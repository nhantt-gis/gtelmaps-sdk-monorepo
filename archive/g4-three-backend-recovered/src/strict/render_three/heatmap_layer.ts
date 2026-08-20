import {
    BufferGeometry,
    CustomBlending,
    DoubleSide,
    ExternalTexture,
    Mesh,
    OneFactor,
    OneMinusSrcAlphaFactor,
} from 'three';

import {getHeatmapColorRampTexture} from '../../render/draw_heatmap';
import {heatmapTextureUniformValues} from '../../render/program/heatmap_program';
import {HEATMAP_FULL_RENDER_FBO_KEY} from '../../style/style_layer/heatmap_style_layer';
import {BucketBuffersCache, type BucketBuffers} from './bucket_geometry';
import {applyHeatmapTextureUniforms, createHeatmapTextureMaterial} from './heatmap_program';
import {invalidateThreeStateCache} from './texture_bridge';

import type {Camera, RawShaderMaterial, WebGLRenderer} from 'three';
import type {HeatmapStyleLayer} from '../../style/style_layer/heatmap_style_layer';
import type {OverscaledTileID} from '../../tile/tile_id';
import type {Painter, RenderOptions} from '../../render/painter';
import type {TileManager} from '../../tile/tile_manager';

/**
 * Draws `heatmap` through Three — the colouring pass only.
 *
 * ## The same split as `hillshade`, for the same reason
 *
 * `drawHeatmap` runs twice per frame. In `offscreen` it sums every feature's
 * kernel additively into a quarter-resolution framebuffer; in `translucent` it
 * reads that framebuffer through a colour ramp. Only the second belongs to the
 * scene — the first is a compute step whose output happens to be a texture, and
 * moving it here would mean driving `context.bindFramebuffer` from inside the
 * Three handover, the exact operation that cost 52 terrain fixtures in G4-2.
 *
 * So `canDraw` refuses the `offscreen` pass and counts it as `prepare-pass`.
 * That counter climbing every frame is **correct**.
 *
 * ## What is different from every layer so far
 *
 * **There are no tiles in this pass.** `renderHeatmapFlat` ignores `coords`
 * entirely: the offscreen pass already composited every tile's kernels into one
 * screen-sized texture, so the colouring is a single full-viewport quad. This is
 * the first ported draw whose geometry has nothing to do with the tile grid, and
 * the first with no `ProjectionData` at all — see `heatmap_program.ts`.
 *
 * One draw per layer per frame also means `stats.drawn` climbs by 1, not by the
 * tile count. Reading it against the other layers' numbers without knowing that
 * would look like the heatmap is barely drawing.
 *
 * ## Declined, with reasons
 *
 * - **Terrain.** It is not merely "terrain support": the terrain path is a
 *   structurally different algorithm — one framebuffer *per tile*, destroyed
 *   after use, and a per-tile projection matrix — rather than the same code with
 *   an elevation term. It would be a second renderer, not a branch.
 * - Globe, render-to-texture, overdraw inspector — as elsewhere.
 */
export type HeatmapStats = {
    drawn: number;
    fellBack: Record<string, number>;
    /** Draws skipped inside a claimed pass. See `FillStats.skipped`. */
    skipped: Record<string, number>;
};

const INDICES_PER_TRIANGLE = 3;

export class HeatmapRenderer {
    readonly stats: HeatmapStats = {drawn: 0, fellBack: {}, skipped: {}};

    private readonly _buffers = new BucketBuffersCache();
    private readonly _externalTextures = new WeakMap<WebGLTexture, ExternalTexture>();
    private readonly _material: RawShaderMaterial;
    private readonly _geometry = new BufferGeometry();
    private readonly _mesh: Mesh;

    constructor() {
        this._material = createHeatmapTextureMaterial();
        this._mesh = new Mesh(this._geometry, this._material);
        // The quad is already in clip space by the time `u_matrix` has been
        // applied, so this mesh carries no transform. Both flags are still
        // needed: Three would otherwise recompute `matrixWorld` every frame, and
        // with an identity projection its culling is meaningless — see
        // `projection_bridge.ts`.
        this._mesh.matrixAutoUpdate = false;
        this._mesh.matrixWorldAutoUpdate = false;
        this._mesh.frustumCulled = false;
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
        layer: HeatmapStyleLayer,
        _coords: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
    ): boolean {
        if (painter.options.showOverdrawInspector) return this._fallBack('overdraw-inspector');
        // **Not the same shape as the other three live layers.** `circle`,
        // `symbol` and `fill-extrusion` reach terrain by adding `get_elevation`
        // to a shader they already had. `drawHeatmap` instead takes a wholly
        // different branch: `prepareHeatmapTerrain`/`renderHeatmapTerrain` give
        // **each tile its own framebuffer** at `tile.tileSize`, draw the texture
        // pass from a tile-space quad (`rasterBoundsBuffer`) rather than the
        // viewport quad, and **destroy the framebuffer** after each render.
        //
        // Two fixtures, and the geometry is the part that is not yet understood
        // by reading: the texture shader multiplies `a_pos` by `u_world` under
        // an ortho matrix sized to the screen, which for a 0..EXTENT quad is off
        // screen by three orders of magnitude — so something about that path is
        // not what it appears, and guessing at it is how §11 spent a section on
        // the wrong suspect. Declined with its own name so the coverage table
        // stops calling it plain `terrain`.
        if (painter.style.map.terrain) return this._fallBack('terrain-per-tile-fbo');
        if (renderOptions.isRenderingToTexture) return this._fallBack('render-to-texture');
        // **No globe decline, and that is not an oversight.** The pass this
        // renderer owns is `renderHeatmapFlat`, which passes `projectionData`
        // as **null** and draws the viewport quad — it never touches a
        // projection. Globe only reaches `prepareHeatmapFlat`, the accumulation
        // pass, which is declined as `prepare-pass` by design.
        // By design and for good — see the class comment.
        if (painter.renderPass === 'offscreen') return this._fallBack('prepare-pass');
        if (painter.renderPass !== 'translucent') return this._fallBack('other-pass');
        // `drawHeatmap` returns before either pass when opacity is zero, so
        // claiming the layer here would be claiming a no-op. Handing it back
        // keeps the two backends' behaviour identical for a case where neither
        // draws anything.
        if (layer.paint.get('heatmap-opacity') === 0) return this._fallBack('zero-opacity');

        return true;
    }

