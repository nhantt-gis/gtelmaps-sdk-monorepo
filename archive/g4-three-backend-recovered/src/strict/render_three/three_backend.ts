import {PerspectiveCamera, Scene, WebGLRenderer} from 'three';

import {coveringTiles} from '../../geo/projection/covering_tiles';
import {isBackgroundStyleLayer} from '../../style/style_layer/background_style_layer';
import {isFillStyleLayer} from '../../style/style_layer/fill_style_layer';
import {isFillExtrusionStyleLayer} from '../../style/style_layer/fill_extrusion_style_layer';
import {isBuildingGlassStyleLayer} from '../../style/style_layer/building_glass_style_layer';
import {isLineStyleLayer} from '../../style/style_layer/line_style_layer';
import {isCircleStyleLayer} from '../../style/style_layer/circle_style_layer';
import {isHeatmapStyleLayer} from '../../style/style_layer/heatmap_style_layer';
import {isSymbolStyleLayer} from '../../style/style_layer/symbol_style_layer';
import {isRasterStyleLayer} from '../../style/style_layer/raster_style_layer';
import {isHillshadeStyleLayer} from '../../style/style_layer/hillshade_style_layer';
import {isColorReliefStyleLayer} from '../../style/style_layer/color_relief_style_layer';
import {Painter} from '../../render/painter';

import {BackgroundRenderer, type BackgroundStats} from './background_layer';
import {FillRenderer, type FillStats} from './fill_layer';
import {FillExtrusionRenderer, type FillExtrusionStats} from './fill_extrusion_layer';
import {BuildingGlassRenderer, type BuildingGlassStats} from './building_glass_layer';
import {LineRenderer, type LineStats} from './line_layer';
import {CircleRenderer, type CircleStats} from './circle_layer';
import {HeatmapRenderer, type HeatmapStats} from './heatmap_layer';
import {SymbolRenderer, type SymbolStats} from './symbol_layer';
import {SkyRenderer, type SkyStats} from './sky_layer';
import {RasterRenderer, type RasterStats} from './raster_layer';
import {HillshadeRenderer, type HillshadeStats} from './hillshade_layer';
import {ColorReliefRenderer, type ColorReliefStats} from './color_relief_layer';
import {useMapLibreProjection} from './projection_bridge';
import {resetThreeState} from './three_state';

import type {mat4} from 'gl-matrix';
import type {IReadonlyTransform} from '../../geo/transform_interface';
import type {Context} from '../../gl/context';
import type {OverscaledTileID} from '../../tile/tile_id';
import type {RenderBackend, RenderBackendOptions} from '../../render/render_backend';
import type {RenderOptions} from '../../render/painter';
import type {Style} from '../../style/style';
import type {StyleLayer} from '../../style/style_layer';
import type {TileManager} from '../../tile/tile_manager';
import type {Terrain} from '../../render/terrain';
import type {Texture, TextureImage} from '../../render/texture';

