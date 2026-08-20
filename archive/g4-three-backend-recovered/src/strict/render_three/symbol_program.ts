import {Matrix4, RawShaderMaterial, Vector2, Vector4} from 'three';

import {
    fragmentDeclarations,
    fragmentInitializers,
    UNPACK_GLSL,
    vertexDeclarations,
    vertexInitializers,
    type BinderDescription,
    type PaintPropertySpec,
} from './paint_binders';
import {globeUniformSlots, projectionGlsl} from './projection_globe';
import {terrainGlsl, terrainUniformSlots} from './terrain_bridge';

/**
 * Builds the `symbolIcon` and `symbolSDF` materials.
 *
 * ## Two programs, one body
 *
 * `symbol_icon.vertex.glsl` and `symbol_sdf.vertex.glsl` are the same shader
 * apart from what they hand the fragment stage: the icon path passes a texture
 * coordinate and a single opacity, the SDF path also passes the glyph size and
 * the perspective `gamma_scale` its antialiasing needs. Everything above that —
 * the size selection, the perspective ratio, the rotation matrix, the label-plane
 * round trip — is identical, and it is arithmetic where a plausible-looking
 * variation moves every label by a few pixels rather than failing.
 *
 * So the body lives once, in {@link symbolVertexMain}, and each variant supplies
 * two hooks. `symbol_program.test.ts` pins the emitted strings for exactly the
 * reason `line_program.test.ts` does: the string *is* the behaviour, and only a
 * GPU can judge it.
 *
 * ## The shader names are shared; the property names are not
 *
 * A symbol layer draws twice — once for icons, once for text — through the same
 * programs. The pragmas are named `fill_color`, `halo_color`, `opacity`,
 * `halo_width`, `halo_blur` in both passes, but they are fed from `icon-*` in one
 * and `text-*` in the other. Hence the spec lists are functions of `isText`
 * rather than constants: writing the shader name into the property slot is the
 * mistake that made every `line` layer decline invisibly in G4-4.
 *
 * ## Where `opacity` goes, and where it does not
 *
 * `opacity` is declared in both stages by MapLibre, but neither fragment shader
 * reads it — the icon one reads `v_total_opacity` and the SDF one reads
 * `v_data1[2]`, both of which the vertex stage has already multiplied the fade
 * into. So it is vertex-only here. See `PaintPropertySpec.inFragment`.
 *
 * ## What is omitted, and why that is safe
 *
 * - ~~**The `GLOBE` branch**~~ — ported in §24, and with it `u_pitched_scale`.
 *   What it corrects is that a label pitched with the map covers a *smaller*
 *   share of the sphere near the poles than at the equator, so its offset has
 *   to be divided by the circumference ratio at its own anchor's latitude. Left
 *   out, labels drift away from their anchors towards the poles.
 * - The old note said `projectionScaling`, which is otherwise the constant
 *   `1.0` — multiplying by exactly 1.0 is an identity in IEEE arithmetic, not an
 *   approximation. Globe is declined before these materials are selected.
 * - **`u_pitch`.** Declared by both upstream shaders and read by neither. Left
 *   out rather than wired to a value nothing consumes; if it ever starts being
 *   read, the link fails loudly rather than sampling a stale uniform.
 * - **The terrain lookups.** `get_elevation` is `0.0` and
 *   `calculate_visibility` is `1.0` without `TERRAIN3D`, which is declined.
 * - **`OVERDRAW_INSPECTOR`**, declined outright.
 */

/** `text-*` or `icon-*`, depending on which pass is drawing. */
function prefixed(isText: boolean, suffix: string): string {
    return `${isText ? 'text' : 'icon'}-${suffix}`;
}

/** The one paint property `symbolIcon` reads. */
export function symbolIconSpecs(isText: boolean): ReadonlyArray<PaintPropertySpec> {
    return [
        // Vertex-only: the fragment shader reads `v_total_opacity`, which
        // already has the fade folded in.
        {property: prefixed(isText, 'opacity'), name: 'opacity', glslType: 'float', precision: 'lowp', inFragment: false},
    ];
}

