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
import {projectionGlsl} from './projection_globe';

/**
 * Builds the `building-glass` material, one per paint configuration.
 *
 * ## How this differs from `fill_extrusion_program`
 *
 * The extrusion shader does all of its lighting in the **vertex** stage and
 * interpolates a finished colour, which is why its three paint properties are
 * all `inFragment: false`. Glass cannot: fresnel depends on the view direction
 * at each fragment, so the normal and the view vector are interpolated and the
 * colour is combined per fragment. `color` is therefore `inFragment: true`
 * here — safe precisely because, unlike upstream, this shader never assigns to
 * it (a varying cannot be written after it is read).
 *
 * ## What is omitted in this version, and what that means
 *
 * No `GLOBE` branch and no `TERRAIN3D` branch. For the migrated MapLibre layers
 * an omitted branch means "declined, MapLibre draws it". **This layer has no
 * such fallback** — see `BuildingGlassRenderer.canDraw` and R-1/R-2 in the spec.
 */
export const BUILDING_GLASS_SPECS: ReadonlyArray<PaintPropertySpec> = [
    {property: 'building-glass-base', name: 'base', glslType: 'float', precision: 'highp', inFragment: false},
    {property: 'building-glass-height', name: 'height', glslType: 'float', precision: 'highp', inFragment: false},
    {property: 'building-glass-color', name: 'color', glslType: 'vec4', precision: 'highp', inFragment: true},
];

/** Signature that decides whether two configurations can share a material. */
export function buildingGlassProgramKey(binders: ReadonlyArray<BinderDescription>): string {
    return binders.map((binder) => `${binder.name}:${binder.kind}`).join('|');
}

/** GLSL for the `#extension` pragma, or nothing if derivatives are unavailable. */
function derivativesExtensionGlsl(hasDerivatives: boolean): string {
    // Must be the fragment shader's first line, before `precision` — a
    // `#extension` directive has to precede every non-preprocessor token.
    return hasDerivatives ? '#extension GL_OES_standard_derivatives : enable\n' : '';
}

/**
 * The block that turns the packed top/bottom flag into a horizontal edge —
 * roofline and baseline. Omitted entirely (not merely zeroed) when the
 * renderer could not confirm `fwidth` support, so a WebGL1 context without
 * `OES_standard_derivatives` still compiles: glass renders, just without the
 * skeleton read. See R-4 in the spec for why only the horizontal edge is
 * derivable here.
 */
