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
 * The `line-dasharray` material — MapLibre's `lineSDF` program.
 *
 * ## Three ways this differs from `line-pattern`
 *
 * - **The atlas is shared, not per tile.** `painter.lineAtlas` is one texture
 *   for the whole map, holding every dash pattern any layer uses, and it grows
 *   as new patterns appear. `tile.imageAtlasTexture` is per tile. So the bind
 *   happens once per pass here, not once per tile — and the texture must be
 *   asked to upload itself whenever `lineAtlas.dirty` is set.
 * - **The `vec4` is not a rectangle.** A pattern binder carries the four corner
 *   coordinates. A dash binder carries `[0, y, height, width]` — the first
 *   component is unused padding, and `w` is the dash pattern's *length*, which
 *   the fragment shader divides by. Reading it as a rectangle produces a line
 *   that is dashed at entirely the wrong rate.
 * - **`line-cap` changes the texture, not just a uniform.** `getDash` takes the
 *   cap as an argument and renders a *different* SDF row for a round one, because the
 *   dash ends get semicircles baked in. The cap is a *layout* property, so it
 *   is read from `layer.layout`, not `layer.paint`.
 *
 * ## Why the atlas needs no `ExternalTexture` filter workaround
 *
 * `LineAtlas.bind` sets `REPEAT`/`LINEAR` at creation time and never uses
 * mipmaps, so the texture is already complete when Three receives it. That is
 * the opposite of the image atlas, which sets its parameters at *bind* time and
 * therefore arrived incomplete — see `fill_layer.ts`. The two atlases differ in
 * this exact respect, and the difference is easy to assume away in either
 * direction.
 */

/**
 * The paint properties the SDF shaders read.
 *
 * `width` is deliberately vertex-only here, although `line_sdf.fragment.glsl`
 * declares it. The fragment stage initializes it and never reads it — the
 * gamma calculation uses `floorwidth`. Declaring it would reserve an
 * interpolator nothing consumes; the emitted GLSL differs from upstream by that
 * one varying, and the output does not.
 */
