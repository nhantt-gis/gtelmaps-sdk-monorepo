import {
    BackSide,
    BufferGeometry,
    CustomBlending,
    ExternalTexture,
    FrontSide,
    Mesh,
    NoBlending,
    OneFactor,
    OneMinusSrcAlphaFactor,
} from 'three';

import {StencilMode} from '../../gl/stencil_mode';
import {translatePosition} from '../../util/util';
import {fillExtrusionUniformValues} from '../../render/program/fill_extrusion_program';
import {applyProjectionData} from './projection_bridge';
import {applyGlobeProjectionData} from './projection_globe';
import {applyTerrainData} from './terrain_bridge';
import {applyStencilMode} from './stencil_bridge';
import {BucketBuffersCache, type BucketBuffers} from './bucket_geometry';
import {
    attributesCoverBinders,
    compositeInterpolationFactor,
    describeBinders,
    PaintAttributesCache,
    type BinderDescription,
    type PaintAttributes,
} from './paint_binders';
import {FILL_EXTRUSION_SPECS, FillExtrusionMaterialCache} from './fill_extrusion_program';
import {
    FILL_EXTRUSION_PATTERN_SPECS,
    createFillExtrusionPatternMaterial,
} from './fill_extrusion_pattern_program';
import {PatternMaterialCache, patternTileUniforms} from './fill_pattern_program';
import {resolvePatternPositions, setConstantPatternUniforms} from './pattern_positions';
import {pixelsToTileUnits} from '../../source/pixels_to_tile_units';

import type {Camera, RawShaderMaterial, WebGLRenderer} from 'three';
import type {Color} from '@maplibre/maplibre-gl-style-spec';
import type {FillExtrusionBucket} from '../../data/bucket/fill_extrusion_bucket';
import type {FillExtrusionStyleLayer} from '../../style/style_layer/fill_extrusion_style_layer';
import type {OverscaledTileID} from '../../tile/tile_id';
import type {Painter, RenderOptions} from '../../render/painter';
import type {ProgramConfiguration} from '../../data/program_configuration';
import type {TileManager} from '../../tile/tile_manager';

/**
 * Draws `fill-extrusion` through Three, for the cases it can.
 *
 * ## What this step is, and what it deliberately is **not**
 *
 * The G4 plan schedules `fill-extrusion` as G4-5, gated on the depth criteria
 * M3/M4 from the G0 spike. Those criteria are about the *3D* depth scheme —
 * reversed-Z, log depth, sub-millimetre separation at 100 km — and they cannot
 * be concluded on SwiftShader, which is the only renderer available here (RO-1).
 *
 * So this is **not** G4-5. It is the parity half: the same draw MapLibre already
 * performs, moved to Three, judged the same way every other layer was judged —
 * by the 1560 fixtures. The depth scheme is untouched. Reading a green gate here
 * as "the depth criteria passed" would be exactly the mistake the plan's
 * invariant exists to prevent, so it is said here rather than left to inference.
 *
 * ## The first layer that writes depth, and the first drawn twice
 *
 * Every ported layer so far reads depth; this one writes it, with
 * `painter.depthRangeFor3D` — a range reserved so 3D layers cannot collide with
 * the per-sublayer 2D ranges.
 *
 * And a translucent extrusion is drawn **twice**: once into depth only, with
 * colour writes off, and once for colour, passing only where the depth equals
 * what the first pass left. That is what stops the far side of a building
 * showing through the near side. The second pass is stencilled to keep coincident
 * polygons from double-blending, and that stencil id comes from
 * `stencilModeFor3D()` — which **increments the painter's id as a side effect**,
 * so it is called exactly once, from `draw`, exactly as upstream calls it.
 *
 * ## Declined, with reasons
 *
 * - **`fill-extrusion-pattern`.** A second program with cross-faded binders and
 *   a `u_height_factor` that maps wall height into pattern space. Same shape as
 *   `fill`'s pattern step, and a separate one.
 * - **Terrain.** Not a branch: the shader reads a `a_centroid` attribute from a
 *   *second* vertex buffer that only exists under terrain, and raises each
 *   building's floor and ceiling by the ground elevation beneath its centroid.
 * - Globe, render-to-texture, overdraw inspector — as elsewhere.
 */
