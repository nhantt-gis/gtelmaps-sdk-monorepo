import {
    BufferGeometry,
    CustomBlending,
    DoubleSide,
    ExternalTexture,
    Mesh,
    OneFactor,
    OneMinusSrcAlphaFactor,
} from 'three';

import {DepthMode} from '../../gl/depth_mode';
import {pixelsToTileUnits} from '../../source/pixels_to_tile_units';
import {translatePosition} from '../../util/util';
import {applyProjectionData, tileProjectionOptions} from './projection_bridge';
import {applyGlobeProjectionData} from './projection_globe';
import {applyStencilMode} from './stencil_bridge';
import {BucketBuffersCache, type BucketBuffers} from './bucket_geometry';
import {
    attributesCoverBinders,
    classifyPaintValue,
    compositeInterpolationFactor,
    describeBinders,
    PaintAttributesCache,
    type BinderDescription,
    type PaintAttributes,
} from './paint_binders';
import {LINE_SPECS, LineMaterialCache} from './line_program';
import {
    createLinePatternMaterial,
    LINE_PATTERN_SPECS,
    linePatternTileUniforms,
} from './line_pattern_program';
import {
    createLineDasharrayMaterial,
    LINE_DASHARRAY_SPECS,
    setConstantDashUniforms,
} from './line_dasharray_program';
import {
    createLineGradientMaterial,
    LINE_GRADIENT_SPECS,
} from './line_gradient_program';
import {
    createLineGradientSdfMaterial,
    LINE_GRADIENT_SDF_SPECS,
} from './line_gradient_sdf_program';
import {invalidateThreeStateCache} from './texture_bridge';
import {resolvePatternPositions, setConstantPatternUniforms} from './pattern_positions';
import {updateGradientTexture} from '../../render/draw_line';

import type {Camera, RawShaderMaterial, WebGLRenderer} from 'three';
import type {Color} from '@maplibre/maplibre-gl-style-spec';
import type {LineBucket} from '../../data/bucket/line_bucket';
import type {LineStyleLayer} from '../../style/style_layer/line_style_layer';
import type {OverscaledTileID} from '../../tile/tile_id';
import type {Painter, RenderOptions} from '../../render/painter';
import type {ProgramConfiguration} from '../../data/program_configuration';
import type {TileManager} from '../../tile/tile_manager';

/**
 * Draws `line` through Three, for the cases it can, and says so when it cannot.
 *
 * ## Scope
 *
 * Plain, patterned and dashed lines on mercator: no `line-gradient`, no
 * terrain, no globe. A gradient selects `lineGradient` — or `lineGradientSDF`
 * when combined with a dasharray, a fifth program rather than a combination of
 * two — and needs a colour ramp texture built per bucket. That is separate work,
 * not a branch here.
 *
 * Three programs live in this class, one per file: `line_program.ts`,
 * `line_pattern_program.ts`, `line_dasharray_program.ts`. They share the
 * extrusion arithmetic and nothing else; see `lineVertexMain`.
 *
 * Paint properties may be constant, data-driven or composite; that machinery is
 * shared with `fill` and lives in `paint_binders.ts`.
 *
 * ## What is new relative to `fill`
 *
 * - **Two attribute types in one buffer.** `a_pos_normal` is `Int16×2` and
 *   `a_data` is `Uint8×4`, packed into eight bytes. See `attribute_bridge.ts`.
 * - **Vertex-only paint properties.** `gapwidth`, `offset` and `width` never
 *   reach the fragment shader; see `line_program.ts`.
 * - **No back-face culling.** MapLibre uses `CullFaceMode.disabled` here because
 *   the extruded triangles have no reliable winding — joins are resolved in the
 *   shader. Culling them would drop geometry unpredictably, which is exactly the
 *   G4-2 quad-winding failure in a shape where the correct winding does not
 *   exist to be found.
 * - **A single pass.** Unlike `fill` there is no outline pass, and lines are
 *   always translucent: `drawLine` returns immediately outside that pass.
 */
export type LineStats = {
    drawn: number;
    fellBack: Record<string, number>;

    /** Tiles skipped inside a claimed draw, by reason. See `FillStats.skipped` in `fill_layer.ts` for why this exists. */
    skipped: Record<string, number>;
};

/** What a gradient adds to the bucket surface. */
type GradientLineBucket = SegmentedLineBucket & {
    layoutVertexBuffer2?: {buffer: WebGLBuffer};
    lineClipsArray: Array<unknown>;
    gradients: Record<string, {texture?: any; version?: number}>;
};

/** The bucket surface this needs, without depending on private fields. */
type SegmentedLineBucket = LineBucket & {
    zoom: number;
    segments: {segments: Array<{vertexOffset: number; vertexLength: number; primitiveOffset: number; primitiveLength: number}>};
    programConfigurations: {get(layerId: string): ProgramConfiguration};
};

const INDICES_PER_TRIANGLE = 3;

/**
 * Whether the layer draws as a pattern, by MapLibre's own test.
 *
 * `constantOr(1)` is truthy for a data-driven value as well as a constant one,
 * which is deliberate upstream: the question is "does this layer use a pattern
 * at all", not "what pattern". `canDraw` and `draw` must agree on the answer, so
 * they ask through one function rather than each repeating the expression.
 */
