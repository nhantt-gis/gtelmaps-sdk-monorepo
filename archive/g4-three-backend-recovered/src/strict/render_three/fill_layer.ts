import {
    BackSide,
    BufferGeometry,
    CustomBlending,
    ExternalTexture,
    FrontSide,
    LineSegments,
    Mesh,
    NoBlending,
    OneFactor,
    OneMinusSrcAlphaFactor,
    type Vector4,
} from 'three';

import {DepthMode} from '../../gl/depth_mode';
import {pixelsToTileUnits} from '../../source/pixels_to_tile_units';
import {translatePosition} from '../../util/util';
import {applyProjectionData, tileProjectionOptions} from './projection_bridge';
import {applyGlobeProjectionData} from './projection_globe';
import {applyStencilMode} from './stencil_bridge';
import {positionSlot, SceneBatch} from './scene_batch';
import {BucketBuffersCache, type BucketBuffers} from './bucket_geometry';
import {
    createFillOutlinePatternMaterial,
    createFillPatternMaterial,
    PATTERN_SPECS,
    PatternMaterialCache,
    patternTileUniforms,
} from './fill_pattern_program';
import {resolvePatternPositions, setConstantPatternUniforms} from './pattern_positions';
import {
    attributesCoverBinders,
    classifyPaintValue,
    compositeInterpolationFactor,
    describeBinders,
    PaintAttributesCache,
    type BinderDescription,
    type PaintAttributes,
} from './paint_binders';
import {
    createFillMaterial,
    createOutlineMaterial,
    FillMaterialCache,
    FILL_SPECS,
    OUTLINE_SPECS,
} from './fill_program';

import type {Camera, RawShaderMaterial, WebGLRenderer} from 'three';
import type {Color} from '@maplibre/maplibre-gl-style-spec';
import type {FillBucket} from '../../data/bucket/fill_bucket';
import type {FillStyleLayer} from '../../style/style_layer/fill_style_layer';
import type {OverscaledTileID} from '../../tile/tile_id';
import type {Painter, RenderOptions} from '../../render/painter';
import type {ProgramConfiguration} from '../../data/program_configuration';
import type {TileManager} from '../../tile/tile_manager';

/**
 * Draws `fill` through Three, for the cases it can, and says so when it cannot.
 *
 * ## Scope
 *
 * Mercator **and globe**, including `fill-pattern`, no terrain, no overdraw
 * inspector. Paint properties may be **constant or data-driven** — the latter
 * through the binder bridge in `paint_binders.ts`. Composite expressions (data
 * *and* zoom together) are still declined; see `canDraw`.
 *
 * ## What is different from `background`
 *
 * `background` draws a synthetic quad this renderer builds itself. `fill` draws
 * **the bucket's own vertices**, which brings in things the background path
 * never touched:
 *
 * - **Segments.** See `bucket_geometry.ts`; indices are relative to each
 *   segment's own vertex base.
 * - **Stencil tile clipping.** MapLibre masks each tile against a stencil value
 *   written earlier in the frame. Skipping it does not produce an obviously
 *   broken frame — it produces overdraw at tile boundaries where a parent tile
 *   and its children overlap, which reads as a seam artefact.
 * - **Two passes per layer.** `fill-antialias` defaults to `true`, so a fill
 *   layer normally draws a triangle pass *and* a line pass, at different
 *   sublayer depths and from different index buffers. Taking over the layer
 *   means taking over both; drawing only the triangles would silently drop every
 *   outline in the style.
 * - **A program per paint configuration.** The shader source itself depends on
 *   which properties are attributes, so there is no single fill material. See
 *   `fill_program.ts`.
 */
export type FillStats = {
    /** Tile draws issued by Three, counting the fill and outline passes apart. */
    drawn: number;
    /** Layer draws handed back to MapLibre, by reason. */
    fellBack: Record<string, number>;

    /**
     * Tiles skipped **inside** a draw this renderer already claimed, by reason.
     *
     * `canDraw` and `draw` decide independently, so any disagreement between
     * them is silent: the layer is claimed, every tile is then skipped, and
     * nobody draws it. That shape has appeared three times from three unrelated
     * causes (a per-tile refusal misplaced in `draw`, a mistyped property name,
     * a constant-position lookup on the attribute path), and each time the only
     * signal was `drawn === 0` — a number that cannot distinguish "nothing to
     * draw" from "everything refused". Naming the reason here makes the
     * difference readable instead of inferred.
     */
    skipped: Record<string, number>;
};

