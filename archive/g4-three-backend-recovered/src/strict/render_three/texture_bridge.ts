import {resetThreeState} from './three_state';

import type {WebGLRenderer} from 'three';

/**
 * Tells Three that its GL state cache is no longer trustworthy.
 *
 * ## The hazard
 *
 * MapLibre's `Texture.bind(filter, wrap)` is called from inside the Three
 * section for one reason only: Three skips `setTextureParameters` for an
 * `ExternalTexture`, so without it the atlas arrives with mipmap filtering and
 * no mipmaps, and samples as opaque black (§6.4).
 *
 * But `bind` is a real `gl.bindTexture` on whichever unit is active. Three keeps
 * a per-unit cache (`WebGLState.currentBoundTextures`) and skips a bind when it
 * believes the right texture is already there. After MapLibre has bound
 * something else to that unit, that belief is wrong, and the shader samples
 * whatever MapLibre left behind.
 *
 * ## Why this did not appear until three textures were involved
 *
 * With **one** texture per material the divergence cannot be observed: the entry
 * Three cached and the texture MapLibre bound are the same object, so skipping
 * the bind still leaves the correct texture bound. `fill-pattern`,
 * `line-pattern` and `line-dasharray` are all single-texture, which is why they
 * pass 1560 fixtures with no invalidation at all.
 *
 * `color-relief` samples **three** — a DEM, an elevation-stop ramp and a colour
 * ramp — and five fixtures went red with output that looked almost right:
 * colours from the correct ramp, at the wrong index. The diagnosis took three
 * measurements, each ruling out one layer: the DEM texel decoded correctly
 * (`[1,134,160]` is elevation 0), `u_unpack` arrived correctly
 * (`[6553.6, 25.6, 0.1, 10000]`), and `u_color_ramp_size` was 3 as expected —
 * which left the elevation-stop *texture* as the only remaining suspect.
 *
 * A cheaper fix was tried first and **refuted**: restoring the
 * `context.activeTexture.set(...)` calls that upstream makes before each bind,
 * so MapLibre stops clobbering its own units. Five fixtures stayed red. The
 * corruption is of *Three's* cache, not MapLibre's.
 *
 * ## The second hazard: a whole MapLibre *draw* inside the handover
 *
 * Texture units were the first case found, not the general one. The general
 * case is that **anything MapLibre does to GL while Three holds the context**
 * leaves Three's cache describing a state that no longer exists — and a
 * MapLibre `program.draw` changes far more than a texture unit: the program,
 * the VAO, every attribute pointer.
 *
 * There is exactly one such draw reachable from a migrated renderer, and it is
 * not obvious from the call site. `painter.stencilConfigForOverlapTwoPass`
 * looks like it computes stencil modes; its first act is `clearStencil()`,
 * which draws a full-screen quad through MapLibre's `clippingMask` program.
 * `getStencilConfigForOverlapAndUpdateStencilID` does the same, but only when
 * the frame is about to run out of stencil ids (`nextStencilID + n > 256`).
 *
 * The failure is total and silent: the next Three draw is issued against
 * MapLibre's VAO, so it has no attributes and produces **no fragments**. It
 * cost §16 nine experiments, because every property normally worth suspecting
 * — cull side, stencil, depth, the fragment shader, even replacing the vertex
 * transform with a hardcoded full-screen quad — changed nothing, all the way
 * down to reading back the centre pixel immediately after the draw and finding
 * the background untouched with `glGetError() == 0`.
 *
 * ## Where to call it
 *
 * Two places, for the two hazards:
 *
 * 1. After the last MapLibre bind for a tile, in any renderer whose material
 *    samples **more than one** texture. Single-texture paths are safe by
 *    construction, per the argument above, and pay nothing.
 * 2. After **either** stencil-config call, in every renderer that makes one.
 *    Including the single-pass one, whose `clearStencil` is conditional and
 *    therefore a latent version of the same bug rather than an absent one —
 *    `raster` on mercator survives today only because a style would need more
 *    than 256 stencil ids in one frame to trigger it.
 *
 * `raster` under globe was green through all of this and is **not** evidence
 * that the second call is unnecessary: it invalidates per tile for reason (1),
 * which happens to also cover reason (2). Removing the texture invalidation
 * there would silently reintroduce this bug.
 *
 * It is not free — it invalidates Three's whole state cache, so the next draw
 * re-applies blending, depth and attribute bindings. Called once per tile that
 * is about to be drawn anyway, which is the granularity the hazard has.
 *
 * ## Why it does not call `resetState` directly
 *
 * `resetState` **writes** as well as forgets: it unbinds the framebuffer and
 * resets the viewport to the canvas. Called mid-draw inside a terrain render
 * pool, that silently redirects the rest of the layer to the screen, where the
 * terrain composite then paints over it — the layer disappears while its draw
 * counter keeps climbing. See `three_state.ts`.
 */
export function invalidateThreeStateCache(renderer: WebGLRenderer, gl: WebGLRenderingContext): void {
    resetThreeState(renderer, gl);
}
