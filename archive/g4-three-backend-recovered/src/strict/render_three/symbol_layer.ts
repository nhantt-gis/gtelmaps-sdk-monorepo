import {
    BufferGeometry,
    CustomBlending,
    ExternalTexture,
    FrontSide,
    Mesh,
    OneFactor,
    OneMinusSrcAlphaFactor,
} from 'three';

import {DepthMode} from '../../gl/depth_mode';
import {pixelsToTileUnits} from '../../source/pixels_to_tile_units';
import {translatePosition} from '../../util/util';
import {evaluateSizeForZoom} from '../../symbol/symbol_size';
import {getGlCoordMatrix, getPitchedLabelPlaneMatrix, updateLineLabels} from '../../symbol/projection';
import {updateVariableAnchors} from '../../render/draw_symbol';
import {mat4} from 'gl-matrix';
import {applyProjectionData} from './projection_bridge';
import {applyGlobeProjectionData} from './projection_globe';
import {applyTerrainData} from './terrain_bridge';
import {BucketBuffersCache, type BucketBuffers} from './bucket_geometry';
import {
    attributesCoverBinders,
    compositeInterpolationFactor,
    describeBinders,
    PaintAttributesCache,
    type BinderDescription,
    type PaintAttributes,
} from './paint_binders';
import {createSymbolTextAndIconMaterial} from './symbol_text_and_icon_program';
import {invalidateThreeStateCache} from './texture_bridge';
import {
    createSymbolIconMaterial,
    createSymbolSdfMaterial,
    SymbolMaterialCache,
    symbolIconSpecs,
    symbolSdfSpecs,
} from './symbol_program';

import type {Camera, RawShaderMaterial, WebGLRenderer} from 'three';
import type {Color} from '@maplibre/maplibre-gl-style-spec';
import type {OverscaledTileID} from '../../tile/tile_id';
import type {Painter, RenderOptions} from '../../render/painter';
import type {ProgramConfiguration} from '../../data/program_configuration';
import type {ProjectionData} from '../../geo/projection/projection_data';
import type {SymbolBucket} from '../../data/bucket/symbol_bucket';
import type {SymbolStyleLayer} from '../../style/style_layer/symbol_style_layer';
import type {TerrainData} from '../../render/terrain';
import type {TileManager} from '../../tile/tile_manager';

/**
 * Draws `symbol` through Three, for the slice this backend covers.
 *
 * ## Why this is the last step, and the most carefully fenced
 *
 * `symbol` is the only layer where the render tier is not separable from the
 * rest. Placement and collision run on the CPU in `src/symbol/` (spec risk R1),
 * and two of those CPU passes — `updateVariableAnchors` and `updateLineLabels` —
 * **write into the buffers this draw reads**, every frame, from inside
 * `drawSymbols`. Taking the draw without running them renders last frame's
 * placement; porting them would mean porting the collision system, which this
 * step explicitly does not do. So they are neither skipped nor ported: they are
 * called, from {@link SymbolRenderer.prepare}.
 *
 * The first slice drew the fence where neither pass was needed at all:
 * point-placed symbols with fixed anchors. Both passes have since been brought
 * inside, and **neither was ported** — they are called, from a step of their
 * own, {@link SymbolRenderer.prepare}, which runs while MapLibre still owns the
 * context. What this backend owns is the draw; placement stays upstream's,
 * which is what keeps spec risk R1 contained.
 *
 * ## Two passes per layer, and both must be in scope
 *
 * `drawSymbols` draws icons and then text, through the same programs but fed
 * from `icon-*` and `text-*` respectively. Claiming a layer claims both, so
 * `canDraw` has to be satisfied about both — a layer whose text is fine and
 * whose icons are along a line is handed back whole.
 *
 * ## Three layout buffers
 *
 * More than any layer so far: the static quad (`a_pos_offset`, `a_data`,
 * `a_pixeloffset`), the placement output (`a_projected_pos`) and the fade state
 * (`a_fade_opacity`). The last is bound with a **one-byte stride** over a
 * `Uint32` array — MapLibre writes four vertices' opacities in one word and then
 * overrides `itemSize` to 1. That override is read straight off the buffer here,
 * which is the whole reason `attribute_bridge.ts` derives strides from the
 * buffer rather than from a table.
 *
 * ## Declined, with reasons
 *
 * - **Collision-box debug** (`showCollisionBoxes`) — a separate draw with its
 *   own program.
 * - Terrain, globe, render-to-texture, overdraw inspector — as elsewhere.
 */
