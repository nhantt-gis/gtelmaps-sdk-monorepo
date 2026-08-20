import {RawShaderMaterial, Vector2, Vector3, Vector4} from 'three';

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
import {PATTERN_POS_GLSL} from './fill_pattern_program';

/**
 * The `fill-extrusion-pattern` material.
 *
 * ## Not a variant of the plain fill-extrusion program
 *
 * The two shaders share the *lighting arithmetic* and nothing else structural,
 * and even the lighting lands somewhere different:
 *
 * | | plain | pattern |
 * |---|---|---|
 * | binders | `base`, `height`, **`color`** | `base`, `height`, **four pattern binders** |
 * | varying | `v_color` — colour and light already combined | `v_lighting` — light alone |
 * | fragment | writes `v_color` | samples the atlas twice, multiplies by `v_lighting` |
 * | `colorvalue` | relative luminance steers the directional term | **absent** — there is no colour to take luminance of |
 *
 * That last row is the one that would be easy to carry across by habit. The
 * plain shader narrows its highlight range using the surface's own brightness
 * (`mix((1.0 - u_lightintensity), max((1.0 - colorvalue + u_lightintensity), 1.0), directional)`);
 * the pattern shader cannot, and uses `max((0.5 + u_lightintensity), 1.0)`
 * instead. Copying the plain form here compiles, runs, and is wrong only in how
 * bright the lit faces are — which is exactly the kind of defect a fixture
 * catches and a reading does not.
 *
 * ## The `pos` that feeds the pattern is not the vertex position
 *
 * A wall's pattern has to run *up* the wall, not across the map, so the
 * coordinate handed to `get_pattern_pos` is chosen per face:
 *
 * ```glsl
 * vec2 pos = normal.x == 1.0 && normal.y == 0.0 && normal.z == 16384.0
 *     ? a_pos                                        // roof
 *     : vec2(edgedistance, elevation * u_height_factor);  // wall
 * ```
 *
 * Note the roof branch uses `a_pos` **without** `u_fill_translate`: translating
 * the building must not slide the pattern across its own roof.
 *
 * ## Declined here, as in the plain program
 *
 * `GLOBE`, `TERRAIN3D` (and with it `a_centroid` and the second vertex buffer),
 * and `OVERDRAW_INSPECTOR`.
 */

/**
 * Paint properties this shader reads.
 *
 * Six binders, four of which come from the **same** style property:
 * `fill-extrusion-pattern` yields `pattern_from`, `pattern_to`,
 * `pixel_ratio_from` and `pixel_ratio_to`. Unlike the plain program there is no
 * `color` binder at all — the pattern *is* the colour.
 *
 * `base` and `height` are `lowp` here and `highp` in the plain shader. That is
 * upstream's own inconsistency, kept rather than tidied: precision qualifiers
 * change how a value rounds, and matching upstream exactly is the whole contract
 * of this port.
 */
export const FILL_EXTRUSION_PATTERN_SPECS: ReadonlyArray<PaintPropertySpec> = [
    // **Vertex only**, even though upstream's fragment shader declares them —
    // matching the plain program, whose `color` binder is vertex-only for the
    // same reason: the vertex body *assigns* to `base` and `height`, and a
    // binder marked `inFragment` is emitted as a varying that the initializer
    // assigns rather than a local. The fragment reads neither value for
    // anything, so the interpolators would be spent for nothing.
    //
    // Stated carefully because the first version of this comment claimed the
    // measured wall collapse came from here. It did not: a *constant* binder
    // takes the uniform branch and never touches a varying, and flipping this
    // flag produced byte-identical output. The collapse was `_setConstantUniforms`
    // being skipped wholesale for the pattern path, leaving `u_base` and
    // `u_height` at zero.
    {property: 'fill-extrusion-base', name: 'base', glslType: 'float', precision: 'lowp', inFragment: false},
    {property: 'fill-extrusion-height', name: 'height', glslType: 'float', precision: 'lowp', inFragment: false},
    {property: 'fill-extrusion-pattern', name: 'pattern_from', glslType: 'vec4', precision: 'lowp', inFragment: true},
    {property: 'fill-extrusion-pattern', name: 'pattern_to', glslType: 'vec4', precision: 'lowp', inFragment: true},
    {property: 'fill-extrusion-pattern', name: 'pixel_ratio_from', glslType: 'float', precision: 'lowp', inFragment: true},
    {property: 'fill-extrusion-pattern', name: 'pixel_ratio_to', glslType: 'float', precision: 'lowp', inFragment: true},
];

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

