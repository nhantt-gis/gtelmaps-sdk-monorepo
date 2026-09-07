import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {readFileSync, readdirSync, rmSync, mkdirSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';

/**
 * Pack a merged tile directory into one MBTiles file.
 *
 * Runs after `mergeTilesets`, never instead of it. tippecanoe can write MBTiles
 * directly, but this pipeline cannot use that: a source is several tippecanoe
 * runs whose tiles are merged by CONCATENATING the protobuf bytes, deliberately
 * without re-encoding, because tippecanoe 1.36.0 corrupts fractional attributes
 * every time it encodes (see `tile-postprocess.mjs`). So the merge has to happen
 * on uncompressed tiles on disk, and the archive is built from its result.
 *
 * `tile-join` is the obvious tool for this and is the wrong one for the same
 * reason: it decodes and re-encodes, which is exactly the pass that corrupts.
 *
 * The directory stays. It is what the dev servers read, and the two demos
 * compare against each other through it. This is an additional artefact for a
 * tile server to serve, not a replacement — it lands next to the directory in
 * `public/`, so it is reachable over HTTP too.
 *
 * Requires `sqlite3` on PATH, the same way the rest of this pipeline requires
 * `tippecanoe`.
 */

/** MBTiles 1.3. The unique index is what makes a tile lookup a lookup. */
const SCHEMA = [
    'PRAGMA journal_mode = OFF;',
    'PRAGMA synchronous = OFF;',
    'CREATE TABLE metadata (name text, value text);',
    'CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob);',
];

const INDEX = [
    'CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);',
    'CREATE UNIQUE INDEX name ON metadata (name);',
];

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Tiles are stored gzipped, which is what the MBTiles spec asks for and what
 * tippecanoe itself writes. `decompressTiles` undoes that on the way out of
 * tippecanoe because the merge needs raw protobuf and because a plain static
 * file server hands gzipped bytes over with no `Content-Encoding`; a tile server
 * reading this archive has no such problem and sets the header.
 */
function tileRows(dir) {
    const rows = [];
    let raw = 0;
    let packed = 0;

    for (const z of readdirSync(dir)) {
        if (!/^\d+$/.test(z)) continue;
        for (const x of readdirSync(join(dir, z))) {
            for (const file of readdirSync(join(dir, z, x))) {
                if (!file.endsWith('.pbf')) continue;
                const y = Number(file.slice(0, -4));
                // MBTiles addresses rows in TMS, bottom-up; the directory is XYZ.
                const row = 2 ** Number(z) - 1 - y;
                const bytes = readFileSync(join(dir, z, x, file));
                const gzipped = gzipSync(bytes, {level: 9});
                raw += bytes.length;
                packed += gzipped.length;
                rows.push(`INSERT INTO tiles VALUES (${z},${x},${row},X'${gzipped.toString('hex')}');`);
            }
        }
    }

    return {rows, raw, packed};
}

/**
 * Everything tippecanoe wrote about the tileset, carried across as-is.
 *
 * `json` holds `vector_layers`, and that is the half a client actually needs:
 * it is what a TileJSON response is built from. Copying the whole table rather
 * than a chosen subset means a field added upstream arrives here for free.
 */
function metadataRows(dir) {
    const table = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'));
    return Object.entries(table).map(([key, value]) =>
        `INSERT INTO metadata VALUES (${quote(key)},${quote(value)});`);
}

/**
 * @param tileDir - A merged tileset: `{z}/{x}/{y}.pbf` plus `metadata.json`.
 * @param outFile - Path to write. Replaced if it exists — appending to an
 *                  existing archive would leave two rows per tile, and the
 *                  unique index would fail the whole transaction.
 * @returns Tile count and byte sizes, for the caller's summary line.
 */
export function packMbtiles(tileDir, outFile) {
    const {rows, raw, packed} = tileRows(tileDir);
    if (rows.length === 0) throw new Error(`no tiles under ${tileDir}`);

    rmSync(outFile, {force: true});
    mkdirSync(dirname(outFile), {recursive: true});

    const sql = [...SCHEMA, ...metadataRows(tileDir), 'BEGIN;', ...rows, 'COMMIT;', ...INDEX].join('\n');
    execFileSync('sqlite3', [outFile], {input: sql, stdio: ['pipe', 'ignore', 'inherit']});

    // Read the count back out rather than trusting the write. A tile that fails
    // to insert takes the transaction with it, but a silent schema mismatch
    // would not, and this is one query.
    const stored = Number(execFileSync('sqlite3', [outFile, 'SELECT count(*) FROM tiles;'], {encoding: 'utf8'}).trim());
    if (stored !== rows.length) {
        throw new Error(`${outFile}: wrote ${rows.length} tiles, read back ${stored}`);
    }

    return {tiles: stored, raw, packed, bytes: statSync(outFile).size};
}
