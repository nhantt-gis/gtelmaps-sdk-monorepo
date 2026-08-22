import {defineConfig} from 'vite';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

const glJs = resolve(__dirname, '../../packages/gtelmaps-gl-js');

/**
 * Answer 404 for a tile that was never generated.
 *
 * tippecanoe writes no tile where there is nothing to draw, and Vite's SPA
 * fallback hands out `index.html` with a 200 for anything it cannot find — so
 * the decoder meets HTML where it expected protobuf and reports "Unimplemented
 * type", which says nothing about the real cause. Worse, the tile then counts as
 * failed rather than empty, and MapLibre holds on to a coarser tile to cover the
 * gap: the same buildings arrive from several zooms at once, for good.
 */
const missingTilesAre404 = {
    name: 'missing-tiles-are-404',
    configureServer(server) {
        server.middlewares.use((req, res, next) => {
            const path = (req.url ?? '').split('?')[0];
            if ((path.startsWith('/tiles/') || path.startsWith('/model-tiles/')) && path.endsWith('.pbf') && !existsSync(resolve(__dirname, `public${path}`))) {
                res.statusCode = 404;
                res.end();
                return;
            }
            next();
        });
    },
};

export default defineConfig({
    plugins: [missingTilesAre404],
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
