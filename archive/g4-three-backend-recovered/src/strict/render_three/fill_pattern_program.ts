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
import {OUTLINE_GLOBE_CLIP_GLSL} from './fill_program';

/**
 * The `fill-pattern` materials, for constant and per-feature patterns alike.
 *
 * ## One material for both data paths
 *
 * A per-feature pattern stores its atlas rectangles in a *pair* of
 * zoom-specific vertex buffers, chosen per frame by the crossfade state; a
 * constant one puts the same rectangles in uniforms. The **shader is identical
 * either way** — see `paint_binders.ts` on shape versus data path — so one
 * emitter serves both, and the difference lives entirely in the draw loop.
 *
 * That was not obvious in advance: the two cases were built as separate
 * materials first, and collapsing them turned out to be mostly deletion.
 *
 * ## `get_pattern_pos`, copied not derived
 *
 * The prelude's helper folds the tile's world-pixel offset into the pattern's
 * repeat, and it does so through a doubled `mod` because the pixel coordinate
 * arrives split across two 16-bit halves:
 *
 * ```glsl
 * mod(mod(mod(upper, size) * 256.0, size) * 256.0 + lower, size)
 * ```
 *
 * GLSL guarantees only 16 bits of precision for `highp` floats, so at high zoom
 * a single-value pixel coordinate loses the low bits and the pattern crawls
 * against the map as you pan. The split is the fix, and the nested `mod` is what
 * reassembles it without overflowing. Rewriting this "more simply" reintroduces
 * exactly the drift it exists to prevent, and only at zoom levels no fixture
 * covers.
 */

/** Verbatim from `src/shaders/_prelude.vertex.glsl`. */
export const PATTERN_POS_GLSL = `
vec2 get_pattern_pos(const vec2 pixel_coord_upper, const vec2 pixel_coord_lower,
                     const vec2 pattern_size, const float tile_units_to_pixels, const vec2 pos) {
    vec2 offset = mod(mod(mod(pixel_coord_upper, pattern_size) * 256.0, pattern_size) * 256.0 + pixel_coord_lower, pattern_size);
    return (tile_units_to_pixels * pos + offset) / pattern_size;
}
`;

/**
 * Uniform values that vary per tile, gathered so the draw loop reads as data.
 *
 * Mirrors `patternUniformValues` in `src/render/program/pattern.ts`.
 */
export type PatternTileUniforms = {
    texsize: [number, number];
    /** `[tileRatio, crossfade.fromScale, crossfade.toScale]`. */
    scale: [number, number, number];
    fade: number;
    pixelCoordUpper: [number, number];
    pixelCoordLower: [number, number];
};

/**
 * Splits a tile's world-pixel origin into the two 16-bit halves the shader
 * expects, and computes the tile-units-to-pixels ratio alongside.
 *
 * Kept as a pure function because it is arithmetic with no GL in it, and because
 * getting the shift wrong produces a pattern that is merely *offset* — a defect
 * with no error and no obvious wrongness in a single frame.
 */
export function patternTileUniforms(
    tile: {tileID: {overscaledZ: number; canonical: {x: number; y: number}; wrap: number}; tileSize: number},
    tileZoom: number,
    tileRatio: number,
    crossfade: {fromScale: number; toScale: number; t: number},
    atlasSize: [number, number],
): PatternTileUniforms {
    const numTiles = Math.pow(2, tile.tileID.overscaledZ);
    const tileSizeAtNearestZoom = tile.tileSize * Math.pow(2, tileZoom) / numTiles;

    const pixelX = tileSizeAtNearestZoom * (tile.tileID.canonical.x + tile.tileID.wrap * numTiles);
    const pixelY = tileSizeAtNearestZoom * tile.tileID.canonical.y;

    return {
        texsize: atlasSize,
        scale: [tileRatio, crossfade.fromScale, crossfade.toScale],
        fade: crossfade.t,
        // The glsl spec guarantees 16 bits of precision, so the coordinate is
        // carried as two halves and reassembled by `get_pattern_pos`.
        pixelCoordUpper: [pixelX >> 16, pixelY >> 16],
        pixelCoordLower: [pixelX & 0xFFFF, pixelY & 0xFFFF],
    };
}

/**
 * The paint properties a pattern shader reads, as MapLibre's pragmas name them.
 *
 * Four of the five come from the **same** style property: `fill-pattern` yields
 * `pattern_from`, `pattern_to`, `pixel_ratio_from` and `pixel_ratio_to`. Several
 * specs sharing a property is already supported — each classifies from the same
 * paint value — so this needs no special case.
 */