function hasLinePattern(layer: LineStyleLayer): boolean {
    return Boolean(layer.paint.get('line-pattern').constantOr(1 as any));
}

/** Whether the layer draws dashed, by MapLibre's own test. */
function hasLineDasharray(layer: LineStyleLayer): boolean {
    return Boolean(layer.paint.get('line-dasharray').constantOr(1 as any));
}

export class LineRenderer {
    readonly stats: LineStats = {drawn: 0, fellBack: {}, skipped: {}};

    private readonly _buffers = new BucketBuffersCache();
    private readonly _paintAttributes = new PaintAttributesCache();
    private readonly _materials = new LineMaterialCache();
    private readonly _patternMaterials = new LineMaterialCache(createLinePatternMaterial);
    private readonly _dashMaterials = new LineMaterialCache(createLineDasharrayMaterial);
    private readonly _gradientMaterials = new LineMaterialCache(createLineGradientMaterial);
    private readonly _gradientSdfMaterials = new LineMaterialCache(createLineGradientSdfMaterial);
    /**
     * A separate cache because a gradient binds **two** layout buffers, and
     * `BucketBuffersCache` keys by bucket alone. Sharing it would hand the
     * gradient pass a descriptor built without `a_uv_x`, or hand the plain pass
     * one that binds an attribute its shader never declares.
     */
    private readonly _gradientBuffers = new BucketBuffersCache();
    private readonly _externalTextures = new WeakMap<WebGLTexture, ExternalTexture>();

    /**
     * One geometry, repointed per segment — same reasoning as `fill`: Three
     * keys binding state by `geometry.id` and releases it only on `dispose()`,
     * which these geometries must never receive.
     */
    private readonly _geometry = new BufferGeometry();
    private readonly _mesh = new Mesh(this._geometry);

    private _fallBack(reason: string): false {
        this.stats.fellBack[reason] = (this.stats.fellBack[reason] ?? 0) + 1;
        return false;
    }

    /** Every `continue` in the draw loop goes through here. See `FillStats.skipped` in `fill_layer.ts` for why this exists. */
    private _skip(reason: string): void {
        this.stats.skipped[reason] = (this.stats.skipped[reason] ?? 0) + 1;
    }

    /**
     * Whether this renderer can draw `layer` — asked **before** the context is
     * handed to Three, and before ownership of the layer is claimed.
     *
     * Both halves matter. The handover has side effects on GL state, so running
     * it around a declined layer corrupts MapLibre's own render (G4-2, 52
     * terrain fixtures). And a refusal *after* `draw` has returned true means the
     * layer is drawn by nobody at all (G4-3b, a polygon that vanished).
     */
    canDraw(
        painter: Painter,
        tileManager: TileManager,
        layer: LineStyleLayer,
        coords: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
    ): boolean {
        if (painter.options.showOverdrawInspector) return this._fallBack('overdraw-inspector');
        // Under terrain these six layer types are drawn **only** into the
        // terrain render pool, by `RenderToTexture.renderLayer`, never straight
        // to the screen. Accepting that path and refusing any other is the
        // narrowest statement of what has actually been migrated: the flat draw
        // into a pool object, not elevation. See `three_backend._openThree`.
        if (painter.style.map.terrain && !renderOptions.isRenderingToTexture) {
            return this._fallBack('terrain-direct');
        }
        if (!painter.style.map.terrain && renderOptions.isRenderingToTexture) {
            return this._fallBack('render-to-texture');
        }
        // `constantOr(1)` is truthy for a data-driven value too, which is how
        // `drawLine` decides. Pattern is tested first because it *wins* upstream:
        // `if (image) programId = 'linePattern'` comes before the dasharray and
        // gradient branches, so a layer with both draws as a pattern.
        if (hasLinePattern(layer)) return this._canDrawPattern(layer);

        // Order matters and mirrors `drawLine`: a dasharray *and* a gradient
        // together select `lineGradientSDF`, a fifth program rather than a
        // combination of two, so the pair is refused before either is taken.
        const hasGradient = Boolean(layer.paint.get('line-gradient'));
        if (hasGradient && hasLineDasharray(layer)) return this._canDrawGradientDasharray(layer);
        if (hasGradient) return this._canDrawGradient(layer);
        if (hasLineDasharray(layer)) return this._canDrawDasharray(layer);

        const binders = describeBinders(layer.paint as never, LINE_SPECS);
        if (!binders) return this._fallBack('unsupported-expression');

        for (const coord of coords) {
            const bucket = tileManager.getTile(coord)?.getBucket(layer) as SegmentedLineBucket | undefined;
            if (!bucket?.programConfigurations) continue;
            const paint = this._paintAttributesFor(bucket, layer.id, painter.context.gl);
            if (!attributesCoverBinders(binders, paint.names)) return this._fallBack('binder-mismatch');
        }

        return true;
    }

