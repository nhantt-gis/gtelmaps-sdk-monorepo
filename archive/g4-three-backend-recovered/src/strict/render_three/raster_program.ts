import {RawShaderMaterial, Vector2, Vector3, Vector4} from 'three';

import {globeUniformSlots, projectionGlsl} from './projection_globe';

/**
 * The `raster` material — MapLibre's `raster` program.
 *
 * ## The first layer with no paint binders at all
 *
 * Every layer so far carried per-feature paint properties, so most of the work
 * was `paint_binders.ts`: classifying each property and emitting the right
 * attribute, varying or uniform. `raster` has none. A raster tile is one image;
 * there are no features to vary by, and every paint property — opacity,
 * brightness, saturation, contrast, hue rotation — is a plain uniform.
 *
 * So this file has no emitter, no binder key, and one material for the whole
 * map rather than one per paint shape.
 *
 * ## Two textures, and the one thing not to do with them
 *
 * `u_image0` is the tile; `u_image1` is its parent, cross-faded in while the
 * tile loads. Upstream sets these sampler uniforms to the literal unit numbers
 * `0` and `1` and binds the textures to those units itself. **Three must be
 * left to assign the units**: the uniform values here are `ExternalTexture`
 * objects, and Three writes the unit number it chose. Writing `0`/`1` here
 * instead would point both samplers at whatever Three last bound.
 *
 * ## `u_coords_top` / `u_coords_bottom`
 *
 * A raster tile is not always an axis-aligned square: an `ImageSource` may place
 * its four corners anywhere. The vertex shader therefore does not use `a_pos`
 * as a position — it uses it as a *fraction* along the quad, and interpolates
 * between the four corner uniforms. For an ordinary tile the corners are
 * `(0,0)`–`(EXTENT,EXTENT)` and the interpolation is the identity.
 */

/** Uniform slots for one raster material. */
function rasterUniformSlots(isGlobe: boolean): Record<string, {value: unknown}> {
    return {
        ...(isGlobe ? globeUniformSlots() : {}),
        u_tl_parent: {value: new Vector2()},
        u_scale_parent: {value: 1},
        u_buffer_scale: {value: 1},
        u_fade_t: {value: 0},
        u_opacity: {value: 1},
        u_image0: {value: null},
        u_image1: {value: null},
        u_brightness_low: {value: 0},
        u_brightness_high: {value: 1},
        u_saturation_factor: {value: 0},
        u_contrast_factor: {value: 1},
        u_spin_weights: {value: new Vector3()},
        u_coords_top: {value: new Vector4()},
        u_coords_bottom: {value: new Vector4()},
    };
}

/**
 * The pole handling in the fragment coordinates, under globe only.
 *
 * A pole vertex has no meaningful mercator Y, so `v_pos0.y` computed from
 * `a_pos` would be far outside `0..1` and the texture would smear along the
 * whole seam. Upstream clamps it to the tile's own top or bottom edge.
 *
 * The test is on **`a_pos`**, not on the interpolated `position`: the sentinel
 * lives in the raw attribute. They happen to be equal for an ordinary tile —
 * whose corners are `(0,0)..(EXTENT,EXTENT)`, making the interpolation the
 * identity — and only an `ImageSource` makes them differ, which never reaches
 * this variant. Written as upstream writes it so that the equality stays a
 * coincidence rather than a dependency.
 */
const GLOBE_POLE_TEXCOORD_GLSL = `
    // North pole
    if (a_pos.y < -32767.5) {
        v_pos0.y = 0.0;
    }
    // South pole
    if (a_pos.y > 32766.5) {
        v_pos0.y = 1.0;
    }
`;

/**
 * One body, compiled twice — the same seam as `background_layer.ts`.
 *
 * Both variants keep the **pole-kill branch** in `projectTile(vec2, vec2)`: on
 * mercator it costs one comparison and never fires, because a mercator mesh has
 * no pole vertices. Keeping it is what makes the mercator variant a faithful
 * port rather than one that happens to agree on the cases reachable today.
 */