export type FillExtrusionStats = {
    drawn: number;
    fellBack: Record<string, number>;
    /** Tiles skipped inside a claimed draw. See `FillStats.skipped`. */
    skipped: Record<string, number>;
};

/** The bucket surface this needs, without depending on private fields. */
type SegmentedExtrusionBucket = FillExtrusionBucket & {
    zoom: number;
    segments: {segments: Array<{vertexOffset: number; vertexLength: number; primitiveOffset: number; primitiveLength: number}>};
    programConfigurations: {get(layerId: string): ProgramConfiguration};
};

const INDICES_PER_TRIANGLE = 3;

/** Whether the layer draws as a pattern, by MapLibre's own test. */
function hasPattern(layer: FillExtrusionStyleLayer): boolean {
    return Boolean(layer.paint.get('fill-extrusion-pattern').constantOr(1 as never));
}

export class FillExtrusionRenderer {
    readonly stats: FillExtrusionStats = {drawn: 0, fellBack: {}, skipped: {}};

    private readonly _buffers = new BucketBuffersCache();
    private readonly _paintAttributes = new PaintAttributesCache();
    private readonly _materials = new FillExtrusionMaterialCache();
    private readonly _patternMaterials = new PatternMaterialCache(createFillExtrusionPatternMaterial);
    private readonly _externalTextures = new WeakMap<WebGLTexture, ExternalTexture>();

    private readonly _geometry = new BufferGeometry();
    private readonly _mesh = new Mesh(this._geometry);

    private _fallBack(reason: string): false {
        this.stats.fellBack[reason] = (this.stats.fellBack[reason] ?? 0) + 1;
        return false;
    }

    /**
     * Drawn, but with pattern uniforms the atlas could not refresh this frame.
     * Counted apart from `skipped` because the tile **is** drawn — a number that
     * says "stale" must not be read as "missing".
     */
    private _stale(reason: string): void {
        this.stats.skipped[`stale-${reason}`] = (this.stats.skipped[`stale-${reason}`] ?? 0) + 1;
    }

    private _skip(reason: string): void {
        this.stats.skipped[reason] = (this.stats.skipped[reason] ?? 0) + 1;
    }

    canDraw(
        painter: Painter,
        tileManager: TileManager,
        layer: FillExtrusionStyleLayer,
        coords: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
    ): boolean {
        if (painter.options.showOverdrawInspector) return this._fallBack('overdraw-inspector');
        if (renderOptions.isRenderingToTexture) return this._fallBack('render-to-texture');
        // **`fill-extrusion-pattern` is accepted, and §11's suspect was wrong.**
        // That section left `a_normal_ed.w` named as the remaining cause, on a
        // trail of measurements that were all individually true and together
        // pointed at the wrong half of the pipeline. Two things had to be
        // corrected here, neither of them in an attribute:
        //
        // 1. A patterned layer takes the **two-pass** path at *any* opacity —
        //    `drawFillExtrusion`'s condition is `opacity === 1 && !pattern`.
        // 2. Every pass that writes colour is **alpha-blended**, not only the
        //    ones below full opacity.
        //
        // Both are in `draw`/`_drawTiles`; see §20 for the bisection that got
        // there, and for why the earlier "constant phase offset on the walls"
        // reading was a description of double-blended geometry rather than of a
        // wrong coordinate.
        const isPattern = hasPattern(layer);
        // `drawFillExtrusion` returns before either pass at opacity 0, so
        // claiming the layer would be claiming a no-op — and a `drawn=0` that
        // means "nothing to do" is indistinguishable from one that means
        // "claimed and refused", which is what §6.6 exists to prevent.
        if (layer.paint.get('fill-extrusion-opacity') === 0) return this._fallBack('zero-opacity');

        const specs = isPattern ? FILL_EXTRUSION_PATTERN_SPECS : FILL_EXTRUSION_SPECS;
        // `allowCrossFaded` is opted into, not defaulted — see `paint_binders.ts`.
        // It is safe here for the same reason it is safe in `fill`: the constant
        // case writes atlas rectangles through `setConstantPatternUniforms` and
        // the driven case re-points its buffers through `updatePaintBuffers`.
        // Omitting it does not fail loudly; it makes every pattern layer decline
        // as `unsupported-expression`, which reads like a style the port cannot
        // express rather than an argument left off.
        const binders = describeBinders(layer.paint as never, specs, isPattern);
        if (!binders) return this._fallBack('unsupported-expression');

        for (const coord of coords) {
            const bucket = tileManager.getTile(coord)?.getBucket(layer) as SegmentedExtrusionBucket | undefined;
            if (!bucket?.programConfigurations) continue;
            const paint = this._paintAttributesFor(bucket, layer.id, painter.context.gl);
            if (!attributesCoverBinders(binders, paint.names)) return this._fallBack('binder-mismatch');
        }

        return true;
    }

