// One tippecanoe invocation per group of layers that can share its flags.

import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decompressTiles} from './tile-postprocess.mjs';

/**
 * The flags every group shares.
 *
 * Everything else is per group, because tippecanoe applies its flags to a whole
 * invocation — which is exactly why this demo runs it four times and merges the
 * results rather than running it once. Clipping, line simplification and tiny
 * polygon reduction are each right for some of these layers and wrong for
 * others, and none of them can be set per layer.
 */
const COMMON = [
    '--force',
    // The script prints its own summary; tippecanoe's progress meter is 40 KB of
    // carriage returns that hides the one line that matters when a run fails.
    '--quiet',
    '--no-feature-limit',
    '--no-tile-size-limit',
    '--preserve-input-order',
];

/**
 * Tile one group of layers into `outDir`.
 *
 * @param outDir - Directory to write `{z}/{x}/{y}.pbf` and `metadata.json` into.
 * @param layers - Vector layer name to the features that belong in it.
 * @param minZoom - Coarsest zoom to write.
 * @param maxZoom - Finest zoom to write.
 * @param args - The flags this group needs and the others do not.
 * @returns Feature count per layer, for the summary.
 */
export function tile({outDir, layers, minZoom, maxZoom, args = []}) {
    const tmp = mkdtempSync(join(tmpdir(), 'parity-tiles-'));
    const argv = [
        '--output-to-directory', outDir,
        '--minimum-zoom', String(minZoom),
        '--maximum-zoom', String(maxZoom),
        ...COMMON,
        ...args,
    ];

    const counts = {};
    for (const [name, features] of Object.entries(layers)) {
        const staged = join(tmp, `${name}.geojson`);
        writeFileSync(staged, JSON.stringify({type: 'FeatureCollection', features}));
        argv.push('-L', `${name}:${staged}`);
        counts[name] = features.length;
    }

    mkdirSync(outDir, {recursive: true});
    execFileSync('tippecanoe', argv, {stdio: ['ignore', 'ignore', 'inherit']});
    rmSync(tmp, {recursive: true, force: true});
    // Not a convenience: see `decompressTiles`. `--no-tile-compression` corrupts
    // every non-integer numeric attribute on tippecanoe 1.36.0.
    decompressTiles(outDir);
    return counts;
}

/**
 * Clipped polygons: the ground carpets and the planning sheets.
 *
 * Clipping is not merely allowed here but necessary. `fill-3d` anchors its UV to
 * the world, so half a polygon receives exactly the UV it should — and the worst
 * feature in this data is a road network carved with 252 holes that costs 65 ms
 * to triangulate on its own, which uncut would be paid in full by every one of
 * the twenty tiles it touches.
 *
 * `--simplify-only-low-zooms` keeps full fidelity at the maximum zoom. The
 * default simplifies everywhere, which takes a 37-point roundabout island down to
 * 19 and an 88-point lake to 31 — and because it runs on each polygon
 * independently, a kerb shared by a road and a verge is simplified two different
 * ways and a sliver of background opens between them. Below the maximum zoom the
 * tolerance scales with the tile's own resolution and is sub-pixel by
 * construction. `--no-tiny-polygon-reduction` stops a small polygon being
 * replaced by a square of the same area.
 */
export const CLIPPED_POLYGONS = ['--simplify-only-low-zooms', '--no-tiny-polygon-reduction'];

/**
 * Features kept whole, for layers that measure something ALONG the feature.
 *
 * `line-3d` and `tube-3d` interpolate `-altitude-end` and phase `-dasharray`
 * along the feature, and the bucket can only measure the part of the feature that
 * reached the tile — a clipped source restarts the ramp, and the dash pattern, at
 * every boundary. For points it does something different but just as necessary:
 * it keeps a point in the buffer zone intact so the bucket, rather than the
 * tiler, decides which tile owns it.
 */
export const WHOLE_FEATURES = ['--no-clipping', '--simplify-only-low-zooms'];

/**
 * Footprints: kept whole AND kept exact.
 *
 * `building-atlas` maps one copy of the roof image across whichever footprint it
 * is handed, so a building cut at a tile edge gets two mappings meeting at a
 * visible seam. Simplification and tiny-polygon reduction defend the same
 * measurement from the other side: MapLibre stands a coarser tile in for one
 * still loading, so the same building can arrive from two zooms at once, and a
 * copy whose outline was altered is measured differently and its roof is mapped
 * twice. Resolution still differs between zooms, so these narrow the gap rather
 * than closing it; the layer refuses the overlap itself.
 */
export const WHOLE_FOOTPRINTS = ['--no-clipping', '--no-line-simplification', '--no-tiny-polygon-reduction'];

/**
 * Encode every point, at every zoom.
 *
 * tippecanoe thins dense dots as zoom decreases, at a rate measured from the
 * MAXIMUM ZOOM of the run — so the same dataset built to z14 and to z16 carries
 * four times as many points at z14. That is a sensible default for a national
 * point set and the wrong one here: 651 devices is nothing to draw, and each one
 * can be in alarm, so a device silently absent from a zoomed-out view is a
 * missing alert rather than a saved byte.
 *
 * Measured for the 5635 trees: a z10 tile grows from 779 bytes to 149 KB, and the
 * whole tileset by about a megabyte. Both are affordable; a shifting tree density
 * that follows the maximum zoom of an unrelated layer is not.
 */
export const KEEP_EVERY_POINT = ['--drop-rate=1'];
