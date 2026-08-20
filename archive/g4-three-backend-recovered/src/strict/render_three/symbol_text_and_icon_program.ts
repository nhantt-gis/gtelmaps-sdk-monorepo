import {Matrix4, RawShaderMaterial, Vector2, Vector4} from 'three';

import {
    fragmentDeclarations,
    fragmentInitializers,
    UNPACK_GLSL,
    vertexDeclarations,
    vertexInitializers,
    type BinderDescription,
} from './paint_binders';
import {globeUniformSlots, projectionGlsl} from './projection_globe';
import {terrainGlsl, terrainUniformSlots} from './terrain_bridge';

/**
 * Builds the `symbolTextAndIcon` material — text with images inline in it.
 *
 * ## Why this is a third file and not a third branch
 *
 * `symbol_program.ts` shares one emitted body between `symbolIcon` and
 * `symbolSDF`, because those two differ only in what they hand the fragment
 * stage. This one is not a variant of either. Reading the upstream shaders side
 * by side, it differs in six independent places:
 *
 * - it has **no `a_pixeloffset` attribute at all**, so both the pixel offset and
 *   the minimum font scale disappear from the corner arithmetic;
 * - it recovers a per-quad `is_sdf` flag from the **low bit of `a_size[0]`**
 *   (`a_size[0] - 2.0 * floor(a_size[0] * 0.5)`), which is how one buffer can
 *   hold glyphs and images at once;
 * - `fontScale` is unconditionally `size / 24.0`, with no `u_is_text` branch;
 * - the pitch re-projection is gated on `u_pitch_with_map && !u_is_along_line`
 *   rather than `u_pitch_with_map` alone;
 * - `v_data0` and `v_data1` widen to `vec4`, carrying a second texture
 *   coordinate and the flag;
 * - **the halo maths is different**, not merely re-parameterised — see below.
 *
 * Threading six conditionals through the shared body would leave a template that
 * emits three shaders and is read as none of them. The G4-4b lesson is that
 * factoring a *working* configuration is where breakage hides, so the seams stay
 * where upstream put them.
 *
 * ## The halo, and the difference that is easy to miss
 *
 * `symbol_sdf.fragment.glsl` computes the fill alpha and then, for a halo,
 * takes `min(smoothstep(halo_edge, …), 1.0 - alpha)` — punching the fill's own
 * shape out of the halo so a transparent fill does not reveal halo underneath.
 * This shader does **not**: it moves the threshold to the halo edge and takes
 * the smoothstep directly. Transcribing the SDF version here would look right on
 * opaque text and wrong only where the fill is translucent.
 *
 * ## Two textures
 *
 * The only symbol program that samples two — the glyph atlas and the image
 * atlas. That crosses the threshold argued in `texture_bridge.ts`, so the caller
 * invalidates Three's per-unit cache; the single-texture programs do not, and
 * that asymmetry is a conclusion rather than an oversight (§6.11).
 */

/** Verbatim from `src/shaders/_prelude.vertex.glsl`. */
const UNPACK_OPACITY_GLSL = `
vec2 unpack_opacity(const float packedOpacity) {
    int intOpacity = int(packedOpacity) / 2;
    return vec2(float(intOpacity) / 127.0, mod(packedOpacity, 2.0));
}
`;

function uniformSlots(binders: ReadonlyArray<BinderDescription>): Record<string, {value: unknown}> {
    const uniforms: Record<string, {value: unknown}> = {};
    for (const binder of binders) {
        if (binder.kind === 'uniform') {
            uniforms[`u_${binder.name}`] = {value: binder.glslType === 'float' ? 0 : new Vector4()};
        } else {
            uniforms[`u_${binder.name}_t`] = {value: 0};
        }
    }
    return uniforms;
}