    /**
     * Draws the layer. Only valid after {@link canDraw} has returned `true`.
     *
     * Always returns `true`: once claimed, the layer is owned in every pass.
     */
    draw(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        tileManager: TileManager,
        layer: FillExtrusionStyleLayer,
        coords: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
    ): boolean {
        if (painter.renderPass !== 'translucent') return true;

        const opacity = layer.paint.get('fill-extrusion-opacity');

        // **`&& !hasPattern` is not decoration.** Upstream's condition is
        // `opacity === 1 && !pattern`, and dropping the second half is what §11
        // spent a measurement trail on and blamed on `a_normal_ed.w`. A
        // patterned layer at full opacity took the single-pass path here and the
        // two-pass path upstream, so a surface *behind* the nearest one still
        // drew — which reads as a wall whose pattern is phase-shifted, not as a
        // missing depth pass. See §20.
        if (opacity === 1 && !hasPattern(layer)) {
            // Opaque and unpatterned: one pass, no stencil. The depth test alone
            // resolves which surface of a building is nearest.
            this._drawTiles(renderer, camera, painter, tileManager, layer, coords, renderOptions,
                StencilMode.disabled, {colorWrite: true});
            return true;
        }

        // Transparent: depth first with colour writes off, so the depth buffer
        // holds the nearest surface…
        this._drawTiles(renderer, camera, painter, tileManager, layer, coords, renderOptions,
            StencilMode.disabled, {colorWrite: false});
        // …then colour, passing only where the depth already equals it. Side
        // effect: `stencilModeFor3D` advances the painter's stencil id, so it is
        // evaluated once, here, exactly as upstream evaluates it.
        this._drawTiles(renderer, camera, painter, tileManager, layer, coords, renderOptions,
            painter.stencilModeFor3D(), {colorWrite: true});
        return true;
    }

