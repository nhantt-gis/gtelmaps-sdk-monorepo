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
 * The `line-gradient` material — MapLibre's `lineGradient` program.
 *
 * ## The only line variant that **creates** a texture
 *
 * `line-pattern` borrows the tile's image atlas; `line-dasharray` borrows the
 * map's line atlas. A gradient has no atlas to borrow from: the colour ramp is
 * rasterised on the CPU from the style expression, per bucket, and uploaded.
 * That work is `updateGradientTexture` in `draw_line.ts`, reused rather than
 * copied — see the note there.
 *
 * The ramp lives in `bucket.gradients[layer.id]`, MapLibre's own cache, so the
 * two backends share one texture rather than each holding a copy.
 *
 * ## A second layout buffer, and why nothing else needed one
 *
 * The gradient's texture coordinate cannot be derived from the extrusion: it is
 * the vertex's position **along the whole line**, across tile boundaries, which
 * only the bucket knows. MapLibre carries it in a *second* vertex buffer —
 * `layoutVertexBuffer2`, holding `a_uv_x` and `a_split_index` as two `Float32`s
 * — bound alongside the first.
 *
 * `BucketBufferSource.layoutBuffers` has always been an array for this reason;
 * this is the first layer to put two things in it.
 *
 * A source without `lineMetrics: true` never populates that array, so the buffer
 * is simply absent. That is a per-tile skip, not a refusal of the layer: the
 * style is valid and MapLibre draws nothing for it either.
 *
 * ## `stepInterpolant` changes both the resolution and the filter
 *
 * A step expression produces hard colour boundaries, so it is rasterised at a
 * resolution derived from the longest line in the bucket and sampled `NEAREST`.
 * An interpolated one gets 256 pixels and `LINEAR`. Sampling a step ramp with
 * `LINEAR` does not fail — it blurs every boundary by one texel, which reads as
 * a slightly soft gradient rather than as a bug.
 */

/**
 * The paint properties the gradient shaders read.
 *
 * There is no `color` binder: the ramp texture *is* the colour, and a style that
 * sets both has its `line-color` ignored by MapLibre too. There is no
 * `floorwidth` either — nothing here divides by the line's width.
 */
export const LINE_GRADIENT_SPECS: ReadonlyArray<PaintPropertySpec> = [
    {property: 'line-blur', name: 'blur', glslType: 'float', precision: 'lowp', inFragment: true},
    {property: 'line-opacity', name: 'opacity', glslType: 'float', precision: 'lowp', inFragment: true},
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
 * Body from `src/shaders/line_gradient.vertex.glsl`, appended inside `main()`.
 *
 * The half-texel shift samples the *centre* of each ramp row. Without it the
 * sample lands on the boundary between two rows and a line picks up the
 * neighbouring clip's colours at its ends — visible only where two line clips
 * meet, which is exactly where nobody looks.
 */
const GRADIENT_VERTEX_TAIL = `

    highp float texel_height = 1.0 / u_image_height;
    highp float half_texel_height = 0.5 * texel_height;
    v_uv = vec2(a_uv_x, a_split_index * texel_height - half_texel_height);`;

/** Body from `src/shaders/line_gradient.fragment.glsl`. */
const GRADIENT_FRAGMENT_BODY = `
    float dist = length(v_normal) * v_width2.s;

    float blur2 = (blur + 1.0 / u_device_pixel_ratio) * v_gamma_scale;
    float alpha = clamp(min(dist - (v_width2.t - blur2), v_width2.s - dist) / blur2, 0.0, 1.0);

    vec4 color = texture2D(u_image, v_uv);

    gl_FragColor = color * (alpha * opacity);
`;

export function createLineGradientMaterial(
    binders: ReadonlyArray<BinderDescription>,
    isGlobe: boolean,
): RawShaderMaterial {
    return new RawShaderMaterial({
        vertexShader: `${LINE_VERTEX_PREAMBLE}
${isGlobe ? LINE_GLOBE_VARYING : ''}
attribute float a_uv_x;
attribute float a_split_index;
uniform float u_image_height;
varying highp vec2 v_uv;
${vertexDeclarations(binders)}
${UNPACK_GLSL}
${projectionGlsl(isGlobe)}
${lineVertexMain(binders, isGlobe, GRADIENT_VERTEX_TAIL)}`,
        fragmentShader: `
precision highp float;
uniform lowp float u_device_pixel_ratio;
uniform sampler2D u_image;

varying vec2 v_normal;
varying vec2 v_width2;
varying float v_gamma_scale;
${isGlobe ? LINE_GLOBE_VARYING : ''}
varying highp vec2 v_uv;
${fragmentDeclarations(binders)}

void main() {
${fragmentInitializers(binders)}
${GRADIENT_FRAGMENT_BODY}${isGlobe ? LINE_GLOBE_CLIP_GLSL : ''}
}
`,
        uniforms: {
            ...(isGlobe ? globeUniformSlots() : {}),
            ...lineTileUniformSlots(),
            u_image: {value: null},
            u_image_height: {value: 1},
            ...uniformSlots(binders),
        },
    });
}
