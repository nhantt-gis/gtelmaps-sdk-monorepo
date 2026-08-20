import {RawShaderMaterial, Vector2} from 'three';

import {PATTERN_POS_GLSL} from './fill_pattern_program';
import {globeUniformSlots, projectionGlsl} from './projection_globe';

/**
 * The `background-pattern` material.
 *
 * ## Not the same shape as `fill-pattern`, despite the name
 *
 * `fill-pattern` carries its atlas rectangles as a **pair of per-feature vertex
 * buffers** chosen by the crossfade state, because a fill's pattern can vary by
 * feature. A background has no features and no bucket, so upstream uses the
 * older, simpler shape: every value is a uniform, and the two crossfade halves
 * are spelled out as `_a`/`_b` pairs mixed by `u_mix`.
 *
 * That means this program shares **only** `get_pattern_pos` with the fill
 * family, and none of `paint_binders.ts`. Reaching for the binder machinery here
 * would be building the general case for a layer that cannot use it.
 *
 * ## Why `u_tile_units_to_pixels` is a uniform and not derived here
 *
 * It is `1 / pixelsToTileUnits(tile, 1, transform.tileZoom)` — note **tileZoom**,
 * not `zoom`. The two differ while zooming, and using the wrong one makes the
 * pattern breathe against the map during a zoom rather than staying pinned to
 * it. `bgPatternUniformValues` is reused whole for exactly this class of reason.
 */
export function createBackgroundPatternMaterial(isGlobe: boolean): RawShaderMaterial {
    return new RawShaderMaterial({
        uniforms: {
            ...(isGlobe ? globeUniformSlots() : {}),
            u_image: {value: null},
            u_opacity: {value: 1},
            u_mix: {value: 0},
            u_texsize: {value: new Vector2()},
            u_pattern_tl_a: {value: new Vector2()},
            u_pattern_br_a: {value: new Vector2()},
            u_pattern_tl_b: {value: new Vector2()},
            u_pattern_br_b: {value: new Vector2()},
            u_pattern_size_a: {value: new Vector2()},
            u_pattern_size_b: {value: new Vector2()},
            u_scale_a: {value: 1},
            u_scale_b: {value: 1},
            u_tile_units_to_pixels: {value: 1},
            u_pixel_coord_upper: {value: new Vector2()},
            u_pixel_coord_lower: {value: new Vector2()},
        },
        vertexShader: `
precision highp float;

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;

uniform vec2 u_pattern_size_a;
uniform vec2 u_pattern_size_b;
uniform vec2 u_pixel_coord_upper;
uniform vec2 u_pixel_coord_lower;
uniform float u_scale_a;
uniform float u_scale_b;
uniform float u_tile_units_to_pixels;

attribute vec2 a_pos;

varying vec2 v_pos_a;
varying vec2 v_pos_b;
${PATTERN_POS_GLSL}
${projectionGlsl(isGlobe)}
void main() {
    gl_Position = projectTile(a_pos);

    v_pos_a = get_pattern_pos(u_pixel_coord_upper, u_pixel_coord_lower, u_scale_a * u_pattern_size_a, u_tile_units_to_pixels, a_pos);
    v_pos_b = get_pattern_pos(u_pixel_coord_upper, u_pixel_coord_lower, u_scale_b * u_pattern_size_b, u_tile_units_to_pixels, a_pos);
}`,
        fragmentShader: `
precision highp float;

uniform vec2 u_pattern_tl_a;
uniform vec2 u_pattern_br_a;
uniform vec2 u_pattern_tl_b;
uniform vec2 u_pattern_br_b;
uniform vec2 u_texsize;
uniform float u_mix;
uniform float u_opacity;

uniform sampler2D u_image;

varying vec2 v_pos_a;
varying vec2 v_pos_b;

void main() {
    vec2 imagecoord = mod(v_pos_a, 1.0);
    vec2 pos = mix(u_pattern_tl_a / u_texsize, u_pattern_br_a / u_texsize, imagecoord);
    vec4 color1 = texture2D(u_image, pos);

    vec2 imagecoord_b = mod(v_pos_b, 1.0);
    vec2 pos2 = mix(u_pattern_tl_b / u_texsize, u_pattern_br_b / u_texsize, imagecoord_b);
    vec4 color2 = texture2D(u_image, pos2);

    gl_FragColor = mix(color1, color2, u_mix) * u_opacity;
}`,
    });
}

/** What `bgPatternUniformValues` returns, as far as this material cares. */
export type BackgroundPatternUniforms = {
    u_pattern_tl_a: [number, number];
    u_pattern_br_a: [number, number];
    u_pattern_tl_b: [number, number];
    u_pattern_br_b: [number, number];
    u_texsize: [number, number];
    u_mix: number;
    u_pattern_size_a: [number, number];
    u_pattern_size_b: [number, number];
    u_scale_a: number;
    u_scale_b: number;
    u_tile_units_to_pixels: number;
    u_pixel_coord_upper: [number, number];
    u_pixel_coord_lower: [number, number];
    u_opacity: number;
};

/**
 * Copies MapLibre's computed uniform values onto the material.
 *
 * Written as a transfer rather than a recomputation on purpose: every value here
 * comes from `bgPatternUniformValues`, and the failure mode of re-deriving any
 * of them is a pattern that is merely *offset* or *scaled* — wrong in a way no
 * single frame looks broken by.
 */
export function applyBackgroundPatternUniforms(
    material: RawShaderMaterial,
    values: BackgroundPatternUniforms,
): void {
    const uniforms = material.uniforms;
    (uniforms.u_pattern_tl_a.value as Vector2).fromArray(values.u_pattern_tl_a);
    (uniforms.u_pattern_br_a.value as Vector2).fromArray(values.u_pattern_br_a);
    (uniforms.u_pattern_tl_b.value as Vector2).fromArray(values.u_pattern_tl_b);
    (uniforms.u_pattern_br_b.value as Vector2).fromArray(values.u_pattern_br_b);
    (uniforms.u_texsize.value as Vector2).fromArray(values.u_texsize);
    (uniforms.u_pattern_size_a.value as Vector2).fromArray(values.u_pattern_size_a);
    (uniforms.u_pattern_size_b.value as Vector2).fromArray(values.u_pattern_size_b);
    (uniforms.u_pixel_coord_upper.value as Vector2).fromArray(values.u_pixel_coord_upper);
    (uniforms.u_pixel_coord_lower.value as Vector2).fromArray(values.u_pixel_coord_lower);
    uniforms.u_mix.value = values.u_mix;
    uniforms.u_scale_a.value = values.u_scale_a;
    uniforms.u_scale_b.value = values.u_scale_b;
    uniforms.u_tile_units_to_pixels.value = values.u_tile_units_to_pixels;
    uniforms.u_opacity.value = values.u_opacity;
}