    private _drawTiles(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        tileManager: TileManager,
        layer: FillExtrusionStyleLayer,
        coords: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
        stencilMode: Readonly<StencilMode>,
        options: {colorWrite: boolean},
    ): void {
        const gl = painter.context.gl;
        const transform = painter.transform;
        const isPattern = hasPattern(layer);
        const binders = describeBinders(
            layer.paint as never,
            isPattern ? FILL_EXTRUSION_PATTERN_SPECS : FILL_EXTRUSION_SPECS,
            isPattern)!;
        // The `variant` flag means **terrain** for both of these, not globe —
        // this renderer still declines globe outright. See `patternProgramKey`.
        const terrain = painter.style.map.terrain;
        const hasTerrain = Boolean(terrain);
        const isGlobe = Boolean(painter.style.projection?.useSubdivision);
        const material = isPattern ?
            this._patternMaterials.get(binders, hasTerrain, isGlobe) :
            this._materials.get(binders, hasTerrain, isGlobe);
        this._mesh.material = material;
        // The **pattern** binders carry atlas rectangles rather than paint
        // values and are resolved per tile below. `base` and `height` are
        // ordinary paint properties in both programs and still need their
        // constant uniforms written here — skipping the call wholesale left
        // `u_base` and `u_height` at zero, which draws buildings with no walls:
        // roofs flat on the ground and every side face collapsed.
        this._setConstantUniforms(
            material, layer, binders.filter((binder) => !binder.name.startsWith('pattern_') &&
                !binder.name.startsWith('pixel_ratio_')));

        const opacity = layer.paint.get('fill-extrusion-opacity');
        // `new DepthMode(gl.LEQUAL, DepthMode.ReadWrite, painter.depthRangeFor3D)`.
        // The only ported layer that writes depth.
        material.depthTest = true;
        material.depthWrite = true;
        material.colorWrite = options.colorWrite;
        // `painter.colorModeForRenderPass()` — alphaBlended
        // `[ONE, ONE_MINUS_SRC_ALPHA]` — for **every** pass that writes colour,
        // not only when opacity is below 1.
        //
        // Gating it on `opacity < 1` looked equivalent and is, for a solid
        // colour: with `src.a == 1` the blend reduces to the source, which is
        // why the plain program passed 74 fixtures with blending switched off.
        // A **pattern** carries its own alpha per texel, so there the two
        // differ, and the difference lands exactly on the pattern's shapes.
        // That was the whole of §11's unexplained wall offset. See §20.
        material.transparent = options.colorWrite;
        material.blending = options.colorWrite ? CustomBlending : NoBlending;
        material.blendSrc = OneFactor;
        material.blendDst = OneMinusSrcAlphaFactor;
        // MapLibre's CullFaceMode.backCCW.
        // MapLibre's CullFaceMode.backCCW, inverted under globe because Three
        // flips the winding itself — see §14.
        material.side = isGlobe ? BackSide : FrontSide;
        applyStencilMode(material, stencilMode, gl);
        material.needsUpdate = true;

        const values = fillExtrusionUniformValues(
            painter,
            layer.paint.get('fill-extrusion-vertical-gradient'),
            opacity,
            [0, 0],
        );
        material.uniforms.u_lightpos.value.fromArray(values.u_lightpos as ArrayLike<number>);
        // Only the globe variant declares it: the light direction transformed
        // into the sphere's frame, which the mercator shader never reads.
        if (material.uniforms.u_lightpos_globe) {
            material.uniforms.u_lightpos_globe.value
                .fromArray(values.u_lightpos_globe as ArrayLike<number>);
        }
        material.uniforms.u_lightcolor.value.fromArray(values.u_lightcolor as ArrayLike<number>);
        material.uniforms.u_lightintensity.value = values.u_lightintensity;
        material.uniforms.u_vertical_gradient.value = values.u_vertical_gradient;
        material.uniforms.u_opacity.value = values.u_opacity;

        const translate = layer.paint.get('fill-extrusion-translate');
        const translateAnchor = layer.paint.get('fill-extrusion-translate-anchor');
        const depthRange = painter.depthRangeFor3D;

        const crossfade = isPattern ? layer.getCrossfadeParameters() : null;
        const constantPattern = isPattern ?
            layer.paint.get('fill-extrusion-pattern').constantOr(null as never) : null;
        const isConstantPattern = isPattern &&
            binders.find((b) => b.name === 'pattern_from')?.kind === 'uniform';
        const declared = isPattern ?
            layer.getPaintProperty('fill-extrusion-pattern') as string | undefined : undefined;

        gl.depthRange(depthRange[0], depthRange[1]);
        try {
            for (const coord of coords) {
                const tile = tileManager.getTile(coord);
                const bucket = tile?.getBucket(layer) as SegmentedExtrusionBucket | undefined;
                if (!bucket) { this._skip('no-bucket'); continue; }

                const buffers = this._buffersFor(bucket, gl, hasTerrain);
                if (!buffers || buffers.segments.length === 0) { this._skip('no-buffers'); continue; }

                const paint = isPattern ?
                    this._patternPaintAttributes(bucket, layer.id, crossfade!, gl) :
                    this._paintAttributesFor(bucket, layer.id, gl);
                this._setCompositeFactors(material, layer, binders, bucket.zoom, transform.zoom);

                if (isPattern) {
                    if (!tile?.imageAtlasTexture) { this._skip('pattern-no-atlas'); continue; }
                    // Only a **constant** pattern resolves rectangles here; per
                    // feature they arrive as attributes. Requiring them
                    // unconditionally is the G4-3b shape — every data-driven
                    // tile skipped after `canDraw` already claimed the layer.
                    const positions = isConstantPattern ?
                        resolvePatternPositions(
                            tile.imageAtlas?.patternPositions as never, constantPattern as never, declared) :
                        null;
                    // **Not** a skip. `updatePatternPositionsInProgram` returns
                    // early when the atlas cannot supply the rectangles, and
                    // `drawFillExtrusion` then draws the tile regardless — with
                    // whatever the program configuration last held. Skipping
                    // instead leaves a hole where upstream shows a stale-but-
                    // plausible pattern, which measured as 30 skipped tiles
                    // against 16 drawn in the probe.
                    if (positions) setConstantPatternUniforms(material, binders, positions);
                    else if (isConstantPattern) this._stale('pattern-positions');

                    // For the parameter side effect; see `fill_layer.ts`.
                    tile.imageAtlasTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
                    material.uniforms.u_image.value = this._externalTexture(tile.imageAtlasTexture.texture);

                    const pattern = patternTileUniforms(
                        tile as never,
                        transform.tileZoom,
                        1 / pixelsToTileUnits(tile, 1, transform.tileZoom),
                        crossfade!,
                        tile.imageAtlasTexture.size as [number, number],
                    );
                    material.uniforms.u_texsize.value.fromArray(pattern.texsize);
                    material.uniforms.u_scale.value.fromArray(pattern.scale);
                    material.uniforms.u_fade.value = pattern.fade;
                    material.uniforms.u_pixel_coord_upper.value.fromArray(pattern.pixelCoordUpper);
                    material.uniforms.u_pixel_coord_lower.value.fromArray(pattern.pixelCoordLower);
                    // Sign and divisor both matter: the wall's pattern runs *up*
                    // the wall, and this converts elevation to the same units
                    // `edgedistance` is in.
                    material.uniforms.u_height_factor.value =
                        -Math.pow(2, coord.overscaledZ) / tile.tileSize / 8;
                }

                material.uniforms.u_fill_translate.value.fromArray(
                    translatePosition(transform, tile, translate, translateAnchor));

                // Per tile — the DEM matrix and DEM texture are the tile's own.
                if (terrain) applyTerrainData(material, terrain.getTerrainData(coord));

                const projectionData = transform.getProjectionData({
                    overscaledTileID: coord,
                    applyGlobeMatrix: !renderOptions.isRenderingToTexture,
                    applyTerrainMatrix: true,
                });
                if (isGlobe) applyGlobeProjectionData(material, projectionData);
                applyProjectionData(this._mesh, projectionData);

                for (let i = 0; i < buffers.segments.length; i++) {
                    buffers.bindSegment(this._geometry, i);
                    paint.bindSegment(this._geometry, buffers.segments[i].vertexOffset);
                    renderer.render(this._mesh, camera);
                    this.stats.drawn++;
                }
            }
        } finally {
            gl.depthRange(0, 1);
        }
    }