/** The five paint properties `symbolSDF` reads. */
export function symbolSdfSpecs(isText: boolean): ReadonlyArray<PaintPropertySpec> {
    return [
        {property: prefixed(isText, 'color'), name: 'fill_color', glslType: 'vec4', precision: 'highp', inFragment: true},
        {property: prefixed(isText, 'halo-color'), name: 'halo_color', glslType: 'vec4', precision: 'highp', inFragment: true},
        // Vertex-only: the fragment shader reads `v_data1[2]`.
        {property: prefixed(isText, 'opacity'), name: 'opacity', glslType: 'float', precision: 'lowp', inFragment: false},
        {property: prefixed(isText, 'halo-width'), name: 'halo_width', glslType: 'float', precision: 'lowp', inFragment: true},
        {property: prefixed(isText, 'halo-blur'), name: 'halo_blur', glslType: 'float', precision: 'lowp', inFragment: true},
    ];
}

/** Signature that decides whether two configurations can share a material. */
export function symbolProgramKey(
    binders: ReadonlyArray<BinderDescription>,
    hasTerrain: boolean,
    isGlobe: boolean,
): string {
    return `${hasTerrain ? 't' : '-'}${isGlobe ? 'g' : '-'}|${symbolBinderKey(binders)}`;
}

function symbolBinderKey(binders: ReadonlyArray<BinderDescription>): string {
    return binders.map((binder) => `${binder.name}:${binder.kind}`).join('|');
}

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

/** Verbatim from `src/shaders/_prelude.vertex.glsl`. */
const UNPACK_OPACITY_GLSL = `
vec2 unpack_opacity(const float packedOpacity) {
    int intOpacity = int(packedOpacity) / 2;
    return vec2(float(intOpacity) / 127.0, mod(packedOpacity, 2.0));
}
`;

/** The declarations both symbol vertex shaders need, before their binders. */
function symbolVertexPreamble(isGlobe: boolean): string {
    return `
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
uniform vec2 u_translation;

attribute vec4 a_pos_offset;
attribute vec4 a_data;
attribute vec4 a_pixeloffset;
attribute vec3 a_projected_pos;
attribute float a_fade_opacity;`;
}

/**
 * The shared body of both symbol vertex shaders.
 *
 * `storeOpacity` runs **before** the early-out, because the icon variant's
 * varying is written there upstream. Writing it after would leave the varying
 * unset on the discarded path — harmless in practice, since the vertex has been
 * pushed outside the clip volume, but "harmless in practice" is how the two
 * shaders drift apart.
 *
 * `tail` writes each variant's remaining varyings at the end.
 */
