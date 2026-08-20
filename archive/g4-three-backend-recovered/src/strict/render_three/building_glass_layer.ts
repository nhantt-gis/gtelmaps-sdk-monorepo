import {
    BufferGeometry,
    CustomBlending,
    FrontSide,
    Mesh,
    NoBlending,
    OneFactor,
    OneMinusSrcAlphaFactor,
} from 'three';

import {isWebGL2} from '../../gl/webgl2';
import {StencilMode} from '../../gl/stencil_mode';
import {translatePosition} from '../../util/util';
import {applyProjectionData, tileProjectionOptions} from './projection_bridge';
import {applyStencilMode} from './stencil_bridge';
import {BucketBuffersCache, type BucketBuffers} from './bucket_geometry';
import {
    compositeInterpolationFactor,
    describeBinders,
    PaintAttributesCache,
    type BinderDescription,
    type PaintAttributes,
} from './paint_binders';
import {BUILDING_GLASS_SPECS, BuildingGlassMaterialCache} from './building_glass_program';
import {eyeInTile, metresToTileUnits} from './eye_in_tile';

import type {Camera, RawShaderMaterial, WebGLRenderer} from 'three';
import type {Color} from '@maplibre/maplibre-gl-style-spec';
import type {BuildingGlassBucket} from '../../data/bucket/building_glass_bucket';
import type {OverscaledTileID} from '../../tile/tile_id';
import type {Painter, RenderOptions} from '../../render/painter';
import type {ProgramConfiguration} from '../../data/program_configuration';
import type {TileManager} from '../../tile/tile_manager';
import type {BuildingGlassStyleLayer} from '../../style/style_layer/building_glass_style_layer';

export type BuildingGlassStats = {
    drawn: number;
    fellBack: Record<string, number>;
    skipped: Record<string, number>;
};

/** One drawing pass, described before any GL state is touched. See the test. */
export type GlassPass = {
    depthTest: boolean;
    depthWrite: boolean;
    colorWrite: boolean;
    blended: boolean;
    /**
     * Whether this pass is stencilled against coincident geometry.
     *
     * `BuildingGlassBucket` reuses `FillExtrusionBucket`'s mesh unmodified, so
     * it inherits the same coincident-polygon hazard: adjoining footprints can
     * produce coplanar triangles, and without a stencil test the colour pass
     * would blend the seam twice. Glass is *always* alpha-blended (there is no
     * opaque fast path — see the class comment), so a double-blended seam is
     * more visible here than on a typically-opaque extrusion, not less.
     *
     * Only the colour pass can use one: the depth-only pass writes no colour,
     * so there is nothing for a stencil to protect, and an overlay (xray) pass
     * neither tests nor writes depth, so there is no coincident-surface
     * resolution for a stencil to help with either. `stencilModeFor3D()`
     * increments the painter's stencil id as a side effect, so `draw()` reads
     * this field to decide whether to take an id **once** for the whole draw,
     * never per pass — see `draw()`.
     */
    stencilled: boolean;
};

const INDICES_PER_TRIANGLE = 3;

/**
 * The bucket surface this needs, without depending on private fields.
 *
 * Identical in shape to `fill_extrusion_layer.ts`'s `SegmentedExtrusionBucket` —
 * `BuildingGlassBucket` subclasses `FillExtrusionBucket` and reuses its geometry
 * entirely, so the same narrow surface applies.
 */
type SegmentedGlassBucket = BuildingGlassBucket & {
    zoom: number;
    segments: {
        segments: Array<{
            vertexOffset: number;
            vertexLength: number;
            primitiveOffset: number;
            primitiveLength: number;
        }>;
    };
    programConfigurations: {get(layerId: string): ProgramConfiguration};
};

/**
 * Draws `building-glass` through Three: an extruded footprint with a
 * per-fragment fresnel rim, always translucent.
 *
 * ## Depth, in two passes
 *
 * Glass has no opaque fast path — unlike `fill-extrusion` there is no
 * single-pass shortcut at full opacity, because the material blends `u_opacity`
 * against the fresnel term regardless of what the paint property says. Every
 * draw is therefore depth-first with colour off, then colour with depth writes
 * off, so a coplanar stack has exactly one sheet that writes depth (ADR-001
 * §8.1). See `describePasses` and its test.
 *
 * ## What this version omits
 *
 * No globe branch, no terrain branch — `createBuildingGlassMaterial` compiles
 * neither, and `_buffersFor` always runs with `hasTerrain: false`. No pattern:
 * `building-glass` declares no `-pattern` property at all.
 */
export class BuildingGlassRenderer {
    readonly stats: BuildingGlassStats = {drawn: 0, fellBack: {}, skipped: {}};

