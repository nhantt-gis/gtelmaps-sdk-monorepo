// Rebuilds the vector tiles this demo renders, from the same GeoJSON the
// 3D plugin's demo draws. Kept in the repo (rather than in a scratch directory)
// because a comparison you cannot regenerate is not a comparison.
//
//   node scripts/build-tiles.mjs [path-to-3d-plugins]
//
// Requires tippecanoe on PATH.

import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(here, '../../../../3d-plugins');
const src = resolve(pluginRoot, 'public/data/overlay/buildings.geojson');
const outDir = resolve(here, '../public/tiles');

// Only the scalar attributes the renderer reads. `floors` is a nested array of
// objects per building; tippecanoe would either drop it or stringify it into
// every tile, and nothing here consumes it.
const KEEP = ['code', 'name', 'height', 'num_floors', 'roof_type', 'roof_height',
    'bay_width', 'facade_material', 'roof_material', 'zone_code', 'subclass_code'];

/**
 * FNV-1a over the feature id, reduced to a small integer.
 *
 * `building-atlas-seed` only has to differ between neighbouring buildings, and a
 * style expression cannot hash a string — so it is baked here, the same way the
 * plugin bakes `facade_material` rather than choosing it at draw time.
 */
function seedOf(id) {
    let h = 0x811c9dc5;
    for (const ch of String(id)) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % 1024;
}

const raw = JSON.parse(readFileSync(src, 'utf8'));
const features = raw.features.map((f) => {
    const props = {};
    for (const k of KEEP) if (f.properties[k] !== undefined) props[k] = f.properties[k];
    // The renderer wants `min_height`; this dataset has no basements, so the
    // base is ground level. Stated here rather than defaulted in the shader so
    // the assumption is visible in the data contract.
    props.min_height = 0;
    props.seed = seedOf(f.properties.id ?? f.properties.code ?? '');
    return {type: 'Feature', properties: props, geometry: f.geometry};
});

const tmp = mkdtempSync(join(tmpdir(), 'parity-tiles-'));
const staged = join(tmp, 'building.geojson');
writeFileSync(staged, JSON.stringify({type: 'FeatureCollection', features}));

mkdirSync(outDir, {recursive: true});
execFileSync('tippecanoe', [
    '--output-to-directory', outDir,
    '--force',
    '--minimum-zoom', '10',
    '--maximum-zoom', '16',
    '--no-feature-limit',
    '--no-tile-size-limit',
    '--no-line-simplification',
    '--preserve-input-order',
    // A building must arrive whole in every tile it touches. `building-atlas`
    // maps one copy of the roof image across each footprint, and it can only
    // measure the footprint it is given: a building cut in half at a tile edge
    // gets two different mappings, one per half, meeting at a visible seam.
    '--no-clipping',
    // A small building must survive at every zoom rather than being merged away.
    // MapLibre stands a coarser tile in for one still loading, so the same
    // building can arrive from two zooms at once, and a copy that has been
    // reduced is measured differently — the layer then maps its roof twice.
    // Resolution still differs between zooms, so this narrows the gap rather
    // than closing it; the layer refuses the overlap itself.
    '--no-tiny-polygon-reduction',
    // Essential. tippecanoe gzips by default; a static server then serves those
    // bytes without `Content-Encoding: gzip` and the decoder reports
    // "Unimplemented type: 3" from somewhere that says nothing about compression.
    '--no-tile-compression',
    '-L', `building:${staged}`,
], {stdio: 'inherit'});

rmSync(tmp, {recursive: true, force: true});
console.log(`\n${features.length} buildings tiled into ${outDir}`);