export const PATTERN_SPECS: ReadonlyArray<PaintPropertySpec> = [
    {property: 'fill-opacity', name: 'opacity', glslType: 'float', precision: 'lowp', inFragment: true},
    {property: 'fill-pattern', name: 'pattern_from', glslType: 'vec4', precision: 'lowp', inFragment: true},
    {property: 'fill-pattern', name: 'pattern_to', glslType: 'vec4', precision: 'lowp', inFragment: true},
    // Vertex-only: they scale the pattern before it reaches the fragment stage.
    {property: 'fill-pattern', name: 'pixel_ratio_from', glslType: 'float', precision: 'lowp', inFragment: false},
    {property: 'fill-pattern', name: 'pixel_ratio_to', glslType: 'float', precision: 'lowp', inFragment: false},
];

/**
 * Signature deciding whether two configurations can share a material.
 *
 * The two `variant` flags are discriminators whose **meaning belongs to the
 * creator**, not to the cache: `fill`'s pattern materials use the first for
 * globe and ignore the second, `fill-extrusion`'s use them for terrain and
 * globe. All the key needs to know is that they change the shader source.
 */
export function patternProgramKey(
    binders: ReadonlyArray<BinderDescription>,
    variantA: boolean,
    variantB: boolean,
): string {
    const shape = binders.map((binder) => `${binder.name}:${binder.kind}`).join('|');
    return `${variantA ? 'a' : '-'}${variantB ? 'b' : '-'}|${shape}`;
}

function uniformSlots(binders: ReadonlyArray<BinderDescription>): Record<string, {value: unknown}> {
    const uniforms: Record<string, {value: unknown}> = {};
    for (const binder of binders) {
        if (binder.kind === 'uniform') {
            uniforms[`u_${binder.name}`] = {value: binder.glslType === 'float' ? 1 : new Vector4()};
        } else {
            // Declared even for source expressions, where it stays 0.
            uniforms[`u_${binder.name}_t`] = {value: 0};
        }
    }
    return uniforms;
}

/** Uniforms every pattern program needs regardless of its binders. */
function tileUniformSlots(): Record<string, {value: unknown}> {
    return {
        u_fill_translate: {value: new Vector2()},
        u_pixel_coord_upper: {value: new Vector2()},
        u_pixel_coord_lower: {value: new Vector2()},
        u_scale: {value: new Vector3()},
        u_texsize: {value: new Vector2()},
        u_fade: {value: 0},
        u_image: {value: null},
    };
}

/**
 * Samples the atlas twice and cross-fades.
 *
 * Takes the rectangles as **parameters** rather than reading them from scope.
 *
 * That is not stylistic. When the property is constant the emitters declare it
 * as a local inside `main()`, which a file-scope function cannot see; when it is
 * per-feature they declare a varying, which it can. Reading from scope compiles
 * in one configuration and fails in the other — and it failed in the one that
 * was already green, so the probe caught it as a shader compile error rather
 * than as wrong pixels.
 */
const SAMPLE_ATLAS_GLSL = `
vec4 samplePattern(vec4 pattern_from, vec4 pattern_to) {
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

    return mix(color1, color2, u_fade);
}
`;

/** The shared part of both pattern vertex shaders. */
function patternVertexBody(binders: ReadonlyArray<BinderDescription>): string {
    return `
    vec2 pattern_tl_a = pattern_from.xy;
    vec2 pattern_br_a = pattern_from.zw;
    vec2 pattern_tl_b = pattern_to.xy;
    vec2 pattern_br_b = pattern_to.zw;

    float tileZoomRatio = u_scale.x;
    float fromScale = u_scale.y;
    float toScale = u_scale.z;

    vec2 display_size_a = (pattern_br_a - pattern_tl_a) / pixel_ratio_from;
    vec2 display_size_b = (pattern_br_b - pattern_tl_b) / pixel_ratio_to;

    gl_Position = projectTile(a_pos + u_fill_translate, a_pos);

    v_pos_a = get_pattern_pos(u_pixel_coord_upper, u_pixel_coord_lower, fromScale * display_size_a, tileZoomRatio, a_pos);
    v_pos_b = get_pattern_pos(u_pixel_coord_upper, u_pixel_coord_lower, toScale * display_size_b, tileZoomRatio, a_pos);
${binders.length ? '' : ''}`;
}

const VERTEX_PREAMBLE = `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform vec2 u_pixel_coord_upper;
uniform vec2 u_pixel_coord_lower;
uniform vec3 u_scale;
uniform vec2 u_fill_translate;
attribute vec2 a_pos;
varying vec2 v_pos_a;
varying vec2 v_pos_b;
`;

const FRAGMENT_PREAMBLE = `
precision highp float;
uniform vec2 u_texsize;
uniform sampler2D u_image;
uniform float u_fade;
varying vec2 v_pos_a;
varying vec2 v_pos_b;
`;