/** `SegmentVector`'s public shape, without importing the class. */
type SegmentedBucket = FillBucket & {
    segments: {segments: Array<{vertexOffset: number; vertexLength: number; primitiveOffset: number; primitiveLength: number}>};
    segments2: {segments: Array<{vertexOffset: number; vertexLength: number; primitiveOffset: number; primitiveLength: number}>};
    programConfigurations: {get(layerId: string): ProgramConfiguration};
};

type PassSetup = {
    isOutline: boolean;
    binders: ReadonlyArray<BinderDescription>;
    opacity: number;
    depthMode: Readonly<DepthMode>;
    isOpaque: boolean;
    /** False on the normal path; true inside a terrain render target. */
    isRenderingToTexture: boolean;
};

export class FillRenderer {
    readonly stats: FillStats = {drawn: 0, fellBack: {}, skipped: {}};

    /** Triangles and outlines come from different index buffers of one bucket. */
    private readonly _fillBuffers = new BucketBuffersCache();
    private readonly _outlineBuffers = new BucketBuffersCache();
    private readonly _paintAttributes = new PaintAttributesCache();
    /**
     * One batch per pass kind. Three splits its render list into opaque and
     * transparent, so mixing the two in one flush would reorder them — see
     * `scene_batch.ts`.
     */
    private readonly _fillBatch = new SceneBatch();
    /**
     * Line primitives, not triangles. A `Mesh` here draws the outline as a
     * filled polygon — which reads as a slightly wrong fill, not as a missing
     * outline.
     */
    private readonly _outlineBatch = new SceneBatch(
        (geometry, material) => new LineSegments(geometry, material));

    private readonly _fillMaterials = new FillMaterialCache(createFillMaterial);
    private readonly _outlineMaterials = new FillMaterialCache(createOutlineMaterial);

    private readonly _fillMesh: Mesh;
    private readonly _outlineMesh: LineSegments;

    /**
     * Two geometries for the whole renderer, repointed per segment.
     *
     * Not one geometry per bucket: Three keys internal binding state by
     * `geometry.id` and only releases it on `dispose()`, which these geometries
     * must never receive — see `bucket_geometry.ts`. A geometry per bucket would
     * therefore accumulate one permanent binding-state entry per tile, for the
     * life of the session. Two fixed geometries make that bounded by
     * construction.
     */
    private readonly _fillGeometry = new BufferGeometry();
    private readonly _outlineGeometry = new BufferGeometry();

    private readonly _patternMaterials = new PatternMaterialCache(createFillPatternMaterial);
    private readonly _patternOutlineMaterials = new PatternMaterialCache(createFillOutlinePatternMaterial);
    private readonly _externalTextures = new WeakMap<WebGLTexture, ExternalTexture>();

    constructor() {
        this._fillMesh = new Mesh(this._fillGeometry);
        this._outlineMesh = new LineSegments(this._outlineGeometry);
    }

    private _fallBack(reason: string): false {
        this.stats.fellBack[reason] = (this.stats.fellBack[reason] ?? 0) + 1;
        return false;
    }

    /** Every `continue` in a draw loop goes through here. See {@link FillStats.skipped}. */
    private _skip(reason: string): void {
        this.stats.skipped[reason] = (this.stats.skipped[reason] ?? 0) + 1;
    }

    /**
     * Whether this renderer can draw `layer` at all — asked **before** the
     * context is handed to Three.
     *
     * The split exists because the handover has side effects on GL state; see
     * the same method on `BackgroundRenderer`, where performing it around a
     * declined layer cost 52 terrain fixtures.
     */
    canDraw(
        painter: Painter,
        tileManager: TileManager,
        layer: FillStyleLayer,
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
        if (layer.paint.get('fill-pattern').constantOr(1 as any)) {
            return this._canDrawPattern(layer);
        }

        const specs = layer.paint.get('fill-antialias') ?
            [...FILL_SPECS, ...OUTLINE_SPECS] : FILL_SPECS;
        const binders = describeBinders(layer.paint as never, specs);
        if (!binders) return this._fallBack('unsupported-expression');

        // The buffer cross-check belongs **here**, not per tile inside `draw`.
        // Once `draw` returns true this renderer owns the layer, so a tile
        // refused at that point is drawn by nobody and disappears from the
        // frame. That is exactly what happened when this check lived in the
        // draw loop: the probe showed a bare background where the polygon should
        // have been, with the fallback counter climbing.
        return this._buffersAgreeWithStyle(tileManager, layer, coords, binders, painter.context.gl);
    }