    private readonly _buffers = new BucketBuffersCache();
    private readonly _paintAttributes = new PaintAttributesCache();
    private readonly _materials = new BuildingGlassMaterialCache();
    private readonly _geometry = new BufferGeometry();
    private readonly _mesh = new Mesh(this._geometry);

    private _fallBack(reason: string): false {
        this.stats.fellBack[reason] = (this.stats.fellBack[reason] ?? 0) + 1;
        return false;
    }

    private _skip(reason: string): void {
        this.stats.skipped[reason] = (this.stats.skipped[reason] ?? 0) + 1;
    }

    /**
     * The passes this layer draws, as data.
     *
     * Separated from `draw` so the depth rules can be asserted without a GPU.
     * Glass is always translucent, so unlike fill-extrusion there is no
     * single-pass shortcut at full opacity: depth first with colour off, then
     * colour with depth writes off. Exactly one sheet writes depth — ADR-001.
     */
    describePasses({xray}: {xray: boolean}): ReadonlyArray<GlassPass> {
        if (xray) {
            return [{depthTest: false, depthWrite: false, colorWrite: true, blended: true, stencilled: false}];
        }
        return [
            {depthTest: true, depthWrite: true, colorWrite: false, blended: false, stencilled: false},
            {depthTest: true, depthWrite: false, colorWrite: true, blended: true, stencilled: true},
        ];
    }

    /**
     * Whether this renderer will draw the layer.
     *
     * **Returning `false` here is not a safe retreat.** Every other renderer in
     * this directory hands the layer back to MapLibre; MapLibre does not know
     * this type, so a decline means nothing draws at all. Only decline where
     * drawing would be a no-op anyway, and count every decline so the parity
     * page can show it.
     */
    canDraw(
        painter: Painter,
        _tileManager: TileManager,
        layer: BuildingGlassStyleLayer,
        coords: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
    ): boolean {
        if (painter.options.showOverdrawInspector) return this._fallBack('overdraw-inspector');
        if (renderOptions.isRenderingToTexture) return this._fallBack('render-to-texture');
        if (layer.paint.get('building-glass-opacity') === 0) return this._fallBack('zero-opacity');
        if (!coords.length) return this._fallBack('no-tiles');
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
        layer: BuildingGlassStyleLayer,
        coords: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
    ): boolean {
        if (painter.renderPass !== 'translucent') return true;

        const xray = layer.paint.get('building-glass-xray');
        const passes = this.describePasses({xray});

        // Once per draw, never per pass: `stencilModeFor3D()` advances the
        // painter's stencil id as a side effect, exactly as upstream calls it.
        // Asking for it inside the loop would burn an id per pass and desync
        // this layer's ids from every other 3D layer in the frame.
        const stencilMode = passes.some((pass) => pass.stencilled) ?
            painter.stencilModeFor3D() : StencilMode.disabled;

        for (const pass of passes) {
            this._drawTiles(renderer, camera, painter, tileManager, layer, coords, renderOptions,
                pass, pass.stencilled ? stencilMode : StencilMode.disabled);
        }
        return true;
    }

