import {RawShaderMaterial, Vector2, Vector4} from 'three';

import {globeUniformSlots, projectionGlsl} from './projection_globe';

import {
    fragmentDeclarations,
    fragmentInitializers,
    UNPACK_GLSL,
    vertexDeclarations,
    vertexInitializers,
    type BinderDescription,
    type PaintPropertySpec,
} from './paint_binders';

/**
 * Builds the `fill` materials, one per paint configuration.
 *
 * ## Why there is more than one material
 *
 * The shader source depends on whether each paint property is a uniform or an
 * attribute, so a style with `fill-color: "#f00"` and one with
 * `fill-color: ["get", "colour"]` need **different compiled programs**. MapLibre
 * has exactly the same constraint and solves it the same way, caching by
 * `ProgramConfiguration.cacheKey`.
 *
 * The cache key here is the list of binder kinds rather than MapLibre's key,
 * because these shaders are generated from the kinds and nothing else. Two
 * layers with different properties but the same kinds share a material, which is
 * correct: the uniforms differ, the program does not.
 *
 * ## The precisions are not decorative
 *
 * `highp` for colours and `lowp` for opacity are copied from `fill.fragment.glsl`
 * and `fill.vertex.glsl`. On mobile GPUs `lowp` is genuinely 8-bit-ish, so
 * promoting everything to `highp` would not be a harmless simplification — it
 * would change what the fixtures render on exactly the hardware this SDK
 * targets.
 */

/** Paint properties the fill shader reads, as MapLibre's pragmas name them. */
export const FILL_SPECS: ReadonlyArray<PaintPropertySpec> = [
    {property: 'fill-color', name: 'color', glslType: 'vec4', precision: 'highp', inFragment: true},
    {property: 'fill-opacity', name: 'opacity', glslType: 'float', precision: 'lowp', inFragment: true},
];

export const OUTLINE_SPECS: ReadonlyArray<PaintPropertySpec> = [
    {property: 'fill-outline-color', name: 'outline_color', glslType: 'vec4', precision: 'highp', inFragment: true},
    {property: 'fill-opacity', name: 'opacity', glslType: 'float', precision: 'lowp', inFragment: true},
];

/**
 * Shared by both shaders. Reproduces `projectTile` from
 * `_projection_mercator.vertex.glsl`, including the guard that pushes
 * subdivision's pole vertices far enough in Z for the clipper to remove the
 * whole triangle.
 */
/**
 * Signature that decides whether two configurations can share a material.
 *
 * The projection is part of it because it changes the **shader source**, not a
 * value inside it — same reason `hillshade`'s light count is in its key.
 */
export function programKey(binders: ReadonlyArray<BinderDescription>, isGlobe: boolean): string {
    return `${isGlobe ? 'g' : 'm'}|${binders.map((binder) => `${binder.name}:${binder.kind}`).join('|')}`;
}

function uniformSlots(binders: ReadonlyArray<BinderDescription>): Record<string, {value: unknown}> {
    const uniforms: Record<string, {value: unknown}> = {};
    for (const binder of binders) {
        if (binder.kind === 'uniform') {
            uniforms[`u_${binder.name}`] = {value: binder.glslType === 'float' ? 1 : new Vector4()};
        } else {
            // Declared even for source expressions, where it stays 0 so the
            // shader's `mix` returns the low zoom endpoint. See paint_binders.
            uniforms[`u_${binder.name}_t`] = {value: 0};
        }
    }
    return uniforms;
}

/**
 * The plain fill material.
 *
 * `fill.vertex.glsl` has **no** `#ifdef GLOBE` anywhere — its whole body is one
 * `projectTile(a_pos + u_fill_translate, a_pos)`, and the two-argument form is
 * the one `projection_globe.ts` already provides. Nor does `drawFill` have a
 * globe branch: unlike `raster`, a fill's geometry is subdivided when the
 * **bucket** is built (`fill_bucket.ts` calls `subdividePolygon`), so by the
 * time it reaches here the vertices already follow the sphere and there is no
 * two-pass mesh dance to reproduce.
 *
 * That is why this layer is the cheapest of the globe family and not the
 * hardest — the work upstream does for it happens somewhere this backend never
 * replaced.
 */
