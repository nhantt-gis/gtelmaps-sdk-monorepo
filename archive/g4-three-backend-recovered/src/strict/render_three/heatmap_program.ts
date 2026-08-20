import {Matrix4, RawShaderMaterial, Vector2} from 'three';

import type {UniformValues} from '../../render/uniform_binding';
import type {HeatmapTextureUniformsType} from '../../render/program/heatmap_program';

/**
 * Builds the `heatmapTexture` material — the pass that colours the density map.
 *
 * ## One material, no binders, no projection
 *
 * This is the smallest shader in the migration. The kernels were already summed
 * into a framebuffer by the offscreen pass, so this draw is a **single
 * screen-space quad** that samples that framebuffer's red channel, looks the
 * value up in a colour ramp, and multiplies by opacity. Nothing varies per
 * feature and nothing varies per tile.
 *
 * `u_matrix` stays an ordinary uniform rather than riding on `mesh.matrixWorld`
 * the way every other ported layer's matrix does. It is not a projection at all
 * — it is `ortho(0, width, height, 0, 0, 1)`, a screen-space transform with a
 * flipped Y — so routing it through `applyProjectionData` would name it after
 * something it is not. Keeping the shader's own uniform also keeps the body
 * byte-identical to `heatmap_texture.vertex.glsl`.
 *
 * ## The samplers are deliberately absent from the uniform copy
 *
 * `heatmapTextureUniformValues` returns `u_image: 0` and `u_color_ramp: 1`,
 * because upstream binds the textures to those units itself. Here the textures
 * arrive as `ExternalTexture` values and **Three** assigns the units; writing the
 * integers in would point both samplers at whatever Three bound last. Same
 * arrangement as `raster_program.ts` and `color_relief_program.ts`.
 */
export function createHeatmapTextureMaterial(): RawShaderMaterial {
    return new RawShaderMaterial({
        // Body verbatim from src/shaders/heatmap_texture.vertex.glsl.
        vertexShader: `
precision highp float;
uniform mat4 u_matrix;
uniform vec2 u_world;
attribute vec2 a_pos;
varying vec2 v_pos;

void main() {
    gl_Position = u_matrix * vec4(a_pos * u_world, 0, 1);

    v_pos.x = a_pos.x;
    v_pos.y = 1.0 - a_pos.y;
}
`,
        // Body verbatim from src/shaders/heatmap_texture.fragment.glsl, minus
        // the OVERDRAW_INSPECTOR branch — that mode is declined outright.
        fragmentShader: `
precision highp float;
uniform sampler2D u_image;
uniform sampler2D u_color_ramp;
uniform float u_opacity;

varying vec2 v_pos;

void main() {
    float t = texture2D(u_image, v_pos).r;
    vec4 color = texture2D(u_color_ramp, vec2(t, 0.5));
    gl_FragColor = color * u_opacity;
}
`,
        uniforms: {
            u_matrix: {value: new Matrix4()},
            u_world: {value: new Vector2()},
            u_image: {value: null},
            u_color_ramp: {value: null},
            u_opacity: {value: 1},
        },
    });
}

/**
 * Copies MapLibre's own uniform values onto the material, samplers excluded.
 *
 * See the file comment for why `u_image` and `u_color_ramp` are skipped.
 */
export function applyHeatmapTextureUniforms(
    material: RawShaderMaterial,
    values: UniformValues<HeatmapTextureUniformsType>,
): void {
    (material.uniforms.u_matrix.value as Matrix4).fromArray(values.u_matrix as ArrayLike<number>);
    (material.uniforms.u_world.value as Vector2).fromArray(values.u_world as [number, number]);
    material.uniforms.u_opacity.value = values.u_opacity as number;
}
