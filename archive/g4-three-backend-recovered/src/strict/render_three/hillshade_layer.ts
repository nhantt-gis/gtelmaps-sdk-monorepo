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
import {hillshadeUniformValues} from '../../render/program/hillshade_program';
import {applyProjectionData, tileProjectionOptions} from './projection_bridge';
import {applyGlobeProjectionData} from './projection_globe';
import {applyStencilMode} from './stencil_bridge';
import {invalidateThreeStateCache} from './texture_bridge';
import {BucketBuffersCache, type BucketBuffers} from './bucket_geometry';
import {applyHillshadeUniforms, HillshadeMaterialCache} from './hillshade_program';

import type {Camera, RawShaderMaterial, WebGLRenderer} from 'three';
import type {HillshadeStyleLayer} from '../../style/style_layer/hillshade_style_layer';
import type {OverscaledTileID} from '../../tile/tile_id';
import type {Painter, RenderOptions} from '../../render/painter';
import type {StencilMode} from '../../gl/stencil_mode';
import type {TileManager} from '../../tile/tile_manager';

/**
 * Draws `hillshade` through Three — the shading pass only.
 *
 * ## Why the offscreen pass is handed back, permanently
 *
 * `drawHillshade` runs twice per frame. In `offscreen` it renders the DEM's
 * slope into a per-tile framebuffer with the `hillshadePrepare` program; in
 * `translucent` it shades that framebuffer's texture onto the map.
 *
 * Only the second belongs to the scene. The first is a compute step whose output
 * is a texture, and moving it would mean driving `context.bindFramebuffer` from
 * inside the Three handover — the precise operation that cost 52 terrain
 * fixtures in G4-2, where `setBaseState()` reset the framebuffer while MapLibre
 * was mid-render into one.
 *
 * So `canDraw` refuses the `offscreen` pass and counts it as `prepare-pass`.
 * That counter climbing every frame is **correct**, not a gap: read it as "the
 * prepare step ran where it belongs".
 *
 * ## What is reused, and why
 *
 * `hillshadeUniformValues` carries the method-name-to-integer table, the
 * latitude range that corrects for mercator distortion, and the bearing
 * adjustment applied when the light is anchored to the viewport. Every one of
 * those, reimplemented slightly wrong, produces terrain that is shaded — just
 * shaded from a different direction.
 */
export type HillshadeStats = {
    drawn: number;
    fellBack: Record<string, number>;
    /** Tiles skipped inside a claimed draw. See `FillStats.skipped`. */
    skipped: Record<string, number>;
};

type HillshadeTile = {
    fbo?: {colorAttachment: {get(): WebGLTexture}};
};

/** Everything constant across a whole `draw`, threaded into `_drawTiles`. */
type HillshadeDrawContext = {
    renderer: WebGLRenderer;
    camera: Camera;
    painter: Painter;
    tileManager: TileManager;
    layer: HillshadeStyleLayer;
    material: RawShaderMaterial;
    /** True whenever tiles are subdivided, i.e. whenever globe is being drawn. */
    isGlobe: boolean;
    isRenderingToTexture: boolean;
    align: boolean;
};

const INDICES_PER_TRIANGLE = 3;

export class HillshadeRenderer {
    readonly stats: HillshadeStats = {drawn: 0, fellBack: {}, skipped: {}};

    private readonly _buffers = new BucketBuffersCache();
    private readonly _externalTextures = new WeakMap<WebGLTexture, ExternalTexture>();
    private readonly _materials = new HillshadeMaterialCache();
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
        _tileManager: TileManager,
        _layer: HillshadeStyleLayer,
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
        // By design and for good — see the class comment.
        if (painter.renderPass === 'offscreen') return this._fallBack('prepare-pass');
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
        layer: HillshadeStyleLayer,
        tileIDs: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
    ): boolean {
        const gl = painter.context.gl;
        const isGlobe = Boolean(painter.style.projection?.useSubdivision);

        // The light count is a `#define`, so a different count is a different
        // program — and so is the projection. See `hillshade_program.ts`.
        const sources = layer.paint.get('hillshade-highlight-color').values.length;
        const material = this._materials.get(sources, isGlobe);
        this._mesh.material = material;

        const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);
        material.depthTest = depthMode.func !== gl.ALWAYS;
        material.depthWrite = Boolean(depthMode.mask);
        material.transparent = true;
        material.blending = CustomBlending;
        material.blendSrc = OneFactor;
        material.blendDst = OneMinusSrcAlphaFactor;
        // MapLibre's CullFaceMode.backCCW in both projections — but Three flips
        // the winding itself when `matrixWorld` has a negative determinant, and
        // only the mercator `mainMatrix` does. Same reasoning, same conclusion
        // and the same one line as `raster_layer.ts`; see §14 and §15.
        material.side = isGlobe ? BackSide : FrontSide;
        material.needsUpdate = true;

        const shared: HillshadeDrawContext = {
            renderer, camera, painter, tileManager, layer, material, isGlobe,
            isRenderingToTexture: renderOptions.isRenderingToTexture,
            align: !painter.options.moving,
        };

        gl.depthRange(depthMode.range[0], depthMode.range[1]);
        try {
            if (isGlobe) {
                // Two passes, borderless then bordered — `drawRaster`'s
                // algorithm, which `drawHillshade` reuses verbatim and points at
                // by comment. The measurement in `raster_layer.ts` about which
                // half of it the fixtures can see applies here unchanged.
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

    /** One pass over one set of tiles — MapLibre's `renderHillshade`. */
    private _drawTiles(
        shared: HillshadeDrawContext,
        coords: Array<OverscaledTileID>,
        stencilModes: {[_: number]: Readonly<StencilMode>},
        useBorder: boolean,
    ): void {
        const {renderer, camera, painter, tileManager, layer, material, isGlobe,
            isRenderingToTexture, align} = shared;
        const gl = painter.context.gl;
        const context = painter.context;
        const transform = painter.transform;

        for (const coord of coords) {
            const tile = tileManager.getTile(coord);
            const fbo = (tile as unknown as HillshadeTile)?.fbo;
            // The prepare pass has not produced this tile's slope texture
            // yet. `renderHillshade` skips it too.
            if (!fbo) { this._skip('no-fbo'); continue; }

            const mesh = painter.style.projection!.getMeshFromTileID(
                context, coord.canonical, useBorder, true, 'raster');
            const buffers = this._buffersFor(mesh, gl);
            if (!buffers || buffers.segments.length === 0) { this._skip('no-mesh'); continue; }

            // No `bind(filter, wrap)` here and none needed: the attachment's
            // parameters were set once at creation, inside
            // `prepareHillshade`. See `hillshade_program.ts`.
            material.uniforms.u_image.value = this._externalTexture(fbo.colorAttachment.get());
            applyHillshadeUniforms(material, hillshadeUniformValues(painter, tile, layer) as never);

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
        this._materials.dispose();
    }
}