    /**
     * Draws the layer. Only valid after {@link canDraw} has returned `true`.
     */
    draw(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        _tileManager: TileManager,
        layer: HeatmapStyleLayer,
        _coords: Array<OverscaledTileID>,
        _renderOptions: RenderOptions,
    ): boolean {
        const gl = painter.context.gl;
        const context = painter.context;

        // Written by the offscreen pass, which MapLibre still owns. Absent on
        // the first frame of a style, and whenever the layer has no data.
        const fbo = layer.heatmapFbos.get(HEATMAP_FULL_RENDER_FBO_KEY);
        if (!fbo) { this._skip('no-framebuffer'); return true; }

        const buffers = this._viewportBuffers(painter, gl);
        if (!buffers || buffers.segments.length === 0) { this._skip('no-quad'); return true; }

        const material = this._material;
        this._mesh.material = material;

        // MapLibre draws this with DepthMode.disabled and StencilMode.disabled —
        // it is a full-viewport composite, so there is nothing to test against.
        material.depthTest = false;
        material.depthWrite = false;
        material.stencilWrite = false;
        material.transparent = true;
        // ColorMode.alphaBlended, against colours that arrive premultiplied.
        material.blending = CustomBlending;
        material.blendSrc = OneFactor;
        material.blendDst = OneMinusSrcAlphaFactor;
        // CullFaceMode.disabled.
        material.side = DoubleSide;
        material.needsUpdate = true;

        applyHeatmapTextureUniforms(material, heatmapTextureUniformValues(painter, layer, 0, 1));

        // The density texture needs no `bind` for its parameters: unlike the
        // atlases, `createHeatmapFbo` sets LINEAR/CLAMP_TO_EDGE at creation and
        // uses no mipmaps, so it reaches Three already complete (§6.4).
        material.uniforms.u_image.value = this._externalTexture(fbo.colorAttachment.get());

        // The ramp does need it — it arrives as an ordinary `Texture`.
        const colorRamp = getHeatmapColorRampTexture(context, layer);
        colorRamp.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
        material.uniforms.u_color_ramp.value = this._externalTexture(colorRamp.texture);
        // Two textures, so the divergence argued in `texture_bridge` is
        // reachable — and the `bind` above is precisely what makes it reachable.
        invalidateThreeStateCache(renderer, gl);

        for (let i = 0; i < buffers.segments.length; i++) {
            buffers.bindSegment(this._geometry, i);
            renderer.render(this._mesh, camera);
            this.stats.drawn++;
        }

        return true;
    }

    private _externalTexture(texture: WebGLTexture): ExternalTexture {
        let wrapped = this._externalTextures.get(texture);
        if (!wrapped) {
            wrapped = new ExternalTexture(texture);
            this._externalTextures.set(texture, wrapped);
        }
        return wrapped;
    }

    /**
     * The painter's own full-viewport quad, `0..1` in both axes.
     *
     * Keyed on the buffer rather than the painter: it is the buffer's identity
     * that decides whether the cached descriptor still points at live GL memory.
     */
    private _viewportBuffers(painter: Painter, gl: WebGLRenderingContext): BucketBuffers | null {
        const vertexBuffer = painter.viewportBuffer as unknown as {buffer?: WebGLBuffer};
        const indexBuffer = painter.quadTriangleIndexBuffer as unknown as {buffer?: WebGLBuffer};
        if (!vertexBuffer?.buffer || !indexBuffer?.buffer) return null;

        return this._buffers.get(vertexBuffer, () => ({
            layoutBuffers: [vertexBuffer as never],
            indexBuffer: indexBuffer.buffer!,
            indexType: gl.UNSIGNED_SHORT,
            indexBytes: 2,
            indexCount: painter.viewportSegments.segments.reduce(
                (total, segment) => total + segment.primitiveLength, 0) * INDICES_PER_TRIANGLE,
            segments: painter.viewportSegments.segments as never,
            indicesPerPrimitive: INDICES_PER_TRIANGLE,
            gl,
        }));
    }

    destroy(): void {
        // The geometry is deliberately not disposed: its attributes point at
        // MapLibre's GL buffers. See `bucket_geometry.ts`.
        this._material.dispose();
    }
}
