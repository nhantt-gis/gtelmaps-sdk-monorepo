import {RawShaderMaterial, Vector4} from 'three';

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
 * The `lineGradientSDF` material — a line that is **both** gradient and dashed.
 *
 * ## A fifth program, not a combination of two
 *
 * `drawLine` selects this whenever a layer sets `line-gradient` *and*
 * `line-dasharray`, and upstream ships it as its own pair of shader files
 * rather than composing the other two. Three things make that necessary, and
 * all three are easy to lose by "just merging" the existing materials:
 *
 * 1. **Two samplers.** The gradient ramp keeps `u_image`; the line atlas moves
 *    to `u_image_dash`. Both are sampled in the same fragment, so this is a
 *    two-texture material and takes `invalidateThreeStateCache` with it — see
 *    `texture_bridge.ts`.
 * 2. **No `color` binder.** The gradient texture *is* the colour, exactly as in
 *    `lineGradient`. The plain SDF program's `color` binder is absent here, and
 *    carrying it across would reserve a varying and then multiply by it.
 * 3. **A different `sdfgamma`.** `line_sdf.fragment.glsl` divides by
 *    `u_device_pixel_ratio`; `line_gradient_sdf.fragment.glsl` **does not**.
 *    Copying the SDF line makes the dash edge softer or harder by the device
 *    pixel ratio — correct at ratio 1, wrong everywhere else, and every fixture
 *    but the `@2x` ones runs at ratio 1.
 *
 * The dash and gradient contributions also combine differently from either
 * parent: `color * (alpha * dash_alpha * opacity)`, with the dash as its own
 * factor rather than folded into `alpha`.
 */

/**
 * The paint properties this shader reads.
 *
 * The gradient set plus the dash set, **minus `color`** — see the file comment.
 */
export const LINE_GRADIENT_SDF_SPECS: ReadonlyArray<PaintPropertySpec> = [
    {property: 'line-blur', name: 'blur', glslType: 'float', precision: 'lowp', inFragment: true},
    {property: 'line-opacity', name: 'opacity', glslType: 'float', precision: 'lowp', inFragment: true},
    {property: 'line-dasharray', name: 'dasharray_from', glslType: 'vec4', precision: 'mediump', inFragment: true},
    {property: 'line-dasharray', name: 'dasharray_to', glslType: 'vec4', precision: 'mediump', inFragment: true},
    {property: 'line-floorwidth', name: 'floorwidth', glslType: 'float', precision: 'lowp', inFragment: true},
    // Vertex-only.
    {property: 'line-gap-width', name: 'gapwidth', glslType: 'float', precision: 'mediump', inFragment: false},
    {property: 'line-offset', name: 'offset', glslType: 'float', precision: 'lowp', inFragment: false},
    {property: 'line-width', name: 'width', glslType: 'float', precision: 'mediump', inFragment: false},
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

/**
 * Both tails, from `src/shaders/line_gradient_sdf.vertex.glsl`.
 *
 * `v_linesofar` stands in for upstream's `a_linesofar` local: the shared body
 * has already computed the same expression, including the `* 2.0` that
 * upstream spells `LINE_DISTANCE_SCALE`.
 */
const GRADIENT_SDF_VERTEX_TAIL = `

    float texel_height = 1.0 / u_image_height;
    float half_texel_height = 0.5 * texel_height;
    v_uv = vec2(a_uv_x, a_split_index * texel_height - half_texel_height);

    float u_patternscale_a_x = u_tileratio / dasharray_from.w / u_crossfade_from;
    float u_patternscale_a_y = -dasharray_from.z / 2.0 / u_lineatlas_height;
    float u_patternscale_b_x = u_tileratio / dasharray_to.w / u_crossfade_to;
    float u_patternscale_b_y = -dasharray_to.z / 2.0 / u_lineatlas_height;

    v_tex_a = vec2(v_linesofar * u_patternscale_a_x / floorwidth, normal.y * u_patternscale_a_y + (float(dasharray_from.y) + 0.5) / u_lineatlas_height);
    v_tex_b = vec2(v_linesofar * u_patternscale_b_x / floorwidth, normal.y * u_patternscale_b_y + (float(dasharray_to.y) + 0.5) / u_lineatlas_height);`;

/** Body from `src/shaders/line_gradient_sdf.fragment.glsl`. */
const GRADIENT_SDF_FRAGMENT_BODY = `
    float dist = length(v_normal) * v_width2.s;

    float blur2 = (blur + 1.0 / u_device_pixel_ratio) * v_gamma_scale;
    float alpha = clamp(min(dist - (v_width2.t - blur2), v_width2.s - dist) / blur2, 0.0, 1.0);

    vec4 color = texture2D(u_image, v_uv);

    float sdfdist_a = texture2D(u_image_dash, v_tex_a).a;
    float sdfdist_b = texture2D(u_image_dash, v_tex_b).a;
    float sdfdist = mix(sdfdist_a, sdfdist_b, u_mix);
    float sdfgamma = (u_lineatlas_width / 256.0) / min(dasharray_from.w, dasharray_to.w);
    float dash_alpha = smoothstep(0.5 - sdfgamma / floorwidth, 0.5 + sdfgamma / floorwidth, sdfdist);

    gl_FragColor = color * (alpha * dash_alpha * opacity);
`;

export function createLineGradientSdfMaterial(
    binders: ReadonlyArray<BinderDescription>,
    isGlobe: boolean,
): RawShaderMaterial {
    return new RawShaderMaterial({
        vertexShader: `${LINE_VERTEX_PREAMBLE}
${isGlobe ? LINE_GLOBE_VARYING : ''}
attribute float a_uv_x;
attribute float a_split_index;
uniform float u_image_height;
uniform float u_tileratio;
uniform float u_crossfade_from;
uniform float u_crossfade_to;
uniform float u_lineatlas_height;
varying highp vec2 v_uv;
varying vec2 v_tex_a;
varying vec2 v_tex_b;
${vertexDeclarations(binders)}
${UNPACK_GLSL}
${projectionGlsl(isGlobe)}
${lineVertexMain(binders, isGlobe, GRADIENT_SDF_VERTEX_TAIL)}`,
        fragmentShader: `
precision highp float;
uniform lowp float u_device_pixel_ratio;
uniform lowp float u_lineatlas_width;
uniform sampler2D u_image;
uniform sampler2D u_image_dash;
uniform float u_mix;

varying vec2 v_normal;
varying vec2 v_width2;
varying float v_gamma_scale;
${isGlobe ? LINE_GLOBE_VARYING : ''}
varying highp vec2 v_uv;
varying vec2 v_tex_a;
varying vec2 v_tex_b;
${fragmentDeclarations(binders)}

void main() {
${fragmentInitializers(binders)}
${GRADIENT_SDF_FRAGMENT_BODY}${isGlobe ? LINE_GLOBE_CLIP_GLSL : ''}
}
`,
        uniforms: {
            ...(isGlobe ? globeUniformSlots() : {}),
            ...lineTileUniformSlots(),
            u_image: {value: null},
            u_image_dash: {value: null},
            u_image_height: {value: 1},
            u_tileratio: {value: 1},
            u_crossfade_from: {value: 1},
            u_crossfade_to: {value: 1},
            u_lineatlas_width: {value: 1},
            u_lineatlas_height: {value: 1},
            u_mix: {value: 0},
            ...uniformSlots(binders),
        },
    });
}