/**
 * A `RenderBackend` that owns a Three.js renderer on the map's own GL context.
 *
 * ## What this does at G4-1, and what it deliberately does not
 *
 * It draws **nothing of its own**. Every member delegates to an inner `Painter`,
 * so the map looks byte-identical to the stock backend. The only thing it adds
 * is a real `THREE.WebGLRenderer` bound to the same `WebGLRenderingContext`, and
 * one empty Three pass per frame.
 *
 * That sounds like a no-op worth skipping. It is the opposite: it is the whole
 * question of G4 asked in the cheapest possible form. Two renderers on one
 * context each cache GL state independently, and each is entitled to assume its
 * cache is true. If merely *constructing* a Three renderer and letting it touch
 * the context each frame corrupts MapLibre's output, the layer-at-a-time
 * migration in `docs/specs/2026-08-10-g4-plan.md` is not viable and the whole
 * plan needs rethinking. Better to learn that from an empty scene than from
 * halfway through porting `fill`.
 *
 * The empty Three pass is therefore not ceremony — it is the measurement. A
 * version of this class that constructed the renderer and never used it would
 * pass the render suite while proving nothing.
 *
 * ## The two-way state reset
 *
 * Each side has to be told the other has been here:
 *
 * - **Three ← MapLibre.** `resetState()` before Three touches the context.
 *   Three's `WebGLState` caches nearly everything; MapLibre has just spent a
 *   frame changing it underneath.
 * - **MapLibre ← Three.** `context.setDirty()` after. MapLibre's `Value`
 *   wrappers cache the same way.
 *
 * `ui/map.ts#_render` already opens every frame with `setDirty()` +
 * `setBaseState()` — it has to, because a custom layer may have run. So the
 * second half of the recovery is, strictly speaking, already there. It is done
 * here anyway: whoever disturbs the state owns putting it back, and this seam
 * should not be silently load-bearing on a line in another file.
 *
 * ## The canvas trap
 *
 * `renderer.setSize()` is never called, and must not be. It writes
 * `canvas.width/height`, and the canvas belongs to MapLibre — `Painter.resize`
 * is the only thing allowed to size it. Three is told about size changes through
 * `setViewport` alone, which touches only Three's own state.
 *
 * ## Where this lives
 *
 * `src/strict/` — new code, checked under `tsconfig.strict.json`. It imports
 * from the ported tier (`Painter`, `Context`, …) and that direction is fine:
 * `tsconfig.strict.json` references the legacy project, so those files are
 * checked under their own looser rules. The rule that matters is the other
 * direction — nothing in the port may import `src/strict/` — which is why this
 * backend is installed at runtime through `setRenderBackendFactory` rather than
 * being reached for by name from inside `src/render/`.
 */
export class ThreeBackend implements RenderBackend {
    private readonly _painter: Painter;
    private readonly _renderer: WebGLRenderer;

    /**
     * Empty for now. G4-2 onward puts migrated layers in here.
     */
    private readonly _scene: Scene;

    /**
     * Contributes nothing to the transform — `useMapLibreProjection` pins it to
     * identity and every mesh carries its own matrix. See `projection_bridge`.
     */
    private readonly _camera: PerspectiveCamera;

    private readonly _background: BackgroundRenderer;
    private readonly _fill: FillRenderer;
    private readonly _fillExtrusion: FillExtrusionRenderer;
    private readonly _buildingGlass: BuildingGlassRenderer;
    private readonly _line: LineRenderer;
    private readonly _circle: CircleRenderer;
    private readonly _heatmap: HeatmapRenderer;
    private readonly _symbol: SymbolRenderer;
    private readonly _sky: SkyRenderer;
    private readonly _raster: RasterRenderer;
    private readonly _hillshade: HillshadeRenderer;
    private readonly _colorRelief: ColorReliefRenderer;

    constructor(gl: WebGL2RenderingContext | WebGLRenderingContext, transform: IReadonlyTransform) {
        this._painter = new Painter(gl as WebGL2RenderingContext, transform);

        this._renderer = new ThreeBackend._RendererCtor({
            canvas: gl.canvas as HTMLCanvasElement,
            context: gl,
        });

        // MapLibre owns the colour, depth and stencil buffers. Three must never
        // clear any of them: it composites onto a frame MapLibre has already
        // drawn.
        this._renderer.autoClear = false;
        this._renderer.autoClearColor = false;
        this._renderer.autoClearDepth = false;
        this._renderer.autoClearStencil = false;

        this._scene = new Scene();
        this._camera = new PerspectiveCamera();
        useMapLibreProjection(this._camera);

        this._background = new BackgroundRenderer();
        this._fill = new FillRenderer();
        this._fillExtrusion = new FillExtrusionRenderer();
        this._buildingGlass = new BuildingGlassRenderer();
        this._line = new LineRenderer();
        this._circle = new CircleRenderer();
        this._heatmap = new HeatmapRenderer();
        this._symbol = new SymbolRenderer();
        this._sky = new SkyRenderer();
        this._raster = new RasterRenderer();
        this._hillshade = new HillshadeRenderer();
        this._colorRelief = new ColorReliefRenderer();
        this._painter.migratedLayerDraw = (tileManager, layer, coords, renderOptions) =>
            this._drawMigratedLayer(tileManager, layer, coords, renderOptions);
        // The painter tells this backend when it is about to draw something of
        // its own between layers — see `Painter.migratedFlush`.
        this._painter.migratedFlush = () => this._closeThree();
        this._painter.migratedSkyDraw = (sky) => {
            if (!this._sky.canDraw(this._painter)) return false;
            return this._drawWithThree(() => this._sky.draw(this._renderer, this._camera, this._painter, sky));
        };

        // Constructing the renderer already touched the context.
        this._painter.context.setDirty();
    }

