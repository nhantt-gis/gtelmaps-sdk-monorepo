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

const raw = JSON.parse(readFileSync(src, 'utf8'));
const features = raw.features.map((f) => {
    const props = {};
    for (const k of KEEP) if (f.properties[k] !== undefined) props[k] = f.properties[k];
    // The renderer wants `min_height`; this dataset has no basements, so the
    // base is ground level. Stated here rather than defaulted in the shader so
    // the assumption is visible in the data contract.
    props.min_height = 0;
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
    // Essential. tippecanoe gzips by default; a static server then serves those
    // bytes without `Content-Encoding: gzip` and the decoder reports
    // "Unimplemented type: 3" from somewhere that says nothing about compression.
    '--no-tile-compression',
    '-L', `building:${staged}`,
], {stdio: 'inherit'});

rmSync(tmp, {recursive: true, force: true});
console.log(`\n${features.length} buildings tiled into ${outDir}`);