export function symbolVertexMain(
    binders: ReadonlyArray<BinderDescription>,
    hasTerrain: boolean,
    isGlobe: boolean,
    hooks: {storeOpacity?: string; tail: string},
): string {
    return `void main() {
${vertexInitializers(binders)}

    vec2 a_pos = a_pos_offset.xy;
    vec2 a_offset = a_pos_offset.zw;

    vec2 a_tex = a_data.xy;
    vec2 a_size = a_data.zw;

    float a_size_min = floor(a_size[0] * 0.5);
    vec2 a_pxoffset = a_pixeloffset.xy / 16.0;
    vec2 a_minFontScale = a_pixeloffset.zw / 256.0;

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

    // compute opacity and visibility
    float visibility = calculate_visibility(projectedPoint);
    vec2 fade_opacity = unpack_opacity(a_fade_opacity);
    float fade_change = fade_opacity[1] > 0.5 ? u_fade_change : -u_fade_change;
    float total_opacity = opacity * max(0.0, min(visibility, fade_opacity[0] + fade_change));
${hooks.storeOpacity ?? ''}
    if (total_opacity < 0.1) {
        gl_Position = vec4(-2., -2., -2., 1.);
        return;
    }

    highp float camera_to_anchor_distance = projectedPoint.w;
    // If the label is pitched with the map, layout is done in pitched space,
    // which makes labels in the distance smaller relative to viewport space.
    // We counteract part of that effect by multiplying by the perspective ratio.
    // If the label isn't pitched with the map, we do layout in viewport space,
    // which makes labels in the distance larger relative to the features around
    // them. We counteract part of that effect by dividing by the perspective ratio.
    highp float distance_ratio = u_pitch_with_map ?
        camera_to_anchor_distance / u_camera_to_center_distance :
        u_camera_to_center_distance / camera_to_anchor_distance;
    highp float perspective_ratio = clamp(
        0.5 + 0.5 * distance_ratio,
        0.0, // Prevents oversized near-field symbols in pitched/overzoomed tiles
        4.0);

    size *= perspective_ratio;

    float fontScale = u_is_text ? size / 24.0 : size;

    highp float symbol_rotation = 0.0;
    if (u_rotate_symbol) {
        // Point labels with 'rotation-alignment: map' are horizontal with respect to tile units
        // To figure out that angle in projected space, we draw a short horizontal line in tile
        // space, project it, and measure its angle in projected space.
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
        // Label plane matrix is identity in this case
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
    vec4 finalPos = u_coord_matrix * vec4(projected_pos.xy / projected_pos.w + rotation_matrix * (a_offset / 32.0 * max(a_minFontScale, fontScale) + a_pxoffset) * projectionScaling, z, 1.0);
    if (u_pitch_with_map) {
        finalPos = projectTileWithElevation(finalPos.xy, finalPos.z);
    }
    float gamma_scale = finalPos.w;
    gl_Position = finalPos;
${hooks.tail}
}
`;
}

/** Uniforms every symbol program needs regardless of its binders. */
function symbolTileUniformSlots(): Record<string, {value: unknown}> {
    return {
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
        u_translation: {value: new Vector2()},
        u_texture: {value: null},
    };
}

export function createSymbolIconMaterial(
    binders: ReadonlyArray<BinderDescription>,
    hasTerrain: boolean,
    isGlobe: boolean,
): RawShaderMaterial {
    return new RawShaderMaterial({
        vertexShader: `${symbolVertexPreamble(isGlobe)}

varying vec2 v_tex;
varying float v_total_opacity;
${vertexDeclarations(binders)}
${UNPACK_GLSL}
${UNPACK_OPACITY_GLSL}
${terrainGlsl(hasTerrain)}
${projectionGlsl(isGlobe)}
${symbolVertexMain(binders, hasTerrain, isGlobe, {
    storeOpacity: '    v_total_opacity = total_opacity;',
    tail: '\n    v_tex = a_tex / u_texsize;',
})}`,
        // Body verbatim from src/shaders/symbol_icon.fragment.glsl.
        fragmentShader: `
precision highp float;
uniform sampler2D u_texture;

varying vec2 v_tex;
varying float v_total_opacity;
${fragmentDeclarations(binders)}

void main() {
${fragmentInitializers(binders)}
    gl_FragColor = texture2D(u_texture, v_tex) * v_total_opacity;
}
`,
        uniforms: {
            ...symbolTileUniformSlots(),
            ...uniformSlots(binders),
            ...(hasTerrain ? terrainUniformSlots() : {}),
            ...(isGlobe ? {u_pitched_scale: {value: 1}, ...globeUniformSlots()} : {}),
        },
    });
}