    /**
     * Patterns, for the slice this backend covers.
     *
     * Constant and per-feature patterns both draw, with and without
     * antialiasing — the stroke goes through `fillOutlinePattern`. What is still
     * declined is listed below, each for a stated reason rather than caution.
     */
    private _canDrawPattern(layer: FillStyleLayer): boolean {
        // With an explicit `fill-outline-color`, MapLibre strokes with the plain
        // `fillOutline` program in that colour rather than with the pattern.
        // Handled in `_drawPattern` by dispatching the stroke to `_drawPass`,
        // the same method the unpatterned path uses — so the binder set has to
        // be describable there too, or the layer would be claimed and then
        // stroked with nothing.
        if (layer.paint.get('fill-antialias') && layer.getPaintProperty('fill-outline-color') &&
            !describeBinders(layer.paint as never, OUTLINE_SPECS)) {
            return this._fallBack('pattern-outline-expression');
        }

        const classified = classifyPaintValue(layer.paint.get('fill-pattern'));
        if (!classified?.crossFaded) return this._fallBack('pattern-unsupported-expression');
        // Both `uniform` (a constant pattern) and `source` (per feature) are
        // drawn; they differ in whether the atlas rectangles arrive as uniforms
        // or as attributes, and the emitters already express that.
        if (classified.kind === 'composite') return this._fallBack('pattern-composite');
        return true;
    }

    /**
     * Whether every tile's buckets carry the attributes `binders` declare.
     *
     * Tiles with no bucket yet are not evidence of disagreement — they are
     * simply not loaded, and `draw` skips them.
     */
    private _buffersAgreeWithStyle(
        tileManager: TileManager,
        layer: FillStyleLayer,
        coords: Array<OverscaledTileID>,
        binders: ReadonlyArray<BinderDescription>,
        gl: WebGLRenderingContext,
    ): boolean {
        for (const coord of coords) {
            const bucket = tileManager.getTile(coord)?.getBucket(layer) as SegmentedBucket | undefined;
            if (!bucket?.programConfigurations) continue;
            const paint = this._paintAttributesFor(bucket, layer.id, gl);
            if (!attributesCoverBinders(binders, paint.names)) return this._fallBack('binder-mismatch');
        }
        return true;
    }

    /**
     * Draws the layer. Only valid after {@link canDraw} has returned `true`.
     *
     * Always returns `true`: once this renderer owns the layer it owns it in
     * every pass, including the passes where it paints nothing. Returning
     * `false` from one of those would let MapLibre draw the layer as well.
     */
    draw(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        tileManager: TileManager,
        layer: FillStyleLayer,
        coords: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
    ): boolean {
        const {isRenderingToTexture} = renderOptions;
        if (layer.paint.get('fill-pattern').constantOr(1 as any)) {
            return this._drawPattern(renderer, camera, painter, tileManager, layer, coords, isRenderingToTexture);
        }

        const opacityValue = layer.paint.get('fill-opacity');
        const opacity = opacityValue.constantOr(1);
        // Only a constant zero means the whole layer paints nothing; a
        // data-driven opacity that happens to be zero for every feature still
        // has to go through the shader.
        if (opacityValue.isConstant() && opacity === 0) return true;

        const fillBinders = describeBinders(layer.paint as never, FILL_SPECS)!;
        const color = layer.paint.get('fill-color').constantOr(null as unknown as Color);
        // The opaque pass is only available when *every* contributing property
        // is a known constant. A data-driven colour may contain any alpha, so
        // the layer has to be treated as translucent.
        const isOpaque = painter.opaquePassEnabledForLayer() &&
            fillBinders.every((binder) => binder.kind === 'uniform') &&
            color?.a === 1 && opacity === 1;

        if (painter.renderPass === (isOpaque ? 'opaque' : 'translucent')) {
            this._drawPass(renderer, camera, painter, tileManager, layer, coords, {
                isOutline: false,
                binders: fillBinders,
                opacity,
                depthMode: painter.getDepthModeForSublayer(
                    1, isOpaque ? DepthMode.ReadWrite : DepthMode.ReadOnly),
                isOpaque,
                isRenderingToTexture,
            });
        }

        if (painter.renderPass === 'translucent' && layer.paint.get('fill-antialias')) {
            // Sublayer 2 when an explicit outline colour is set, 0 otherwise —
            // MapLibre's own choice, which controls whether the outline is
            // depth-separated from the fill it belongs to.
            const sublayer = layer.getPaintProperty('fill-outline-color') ? 2 : 0;
            this._drawPass(renderer, camera, painter, tileManager, layer, coords, {
                isOutline: true,
                binders: describeBinders(layer.paint as never, OUTLINE_SPECS)!,
                opacity,
                depthMode: painter.getDepthModeForSublayer(sublayer, DepthMode.ReadOnly),
                isOpaque: false,
                isRenderingToTexture,
            });
        }

        return true;
    }

