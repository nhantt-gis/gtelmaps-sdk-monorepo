import {Painter} from './painter';

import type {IReadonlyTransform} from '../geo/transform_interface';
import type {RenderBackend} from './render_backend';

/**
 * Where the map decides what draws it.
 *
 * `ui/map.ts` used to call `new Painter(...)` directly, which is fine while
 * there is one backend and impossible to work around once there are two. G4
 * replaces the render tier one layer type at a time, so both backends have to
 * exist at once for a while; this is the single place that chooses between them.
 *
 * Deliberately the first step of G4 and not a later one: every week this stays
 * hardcoded is a week of new code written against a concrete `Painter`.
 *
 * The default stays `Painter`, so installing this changes no behaviour — which
 * is the point. The gate for this step is that all four checks read exactly what
 * they read before it.
 *
 * ## The return type, and why it took two steps to widen
 *
 * This first returned `Painter`, not `RenderBackend`, because typing it to the
 * interface did not compile. The interface's fourteen members were an accurate
 * count of what is *read off* the backend, but the backend is also **passed by
 * reference** into things that demanded the concrete class — which a grep for
 * `painter.` never sees:
 *
 *   - `new Terrain(painter, ...)`                     ui/map.ts
 *   - `tile.prepare(painter)` and friends             source/geojson_source.ts,
 *                                                     source/vector_tile_source.ts
 *   - `painter.terrainFacilitator`                    ui/map.ts
 *   - `painter.transform = ...`                       assigned, so it could not
 *                                                     be `readonly` on the
 *                                                     interface
 *
 * Those consumers were widened to `RenderBackend` first, so the return type
 * follows rather than leads. It was deliberately not papered over with a cast:
 * a cast would have compiled and hidden exactly the coupling G4 exists to undo.
 *
 * With this widened, `setRenderBackendFactory` can install a backend that is not
 * a `Painter` at all. Note what is still true inside `src/render/`: the `draw_*`
 * functions and `symbol/projection.ts` take a concrete `Painter`. That is fine
 * and expected — they are the tier being replaced, and a wrapping backend hands
 * them the inner `Painter`, never itself.
 */
export type RenderBackendFactory = (
    gl: WebGL2RenderingContext | WebGLRenderingContext,
    transform: IReadonlyTransform,
) => RenderBackend;

const defaultFactory: RenderBackendFactory = (gl, transform) => new Painter(gl as WebGL2RenderingContext, transform);

let factory: RenderBackendFactory = defaultFactory;

/**
 * Swaps in a different backend. Call before any `Map` is constructed; existing
 * maps keep the backend they were built with.
 */
export function setRenderBackendFactory(next: RenderBackendFactory | null): void {
    factory = next ?? defaultFactory;
}

export function createRenderBackend(
    gl: WebGL2RenderingContext | WebGLRenderingContext,
    transform: IReadonlyTransform,
): RenderBackend {
    return factory(gl, transform);
}
