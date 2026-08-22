// Tiles the model instances this demo places, from the same GeoJSON the 3D
// plugin's demo loads whole.
//
//   node scripts/build-model-tiles.mjs [path-to-3d-plugins]
//
// Requires tippecanoe on PATH. Also copies the .glb assets into public/models.

import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(here, '../../../../3d-plugins');
const dataDir = resolve(pluginRoot, 'public/data');
const outDir = resolve(here, '../public/model-tiles');
const modelOut = resolve(here, '../public/models');

/** The instance fields the layer reads, and nothing else. */
const KEEP = ['id', 'code', 'name', 'subclass_code', 'class_code', 'species',
    'scale', 'bearing', 'pitch', 'roll', 'height', 'altitude', 'speed_kmh'];

/** Point features only: a mover's own point is replaced by the line it follows. */

function points(file, extra = () => ({})) {
    const raw = JSON.parse(readFileSync(resolve(dataDir, file), 'utf8'));
    return raw.features
        .filter((f) => f.geometry?.type === 'Point')
        .map((f) => {
            const props = {};
            for (const k of KEEP) if (f.properties[k] !== undefined) props[k] = f.properties[k];
            Object.assign(props, extra(f));
            return {type: 'Feature', properties: props, geometry: f.geometry};
        });
}

/**
 * Longest line of a (Multi)LineString feature, followed by its own reverse.
 *
 * Out and back, so the loop closes on itself: a mover that reaches the end walks
 * home rather than teleporting to the start. The plugin's own route planner does
 * the same thing for the same reason.
 */
function outAndBack(geometry) {
    const lines = geometry.type === 'MultiLineString' ? geometry.coordinates : [geometry.coordinates];
    let best = [];
    for (const line of lines) if (line.length > best.length) best = line;
    if (best.length < 2) return null;
    return best.concat(best.slice(0, -1).reverse());
}

/**
 * One line feature per mover: the route it follows, plus how fast it goes and
 * where along it it starts.
 *
 * Deliberately one copy of the geometry each, rather than one shared route with
 * a fleet pointing at it. A tile is a self-contained thing — the bucket resamples
 * what it is given and has nowhere to keep a shared table — and 100 short lines
 * is a few tens of kilobytes.
 */
function movers(pointFile, routeFile, count) {
    const routes = JSON.parse(readFileSync(resolve(dataDir, routeFile), 'utf8')).features
        .map((f) => outAndBack(f.geometry))
        .filter(Boolean);
    if (routes.length === 0) return [];

    const source = points(pointFile).slice(0, count);
    return source.map((feature, i) => {
        const line = routes[i % routes.length];
        const length = line.reduce((sum, c, k) => k === 0 ? 0 :
            sum + Math.hypot((c[0] - line[k - 1][0]) * 109000, (c[1] - line[k - 1][1]) * 111000), 0);
        const props = {...feature.properties};
        // Spread the fleet along its route instead of stacking it at one end.
        props.route_offset = (length * ((i * 0.6180339887) % 1));
        props.route_speed = props.speed_kmh ? props.speed_kmh / 3.6 : 1.4;
        return {type: 'Feature', properties: props, geometry: {type: 'LineString', coordinates: line}};
    });
}

const layers = {
    tree: points('overlay/trees.geojson'),
    infra: points('overlay/infrastructures.geojson'),
    vehicle: movers('overlay/vehicles.geojson', 'tracing/vehicle-routes.geojson', 100),
    employee: movers('overlay/employees.geojson', 'tracing/employee-tracks.geojson', 100),
};

const tmp = mkdtempSync(join(tmpdir(), 'parity-models-'));
const args = [
    '--output-to-directory', outDir,
    '--force',
    '--minimum-zoom', '10',
    // Deliberately coarser than the building tiles. A model layer draws once per
    // (tile, model), so eighty z16 tiles would be eighty times as many calls as
    // a dozen z14 ones covering the same ground — and every one of them still
    // culls, which is the whole point of putting instances in tiles.
    '--maximum-zoom', '14',
    '--no-feature-limit',
    '--no-tile-size-limit',
    '--preserve-input-order',
    // Not optional here. A route must arrive whole in the tile that claims it,
    // and that tile is chosen by where the line STARTS — clipping would hand each
    // tile a different fragment of the same route and the mover would run off the
    // end of whichever piece it got. It also keeps a point in the buffer zone
    // intact so the bucket, rather than the tiler, decides who owns it.
    '--no-clipping',
    '--no-tile-compression',
];

for (const [name, features] of Object.entries(layers)) {
    const staged = join(tmp, `${name}.geojson`);
    writeFileSync(staged, JSON.stringify({type: 'FeatureCollection', features}));
    args.push('-L', `${name}:${staged}`);
}

mkdirSync(outDir, {recursive: true});
execFileSync('tippecanoe', args, {stdio: 'inherit'});
rmSync(tmp, {recursive: true, force: true});

mkdirSync(modelOut, {recursive: true});
const srcModels = resolve(pluginRoot, 'public/models');
let copied = 0;
for (const file of readdirSync(srcModels)) {
    if (!file.endsWith('.glb') && !file.endsWith('.vat.bin') && !file.endsWith('.vat.json')) continue;
    copyFileSync(join(srcModels, file), join(modelOut, file));
    copied++;
}

for (const [name, features] of Object.entries(layers)) {
    console.log(`  ${name}: ${features.length}`);
}
console.log(`\ntiled into ${outDir}; ${copied} model files copied into ${modelOut}`);