export type SymbolStats = {
    drawn: number;
    fellBack: Record<string, number>;
    /** Tiles skipped inside a claimed draw. See `FillStats.skipped`. */
    skipped: Record<string, number>;
};

/** The bucket surface this needs, without depending on private fields. */
type DrawableSymbolBucket = SymbolBucket & {
    zoom: number;
    text: SymbolPassBuffers;
    icon: SymbolPassBuffers;
};

type SymbolPassBuffers = {
    layoutVertexBuffer?: {buffer?: WebGLBuffer};
    dynamicLayoutVertexBuffer?: {buffer?: WebGLBuffer};
    opacityVertexBuffer?: {buffer?: WebGLBuffer};
    indexBuffer?: {buffer?: WebGLBuffer};
    indexArray: {length: number};
    segments: {get(): Array<{vertexOffset: number; vertexLength: number; primitiveOffset: number; primitiveLength: number; sortKey?: number}>};
    hasVisibleVertices: boolean;
    programConfigurations: {get(layerId: string): ProgramConfiguration};
};

/** Everything one tile contributes to one pass, resolved before any drawing. */
type SymbolTileState = {
    buffers: BucketBuffers;
    paint: PaintAttributes;
    bucketZoom: number;
    texture: SymbolAtlasTexture;
    textureFilter: number;
    texSize: [number, number];
    size: {uSizeT: number; uSize: number} | null;
    sizeKind: string;
    labelPlaneMatrix: mat4;
    coordMatrix: mat4;
    translation: [number, number];
    projectionData: ProjectionData;
    /** MapLibre's per-tile DEM lookup, or `null` when the map has no terrain. */
    terrainData: TerrainData | null;
    isSDF: boolean;
    shaderVariableAnchor: boolean;
    /**
     * The image atlas and its size, when this bucket has images inline in its
     * text. Present only where the `symbolTextAndIcon` program is selected.
     */
    iconTexture: SymbolAtlasTexture | null;
    iconTextureFilter: number;
    texSizeIcon: [number, number];
};

type SymbolSegmentDraw = {
    state: SymbolTileState;
    segmentIndex: number;
    sortKey: number;
};

type SymbolAtlasTexture = {
    texture: WebGLTexture;
    size: [number, number];
    bind(filter: number, wrap: number): void;
};

const INDICES_PER_TRIANGLE = 3;

/** `identityMat4` from `draw_symbol.ts`: the label plane matrix along a line. */
const IDENTITY_MATRIX = mat4.identity(new Float32Array(16)) as unknown as mat4;

export class SymbolRenderer {
    readonly stats: SymbolStats = {drawn: 0, fellBack: {}, skipped: {}};

    /**
     * Keyed on the pass's `SymbolBuffers`, not on the bucket: a bucket owns two
     * of them, with different contents and different segment lists.
     */
    private readonly _buffers = new BucketBuffersCache();
    private readonly _paintAttributes = new PaintAttributesCache();
    private readonly _iconMaterials = new SymbolMaterialCache(createSymbolIconMaterial);
    private readonly _sdfMaterials = new SymbolMaterialCache(createSymbolSdfMaterial);
    private readonly _textAndIconMaterials = new SymbolMaterialCache(createSymbolTextAndIconMaterial);
    private readonly _externalTextures = new WeakMap<WebGLTexture, ExternalTexture>();

    private readonly _geometry = new BufferGeometry();
    private readonly _mesh = new Mesh(this._geometry);

    private _fallBack(reason: string): false {
        this.stats.fellBack[reason] = (this.stats.fellBack[reason] ?? 0) + 1;
        return false;
    }

    private _skip(reason: string): void {
        this.stats.skipped[reason] = (this.stats.skipped[reason] ?? 0) + 1;
    }

