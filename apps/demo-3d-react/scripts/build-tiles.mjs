// Rebuilds the vector tiles and binary assets this demo renders, from the same
// GeoJSON the 3D plugin's demo draws. Kept in the repo (rather than in a scratch
// directory) because a comparison you cannot regenerate is not a comparison.
//
//   node scripts/build-tiles.mjs [--source basemap|overlay] [path-to-3d-plugins]
//
// Requires tippecanoe and sqlite3 on PATH.
//
// Two tilesets come out, and they are split by HOW OFTEN THEY CHANGE rather than
// by what they draw:
//
//   public/tiles/basemap   z8-16  what the site is       — never changes
//   public/tiles/overlay   z8-16  what is planned on it  — changes per revision
//
// That is what `--source` is for: a device changing state rebuilds `overlay` in
// under a second without touching one basemap tile.
//
// Vehicle, employee and trace feeds are NOT built here. They are mock data
// standing in for an API, and they live in `scripts/mock/` — see the header of
// `mock/build-api.mjs`. Everything in `scripts/` outside that directory produces
// what a tile server serves.
//
// Within a source the layers still need several tippecanoe runs, because
// clipping, line simplification and tiny polygon reduction are flags of a whole
// invocation and each is right for some layers and wrong for others. The runs are
// merged afterwards by concatenating the tiles that share a coordinate — see
// `mergeTilesets` in `lib/tile-postprocess.mjs`.
//
// Each merged tileset is then packed into `public/tiles/{name}.mbtiles`, next to
// the directory it came from. That archive is an ADDITION, not a replacement:
// `public/tiles/{name}/` stays, because it is what the dev server reads. The
// archive exists for a tile server to serve — one file instead of a few hundred,
// gzipped, with the tileset's own metadata inside it. Sitting under `public/` it
// is also reachable over HTTP, which is what a range-request reader would want.
//

import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {reader} from './lib/geojson.mjs';
import {PUBLIC_DIR, TILES_DIR} from './lib/paths.mjs';
import {packMbtiles} from './lib/mbtiles.mjs';
import {mergeTilesets} from './lib/tile-postprocess.mjs';
import {tile} from './lib/tippecanoe.mjs';
import {copyModels, copyTextures} from './lib/assets.mjs';
import {basemapSource, GROUND_MATERIALS} from './lib/sources/basemap.mjs';
import {overlaySource} from './lib/sources/overlay.mjs';

const SOURCES = {
    basemap: basemapSource,
    overlay: overlaySource,
};

const argv = process.argv.slice(2);
const only = [];
const rest = [];
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') only.push(argv[++i]);
    else rest.push(argv[i]);
}
for (const name of only) {
    if (!SOURCES[name]) {
        throw new Error(`unknown source "${name}"; expected one of ${Object.keys(SOURCES).join(', ')}`);
    }
}
const wanted = only.length ? only : Object.keys(SOURCES);

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = rest[0] ? resolve(rest[0]) : resolve(here, '../../../../3d-plugins');
const read = reader(resolve(pluginRoot, 'public/data'));

const staging = mkdtempSync(join(tmpdir(), 'parity-staging-'));
const describe = (counts) => Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');
const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
let features = 0;

try {
    for (const name of wanted) {
        const {runs, notes} = SOURCES[name](read);
        const outDirs = [];
        const summary = [];
        for (const run of runs) {
            const outDir = join(staging, `${name}-${run.name}`);
            const counts = tile({...run, outDir});
            outDirs.push(outDir);
            summary.push(`   ${`${run.name}:`.padEnd(12)} ${describe(counts)}`);
            features += Object.values(counts).reduce((a, b) => a + b, 0);
        }
        const tileDir = resolve(TILES_DIR, name);
        const merged = mergeTilesets(outDirs, tileDir);
        const zooms = `z${Math.min(...runs.map((r) => r.minZoom))}-${Math.max(...runs.map((r) => r.maxZoom))}`;
        console.log(`public/tiles/${name}  ${zooms}  ${merged.tiles} tiles` +
            (merged.shared ? ` (${merged.shared} carry more than one run)` : ''));
        for (const line of summary) console.log(line);
        for (const note of notes ?? []) console.log(`   ${note}`);

        const archive = packMbtiles(tileDir, resolve(TILES_DIR, `${name}.mbtiles`));
        console.log(`   ${'mbtiles:'.padEnd(12)} public/tiles/${name}.mbtiles  ${archive.tiles} tiles, ` +
            `${megabytes(archive.raw)} raw → ${megabytes(archive.packed)} gzipped, ` +
            `${megabytes(archive.bytes)} on disk`);
    }
} finally {
    rmSync(staging, {recursive: true, force: true});
}

// Written whichever source was asked for, and cheap either way: the model table
// is named by `tree` in the basemap and by `poi` in the overlay, so no one source
// owns the assets. They are here rather than in a command of their own because
// a tile refers to them BY ID — a tile without its models draws nothing.
const modelFiles = copyModels(pluginRoot, resolve(PUBLIC_DIR, 'models'));
const textureFiles = copyTextures(pluginRoot, resolve(PUBLIC_DIR, 'textures'), GROUND_MATERIALS);

console.log(`${features} features in tiles, ${modelFiles} model files and ${textureFiles} textures written into public/`);