    /**
     * Dispatches one layer to whichever migrated renderer owns its type.
     *
     * Every branch has the same shape and it is the shape that matters:
     * `canDraw` is asked **outside** `_drawWithThree`, never inside it. The
     * handover is not side-effect free — it calls `resetState()` and
     * `setBaseState()`, and the latter rebinds the framebuffer — so performing
     * it around a layer that is then handed back corrupts MapLibre's own
     * rendering of that layer. That cost 52 terrain fixtures in G4-2.
     */
    private _drawMigratedLayer(
        tileManager: TileManager,
        layer: StyleLayer,
        coords: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
    ): boolean {
        if (isBackgroundStyleLayer(layer)) {
            return this._claim(
                () => this._background.canDraw(this._painter, layer, renderOptions.isRenderingToTexture),
                () => this._background.draw(
                    this._renderer,
                    this._camera,
                    this._painter,
                    layer,
                    coords,
                    coveringTiles(this._painter.transform, {
                        tileSize: this._painter.transform.tileSize,
                        terrain: this._painter.style.map.terrain,
                    }),
                    renderOptions.isRenderingToTexture,
                ));
        }

        if (isFillStyleLayer(layer)) {
            return this._claim(
                () => this._fill.canDraw(this._painter, tileManager, layer, coords, renderOptions),
                () => this._fill.draw(
                    this._renderer,
                    this._camera,
                    this._painter,
                    tileManager,
                    layer,
                    coords,
                    renderOptions,
                ));
        }

        if (isFillExtrusionStyleLayer(layer)) {
            return this._claim(
                () => this._fillExtrusion.canDraw(this._painter, tileManager, layer, coords, renderOptions),
                () => this._fillExtrusion.draw(
                    this._renderer,
                    this._camera,
                    this._painter,
                    tileManager,
                    layer,
                    coords,
                    renderOptions,
                ));
        }

        if (isBuildingGlassStyleLayer(layer)) {
            return this._claim(
                () => this._buildingGlass.canDraw(this._painter, tileManager, layer, coords, renderOptions),
                () => this._buildingGlass.draw(
                    this._renderer,
                    this._camera,
                    this._painter,
                    tileManager,
                    layer,
                    coords,
                    renderOptions,
                ));
        }

        if (isLineStyleLayer(layer)) {
            return this._claim(
                () => this._line.canDraw(this._painter, tileManager, layer, coords, renderOptions),
                () => this._line.draw(
                    this._renderer,
                    this._camera,
                    this._painter,
                    tileManager,
                    layer,
                    coords,
                    renderOptions,
                ));
        }

        if (isCircleStyleLayer(layer)) {
            return this._claim(
                () => this._circle.canDraw(this._painter, tileManager, layer, coords, renderOptions),
                () => this._circle.draw(
                    this._renderer,
                    this._camera,
                    this._painter,
                    tileManager,
                    layer,
                    coords,
                    renderOptions,
                ));
        }

        if (isSymbolStyleLayer(layer)) {
            if (!this._symbol.canDraw(this._painter, tileManager, layer, coords, renderOptions)) {
                this._closeThree();
                return false;
            }
            // **Outside** the handover, and that is the point. This runs
            // MapLibre's own along-line placement, which ends in a
            // `bufferSubData` on MapLibre's buffer — a MapLibre GL call, which
            // belongs in MapLibre's ownership of the context. See
            // `SymbolRenderer.prepare`. Asked first so a point-placed layer,
            // which needs nothing, does not break a batched run for free.
            if (this._symbol.needsPrepare(this._painter, layer)) {
                this._closeThree();
                this._symbol.prepare(this._painter, tileManager, layer, coords);
            }
            this._openThree();
            return this._symbol.draw(
                this._renderer,
                this._camera,
                this._painter,
                tileManager,
                layer,
                coords,
                renderOptions,
            );
        }

        if (isHeatmapStyleLayer(layer)) {
            return this._claim(
                () => this._heatmap.canDraw(this._painter, tileManager, layer, coords, renderOptions),
                () => this._heatmap.draw(
                    this._renderer,
                    this._camera,
                    this._painter,
                    tileManager,
                    layer,
                    coords,
                    renderOptions,
                ));
        }

        if (isRasterStyleLayer(layer)) {
            return this._claim(
                () => this._raster.canDraw(this._painter, tileManager, layer, coords, renderOptions),
                () => this._raster.draw(
                    this._renderer,
                    this._camera,
                    this._painter,
                    tileManager,
                    layer,
                    coords,
                    renderOptions,
                ));
        }

        if (isHillshadeStyleLayer(layer)) {
            return this._claim(
                () => this._hillshade.canDraw(this._painter, tileManager, layer, coords, renderOptions),
                () => this._hillshade.draw(
                    this._renderer,
                    this._camera,
                    this._painter,
                    tileManager,
                    layer,
                    coords,
                    renderOptions,
                ));
        }

        if (isColorReliefStyleLayer(layer)) {
            return this._claim(
                () => this._colorRelief.canDraw(this._painter, tileManager, layer, coords, renderOptions),
                () => this._colorRelief.draw(
                    this._renderer,
                    this._camera,
                    this._painter,
                    tileManager,
                    layer,
                    coords,
                    renderOptions,
                ));
        }

        // No renderer here owns this layer type, so MapLibre is about to draw
        // it and must have the context back.
        this._closeThree();
        return false;
    }