    private _drawPass(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        tileManager: TileManager,
        layer: FillStyleLayer,
        coords: Array<OverscaledTileID>,
        pass: PassSetup,
    ): void {
        const {isOutline, binders, depthMode, isOpaque, isRenderingToTexture} = pass;
        const what = isOutline ? 'outline' : 'fill';
        const gl = painter.context.gl;
        const isGlobe = Boolean(painter.style.projection?.useSubdivision);
        const base = (isOutline ? this._outlineMaterials : this._fillMaterials).get(binders, isGlobe);
        const batch = isOutline ? this._outlineBatch : this._fillBatch;
        batch.begin();

        const translate = layer.paint.get('fill-translate');
        const translateAnchor = layer.paint.get('fill-translate-anchor');

        // See `background_layer.ts`: Three has no depthRange, and without it
        // every sublayer collapses onto the same depth.
        gl.depthRange(depthMode.range[0], depthMode.range[1]);
        try {
            for (const coord of coords) {
                const tile = tileManager.getTile(coord);
                const bucket = tile?.getBucket(layer) as SegmentedBucket | undefined;
                if (!bucket) { this._skip(`${what}-no-bucket`); continue; }

                const buffers = this._buffersFor(bucket, isOutline, gl);
                if (!buffers || buffers.segments.length === 0) { this._skip(`${what}-no-buffers`); continue; }

                const paint = this._paintAttributesFor(bucket, layer.id, gl);
                const stencilMode = painter.stencilModeForClipping(coord);
                const translation = translatePosition(painter.transform, tile, translate, translateAnchor);
                const projectionData = painter.transform.getProjectionData(tileProjectionOptions(coord, isRenderingToTexture));

                for (let i = 0; i < buffers.segments.length; i++) {
                    // **The layer id is part of the key, and leaving it out cost
                    // eight fixtures.** Two `fill` layers with the same paint
                    // *shape* share one base material — the material cache is
                    // keyed by binder kinds, not by layer — so without it the
                    // second layer reused the first layer's slot and drew in the
                    // first layer's colour.
                    const slot = batch.slot(`${layer.id}:${coord.key}:${i}`, base);
                    const material = slot.material;

                    // Written every draw, not once per slot. A first version set
                    // them only on the frame a slot appeared, which is wrong for
                    // a second reason beyond the key: a paint property with a
                    // transition re-evaluates its "constant" every frame. These
                    // are plain object writes, not GL calls — the batching win
                    // was never in skipping them.
                    this._setConstantUniforms(material, layer, binders);
                    if (isOutline) {
                        material.uniforms.u_world.value.set(gl.drawingBufferWidth, gl.drawingBufferHeight);
                    }
                    material.depthTest = depthMode.func !== gl.ALWAYS;
                    material.depthWrite = Boolean(depthMode.mask);
                    // ColorMode.unblended is [ONE, ZERO], which is blending
                    // switched off; ColorMode.alphaBlended is
                    // [ONE, ONE_MINUS_SRC_ALPHA] against premultiplied colours.
                    material.transparent = !isOpaque;
                    material.blending = isOpaque ? NoBlending : CustomBlending;
                    material.blendSrc = OneFactor;
                    material.blendDst = OneMinusSrcAlphaFactor;
                    // MapLibre's CullFaceMode.backCCW. Lines ignore side — so
                    // the globe inversion below is a no-op for the outline pass,
                    // which is exactly why the outline shader has to clip in
                    // software instead. See `fill_program.ts` and §14.
                    material.side = isGlobe ? BackSide : FrontSide;
                    // Only on the first frame: `needsUpdate` makes Three
                    // re-resolve the program, and doing that per draw per frame
                    // would cost more than the whole batching saves.
                    if (slot.isNew) material.needsUpdate = true;

                    // Per tile, not per layer: an overzoomed bucket carries zoom
                    // endpoints from a lower zoom than its neighbours.
                    this._setCompositeFactors(material, layer, binders, bucket.zoom, painter.transform.zoom);
                    applyStencilMode(material, stencilMode, gl);
                    material.uniforms.u_fill_translate.value.fromArray(translation);
                    // Per slot, not per tile: `SceneBatch` hands out a **clone**
                    // of the base material, and `clone()` deep-copies uniform
                    // values — so each slot carries its own tile's mercator
                    // coordinates rather than sharing the last one written.
                    if (isGlobe) applyGlobeProjectionData(material, projectionData);
                    positionSlot(slot, projectionData);

                    buffers.bindSegment(slot.geometry, i);
                    paint.bindSegment(slot.geometry, buffers.segments[i].vertexOffset);
                    this.stats.drawn++;
                }
            }
            batch.flush(renderer, camera);
        } finally {
            gl.depthRange(0, 1);
        }
    }