function edgeGlsl(hasDerivatives: boolean): string {
    if (!hasDerivatives) return '';
    return `
    float edge = 0.0;
    // Chỉ trên tường. Mặt mái có MỌI đỉnh t = 1, nên không loại nó ra thì "gần
    // đường mái" đúng với toàn bộ mặt mái chứ không phải viền của nó.
    // n.z ~ 1 trên mái, ~ 0 trên tường.
    if (abs(n.z) < 0.5) {
        float d = min(v_edge_t, 1.0 - v_edge_t);
        float w = fwidth(v_edge_t) * u_edge_width;
        edge = 1.0 - smoothstep(0.0, w, d);
    }
    float edgeAlpha = edge * u_edge_opacity;
    rgb = mix(rgb, u_edge_color.rgb, edgeAlpha);
    alpha = max(alpha, edgeAlpha);
`;
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

export function createBuildingGlassMaterial(
    binders: ReadonlyArray<BinderDescription>,
    hasDerivatives: boolean,
): RawShaderMaterial {
    return new RawShaderMaterial({
        vertexShader: `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;

uniform vec2 u_fill_translate;
uniform vec3 u_eye_tile;
uniform float u_metres_to_tile_units;

attribute vec2 a_pos;
attribute vec4 a_normal_ed;

varying vec3 v_normal;
varying vec3 v_view_dir;
varying float v_edge_t;
${vertexDeclarations(binders)}
${UNPACK_GLSL}
${projectionGlsl(false)}
void main() {
${vertexInitializers(binders)}

    vec3 normal = a_normal_ed.xyz;

    base = max(0.0, base);
    height = max(0.0, height);

    // \`normal.x\` carries the packed normal's x **and** a top/bottom flag in its
    // low bit — upstream's own trick, and why this reads \`mod\` rather than a
    // second attribute.
    float t = mod(normal.x, 2.0);
    // Kept as its own varying rather than recovered from \`v_normal\`:
    // \`v_normal = normalize(normal / 16384.0)\` below erases this low bit.
    v_edge_t = t;
    float elevation = t > 0.0 ? height : base;
    vec2 posInTile = a_pos + u_fill_translate;

    // 16384.0 is the fixed-point scale the bucket packed the normals at.
    v_normal = normalize(normal / 16384.0);

    // Both ends converted into tile units before the subtraction. \`u_eye_tile.z\`
    // and \`elevation\` are metres while xy are tile units; a matrix tolerates
    // that because each axis carries its own scale, a direction vector does not.
    vec3 eye = vec3(u_eye_tile.xy, u_eye_tile.z * u_metres_to_tile_units);
    vec3 here = vec3(posInTile, elevation * u_metres_to_tile_units);
    v_view_dir = eye - here;

    gl_Position = projectTileFor3D(posInTile, elevation);
}
`,
        fragmentShader: `${derivativesExtensionGlsl(hasDerivatives)}precision highp float;

uniform float u_opacity;
uniform float u_fresnel_power;
uniform float u_fresnel_intensity;
uniform float u_ambient;
uniform float u_rim_gain;
uniform vec4 u_edge_color;
uniform float u_edge_opacity;
uniform float u_edge_width;

varying vec3 v_normal;
varying vec3 v_view_dir;
${hasDerivatives ? 'varying float v_edge_t;' : ''}
${fragmentDeclarations(binders)}
void main() {
${fragmentInitializers(binders)}
    vec3 n = normalize(v_normal);
    vec3 view_dir = normalize(v_view_dir);

    // Grazing faces brighten; faces square to the camera stay near the floor.
    float fresnel = pow(1.0 - abs(dot(view_dir, n)), u_fresnel_power);

    // 0.98 rather than 1.0: fully opaque glass stops reading as glass, and the
    // reference material capped it for the same reason.
    float alpha = clamp(u_opacity + fresnel * u_fresnel_intensity, 0.0, 0.98);
    vec3 rgb = color.rgb * (u_ambient + fresnel * u_rim_gain);
${edgeGlsl(hasDerivatives)}
    // Premultiplied, because the renderer blends [ONE, ONE_MINUS_SRC_ALPHA].
    gl_FragColor = vec4(rgb * alpha, alpha);
}
`,
        uniforms: {
            u_fill_translate: {value: new Vector2()},
            u_eye_tile: {value: new Vector3()},
            u_metres_to_tile_units: {value: 1},
            u_opacity: {value: 0.06},
            u_fresnel_power: {value: 2.4},
            u_fresnel_intensity: {value: 0.5},
            u_ambient: {value: 0.4},
            u_rim_gain: {value: 1.1},
            u_edge_color: {value: new Vector4(1, 1, 1, 1)},
            u_edge_opacity: {value: 0.9},
            u_edge_width: {value: 1},
            ...uniformSlots(binders),
        },
    });
}

/**
 * One material per program key, built on demand. Bounded by the number of
 * distinct paint *shapes* in a style, so it needs no eviction.
 */
export class BuildingGlassMaterialCache {
    private readonly _materials = new Map<string, RawShaderMaterial>();

    get(binders: ReadonlyArray<BinderDescription>, hasDerivatives: boolean): RawShaderMaterial {
        const key = `${hasDerivatives ? 'd' : '-'}|${buildingGlassProgramKey(binders)}`;
        let material = this._materials.get(key);
        if (!material) {
            material = createBuildingGlassMaterial(binders, hasDerivatives);
            this._materials.set(key, material);
        }
        return material;
    }

    dispose(): void {
        for (const material of this._materials.values()) material.dispose();
        this._materials.clear();
    }
}
