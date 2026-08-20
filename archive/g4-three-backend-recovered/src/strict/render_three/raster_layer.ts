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
import {EXTENT} from '../../data/extent';
import {StencilMode} from '../../gl/stencil_mode';
import {ImageSource} from '../../source/image_source';
import {getFadeProperties} from '../../render/draw_raster';
import {rasterUniformValues} from '../../render/program/raster_program';
import {applyProjectionData, tileProjectionOptions} from './projection_bridge';
import {applyGlobeProjectionData} from './projection_globe';
import {applyStencilMode} from './stencil_bridge';
import {BucketBuffersCache, type BucketBuffers} from './bucket_geometry';
import {applyRasterUniforms, createRasterMaterial} from './raster_program';
import {invalidateThreeStateCache} from './texture_bridge';

import type {Camera, RawShaderMaterial, WebGLRenderer} from 'three';
import type {OverscaledTileID} from '../../tile/tile_id';
import type {Painter, RenderOptions} from '../../render/painter';
import type {RasterStyleLayer} from '../../style/style_layer/raster_style_layer';
import type {TileManager} from '../../tile/tile_manager';

/**
 * Draws `raster` through Three, for the cases it can, and says so when it cannot.
 *
 * ## What makes this unlike every layer before it
 *
 * - **No paint binders.** A raster tile is one image; nothing varies per
 *   feature. `paint_binders.ts` is not involved at all, and there is one
 *   material for the whole map instead of one per paint shape.
 * - **The geometry is not a bucket's.** It comes from
 *   `projection.getMeshFromTileID`, which on mercator is a single cached quad
 *   shared by every tile — position lives entirely in the matrix. It is bound
 *   through the same `BucketBuffers` as everything else, which matters for one
 *   specific reason: the quad's index winding is `(1,0,2),(1,2,3)`, and using
 *   MapLibre's own index buffer means the G4-2 winding failure cannot recur by
 *   transcription.
 * - **Two textures per draw**, the tile and its parent, cross-faded while the
 *   tile loads.
 * - **The depth mode varies per tile.** Sublayer is `overscaledZ - minTileZ` and
 *   the comparison is `gl.LESS` rather than the usual `LEQUAL`, so overlapping
 *   tiles at different zooms do not double-draw. An opaque layer also writes
 *   depth; a translucent one does not.
 *
 * ## Three shapes, chosen exactly as `drawRaster` chooses them
 *
 * | source / projection | stencil | passes | mesh |
 * |---|---|---|---|
 * | `ImageSource`, any projection | **none** | 1 | no border, no poles |
 * | globe (subdivided) | `stencilConfigForOverlapTwoPass` | **2** | pass 2 has borders |
 * | anything else | `getStencilConfigForOverlapAndUpdateStencilID` | 1 | no border |
 *
 * The two-pass globe path is not a different uniform, it is a different
 * algorithm. Subdivided tiles at different granularities leave hairline gaps
 * between them, so each mesh carries a small border region — but borders
 * overlap, and an overlapped border shows a stretched edge texel. Upstream draws
 * every tile **borderless first**, marking the stencil, then draws the same
 * tiles **with borders** where the stencil is still unmarked. Gaps get filled,
 * borders never cover a neighbour, and no pixel is shaded twice.
 *
 * ## Declined, with reasons
 *
 * - Terrain outside the render pool, render-to-texture without terrain,
 *   overdraw inspector — as elsewhere.
 */
export type RasterStats = {
    drawn: number;
    fellBack: Record<string, number>;
    /** Tiles skipped inside a claimed draw. See `FillStats.skipped`. */
    skipped: Record<string, number>;
};

/** Everything constant across a whole `draw`, threaded into `_drawTiles`. */
type RasterDrawContext = {
    renderer: WebGLRenderer;
    camera: Camera;
    painter: Painter;
    tileManager: TileManager;
    layer: RasterStyleLayer;
    /** True whenever tiles are subdivided, i.e. whenever globe is being drawn. */
    isGlobe: boolean;
    isRenderingToTexture: boolean;
};

/**
 * What differs between the three shapes in the table above.
 *
 * An object rather than upstream's seven positional arguments — four of which
 * are booleans in a row. `drawTiles(…, false, true, cornerCoords, false, …)` is
 * not something a reader can check, and the globe path adds a fifth call site.
 */
type RasterTilePass = {
    coords: Array<OverscaledTileID>;
    /** `null` means no stencil at all — the image-source case. */
    stencilModes: {[_: number]: Readonly<StencilMode>} | null;
    useBorder: boolean;
    allowPoles: boolean;
    corners: ReadonlyArray<{x: number; y: number}>;
    flipCullFace: boolean;
};

