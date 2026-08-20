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

// The bundle is loaded by a script tag (see index.html), so its export lands on
// the window rather than arriving through an import.
const gl = (window as unknown as {gtelmapsgl: typeof import('@gis/gtelmaps-gl-js')}).gtelmapsgl;

const params = new URLSearchParams(location.search);

const GLASS_COLOR = '#5aa9dd';
const EDGE_COLOR = '#8fe0ff';

/**
 * The plugin bakes `facade_material` into its GeoJSON from a hash of each
 * building's id, and `scripts/build-tiles.mjs` carries that field through, so
 * the two sides clad the same building in the same material.
 */
const FACADE_BY_MATERIAL: unknown[] = [
    'match', ['get', 'facade_material'],
    'plaster', 'facade-plaster',
    'brick', 'facade-brick',
    'block', 'facade-block',
    'wood', 'facade-wood',
    'glass', 'facade-glass',
    'facade-plaster',
];

const map = new gl.Map({
    container: 'map',
    hash: 'm',
    center: [107.1689, 10.5931],
    // Close enough that a facade reads as a facade: these are 6–18 m buildings,
    // and at district zoom the storey lines collapse into texture noise.
    zoom: 17.3,
    pitch: 62,
    bearing: -22,
    maxPitch: 85,
    style: {
        version: 8,
        // Local sprite, built by `scripts/build-sprite.mjs` from the plugin's own
        // facade textures. No glyphs: nothing here draws a symbol, and pointing
        // at a remote style server would make the demo fail for a reason that
        // has nothing to do with the layers under test.
        sprite: `${location.origin}/sprite/sprite`,
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
                id: 'atlas',
                type: 'building-atlas',
                source: 'kcn',
                'source-layer': 'building',
                layout: {visibility: 'none'},
                paint: {
                    'building-atlas-height': ['get', 'height'],
                    'building-atlas-base': ['get', 'min_height'],
                    'building-atlas-pattern': FACADE_BY_MATERIAL,
                    'building-atlas-glow-pattern': 'facade-glow',
                    'building-atlas-seed': ['get', 'seed'],
                    'building-atlas-roof-color': '#39434f',
                    'building-atlas-bay-width': ['coalesce', ['get', 'bay_width'], 6],
                    // The plugin derives storeys from `num_floors` when the
                    // source has it and from height/3.3 when it does not. Same
                    // rule, expressed as the metres-per-storey this layer
                    // consumes, so floor lines land on the storeys exactly.
                    'building-atlas-floor-height': [
                        'case',
                        ['>', ['coalesce', ['get', 'num_floors'], 0], 0],
                        ['/', ['get', 'height'], ['get', 'num_floors']],
                        3.3,
                    ],
                    'building-atlas-night': 0,
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

map.addControl(new gl.NavigationControl({visualizePitch: true}), 'top-right');

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const readout = el('readout');

function setPaint(layerId: string, prop: string, value: unknown) {
    if (!map.isStyleLoaded()) return;
    map.setPaintProperty(layerId, prop, value as any);
}

el<HTMLInputElement>('xray').addEventListener('change', (e) => {
    setPaint('glass', 'building-glass-xray', (e.target as HTMLInputElement).checked);
});
el<HTMLInputElement>('solid').addEventListener('change', (e) => {
    if (!map.isStyleLoaded()) return;
    map.setLayoutProperty('solid', 'visibility', (e.target as HTMLInputElement).checked ? 'visible' : 'none');
});

const LAYER_BY_MODE: Record<string, string> = {glass: 'glass', atlas: 'atlas'};
let pendingMode: string | null = null;

function setMode(mode: string) {
    el('atlas-controls').hidden = mode !== 'atlas';
    el('glass-controls').hidden = mode !== 'glass';
    el('mode-label').textContent = `addLayer({type:'building-${mode}'})`;

    // `setLayoutProperty` throws outright if the style has not finished loading,
    // and the controls are live from first paint. Remember the choice and apply
    // it on load rather than letting a fast click blow up the page.
    if (!map.isStyleLoaded()) {
        pendingMode = mode;
        return;
    }
    for (const [key, id] of Object.entries(LAYER_BY_MODE)) {
        map.setLayoutProperty(id, 'visibility', key === mode ? 'visible' : 'none');
    }
}

map.on('load', () => {
    if (pendingMode) {
        const mode = pendingMode;
        pendingMode = null;
        setMode(mode);
    }
});
for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="mode"]'))) {
    input.addEventListener('change', () => { if (input.checked) setMode(input.value); });
}

el<HTMLInputElement>('night').addEventListener('input', (e) => {
    setPaint('atlas', 'building-atlas-night', Number((e.target as HTMLInputElement).value));
});
el<HTMLInputElement>('bay').addEventListener('input', (e) => {
    setPaint('atlas', 'building-atlas-bay-width', Number((e.target as HTMLInputElement).value));
});
el<HTMLInputElement>('edge').addEventListener('input', (e) => {
    setPaint('glass', 'building-glass-edge-opacity', Number((e.target as HTMLInputElement).value));
});
el<HTMLInputElement>('opacity').addEventListener('input', (e) => {
    setPaint('glass', 'building-glass-opacity', Number((e.target as HTMLInputElement).value));
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