/** Upstream's `#ifdef TERRAIN3D` offsets, verbatim. */
const TERRAIN_OFFSETS_GLSL = `    float height_terrain3d_offset = get_elevation(a_centroid);
    float base_terrain3d_offset = height_terrain3d_offset - (base > 0.0 ? 0.0 : 10.0);`;

/** And its `#else` half, so the two lines that use them are written once. */
const FLAT_OFFSETS_GLSL = `    float height_terrain3d_offset = 0.0;
    float base_terrain3d_offset = 0.0;`;

export function createFillExtrusionPatternMaterial(
    binders: ReadonlyArray<BinderDescription>,
    hasTerrain: boolean,
    isGlobe: boolean,
): RawShaderMaterial {
    return new RawShaderMaterial({
        // Body from src/shaders/fill_extrusion_pattern.vertex.glsl, with the
        // GLOBE and TERRAIN3D branches removed — see the file comment.
        vertexShader: `
precision highp float;

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;

uniform vec2 u_pixel_coord_upper;
uniform vec2 u_pixel_coord_lower;
uniform float u_height_factor;
uniform vec3 u_scale;
uniform float u_vertical_gradient;
uniform lowp float u_opacity;
uniform vec2 u_fill_translate;
uniform vec3 u_lightcolor;
uniform lowp vec3 u_lightpos;
${isGlobe ? 'uniform lowp vec3 u_lightpos_globe;' : ''}
uniform lowp float u_lightintensity;

attribute vec2 a_pos;
attribute vec4 a_normal_ed;
${hasTerrain ? 'attribute vec2 a_centroid;' : ''}

varying vec2 v_pos_a;
varying vec2 v_pos_b;
varying vec4 v_lighting;
${vertexDeclarations(binders)}
${UNPACK_GLSL}
${terrainGlsl(hasTerrain)}
${projectionGlsl(isGlobe)}
${PATTERN_POS_GLSL}
void main() {
${vertexInitializers(binders)}

    vec2 pattern_tl_a = pattern_from.xy;
    vec2 pattern_br_a = pattern_from.zw;
    vec2 pattern_tl_b = pattern_to.xy;
    vec2 pattern_br_b = pattern_to.zw;

    float tileRatio = u_scale.x;
    float fromScale = u_scale.y;
    float toScale = u_scale.z;

    vec3 normal = a_normal_ed.xyz;
    float edgedistance = a_normal_ed.w;

    vec2 display_size_a = (pattern_br_a - pattern_tl_a) / pixel_ratio_from;
    vec2 display_size_b = (pattern_br_b - pattern_tl_b) / pixel_ratio_to;

    // Without TERRAIN3D both offsets are 0.0, so only the ground-level clamp
    // survives. Terrain is declined before this material is selected.
    // Raise the "ceiling" by the elevation of the centroid, and lower the
    // "floor" of ground-level elements by a further 10 m so a building on a
    // slope gets a basement instead of hanging in the air. Both are 0.0 in the
    // flat variant, so the two lines below are upstream's verbatim.
${hasTerrain ? TERRAIN_OFFSETS_GLSL : FLAT_OFFSETS_GLSL}
    base = max(0.0, base) + base_terrain3d_offset;
    height = max(0.0, height) + height_terrain3d_offset;

    float t = mod(normal.x, 2.0);
    float elevation = t > 0.0 ? height : base;
    vec2 posInTile = a_pos + u_fill_translate;

${isGlobe ?
    '    vec3 spherePos = projectToSphere(posInTile, a_pos);\n' +
        '    gl_Position = interpolateProjectionFor3D(posInTile, spherePos, elevation);' :
    '    gl_Position = projectTileFor3D(posInTile, elevation);'}

    vec2 pos = normal.x == 1.0 && normal.y == 0.0 && normal.z == 16384.0
        ? a_pos // extrusion top - note the lack of u_fill_translate, because translation should not affect the pattern
        : vec2(edgedistance, elevation * u_height_factor); // extrusion side

    v_pos_a = get_pattern_pos(u_pixel_coord_upper, u_pixel_coord_lower, fromScale * display_size_a, tileRatio, pos);
    v_pos_b = get_pattern_pos(u_pixel_coord_upper, u_pixel_coord_lower, toScale * display_size_b, tileRatio, pos);

    v_lighting = vec4(0.0, 0.0, 0.0, 1.0);
    float directional = clamp(dot(normal / 16383.0, u_lightpos), 0.0, 1.0);
    directional = mix((1.0 - u_lightintensity), max((0.5 + u_lightintensity), 1.0), directional);

    if (normal.y != 0.0) {
        directional *= (
            (1.0 - u_vertical_gradient) +
            (u_vertical_gradient * clamp((t + base) * pow(height / 150.0, 0.5), mix(0.7, 0.98, 1.0 - u_lightintensity), 1.0)));
    }

    v_lighting.rgb += clamp(directional * u_lightcolor, mix(vec3(0.0), vec3(0.3), 1.0 - u_lightcolor), vec3(1.0));
    v_lighting *= u_opacity;
}
`,
        // Body verbatim from src/shaders/fill_extrusion_pattern.fragment.glsl.
        fragmentShader: `
precision highp float;

uniform vec2 u_texsize;
uniform float u_fade;
uniform sampler2D u_image;

varying vec2 v_pos_a;
varying vec2 v_pos_b;
varying vec4 v_lighting;
${fragmentDeclarations(binders)}
${UNPACK_GLSL}
void main() {
${fragmentInitializers(binders)}

    vec2 pattern_tl_a = pattern_from.xy;
    vec2 pattern_br_a = pattern_from.zw;
    vec2 pattern_tl_b = pattern_to.xy;
    vec2 pattern_br_b = pattern_to.zw;

    vec2 imagecoord = mod(v_pos_a, 1.0);
    vec2 pos = mix(pattern_tl_a / u_texsize, pattern_br_a / u_texsize, imagecoord);
    vec4 color1 = texture2D(u_image, pos);

    vec2 imagecoord_b = mod(v_pos_b, 1.0);
    vec2 pos2 = mix(pattern_tl_b / u_texsize, pattern_br_b / u_texsize, imagecoord_b);
    vec4 color2 = texture2D(u_image, pos2);

    vec4 mixedColor = mix(color1, color2, u_fade);

    gl_FragColor = mixedColor * v_lighting;
}
`,
        uniforms: {
            u_lightcolor: {value: new Vector3()},
            u_lightpos: {value: new Vector3()},
            u_lightintensity: {value: 0},
            u_vertical_gradient: {value: 0},
            u_opacity: {value: 1},
            u_fill_translate: {value: new Vector2()},
            u_height_factor: {value: 0},
            u_scale: {value: new Vector3()},
            u_fade: {value: 0},
            u_texsize: {value: new Vector2()},
            u_pixel_coord_upper: {value: new Vector2()},
            u_pixel_coord_lower: {value: new Vector2()},
            u_image: {value: null},
            ...uniformSlots(binders),
            ...(hasTerrain ? terrainUniformSlots() : {}),
            ...(isGlobe ? {u_lightpos_globe: {value: new Vector3()}, ...globeUniformSlots()} : {}),
        },
    });
}
