// Keeping a run short enough that MapLibre's tile coordinates can hold it.
//
// `--no-clipping` hands every tile the whole feature, which is what makes
// `line-3d-altitude-end` and `line-3d-dasharray` measure along the feature
// rather than along whatever survived a cut. It also means the tile at one end
// of a long run carries vertices belonging to the other end, and there is a hard
// ceiling on how far those may sit: `load_geometry.ts` scales tile coordinates
// to EXTENT 8192 and clamps them to ±16383, two tile widths. A vertex past that
// is not dropped — it is pinned to the boundary, so the run acquires a dead
// straight leg to a place it never went, and the only sign is one
// `Geometry exceeds allowed extent` in the console.
//
// A run emitted into the tile containing one of its ends reaches (span + 1)
// tiles from that tile's origin, so the safe span is one tile, not two.

/** Span allowed per run, in tiles. One tile plus the `+ 1` above, less a margin. */
const DEFAULT_BUDGET_TILES = 0.9;

const project = (lng, lat, n) => {
    const sin = Math.sin(lat * Math.PI / 180);
    return [
        (lng + 180) / 360 * n,
        (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n,
    ];
};

const unproject = ([x, y], n) => [
    x / n * 360 - 180,
    180 / Math.PI * Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))),
];

/** The wider of the two axes, which is what the clamp measures. */
const box = (points) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of points) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return Math.max(maxX - minX, maxY - minY);
};

/**
 * Split one run into pieces that each fit the budget, in tile units at
 * `maxZoom`. Consecutive pieces share their joining vertex, so the geometry is
 * unchanged; what restarts at a join is anything measured **along the feature** —
 * an altitude ramp, a dash phase. Callers that carry either should check whether
 * a split actually happened.
 *
 * A single segment can be longer than the budget on its own — the reference
 * data has a 2.6 km camera cable with two vertices — so segments are divided
 * before the run is chunked.
 */
export function splitToTileBudget(coordinates, maxZoom, budgetTiles = DEFAULT_BUDGET_TILES) {
    const n = 2 ** maxZoom;
    const projected = coordinates.map(([lng, lat]) => project(lng, lat, n));

    const dense = [projected[0]];
    for (let i = 1; i < projected.length; i++) {
        const [ax, ay] = projected[i - 1];
        const [bx, by] = projected[i];
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) / budgetTiles));
        for (let s = 1; s <= steps; s++) {
            dense.push([ax + (bx - ax) * s / steps, ay + (by - ay) * s / steps]);
        }
    }

    const chunks = [];
    let current = [dense[0]];
    for (let i = 1; i < dense.length; i++) {
        if (box([...current, dense[i]]) > budgetTiles) {
            chunks.push(current);
            current = [current[current.length - 1]];
        }
        current.push(dense[i]);
    }
    if (current.length >= 2) chunks.push(current);

    for (const chunk of chunks) {
        // The whole point of this module. A chunk over budget would ship as a
        // tile with a dead straight leg in it and nothing but a console warning.
        if (box(chunk) > budgetTiles + 1e-9) {
            throw new Error(`run still spans ${box(chunk).toFixed(3)} tiles, over the ${budgetTiles} budget`);
        }
    }

    return chunks.map((chunk) => chunk.map((p) => unproject(p, n)));
}