    /**
     * `line-pattern`, for the slice this backend covers.
     *
     * No buffer cross-check here, unlike the plain path. A cross-faded binder
     * publishes **neither** of its two zoom-specific buffers until
     * `updatePaintBuffers(crossfade)` is called, which happens per tile inside
     * the draw loop — so asking `attributesCoverBinders` at this point reads an
     * empty list and refuses every patterned layer. Classification answers the
     * same question without needing the buffers to exist yet.
     */
    private _canDrawPattern(layer: LineStyleLayer): boolean {
        // Synthesised in `LineStyleLayer.recalculate`, absent from the style
        // spec, and read by the fragment shader as the pattern's aspect ratio.
        // Checked explicitly because a missing paint property declines the layer
        // *silently* — the G4-4 `line-gapwidth` failure, where every line layer
        // in every style fell back and 1560 fixtures stayed green.
        if (!layer.paint.get('line-floorwidth' as never)) return this._fallBack('pattern-no-floorwidth');

        const classified = classifyPaintValue(layer.paint.get('line-pattern'));
        if (!classified?.crossFaded) return this._fallBack('pattern-unsupported-expression');
        // `uniform` is a constant pattern and `source` is per feature; the
        // emitters already express that difference. `composite` would need the
        // zoom-interpolated form of a cross-faded binder, which is not built.
        if (classified.kind === 'composite') return this._fallBack('pattern-composite');

        return Boolean(describeBinders(layer.paint as never, LINE_PATTERN_SPECS, true));
    }

    /**
     * `line-gradient`, for the slice this backend covers.
     *
     * No cross-faded classification here, unlike pattern and dasharray:
     * `line-gradient` is not a paint binder at all. It never reaches the shader
     * as an attribute or a uniform — it is rasterised into a texture on the CPU.
     * The only binders are `blur`, `opacity` and the three extrusion widths.
     */
    private _canDrawGradient(layer: LineStyleLayer): boolean {
        return Boolean(describeBinders(layer.paint as never, LINE_GRADIENT_SPECS));
    }

    /**
     * Both at once — MapLibre's `lineGradientSDF`, a fifth program.
     *
     * The guard is the dash guard, not the union of both: `line-gradient`
     * contributes no binder at all (it is a texture, not a paint property), so
     * everything that can be refused here is a dash concern.
     */
    private _canDrawGradientDasharray(layer: LineStyleLayer): boolean {
        if (!layer.paint.get('line-floorwidth' as never)) return this._fallBack('dash-no-floorwidth');

        const classified = classifyPaintValue(layer.paint.get('line-dasharray'));
        if (!classified?.crossFaded) return this._fallBack('dash-unsupported-expression');
        if (classified.kind === 'composite') return this._fallBack('dash-composite');

        return Boolean(describeBinders(layer.paint as never, LINE_GRADIENT_SDF_SPECS, true));
    }

    /** `line-dasharray`, for the slice this backend covers. */
    private _canDrawDasharray(layer: LineStyleLayer): boolean {
        if (!layer.paint.get('line-floorwidth' as never)) return this._fallBack('dash-no-floorwidth');

        const classified = classifyPaintValue(layer.paint.get('line-dasharray'));
        if (!classified?.crossFaded) return this._fallBack('dash-unsupported-expression');
        if (classified.kind === 'composite') return this._fallBack('dash-composite');

        return Boolean(describeBinders(layer.paint as never, LINE_DASHARRAY_SPECS, true));
    }

    /**
     * Draws the layer. Only valid after {@link canDraw} has returned `true`.
     *
     * Always returns `true`: once claimed, the layer is owned in every pass,
     * including the passes that paint nothing.
     */
    draw(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        tileManager: TileManager,
        layer: LineStyleLayer,
        coords: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
    ): boolean {
        const {isRenderingToTexture} = renderOptions;
        // `drawLine` leaves immediately outside the translucent pass, so the
        // opaque visit is a no-op that still claims ownership.
        if (painter.renderPass !== 'translucent') return true;

        const opacity = layer.paint.get('line-opacity');
        const width = layer.paint.get('line-width');
        // Constant zero only: a data-driven value that happens to be zero for
        // every feature still has to go through the shader.
        if (opacity.isConstant() && opacity.constantOr(1) === 0) return true;
        if (width.isConstant() && width.constantOr(1) === 0) return true;

        if (hasLinePattern(layer)) {
            this._drawPattern(renderer, camera, painter, tileManager, layer, coords, isRenderingToTexture);
            return true;
        }
        // Order mirrors `drawLine`: the pair selects a fifth program, so it is
        // tested before either half.
        if (layer.paint.get('line-gradient') && hasLineDasharray(layer)) {
            this._drawGradientDasharray(renderer, camera, painter, tileManager, layer, coords, isRenderingToTexture);
            return true;
        }
        if (layer.paint.get('line-gradient')) {
            this._drawGradient(renderer, camera, painter, tileManager, layer, coords, isRenderingToTexture);
            return true;
        }
        if (hasLineDasharray(layer)) {
            this._drawDasharray(renderer, camera, painter, tileManager, layer, coords, isRenderingToTexture);
            return true;
        }

        const binders = describeBinders(layer.paint as never, LINE_SPECS)!;
        const isGlobe = Boolean(painter.style.projection?.useSubdivision);
        const material = this._materials.get(binders, isGlobe);
        this._mesh.material = material;
        this._setConstantUniforms(material, layer, binders);

        const gl = painter.context.gl;
        const transform = painter.transform;
        const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);

