// Assembles the sprite this demo styles with, out of the same facade textures
// the 3D plugin uses. Kept in the repo for the same reason as build-tiles.mjs:
// a comparison you cannot regenerate is not a comparison.
//
//   node scripts/build-sprite.mjs [path-to-3d-plugins]

import {PNG} from 'pngjs';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '../../../../3d-plugins');
const facades = resolve(pluginRoot, 'public/textures/buildings/facades');
const outDir = resolve(here, '../public/sprite');

// Downscaled from the source 512²: a facade tile is repeated once per window bay,
// so it is never magnified, and 128² keeps the whole sheet inside one modest
// texture. Still a power of two, which `mod()` tiling wants.
const CELL = 128;

// The plugin picks a facade per building from a hash of its id, baked into the
// GeoJSON as `facade_material`. The same five materials appear here under names
// the style refers to.
const FACADES = ['plaster', 'brick', 'block', 'wood', 'glass'];
const FILE = {
    plaster: 'plaster_window_diffuse.png',
    brick: 'brick_window_diffuse.png',
    block: 'block_window_diffuse.png',
    wood: 'wood_window_diffuse.png',
    glass: 'glass_diffuse.png',
};

// One mask for the whole layer, not one per facade. The plugin can afford a
// per-facade glow layer because it uses a texture array; here the mask is a
// layer constant (see `building-atlas-glow-pattern`), so this is the closest
// single choice — it is the mask the plugin pairs with plaster and block, the
// two most common materials in this dataset.
const GLOW = 'window1_glow.png';

function load(name) {
    return PNG.sync.read(readFileSync(resolve(facades, name)));
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

function paste(sheet, img, ox, opaque) {
    for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
            const i = (y * img.width + x) << 2;
            const o = (y * sheet.width + (x + ox)) << 2;
            sheet.data[o] = img.data[i];
            sheet.data[o + 1] = img.data[i + 1];
            sheet.data[o + 2] = img.data[i + 2];
            // Forced opaque. The per-tile atlas stores premultiplied alpha, so a
            // facade pixel with alpha 0 would lose its colour outright — and
            // several of these source images carry an alpha channel that was
            // never meant to be read as transparency.
            sheet.data[o + 3] = opaque ? 255 : img.data[i + 3];
        }
    }
}

const ids = [...FACADES, 'glow'];
const sheet = new PNG({width: CELL * ids.length, height: CELL});
const index = {};

ids.forEach((id, i) => {
    const file = id === 'glow' ? GLOW : FILE[id];
    paste(sheet, downscale(load(file), CELL), i * CELL, true);
    index[id === 'glow' ? 'facade-glow' : `facade-${id}`] =
        {x: i * CELL, y: 0, width: CELL, height: CELL, pixelRatio: 1};
});

mkdirSync(outDir, {recursive: true});
writeFileSync(resolve(outDir, 'sprite.png'), PNG.sync.write(sheet));
writeFileSync(resolve(outDir, 'sprite.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`sprite: ${ids.length} images at ${CELL}px into ${outDir}`);
