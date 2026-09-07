// The overlay source: what is PLANNED for the site, and the assets on it whose
// state changes. Every project has a different set of these, and they are rebuilt
// far more often than the basemap — which is the whole reason they are a tileset
// of their own. `node scripts/build-tiles.mjs --source overlay` rebuilds this
// without touching a single basemap tile.
//
// What is NOT here: anything that moves. Vehicle and employee movements are
// queried from an API as GeoJSON and added with `map.addLayer` at runtime, so
// they must not be baked into the base map's style at all. See `lib/movers.mjs`.

import {splitToTileBudget} from '../tile-span.mjs';
import {lines, parts, pick, points, polygons} from '../geojson.mjs';
import {centimetres} from '../tile-postprocess.mjs';
import {CLIPPED_POLYGONS, KEEP_EVERY_POINT, WHOLE_FEATURES} from '../tippecanoe.mjs';
import {GROUND_MIN_ZOOM, MAX_ZOOM, RAISED_MIN_ZOOM} from '../zoom.mjs';

/**
 * The three translucent sheets the plugin stacks on top of the ground.
 *
 * One vector layer each rather than one layer discriminated by a `kind`
 * attribute: they are three different datasets that happen to be drawn the same
 * way, and a style that wants only one of them should not have to filter a layer
 * carrying the other two through every tile.
 */
const PARCEL_SETS = [
    ['planned_landuse', 'planning/planned_landuses.geojson', '#7c3aed'],
    ['planned_parcel', 'planning/land_plots.geojson', '#aac6da'],
    ['cadastral_parcel', 'base/company_parcels.geojson', '#f59e0b'],
];

const PARCEL_KEEP = ['id', 'code', 'name', 'status', 'investor_name', 'tax_code', 'max_floors'];

/**
 * The instance fields a `model-3d`, `label-3d` or `alert-3d` layer reads off a
 * device.
 *
 * `status` is why this dataset sits in `project` rather than in the basemap. The
 * geometry — 310 street lights, 247 power poles, 62 hydrants, 32 cameras — is as
 * static as a building; the state is not. And it cannot be moved out to
 * `map.setFeatureState`, because a MapLibre `filter` expression cannot read
 * feature state, and the `alerts` layer is exactly a filter on `status`.
 */
const POI_KEEP = ['id', 'code', 'name', 'subclass_code', 'class_code',
    'scale', 'bearing', 'pitch', 'roll', 'altitude', 'status'];

export function overlaySource(read) {
    const parcels = {};
    for (const [layer, file, fallback] of PARCEL_SETS) {
        parcels[layer] = polygons(read(file)).map((f) => ({
            type: 'Feature',
            properties: {
                // `max_floors` is carried for the `wall-3d` layer, which drives a
                // curtain's height from it. Only `planned_landuse` has it; the
                // other two sets leave it undefined and the style coalesces.
                ...pick(f.properties, PARCEL_KEEP),
                color: f.properties.color ?? fallback,
            },
            geometry: f.geometry,
        }));
    }

    const poi = points(read('overlay/infrastructures.geojson')).map((f) => ({
        type: 'Feature',
        properties: {...pick(f.properties, POI_KEEP), height_cm: centimetres(f.properties.height)},
        geometry: f.geometry,
    }));

    let splitCount = 0;
    /**
     * Power, camera cable and water supply, in one layer.
     *
     * The plugin needs three groups for these because its material holds one
     * colour for the whole group — `onWrite` reads `entities[0]` and the last
     * write wins. `tube-3d-color` and `-radius` are data-driven, so the three
     * become one layer and one draw call per tile.
     *
     * `height` is signed in the source: +19 m for power, +18 m for camera cable,
     * −10 m for water supply. It goes straight into `tube-3d-altitude`.
     */
    const network = lines(read('overlay/infrastructure_networks.geojson'))
        .flatMap((f) => parts(f).flatMap((part) => {
            const pieces = splitToTileBudget(part, MAX_ZOOM);
            if (pieces.length > 1) splitCount++;
            return pieces.map((piece) => ({
                type: 'Feature',
                properties: pick(f.properties, ['id', 'name', 'subclass_code', 'height', 'zone_code']),
                geometry: {type: 'LineString', coordinates: piece},
            }));
        }));

    return {
        runs: [
            {
                name: 'parcels',
                layers: parcels,
                minZoom: GROUND_MIN_ZOOM,
                maxZoom: MAX_ZOOM,
                args: CLIPPED_POLYGONS,
            },
            {
                name: 'assets',
                layers: {poi, network},
                minZoom: RAISED_MIN_ZOOM,
                maxZoom: MAX_ZOOM,
                args: [...WHOLE_FEATURES, ...KEEP_EVERY_POINT],
            },
        ],
        notes: [`${splitCount} utility runs were too long for the tile coordinate budget and were split`],
    };
}
