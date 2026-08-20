import {
    ConstantAlphaFactor,
    ConstantColorFactor,
    CustomBlending,
    DstAlphaFactor,
    DstColorFactor,
    NoBlending,
    OneFactor,
    OneMinusConstantAlphaFactor,
    OneMinusConstantColorFactor,
    OneMinusDstAlphaFactor,
    OneMinusDstColorFactor,
    OneMinusSrcAlphaFactor,
    OneMinusSrcColorFactor,
    SrcAlphaFactor,
    SrcAlphaSaturateFactor,
    SrcColorFactor,
    ZeroFactor,
} from 'three';

import type {Material} from 'three';
import type {ColorMode} from '../../gl/color_mode';

/**
 * Copies a MapLibre `ColorMode` onto a Three material.
 *
 * ## The whole reason this file exists
 *
 * Three's blend factors are **not** the GL enums. `stencil_bridge.ts` says the
 * opposite about stencil *ops*, and there it is true — `KeepStencilOp` really is
 * `0x1E00`. The analogy does not carry, and assuming it did is what produced a
 * sky that rasterised, wrote depth, passed every state check, and painted
 * nothing at all:
 *
 * ```js
 * // three/src/constants.js
 * export const ZeroFactor = 200;
 * export const OneFactor  = 201;
 * // three/src/renderers/webgl/WebGLState.js
 * gl.blendFuncSeparate( factorToGL[ blendSrc ], factorToGL[ blendDst ], … );
 * ```
 *
 * `factorToGL` is keyed by those 200-range values. Handing it `gl.ONE` (`1`)
 * looks up `factorToGL[1]`, which is `undefined`, and WebGL coerces `undefined`
 * to `0` — `GL_ZERO`. So `(ONE, ONE_MINUS_SRC_ALPHA)` silently became
 * `(ZERO, ZERO)`: every fragment blended to nothing, while `COLOR_WRITEMASK`,
 * the depth state, the program and the draw call were all correct.
 *
 * Nothing in the failure pointed at blending. It took reading
 * `BLEND_SRC_RGB`/`BLEND_DST_RGB` at the instant `drawElements` fired to see
 * `(0,0)`. Hence this table, and hence the test that pins the values as
 * *different* from the GL enums rather than equal to them.
 *
 * ## Why a table and not a cast
 *
 * The other nine renderers never hit this because they name Three's constants
 * directly — they know at author time that a layer is alpha-blended. Only code
 * that reads a `ColorMode` *at runtime* has to translate, and translation with
 * an unknown value must **refuse** rather than guess: an unmapped factor that
 * fell through to `undefined` is exactly the bug above.
 */

/** MapLibre's GL blend factors, by their GL enum value. */
const FACTOR_TO_THREE: Record<number, number> = {
    0x0000: ZeroFactor,
    0x0001: OneFactor,
    0x0300: SrcColorFactor,
    0x0301: OneMinusSrcColorFactor,
    0x0302: SrcAlphaFactor,
    0x0303: OneMinusSrcAlphaFactor,
    0x0304: DstAlphaFactor,
    0x0305: OneMinusDstAlphaFactor,
    0x0306: DstColorFactor,
    0x0307: OneMinusDstColorFactor,
    0x0308: SrcAlphaSaturateFactor,
    0x8001: ConstantColorFactor,
    0x8002: OneMinusConstantColorFactor,
    0x8003: ConstantAlphaFactor,
    0x8004: OneMinusConstantAlphaFactor,
};

/** GL's `ONE` and `ZERO`, which together mean "no blending at all". */
const GL_ONE = 0x0001;
const GL_ZERO = 0x0000;

/** Translates one GL blend factor, refusing anything not in the table. */
export function blendFactorToThree(glFactor: number): number {
    const factor = FACTOR_TO_THREE[glFactor];
    if (factor === undefined) {
        // Refused rather than passed through: passing it through is the bug this
        // file documents, and it fails silently.
        throw new Error(`Unsupported GL blend factor 0x${glFactor.toString(16)}`);
    }
    return factor;
}

/**
 * Applies a MapLibre `ColorMode` to a material: blending, and the write mask.
 *
 * `(ONE, ZERO)` is `ColorMode.Replace`, which is not a blend at all — it is
 * mapped to `NoBlending` so Three disables `GL_BLEND` rather than configuring a
 * blend that happens to be the identity.
 */
export function applyColorMode(material: Material, mode: Readonly<ColorMode>): void {
    const [src, dst] = mode.blendFunction;

    if (src === GL_ONE && dst === GL_ZERO) {
        material.transparent = false;
        material.blending = NoBlending;
    } else {
        material.transparent = true;
        material.blending = CustomBlending;
        material.blendSrc = blendFactorToThree(src) as unknown as Material['blendSrc'];
        material.blendDst = blendFactorToThree(dst) as unknown as Material['blendDst'];
    }

    // MapLibre's mask is per channel; Three's `colorWrite` is one flag. Every
    // `ColorMode` MapLibre constructs is all-true or all-false, so the two are
    // equivalent — but assert it rather than assume, because a per-channel mask
    // would silently lose channels here.
    const [r, g, b, a] = mode.mask;
    if (r !== g || g !== b || b !== a) {
        throw new Error('Per-channel colour masks cannot be expressed on a Three material');
    }
    material.colorWrite = r;
}