export function createRasterMaterial(isGlobe: boolean): RawShaderMaterial {
    return new RawShaderMaterial({
        // Body from src/shaders/raster.vertex.glsl.
        vertexShader: `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform vec2 u_tl_parent;
uniform float u_scale_parent;
uniform float u_buffer_scale;
uniform vec4 u_coords_top;
uniform vec4 u_coords_bottom;

attribute vec2 a_pos;

varying vec2 v_pos0;
varying vec2 v_pos1;
${projectionGlsl(isGlobe)}
void main() {
    vec2 fractionalPos = a_pos / 8192.0;
    vec2 position = mix(mix(u_coords_top.xy, u_coords_top.zw, fractionalPos.x), mix(u_coords_bottom.xy, u_coords_bottom.zw, fractionalPos.x), fractionalPos.y);
    gl_Position = projectTile(position, position);

    v_pos0 = ((fractionalPos - 0.5) / u_buffer_scale) + 0.5;
${isGlobe ? GLOBE_POLE_TEXCOORD_GLSL : ''}
    v_pos1 = (v_pos0 * u_scale_parent) + u_tl_parent;
}
`,
        // Body from src/shaders/raster.fragment.glsl.
        fragmentShader: `
precision highp float;
uniform float u_fade_t;
uniform float u_opacity;
uniform sampler2D u_image0;
uniform sampler2D u_image1;

varying vec2 v_pos0;
varying vec2 v_pos1;

uniform float u_brightness_low;
uniform float u_brightness_high;

uniform float u_saturation_factor;
uniform float u_contrast_factor;
uniform vec3 u_spin_weights;

void main() {
    vec4 color0 = texture2D(u_image0, v_pos0);
    vec4 color1 = texture2D(u_image1, v_pos1);
    if (color0.a > 0.0) {
        color0.rgb = color0.rgb / color0.a;
    }
    if (color1.a > 0.0) {
        color1.rgb = color1.rgb / color1.a;
    }
    vec4 color = mix(color0, color1, u_fade_t);
    color.a *= u_opacity;
    vec3 rgb = color.rgb;

    rgb = vec3(
        dot(rgb, u_spin_weights.xyz),
        dot(rgb, u_spin_weights.zxy),
        dot(rgb, u_spin_weights.yzx));

    float average = (color.r + color.g + color.b) / 3.0;
    rgb += (average - rgb) * u_saturation_factor;

    rgb = (rgb - 0.5) * u_contrast_factor + 0.5;

    vec3 u_high_vec = vec3(u_brightness_low, u_brightness_low, u_brightness_low);
    vec3 u_low_vec = vec3(u_brightness_high, u_brightness_high, u_brightness_high);

    gl_FragColor = vec4(mix(u_high_vec, u_low_vec, rgb) * color.a, color.a);
}
`,
        uniforms: rasterUniformSlots(isGlobe),
    });
}

/**
 * Copies MapLibre's own `rasterUniformValues` output onto the material.
 *
 * The value function is imported rather than reimplemented: `spinWeights`,
 * `contrastFactor` and `saturationFactor` are three formulas whose wrong
 * versions all produce a picture — a slightly different hue, a slightly flatter
 * image — and none of them an error.
 *
 * `u_image0` and `u_image1` are skipped on purpose; see the module comment.
 */
export function applyRasterUniforms(
    material: RawShaderMaterial,
    values: Record<string, unknown>,
): void {
    for (const [name, value] of Object.entries(values)) {
        if (name === 'u_image0' || name === 'u_image1') continue;
        const slot = material.uniforms[name];
        if (!slot) continue;
        if (Array.isArray(value)) {
            (slot.value as {fromArray(a: ArrayLike<number>): void}).fromArray(value);
        } else {
            slot.value = value;
        }
    }
}