    private _setConstantUniforms(
        material: RawShaderMaterial,
        layer: FillExtrusionStyleLayer,
        binders: ReadonlyArray<BinderDescription>,
    ): void {
        for (const binder of binders) {
            if (binder.kind !== 'uniform') continue;
            const slot = material.uniforms[`u_${binder.name}`];
            const value = (layer.paint.get(binder.property as never) as {constantOr(fallback: unknown): unknown})
                .constantOr(null);
            if (binder.glslType === 'float') {
                slot.value = value as number;
            } else {
                const color = value as Color;
                (slot.value as {set(r: number, g: number, b: number, a: number): void})
                    .set(color.r, color.g, color.b, color.a);
            }
        }
    }

    private _setCompositeFactors(
        material: RawShaderMaterial,
        layer: FillExtrusionStyleLayer,
        binders: ReadonlyArray<BinderDescription>,
        bucketZoom: number,
        cameraZoom: number,
    ): void {
        for (const binder of binders) {
            if (binder.kind !== 'composite') continue;
            material.uniforms[`u_${binder.name}_t`].value = compositeInterpolationFactor(
                layer.paint.get(binder.property as never), bucketZoom, cameraZoom);
        }
    }

    /** `null` when the bucket has not been uploaded yet. */
    /**
     * `a_centroid` rides in a **second** layout buffer, present only under
     * terrain — `bucket.centroidVertexBuffer`, populated by the same pass that
     * fills the first. `BucketBufferSource.layoutBuffers` has always been an
     * array for exactly this, as `line-gradient` already uses it.
     *
     * The buffer is part of the cache key, not just the bucket: a bucket built
     * before terrain was enabled has none, and reusing its cached entry
     * afterwards would bind a geometry with no `a_centroid` to a shader that
     * reads one.
     */
    private _buffersFor(
        bucket: SegmentedExtrusionBucket,
        gl: WebGLRenderingContext,
        hasTerrain: boolean,
    ): BucketBuffers | null {
        if (!bucket.layoutVertexBuffer?.buffer || !bucket.indexBuffer?.buffer) return null;
        const centroid = hasTerrain ? bucket.centroidVertexBuffer : undefined;
        if (hasTerrain && !centroid?.buffer) return null;

        return this._buffers.get(centroid ?? bucket, () => ({
            layoutBuffers: centroid ?
                [bucket.layoutVertexBuffer as never, centroid as never] :
                [bucket.layoutVertexBuffer as never],
            indexBuffer: bucket.indexBuffer.buffer,
            indexType: gl.UNSIGNED_SHORT,
            indexBytes: 2,
            indexCount: bucket.indexArray.length * INDICES_PER_TRIANGLE,
            segments: bucket.segments.segments,
            indicesPerPrimitive: INDICES_PER_TRIANGLE,
            gl,
        }));
    }

