import {GLSL3, RawShaderMaterial, Vector2, Vector4} from 'three';

import {globeUniformSlots, projectionGlsl} from './projection_globe';

/**
 * The `color-relief` material — MapLibre's `colorRelief` program.
 *
 * ## The first material that must be GLSL ES 3.00
 *
 * Every other material in this backend is written in GLSL ES 1.00 —
 * `attribute`/`varying`/`texture2D`/`gl_FragColor` — which WebGL2 still accepts,
 * and which keeps them readable next to the ported shaders.
 *
 * This one cannot be. The fragment shader binary-searches the elevation ramp:
 *
 * ```glsl
 * while (r - l > 1) { ... }
 * ```
 *
 * GLSL ES 1.00 requires loop bounds a compiler can unroll — a `while` on a
 * value computed at runtime does not compile there. Rewriting it as a fixed
 * `for` with an early break would change the search into something that happens
 * to agree for the ramp sizes tried, so the shader is left alone and the version
 * is raised instead, via `glslVersion: GLSL3`.
 *
 * With `GLSL3` on a `RawShaderMaterial`, Three emits only the `#version`
 * directive: the `in`/`out` declarations and the output variable are all
 * written here.
 *
 * ## Three textures, all safe
 *
 * The DEM, the elevation-stop ramp and the colour-stop ramp are all MapLibre
 * `Texture` objects whose `bind(filter, wrap)` the draw loop calls explicitly,
 * so none of them reaches Three with the incomplete-texture parameters that made
 * the image atlas sample opaque black (§6.4).
 *
 * ## The shared projection GLSL is version-agnostic, and that is checked
 *
 * `projectionGlsl` is written for the GLSL ES 1.00 materials, and this is the
 * one material that compiles as 3.00. It drops in unchanged because it uses no
 * construct the two versions spell differently — no `attribute`, no `varying`,
 * no `texture2D`, only uniforms, `vec`/`mat` arithmetic and plain functions.
 * Stated rather than assumed: a shader that fails to compile here would fail as
 * a **dead frame**, the failure mode §14 spent a step learning to recognise.
 */
export function createColorReliefMaterial(isGlobe: boolean): RawShaderMaterial {
    return new RawShaderMaterial({
        glslVersion: GLSL3,
        // Body from src/shaders/color_relief.vertex.glsl.
        vertexShader: `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform vec2 u_dimension;

in vec2 a_pos;

out vec2 v_pos;
${projectionGlsl(isGlobe)}
void main() {
    gl_Position = projectTile(a_pos, a_pos);
    highp vec2 epsilon = 1.0 / u_dimension;
    float scale = (u_dimension.x - 2.0) / u_dimension.x;
    v_pos = (a_pos / 8192.0) * scale + epsilon;
    if (a_pos.y < -32767.5) {
        v_pos.y = 0.0;
    }
    if (a_pos.y > 32766.5) {
        v_pos.y = 1.0;
    }
}
`,
        // Body from src/shaders/color_relief.fragment.glsl, verbatim including
        // the binary search — see the module comment.
        fragmentShader: `
precision highp float;

uniform sampler2D u_image;
uniform vec4 u_unpack;
uniform sampler2D u_elevation_stops;
uniform sampler2D u_color_stops;
uniform int u_color_ramp_size;
uniform float u_opacity;

in vec2 v_pos;
out vec4 fragColor;

float getElevation(vec2 coord) {
    vec4 data = texture(u_image, coord) * 255.0;
    data.a = -1.0;
    return dot(data, u_unpack);
}

float getElevationStop(int stop) {
    float x = (float(stop)+0.5)/float(u_color_ramp_size);
    vec4 data = texture(u_elevation_stops, vec2(x, 0)) * 255.0;
    data.a = -1.0;
    return dot(data, u_unpack);
}

void main() {
    float el = getElevation(v_pos);

    int r = (u_color_ramp_size - 1);
    int l = 0;
    float el_l = getElevationStop(l);
    float el_r = getElevationStop(r);
    while(r - l > 1)
    {
        int m = (r + l) / 2;
        float el_m = getElevationStop(m);
        if(el < el_m)
        {
            r = m;
            el_r = el_m;
        }
        else
        {
            l = m;
            el_l = el_m;
        }
    }

    float x = (float(l) + (el - el_l) / (el_r - el_l) + 0.5)/float(u_color_ramp_size);
    fragColor = u_opacity*texture(u_color_stops, vec2(x, 0));
}
`,
        uniforms: {
            u_image: {value: null},
            u_unpack: {value: new Vector4()},
            u_dimension: {value: new Vector2()},
            u_elevation_stops: {value: null},
            u_color_stops: {value: null},
            u_color_ramp_size: {value: 1},
            u_opacity: {value: 1},
            ...(isGlobe ? globeUniformSlots() : {}),
        },
    });
}

/**
 * Copies MapLibre's own `colorReliefUniformValues` output onto the material.
 *
 * The three sampler uniforms are skipped: upstream writes the literal unit
 * numbers `0`, `1` and `4`, while Three assigns units itself. Unit `4` in
 * particular is a number nothing here should be repeating.
 */
export function applyColorReliefUniforms(
    material: RawShaderMaterial,
    values: Record<string, unknown>,
): void {
    for (const [name, value] of Object.entries(values)) {
        if (name === 'u_image' || name === 'u_elevation_stops' || name === 'u_color_stops') continue;
        const slot = material.uniforms[name];
        if (!slot) continue;
        if (Array.isArray(value)) {
            (slot.value as {fromArray(a: ArrayLike<number>): void}).fromArray(value);
        } else {
            slot.value = value;
        }
    }
}