        material.depthTest = depthMode.func !== gl.ALWAYS;
        material.depthWrite = Boolean(depthMode.mask);
        material.transparent = true;
        // ColorMode.alphaBlended, against colours that arrive premultiplied.
        material.blending = CustomBlending;
        material.blendSrc = OneFactor;
        material.blendDst = OneMinusSrcAlphaFactor;
        // CullFaceMode.disabled — see the class comment.
        // MapLibre's CullFaceMode.disabled — and unlike every other layer this
        // stays the same under globe. A line's triangles get their winding in
        // the shader, so there is no consistent face to cull; that is exactly
        // why upstream clips the far hemisphere in the fragment stage instead.
        material.side = DoubleSide;
        material.needsUpdate = true;

        material.uniforms.u_device_pixel_ratio.value = painter.pixelRatio;
        // Upstream's `#ifdef TERRAIN3D` branch on `v_gamma_scale`, as a
        // uniform — see `line_program.ts`. Set on all four line variants
        // because all four upstream shaders carry the same branch.
        material.uniforms.u_flat_gamma.value = isRenderingToTexture ? 1 : 0;
        material.uniforms.u_units_to_pixels.value.set(
            1 / transform.pixelsToGLUnits[0],
            1 / transform.pixelsToGLUnits[1],
        );

        const pixelRatio = transform.getPixelScale();
        const translate = layer.paint.get('line-translate');
        const translateAnchor = layer.paint.get('line-translate-anchor');

