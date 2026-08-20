import {ExternalTexture, Matrix4, Vector4} from 'three';

import type {RawShaderMaterial} from 'three';
import type {TerrainData} from '../../render/terrain';

/**
 * Elevation for the layers terrain does **not** draw through the render pool.
 *
 * ## Two terrain paths, and this is the other one
 *
 * §9 migrated the six layer types `RenderToTexture` composites — `background`,
 * `fill`, `line`, `raster`, `hillshade`, `color-relief`. Those are drawn
 * **flat** into a pool object and lifted afterwards by the terrain mesh, so
 * their shaders never read an elevation.
 *
 * `circle`, `symbol`, `heatmap` and `fill-extrusion` are drawn **live**, into
 * the frame, and have to raise each vertex themselves. That is what upstream's
 * `#ifdef TERRAIN3D` block does, and it is the last structural piece of the
 * render tier that this backend stubbed out rather than ported.
 *
 * ## Two textures, on units Three chooses
 *
 * `u_terrain` is the DEM of the covering source tile; `u_depth` is the terrain
 * depth buffer, used to fade geometry that has a hill in front of it.
 * `getTerrainData` reports them as the literal units `3` and `2` because
 * `Program.draw` binds them there itself — **those numbers are dropped here**,
 * exactly as `raster_program.ts` drops `u_image0`/`u_image1`. Three assigns its
 * own units and writes them.
 *
 * Both arrive as raw `WebGLTexture`s with no MapLibre wrapper, which is the
 * shape that made the image atlas sample opaque black (§6.4). It is safe here,
 * and checked rather than assumed: `terrain.ts` calls bind with NEAREST and
 * CLAMP_TO_EDGE on the DEM texture and on both framebuffer textures **at
 * creation**, so they reach Three already complete — the same reason the line
 * atlas is safe.
 */

/** `ele`, `get_elevation`, `depthOpacity` and `calculate_visibility`, verbatim. */
const TERRAIN_GLSL = `
uniform sampler2D u_terrain;
uniform float u_terrain_dim;
uniform mat4 u_terrain_matrix;
uniform vec4 u_terrain_unpack;
uniform float u_terrain_exaggeration;
uniform highp sampler2D u_depth;

const highp vec4 bitSh = vec4(256. * 256. * 256., 256. * 256., 256., 1.);
const highp vec4 bitShifts = vec4(1.) / bitSh;

highp float unpack(highp vec4 color) {
   return dot(color , bitShifts);
}

highp float depthOpacity(vec3 frag) {
    highp float d = unpack(texture2D(u_depth, frag.xy * 0.5 + 0.5)) + 0.0001 - frag.z;
    return 1.0 - max(0.0, min(1.0, -d * 500.0));
}

float calculate_visibility(vec4 pos) {
    vec3 frag = pos.xyz / pos.w;
    highp float d = depthOpacity(frag);
    if (d > 0.95) return 1.0;
    return (d + depthOpacity(frag + vec3(0.0, 0.01, 0.0))) / 2.0;
}

float ele(vec2 pos) {
    vec4 rgb = (texture2D(u_terrain, pos) * 255.0) * u_terrain_unpack;
    return rgb.r + rgb.g + rgb.b - u_terrain_unpack.a;
}

float get_elevation(vec2 pos) {
    vec2 coord = (u_terrain_matrix * vec4(pos, 0.0, 1.0)).xy * u_terrain_dim + 1.0;
    vec2 f = fract(coord);
    vec2 c = (floor(coord) + 0.5) / (u_terrain_dim + 2.0);
    float d = 1.0 / (u_terrain_dim + 2.0);
    float tl = ele(c);
    float tr = ele(c + vec2(d, 0.0));
    float bl = ele(c + vec2(0.0, d));
    float br = ele(c + vec2(d, d));
    float elevation = mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
    return elevation * u_terrain_exaggeration;
}
`;

/**
 * The `#else` halves, as functions rather than as nothing.
 *
 * Upstream's `get_elevation` returns `0.0` and `calculate_visibility` returns
 * `1.0` when `TERRAIN3D` is undefined, so the shader body is written **once**
 * and calls them either way. Emitting the same two stubs here means the ported
 * bodies stay byte-comparable with upstream instead of growing a branch — the
 * same argument as `projectLineThickness` in `projection_globe.ts`.
 */
const NO_TERRAIN_GLSL = `
float calculate_visibility(vec4 pos) {
    return 1.0;
}

float get_elevation(vec2 pos) {
    return 0.0;
}
`;

/** The elevation GLSL for one variant. */
export function terrainGlsl(hasTerrain: boolean): string {
    return hasTerrain ? TERRAIN_GLSL : NO_TERRAIN_GLSL;
}

/**
 * The uniform slots a terrain variant needs.
 *
 * Absent from the flat variant entirely, for the reason `globeUniformSlots`
 * gives: a slot that exists and is never written cannot be told apart from one
 * written wrongly.
 */
export function terrainUniformSlots(): Record<string, {value: unknown}> {
    return {
        u_terrain: {value: null},
        u_depth: {value: null},
        u_terrain_dim: {value: 1},
        u_terrain_matrix: {value: new Matrix4()},
        u_terrain_unpack: {value: new Vector4()},
        u_terrain_exaggeration: {value: 1},
    };
}

/** One `ExternalTexture` per raw handle, shared by every renderer. */
const wrappers = new WeakMap<WebGLTexture, ExternalTexture>();

function wrap(texture: WebGLTexture): ExternalTexture {
    let wrapped = wrappers.get(texture);
    if (!wrapped) {
        wrapped = new ExternalTexture(texture);
        wrappers.set(texture, wrapped);
    }
    return wrapped;
}

/**
 * Copies MapLibre's own `getTerrainData` output onto a terrain material.
 *
 * Call once per tile: `u_terrain_matrix` and the DEM texture are both
 * per-tile — the matrix maps that tile's in-tile coordinates into the covering
 * DEM tile, and neighbouring tiles routinely resolve to different DEM tiles.
 * Hoisting it out of the loop samples every tile through the first tile's DEM,
 * which produces a plausible landscape at the wrong height.
 */
export function applyTerrainData(material: RawShaderMaterial, data: TerrainData): void {
    const uniforms = material.uniforms;
    uniforms.u_terrain.value = wrap(data.texture);
    uniforms.u_depth.value = wrap(data.depthTexture);
    uniforms.u_terrain_dim.value = data.u_terrain_dim;
    (uniforms.u_terrain_matrix.value as Matrix4)
        .fromArray(data.u_terrain_matrix as unknown as ArrayLike<number>);
    (uniforms.u_terrain_unpack.value as Vector4).fromArray(data.u_terrain_unpack);
    uniforms.u_terrain_exaggeration.value = data.u_terrain_exaggeration;
}