    /**
     * Indirection so a test can substitute a renderer without a GPU. Assigned
     * rather than imported at the call site because Three's constructor is the
     * one thing here that cannot run headless.
     */
    private static _RendererCtor: typeof WebGLRenderer = WebGLRenderer;

    /** @internal Test seam — see `_RendererCtor`. */
    static setRendererConstructor(ctor: typeof WebGLRenderer | null): void {
        ThreeBackend._RendererCtor = ctor ?? WebGLRenderer;
    }

    /** The inner backend, for the layers G4 has not migrated yet. */
    get painter(): Painter {
        return this._painter;
    }

    /** The Three scene migrated layers draw into. Empty until G4-2. */
    get scene(): Scene {
        return this._scene;
    }

    // ── surface geometry ────────────────────────────────────────────────
    get width(): number {
        return this._painter.width;
    }

    get height(): number {
        return this._painter.height;
    }

    get pixelRatio(): number {
        return this._painter.pixelRatio;
    }

    // ── what is being drawn ─────────────────────────────────────────────
    get style(): Style {
        return this._painter.style;
    }

    set style(value: Style) {
        this._painter.style = value;
    }

    get transform(): IReadonlyTransform {
        return this._painter.transform;
    }

    set transform(value: IReadonlyTransform) {
        this._painter.transform = value;
    }

    get terrainFacilitator(): {dirty: boolean; matrix: mat4; renderTime: number} {
        return this._painter.terrainFacilitator;
    }

    maybeDrawDepthAndCoords(requireExact: boolean): void {
        this._painter.maybeDrawDepthAndCoords(requireExact);
    }

    // ── lifecycle ───────────────────────────────────────────────────────
    resize(width: number, height: number, pixelRatio: number): void {
        this._painter.resize(width, height, pixelRatio);
        // Viewport only. `setSize` would resize MapLibre's canvas — see the
        // class comment.
        this._renderer.setViewport(0, 0, this._painter.width, this._painter.height);
    }

    render(style: Style, options: RenderBackendOptions): void {
        this._painter.render(style, options);
        // The frame may have ended mid-run, with Three still holding the
        // context. Whoever disturbs the state owns putting it back.
        this._closeThree();
        this._renderThreePass();
    }

    /**
     * Hands the context to Three and takes it back.
     *
     * Renders an empty scene at G4-1: no pixels, full state disturbance. That is
     * the point — see the class comment.
     */
    private _renderThreePass(): void {
        this._drawWithThree(() => {
            this._renderer.render(this._scene, this._camera);
        });
    }