    canDraw(
        painter: Painter,
        tileManager: TileManager,
        layer: SymbolStyleLayer,
        coords: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
    ): boolean {
        if (painter.options.showOverdrawInspector) return this._fallBack('overdraw-inspector');
        if (renderOptions.isRenderingToTexture) return this._fallBack('render-to-texture');
        // A second draw with its own program, appended after both passes.
        // **Declined, with the implementation kept** — the globe variant of all
        // three symbol materials is built and unit-tested, and `canDraw` is the
        // only thing standing in front of it. §24 got 20 globe fixtures down to
        // 13 red and then stopped rather than guessing further.
        //
        // What is measured, so the next attempt does not re-derive it:
        //
        // - `u_pitched_scale` was missing entirely. `symbolUniformValues` fills
        //   it from `transform.getCircleRadiusCorrection()`; writing it turned
        //   **7 of the 20** green.
        // - The remaining 13 fall in three clusters, which is itself a clue that
        //   they are not one bug: `icon-text-translate-{map,viewport}` and their
        //   terrain twins (4, ~0.019), `text-always-overlap-occluded/*`
        //   (3, 0.002–0.041), and `text-variable-anchor/*` plus
        //   `text-pitched-rotated` and `text-point-pole-to-pole` (6, 0.001–0.014).
        // - **The vertex shader body is byte-identical to upstream** apart from
        //   the ported `projectionScaling` block, checked line by line. So the
        //   cause is not in the shader body — it is a uniform value or the CPU
        //   placement passes, which is where symbol's globe support mostly
        //   lives (`src/symbol/projection.ts`).
        // - `drawSymbol` does **not** force a simple projection for any of the
        //   three programs, so the globe prelude is reaching them here as it
        //   does upstream.
        if ((painter.style.projection?.transitionState ?? 0) > 0) return this._fallBack('globe');
        if (tileManager.map?.showCollisionBoxes) return this._fallBack('collision-boxes');

        // **Both** spec sets, for every pass that runs — not just the one the
        // bucket happens to select. `sdfIcons` is a per-bucket fact, so one
        // layer can need the icon program for one tile and the SDF program for
        // another; `_drawPass` therefore builds both binder sets up front and
        // asserts they exist. Checking only the selected one here would make
        // that assertion a lie for the very styles that mix the two.
        for (const pass of passesFor(layer)) {
            for (const specs of [symbolSdfSpecs(pass.isText), symbolIconSpecs(pass.isText)]) {
                if (!describeBinders(layer.paint as never, specs)) {
                    return this._fallBack('unsupported-expression');
                }
            }
        }

        for (const coord of coords) {
            const bucket = tileManager.getTile(coord)?.getBucket(layer) as DrawableSymbolBucket | undefined;
            if (!bucket) continue;
            // Images inline in text, **on a line**, and only that combination.
            // Each half works alone — `formatted-images-*` and every
            // `symbol-placement: line` fixture pass — but together two fixtures
            // come out subtly displaced (diffs 0.02 and 0.06), and a small
            // displacement is precisely the failure this project does not ship
            // on a guess. Named and refused until it is understood.
            if (bucket.iconsInText && isAlongLine(layer, true)) {
                return this._fallBack('icons-in-text-along-line');
            }

            for (const pass of passesFor(layer)) {
                const buffers = pass.isText ? bucket.text : bucket.icon;
                // Guarded on the **GL buffer**, not on the object. A pass with
                // nothing in it never uploads at all — `SymbolBuffers.upload`
                // returns early when its arrays are empty, before it reaches
                // `programConfigurations.upload` — so asking that configuration
                // for its paint buffers throws. Every icon-only or text-only
                // layer hits this on every tile, which is why it took the probe
                // exactly one run to find.
                if (!buffers?.layoutVertexBuffer?.buffer) continue;
                const binders = describeBinders(layer.paint as never, specsFor(pass.isText, bucket))!;
                const paint = this._paintAttributesFor(buffers, layer.id, painter.context.gl);
                if (!attributesCoverBinders(binders, paint.names)) return this._fallBack('binder-mismatch');
            }
        }

        return true;
    }

    /**
     * Whether {@link prepare} would do GL work for this layer.
     *
     * Asked by the backend so a batched handover is only broken when it has to
     * be. `prepare` is MapLibre's code touching MapLibre's buffers, so it cannot
     * run while Three owns the context — but most symbol layers are point-placed
     * with fixed anchors and need nothing, and breaking the batch for them would
     * pay the handover cost for no reason.
     */
    needsPrepare(painter: Painter, layer: SymbolStyleLayer): boolean {
        if (painter.renderPass !== 'translucent') return false;
        if (hasVariablePlacement(layer)) return true;
        return passesFor(layer).some((pass) => isAlongLine(layer, pass.isText));
    }

