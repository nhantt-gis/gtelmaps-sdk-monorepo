import {
    BackSide,
    BufferGeometry,
    CustomBlending,
    ExternalTexture,
    FrontSide,
    Mesh,
    OneFactor,
    OneMinusSrcAlphaFactor,
} from 'three';

import {DepthMode} from '../../gl/depth_mode';
import {Texture} from '../../render/texture';
import {colorReliefUniformValues} from '../../render/program/color_relief_program';
import {applyProjectionData, tileProjectionOptions} from './projection_bridge';
import {applyGlobeProjectionData} from './projection_globe';
import {applyStencilMode} from './stencil_bridge';
import {BucketBuffersCache, type BucketBuffers} from './bucket_geometry';
import {applyColorReliefUniforms, createColorReliefMaterial} from './color_relief_program';
import {invalidateThreeStateCache} from './texture_bridge';

import type {Camera, RawShaderMaterial, WebGLRenderer} from 'three';
import type {ColorReliefStyleLayer} from '../../style/style_layer/color_relief_style_layer';
import type {OverscaledTileID} from '../../tile/tile_id';
import type {Painter, RenderOptions} from '../../render/painter';
import type {StencilMode} from '../../gl/stencil_mode';
import type {TileManager} from '../../tile/tile_manager';

/**
 * Draws `color-relief` through Three.
 *
 * ## Three textures, and only one of them per tile
 *
 * The DEM is per tile and re-uploaded each frame from `dem.getPixels()`. The two
 * ramps — elevation stops and colour stops — belong to the *layer* and are built
 * once by `layer.getColorRampTextures`, so upstream fetches them on the first
 * tile of the pass and reuses them for the rest. That is replicated here rather
 * than simplified to "every tile", because building the ramp is a CPU
 * rasterisation, not a lookup.
 *
 * ## The DEM upload is MapLibre's, deliberately
 *
 * `demTexture.update(pixelData, {premultiply: false})` is a `texImage2D` into a
 * texture MapLibre owns and pools through `painter.getTileTexture`. Reproducing
 * it would fork the pool. The call is made here, on MapLibre's texture, and only
 * the *sampling* happens through Three.
 */
export type ColorReliefStats = {
    drawn: number;
    fellBack: Record<string, number>;
    /** Tiles skipped inside a claimed draw. See `FillStats.skipped`. */
    skipped: Record<string, number>;
};

const INDICES_PER_TRIANGLE = 3;

type MapLibreTexture = {texture: WebGLTexture; bind(filter: number, wrap: number): void};

/** Everything constant across a whole `draw`, threaded into `_drawTiles`. */
type ColorReliefDrawContext = {
    renderer: WebGLRenderer;
    camera: Camera;
    painter: Painter;
    tileManager: TileManager;
    layer: ColorReliefStyleLayer;
    material: RawShaderMaterial;
    /** True whenever tiles are subdivided, i.e. whenever globe is being drawn. */
    isGlobe: boolean;
    isRenderingToTexture: boolean;
    align: boolean;
};

export class ColorReliefRenderer {
    readonly stats: ColorReliefStats = {drawn: 0, fellBack: {}, skipped: {}};

    private readonly _buffers = new BucketBuffersCache();
    private readonly _externalTextures = new WeakMap<WebGLTexture, ExternalTexture>();
    private readonly _material: RawShaderMaterial;
    private readonly _globeMaterial: RawShaderMaterial;
    private readonly _geometry = new BufferGeometry();
    private readonly _mesh: Mesh;

    constructor() {
        this._material = createColorReliefMaterial(false);
        this._globeMaterial = createColorReliefMaterial(true);
        this._mesh = new Mesh(this._geometry, this._material);
    }

    private _fallBack(reason: string): false {
        this.stats.fellBack[reason] = (this.stats.fellBack[reason] ?? 0) + 1;
        return false;
    }

    private _skip(reason: string): void {
        this.stats.skipped[reason] = (this.stats.skipped[reason] ?? 0) + 1;
    }

