// The static source: what the site IS, as opposed to what is planned for it or
// what is moving around on it. Nothing here changes between revisions of a
// project, so it is the one tileset a second project could share.
//
// Eight canonical layers — boundary, landcover, landuse, water, road, building,
// tree, poi — of which this dataset fills seven. `poi` is empty here because the
// only POI dataset in the reference data carries a live `status`, which puts it
// in `project` instead; the slot stays part of the contract.

import {centimetres} from '../tile-postprocess.mjs';
import {splitToTileBudget} from '../tile-span.mjs';
import {lines, parts, pick, points, polygons} from '../geojson.mjs';
import {CLIPPED_POLYGONS, KEEP_EVERY_POINT, WHOLE_FEATURES, WHOLE_FOOTPRINTS} from '../tippecanoe.mjs';
import {GROUND_MIN_ZOOM, MAX_ZOOM, RAISED_MIN_ZOOM} from '../zoom.mjs';

/**
 * Ground materials, in the order they are stacked into the layer's texture
 * array. `fill-3d-texture-index` is a position in this list, so the order is part
 * of the data contract and has to match `MATERIALS` in `src/main.ts`.
 */
export const GROUND_MATERIALS = ['concrete-alpha', 'road-asphalt', 'industrial-ground', 'soil-alpha'];

/**
 * The reference implementation's own mapping, from `config.ts:108-131`. It reads
 * `class_code`/`subclass_code` and ignores the `textureUrl` the data carries — so
 * this does the same, rather than quietly diverging on 1 of 239 features.
 */
function groundMaterial(p) {
    if (p.class_code === 'road') return 'road-asphalt';
    switch (String(p.subclass_code)) {
        case 'internal_roads': case 'parking': case 'driveway': return 'road-asphalt';
        case 'sidewalk': case 'yard': case 'plaza': return 'concrete-alpha';
        case 'industrial': case 'hardstand': return 'industrial-ground';
        case 'soil': case 'bare': return 'soil-alpha';
        default: return 'concrete-alpha';
    }
}

// Only the scalar attributes the renderer reads. `floors` is a nested array of
// objects per building; tippecanoe would either drop it or stringify it into
// every tile, and nothing here consumes it.
const BUILDING_KEEP = ['code', 'name', 'height', 'num_floors', 'roof_type', 'roof_height',
    'bay_width', 'facade_material', 'roof_material', 'zone_code', 'subclass_code'];

/** The instance fields a `model-3d` layer reads off a tree, and nothing else. */
const TREE_KEEP = ['id', 'code', 'name', 'subclass_code', 'class_code', 'species',
    'scale', 'bearing', 'pitch', 'roll', 'altitude'];

/**
 * FNV-1a over the feature id, reduced to a small integer.
 *
 * `building-atlas-seed` only has to differ between neighbouring buildings, and a
 * style expression cannot hash a string — so it is baked here, the same way the
 * plugin bakes `facade_material` rather than choosing it at draw time.
 */
function seedOf(id) {
    let h = 0x811c9dc5;
    for (const ch of String(id)) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % 1024;
}