export function createFillMaterial(
    binders: ReadonlyArray<BinderDescription>,
    isGlobe: boolean,
): RawShaderMaterial {
    return new RawShaderMaterial({
        vertexShader: `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform vec2 u_fill_translate;
attribute vec2 a_pos;
${vertexDeclarations(binders)}
${UNPACK_GLSL}
${projectionGlsl(isGlobe)}
void main() {
${vertexInitializers(binders)}
    gl_Position = projectTile(a_pos + u_fill_translate, a_pos);
}
`,
        // Body verbatim from src/shaders/fill.fragment.glsl.
        fragmentShader: `
precision highp float;
${fragmentDeclarations(binders)}
void main() {
${fragmentInitializers(binders)}
    gl_FragColor = color * opacity;
}
`,
        uniforms: {
            u_fill_translate: {value: new Vector2()},
            ...uniformSlots(binders),
            ...(isGlobe ? globeUniformSlots() : {}),
        },
    });
}

/**
 * The outline material — the one place in the fill family where globe is not
 * only a different `projectTile`.
 *
 * An outline is drawn as **line primitives**, and lines are not affected by
 * back-face culling. Every other layer keeps the far side of the planet off the
 * screen by culling; an outline cannot, so upstream carries the vertex's own
 * `z/w` across as a varying and **discards in the fragment shader** where it
 * exceeds 1. Its comment says why the depth test does not already handle it:
 * some hardware applies `glDepthRange` before clipping rather than after.
 *
 * Ported rather than skipped, because the failure it prevents is not subtle —
 * without it every polygon on the back of the globe shows its outline through
 * the front.
 */
export function createOutlineMaterial(
    binders: ReadonlyArray<BinderDescription>,
    isGlobe: boolean,
): RawShaderMaterial {
    return new RawShaderMaterial({
        vertexShader: `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform vec2 u_fill_translate;
uniform vec2 u_world;
attribute vec2 a_pos;
varying vec2 v_pos;
${isGlobe ? 'varying float v_depth;' : ''}
${vertexDeclarations(binders)}
${UNPACK_GLSL}
${projectionGlsl(isGlobe)}
void main() {
${vertexInitializers(binders)}
    gl_Position = projectTile(a_pos + u_fill_translate, a_pos);
    v_pos = (gl_Position.xy / gl_Position.w + 1.0) / 2.0 * u_world;
${isGlobe ? '    v_depth = gl_Position.z / gl_Position.w;' : ''}
}
`,
        // Body verbatim from src/shaders/fill_outline.fragment.glsl, including
        // its GLOBE branch under the globe variant.
        fragmentShader: `
precision highp float;
uniform vec2 u_world;
varying vec2 v_pos;
${isGlobe ? 'varying float v_depth;' : ''}
${fragmentDeclarations(binders)}
void main() {
${fragmentInitializers(binders)}
    float dist = length(v_pos - gl_FragCoord.xy);
    float alpha = 1.0 - smoothstep(0.0, 1.0, dist);
    gl_FragColor = outline_color * (alpha * opacity);
${isGlobe ? OUTLINE_GLOBE_CLIP_GLSL : ''}
}
`,
        uniforms: {
            u_fill_translate: {value: new Vector2()},
            u_world: {value: new Vector2()},
            ...uniformSlots(binders),
            ...(isGlobe ? globeUniformSlots() : {}),
        },
    });
}

/**
 * Upstream's software back-face clip for line primitives, verbatim.
 *
 * See {@link createOutlineMaterial} for why a depth test is not enough.
 */
export const OUTLINE_GLOBE_CLIP_GLSL = `
    if (v_depth > 1.0) {
        // Hides polygon outlines that are visible on the backfacing side of the globe.
        // This is needed, because some hardware seems to apply glDepthRange first and then apply clipping, which is the wrong order.
        // Other layers fix this by using backface culling, but that is unavailable for line primitives, so we clip the lines in software here.
        discard;
    }`;

/**
 * One material per program key, built on demand.
 *
 * Bounded by the number of distinct paint *shapes* in a style — a handful — not
 * by tiles or layers, so it needs no eviction.
 */
export class FillMaterialCache {
    private readonly _materials = new Map<string, RawShaderMaterial>();

    constructor(
        private readonly _create:
        (binders: ReadonlyArray<BinderDescription>, isGlobe: boolean) => RawShaderMaterial,
    ) {}

    get(binders: ReadonlyArray<BinderDescription>, isGlobe: boolean): RawShaderMaterial {
        const key = programKey(binders, isGlobe);
        let material = this._materials.get(key);
        if (!material) {
            material = this._create(binders, isGlobe);
            this._materials.set(key, material);
        }
        return material;
    }

    dispose(): void {
        // These materials are Three's own, unlike the geometries — disposing
        // them frees compiled programs and nothing MapLibre owns.
        for (const material of this._materials.values()) material.dispose();
        this._materials.clear();
    }
}
