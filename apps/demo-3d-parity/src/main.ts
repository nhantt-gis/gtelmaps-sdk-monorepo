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
 * The plugin's 2.4× height exaggeration lives in its app config, not in its
 * library, so it is reproduced here as a style expression rather than as a layer
 * property — see `EXAGGERATION`. Two differences remain and are not defects: the
 * plugin bakes the camera into its projection matrix, and it bypasses colour
 * management entirely. Compare the *behaviour* of the effect (does the rim follow
 * the camera, does the skeleton read, are the tiers right), not pixels.
 */

// The bundle is loaded by a script tag (see index.html), so its export lands on
// the window rather than arriving through an import.
const gl = (window as unknown as {gtelmapsgl: typeof import('@gis/gtelmaps-gl-js')}).gtelmapsgl;

const params = new URLSearchParams(location.search);



/**
 * `BUILDING_EXAGGERATION` from the plugin's `config.ts`. Real heights here are
 * 6–18 m over a ~6 km site, which reads flat; the plugin scales them and so must
 * this pane, or the two are not showing the same buildings.
 */
const EXAGGERATION = 2.4;

/** Real metres from the tile, scaled the way the plugin scales them. */
const HEIGHT: unknown[] = ['*', EXAGGERATION, ['get', 'height']];

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

/**
 * The plugin's `FACADE_GLOW`. A mask says which cells of a facade are glazing,
 * so it only lines up with the window shape it was drawn for — pairing it with
 * the facade is not a nicety, it is what keeps the lit windows on the windows.
 */
const GLOW_BY_MATERIAL: unknown[] = [
    'match', ['get', 'facade_material'],
    'plaster', 'facade-glow-window1',
    'block', 'facade-glow-window1',
    'brick', 'facade-glow-window0',
    'wood', 'facade-glow-window0',
    'glass', 'facade-glow-glass',
    'facade-glow-window1',
];

const ROOF_BY_MATERIAL: unknown[] = [
    'match', ['get', 'roof_material'],
    'concrete', 'roof-concrete',
    'eternit', 'roof-eternit',
    'metal', 'roof-metal',
    'tiles', 'roof-tiles',
    'generic1', 'roof-generic1',
    'generic2', 'roof-generic2',
    'generic3', 'roof-generic3',
    'generic4', 'roof-generic4',
    'roof-concrete',
];


const map = new gl.Map({
    container: 'map',
    hash: 'm',
    // The reconciliation viewpoint. Close enough that a facade reads as a facade:
    // even exaggerated these are 14–43 m buildings, and at district zoom the
    // storey lines collapse into texture noise.
    center: [107.169352, 10.59153],
    zoom: 18.15,
    pitch: 64,
    bearing: -36.5,
    maxPitch: 85,
    canvasContextAttributes: { antialias: true },
    style: {
        version: 8,
        // Local sprite, built by `scripts/build-sprite.mjs` from the plugin's own
        // facade textures. No glyphs: nothing here draws a symbol, and pointing
        // at a remote style server would make the demo fail for a reason that
        // has nothing to do with the layers under test.
        sprite: `${location.origin}/sprite/sprite`,
        // The plugin bakes its shader light and never turns it. MapLibre's default
        // is `viewport`-anchored, which would swing the lit face round as the
        // camera rotates. `[1, 38.66, 36.99]` is `normalize(-0.4, -0.5, 0.85)`
        // from `atlasShader.ts`, carried into tile space — where +Y runs south,
        // so the middle component changes sign on the way.
        light: {
            anchor: 'map',
            position: [1, 38.66, 36.99],
            color: '#ffffff',
            intensity: 0.5,
        },
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
                    'fill-extrusion-height': HEIGHT,
                    'fill-extrusion-base': ['get', 'min_height'],
                    'fill-extrusion-opacity': 1,
                },
            },
            {
                id: 'atlas',
                type: 'building-atlas',
                source: 'kcn',
                'source-layer': 'building',
                layout: {
                    'visibility': 'none',
                    // Layout, not paint: whole window bays are baked into the
                    // tile geometry, so changing this reparses tiles.
                    'building-atlas-bay-width': ['coalesce', ['get', 'bay_width'], 6],
                },
                paint: {
                    'building-atlas-height': HEIGHT,
                    'building-atlas-base': ['get', 'min_height'],
                    'building-atlas-pattern': FACADE_BY_MATERIAL,
                    'building-atlas-glow-pattern': GLOW_BY_MATERIAL,
                    'building-atlas-roof-pattern': ROOF_BY_MATERIAL,
                    'building-atlas-seed': ['get', 'seed'],
                    // The plugin's dark-theme fallback. Every feature here shares
                    // one `subclass_code`, so its per-type table never fires and
                    // this is the colour it actually uses. Left at the spec
                    // default of white, the tint *brightens* instead, which is
                    // what was washing the facades out.
                    'building-atlas-tint': '#2b3242',
                    // The plugin derives storeys from `num_floors` where the
                    // source has it, and from height over 3.3 m where it does
                    // not. Same rule. Every feature here has the attribute, so
                    // the fallback only guards a future dataset that does not.
                    'building-atlas-num-floors': [
                        'max', 1,
                        ['round', [
                            'case',
                            ['>', ['coalesce', ['get', 'num_floors'], 0], 0],
                            ['get', 'num_floors'],
                            ['/', HEIGHT, 3.3],
                        ]],
                    ],
                    'building-atlas-night': 0,
                },
            },
            {
                id: 'glass',
                type: 'building-glass',
                source: 'kcn',
                'source-layer': 'building',
                // Colour, opacity, edge colour, edge opacity and X-ray are all
                // left unset: the spec defaults *are* the plugin's values now, so
                // stating them here would only hide a future drift between them.
                paint: {
                    'building-glass-height': HEIGHT,
                    'building-glass-base': ['get', 'min_height'],
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

// Reachable from the console and from the screenshot harness: this pane exists
// to be interrogated, and a comparison you cannot poke at is a poor comparison.
(window as unknown as {gtelmap: typeof map}).gtelmap = map;

el<HTMLInputElement>('xray').addEventListener('change', (e) => {
    setPaint('glass', 'building-glass-xray', (e.target as HTMLInputElement).checked);
});
el<HTMLInputElement>('hidden-edges').addEventListener('change', (e) => {
    setPaint('glass', 'building-glass-xray-hidden-edges', (e.target as HTMLInputElement).checked);
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
// Bay width decides geometry, so it is a layout property and moving this slider
// reparses every visible tile. The lag is the honest cost of baking whole window
// bays into the mesh, and this is the only place a user feels it.
el<HTMLInputElement>('bay').addEventListener('input', (e) => {
    if (!map.isStyleLoaded()) return;
    map.setLayoutProperty('atlas', 'building-atlas-bay-width', Number((e.target as HTMLInputElement).value));
});
el<HTMLInputElement>('edge').addEventListener('input', (e) => {
    setPaint('glass', 'building-glass-edge-opacity', Number((e.target as HTMLInputElement).value));
});
el<HTMLInputElement>('opacity').addEventListener('input', (e) => {
    setPaint('glass', 'building-glass-opacity', Number((e.target as HTMLInputElement).value));
});

// A still frame of a fresnel effect always looks plausible; only motion shows
// whether the rim actually tracks the camera — but a spinning camera also pulls
// this pane away from the reference pane, which only re-syncs on `moveend`. So
// the spin is available and off: reconciliation first, fresnel check second.
let spinning = false;
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

// Reachable from the console and from the screenshot harness.
(window as unknown as {map: unknown}).map = map;

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