    /**
     * Runs MapLibre's own CPU placement pass for along-line labels.
     *
     * ## Why this is a separate method, called outside the Three handover
     *
     * `updateLineLabels` re-projects every glyph of every line label onto the
     * label plane for *this* frame's camera, and finishes with
     * `dynamicLayoutVertexBuffer.updateData(...)` — a real `bufferSubData`. It
     * is MapLibre's code writing MapLibre's buffer with MapLibre's GL state, and
     * it is the reason along-line placement was refused outright in the first
     * slice: the draw reads the buffer this writes, in the same frame.
     *
     * Calling it from inside `_drawWithThree` would put a MapLibre GL call in
     * the middle of Three's ownership of the context — the shape of the G4-2
     * failure. Calling it from `canDraw` would give a query a side effect, which
     * is the mistake `raster` names about `getStencilConfigForOverlapAndUpdateStencilID`.
     * So it gets its own step, between the two, where MapLibre still owns the
     * context. That ordering is the whole design: {@link ThreeBackend} calls
     * `canDraw`, then `prepare`, then hands over.
     *
     * A no-op for point-placed layers, which is most of them.
     */
    prepare(
        painter: Painter,
        tileManager: TileManager,
        layer: SymbolStyleLayer,
        coords: Array<OverscaledTileID>,
    ): void {
        if (painter.renderPass !== 'translucent') return;

        // **First, and for the whole layer**, exactly as `drawSymbols` orders
        // it: icon and text placement depend on each other under
        // `icon-text-fit`, so this cannot be folded into the per-pass loop
        // below. It also reads the *text* alignment and translate in both
        // cases, because a variable anchor belongs to the label.
        if (hasVariablePlacement(layer)) {
            updateVariableAnchors(
                coords, painter, layer, tileManager,
                layer.layout.get('text-rotation-alignment'),
                layer.layout.get('text-pitch-alignment'),
                layer.paint.get('text-translate'),
                layer.paint.get('text-translate-anchor'),
                painter.style.placement.variableOffsets,
            );
        }

        for (const pass of passesFor(layer)) {
            if (!isAlongLine(layer, pass.isText)) continue;

            const transform = painter.transform;
            const rotateWithMap = layer.layout.get(
                pass.isText ? 'text-rotation-alignment' : 'icon-rotation-alignment') === 'map';
            const pitchWithMap = layer.layout.get(
                pass.isText ? 'text-pitch-alignment' : 'icon-pitch-alignment') === 'map';
            const keepUpright = layer.layout.get(pass.isText ? 'text-keep-upright' : 'icon-keep-upright');
            // The **text** property in both passes, which looks like a typo
            // upstream and is not: an icon on a line is oriented by the label it
            // belongs to. Copied rather than corrected.
            const rotateToLine = layer.layout.get('text-rotation-alignment') === 'map';
            const translate = layer.paint.get(pass.isText ? 'text-translate' : 'icon-translate');
            const translateAnchor = layer.paint.get(
                pass.isText ? 'text-translate-anchor' : 'icon-translate-anchor');

            for (const coord of coords) {
                const tile = tileManager.getTile(coord);
                const bucket = tile?.getBucket(layer) as DrawableSymbolBucket | undefined;
                if (!bucket) continue;
                const passBuffers = pass.isText ? bucket.text : bucket.icon;
                // The same three-part skip the draw loop applies, and it has to
                // be the same: preparing a pass the draw will skip writes a
                // buffer nothing reads, and skipping one the draw will use
                // leaves last frame's placement on screen.
                if (!passBuffers?.layoutVertexBuffer?.buffer) continue;
                if (!passBuffers.segments.get().length || !passBuffers.hasVisibleVertices) continue;

                const s = pixelsToTileUnits(tile, 1, transform.zoom);
                const pitchedLabelPlaneMatrix = getPitchedLabelPlaneMatrix(rotateWithMap, transform, s);
                const inverse = mat4.create();
                mat4.invert(inverse, pitchedLabelPlaneMatrix);

                updateLineLabels(
                    bucket as never, painter, pass.isText,
                    pitchedLabelPlaneMatrix, inverse, pitchWithMap, keepUpright, rotateToLine,
                    coord.toUnwrapped(), transform.width, transform.height,
                    translatePosition(transform, tile, translate, translateAnchor),
                    // The CPU half of terrain: every glyph of a line label is
                    // re-projected on the CPU, and under terrain each has to be
                    // lifted to the ground beneath it. `updateVariableAnchors`
                    // derives the same callback itself from the painter; this
                    // one has to be handed in.
                    (painter.style.map.terrain ?
                        (x: number, y: number) => painter.style.map.terrain.getElevation(coord, x, y) :
                        null) as never,
                );
            }
        }
    }

