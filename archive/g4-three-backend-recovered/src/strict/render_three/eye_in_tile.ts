import {EXTENT} from '../../data/extent';

import type {IReadonlyTransform} from '../../geo/transform_interface';
import type {OverscaledTileID} from '../../tile/tile_id';

/**
 * The camera, in the in-tile coordinates a 3D layer's vertices live in.
 *
 * ## Why this is not just `transform.cameraPosition`
 *
 * Two mismatches, and only one of them matters.
 *
 * **Space.** `cameraPosition` is in world pixels for x/y and **metres** for z —
 * the space the view-projection matrix consumes, because `pixelPerMeter` was
 * folded into its z before it was inverted. A 3D layer's vertex is
 * `(a_pos in 0..EXTENT, elevation in metres)`, so x and y need rescaling into
 * the tile's frame and z passes through untouched. That conversion is exact:
 * the test transforms the result by the tile matrix and gets the same
 * homogeneous `w` as the unconverted camera through the world matrix.
 *
 * **Precision.** `cameraPosition` is computed as `invViewProj · (0,0,-1,1)` —
 * the unprojection of the near plane's centre, not the camera. It sits on the
 * view axis, offset by the near distance, about 1.4% of the camera's height at
 * every zoom. That is *not* corrected here, deliberately: the resulting error in
 * view **direction** was measured at 0.065°–1.419°, and a fresnel term of
 * `pow(1 - |dot|, 2.4)` cannot show it. Recovering the exact eye costs a matrix
 * inversion per frame to buy an angle nobody can see. If some later effect does
 * need the exact eye — a reflection, say — build it for that effect;
 * `eye_in_tile.test.ts` carries the ray-intersection construction.
 */
export function eyeInTile(transform: IReadonlyTransform, tileID: OverscaledTileID): [number, number, number] {
    const camera = transform.cameraPosition;
    const tileWorldSize = transform.worldSize / Math.pow(2, tileID.canonical.z);
    const unitsPerWorldPixel = EXTENT / tileWorldSize;

    return [
        (camera[0] - tileID.canonical.x * tileWorldSize) * unitsPerWorldPixel,
        (camera[1] - tileID.canonical.y * tileWorldSize) * unitsPerWorldPixel,
        camera[2],
    ];
}

/**
 * How many in-tile units one metre of elevation spans.
 *
 * `eyeInTile` deliberately leaves z in metres so it stays comparable with the
 * matrix and with the shader's `elevation`. That makes the eye a **mixed-unit**
 * point, which is fine for a matrix — each axis carries its own scale — and
 * wrong for a subtraction. A view direction is a subtraction, so the fresnel
 * shader converts z with this factor before forming it. Getting this wrong does
 * not error: it tilts the rim by an amount that varies with zoom, which reads as
 * a lighting choice.
 */
export function metresToTileUnits(transform: IReadonlyTransform, tileID: OverscaledTileID): number {
    const tileWorldSize = transform.worldSize / Math.pow(2, tileID.canonical.z);
    return transform.pixelsPerMeter * EXTENT / tileWorldSize;
}
