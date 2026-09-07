import {gunzipSync} from 'node:zlib';
import {readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';

/**
 * ════════════════════════════════════════════════════════════════════════
 *  tippecanoe 1.36.0 cannot be trusted with a non-integer attribute
 * ════════════════════════════════════════════════════════════════════════
 *
 * Integers survive; anything with a fractional part comes back as a denormal or
 * an astronomical number. `height: 8.5` reads as -2.7e20, `alt_end: 7.8` as
 * 5.4e-125. It had been happening quietly for a while: 69 of this demo's
 * building features and 92 of its floor plates were being drawn at absurd
 * heights, and a building 1.8e22 m tall is simply not on screen, so nothing
 * looked broken — it looked like those buildings were missing.
 *
 * Two independent triggers were reproduced:
 *
 *  - `--no-tile-compression`. Three features, one flag, everything else equal:
 *    with the flag, 8.5 becomes 1.8e28; without it, exact. Every other flag this
 *    demo passes was bisected and none of them does this.
 *  - Zoom depth, with the flag already gone. On the real building data z10 and
 *    z12 carry all fourteen heights exactly and z14 and z16 are corrupt.
 *
 * Two triggers is enough to stop looking for a third. The rule is therefore not
 * "avoid that flag" but **never hand tippecanoe a fractional number**: scale it
 * to an integer here and scale it back in the style expression.
 *
 * {@link decompressTiles} still exists because dropping the flag was correct and
 * the tiles do have to reach the browser uncompressed.
 */

/** Metres to whole centimetres. A centimetre is far below anything drawn here. */
export function centimetres(metres) {
    return Math.round((Number(metres) || 0) * 100);
}

/**
 * Decompress a tippecanoe output directory in place.
 *
 * The tiles have to reach the browser uncompressed, because a static file server
 * hands the gzipped bytes over with no `Content-Encoding` and the decoder then
 * reports "Unimplemented type: 3" from somewhere that says nothing about
 * compression. `--no-tile-compression` is the obvious way to get that and is
 * unusable — see above. So let tippecanoe compress, which is its tested path,
 * and unzip afterwards.
 */
export function decompressTiles(dir) {
    let count = 0;
    const walk = (path) => {
        for (const entry of readdirSync(path)) {
            const full = join(path, entry);
            if (statSync(full).isDirectory()) {
                walk(full);
            } else if (entry.endsWith('.pbf')) {
                const buf = readFileSync(full);
                // Idempotent: a tile that is already plain is left alone.
                if (buf[0] === 0x1f && buf[1] === 0x8b) {
                    writeFileSync(full, gunzipSync(buf));
                    count++;
                }
            }
        }
    };
    walk(dir);
    return count;
}

/**
 * Combine several tippecanoe outputs into one tileset, by concatenating the
 * tiles that share a coordinate.
 *
 * A vector tile is a protobuf whose only top-level field is `repeated Layer
 * layers = 3`, and concatenating two encoded messages of one type is defined by
 * protobuf as merging them — repeated fields append. So two tiles at the same
 * z/x/y become one tile carrying both sets of layers, byte for byte, with
 * nothing re-encoded.
 *
 * That last part is the reason this is done here rather than with `tile-join`:
 * tippecanoe 1.36.0 corrupts fractional attributes on the way out (see above),
 * and a merge that never re-encodes cannot reintroduce the bug on a second pass.
 *
 * Layer names must be unique across the inputs; a name in two of them would
 * arrive twice and the decoder would keep whichever it read last.
 */
export function mergeTilesets(inputs, outDir) {
    const names = inputs.flatMap((dir) => vectorLayerNames(dir));
    const duplicated = names.filter((n, i) => names.indexOf(n) !== i);
    if (duplicated.length) {
        throw new Error(`layer name in more than one group: ${[...new Set(duplicated)].join(', ')}`);
    }

    rmSync(outDir, {recursive: true, force: true});
    const tiles = new Map();
    for (const dir of inputs) {
        for (const rel of relativeTilePaths(dir)) {
            if (!tiles.has(rel)) tiles.set(rel, []);
            tiles.get(rel).push(readFileSync(join(dir, rel)));
        }
    }

    let shared = 0;
    for (const [rel, pieces] of tiles) {
        const target = join(outDir, rel);
        mkdirSync(dirname(target), {recursive: true});
        writeFileSync(target, pieces.length === 1 ? pieces[0] : Buffer.concat(pieces));
        if (pieces.length > 1) shared++;
    }

    writeMetadata(inputs, outDir);
    return {tiles: tiles.size, shared};
}

/** Every `{z}/{x}/{y}.pbf` in a tippecanoe output, relative to its root. */
function relativeTilePaths(dir, prefix = '') {
    const out = [];
    for (const entry of readdirSync(join(dir, prefix))) {
        const rel = prefix ? `${prefix}/${entry}` : entry;
        if (statSync(join(dir, rel)).isDirectory()) out.push(...relativeTilePaths(dir, rel));
        else if (entry.endsWith('.pbf')) out.push(rel);
    }
    return out;
}

function readMetadata(dir) {
    return JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'));
}

function vectorLayerNames(dir) {
    return JSON.parse(readMetadata(dir).json ?? '{}').vector_layers?.map((l) => l.id) ?? [];
}

/**
 * `metadata.json` for the merged set, plus the TileJSON a consumer that is not
 * this demo would ask for. The demo's own style names the tiles directly, so
 * these describe the tileset rather than drive it.
 */
function writeMetadata(inputs, outDir) {
    const parts = inputs.map(readMetadata);
    const vectorLayers = parts.flatMap((m) => JSON.parse(m.json ?? '{}').vector_layers ?? []);
    const bounds = parts
        .map((m) => m.bounds.split(',').map(Number))
        .reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
    const minzoom = Math.min(...parts.map((m) => Number(m.minzoom)));
    const maxzoom = Math.max(...parts.map((m) => Number(m.maxzoom)));
    const name = basename(outDir);

    writeFileSync(join(outDir, 'metadata.json'), `${JSON.stringify({
        ...parts[0],
        name,
        description: `${name}: ${vectorLayers.map((l) => l.id).join(', ')}`,
        minzoom: String(minzoom),
        maxzoom: String(maxzoom),
        bounds: bounds.join(','),
        json: JSON.stringify({vector_layers: vectorLayers}),
    }, null, 2)}\n`);

    writeFileSync(join(outDir, 'tiles.json'), `${JSON.stringify({
        tilejson: '3.0.0',
        name,
        scheme: 'xyz',
        format: 'pbf',
        // Rooted at the server, because `public/` is served at the origin. A
        // deployment under a sub-path has to rewrite this.
        tiles: [`/${name}/{z}/{x}/{y}.pbf`],
        minzoom,
        maxzoom,
        bounds,
        vector_layers: vectorLayers,
    }, null, 2)}\n`);
}
