import {
    DecrementStencilOp,
    DecrementWrapStencilOp,
    IncrementStencilOp,
    IncrementWrapStencilOp,
    InvertStencilOp,
    KeepStencilOp,
    ReplaceStencilOp,
    ZeroStencilOp,
} from 'three';

import type {Material} from 'three';
import type {StencilMode} from '../../gl/stencil_mode';

/**
 * Copies a MapLibre `StencilMode` onto a Three material.
 *
 * The one thing worth naming: MapLibre's `StencilMode.mask` is the **write**
 * mask (`glStencilMask`) while `test.mask` is the **compare** mask
 * (`glStencilFunc`'s third argument). Three names them `stencilWriteMask` and
 * `stencilFuncMask`, and swapping them is silent — tile clipping would still
 * appear to work at one zoom and fail where the stencil refs differ.
 *
 * Three's `stencilWrite` flag gates the whole stencil block, test included, so
 * it is set for any mode that is not `disabled`.
 *
 * ## Why the ops are cast
 *
 * Three's stencil ops *are* the GL enums, so MapLibre's values pass through
 * unchanged.
 *
 * **Do not carry that fact to blending.** Three's *blend factors* are not GL
 * enums — they are 200-range values of Three's own, looked up through a table.
 * Assuming the analogy held, and writing it into a comment without checking,
 * produced a `sky` layer that rasterised, wrote depth, passed every state check
 * and painted nothing at all. See `color_mode_bridge.ts`.
 *
 * The exception here is that `@types/three@0.185` declares
 * `DecrementStencilOp: 7283`, a typo for `0x1E03 = 7683`. Three's own
 * `constants.js` has the correct value; only the type is wrong. Writing 7283 to
 * satisfy the compiler would send an enum GL does not define, so the values are
 * cast instead. {@link STENCIL_OPS_MATCH_THREE} pins the equivalence, and will
 * fail if a future `three` genuinely diverges rather than merely mistyping.
 */
export function applyStencilMode(material: Material, mode: Readonly<StencilMode>, gl: WebGLRenderingContext): void {
    material.stencilWrite = mode.test.func !== gl.ALWAYS || mode.mask !== 0;
    material.stencilFunc = mode.test.func;
    material.stencilRef = mode.ref;
    material.stencilFuncMask = mode.test.mask;
    material.stencilWriteMask = mode.mask;
    material.stencilFail = mode.fail as unknown as Material['stencilFail'];
    material.stencilZFail = mode.depthFail as unknown as Material['stencilZFail'];
    material.stencilZPass = mode.pass as unknown as Material['stencilZPass'];
}

/**
 * The stencil ops Three ships at runtime, keyed by GL name.
 *
 * Exported so a test can compare them against the context's own constants. See
 * the cast in {@link applyStencilMode}.
 */
export const STENCIL_OPS_MATCH_THREE = {
    ZERO: ZeroStencilOp,
    KEEP: KeepStencilOp,
    REPLACE: ReplaceStencilOp,
    INCR: IncrementStencilOp,
    DECR: DecrementStencilOp,
    INCR_WRAP: IncrementWrapStencilOp,
    DECR_WRAP: DecrementWrapStencilOp,
    INVERT: InvertStencilOp,
} as const;