export function createSymbolSdfMaterial(
    binders: ReadonlyArray<BinderDescription>,
    hasTerrain: boolean,
    isGlobe: boolean,
): RawShaderMaterial {
    return new RawShaderMaterial({
        vertexShader: `${symbolVertexPreamble(isGlobe)}

varying vec2 v_data0;
varying vec3 v_data1;
${vertexDeclarations(binders)}
${UNPACK_GLSL}
${UNPACK_OPACITY_GLSL}
${terrainGlsl(hasTerrain)}
${projectionGlsl(isGlobe)}
${symbolVertexMain(binders, hasTerrain, isGlobe, {
    tail: '\n    v_data0 = a_tex / u_texsize;\n    v_data1 = vec3(gamma_scale, size, total_opacity);',
})}`,
        // Body verbatim from src/shaders/symbol_sdf.fragment.glsl.
        fragmentShader: `
precision highp float;
#define SDF_PX 8.0

uniform bool u_is_halo;
uniform sampler2D u_texture;
uniform highp float u_gamma_scale;
uniform lowp float u_device_pixel_ratio;
uniform bool u_is_text;

varying vec2 v_data0;
varying vec3 v_data1;
${fragmentDeclarations(binders)}

void main() {
${fragmentInitializers(binders)}

    float EDGE_GAMMA = 0.105 / u_device_pixel_ratio;

    vec2 tex = v_data0.xy;
    float gamma_scale = v_data1.x;
    float size = v_data1.y;
    float total_opacity = v_data1[2];

    float fontScale = u_is_text ? size / 24.0 : size;

    lowp vec4 color = fill_color;
    highp float gamma = EDGE_GAMMA / (fontScale * u_gamma_scale);
    lowp float inner_edge = (256.0 - 64.0) / 256.0;
    if (u_is_halo) {
        color = halo_color;
        gamma = (halo_blur * 1.19 / SDF_PX + EDGE_GAMMA) / (fontScale * u_gamma_scale);
        inner_edge = inner_edge + gamma * gamma_scale;
    }

    lowp float dist = texture2D(u_texture, tex).a;
    highp float gamma_scaled = gamma * gamma_scale;
    highp float alpha = smoothstep(inner_edge - gamma_scaled, inner_edge + gamma_scaled, dist);
    if (u_is_halo) {
        // When drawing halos, we want the inside of the halo to be transparent as well
        // in case the text fill is transparent.
        lowp float halo_edge = (6.0 - halo_width / fontScale) / SDF_PX;
        alpha = min(smoothstep(halo_edge - gamma_scaled, halo_edge + gamma_scaled, dist), 1.0 - alpha);
    }

    gl_FragColor = color * (alpha * total_opacity);
}
`,
        uniforms: {
            ...symbolTileUniformSlots(),
            u_gamma_scale: {value: 1},
            u_device_pixel_ratio: {value: 1},
            u_is_halo: {value: 0},
            ...uniformSlots(binders),
            ...(hasTerrain ? terrainUniformSlots() : {}),
            ...(isGlobe ? {u_pitched_scale: {value: 1}, ...globeUniformSlots()} : {}),
        },
    });
}

/**
 * One material per program key, built on demand.
 *
 * Bounded by the number of distinct paint *shapes* in a style, not by tiles or
 * layers, so it needs no eviction.
 */
export class SymbolMaterialCache {
    private readonly _materials = new Map<string, RawShaderMaterial>();

    constructor(
        private readonly _create: (
            binders: ReadonlyArray<BinderDescription>,
            hasTerrain: boolean,
            isGlobe: boolean,
        ) => RawShaderMaterial,
    ) {}

    get(
        binders: ReadonlyArray<BinderDescription>,
        hasTerrain: boolean,
        isGlobe: boolean,
    ): RawShaderMaterial {
        const key = symbolProgramKey(binders, hasTerrain, isGlobe);
        let material = this._materials.get(key);
        if (!material) {
            material = this._create(binders, hasTerrain, isGlobe);
            this._materials.set(key, material);
        }
        return material;
    }

    dispose(): void {
        for (const material of this._materials.values()) material.dispose();
        this._materials.clear();
    }
}