export function createSymbolTextAndIconMaterial(
    binders: ReadonlyArray<BinderDescription>,
    hasTerrain: boolean,
    isGlobe: boolean,
): RawShaderMaterial {
    return new RawShaderMaterial({
        // Body from src/shaders/symbol_text_and_icon.vertex.glsl, with the GLOBE
        // branch and the terrain lookups removed — as in `symbol_program.ts`.
        vertexShader: `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;

uniform bool u_is_size_zoom_constant;
uniform bool u_is_size_feature_constant;
uniform highp float u_size_t;
uniform highp float u_size;
uniform mat4 u_label_plane_matrix;
uniform mat4 u_coord_matrix;
${isGlobe ? 'uniform float u_pitched_scale;' : ''}
uniform bool u_is_text;
uniform bool u_pitch_with_map;
uniform bool u_is_along_line;
uniform bool u_is_variable_anchor;
uniform bool u_rotate_symbol;
uniform highp float u_aspect_ratio;
uniform highp float u_camera_to_center_distance;
uniform float u_fade_change;
uniform vec2 u_texsize;
uniform vec2 u_texsize_icon;
uniform vec2 u_translation;

attribute vec4 a_pos_offset;
attribute vec4 a_data;
attribute vec3 a_projected_pos;
attribute float a_fade_opacity;

varying vec4 v_data0;
varying vec4 v_data1;
${vertexDeclarations(binders)}
${UNPACK_GLSL}
${UNPACK_OPACITY_GLSL}
${terrainGlsl(hasTerrain)}
${projectionGlsl(isGlobe)}
void main() {
${vertexInitializers(binders)}

    vec2 a_pos = a_pos_offset.xy;
    vec2 a_offset = a_pos_offset.zw;

    vec2 a_tex = a_data.xy;
    vec2 a_size = a_data.zw;

    float a_size_min = floor(a_size[0] * 0.5);
    // The low bit of a_size[0] says whether this quad is a glyph or an image.
    float is_sdf = a_size[0] - 2.0 * a_size_min;

    float ele = get_elevation(a_pos);
    highp float segment_angle = -a_projected_pos[2];
    float size;

    if (!u_is_size_zoom_constant && !u_is_size_feature_constant) {
        size = mix(a_size_min, a_size[1], u_size_t) / 128.0;
    } else if (u_is_size_zoom_constant && !u_is_size_feature_constant) {
        size = a_size_min / 128.0;
    } else {
        size = u_size;
    }

    vec2 translated_a_pos = a_pos + u_translation;
    vec4 projectedPoint = projectTileWithElevation(translated_a_pos, ele);

    // compute total opacity and early exit if too transparent.
    float visibility = calculate_visibility(projectedPoint);
    vec2 fade_opacity = unpack_opacity(a_fade_opacity);
    float fade_change = fade_opacity[1] > 0.5 ? u_fade_change : -u_fade_change;
    float total_opacity = opacity * max(0.0, min(visibility, fade_opacity[0] + fade_change));
    if (total_opacity < 0.1) {
        gl_Position = vec4(-2., -2., -2., 1.);
        return;
    }

    highp float camera_to_anchor_distance = projectedPoint.w;
    highp float distance_ratio = u_pitch_with_map ?
        camera_to_anchor_distance / u_camera_to_center_distance :
        u_camera_to_center_distance / camera_to_anchor_distance;
    highp float perspective_ratio = clamp(
        0.5 + 0.5 * distance_ratio,
        0.0,
        4.0);

    size *= perspective_ratio;

    float fontScale = size / 24.0;

    highp float symbol_rotation = 0.0;
    if (u_rotate_symbol) {
        // See comments in symbol_sdf.vertex
        vec4 offsetProjectedPoint = projectTileWithElevation(translated_a_pos + vec2(1, 0), ele);

        vec2 a = projectedPoint.xy / projectedPoint.w;
        vec2 b = offsetProjectedPoint.xy / offsetProjectedPoint.w;

        symbol_rotation = atan((b.y - a.y) / u_aspect_ratio, b.x - a.x);
    }

    highp float angle_sin = sin(segment_angle + symbol_rotation);
    highp float angle_cos = cos(segment_angle + symbol_rotation);
    mat2 rotation_matrix = mat2(angle_cos, -1.0 * angle_sin, angle_sin, angle_cos);

    vec4 projected_pos;
    if (u_is_along_line || u_is_variable_anchor) {
        projected_pos = vec4(a_projected_pos.xy, ele, 1.0);
    } else if (u_pitch_with_map) {
        projected_pos = u_label_plane_matrix * vec4(a_projected_pos.xy + u_translation, ele, 1.0);
    } else {
        projected_pos = u_label_plane_matrix * projectTileWithElevation(a_projected_pos.xy + u_translation, ele);
    }

    float z = float(u_pitch_with_map) * projected_pos.z / projected_pos.w;

    float projectionScaling = 1.0;
${isGlobe ?
    '    if (u_pitch_with_map) {\n' +
        '        float anchor_pos_tile_y = (u_coord_matrix * vec4(projected_pos.xy / projected_pos.w, z, 1.0)).y;\n' +
        '        projectionScaling = mix(projectionScaling, 1.0 / circumferenceRatioAtTileY(anchor_pos_tile_y) * u_pitched_scale, u_projection_transition);\n' +
        '    }' : ''}
    vec4 finalPos = u_coord_matrix * vec4(projected_pos.xy / projected_pos.w + rotation_matrix * (a_offset / 32.0 * fontScale) * projectionScaling, z, 1.0);
    // Note the extra condition against upstream's SDF shader: along a line the
    // position is already in clip space and must not be re-projected.
    if (u_pitch_with_map && !u_is_along_line) {
        finalPos = projectTileWithElevation(finalPos.xy, finalPos.z);
    }
    float gamma_scale = finalPos.w;
    gl_Position = finalPos;

    v_data0.xy = a_tex / u_texsize;
    v_data0.zw = a_tex / u_texsize_icon;
    v_data1 = vec4(gamma_scale, size, total_opacity, is_sdf);
}
`,
        // Body from src/shaders/symbol_text_and_icon.fragment.glsl.
        fragmentShader: `
precision highp float;
#define SDF_PX 8.0
#define SDF 1.0
#define ICON 0.0

uniform bool u_is_halo;
uniform sampler2D u_texture;
uniform sampler2D u_texture_icon;
uniform highp float u_gamma_scale;
uniform lowp float u_device_pixel_ratio;

varying vec4 v_data0;
varying vec4 v_data1;
${fragmentDeclarations(binders)}

void main() {
${fragmentInitializers(binders)}

    float total_opacity = v_data1[2];

    if (v_data1.w == ICON) {
        vec2 tex_icon = v_data0.zw;
        gl_FragColor = texture2D(u_texture_icon, tex_icon) * total_opacity;
        return;
    }

    vec2 tex = v_data0.xy;

    float EDGE_GAMMA = 0.105 / u_device_pixel_ratio;

    float gamma_scale = v_data1.x;
    float size = v_data1.y;

    float fontScale = size / 24.0;

    lowp vec4 color = fill_color;
    highp float gamma = EDGE_GAMMA / (fontScale * u_gamma_scale);
    lowp float buff = (256.0 - 64.0) / 256.0;
    if (u_is_halo) {
        color = halo_color;
        gamma = (halo_blur * 1.19 / SDF_PX + EDGE_GAMMA) / (fontScale * u_gamma_scale);
        buff = (6.0 - halo_width / fontScale) / SDF_PX;
    }

    lowp float dist = texture2D(u_texture, tex).a;
    highp float gamma_scaled = gamma * gamma_scale;
    highp float alpha = smoothstep(buff - gamma_scaled, buff + gamma_scaled, dist);

    gl_FragColor = color * (alpha * total_opacity);
}
`,
        uniforms: {
            u_is_size_zoom_constant: {value: 0},
            u_is_size_feature_constant: {value: 0},
            u_size_t: {value: 0},
            u_size: {value: 0},
            u_camera_to_center_distance: {value: 0},
            u_rotate_symbol: {value: 0},
            u_aspect_ratio: {value: 1},
            u_fade_change: {value: 1},
            u_label_plane_matrix: {value: new Matrix4()},
            u_coord_matrix: {value: new Matrix4()},
            u_is_text: {value: 0},
            u_pitch_with_map: {value: 0},
            u_is_along_line: {value: 0},
            u_is_variable_anchor: {value: 0},
            u_texsize: {value: new Vector2()},
            u_texsize_icon: {value: new Vector2()},
            u_translation: {value: new Vector2()},
            u_texture: {value: null},
            u_texture_icon: {value: null},
            u_gamma_scale: {value: 1},
            u_device_pixel_ratio: {value: 1},
            u_is_halo: {value: 0},
            ...uniformSlots(binders),
            ...(hasTerrain ? terrainUniformSlots() : {}),
            ...(isGlobe ? {u_pitched_scale: {value: 1}, ...globeUniformSlots()} : {}),
        },
    });
}