    /**
     * Draws the layer. Only valid after {@link canDraw} has returned `true`,
     * and after {@link prepare} has run for the same frame.
     *
     * Always returns `true`: once claimed, the layer is owned in every pass.
     */
    draw(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        tileManager: TileManager,
        layer: SymbolStyleLayer,
        coords: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
    ): boolean {
        // `drawSymbols` leaves immediately outside the translucent pass.
        if (painter.renderPass !== 'translucent') return true;

        for (const pass of passesFor(layer)) {
            this._drawPass(renderer, camera, painter, tileManager, layer, coords, renderOptions, pass.isText);
        }
        return true;
    }

    /** One of the two `drawLayerSymbols` calls: icons, then text. */
    private _drawPass(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        tileManager: TileManager,
        layer: SymbolStyleLayer,
        coords: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
        isText: boolean,
    ): void {
        const gl = painter.context.gl;
        const context = painter.context;
        const transform = painter.transform;

        const rotationAlignment = layer.layout.get(isText ? 'text-rotation-alignment' : 'icon-rotation-alignment');
        const pitchAlignment = layer.layout.get(isText ? 'text-pitch-alignment' : 'icon-pitch-alignment');
        const rotateWithMap = rotationAlignment === 'map';
        const pitchWithMap = pitchAlignment === 'map';
        const alongLine = isAlongLine(layer, isText);
        // Labels along a line are already rotated by `updateLineLabels`, on the
        // CPU, so the shader must not rotate them a second time.
        const rotateInShader = rotateWithMap && !pitchWithMap && !alongLine;

        const translate = layer.paint.get(isText ? 'text-translate' : 'icon-translate');
        const translateAnchor = layer.paint.get(isText ? 'text-translate-anchor' : 'icon-translate-anchor');
        const hasSortKey = !layer.layout.get('symbol-sort-key').isConstant();
        const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);

        const terrain = painter.style.map.terrain;
        const hasTerrain = Boolean(terrain);
        const isGlobe = Boolean(painter.style.projection?.useSubdivision);
        const pitchedTextRescaling = transform.getCircleRadiusCorrection();
        const draws: Array<SymbolSegmentDraw> = [];
        let sortFeaturesByKey = false;