    /** Values for the properties this configuration compiled as uniforms. */
    private _setConstantUniforms(
        material: RawShaderMaterial,
        layer: FillStyleLayer,
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
                (slot.value as Vector4).set(color.r, color.g, color.b, color.a);
            }
        }
    }

    /**
     * Draws a constant-pattern fill.
     *
     * ## The texture handover
     *
     * MapLibre's atlas is a raw `WebGLTexture`; `ExternalTexture` is Three's own
     * wrapper for one. Unlike the geometry buffers it is **safe to dispose** —
     * `setTexture2D`'s external branch skips `initTexture`, so `__webglInit` is
     * never set and `deallocateTexture` returns before `deleteTexture`. Two
     * opposite rules in one backend; see the G4 plan §6.4 before harmonising
     * them.
     *
     * The wrapper is cached per `WebGLTexture` because Three keys its own state
     * on the wrapper object, and a fresh one each frame would re-record the same
     * texture under a new key for the life of the session.
     */
    private _drawPattern(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        tileManager: TileManager,
        layer: FillStyleLayer,
        coords: Array<OverscaledTileID>,
        isRenderingToTexture: boolean,
    ): boolean {
        const opacity = layer.paint.get('fill-opacity').constantOr(1);
        if (opacity === 0) return true;
        // Patterns always carry alpha, so MapLibre draws them translucent.
        if (painter.renderPass !== 'translucent') return true;

        const gl = painter.context.gl;
        const transform = painter.transform;
        const binders = describeBinders(layer.paint as never, PATTERN_SPECS, true)!;
        const isConstantPattern = binders.find((b) => b.name === 'pattern_from')?.kind === 'uniform';
        const isGlobe = Boolean(painter.style.projection?.useSubdivision);
        const material = this._patternMaterials.get(binders, isGlobe);
        this._fillMesh.material = material;

        const depthMode = painter.getDepthModeForSublayer(1, DepthMode.ReadOnly);
        material.depthTest = depthMode.func !== gl.ALWAYS;
        material.depthWrite = Boolean(depthMode.mask);
        material.transparent = true;
        material.blending = CustomBlending;
        material.blendSrc = OneFactor;
        material.blendDst = OneMinusSrcAlphaFactor;
        // MapLibre's CullFaceMode.backCCW, inverted under globe because Three
        // flips the winding itself — see `raster_layer.ts` and §14. Set here and
        // **only** here: an earlier version of this step also set it beside the
        // material lookup above, and this line silently overwrote it, which the
        // `globe fill pattern` probe scene reported as a bare background.
        material.side = isGlobe ? BackSide : FrontSide;
        material.needsUpdate = true;
        // **Only when it compiled as a uniform.** `opacity` is an ordinary paint
        // binder in the pattern shader, so a data-driven one becomes an
        // attribute and `u_opacity` does not exist — writing it then throws, and
        // a throw inside the handover is a dead frame, not a wrong pixel. This
        // path used to refuse such layers outright (`pattern-data-driven-opacity`)
        // for want of this one check.
        if (material.uniforms.u_opacity) material.uniforms.u_opacity.value = opacity;

        const crossfade = layer.getCrossfadeParameters();
        const constantPattern = layer.paint.get('fill-pattern').constantOr(null as never);
        const declared = layer.getPaintProperty('fill-pattern') as string | undefined;
        const translate = layer.paint.get('fill-translate');
        const translateAnchor = layer.paint.get('fill-translate-anchor');

        gl.depthRange(depthMode.range[0], depthMode.range[1]);
        try {
            for (const coord of coords) {
                const tile = tileManager.getTile(coord);
                const bucket = tile?.getBucket(layer) as SegmentedBucket | undefined;
                if (!bucket || !tile?.imageAtlasTexture) { this._skip('pattern-no-atlas'); continue; }

                // Only a **constant** pattern resolves its rectangles here; per
                // feature they arrive as attributes and there is nothing to look
                // up. Requiring them unconditionally — which the first version
                // did — made `constantOr(null)` return null for every
                // data-driven layer, so every tile was skipped while `canDraw`
                // had already claimed the layer: drawn by nobody, the G4-3b
                // failure shape exactly, and the probe showed a bare background.
                const positions = isConstantPattern
                    ? resolvePatternPositions(
                        tile.imageAtlas?.patternPositions as never, constantPattern as never, declared)
                    : null;
                // Skipping the tile for a frame is what MapLibre does too — the
                // atlas is mid-rebuild. Drawing with unresolved positions is the
                // wrong-pixel-ratio bug, not a blank tile.
                if (isConstantPattern && !positions) { this._skip('pattern-unresolved-positions'); continue; }

                const buffers = this._buffersFor(bucket, false, gl);
                if (!buffers || buffers.segments.length === 0) { this._skip('pattern-no-buffers'); continue; }

                const paint = this._patternPaintAttributes(bucket, layer.id, crossfade, gl);

                // Only when the pattern is constant. Per feature the same
                // rectangles arrive as attributes, and there is no uniform to
                // write — `material.uniforms.u_pattern_from` does not exist.
                if (positions) setConstantPatternUniforms(material, binders, positions);
                // Sets the texture's filter and wrap parameters, which MapLibre
                // applies at bind time rather than at creation. Three skips
                // `uploadTexture` for an external texture and therefore never
                // sets them, leaving MIN_FILTER at its default
                // NEAREST_MIPMAP_LINEAR — and a texture with no mipmaps and a
                // mipmap filter is *incomplete*, which WebGL samples as opaque
                // black. That was the measured symptom: [0,0,0,255] with the
                // draw counter confirming 36 real draws.
                //
                // The parameters live on the texture object, so doing this once
                // per tile per frame is enough; Three's own bind afterwards
                // keeps them.
                tile.imageAtlasTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
                material.uniforms.u_image.value = this._externalTexture(tile.imageAtlasTexture.texture);

                const uniforms = patternTileUniforms(
                    tile as never,
                    transform.tileZoom,
                    1 / pixelsToTileUnits(tile, 1, transform.tileZoom),
                    crossfade,
                    tile.imageAtlasTexture.size as [number, number],
                );
                material.uniforms.u_texsize.value.fromArray(uniforms.texsize);
                material.uniforms.u_scale.value.fromArray(uniforms.scale);
                material.uniforms.u_fade.value = uniforms.fade;
                material.uniforms.u_pixel_coord_upper.value.fromArray(uniforms.pixelCoordUpper);
                material.uniforms.u_pixel_coord_lower.value.fromArray(uniforms.pixelCoordLower);
                material.uniforms.u_fill_translate.value.fromArray(
                    translatePosition(transform, tile, translate, translateAnchor));

                applyStencilMode(material, painter.stencilModeForClipping(coord), gl);
                const projectionData = transform.getProjectionData(
                    tileProjectionOptions(coord, isRenderingToTexture));
                if (isGlobe) applyGlobeProjectionData(material, projectionData);
                applyProjectionData(this._fillMesh, projectionData);

                for (let i = 0; i < buffers.segments.length; i++) {
                    buffers.bindSegment(this._fillGeometry, i);
                    paint.bindSegment(this._fillGeometry, buffers.segments[i].vertexOffset);
                    renderer.render(this._fillMesh, camera);
                    this.stats.drawn++;
                }
            }
        } finally {
            gl.depthRange(0, 1);
        }

        if (layer.paint.get('fill-antialias')) {
            // `drawFill` picks `fillOutline` over `fillOutlinePattern` whenever
            // an explicit `fill-outline-color` is set — the stroke is that
            // colour, not the pattern — and puts it on sublayer 2 rather than 0.
            // Both facts come from the same two lines upstream, and taking only
            // the first draws a correctly-coloured outline at the wrong depth.
            if (layer.getPaintProperty('fill-outline-color')) {
                this._drawPass(renderer, camera, painter, tileManager, layer, coords, {
                    isOutline: true,
                    binders: describeBinders(layer.paint as never, OUTLINE_SPECS)!,
                    opacity,
                    depthMode: painter.getDepthModeForSublayer(2, DepthMode.ReadOnly),
                    isOpaque: false,
                    isRenderingToTexture,
                });
                return true;
            }
            this._drawPatternOutline(renderer, camera, painter, tileManager, layer, coords, opacity, isRenderingToTexture);
        }

        return true;
    }

    /**
     * The stroke for a patterned fill — MapLibre's `fillOutlinePattern`.
     *
     * A separate pass rather than a branch: it reads the *second* index buffer
     * as line primitives, at its own sublayer depth. Folding it into the fill
     * loop would draw the outline from the triangle buffer, which still draws
     * lines — just the wrong ones.
     *
     * Sublayer 0, because this path only runs when no explicit
     * `fill-outline-color` is set; MapLibre uses sublayer 2 in the other case,
     * which `canDraw` declines.
     */
    private _drawPatternOutline(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        tileManager: TileManager,
        layer: FillStyleLayer,
        coords: Array<OverscaledTileID>,
        opacity: number,
        isRenderingToTexture: boolean,
    ): void {
        const gl = painter.context.gl;
        const transform = painter.transform;
        const binders = describeBinders(layer.paint as never, PATTERN_SPECS, true)!;
        const isConstantPattern = binders.find((b) => b.name === 'pattern_from')?.kind === 'uniform';
        const isGlobe = Boolean(painter.style.projection?.useSubdivision);
        // Lines ignore `side`; the globe clip happens in the fragment shader.
        const material = this._patternOutlineMaterials.get(binders, isGlobe);
        this._outlineMesh.material = material;

        const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);
        material.depthTest = depthMode.func !== gl.ALWAYS;
        material.depthWrite = Boolean(depthMode.mask);
        material.transparent = true;
        material.blending = CustomBlending;
        material.blendSrc = OneFactor;
        material.blendDst = OneMinusSrcAlphaFactor;
        material.needsUpdate = true;
        // **Only when it compiled as a uniform.** `opacity` is an ordinary paint
        // binder in the pattern shader, so a data-driven one becomes an
        // attribute and `u_opacity` does not exist — writing it then throws, and
        // a throw inside the handover is a dead frame, not a wrong pixel. This
        // path used to refuse such layers outright (`pattern-data-driven-opacity`)
        // for want of this one check.
        if (material.uniforms.u_opacity) material.uniforms.u_opacity.value = opacity;
        // Device pixels: `v_pos` is compared against gl_FragCoord.
        material.uniforms.u_world.value.set(gl.drawingBufferWidth, gl.drawingBufferHeight);

        const crossfade = layer.getCrossfadeParameters();
        const constantPattern = layer.paint.get('fill-pattern').constantOr(null as never);
        const declared = layer.getPaintProperty('fill-pattern') as string | undefined;
        const translate = layer.paint.get('fill-translate');
        const translateAnchor = layer.paint.get('fill-translate-anchor');

        gl.depthRange(depthMode.range[0], depthMode.range[1]);
        try {
            for (const coord of coords) {
                const tile = tileManager.getTile(coord);
                const bucket = tile?.getBucket(layer) as SegmentedBucket | undefined;
                if (!bucket || !tile?.imageAtlasTexture) { this._skip('pattern-outline-no-atlas'); continue; }

                const positions = isConstantPattern
                    ? resolvePatternPositions(
                        tile.imageAtlas?.patternPositions as never, constantPattern as never, declared)
                    : null;
                if (isConstantPattern && !positions) { this._skip('pattern-outline-unresolved-positions'); continue; }

                const buffers = this._buffersFor(bucket, true, gl);
                if (!buffers || buffers.segments.length === 0) { this._skip('pattern-outline-no-buffers'); continue; }

                const paint = this._patternPaintAttributes(bucket, layer.id, crossfade, gl);

                // Only when the pattern is constant. Per feature the same
                // rectangles arrive as attributes, and there is no uniform to
                // write — `material.uniforms.u_pattern_from` does not exist.
                if (positions) setConstantPatternUniforms(material, binders, positions);
                tile.imageAtlasTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
                material.uniforms.u_image.value = this._externalTexture(tile.imageAtlasTexture.texture);

                const uniforms = patternTileUniforms(
                    tile as never,
                    transform.tileZoom,
                    1 / pixelsToTileUnits(tile, 1, transform.tileZoom),
                    crossfade,
                    tile.imageAtlasTexture.size as [number, number],
                );
                material.uniforms.u_texsize.value.fromArray(uniforms.texsize);
                material.uniforms.u_scale.value.fromArray(uniforms.scale);
                material.uniforms.u_fade.value = uniforms.fade;
                material.uniforms.u_pixel_coord_upper.value.fromArray(uniforms.pixelCoordUpper);
                material.uniforms.u_pixel_coord_lower.value.fromArray(uniforms.pixelCoordLower);
                material.uniforms.u_fill_translate.value.fromArray(
                    translatePosition(transform, tile, translate, translateAnchor));

                applyStencilMode(material, painter.stencilModeForClipping(coord), gl);
                const projectionData = transform.getProjectionData(
                    tileProjectionOptions(coord, isRenderingToTexture));
                if (isGlobe) applyGlobeProjectionData(material, projectionData);
                applyProjectionData(this._outlineMesh, projectionData);

                for (let i = 0; i < buffers.segments.length; i++) {
                    buffers.bindSegment(this._outlineGeometry, i);
                    paint.bindSegment(this._outlineGeometry, buffers.segments[i].vertexOffset);
                    renderer.render(this._outlineMesh, camera);
                    this.stats.drawn++;
                }
            }
        } finally {
            gl.depthRange(0, 1);
        }
    }

    /**
     * Paint attributes for a pattern, after telling MapLibre which crossfade
     * side to expose.
     *
     * `updatePaintBuffers(crossfade)` is not optional here, and its absence does
     * not fail loudly. A cross-faded binder holds two zoom-specific buffers and
     * **neither is published** until this runs with a crossfade — `upload()`
     * calls it without one, and that path only publishes binders that have a
     * single `paintVertexBuffer`. So `getPaintVertexBuffers()` comes back empty,
     * the attributes bind to nothing, the shader reads zeros, and the pattern
     * renders as a degenerate rectangle: drawn, counted, and invisible.
     *
     * `PaintAttributesCache` compares the buffer list rather than assuming it,
     * so it picks up the change on the frame the crossfade flips.
     */
    private _patternPaintAttributes(
        bucket: SegmentedBucket,
        layerId: string,
        crossfade: Parameters<ProgramConfiguration['updatePaintBuffers']>[0],
        gl: WebGLRenderingContext,
    ): PaintAttributes {
        const programConfiguration = bucket.programConfigurations.get(layerId);
        programConfiguration.updatePaintBuffers(crossfade);
        return this._paintAttributes.get(bucket, programConfiguration, gl);
    }

    /** One wrapper per `WebGLTexture`; see `_drawPattern`. */
    private _externalTexture(texture: WebGLTexture): ExternalTexture {
        let wrapper = this._externalTextures.get(texture);
        if (!wrapper) {
            wrapper = new ExternalTexture(texture);
            this._externalTextures.set(texture, wrapper);
        }
        return wrapper;
    }

    /** `u_<name>_t` for the composite properties in this configuration. */
    private _setCompositeFactors(
        material: RawShaderMaterial,
        layer: FillStyleLayer,
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

    /**
     * `null` when the bucket has not been uploaded yet.
     *
     * A tile can be visible for a frame before `upload()` runs, and the GL
     * buffers do not exist until it does. Skipping that frame is correct — the
     * tile simply appears one frame later, which is what MapLibre does too.
     */
    private _buffersFor(bucket: SegmentedBucket, isOutline: boolean, gl: WebGLRenderingContext): BucketBuffers | null {
        const indexBuffer = (isOutline ? bucket.indexBuffer2 : bucket.indexBuffer)?.buffer;
        if (!bucket.layoutVertexBuffer?.buffer || !indexBuffer) return null;

        const cache = isOutline ? this._outlineBuffers : this._fillBuffers;
        const indicesPerPrimitive = isOutline ? 2 : 3;
        return cache.get(bucket, () => ({
            // The layout describes itself — `a_pos`, two int16 in tile units.
            layoutBuffers: [bucket.layoutVertexBuffer as never],
            indexBuffer,
            indexType: gl.UNSIGNED_SHORT,
            indexBytes: 2,
            // `length` survives `freeBufferAfterUpload`; the typed views do not.
            indexCount: (isOutline ? bucket.indexArray2 : bucket.indexArray).length * indicesPerPrimitive,
            segments: (isOutline ? bucket.segments2 : bucket.segments).segments,
            indicesPerPrimitive,
            gl,
        }));
    }

    private _paintAttributesFor(bucket: SegmentedBucket, layerId: string, gl: WebGLRenderingContext): PaintAttributes {
        return this._paintAttributes.get(bucket, bucket.programConfigurations.get(layerId), gl);
    }

    destroy(): void {
        // The geometries are deliberately not disposed: their attributes point
        // at MapLibre's GL buffers, and Three's dispose would delete them. See
        // `bucket_geometry.ts`. The materials are Three's own.
        this._fillMaterials.dispose();
        this._outlineMaterials.dispose();
        this._patternMaterials.dispose();
        this._patternOutlineMaterials.dispose();
    }
}