    private _drawTiles(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        tileManager: TileManager,
        layer: BuildingGlassStyleLayer,
        coords: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
        pass: GlassPass,
        stencilMode: Readonly<StencilMode>,
    ): void {
        const gl = painter.context.gl;
        const transform = painter.transform;
        const binders = describeBinders(layer.paint as never, BUILDING_GLASS_SPECS)!;
        // `fwidth` là thứ giữ viền dày đúng số pixel đã khai, bất kể toà nhà cao
        // hay thấp. Nó là core trong WebGL2; trên WebGL1 phải hỏi extension.
        // Fork này mặc định `webgl2withfallback`, nên WebGL1 vẫn là đích sống và
        // không được giả định là có.
        const hasDerivatives = isWebGL2(gl) || Boolean(gl.getExtension('OES_standard_derivatives'));
        const material = this._materials.get(binders, hasDerivatives);
        this._mesh.material = material;

        material.depthTest = pass.depthTest;
        material.depthWrite = pass.depthWrite;
        material.colorWrite = pass.colorWrite;
        material.transparent = pass.blended;
        material.blending = pass.blended ? CustomBlending : NoBlending;
        material.blendSrc = OneFactor;
        material.blendDst = OneMinusSrcAlphaFactor;
        material.side = FrontSide;
        applyStencilMode(material, stencilMode, gl);

        material.uniforms.u_opacity.value = layer.paint.get('building-glass-opacity');
        material.uniforms.u_fresnel_power.value = layer.paint.get('building-glass-fresnel-power');
        material.uniforms.u_fresnel_intensity.value = layer.paint.get('building-glass-fresnel-intensity');
        material.uniforms.u_ambient.value = layer.paint.get('building-glass-ambient');
        material.uniforms.u_rim_gain.value = layer.paint.get('building-glass-rim-gain');

        const edgeColor = layer.paint.get('building-glass-edge-color');
        material.uniforms.u_edge_color.value.set(edgeColor.r, edgeColor.g, edgeColor.b, edgeColor.a);
        material.uniforms.u_edge_opacity.value = layer.paint.get('building-glass-edge-opacity');
        material.uniforms.u_edge_width.value = layer.paint.get('building-glass-edge-width');
        material.needsUpdate = true;

        this._setConstantUniforms(material, layer, binders);

        const translate = layer.paint.get('building-glass-translate');
        const translateAnchor = layer.paint.get('building-glass-translate-anchor');

        const usesDepth = pass.depthTest || pass.depthWrite;
        if (usesDepth) {
            const depthRange = painter.depthRangeFor3D;
            gl.depthRange(depthRange[0], depthRange[1]);
        }
        try {
            for (const coord of coords) {
                const tile = tileManager.getTile(coord);
                const bucket = tile?.getBucket(layer) as SegmentedGlassBucket | undefined;
                if (!bucket) { this._skip('no-bucket'); continue; }

                const buffers = this._buffersFor(bucket, gl, false);
                if (!buffers || buffers.segments.length === 0) { this._skip('no-buffers'); continue; }
                const paint = this._paintAttributesFor(bucket, layer.id, gl);

                this._setCompositeFactors(material, layer, binders, bucket.zoom, transform.zoom);

                // Per tile, because the tile's own origin and span are in it.
                material.uniforms.u_eye_tile.value.fromArray(eyeInTile(transform, coord));
                material.uniforms.u_metres_to_tile_units.value = metresToTileUnits(transform, coord);

                material.uniforms.u_fill_translate.value.fromArray(
                    translatePosition(transform, tile, translate, translateAnchor));

                const projectionData = transform.getProjectionData(
                    tileProjectionOptions(coord, renderOptions.isRenderingToTexture));
                applyProjectionData(this._mesh, projectionData);

                for (let i = 0; i < buffers.segments.length; i++) {
                    buffers.bindSegment(this._geometry, i);
                    paint.bindSegment(this._geometry, buffers.segments[i].vertexOffset);
                    renderer.render(this._mesh, camera);
                    this.stats.drawn++;
                }
            }
        } finally {
            // Returns the depth range to the next pass, exactly as
            // `FillExtrusionRenderer._drawTiles` does — and in a `finally` for
            // the same reason: the loop above can throw before reaching the end.
            if (usesDepth) gl.depthRange(0, 1);
        }
    }

    /** Identical in shape to `FillExtrusionRenderer._setConstantUniforms`. */
    private _setConstantUniforms(
        material: RawShaderMaterial,
        layer: BuildingGlassStyleLayer,
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

    /**
     * Copied verbatim (signature and body) from
     * `FillExtrusionRenderer._buffersFor`. `hasTerrain` is always `false` from
     * `_drawTiles` in this version — `building-glass` compiles no `TERRAIN3D`
     * branch — but the parameter stays so the two stay identical rather than
     * drifting into two implementations of the same cache wrapper.
     */
    private _buffersFor(
        bucket: SegmentedGlassBucket,
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

    /**
     * Copied verbatim from `FillExtrusionRenderer._paintAttributesFor`.
     * `PaintAttributesCache.get` takes a `ProgramConfiguration`, not a layer id —
     * this is the wrapper that pulls one out of the bucket.
     */
    private _paintAttributesFor(
        bucket: SegmentedGlassBucket,
        layerId: string,
        gl: WebGLRenderingContext,
    ): PaintAttributes {
        return this._paintAttributes.get(bucket, bucket.programConfigurations.get(layerId), gl);
    }

    /**
     * Copied verbatim from `FillExtrusionRenderer._setCompositeFactors`.
     * Interpolates the zoom factor for `composite`-kind binders — per bucket,
     * not per layer, because an overzoomed tile carries endpoints from a lower
     * zoom than its neighbours.
     */
    private _setCompositeFactors(
        material: RawShaderMaterial,
        layer: BuildingGlassStyleLayer,
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

    destroy(): void {
        // Only the material cache owns anything disposable. `BucketBuffersCache`
        // deliberately has no `dispose()` — the buffers it hands out belong to
        // MapLibre's buckets, and disposing a geometry bound through it would
        // delete buffers the other renderer still uses. See `bucket_geometry.ts`.
        this._materials.dispose();
    }
}