export const LINE_DASHARRAY_SPECS: ReadonlyArray<PaintPropertySpec> = [
    {property: 'line-color', name: 'color', glslType: 'vec4', precision: 'highp', inFragment: true},
    {property: 'line-blur', name: 'blur', glslType: 'float', precision: 'lowp', inFragment: true},
    {property: 'line-opacity', name: 'opacity', glslType: 'float', precision: 'lowp', inFragment: true},
    // Read by both stages: the vertex shader scales the texture coordinate by
    // the dash length, the fragment shader derives its gamma from it.
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

/** A row of the line atlas, as `LineAtlas.getDash` returns it. */
export type DashEntry = {y: number; height: number; width: number};

/**
 * The four components a dash binder carries, in the order the shader expects.
 *
 * `[0, y, height, width]` — mirrors `setConstantDashPositions` on
 * `CrossFadedConstantBinder` exactly. The leading zero is padding that exists
 * so the dash and pattern binders can share one `vec4` attribute layout.
 */
export function dashVec4(entry: DashEntry): [number, number, number, number] {
    return [0, entry.y, entry.height, entry.width];
}

/**
 * Writes the two dash rows into uniforms, for a **constant** dasharray only.
 *
 * Mirrors `setConstantPatternUniforms` in `pattern_positions.ts`; kept separate
 * because the values mean different things and share only their shape.
 */
export function setConstantDashUniforms(
    material: RawShaderMaterial,
    binders: ReadonlyArray<BinderDescription>,
    from: DashEntry,
    to: DashEntry,
): void {
    if (binders.find((binder) => binder.name === 'dasharray_from')?.kind !== 'uniform') return;

    material.uniforms.u_dasharray_from.value.fromArray(dashVec4(from));
    material.uniforms.u_dasharray_to.value.fromArray(dashVec4(to));
}

/**
 * Body from `src/shaders/line_sdf.vertex.glsl`, appended inside `main()`.
 *
 * Reads `v_linesofar` where upstream reads its `a_linesofar` local — the same
 * value, already assigned by the shared body above. `normal` is likewise a local
 * of the shared body.
 */
const SDF_VERTEX_TAIL = `

    float u_patternscale_a_x = u_tileratio / dasharray_from.w / u_crossfade_from;
    float u_patternscale_a_y = -dasharray_from.z / 2.0 / u_lineatlas_height;
    float u_patternscale_b_x = u_tileratio / dasharray_to.w / u_crossfade_to;
    float u_patternscale_b_y = -dasharray_to.z / 2.0 / u_lineatlas_height;

    v_tex_a = vec2(v_linesofar * u_patternscale_a_x / floorwidth, normal.y * u_patternscale_a_y + (float(dasharray_from.y) + 0.5) / u_lineatlas_height);
    v_tex_b = vec2(v_linesofar * u_patternscale_b_x / floorwidth, normal.y * u_patternscale_b_y + (float(dasharray_to.y) + 0.5) / u_lineatlas_height);`;

/** Body from `src/shaders/line_sdf.fragment.glsl`. */
const SDF_FRAGMENT_BODY = `
    float dist = length(v_normal) * v_width2.s;

    float blur2 = (blur + 1.0 / u_device_pixel_ratio) * v_gamma_scale;
    float alpha = clamp(min(dist - (v_width2.t - blur2), v_width2.s - dist) / blur2, 0.0, 1.0);

    float sdfdist_a = texture2D(u_image, v_tex_a).a;
    float sdfdist_b = texture2D(u_image, v_tex_b).a;
    float sdfdist = mix(sdfdist_a, sdfdist_b, u_mix);
    float sdfgamma = (u_lineatlas_width / 256.0 / u_device_pixel_ratio) / min(dasharray_from.w, dasharray_to.w);
    alpha *= smoothstep(0.5 - sdfgamma / floorwidth, 0.5 + sdfgamma / floorwidth, sdfdist);

    gl_FragColor = color * (alpha * opacity);
`;

export function createLineDasharrayMaterial(
    binders: ReadonlyArray<BinderDescription>,
    isGlobe: boolean,
): RawShaderMaterial {
    return new RawShaderMaterial({
        vertexShader: `${LINE_VERTEX_PREAMBLE}
${isGlobe ? LINE_GLOBE_VARYING : ''}
uniform float u_tileratio;
uniform float u_crossfade_from;
uniform float u_crossfade_to;
uniform float u_lineatlas_height;
varying vec2 v_tex_a;
varying vec2 v_tex_b;
${vertexDeclarations(binders)}
${UNPACK_GLSL}
${projectionGlsl(isGlobe)}
${lineVertexMain(binders, isGlobe, SDF_VERTEX_TAIL)}`,
        fragmentShader: `
precision highp float;
uniform lowp float u_device_pixel_ratio;
uniform lowp float u_lineatlas_width;
uniform sampler2D u_image;
uniform float u_mix;

varying vec2 v_normal;
varying vec2 v_width2;
varying vec2 v_tex_a;
varying vec2 v_tex_b;
varying float v_gamma_scale;
${isGlobe ? LINE_GLOBE_VARYING : ''}
${fragmentDeclarations(binders)}

void main() {
${fragmentInitializers(binders)}
${SDF_FRAGMENT_BODY}${isGlobe ? LINE_GLOBE_CLIP_GLSL : ''}
}
`,
        uniforms: {
            ...(isGlobe ? globeUniformSlots() : {}),
            ...lineTileUniformSlots(),
            u_tileratio: {value: 1},
            u_crossfade_from: {value: 1},
            u_crossfade_to: {value: 1},
            u_lineatlas_width: {value: 1},
            u_lineatlas_height: {value: 1},
            u_mix: {value: 0},
            u_image: {value: null},
            ...uniformSlots(binders),
        },
    });
}
