import {Matrix4} from 'three';

import type {Camera, Object3D} from 'three';
import type {ProjectionData} from '../../geo/projection/projection_data';
import type {OverscaledTileID} from '../../tile/tile_id';

/**
 * Makes a Three.js mesh whose vertices are in MapLibre tile coordinates land on
 * exactly the pixels MapLibre would have put it on.
 *
 * ## The problem
 *
 * MapLibre's tile geometry lives in in-tile coordinates, `0..EXTENT`, and every
 * draw call carries a `ProjectionData` whose `mainMatrix` takes those straight
 * to clip space — one matrix covering the tile's position, the map's zoom, the
 * pitch, the globe transition and the terrain offset all at once. Three.js
 * instead splits the same job in two, `projectionMatrix * modelViewMatrix`, and
 * recomputes both from a camera and a scene graph it owns.
 *
 * Nothing about a map's transform decomposes cleanly into Three's camera model.
 * The globe projection in particular is not a perspective camera looking at a
 * scene; it is a shader that bends a unit sphere. Trying to reconstruct a
 * `PerspectiveCamera` that reproduces `mainMatrix` would be an approximation,
 * and approximations do not survive a 1560-fixture pixel comparison.
 *
 * ## The approach: give Three the matrix, not the camera
 *
 * The identity is arranged so that Three's own multiplication reproduces
 * `mainMatrix` exactly:
 *
 * ```
 * projectionMatrix     := identity
 * matrixWorldInverse   := identity
 * mesh.matrixWorld     := mainMatrix
 *
 * gl_Position = projectionMatrix * modelViewMatrix * position
 *             = I * (matrixWorldInverse * matrixWorld) * position
 *             = mainMatrix * position                          ✔
 * ```
 *
 * So Three's transform stack is not fought or bypassed — it is fed values that
 * make it agree with MapLibre by construction. Standard Three materials keep
 * working, because they see an ordinary `modelViewMatrix` and
 * `projectionMatrix`.
 *
 * The cost is stated rather than hidden: with an identity projection and a
 * per-object matrix carrying everything, **Three's frustum culling is
 * meaningless** — every object's bounding sphere lands in the same place. Culling
 * has to come from MapLibre's `coveringTiles`, which is where it comes from
 * today anyway. `frustumCulled = false` is therefore set here deliberately, not
 * as a workaround.
 *
 * ## What this does not solve
 *
 * `mainMatrix` is float32 by the time it reaches here, and it folds in the
 * tile's world position. That is fine at the zoom levels the 2D fixtures cover
 * and is exactly what MapLibre does — matching it is the point. It is *not* the
 * RTC scheme the architecture spec §5.1 requires for 100 km sightlines, which
 * needs the camera-relative subtraction to happen in float64 before any matrix
 * is built. The two coexist: 2D layers ported through here keep MapLibre's
 * precision behaviour exactly, and the 3D tiers get their own path. Do not
 * extend this function into the 3D path — see `apps/spike-g0-precision`.
 */

const IDENTITY = new Matrix4();

/**
 * Points `camera` at clip space directly, so that per-object matrices carry the
 * whole transform.
 *
 * Call once per frame before rendering ported layers. Cheap: it assigns two
 * identity matrices and disables the auto-update that would overwrite them.
 */
export function useMapLibreProjection(camera: Camera): void {
    // Three recomputes both of these from camera position/fov on every render
    // unless told not to.
    camera.matrixAutoUpdate = false;
    camera.matrixWorldAutoUpdate = false;

    camera.projectionMatrix.copy(IDENTITY);
    camera.projectionMatrixInverse.copy(IDENTITY);
    camera.matrix.copy(IDENTITY);
    camera.matrixWorld.copy(IDENTITY);
    camera.matrixWorldInverse.copy(IDENTITY);
}

/**
 * Puts a tile-space mesh where `data` says it goes.
 *
 * `object` is expected to hold geometry in in-tile coordinates (`0..EXTENT`),
 * the same arrays MapLibre's buckets already produce.
 */
export function applyProjectionData(object: Object3D, data: ProjectionData): void {
    // Three would otherwise recompute matrixWorld from position/quaternion/scale
    // and discard what is set below.
    object.matrixAutoUpdate = false;
    object.matrixWorldAutoUpdate = false;

    object.matrix.fromArray(data.mainMatrix as unknown as ArrayLike<number>);
    object.matrixWorld.copy(object.matrix);

    // See the header: with an identity projection every bounding sphere collides,
    // so Three's culling would be arbitrary. MapLibre's coveringTiles decides
    // visibility.
    object.frustumCulled = false;
}

/**
 * The projection options for one tile, as MapLibre's own draw functions ask for
 * them.
 *
 * The only variable is `applyGlobeMatrix`, and it is **false inside a terrain
 * render target**. Every `drawX` upstream writes it as `!isRenderingToTexture`,
 * for a reason worth stating rather than copying: a render-pool object holds one
 * terrain tile drawn flat, in its own tile space. Bending it onto the globe
 * there would apply the sphere twice — once into the texture and once again when
 * `drawTerrain` places that texture on the mesh.
 *
 * Written as a helper because it is the same three lines at eleven call sites
 * across six renderers, and the eleventh one getting `true` is not something any
 * gate would report as "globe applied twice"; it would report a shifted fill.
 */
export function tileProjectionOptions(
    overscaledTileID: OverscaledTileID,
    isRenderingToTexture: boolean,
    /** Texture-sampling alignment, which only the raster-family layers pass. */
    aligned?: boolean,
): {
    overscaledTileID: OverscaledTileID;
    applyGlobeMatrix: boolean;
    applyTerrainMatrix: boolean;
    aligned?: boolean;
} {
    return {
        overscaledTileID,
        applyGlobeMatrix: !isRenderingToTexture,
        applyTerrainMatrix: true,
        aligned,
    };
}