    /**
     * Runs `body` with Three owning the context, and gives it back afterwards.
     *
     * ## Why both `setDirty` and `setBaseState`
     *
     * `setDirty()` only *marks* MapLibre's cached GL values stale; a value is
     * rewritten to the driver when something sets it again. `setBaseState()` is
     * what actually reasserts them.
     *
     * At G4-1 this ran once, at the end of the frame, and `setDirty()` alone was
     * enough — `ui/map.ts#_render` opens the next frame with both. The moment the
     * handover moved *mid*-frame for G4-2, that stopped being true: anything
     * Three changed that MapLibre does not happen to set again during the rest of
     * the frame stays wrong.
     *
     * It was not a subtle failure. The render suite went from 2 failures to 144,
     * and almost every one was a `text-*` or `symbol` fixture — the layers that
     * depend on exactly the state `setBaseState` restores: bound program, active
     * texture unit, and the `UNPACK_*` pixel-store flags Three sets when it
     * uploads its own textures.
     *
     * Both directions matter. Omitting either produces corruption in layers that
     * have nothing to do with the one being migrated, which is very hard to
     * attribute back to here.
     */
    private _drawWithThree<T>(body: () => T): T {
        this._openThree();
        try {
            return body();
        } finally {
            this._closeThree();
        }
    }

    /**
     * Whether Three currently owns the context.
     *
     * Held **across consecutive migrated layers**. §7 measured the per-layer
     * handover at ~103 µs, which at a hundred layers is most of a 60 fps frame
     * — and now that every style layer type is migrated, consecutive runs are
     * usually the whole frame.
     */
    private _threeOpen = false;

    /** MapLibre's viewport when the handover opened, so closing can restore it. */
    private _viewportAtOpen: [number, number, number, number] | null = null;

    /**
     * Takes the context, and puts back the two things `resetState` destroys.
     *
     * `WebGLState.reset()` — which `resetState()` calls — ends with
     *
     * ```js
     * gl.bindFramebuffer( gl.FRAMEBUFFER, null );
     * gl.viewport( 0, 0, gl.canvas.width, gl.canvas.height );
     * ```
     *
     * On the normal path both are already true, so nothing showed. Under
     * terrain they are not: `RenderToTexture.renderLayer` binds a pool object's
     * framebuffer and sets the viewport to that texture's size, and a handover
     * inside that would redirect the draw **to the screen at the wrong size**.
     * That is the whole reason every renderer declined `render-to-texture`, and
     * removing the decline without this would not fail loudly — it would draw
     * the layer twice over the map and leave the terrain tile blank.
     *
     * **Read from GL, not from `context.bindFramebuffer.current`.** MapLibre's
     * cached `Value` is what MapLibre last *set*, and this backend's whole job
     * is being somewhere that cache is not authoritative. The two queries are
     * client-side state in every WebGL implementation, not a pipeline flush.
     */
    private _openThree(): void {
        if (this._threeOpen) return;
        const gl = this._painter.context.gl;
        const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
        this._viewportAtOpen = [viewport[0], viewport[1], viewport[2], viewport[3]];
        this._threeOpen = true;
        resetThreeState(this._renderer, gl);
    }

    /**
     * Gives the context back, if Three has it.
     *
     * Called on three occasions and no others: a layer this backend declines
     * (MapLibre is about to draw it), `Painter.migratedFlush` (the painter is
     * about to draw something of its own between layers), and the end of the
     * frame. Anything else would either corrupt MapLibre's rendering or pay for
     * a handover nothing needed.
     */
    private _closeThree(): void {
        if (!this._threeOpen) return;
        this._threeOpen = false;
        this._painter.context.setDirty();
        this._painter.setBaseState();
        // `setBaseState` ends with `viewport.set([0, 0, width, height])` — the
        // **canvas**, which is the wrong answer inside a terrain render target.
        // It matters immediately: `_renderTileClippingMasks` flushes this
        // backend and then draws the masks itself, so a clobbered viewport
        // would put the stencil masks at canvas size inside a 512-pixel tile.
        // Set through MapLibre's own `Value` so its cache stays truthful.
        const viewport = this._viewportAtOpen;
        if (viewport) this._painter.context.viewport.set(viewport);
    }