        for (const coord of coords) {
            const tile = tileManager.getTile(coord);
            const bucket = tile?.getBucket(layer) as DrawableSymbolBucket | undefined;
            if (!bucket) { this._skip(`${isText ? 'text' : 'icon'}-no-bucket`); continue; }

            const passBuffers = isText ? bucket.text : bucket.icon;
            // MapLibre's own three-part test: a pass with no segments or no
            // placed symbols contributes nothing, and `hasVisibleVertices` is the
            // one the placement system updates.
            if (!passBuffers || !passBuffers.segments.get().length || !passBuffers.hasVisibleVertices) {
                this._skip(`${isText ? 'text' : 'icon'}-nothing-visible`);
                continue;
            }

            const buffers = this._buffersFor(passBuffers, gl);
            if (!buffers || buffers.segments.length === 0) { this._skip('no-buffers'); continue; }

            const isSDF = isText || Boolean(bucket.sdfIcons);
            const sizeData = isText ? bucket.textSizeData : bucket.iconSizeData;
            const transformed = pitchWithMap || transform.pitch !== 0;

            let texture: SymbolAtlasTexture;
            let textureFilter: number;
            let iconTexture: SymbolAtlasTexture | null = null;
            let iconTextureFilter: number = gl.LINEAR;
            let texSizeIcon: [number, number] = [0, 0];
            if (isText) {
                texture = tile.glyphAtlasTexture as unknown as SymbolAtlasTexture;
                textureFilter = gl.LINEAR;
                if (bucket.iconsInText) {
                    iconTexture = (tile.imageAtlasTexture as unknown as SymbolAtlasTexture) ?? null;
                    // NEAREST only on a still map at a size the atlas was built
                    // for; anything moving or zoom-dependent needs LINEAR.
                    const zoomDependentSize = sizeData.kind === 'composite' || sizeData.kind === 'camera';
                    iconTextureFilter = transformed || painter.options.rotating ||
                        painter.options.zooming || zoomDependentSize ? gl.LINEAR : gl.NEAREST;
                    texSizeIcon = iconTexture?.size ?? [0, 0];
                }
            } else {
                const iconScaled = layer.layout.get('icon-size').constantOr(0) !== 1 || bucket.iconsNeedLinear;
                texture = tile.imageAtlasTexture as unknown as SymbolAtlasTexture;
                textureFilter = isSDF || painter.options.rotating || painter.options.zooming || iconScaled || transformed ?
                    gl.LINEAR :
                    gl.NEAREST;
            }
            if (!texture) { this._skip(`${isText ? 'text' : 'icon'}-no-atlas`); continue; }
            if (isText && bucket.iconsInText && !iconTexture) { this._skip('text-no-icon-atlas'); continue; }

            // See the comment at the top of src/symbol/projection.ts for an
            // overview of the symbol projection process.
            const s = pixelsToTileUnits(tile, 1, transform.zoom);
            const pitchedLabelPlaneMatrix = getPitchedLabelPlaneMatrix(rotateWithMap, transform, s);
            // **Per tile, not per layer.** For the text pass this follows the
            // layer, but for icons it depends on whether *this bucket* has text
            // to fit them to — so two tiles of one layer can disagree, and the
            // uniform has to move with them.
            const variableAnchors = hasVariablePlacement(layer) && bucket.hasTextData();
            const fitsIconToText = layer.layout.get('icon-text-fit') !== 'none' &&
                variableAnchors && bucket.hasIconData();
            const shaderVariableAnchor = (isText && hasVariablePlacement(layer)) || fitsIconToText;
            // In both of these cases `a_projected_pos` already holds label-plane
            // coordinates — `updateLineLabels` or `updateVariableAnchors` put
            // them there — so the shader takes an early branch and the matrix is
            // unused. Upstream passes an identity rather than leaving it stale.
            const labelPlaneMatrix = alongLine || shaderVariableAnchor ?
                IDENTITY_MATRIX :
                (pitchWithMap ? pitchedLabelPlaneMatrix : transform.clipSpaceToPixelsMatrix);

            draws.push(...this._segmentDraws({
                buffers,
                paint: this._paintAttributesFor(passBuffers, layer.id, gl),
                bucketZoom: bucket.zoom,
                texture,
                textureFilter,
                texSize: texture.size,
                size: evaluateSizeForZoom(sizeData, transform.zoom),
                sizeKind: sizeData.kind,
                labelPlaneMatrix,
                coordMatrix: getGlCoordMatrix(pitchWithMap, rotateWithMap, transform, s),
                translation: translatePosition(transform, tile, translate, translateAnchor),
                shaderVariableAnchor,
                projectionData: transform.getProjectionData({
                    overscaledTileID: coord,
                    applyGlobeMatrix: !renderOptions.isRenderingToTexture,
                    applyTerrainMatrix: true,
                }),
                terrainData: terrain?.getTerrainData(coord) ?? null,
                isSDF,
                iconTexture,
                iconTextureFilter,
                texSizeIcon,
            }, hasSortKey && bucket.canOverlap));

            if (hasSortKey && bucket.canOverlap) sortFeaturesByKey = true;
        }

        if (sortFeaturesByKey) draws.sort((a, b) => a.sortKey - b.sortKey);
        if (draws.length === 0) return;

        // Two buckets of the same layer can disagree about `sdfIcons` — it is a
        // property of the images each tile actually used — so the program is
        // chosen **per draw**, exactly as `drawLayerSymbols` chooses it per tile.
        // Picking one material from the first tile would render the others with
        // the wrong shader, and with a sort key the two can interleave.
        const sdfBinders = describeBinders(layer.paint as never, symbolSdfSpecs(isText))!;
        const iconBinders = describeBinders(layer.paint as never, symbolIconSpecs(isText))!;
        const haloWidth = layer.paint.get(isText ? 'text-halo-width' : 'icon-halo-width');
        const haloIsDrawn = haloWidth.constantOr(1) !== 0;

