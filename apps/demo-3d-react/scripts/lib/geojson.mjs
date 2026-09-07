// Readers shared by every layer module, over the 3D plugin's own GeoJSON.

import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

/** A reader bound to the plugin's `public/data` directory. */
export function reader(dataDir) {
    return (rel) => JSON.parse(readFileSync(resolve(dataDir, rel), 'utf8'));
}

/** Only polygons. A stray point or line in a surface dataset draws nothing. */
export const polygons = (fc) => fc.features.filter(
    (f) => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'));

/** Only lines. A stray point or polygon in a line dataset draws nothing. */
export const lines = (fc) => fc.features.filter(
    (f) => f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString'));

/** Only points: a mover's own point is replaced by the line it follows. */
export const points = (fc) => fc.features.filter((f) => f.geometry?.type === 'Point');

/** Every part of a line feature, as plain coordinate arrays. */
export function parts(feature) {
    const {type, coordinates} = feature.geometry;
    const all = type === 'LineString' ? [coordinates] : coordinates;
    // One `water_supply_network` feature carries `coordinates: []`. The plugin
    // filters it out without a word; so does this, but on purpose.
    return all.filter((part) => Array.isArray(part) && part.length >= 2);
}

/** The named properties that are actually present. */
export function pick(props, keys) {
    const out = {};
    for (const k of keys) if (props[k] !== undefined && props[k] !== null) out[k] = props[k];
    return out;
}