type RasterTile = {
    texture?: {
        texture: WebGLTexture;
        useMipmap: boolean;
        bind(filter: number, wrap: number, mipmap?: number): void;
    };
    fadeOpacity?: number;
};

const INDICES_PER_TRIANGLE = 3;

export class RasterRenderer {
    readonly stats: RasterStats = {drawn: 0, fellBack: {}, skipped: {}};

    private readonly _buffers = new BucketBuffersCache();
    private readonly _externalTextures = new WeakMap<WebGLTexture, ExternalTexture>();
    private readonly _material: RawShaderMaterial;
    private readonly _globeMaterial: RawShaderMaterial;
    private readonly _geometry = new BufferGeometry();
    private readonly _mesh: Mesh;

    constructor() {
        this._material = createRasterMaterial(false);
        this._globeMaterial = createRasterMaterial(true);
        // One mesh for both: unlike `background`, the geometry comes from
        // MapLibre's mesh in *either* projection, so only the material differs.
        this._mesh = new Mesh(this._geometry, this._material);
    }

    private _fallBack(reason: string): false {
        this.stats.fellBack[reason] = (this.stats.fellBack[reason] ?? 0) + 1;
        return false;
    }

    private _skip(reason: string): void {
        this.stats.skipped[reason] = (this.stats.skipped[reason] ?? 0) + 1;
    }

    /**
     * Whether this renderer can draw `layer`, asked before the handover.
     *
     * Note what is **not** asked here: `getStencilConfigForOverlapAndUpdateStencilID`
     * advances the painter's stencil id as a side effect, so it belongs in
     * `draw`, called exactly once, exactly as upstream calls it.
     */
    canDraw(
        painter: Painter,
        tileManager: TileManager,
        _layer: RasterStyleLayer,
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
        if (!coords.length) return this._fallBack('no-tiles');

        return true;
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
        layer: RasterStyleLayer,
        tileIDs: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
    ): boolean {
        if (painter.renderPass !== 'translucent') return true;
        if (layer.paint.get('raster-opacity') === 0) return true;

        // An `ImageSource` is one picture pinned to four arbitrary corners, not
        // a grid, and `drawRaster` treats it as a separate branch with four
        // differences from the tiled path — all of them here, none elsewhere:
        //
        // 1. **No stencil at all.** Tiles of one image cannot overlap, so the
        //    overlap machinery has nothing to resolve. Calling it anyway would
        //    not merely be wasted: it advances the painter's stencil id as a
        //    side effect, burning ids toward the 256 that force a mid-frame
        //    stencil clear.
        // 2. **No poles.** `allowPoles` is false, so the mesh stops at the
        //    image's own edge instead of being stretched to the projection's.
        // 3. **The image's corners**, not the tile's. They become
        //    `u_coords_top`/`u_coords_bottom`, which is what lets a rotated or
        //    sheared overlay land on its four given points.
        // 4. **Possibly flipped winding.** Corners given in the other order make
        //    every triangle face away, so upstream flips the cull face rather
        //    than reordering the geometry.
        //
        // Note the branch order, which is upstream's: an image source takes the
        // single-pass shape **even under globe**. Its tiles cannot overlap, so
        // there is nothing for the two-pass stencil to resolve.
        const source = tileManager.getSource();
        const image = source instanceof ImageSource ? source : null;
        const isGlobe = Boolean(painter.style.projection?.useSubdivision);

        const shared: RasterDrawContext = {
            renderer, camera, painter, tileManager, layer, isGlobe,
            isRenderingToTexture: renderOptions.isRenderingToTexture,
        };

        if (image) {
            this._drawTiles(shared, {
                coords: tileIDs,
                stencilModes: null,
                useBorder: false,
                allowPoles: false,
                corners: image.tileCoords,
                flipCullFace: image.flippedWindingOrder,
            });
            return true;
        }

        if (isGlobe) {
            // Borderless first — it marks the stencil with the *higher* values,
            // so it wins every pixel it covers. The bordered pass then draws
            // only where the stencil is still low, which is exactly the gaps.
            //
            // **The gate verifies only half of this, measured both ways.**
            // Deleting the bordered pass entirely leaves `projection/globe` at
            // 104/104 — no fixture here has a gap for it to fill. Moving the
            // borders into the *first* pass instead turns 5 fixtures red
            // (`raster-planet`, `raster-pole`, `raster-warped` and two
            // `atmosphere` ones, 0.0003–0.0148). So the fixtures do see a
            // stretched border texel where a tile already covers — the half
            // that says "borders must lose" — and never see the half that says
            // "borders must fill". Kept for upstream parity, and because a real
            // map with neighbouring tiles at different granularities is exactly
            // the case this suite does not contain.
            // `clearStencil()` runs inside this call and draws a full-screen
            // quad through MapLibre's own program, which leaves Three's state
            // cache describing a VAO that is no longer bound. This renderer
            // also invalidates per tile for its two textures, so it was green
            // without this line — which is luck, not safety. See
            // `texture_bridge.ts`.
            const [borderless, bordered, coords] = painter.stencilConfigForOverlapTwoPass(tileIDs);
            invalidateThreeStateCache(renderer, painter.context.gl);
            const shape = {coords, useBorder: false, allowPoles: true, corners: CORNER_COORDS, flipCullFace: false};
            this._drawTiles(shared, {...shape, stencilModes: borderless});
            this._drawTiles(shared, {...shape, stencilModes: bordered, useBorder: true});
            return true;
        }

        // Its `clearStencil()` is conditional, not absent — same note.
        const [stencilModes, coords] = painter.getStencilConfigForOverlapAndUpdateStencilID(tileIDs);
        invalidateThreeStateCache(renderer, painter.context.gl);
        this._drawTiles(shared, {
            coords,
            stencilModes,
            useBorder: false,
            allowPoles: true,
            corners: CORNER_COORDS,
            flipCullFace: false,
        });
        return true;
    }