    /** Pattern attributes must be re-pointed each frame; see `fill_layer.ts`. */
    private _patternPaintAttributes(
        bucket: SegmentedExtrusionBucket,
        layerId: string,
        crossfade: Parameters<ProgramConfiguration['updatePaintBuffers']>[0],
        gl: WebGLRenderingContext,
    ): PaintAttributes {
        const programConfiguration = bucket.programConfigurations.get(layerId);
        programConfiguration.updatePaintBuffers(crossfade);
        return this._paintAttributes.get(bucket, programConfiguration, gl);
    }

    /** One wrapper per `WebGLTexture`; see `raster_layer.ts`. */
    private _externalTexture(texture: WebGLTexture): ExternalTexture {
        let wrapper = this._externalTextures.get(texture);
        if (!wrapper) {
            wrapper = new ExternalTexture(texture);
            this._externalTextures.set(texture, wrapper);
        }
        return wrapper;
    }

    private _paintAttributesFor(
        bucket: SegmentedExtrusionBucket,
        layerId: string,
        gl: WebGLRenderingContext,
    ): PaintAttributes {
        return this._paintAttributes.get(bucket, bucket.programConfigurations.get(layerId), gl);
    }

    destroy(): void {
        // The geometry is deliberately not disposed: its attributes point at
        // MapLibre's GL buffers. See `bucket_geometry.ts`.
        this._materials.dispose();
    }
}
