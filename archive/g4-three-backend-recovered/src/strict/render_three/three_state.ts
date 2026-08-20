import type {WebGLRenderer} from 'three';

/**
 * `renderer.resetState()`, with the two things it destroys put back.
 *
 * ## What `resetState` does that nobody wants
 *
 * It exists to tell Three its GL state cache is stale, and it does that by
 * re-reading defaults. But `WebGLState.reset()` does not only forget — it
 * **writes**, and the last two writes are:
 *
 * ```js
 * gl.bindFramebuffer( gl.FRAMEBUFFER, null );
 * gl.viewport( 0, 0, gl.canvas.width, gl.canvas.height );
 * ```
 *
 * On the normal path both are already true, which is why ten layer types were
 * built on top of this without noticing. Inside a terrain render pool neither
 * is: `RenderToTexture` has bound a pool object and set the viewport to that
 * texture's size.
 *
 * ## The failure it produces is not a crash
 *
 * A draw that loses them does not error. It goes to the canvas, at canvas size,
 * and is then painted over by the terrain composite — so the layer simply
 * **vanishes**, and the render pool contains nothing where it should have been.
 * `stats.drawn` counts the draws as normal, because they did happen. That is the
 * shape it had: `raster` reporting eight draws per frame, a centre pixel showing
 * the background, and fourteen red terrain fixtures.
 *
 * ## Read from GL, not from MapLibre's cache
 *
 * `context.bindFramebuffer.current` is what MapLibre last *set*. This code runs
 * in the places where that is not authoritative — which is the entire reason
 * this backend exists — so the values come from `getParameter`. Both are
 * client-side state in every WebGL implementation, not a pipeline flush.
 *
 * ## Both callers, and why they are the same problem
 *
 * - `ThreeBackend._openThree`, once per handover.
 * - `invalidateThreeStateCache`, mid-draw, for materials sampling more than one
 *   texture — see `texture_bridge.ts`.
 *
 * The second is the one that cost the fixtures, and it is worth being precise
 * about why: the framebuffer hazard and the texture-cache hazard are unrelated
 * problems that happen to share a remedy, so fixing the first in the handover
 * left the second silently broken in exactly the renderers that need it most.
 */
export function resetThreeState(renderer: WebGLRenderer, gl: WebGLRenderingContext): void {
    const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;

    renderer.resetState();

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    // Through Three's own setter, so its cached viewport agrees with GL. Setting
    // it behind Three's back would leave the cache claiming the canvas size, and
    // the next equal-valued set would be skipped as a no-op while GL still held
    // the render-target viewport.
    renderer.setViewport(viewport[0], viewport[1], viewport[2], viewport[3]);
}