        gl.depthRange(depthMode.range[0], depthMode.range[1]);
        try {
            for (const draw of draws) {
                const {state} = draw;
                // Three programs now, chosen exactly as `getSymbolProgramName`
                // chooses them: images inline in text win over plain SDF, and
                // only for the text pass — which is where `iconTexture` is set.
                const binders = state.isSDF ? sdfBinders : iconBinders;
                const material = state.iconTexture ?
                    this._textAndIconMaterials.get(sdfBinders, hasTerrain, isGlobe) :
                    (state.isSDF ?
                        this._sdfMaterials.get(sdfBinders, hasTerrain, isGlobe) :
                        this._iconMaterials.get(iconBinders, hasTerrain, isGlobe));
                this._mesh.material = material;
                this._setConstantUniforms(material, layer, binders);

                material.depthTest = depthMode.func !== gl.ALWAYS;
                material.depthWrite = Boolean(depthMode.mask);
                material.transparent = true;
                // ColorMode.alphaBlended, against premultiplied colours.
                material.blending = CustomBlending;
                material.blendSrc = OneFactor;
                material.blendDst = OneMinusSrcAlphaFactor;
                // MapLibre's CullFaceMode.backCCW.
                material.side = FrontSide;
                // `drawSymbols` disables the stencil test outright, so labels
                // are not clipped at tile boundaries.
                material.stencilWrite = false;
                material.needsUpdate = true;

                material.uniforms.u_camera_to_center_distance.value = transform.cameraToCenterDistance;
                material.uniforms.u_aspect_ratio.value = transform.width / transform.height;
                material.uniforms.u_fade_change.value = painter.options.fadeDuration ? painter.symbolFadeChange : 1;
                material.uniforms.u_is_text.value = +isText;
                material.uniforms.u_pitch_with_map.value = +pitchWithMap;
                material.uniforms.u_rotate_symbol.value = +rotateInShader;
                material.uniforms.u_is_along_line.value = +alongLine;
                material.uniforms.u_is_variable_anchor.value = +state.shaderVariableAnchor;

                material.uniforms.u_is_size_zoom_constant.value =
                    +(state.sizeKind === 'constant' || state.sizeKind === 'source');
                material.uniforms.u_is_size_feature_constant.value =
                    +(state.sizeKind === 'constant' || state.sizeKind === 'camera');
                material.uniforms.u_size_t.value = state.size ? state.size.uSizeT : 0;
                material.uniforms.u_size.value = state.size ? state.size.uSize : 0;
                material.uniforms.u_label_plane_matrix.value.fromArray(state.labelPlaneMatrix);
                material.uniforms.u_coord_matrix.value.fromArray(state.coordMatrix);
                material.uniforms.u_translation.value.fromArray(state.translation);
                material.uniforms.u_texsize.value.fromArray(state.texSize);
                // Globe only. `transform.getCircleRadiusCorrection()` — the same
                // value `circle` passes as `radiusCorrectionFactor`, under a
                // different name because here it rescales a *pitched label*
                // rather than a circle's radius.
                if (material.uniforms.u_pitched_scale) {
                    material.uniforms.u_pitched_scale.value = pitchedTextRescaling;
                }

                // Three skips `setTextureParameters` for an external texture, so
                // this `bind` is what sets the filter and wrap. One texture per
                // material means the cache divergence argued in `texture_bridge`
                // is unreachable here — see §6.11.
                context.activeTexture.set(gl.TEXTURE0);
                state.texture.bind(state.textureFilter, gl.CLAMP_TO_EDGE);
                material.uniforms.u_texture.value = this._externalTexture(state.texture.texture);

                if (state.iconTexture) {
                    material.uniforms.u_texsize_icon.value.fromArray(state.texSizeIcon);
                    context.activeTexture.set(gl.TEXTURE1);
                    state.iconTexture.bind(state.iconTextureFilter, gl.CLAMP_TO_EDGE);
                    material.uniforms.u_texture_icon.value = this._externalTexture(state.iconTexture.texture);
                    // Two textures, so the divergence argued in `texture_bridge`
                    // is reachable here — and only here among the symbol programs.
                    invalidateThreeStateCache(renderer, gl);
                }

                this._setCompositeFactors(material, layer, binders, state.bucketZoom, transform.zoom);
                // Per tile — see `terrain_bridge.ts`.
                if (state.terrainData) applyTerrainData(material, state.terrainData);
                if (isGlobe) applyGlobeProjectionData(material, state.projectionData);
                applyProjectionData(this._mesh, state.projectionData);

                state.buffers.bindSegment(this._geometry, draw.segmentIndex);
                state.paint.bindSegment(this._geometry, state.buffers.segments[draw.segmentIndex].vertexOffset);

                if (state.isSDF || state.iconTexture) {
                    material.uniforms.u_gamma_scale.value = pitchWithMap ?
                        Math.cos(transform.pitch * Math.PI / 180.0) * transform.cameraToCenterDistance :
                        1;
                    material.uniforms.u_device_pixel_ratio.value = painter.pixelRatio;

                    // The halo is a **separate draw of the same geometry**,
                    // underneath, not a wider outline in one pass. Upstream
                    // draws it first so the fill covers its inner edge.
                    if (haloIsDrawn) {
                        material.uniforms.u_is_halo.value = 1;
                        renderer.render(this._mesh, camera);
                        this.stats.drawn++;
                        material.uniforms.u_is_halo.value = 0;
                    }
                }

                renderer.render(this._mesh, camera);
                this.stats.drawn++;
            }
        } finally {
            gl.depthRange(0, 1);
        }
    }

    /** One entry per segment, carrying the sort key when the layer has one. */
    private _segmentDraws(state: SymbolTileState, sorted: boolean): Array<SymbolSegmentDraw> {
        const draws: Array<SymbolSegmentDraw> = [];
        for (let i = 0; i < state.buffers.segments.length; i++) {
            draws.push({
                state,
                segmentIndex: i,
                sortKey: sorted ? state.buffers.segments[i].sortKey ?? 0 : 0,
            });
        }
        return draws;
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
        layer: SymbolStyleLayer,
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
        layer: SymbolStyleLayer,
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

    /** `null` when the pass's buffers have not been uploaded yet. */
    private _buffersFor(passBuffers: SymbolPassBuffers, gl: WebGLRenderingContext): BucketBuffers | null {
        if (!passBuffers.layoutVertexBuffer?.buffer ||
            !passBuffers.dynamicLayoutVertexBuffer?.buffer ||
            !passBuffers.opacityVertexBuffer?.buffer ||
            !passBuffers.indexBuffer?.buffer) {
            return null;
        }

        return this._buffers.get(passBuffers, () => ({
            layoutBuffers: [
                passBuffers.layoutVertexBuffer as never,
                passBuffers.dynamicLayoutVertexBuffer as never,
                passBuffers.opacityVertexBuffer as never,
            ],
            indexBuffer: passBuffers.indexBuffer!.buffer!,
            indexType: gl.UNSIGNED_SHORT,
            indexBytes: 2,
            indexCount: passBuffers.indexArray.length * INDICES_PER_TRIANGLE,
            segments: passBuffers.segments.get() as never,
            indicesPerPrimitive: INDICES_PER_TRIANGLE,
            gl,
        }));
    }

    private _paintAttributesFor(
        passBuffers: SymbolPassBuffers,
        layerId: string,
        gl: WebGLRenderingContext,
    ): PaintAttributes {
        return this._paintAttributes.get(passBuffers, passBuffers.programConfigurations.get(layerId), gl);
    }

    destroy(): void {
        // The geometry is deliberately not disposed: its attributes point at
        // MapLibre's GL buffers. See `bucket_geometry.ts`.
        this._iconMaterials.dispose();
        this._sdfMaterials.dispose();
        this._textAndIconMaterials.dispose();
    }
}