/**
 * The fill pass for a patterned fill, in whichever configuration `binders`
 * describes.
 *
 * One function for both the constant and the per-feature case. They differ only
 * in whether each property is a uniform or an attribute, and the emitters in
 * `paint_binders.ts` already express that difference — which is the whole point
 * of separating a property's GLSL shape from where its data comes from.
 */
export function createFillPatternMaterial(
    binders: ReadonlyArray<BinderDescription>,
    isGlobe: boolean,
): RawShaderMaterial {
    return new RawShaderMaterial({
        vertexShader: `${VERTEX_PREAMBLE}
${vertexDeclarations(binders)}
${UNPACK_GLSL}
${PATTERN_POS_GLSL}
${projectionGlsl(isGlobe)}
void main() {
${vertexInitializers(binders)}
${patternVertexBody(binders)}
}
`,
        // Body from src/shaders/fill_pattern.fragment.glsl.
        fragmentShader: `${FRAGMENT_PREAMBLE}
${fragmentDeclarations(binders)}
${SAMPLE_ATLAS_GLSL}
void main() {
${fragmentInitializers(binders)}
    gl_FragColor = samplePattern(pattern_from, pattern_to) * opacity;
}
`,
        uniforms: {...tileUniformSlots(), ...uniformSlots(binders), ...(isGlobe ? globeUniformSlots() : {})},
    });
}

/**
 * The stroke for a patterned fill — MapLibre's `fillOutlinePattern`.
 *
 * The fill shader plus the distance-to-edge alpha that `fillOutline` uses.
 * MapLibre selects this program only when the style sets no explicit
 * `fill-outline-color`; with one set it strokes a plain colour instead, which
 * is a different program and is declined.
 */
export function createFillOutlinePatternMaterial(
    binders: ReadonlyArray<BinderDescription>,
    isGlobe: boolean,
): RawShaderMaterial {
    return new RawShaderMaterial({
        vertexShader: `${VERTEX_PREAMBLE}
uniform vec2 u_world;
varying vec2 v_pos;
${isGlobe ? 'varying float v_depth;' : ''}
${vertexDeclarations(binders)}
${UNPACK_GLSL}
${PATTERN_POS_GLSL}
${projectionGlsl(isGlobe)}
void main() {
${vertexInitializers(binders)}
${patternVertexBody(binders)}
    v_pos = (gl_Position.xy / gl_Position.w + 1.0) / 2.0 * u_world;
${isGlobe ? '    v_depth = gl_Position.z / gl_Position.w;' : ''}
}
`,
        // Body from src/shaders/fill_outline_pattern.fragment.glsl, including
        // its GLOBE branch under the globe variant — the same software
        // back-face clip as the plain outline, for the same reason.
        fragmentShader: `${FRAGMENT_PREAMBLE}
varying vec2 v_pos;
${isGlobe ? 'varying float v_depth;' : ''}
${fragmentDeclarations(binders)}
${SAMPLE_ATLAS_GLSL}
void main() {
${fragmentInitializers(binders)}
    float dist = length(v_pos - gl_FragCoord.xy);
    float alpha = 1.0 - smoothstep(0.0, 1.0, dist);
    gl_FragColor = samplePattern(pattern_from, pattern_to) * alpha * opacity;
${isGlobe ? OUTLINE_GLOBE_CLIP_GLSL : ''}
}
`,
        uniforms: {
            u_world: {value: new Vector2()},
            ...tileUniformSlots(),
            ...uniformSlots(binders),
            ...(isGlobe ? globeUniformSlots() : {}),
        },
    });
}

/**
 * One material per program key.
 *
 * Bounded by the number of distinct paint shapes in a style — a handful — not
 * by tiles, so it needs no eviction.
 */
export class PatternMaterialCache {
    private readonly _materials = new Map<string, RawShaderMaterial>();

    constructor(
        private readonly _create: (
            binders: ReadonlyArray<BinderDescription>,
            variantA: boolean,
            variantB: boolean,
        ) => RawShaderMaterial,
    ) {}

    /** See {@link patternProgramKey} for what the flags mean — it depends. */
    get(
        binders: ReadonlyArray<BinderDescription>,
        variantA: boolean,
        variantB: boolean = false,
    ): RawShaderMaterial {
        const key = patternProgramKey(binders, variantA, variantB);
        let material = this._materials.get(key);
        if (!material) {
            material = this._create(binders, variantA, variantB);
            this._materials.set(key, material);
        }
        return material;
    }

    dispose(): void {
        for (const material of this._materials.values()) material.dispose();
        this._materials.clear();
    }
}