    canDraw(
        painter: Painter,
        _tileManager: TileManager,
        _layer: ColorReliefStyleLayer,
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
        if (painter.renderPass !== 'translucent') return this._fallBack('other-pass');
        if (!coords.length) return this._fallBack('no-tiles');

        return true;
    }

    /**
     * Draws the layer. Only valid after {@link canDraw} has returned `true`.
     */
    draw(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        tileManager: TileManager,
        layer: ColorReliefStyleLayer,
        tileIDs: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
    ): boolean {
        const gl = painter.context.gl;
        const isGlobe = Boolean(painter.style.projection?.useSubdivision);
        const material = isGlobe ? this._globeMaterial : this._material;
        this._mesh.material = material;

        const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);
        material.depthTest = depthMode.func !== gl.ALWAYS;
        material.depthWrite = Boolean(depthMode.mask);
        material.transparent = true;
        material.blending = CustomBlending;
        material.blendSrc = OneFactor;
        material.blendDst = OneMinusSrcAlphaFactor;
        // MapLibre's CullFaceMode.backCCW in both projections; the inversion
        // under globe is Three's own winding flip. Same one line as
        // `raster_layer.ts` and `hillshade_layer.ts` — see §14 and §15.
        material.side = isGlobe ? BackSide : FrontSide;
        material.needsUpdate = true;

        const shared: ColorReliefDrawContext = {
            renderer, camera, painter, tileManager, layer, material, isGlobe,
            isRenderingToTexture: renderOptions.isRenderingToTexture,
            align: !painter.options.moving,
        };

        gl.depthRange(depthMode.range[0], depthMode.range[1]);
        try {
            if (isGlobe) {
                // Two passes, borderless then bordered — `drawRaster`'s
                // algorithm, which `drawColorRelief` reuses verbatim and points
                // at by comment. See `raster_layer.ts` for which half of it the
                // fixtures can actually see.
                // `clearStencil()` runs inside this call and draws a
                // full-screen quad through MapLibre's own program, which leaves
                // Three's state cache describing a VAO that is no longer bound.
                // See `texture_bridge.ts`.
                const [borderless, bordered, coords] =
                    painter.stencilConfigForOverlapTwoPass(tileIDs);
                invalidateThreeStateCache(renderer, gl);
                this._drawTiles(shared, coords, borderless, false);
                this._drawTiles(shared, coords, bordered, true);
            } else {
                // Side effect: advances the painter's stencil id. Once, here.
                // Its `clearStencil()` is conditional, not absent — same note.
                const [stencilModes, coords] =
                    painter.getStencilConfigForOverlapAndUpdateStencilID(tileIDs);
                invalidateThreeStateCache(renderer, gl);
                this._drawTiles(shared, coords, stencilModes, false);
            }
        } finally {
            gl.depthRange(0, 1);
        }

