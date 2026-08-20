import {defineConfig} from 'vite';
import {resolve} from 'node:path';

const glJs = resolve(__dirname, '../../packages/gtelmaps-gl-js');

export default defineConfig({
    server: {
        port: 5180,
        // The bundle and the CSS are read straight out of the fork's `dist/`
        // rather than through the package entry: `package.json` still names
        // upstream's `dist/maplibre-gl.js`, which this fork does not build.
        fs: {allow: [resolve(__dirname, '../..'), glJs]},
    },
    resolve: {
        alias: {
            '@gl-dist': resolve(glJs, 'dist'),
        },
    },
});
