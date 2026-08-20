/**
 * Side-by-side check for the `building-glass` layer type.
 *
 * Left: this fork, drawing `building-glass` from vector tiles through MapLibre's
 * own painter. Right (optional, `?ref=<url>`): the 3D plugin demo in an iframe,
 * for the visual comparison the acceptance gate asks for.
 *
 * The tiles under `public/tiles` are built by `scripts/build-tiles.mjs` from the
 * *same* GeoJSON the plugin demo draws (KCN Châu Đức, 372 buildings), so the two
 * panes are showing the same buildings rather than two similar-looking datasets.
 *
 * Three differences are expected and are not defects — the plugin exaggerates
 * height by 2.4×, bakes the camera into its projection matrix, and bypasses
 * colour management entirely. Compare the *behaviour* of the effect (does the
 * rim follow the camera, does the skeleton read, are the tiers right), not pixels.
 */

declare const gtelmapsgl: typeof import('@gis/gtelmaps-gl-js');

const params = new URLSearchParams(location.search);

const GLASS_COLOR = '#5aa9dd';
const EDGE_COLOR = '#8fe0ff';

const map = new gtelmapsgl.Map({
    container: 'map',
    hash: 'm',
    center: [107.1689, 10.5931],
    zoom: 15.4,
    pitch: 62,
    bearing: -22,
    maxPitch: 85,
    antialias: true,
    style: {
        version: 8,
        // No sprite and no glyphs: nothing here draws a symbol, and pointing at
        // a remote style server would make the demo fail for a reason that has
        // nothing to do with the layer under test.
        sources: {
            kcn: {
                type: 'vector',
                tiles: [`${location.origin}/tiles/{z}/{x}/{y}.pbf`],
                minzoom: 10,
                maxzoom: 16,
            },
        },
        layers: [
            {id: 'bg', type: 'background', paint: {'background-color': '#070d14'}},
            {
                // The control: the same footprints as an ordinary extrusion, so
                // "is the glass in the right place" is answerable on one screen.
                id: 'solid',
                type: 'fill-extrusion',
                source: 'kcn',
                'source-layer': 'building',
                layout: {visibility: 'none'},
                paint: {
                    'fill-extrusion-color': '#26333f',
                    'fill-extrusion-height': ['get', 'height'],
                    'fill-extrusion-base': ['get', 'min_height'],
                    'fill-extrusion-opacity': 1,
                },
            },
            {
                id: 'glass',
                type: 'building-glass',
                source: 'kcn',
                'source-layer': 'building',
                paint: {
                    'building-glass-height': ['get', 'height'],
                    'building-glass-base': ['get', 'min_height'],
                    'building-glass-color': GLASS_COLOR,
                    'building-glass-opacity': 0.06,
                    'building-glass-edge-color': EDGE_COLOR,
                    'building-glass-edge-opacity': 0.9,
                    'building-glass-xray': false,
                },
            },
        ],
    } as any,
});

map.addControl(new gtelmapsgl.NavigationControl({visualizePitch: true}), 'top-right');

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const readout = el('readout');

function setPaint(prop: string, value: unknown) {
    map.setPaintProperty('glass', prop, value as any);
}

el<HTMLInputElement>('xray').addEventListener('change', (e) => {
    setPaint('building-glass-xray', (e.target as HTMLInputElement).checked);
});
el<HTMLInputElement>('solid').addEventListener('change', (e) => {
    map.setLayoutProperty('solid', 'visibility', (e.target as HTMLInputElement).checked ? 'visible' : 'none');
});
el<HTMLInputElement>('edge').addEventListener('input', (e) => {
    setPaint('building-glass-edge-opacity', Number((e.target as HTMLInputElement).value));
});
el<HTMLInputElement>('opacity').addEventListener('input', (e) => {
    setPaint('building-glass-opacity', Number((e.target as HTMLInputElement).value));
});

// A still frame of a fresnel effect always looks plausible; only motion shows
// whether the rim actually tracks the camera. So the demo spins by default.
let spinning = true;
el<HTMLInputElement>('spin').addEventListener('change', (e) => {
    spinning = (e.target as HTMLInputElement).checked;
});
map.on('mousedown', () => { spinning = false; el<HTMLInputElement>('spin').checked = false; });

let last = performance.now();
function frame(now: number) {
    const dt = (now - last) / 1000;
    last = now;
    if (spinning && !map.isMoving()) {
        map.setBearing(map.getBearing() + dt * 6);
    }
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

map.on('render', () => {
    const c = map.getCenter();
    readout.textContent =
        `${map.getZoom().toFixed(2)}z  ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}  ` +
        `${map.getBearing().toFixed(0)}° / ${map.getPitch().toFixed(0)}°`;
});

map.on('error', (e) => {
    // Loud, because the most likely failure here is a missing tile answered with
    // index.html and a 200, which surfaces far away as a protobuf decode error.
    readout.textContent = `ERROR: ${(e as unknown as {error?: Error}).error?.message ?? e}`;
    readout.style.color = '#ff9a9a';
});

// Optional reference pane. The plugin demo keeps its camera in the URL hash as
// `#zoom/lat/lng/bearing/pitch`, so the two can be pinned to one viewpoint.
const ref = params.get('ref');
if (ref) {
    el('ref-pane').hidden = false;
    const iframe = el<HTMLIFrameElement>('ref');
    const sync = () => {
        const c = map.getCenter();
        const hash = `#${map.getZoom().toFixed(2)}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}` +
            `/${map.getBearing().toFixed(1)}/${map.getPitch().toFixed(1)}`;
        const url = ref.split('#')[0] + hash;
        el('ref-url').textContent = url;
        // Cross-origin: we can only set the whole src, and only on demand —
        // doing it every frame would reload the plugin continuously.
        iframe.src = url;
    };
    sync();
    map.on('moveend', sync);
}