        return true;
    }

    /**
     * One pass over one set of tiles — MapLibre's `renderColorRelief`.
     *
     * The ramp textures are bound **per pass**, not per draw: upstream's
     * `firstTile` flag is local to `renderColorRelief`, so the two-pass globe
     * path rebinds them on the second pass too. Hoisting it out to `draw` would
     * be one fewer bind and a divergence, and the divergence only shows up if
     * something else rebinds unit 1 or 4 in between.
     */
    private _drawTiles(
        shared: ColorReliefDrawContext,
        coords: Array<OverscaledTileID>,
        stencilModes: {[_: number]: Readonly<StencilMode>},
        useBorder: boolean,
    ): void {
        const {renderer, camera, painter, tileManager, layer, material, isGlobe,
            isRenderingToTexture, align} = shared;
        const gl = painter.context.gl;
        const context = painter.context;
        const transform = painter.transform;
        const textureFilter = layer.paint.get('resampling') === 'nearest' ? gl.NEAREST : gl.LINEAR;

        let colorRampSize = 0;
        let rampsBound = false;

        for (const coord of coords) {
            const tile = tileManager.getTile(coord);
            const dem = tile?.dem;
            if (!dem || !dem.data) { this._skip('no-dem'); continue; }

            // Layer-scoped, not tile-scoped: built once and reused for the
            // rest of the pass, as upstream does.
            if (!rampsBound) {
                const maxLength = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
                const {elevationTexture, colorTexture} =
                    layer.getColorRampTextures(context, maxLength, dem.getUnpackVector() as never);
                context.activeTexture.set(gl.TEXTURE1);
                elevationTexture.bind(gl.NEAREST, gl.CLAMP_TO_EDGE);
                context.activeTexture.set(gl.TEXTURE4);
                colorTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
                material.uniforms.u_elevation_stops.value =
                    this._externalTexture((elevationTexture as MapLibreTexture).texture);
                material.uniforms.u_color_stops.value =
                    this._externalTexture((colorTexture as MapLibreTexture).texture);
                colorRampSize = elevationTexture.size[0];
                rampsBound = true;
            }

            // MapLibre's own upload into MapLibre's own pooled texture.
            context.pixelStoreUnpackPremultiplyAlpha.set(false);
            tile.demTexture = tile.demTexture || painter.getTileTexture(dem.stride);
            if (tile.demTexture) {
                tile.demTexture.update(dem.getPixels() as never, {premultiply: false});
            } else {
                tile.demTexture = new Texture(context, dem.getPixels() as never, gl.RGBA, {premultiply: false});
            }
            context.activeTexture.set(gl.TEXTURE0);
            tile.demTexture.bind(textureFilter, gl.CLAMP_TO_EDGE);
            material.uniforms.u_image.value =
                this._externalTexture((tile.demTexture as unknown as MapLibreTexture).texture);
            // Three samples three textures here, so its per-unit cache has
            // to be discarded after MapLibre's binds. See `texture_bridge`.
            invalidateThreeStateCache(renderer, gl);

            const mesh = painter.style.projection!.getMeshFromTileID(
                context, coord.canonical, useBorder, true, 'raster');
            const buffers = this._buffersFor(mesh, gl);
            if (!buffers || buffers.segments.length === 0) { this._skip('no-mesh'); continue; }

            applyColorReliefUniforms(
                material, colorReliefUniformValues(layer, dem, colorRampSize) as never);

            applyStencilMode(material, stencilModes[coord.overscaledZ], gl);

            const projectionData = transform.getProjectionData(
                tileProjectionOptions(coord, isRenderingToTexture, align));
            if (isGlobe) applyGlobeProjectionData(material, projectionData);
            applyProjectionData(this._mesh, projectionData);

            for (let i = 0; i < buffers.segments.length; i++) {
                buffers.bindSegment(this._geometry, i);
                renderer.render(this._mesh, camera);
                this.stats.drawn++;
            }
        }
    }

    private _externalTexture(texture: WebGLTexture): ExternalTexture {
        let wrapped = this._externalTextures.get(texture);
        if (!wrapped) {
            wrapped = new ExternalTexture(texture);
            this._externalTextures.set(texture, wrapped);
        }
        return wrapped;
    }

    private _buffersFor(
        mesh: {
            vertexBuffer?: {buffer?: WebGLBuffer};
            indexBuffer?: {buffer?: WebGLBuffer};
            segments: {segments: Array<{primitiveLength: number}>};
        },
        gl: WebGLRenderingContext,
    ): BucketBuffers | null {
        if (!mesh.vertexBuffer?.buffer || !mesh.indexBuffer?.buffer) return null;

        return this._buffers.get(mesh, () => ({
            layoutBuffers: [mesh.vertexBuffer as never],
            indexBuffer: mesh.indexBuffer!.buffer!,
            indexType: gl.UNSIGNED_SHORT,
            indexBytes: 2,
            indexCount: mesh.segments.segments.reduce(
                (total, segment) => total + segment.primitiveLength, 0) * INDICES_PER_TRIANGLE,
            segments: mesh.segments.segments as never,
            indicesPerPrimitive: INDICES_PER_TRIANGLE,
            gl,
        }));
    }

    destroy(): void {
        // The geometry is deliberately not disposed: its attributes point at
        // MapLibre's GL buffers. See `bucket_geometry.ts`.
        this._material.dispose();
        this._globeMaterial.dispose();
    }
}
