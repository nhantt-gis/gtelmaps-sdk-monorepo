// The binary assets the tiles refer to by id: glTF models and ground textures.

import {copyFileSync, mkdirSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';

const MODEL_SUFFIXES = ['.glb', '.vat.bin', '.vat.json'];

/** Every model file the style's `models` table can name. */
export function copyModels(pluginRoot, outDir) {
    mkdirSync(outDir, {recursive: true});
    const src = resolve(pluginRoot, 'public/models');
    let copied = 0;
    for (const file of readdirSync(src)) {
        if (!MODEL_SUFFIXES.some((suffix) => file.endsWith(suffix))) continue;
        copyFileSync(join(src, file), join(outDir, file));
        copied++;
    }
    return copied;
}

/**
 * The ground materials, plus the ripple normal map.
 *
 * The normal map is copied under an honest extension. `water-normals.png` in the
 * reference is a JPEG — `file` says so, and it decodes only because both of the
 * fork's image paths wrap the bytes in a Blob typed `image/png` and let the
 * browser sniff the content anyway. Renaming costs nothing and stops the next
 * person debugging a decoder that was never wrong.
 */
export function copyTextures(pluginRoot, outDir, groundMaterials) {
    mkdirSync(outDir, {recursive: true});
    for (const name of [...groundMaterials, 'grass-alpha']) {
        copyFileSync(resolve(pluginRoot, `public/textures/${name}.png`), join(outDir, `${name}.png`));
    }
    copyFileSync(resolve(pluginRoot, 'public/textures/water-normals.png'),
        join(outDir, 'water-normals.jpg'));
    return groundMaterials.length + 2;
}