    /**
     * One pass over one set of tiles — MapLibre's `drawTiles`, which the globe
     * path calls twice.
     */
    private _drawTiles(shared: RasterDrawContext, pass: RasterTilePass): void {
        const {renderer, camera, painter, tileManager, layer, isGlobe, isRenderingToTexture} = shared;
        const {coords, stencilModes, useBorder, allowPoles} = pass;

        const gl = painter.context.gl;
        const context = painter.context;
        const transform = painter.transform;
        const material = isGlobe ? this._globeMaterial : this._material;
        this._mesh.material = material;

        const rasterOpacity = layer.paint.get('raster-opacity');
        const minTileZ = coords[coords.length - 1].overscaledZ;

        material.transparent = true;
        material.blending = CustomBlending;
        material.blendSrc = OneFactor;
        material.blendDst = OneMinusSrcAlphaFactor;
        // MapLibre's CullFaceMode.backCCW, as for `fill` — or `frontCCW` when
        // the image's corners wind the other way, which renders the back faces
        // instead of culling them.
        //
        // The `isGlobe` term is the second, independent inversion, and it is not
        // upstream's — upstream uses `backCCW` in both projections. Three flips
        // the winding itself whenever `matrixWorld` has a negative determinant,
        // and `matrixWorld` is `mainMatrix`: the mercator one carries a Y flip
        // and so is negative, the globe one operates on a unit sphere and is
        // not. Same mesh, same screen-space winding, opposite `side` — which is
        // what cost §12 a whole step before it was found in §14.
        material.side = (pass.flipCullFace !== isGlobe) ? BackSide : FrontSide;
        material.needsUpdate = true;

        const align = !painter.options.moving;
        const useNearest = layer.paint.get('resampling') === 'nearest' ||
            layer.paint.get('raster-resampling') === 'nearest';
        const textureFilter = useNearest ? gl.NEAREST : gl.LINEAR;
        const fadeDuration = layer.paint.get('raster-fade-duration');

        for (const coord of coords) {
            const tile = tileManager.getTile(coord) as unknown as RasterTile;
            if (!tile?.texture) { this._skip('no-texture'); continue; }

            const mesh = painter.style.projection!.getMeshFromTileID(
                context, coord.canonical, useBorder, allowPoles, 'raster');
            const buffers = this._buffersFor(mesh, gl);
            if (!buffers || buffers.segments.length === 0) { this._skip('no-mesh'); continue; }

            // Lower zooms to sublayer 0, higher to higher sublayers, compared
            // with LESS so overlapping tiles do not draw twice.
            const depthMode = painter.getDepthModeForSublayer(
                coord.overscaledZ - minTileZ,
                rasterOpacity === 1 ? DepthMode.ReadWrite : DepthMode.ReadOnly,
                gl.LESS);
            material.depthTest = depthMode.func !== gl.ALWAYS;
            material.depthWrite = Boolean(depthMode.mask);

            // Writes back `tile.fadeOpacity`, which later frames read. Reused
            // from `draw_raster.ts` for that reason, not for the arithmetic.
            //
            // The last argument is not decoration: under terrain
            // `getFadeProperties` returns the no-fade defaults outright, because
            // a render-pool tile is composited by the terrain mesh and must not
            // also cross-fade against its parent. Passing a hardcoded `false`
            // here was harmless while this renderer declined terrain, and became
            // **14 red terrain fixtures** the moment it stopped — every terrain
            // fixture in which Three drew raster, and no other.
            const {parentTile, parentScaleBy, parentTopLeft, fadeValues} =
                getFadeProperties(tile as never, tileManager, fadeDuration, Boolean(painter.style.map.terrain));
            tile.fadeOpacity = fadeValues.tileOpacity;

            // The `bind` calls are for their **parameter** side effect: Three
            // skips `setTextureParameters` for an external texture, so without
            // them MIN_FILTER stays at its mipmap default and an incomplete
            // texture samples as opaque black (§6.4). The active-unit calls
            // keep MapLibre's own state cache honest for when it draws next.
            context.activeTexture.set(gl.TEXTURE0);
            tile.texture.bind(textureFilter, gl.CLAMP_TO_EDGE, gl.LINEAR_MIPMAP_NEAREST);

            context.activeTexture.set(gl.TEXTURE1);
            const parent = parentTile as unknown as RasterTile | null;
            // Falls back to the tile's own texture when there is no parent, so
            // `u_image1` always samples something valid; `u_fade_t` is 0 then.
            const fadeTexture = parent?.texture ?? tile.texture;
            if (parent) parent.fadeOpacity = fadeValues.parentTileOpacity;
            fadeTexture.bind(textureFilter, gl.CLAMP_TO_EDGE, gl.LINEAR_MIPMAP_NEAREST);

            // Anisotropic filtering above a pitch threshold, kept sharp on flat
            // maps. Applied to whatever is bound on TEXTURE1 — which is the
            // tile's own texture whenever there is no parent — and gated on the
            // *tile's* `useMipmap`, both exactly as `drawRaster` does.
            //
            // Omitting this was the whole cost of this step: one fixture,
            // `raster-anisotropic-filtering/pitch-45`, and nothing else in the
            // suite or the probe could see it. A filter quality setting has no
            // failure mode louder than a slightly blurrier picture.
            if (tile.texture.useMipmap &&
                context.extTextureFilterAnisotropic &&
                transform.pitch > painter.options.anisotropicFilterPitch) {
                gl.texParameterf(
                    gl.TEXTURE_2D,
                    context.extTextureFilterAnisotropic.TEXTURE_MAX_ANISOTROPY_EXT,
                    context.extTextureFilterAnisotropicMax!);
            }

            applyRasterUniforms(material, rasterUniformValues(
                parentTopLeft, parentScaleBy, fadeValues.fadeMix, layer,
                pass.corners as never) as never);
            // Three assigns the texture units; see `raster_program.ts`.
            material.uniforms.u_image0.value = this._externalTexture(tile.texture.texture);
            material.uniforms.u_image1.value = this._externalTexture(fadeTexture.texture);
            // Two textures, so the divergence argued in `texture_bridge` is
            // reachable here too — even though the fixtures were green without
            // it, which is exactly the kind of accident this repo does not bank.
            invalidateThreeStateCache(renderer, gl);

            applyStencilMode(material, stencilModes ? stencilModes[coord.overscaledZ] : StencilMode.disabled, gl);

            const projectionData = transform.getProjectionData(
                tileProjectionOptions(coord, isRenderingToTexture, align));
            // The sphere half travels on the material, the matrix half on the
            // mesh — see `projection_globe.ts`. Both come from the same
            // `ProjectionData`, so they cannot describe different tiles.
            if (isGlobe) applyGlobeProjectionData(material, projectionData);
            applyProjectionData(this._mesh, projectionData);

            gl.depthRange(depthMode.range[0], depthMode.range[1]);
            try {
                for (let i = 0; i < buffers.segments.length; i++) {
                    buffers.bindSegment(this._geometry, i);
                    renderer.render(this._mesh, camera);
                    this.stats.drawn++;
                }
            } finally {
                gl.depthRange(0, 1);
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
            // The mercator quad is two triangles; segments carry the window.
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

/**
 * The four corners of an ordinary tile, in tile-local coordinates.
 *
 * Mirrors `cornerCoords` in `draw_raster.ts`. Only an `ImageSource` supplies
 * anything else, and it brings its own.
 */
const CORNER_COORDS: ReadonlyArray<{x: number; y: number}> = [
    {x: 0, y: 0},
    {x: EXTENT, y: 0},
    {x: EXTENT, y: EXTENT},
    {x: 0, y: EXTENT},
];
