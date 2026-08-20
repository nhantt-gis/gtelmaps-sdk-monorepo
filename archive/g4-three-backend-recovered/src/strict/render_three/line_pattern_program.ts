import {RawShaderMaterial, Vector2, Vector3, Vector4} from 'three';

import {
    fragmentDeclarations,
    fragmentInitializers,
    UNPACK_GLSL,
    vertexDeclarations,
    type BinderDescription,
    type PaintPropertySpec,
} from './paint_binders';
import {globeUniformSlots, projectionGlsl} from './projection_globe';
import {
    LINE_GLOBE_CLIP_GLSL,
    LINE_GLOBE_VARYING,
    LINE_VERTEX_PREAMBLE,
    lineTileUniformSlots,
    lineVertexMain,
} from './line_program';

/**
 * The `line-pattern` material.
 *
 * ## Why this is not `fill-pattern` with a different vertex body
 *
 * Both sample the same image atlas, but they locate the sample completely
 * differently. A patterned fill tiles the pattern across *tile space*, so it
 * uses the prelude's `get_pattern_pos` and the split 16-bit world-pixel origin.
 * A patterned line repeats the pattern along the line's own arc length: the
 * horizontal coordinate comes from `v_linesofar`, the vertical one from the
 * extrusion normal. There is no `get_pattern_pos` here, no `u_pixel_coord_*`,
 * and nothing to share beyond the atlas itself.
 *
 * What *is* shared is the extrusion arithmetic, imported from `line_program.ts`
 * rather than copied — see `lineVertexMain`.
 *
 * ## `floorwidth`, a paint property with no entry in the style spec
 *
 * The fragment stage needs the line's width to work out the pattern's aspect
 * ratio, and it needs it *floored to the integer zoom*. MapLibre supplies that
 * by synthesising a property: `LineStyleLayer.recalculate` writes
 * `line-floorwidth` into `paint._values`, built from `line-width`'s own
 * specification with `useIntegerZoom` forced on.
 *
 * Two consequences worth stating, because neither is guessable:
 *
 * - `line-floorwidth` is absent from the style spec, so nothing validates the
 *   name. Misspelling it yields `undefined` from `paint.get` and the layer is
 *   declined — invisibly, exactly the `line-gapwidth` failure from G4-4.
 * - It is a *different* binder from `width` despite deriving from the same
 *   style property, because the zoom flooring changes its value. Reusing
 *   `width` here would be right at integer zooms and wrong everywhere else.
 */

/**
 * The paint properties the line-pattern shaders read.
 *
 * Note `pixel_ratio_from`/`pixel_ratio_to` are `inFragment: true` here, unlike
 * in `fill-pattern`. The fill shader divides by the pixel ratio in the *vertex*
 * stage; this one computes `display_size` in the *fragment* stage. Copying the
 * fill spec across would drop two varyings the fragment shader reads.
 */
export const LINE_PATTERN_SPECS: ReadonlyArray<PaintPropertySpec> = [
    {property: 'line-blur', name: 'blur', glslType: 'float', precision: 'lowp', inFragment: true},
    {property: 'line-opacity', name: 'opacity', glslType: 'float', precision: 'lowp', inFragment: true},
    {property: 'line-pattern', name: 'pattern_from', glslType: 'vec4', precision: 'lowp', inFragment: true},
    {property: 'line-pattern', name: 'pattern_to', glslType: 'vec4', precision: 'lowp', inFragment: true},
    {property: 'line-pattern', name: 'pixel_ratio_from', glslType: 'float', precision: 'lowp', inFragment: true},
    {property: 'line-pattern', name: 'pixel_ratio_to', glslType: 'float', precision: 'lowp', inFragment: true},
    // Vertex-only: they shape the extrusion, or reach the fragment stage as
    // `v_width` rather than as a binder varying.
    {property: 'line-gap-width', name: 'gapwidth', glslType: 'float', precision: 'mediump', inFragment: false},
    {property: 'line-offset', name: 'offset', glslType: 'float', precision: 'lowp', inFragment: false},
    {property: 'line-width', name: 'width', glslType: 'float', precision: 'mediump', inFragment: false},
    {property: 'line-floorwidth', name: 'floorwidth', glslType: 'float', precision: 'lowp', inFragment: false},
];

function uniformSlots(binders: ReadonlyArray<BinderDescription>): Record<string, {value: unknown}> {
    const uniforms: Record<string, {value: unknown}> = {};
    for (const binder of binders) {
        if (binder.kind === 'uniform') {
            uniforms[`u_${binder.name}`] = {value: binder.glslType === 'float' ? 1 : new Vector4()};
        } else {
            uniforms[`u_${binder.name}_t`] = {value: 0};
        }
    }
    return uniforms;
}