        gl.depthRange(depthMode.range[0], depthMode.range[1]);
        try {
            for (const coord of coords) {
                const tile = tileManager.getTile(coord);
                const bucket = tile?.getBucket(layer) as SegmentedLineBucket | undefined;
                if (!bucket) { this._skip('no-bucket'); continue; }

                const buffers = this._buffersFor(bucket, gl);
                if (!buffers || buffers.segments.length === 0) { this._skip('no-buffers'); continue; }

                const paint = this._paintAttributesFor(bucket, layer.id, gl);
                this._setCompositeFactors(material, layer, binders, bucket.zoom, transform.zoom);

                applyStencilMode(material, painter.stencilModeForClipping(coord), gl);

                material.uniforms.u_translation.value.fromArray(
                    translatePosition(transform, tile, translate, translateAnchor));
                // Tile units per screen pixel: what turns a width in pixels into
                // the extrusion distance the vertex shader applies.
                material.uniforms.u_ratio.value = pixelRatio / pixelsToTileUnits(tile, 1, transform.zoom);

                const projectionData = transform.getProjectionData(
                    tileProjectionOptions(coord, isRenderingToTexture));
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

        return true;
    }

    /**
     * The patterned-line pass — MapLibre's `linePattern` program.
     *
     * Shares the extrusion with the plain path and nothing else. The pattern
     * repeats along the line's **arc length** (`v_linesofar`), not across tile
     * space, so none of `fill-pattern`'s `get_pattern_pos` machinery applies;
     * see `line_pattern_program.ts`.
     */
    private _drawPattern(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        tileManager: TileManager,
        layer: LineStyleLayer,
        coords: Array<OverscaledTileID>,
        isRenderingToTexture: boolean,
    ): void {
        const gl = painter.context.gl;
        const transform = painter.transform;
        const binders = describeBinders(layer.paint as never, LINE_PATTERN_SPECS, true)!;
        const isConstantPattern = binders.find((b) => b.name === 'pattern_from')?.kind === 'uniform';
        const isGlobe = Boolean(painter.style.projection?.useSubdivision);
        const material = this._patternMaterials.get(binders, isGlobe);
        this._mesh.material = material;
        // Cross-faded binders are excluded deliberately. Their constant form is
        // a `{from, to}` image pair, not a number or a colour, and it reaches
        // the shader through `setConstantPatternUniforms` after the atlas lookup
        // — feeding it to the generic writer would read `.r`/`.g`/`.b` off an
        // image name and quietly write NaN.
        this._setConstantUniforms(material, layer, binders.filter((b) => !b.crossFaded));

        const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);
        material.depthTest = depthMode.func !== gl.ALWAYS;
        material.depthWrite = Boolean(depthMode.mask);
        material.transparent = true;
        material.blending = CustomBlending;
        material.blendSrc = OneFactor;
        material.blendDst = OneMinusSrcAlphaFactor;
        material.side = DoubleSide;
        material.needsUpdate = true;

        material.uniforms.u_device_pixel_ratio.value = painter.pixelRatio;
        // Upstream's `#ifdef TERRAIN3D` branch on `v_gamma_scale`, as a
        // uniform — see `line_program.ts`. Set on all four line variants
        // because all four upstream shaders carry the same branch.
        material.uniforms.u_flat_gamma.value = isRenderingToTexture ? 1 : 0;
        material.uniforms.u_units_to_pixels.value.set(
            1 / transform.pixelsToGLUnits[0],
            1 / transform.pixelsToGLUnits[1],
        );

        const pixelRatio = transform.getPixelScale();
        const crossfade = layer.getCrossfadeParameters();
        const constantPattern = layer.paint.get('line-pattern').constantOr(null as never);
        const declared = layer.getPaintProperty('line-pattern') as string | undefined;
        const translate = layer.paint.get('line-translate');
        const translateAnchor = layer.paint.get('line-translate-anchor');

        gl.depthRange(depthMode.range[0], depthMode.range[1]);
        try {
            for (const coord of coords) {
                const tile = tileManager.getTile(coord);
                const bucket = tile?.getBucket(layer) as SegmentedLineBucket | undefined;
                // `drawLine` skips the tile outright while its patterns are still
                // loading, before it even looks for a bucket.
                if (!tile?.patternsLoaded?.()) { this._skip('pattern-not-loaded'); continue; }
                if (!bucket || !tile.imageAtlasTexture) { this._skip('pattern-no-atlas'); continue; }

                const positions = isConstantPattern
                    ? resolvePatternPositions(
                        tile.imageAtlas?.patternPositions as never, constantPattern as never, declared)
                    : null;
                if (isConstantPattern && !positions) { this._skip('pattern-unresolved-positions'); continue; }

                const buffers = this._buffersFor(bucket, gl);
                if (!buffers || buffers.segments.length === 0) { this._skip('pattern-no-buffers'); continue; }

                const paint = this._patternPaintAttributes(bucket, layer.id, crossfade, gl);
                if (positions) setConstantPatternUniforms(material, binders, positions);

                // Three skips `setTextureParameters` for an external texture, so
                // MIN_FILTER would stay at NEAREST_MIPMAP_LINEAR and the atlas
                // would sample as opaque black. See `fill_layer.ts`.
                tile.imageAtlasTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
                material.uniforms.u_image.value = this._externalTexture(tile.imageAtlasTexture.texture);

                const uniforms = linePatternTileUniforms(
                    1 / pixelsToTileUnits(tile, 1, transform.tileZoom),
                    crossfade,
                    tile.imageAtlasTexture.size as [number, number],
                );
                material.uniforms.u_texsize.value.fromArray(uniforms.texsize);
                material.uniforms.u_scale.value.fromArray(uniforms.scale);
                material.uniforms.u_fade.value = uniforms.fade;

                this._setCompositeFactors(material, layer, binders, bucket.zoom, transform.zoom);
                applyStencilMode(material, painter.stencilModeForClipping(coord), gl);

                material.uniforms.u_translation.value.fromArray(
                    translatePosition(transform, tile, translate, translateAnchor));
                material.uniforms.u_ratio.value = pixelRatio / pixelsToTileUnits(tile, 1, transform.zoom);

                const projectionData = transform.getProjectionData(
                    tileProjectionOptions(coord, isRenderingToTexture));
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

    /**
     * The gradient pass — MapLibre's `lineGradient` program.
     *
     * The colour ramp is rebuilt only when `layer.gradientVersion` moves past
     * the cached one, exactly as `bindGradientTextures` does, and it is stored
     * back in `bucket.gradients[layer.id]` so both backends share one texture.
     */
    private _drawGradient(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        tileManager: TileManager,
        layer: LineStyleLayer,
        coords: Array<OverscaledTileID>,
        isRenderingToTexture: boolean,
    ): void {
        const gl = painter.context.gl;
        const transform = painter.transform;
        const binders = describeBinders(layer.paint as never, LINE_GRADIENT_SPECS)!;
        const isGlobe = Boolean(painter.style.projection?.useSubdivision);
        const material = this._gradientMaterials.get(binders, isGlobe);
        this._mesh.material = material;
        this._setConstantUniforms(material, layer, binders);

        const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);
        material.depthTest = depthMode.func !== gl.ALWAYS;
        material.depthWrite = Boolean(depthMode.mask);
        material.transparent = true;
        material.blending = CustomBlending;
        material.blendSrc = OneFactor;
        material.blendDst = OneMinusSrcAlphaFactor;
        material.side = DoubleSide;
        material.needsUpdate = true;

        material.uniforms.u_device_pixel_ratio.value = painter.pixelRatio;
        // Upstream's `#ifdef TERRAIN3D` branch on `v_gamma_scale`, as a
        // uniform — see `line_program.ts`. Set on all four line variants
        // because all four upstream shaders carry the same branch.
        material.uniforms.u_flat_gamma.value = isRenderingToTexture ? 1 : 0;
        material.uniforms.u_units_to_pixels.value.set(
            1 / transform.pixelsToGLUnits[0],
            1 / transform.pixelsToGLUnits[1],
        );

        const pixelRatio = transform.getPixelScale();
        const translate = layer.paint.get('line-translate');
        const translateAnchor = layer.paint.get('line-translate-anchor');
        // A step expression has hard colour boundaries; sampling it LINEAR
        // blurs every boundary by a texel, which looks like a soft gradient
        // rather than like a defect.
        const filter = layer.stepInterpolant ? gl.NEAREST : gl.LINEAR;

        gl.depthRange(depthMode.range[0], depthMode.range[1]);
        try {
            for (const coord of coords) {
                const tile = tileManager.getTile(coord);
                const bucket = tile?.getBucket(layer) as GradientLineBucket | undefined;
                if (!bucket) { this._skip('gradient-no-bucket'); continue; }
                // Absent unless the source sets `lineMetrics: true`. The style
                // is still valid; MapLibre draws nothing for it either.
                if (!bucket.layoutVertexBuffer2?.buffer) { this._skip('gradient-no-line-metrics'); continue; }

                const buffers = this._gradientBuffersFor(bucket, gl);
                if (!buffers || buffers.segments.length === 0) { this._skip('gradient-no-buffers'); continue; }

                const layerGradient = bucket.gradients[layer.id];
                const texture = layer.gradientVersion !== layerGradient.version
                    ? updateGradientTexture(painter, tileManager, painter.context, gl, layer as never, bucket as never, coord, layerGradient)
                    : layerGradient.texture;
                // Three skips `setTextureParameters` for an external texture —
                // see `fill_layer.ts`. This is also where the step/interpolated
                // filter choice takes effect.
                texture.bind(filter, gl.CLAMP_TO_EDGE);
                material.uniforms.u_image.value = this._externalTexture(texture.texture);
                material.uniforms.u_image_height.value = bucket.lineClipsArray.length;

                const paint = this._paintAttributesFor(bucket, layer.id, gl);
                this._setCompositeFactors(material, layer, binders, bucket.zoom, transform.zoom);
                applyStencilMode(material, painter.stencilModeForClipping(coord), gl);

                material.uniforms.u_translation.value.fromArray(
                    translatePosition(transform, tile, translate, translateAnchor));
                material.uniforms.u_ratio.value = pixelRatio / pixelsToTileUnits(tile, 1, transform.zoom);

                const projectionData = transform.getProjectionData(
                    tileProjectionOptions(coord, isRenderingToTexture));
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

    /**
     * Gradient **and** dash — MapLibre's `lineGradientSDF`.
     *
     * Deliberately its own method rather than a flag on the two it resembles.
     * It needs the gradient path's second layout buffer *and* the dash path's
     * atlas, cross-faded paint attributes and `getDash`-before-`bind` ordering;
     * threading both through either existing method would put four conditionals
     * inside code whose comments explain why each step is where it is.
     *
     * It is also the first line material to sample **two** textures, so it
     * carries `invalidateThreeStateCache` — see `texture_bridge.ts`.
     */
    private _drawGradientDasharray(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        tileManager: TileManager,
        layer: LineStyleLayer,
        coords: Array<OverscaledTileID>,
        isRenderingToTexture: boolean,
    ): void {
        const gl = painter.context.gl;
        const transform = painter.transform;
        const binders = describeBinders(layer.paint as never, LINE_GRADIENT_SDF_SPECS, true)!;
        const isConstantDash = binders.find((b) => b.name === 'dasharray_from')?.kind === 'uniform';
        const isGlobe = Boolean(painter.style.projection?.useSubdivision);
        const material = this._gradientSdfMaterials.get(binders, isGlobe);
        this._mesh.material = material;
        this._setConstantUniforms(material, layer, binders.filter((b) => !b.crossFaded));

        const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);
        material.depthTest = depthMode.func !== gl.ALWAYS;
        material.depthWrite = Boolean(depthMode.mask);
        material.transparent = true;
        material.blending = CustomBlending;
        material.blendSrc = OneFactor;
        material.blendDst = OneMinusSrcAlphaFactor;
        material.side = DoubleSide;
        material.needsUpdate = true;

        material.uniforms.u_device_pixel_ratio.value = painter.pixelRatio;
        material.uniforms.u_flat_gamma.value = isRenderingToTexture ? 1 : 0;
        material.uniforms.u_units_to_pixels.value.set(
            1 / transform.pixelsToGLUnits[0],
            1 / transform.pixelsToGLUnits[1],
        );

        const lineAtlas = painter.lineAtlas;
        const crossfade = layer.getCrossfadeParameters();
        material.uniforms.u_crossfade_from.value = crossfade.fromScale;
        material.uniforms.u_crossfade_to.value = crossfade.toScale;
        material.uniforms.u_mix.value = crossfade.t;

        // `getDash` before `bind`, for the reason spelled out in
        // `_drawDasharray`: `getDash` is what adds the row and sets `dirty`.
        if (isConstantDash) {
            const constantDash = layer.paint.get('line-dasharray').constantOr(null as never) as
                {from: Array<number>; to: Array<number>} | null;
            if (!constantDash) { this._skip('gradient-dash-unresolved'); return; }
            const round = layer.layout.get('line-cap').constantOr(null as never) === 'round';
            setConstantDashUniforms(
                material, binders,
                lineAtlas.getDash(constantDash.from, round),
                lineAtlas.getDash(constantDash.to, round),
            );
        }

        lineAtlas.bind(painter.context);
        // **`u_image_dash`, not `u_image`.** The gradient ramp keeps `u_image`
        // in this program; putting the atlas there would sample the dash rows
        // as the line's colour and the ramp as its dash.
        material.uniforms.u_image_dash.value = this._externalTexture(lineAtlas.texture);
        material.uniforms.u_lineatlas_width.value = lineAtlas.width;
        material.uniforms.u_lineatlas_height.value = lineAtlas.height;

        const pixelRatio = transform.getPixelScale();
        const translate = layer.paint.get('line-translate');
        const translateAnchor = layer.paint.get('line-translate-anchor');
        const filter = layer.stepInterpolant ? gl.NEAREST : gl.LINEAR;

        gl.depthRange(depthMode.range[0], depthMode.range[1]);
        try {
            for (const coord of coords) {
                const tile = tileManager.getTile(coord);
                const bucket = tile?.getBucket(layer) as GradientLineBucket | undefined;
                if (!bucket) { this._skip('gradient-dash-no-bucket'); continue; }
                if (!bucket.layoutVertexBuffer2?.buffer) { this._skip('gradient-dash-no-line-metrics'); continue; }

                const buffers = this._gradientBuffersFor(bucket, gl);
                if (!buffers || buffers.segments.length === 0) { this._skip('gradient-dash-no-buffers'); continue; }

                const layerGradient = bucket.gradients[layer.id];
                const texture = layer.gradientVersion !== layerGradient.version
                    ? updateGradientTexture(painter, tileManager, painter.context, gl, layer as never, bucket as never, coord, layerGradient)
                    : layerGradient.texture;
                texture.bind(filter, gl.CLAMP_TO_EDGE);
                material.uniforms.u_image.value = this._externalTexture(texture.texture);
                material.uniforms.u_image_height.value = bucket.lineClipsArray.length;
                // Two textures, and MapLibre has just bound both itself.
                invalidateThreeStateCache(renderer, gl);

                const paint = this._patternPaintAttributes(bucket as never, layer.id, crossfade, gl);

                material.uniforms.u_tileratio.value = 1 / pixelsToTileUnits(tile, 1, transform.tileZoom);
                this._setCompositeFactors(material, layer, binders, bucket.zoom, transform.zoom);
                applyStencilMode(material, painter.stencilModeForClipping(coord), gl);

                material.uniforms.u_translation.value.fromArray(
                    translatePosition(transform, tile, translate, translateAnchor));
                material.uniforms.u_ratio.value = pixelRatio / pixelsToTileUnits(tile, 1, transform.zoom);

                const projectionData = transform.getProjectionData(
                    tileProjectionOptions(coord, isRenderingToTexture));
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

    /**
     * The dashed-line pass — MapLibre's `lineSDF` program.
     *
     * The one structural difference from `_drawPattern`: the atlas is
     * `painter.lineAtlas`, a single texture for the whole map rather than one
     * per tile, so it is bound **once** before the loop. `bind` also uploads it
     * when `dirty` — a new dash pattern appearing mid-session sets that flag,
     * and skipping the call leaves the new rows unwritten while the old ones
     * still sample fine, so the symptom would be one layer dashed wrongly
     * rather than any error.
     */
    private _drawDasharray(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        tileManager: TileManager,
        layer: LineStyleLayer,
        coords: Array<OverscaledTileID>,
        isRenderingToTexture: boolean,
    ): void {
        const gl = painter.context.gl;
        const transform = painter.transform;
        const binders = describeBinders(layer.paint as never, LINE_DASHARRAY_SPECS, true)!;
        const isConstantDash = binders.find((b) => b.name === 'dasharray_from')?.kind === 'uniform';
        const isGlobe = Boolean(painter.style.projection?.useSubdivision);
        const material = this._dashMaterials.get(binders, isGlobe);
        this._mesh.material = material;
        this._setConstantUniforms(material, layer, binders.filter((b) => !b.crossFaded));

        const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);
        material.depthTest = depthMode.func !== gl.ALWAYS;
        material.depthWrite = Boolean(depthMode.mask);
        material.transparent = true;
        material.blending = CustomBlending;
        material.blendSrc = OneFactor;
        material.blendDst = OneMinusSrcAlphaFactor;
        material.side = DoubleSide;
        material.needsUpdate = true;

        material.uniforms.u_device_pixel_ratio.value = painter.pixelRatio;
        // Upstream's `#ifdef TERRAIN3D` branch on `v_gamma_scale`, as a
        // uniform — see `line_program.ts`. Set on all four line variants
        // because all four upstream shaders carry the same branch.
        material.uniforms.u_flat_gamma.value = isRenderingToTexture ? 1 : 0;
        material.uniforms.u_units_to_pixels.value.set(
            1 / transform.pixelsToGLUnits[0],
            1 / transform.pixelsToGLUnits[1],
        );

        const lineAtlas = painter.lineAtlas;
        const crossfade = layer.getCrossfadeParameters();
        material.uniforms.u_crossfade_from.value = crossfade.fromScale;
        material.uniforms.u_crossfade_to.value = crossfade.toScale;
        material.uniforms.u_mix.value = crossfade.t;

        // **Before `bind`, and that order is the whole thing.** `getDash` is
        // what *adds a row* to the atlas the first time a dash pattern is seen,
        // and adding a row sets `dirty`; `bind` is what uploads it. Binding
        // first uploads the atlas as it was, then the new row is written to the
        // CPU copy only — so the shader samples a row the texture does not yet
        // contain.
        //
        // It repairs itself on the next frame, which is exactly why no probe
        // scene could see it: the probe renders until the map settles, while a
        // render fixture captures a single frame. Twenty `line-dasharray`
        // fixtures went red on a backend whose every probe row matched.
        if (isConstantDash) {
            const constantDash = layer.paint.get('line-dasharray').constantOr(null as never) as
                {from: Array<number>; to: Array<number>} | null;
            if (!constantDash) { this._skip('dash-unresolved'); return; }
            // A layout property, not a paint one: round caps bake semicircles
            // into the dash ends, so they select a different atlas row rather
            // than changing a uniform.
            const round = layer.layout.get('line-cap').constantOr(null as never) === 'round';
            setConstantDashUniforms(
                material, binders,
                lineAtlas.getDash(constantDash.from, round),
                lineAtlas.getDash(constantDash.to, round),
            );
        }

        // Creates the texture on first use and re-uploads it when dirty. Unlike
        // the image atlas this one sets REPEAT/LINEAR at creation and uses no
        // mipmaps, so it reaches Three already complete.
        lineAtlas.bind(painter.context);
        material.uniforms.u_image.value = this._externalTexture(lineAtlas.texture);
        material.uniforms.u_lineatlas_width.value = lineAtlas.width;
        material.uniforms.u_lineatlas_height.value = lineAtlas.height;

        const pixelRatio = transform.getPixelScale();
        const translate = layer.paint.get('line-translate');
        const translateAnchor = layer.paint.get('line-translate-anchor');

        gl.depthRange(depthMode.range[0], depthMode.range[1]);
        try {
            for (const coord of coords) {
                const tile = tileManager.getTile(coord);
                const bucket = tile?.getBucket(layer) as SegmentedLineBucket | undefined;
                if (!bucket) { this._skip('dash-no-bucket'); continue; }

                const buffers = this._buffersFor(bucket, gl);
                if (!buffers || buffers.segments.length === 0) { this._skip('dash-no-buffers'); continue; }

                const paint = this._patternPaintAttributes(bucket, layer.id, crossfade, gl);

                material.uniforms.u_tileratio.value = 1 / pixelsToTileUnits(tile, 1, transform.tileZoom);
                this._setCompositeFactors(material, layer, binders, bucket.zoom, transform.zoom);
                applyStencilMode(material, painter.stencilModeForClipping(coord), gl);

                material.uniforms.u_translation.value.fromArray(
                    translatePosition(transform, tile, translate, translateAnchor));
                material.uniforms.u_ratio.value = pixelRatio / pixelsToTileUnits(tile, 1, transform.zoom);

                const projectionData = transform.getProjectionData(
                    tileProjectionOptions(coord, isRenderingToTexture));
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

    /**
     * Paint attributes for a cross-faded configuration.
     *
     * `updatePaintBuffers(crossfade)` is not optional and not a refresh: a
     * cross-faded binder holds two zoom-specific buffers and publishes
     * **neither** until this is called with the frame's crossfade state. Without
     * it the attribute list is empty, every bind points at nothing, and the
     * shader reads zeros — a pattern that draws, counts, and is invisible.
     */
    private _patternPaintAttributes(
        bucket: SegmentedLineBucket,
        layerId: string,
        crossfade: Parameters<ProgramConfiguration['updatePaintBuffers']>[0],
        gl: WebGLRenderingContext,
    ): PaintAttributes {
        const programConfiguration = bucket.programConfigurations.get(layerId);
        programConfiguration.updatePaintBuffers(crossfade);
        return this._paintAttributes.get(bucket, programConfiguration, gl);
    }

    private _externalTexture(texture: WebGLTexture): ExternalTexture {
        let wrapped = this._externalTextures.get(texture);
        if (!wrapped) {
            wrapped = new ExternalTexture(texture);
            this._externalTextures.set(texture, wrapped);
        }
        return wrapped;
    }

    private _setConstantUniforms(
        material: RawShaderMaterial,
        layer: LineStyleLayer,
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
        layer: LineStyleLayer,
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
    private _buffersFor(bucket: SegmentedLineBucket, gl: WebGLRenderingContext): BucketBuffers | null {
        if (!bucket.layoutVertexBuffer?.buffer || !bucket.indexBuffer?.buffer) return null;

        return this._buffers.get(bucket, () => ({
            layoutBuffers: [bucket.layoutVertexBuffer as never],
            indexBuffer: bucket.indexBuffer.buffer,
            indexType: gl.UNSIGNED_SHORT,
            indexBytes: 2,
            indexCount: bucket.indexArray.length * INDICES_PER_TRIANGLE,
            segments: bucket.segments.segments,
            indicesPerPrimitive: INDICES_PER_TRIANGLE,
            gl,
        }));
    }

    private _gradientBuffersFor(bucket: GradientLineBucket, gl: WebGLRenderingContext): BucketBuffers | null {
        if (!bucket.layoutVertexBuffer?.buffer || !bucket.indexBuffer?.buffer) return null;

        return this._gradientBuffers.get(bucket, () => ({
            layoutBuffers: [bucket.layoutVertexBuffer as never, bucket.layoutVertexBuffer2 as never],
            indexBuffer: bucket.indexBuffer.buffer,
            indexType: gl.UNSIGNED_SHORT,
            indexBytes: 2,
            indexCount: bucket.indexArray.length * INDICES_PER_TRIANGLE,
            segments: bucket.segments.segments,
            indicesPerPrimitive: INDICES_PER_TRIANGLE,
            gl,
        }));
    }

    private _paintAttributesFor(bucket: SegmentedLineBucket, layerId: string, gl: WebGLRenderingContext): PaintAttributes {
        return this._paintAttributes.get(bucket, bucket.programConfigurations.get(layerId), gl);
    }

    destroy(): void {
        // The geometry is deliberately not disposed: its attributes point at
        // MapLibre's GL buffers. See `bucket_geometry.ts`.
        this._materials.dispose();
        this._patternMaterials.dispose();
        this._dashMaterials.dispose();
        this._gradientMaterials.dispose();
        this._gradientSdfMaterials.dispose();
    }
}
