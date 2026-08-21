// Assembles the sprite this demo styles with, out of the same facade and roof
// textures the 3D plugin uses. Kept in the repo for the same reason as
// build-tiles.mjs: a comparison you cannot regenerate is not a comparison.
//
//   node scripts/build-sprite.mjs [path-to-3d-plugins]

import {PNG} from 'pngjs';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '../../../../3d-plugins');
const textures = resolve(pluginRoot, 'public/textures/buildings');
const outDir = resolve(here, '../public/sprite');

// The size the plugin itself uploads (`textureArray.ts`, `size: 256`), from the
// same 512² sources. Matching it matters: at the reconciliation zoom a window
// bay covers more screen pixels than the cell has texels, so the facade is being
// *magnified*, and cell resolution is what the eye reads as sharpness.
const CELL = 256;
// 16 cells; a square grid keeps the sheet at 1024² rather than a 4096×256 strip.
const COLUMNS = 4;

// The plugin picks a facade per building from a hash of its id, baked into the
// GeoJSON as `facade_material`. The same five materials appear here under names
// the style refers to.
const FACADES = {
    plaster: 'facades/plaster_window_diffuse.png',
    brick: 'facades/brick_window_diffuse.png',
    block: 'facades/block_window_diffuse.png',
    wood: 'facades/wood_window_diffuse.png',
    glass: 'facades/glass_diffuse.png',
};

// A glow mask marks which cells of a facade are glazing, so it only lines up
// with the facade whose window shape it was drawn for. The plugin's pairing
// (`FACADE_GLOW` in its config) is reproduced by the style; all three masks it
// draws from are packed here.
const GLOWS = {
    window0: 'facades/window0_glow.png',
    window1: 'facades/window1_glow.png',
    glass: 'facades/glass_glow.png',
};

// The eight `roof_material` values this dataset actually uses.
const ROOFS = {
    concrete: 'roofs/concrete_diffuse.png',
    eternit: 'roofs/eternit_diffuse.png',
    metal: 'roofs/metal_diffuse.png',
    tiles: 'roofs/tiles_diffuse.png',
    generic1: 'roofs/generic1_diffuse.png',
    generic2: 'roofs/generic2_diffuse.png',
    generic3: 'roofs/generic3_diffuse.png',
    generic4: 'roofs/generic4_diffuse.png',
};

const CELLS = [
    ...Object.entries(FACADES).map(([k, f]) => [`facade-${k}`, f]),
    ...Object.entries(GLOWS).map(([k, f]) => [`facade-glow-${k}`, f]),
    ...Object.entries(ROOFS).map(([k, f]) => [`roof-${k}`, f]),
];

function load(name) {
    return PNG.sync.read(readFileSync(resolve(textures, name)));
}

/** Box-filter downscale. Nearest sampling shimmers badly once a facade tiles. */
function downscale(src, size) {
    const out = new PNG({width: size, height: size});
    const fx = src.width / size, fy = src.height / size;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let sy = Math.floor(y * fy); sy < Math.floor((y + 1) * fy); sy++) {
                for (let sx = Math.floor(x * fx); sx < Math.floor((x + 1) * fx); sx++) {
                    const i = (sy * src.width + sx) << 2;
                    r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; a += src.data[i + 3]; n++;
                }
            }
            const o = (y * size + x) << 2;
            out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = a / n;
        }
    }
    return out;
}

function paste(sheet, img, ox, oy) {
    for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
            const i = (y * img.width + x) << 2;
            const o = ((y + oy) * sheet.width + (x + ox)) << 2;
            sheet.data[o] = img.data[i];
            sheet.data[o + 1] = img.data[i + 1];
            sheet.data[o + 2] = img.data[i + 2];
            // Forced opaque. The per-tile atlas stores premultiplied alpha, so a
            // pixel with alpha 0 would lose its colour outright — and several of
            // these source images carry an alpha channel that was never meant to
            // be read as transparency.
            sheet.data[o + 3] = 255;
        }
    }
}

const rows = Math.ceil(CELLS.length / COLUMNS);
const sheet = new PNG({width: CELL * COLUMNS, height: CELL * rows});
const index = {};

CELLS.forEach(([id, file], i) => {
    const x = (i % COLUMNS) * CELL;
    const y = Math.floor(i / COLUMNS) * CELL;
    paste(sheet, downscale(load(file), CELL), x, y);
    index[id] = {x, y, width: CELL, height: CELL, pixelRatio: 1};
});

mkdirSync(outDir, {recursive: true});
writeFileSync(resolve(outDir, 'sprite.png'), PNG.sync.write(sheet));
writeFileSync(resolve(outDir, 'sprite.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`sprite: ${CELLS.length} images at ${CELL}px (${sheet.width}×${sheet.height}) into ${outDir}`);