/** Uniform values that vary per tile. Mirrors `linePatternUniformValues`. */
export type LinePatternTileUniforms = {
    texsize: [number, number];
    /** `[tileRatio, crossfade.fromScale, crossfade.toScale]`. */
    scale: [number, number, number];
    fade: number;
};

/**
 * Per-tile uniform values for a patterned line.
 *
 * `tileRatio` is `1 / pixelsToTileUnits(tile, 1, transform.tileZoom)` — note
 * `tileZoom`, the integer zoom, while `u_ratio` in the shared preamble uses
 * `transform.zoom`, the fractional one. They are different numbers by design:
 * one scales the pattern with the tile, the other scales the line width with the
 * camera. Using the same zoom for both makes the pattern breathe as you zoom
 * between integer levels, which no static fixture can see.
 */
export function linePatternTileUniforms(
    tileRatio: number,
    crossfade: {fromScale: number; toScale: number; t: number},
    atlasSize: [number, number],
): LinePatternTileUniforms {
    return {
        texsize: atlasSize,
        scale: [tileRatio, crossfade.fromScale, crossfade.toScale],
        fade: crossfade.t,
    };
}

/**
 * Body from `src/shaders/line_pattern.fragment.glsl`.
 *
 * `v_width` carries `floorwidth`; the aspect ratio it feeds is what keeps a
 * pattern from stretching as the line thickens.
 */
const PATTERN_FRAGMENT_BODY = `
    vec2 pattern_tl_a = pattern_from.xy;
    vec2 pattern_br_a = pattern_from.zw;
    vec2 pattern_tl_b = pattern_to.xy;
    vec2 pattern_br_b = pattern_to.zw;

    float tileZoomRatio = u_scale.x;
    float fromScale = u_scale.y;
    float toScale = u_scale.z;

    vec2 display_size_a = (pattern_br_a - pattern_tl_a) / pixel_ratio_from;
    vec2 display_size_b = (pattern_br_b - pattern_tl_b) / pixel_ratio_to;

    vec2 pattern_size_a = vec2(display_size_a.x * fromScale / tileZoomRatio, display_size_a.y);
    vec2 pattern_size_b = vec2(display_size_b.x * toScale / tileZoomRatio, display_size_b.y);

    float aspect_a = display_size_a.y / v_width;
    float aspect_b = display_size_b.y / v_width;

    float dist = length(v_normal) * v_width2.s;

    float blur2 = (blur + 1.0 / u_device_pixel_ratio) * v_gamma_scale;
    float alpha = clamp(min(dist - (v_width2.t - blur2), v_width2.s - dist) / blur2, 0.0, 1.0);

    float x_a = mod(v_linesofar / pattern_size_a.x * aspect_a, 1.0);
    float x_b = mod(v_linesofar / pattern_size_b.x * aspect_b, 1.0);

    float y = 0.5 * v_normal.y + 0.5;

    vec2 texel_size = 1.0 / u_texsize;

    vec2 pos_a = mix(pattern_tl_a * texel_size - texel_size, pattern_br_a * texel_size + texel_size, vec2(x_a, y));
    vec2 pos_b = mix(pattern_tl_b * texel_size - texel_size, pattern_br_b * texel_size + texel_size, vec2(x_b, y));

    vec4 color = mix(texture2D(u_image, pos_a), texture2D(u_image, pos_b), u_fade);

    gl_FragColor = color * alpha * opacity;
`;

export function createLinePatternMaterial(
    binders: ReadonlyArray<BinderDescription>,
    isGlobe: boolean,
): RawShaderMaterial {
    return new RawShaderMaterial({
        vertexShader: `${LINE_VERTEX_PREAMBLE}
${isGlobe ? LINE_GLOBE_VARYING : ''}
varying float v_width;
${vertexDeclarations(binders)}
${UNPACK_GLSL}
${projectionGlsl(isGlobe)}
${lineVertexMain(binders, isGlobe, '\n    v_width = floorwidth;')}`,
        fragmentShader: `
precision highp float;
uniform lowp float u_device_pixel_ratio;
uniform vec2 u_texsize;
uniform float u_fade;
uniform mediump vec3 u_scale;
uniform sampler2D u_image;

varying vec2 v_normal;
varying vec2 v_width2;
varying highp float v_linesofar;
varying float v_gamma_scale;
${isGlobe ? LINE_GLOBE_VARYING : ''}
varying float v_width;
${fragmentDeclarations(binders)}

void main() {
${fragmentInitializers(binders)}
${PATTERN_FRAGMENT_BODY}${isGlobe ? LINE_GLOBE_CLIP_GLSL : ''}
}
`,
        uniforms: {
            ...(isGlobe ? globeUniformSlots() : {}),
            ...lineTileUniformSlots(),
            u_texsize: {value: new Vector2()},
            u_scale: {value: new Vector3()},
            u_fade: {value: 0},
            u_image: {value: null},
            ...uniformSlots(binders),
        },
    });
}