    /**
     * Asks a renderer for a layer, and keeps the handover open if it takes it.
     *
     * The order is the same one §4c paid 52 fixtures to learn — `canDraw`
     * **outside** the handover — with one change: "outside" now means "before
     * opening it", not "after closing it". A run of layers this backend draws
     * pays one handover between them all instead of one each.
     */
    private _claim(canDraw: () => boolean, draw: () => boolean): boolean {
        if (!canDraw()) {
            this._closeThree();
            return false;
        }
        this._openThree();
        return draw();
    }

    /** How much of the frame Three actually drew. See `background_layer.ts`. */
    get backgroundStats(): BackgroundStats {
        return this._background.stats;
    }

    /** How much of the frame Three actually drew. See `fill_layer.ts`. */
    get fillStats(): FillStats {
        return this._fill.stats;
    }

    /** How much of the frame Three actually drew. See `fill_extrusion_layer.ts`. */
    get fillExtrusionStats(): FillExtrusionStats {
        return this._fillExtrusion.stats;
    }

    /** How much of the frame Three actually drew. See `building_glass_layer.ts`. */
    get buildingGlassStats(): BuildingGlassStats {
        return this._buildingGlass.stats;
    }

    /** How much of the frame Three actually drew. See `line_layer.ts`. */
    get lineStats(): LineStats {
        return this._line.stats;
    }

    /** How much of the frame Three actually drew. See `circle_layer.ts`. */
    get circleStats(): CircleStats {
        return this._circle.stats;
    }

    get skyStats(): SkyStats {
        return this._sky.stats;
    }

    /** How much of the frame Three actually drew. See `symbol_layer.ts`. */
    get symbolStats(): SymbolStats {
        return this._symbol.stats;
    }

    /** How much of the frame Three actually drew. See `heatmap_layer.ts`. */
    get heatmapStats(): HeatmapStats {
        return this._heatmap.stats;
    }

    /** How much of the frame Three actually drew. See `raster_layer.ts`. */
    get rasterStats(): RasterStats {
        return this._raster.stats;
    }

    /** How much of the frame Three actually drew. See `hillshade_layer.ts`. */
    get hillshadeStats(): HillshadeStats {
        return this._hillshade.stats;
    }

    /** How much of the frame Three actually drew. See `color_relief_layer.ts`. */
    get colorReliefStats(): ColorReliefStats {
        return this._colorRelief.stats;
    }

    destroy(): void {
        // Only Three's own objects. `dispose()` does not touch the context's
        // buffers, which MapLibre still owns and destroys itself.
        // Every migrated renderer, not just the first three. Each holds a
        // material cache, and a material holds a compiled program — dropping the
        // reference without disposing leaks the program for the lifetime of the
        // context. Missing from here since G4-6, when three renderers were added
        // and this list was not.
        this._background.destroy();
        this._fill.destroy();
        this._fillExtrusion.destroy();
        this._buildingGlass.destroy();
        this._line.destroy();
        this._circle.destroy();
        this._heatmap.destroy();
        this._symbol.destroy();
        this._raster.destroy();
        this._hillshade.destroy();
        this._colorRelief.destroy();
        this._renderer.dispose();
        this._painter.destroy();
    }

    setBaseState(): void {
        this._painter.setBaseState();
    }

    // ── texture pooling ─────────────────────────────────────────────────
    createImageTexture(image: TextureImage, options?: {useMipmap?: boolean; premultiply?: boolean}): Texture {
        return this._painter.createImageTexture(image, options);
    }

    saveTileTexture(texture: Texture): void {
        this._painter.saveTileTexture(texture);
    }

    getTileTexture(size: number): Texture | null {
        return this._painter.getTileTexture(size);
    }

    overLimit(): boolean {
        return this._painter.overLimit();
    }

    // ── not yet backend-neutral ─────────────────────────────────────────
    get context(): Context {
        return this._painter.context;
    }

    setTerrain(terrain: Terrain | null): void {
        this._painter.setTerrain(terrain);
    }
}