/**
 * Which of the two passes actually run, by MapLibre's own test.
 *
 * A constant zero opacity skips the pass entirely upstream; a data-driven zero
 * does not, because it is still zero only for some features.
 */
function passesFor(layer: SymbolStyleLayer): Array<{isText: boolean}> {
    const passes: Array<{isText: boolean}> = [];
    if (layer.paint.get('icon-opacity').constantOr(1) !== 0) passes.push({isText: false});
    if (layer.paint.get('text-opacity').constantOr(1) !== 0) passes.push({isText: true});
    return passes;
}

/** `drawSymbols`' own test, which reads the *unevaluated* layout. */
function hasVariablePlacement(layer: SymbolStyleLayer): boolean {
    return layer._unevaluatedLayout.hasValue('text-variable-anchor') ||
        layer._unevaluatedLayout.hasValue('text-variable-anchor-offset');
}

/** `drawLayerSymbols`' own definition, asked per pass. */
function isAlongLine(layer: SymbolStyleLayer, isText: boolean): boolean {
    const rotationAlignment = layer.layout.get(isText ? 'text-rotation-alignment' : 'icon-rotation-alignment');
    return rotationAlignment !== 'viewport' && layer.layout.get('symbol-placement') !== 'point';
}

/** Which program a pass selects, which for icons depends on the bucket. */
function specsFor(isText: boolean, bucket: {sdfIcons?: boolean}) {
    return isText || bucket.sdfIcons ? symbolSdfSpecs(isText) : symbolIconSpecs(isText);
}