export function basemapSource(read) {
    /**
     * The estate outline and its five sub-areas, in one layer.
     *
     * One layer rather than two because they are the same kind of thing at two
     * levels, and `subclass_code` already says which: `zone` for the outline,
     * `subzone` for a part of it. `parent_id` on a subzone points at the zone, so
     * a style that wants a hierarchy has it without a second source-layer.
     */
    const boundary = [
        ...polygons(read('base/zones.geojson')),
        ...polygons(read('base/subzones.geojson')),
    ].map((f) => ({
        type: 'Feature',
        properties: pick(f.properties, ['id', 'code', 'name', 'subclass_code', 'zone_code', 'parent_id']),
        geometry: f.geometry,
    }));

    /**
     * Vegetated ground. Its own layer rather than a flag on `landuse`, because
     * the texture period differs — 28 m here against 42 m there — and that period
     * has to be constant across a layer for the UV grid to stay one global affine
     * function of Mercator coordinates.
     */
    const landcover = polygons(read('base/grasses.geojson')).map((f) => ({
        type: 'Feature',
        properties: pick(f.properties, ['id', 'code', 'name', 'subclass_code']),
        geometry: f.geometry,
    }));

    /** Paved and bare ground: four materials, one layer, one draw call per tile. */
    const landuse = polygons(read('base/landuses.geojson')).map((f) => ({
        type: 'Feature',
        properties: {
            ...pick(f.properties, ['id', 'code', 'name', 'class_code', 'subclass_code', 'surface']),
            material: groundMaterial(f.properties),
        },
        geometry: f.geometry,
    }));

    /**
     * The 44 bodies of water the reference implementation draws — golf course
     * lakes, the Soai river, and the estate's own channels.
     *
     * Nothing is derived here: `water-3d` reads its two colours and its opacity
     * from the style and the ripple field from the world, so a water feature
     * carries no rendering hints at all. The reference is the same in that
     * respect, and worse in another: its shader reads neither the per-vertex
     * colour nor the per-vertex opacity, so it cannot tint or hide one lake even
     * if the data asked it to. `name` and `subclass_code` are kept so a click can
     * answer with something.
     */
    const water = polygons(read('base/waters.geojson')).map((f) => ({
        type: 'Feature',
        properties: pick(f.properties, ['id', 'code', 'name', 'subclass_code', 'zone_code']),
        geometry: f.geometry,
    }));

    let splitCount = 0;
    /**
     * The road network as real surfaces, which the plugin cannot draw at all.
     *
     * Its own carpet dataset has 238 pavement polygons and exactly one road
     * polygon, so the roadway there is the gap between the kerbs; the centrelines
     * are used only for 0.7 m lane markings. Every one of these 888 features
     * carries `width: 12`, which `stack.ts` never reads — `widthMeters` is a
     * constant in the layer config. Here it is a data-driven paint property, so
     * one layer paints the whole network at its real width.
     *
     * Split to the tile coordinate budget first: `--no-clipping` is what lets
     * `line-3d-dasharray` phase along the whole feature, and the price is that a
     * run wider than one tile has to be cut anyway. See `tile-span.mjs`.
     */
    const road = lines(read('base/roads.geojson')).flatMap((f) => parts(f).flatMap((part) => {
        const pieces = splitToTileBudget(part, MAX_ZOOM);
        if (pieces.length > 1) splitCount++;
        return pieces.map((piece) => ({
            type: 'Feature',
            properties: pick(f.properties, ['id', 'name', 'code', 'width', 'surface', 'subclass_code']),
            geometry: {type: 'LineString', coordinates: piece},
        }));
    }));

    const building = read('overlay/buildings.geojson').features.map((f) => {
        const props = pick(f.properties, BUILDING_KEEP);
        // The renderer wants `min_height`; this dataset has no basements, so the
        // base is ground level. Stated here rather than defaulted in the shader
        // so the assumption is visible in the data contract.
        props.min_height = 0;
        // Whole centimetres, because 61 of these buildings have a fractional
        // height and tippecanoe corrupts every one. See `tile-postprocess.mjs`.
        props.height_cm = centimetres(props.height);
        delete props.height;
        props.seed = seedOf(f.properties.id ?? f.properties.code ?? '');
        return {type: 'Feature', properties: props, geometry: f.geometry};
    });

    const tree = points(read('overlay/trees.geojson')).map((f) => ({
        type: 'Feature',
        properties: {...pick(f.properties, TREE_KEEP), height_cm: centimetres(f.properties.height)},
        geometry: f.geometry,
    }));

    return {
        runs: [
            {
                name: 'carpets',
                layers: {boundary, landcover, landuse, water},
                minZoom: GROUND_MIN_ZOOM,
                maxZoom: MAX_ZOOM,
                args: CLIPPED_POLYGONS,
            },
            {
                name: 'footprints',
                layers: {building},
                minZoom: RAISED_MIN_ZOOM,
                maxZoom: MAX_ZOOM,
                args: WHOLE_FOOTPRINTS,
            },
            {
                name: 'whole',
                layers: {road, tree},
                minZoom: RAISED_MIN_ZOOM,
                maxZoom: MAX_ZOOM,
                args: [...WHOLE_FEATURES, ...KEEP_EVERY_POINT],
            },
        ],
        notes: [`${splitCount} road runs were too long for the tile coordinate budget and were split`],
    };
}
