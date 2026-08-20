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

/**
 * Builds the `fillExtrusion` material, one per paint configuration.
 *
 * ## All three paint properties are vertex-only
 *
 * The fragment shader is two lines: it writes `v_color` and nothing else. Every
 * lighting decision — relative luminance, the ambient floor, the directional
 * term, the vertical gradient down each wall — happens in the vertex shader and
 * is interpolated. So `base`, `height` and `color` are all `inFragment: false`,
 * and the fragment stage declares no binders at all.
 *
 * That also means the binder locals are **assigned to**: `base = max(0.0, base)`
 * and `color += ambientlight` are upstream's own lines. The emitters already
 * produce locals rather than varyings for vertex-only properties, so those
 * assignments compile unchanged — but it is why marking any of the three
 * `inFragment: true` would break the shader rather than merely waste an
 * interpolator: a varying cannot be written after it is read.
 *
 * ## The lighting constants are not decorative
 *
 * `0.2126 / 0.7152 / 0.0722` are the Rec. 709 luminance weights; `16384.0` is
 * the fixed-point scale the bucket packed the normals at; `150.0` and the
 * `mix(0.7, 0.98, …)` clamp shape the wall gradient. Every one of them, given a
 * plausible wrong value, produces buildings that are lit — just lit differently.
 * They are copied verbatim and pinned by `fill_extrusion_program.test.ts`.
 *
 * ## What is omitted, and why that is safe
 *
 * - **The `GLOBE` branch**, and with it `u_lightpos_globe`, which is only read
 *   inside it. Globe is declined before this material is selected.
 * - **The `TERRAIN3D` branch**, and with it the `a_centroid` attribute and the
 *   `base`/`height` terrain offsets, which are `0.0` without it. Terrain is
 *   declined; note that this is also the only attribute a fill-extrusion bucket
 *   carries in a *second* buffer, so declining terrain keeps the geometry to one.
 * - **`OVERDRAW_INSPECTOR`**, declined outright.
 */

/** Paint properties the fill-extrusion shader reads, as MapLibre's pragmas name them. */
export const FILL_EXTRUSION_SPECS: ReadonlyArray<PaintPropertySpec> = [
    // All vertex-only: the fragment shader reads `v_color` and nothing else.
    {property: 'fill-extrusion-base', name: 'base', glslType: 'float', precision: 'highp', inFragment: false},
    {property: 'fill-extrusion-height', name: 'height', glslType: 'float', precision: 'highp', inFragment: false},
    {property: 'fill-extrusion-color', name: 'color', glslType: 'vec4', precision: 'highp', inFragment: false},
];

/** Signature that decides whether two configurations can share a material. */
export function fillExtrusionProgramKey(binders: ReadonlyArray<BinderDescription>): string {
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

/** Upstream's `#ifdef TERRAIN3D` offsets, verbatim. */
const TERRAIN_OFFSETS_GLSL = `    float height_terrain3d_offset = get_elevation(a_centroid);
    float base_terrain3d_offset = height_terrain3d_offset - (base > 0.0 ? 0.0 : 10.0);`;

/** And its `#else` half, so the two lines that use them are written once. */
const FLAT_OFFSETS_GLSL = `    float height_terrain3d_offset = 0.0;
    float base_terrain3d_offset = 0.0;`;

export function createFillExtrusionMaterial(
    binders: ReadonlyArray<BinderDescription>,
    hasTerrain: boolean,
    isGlobe: boolean,
): RawShaderMaterial {
    return new RawShaderMaterial({
        // Body from src/shaders/fill_extrusion.vertex.glsl, with the GLOBE and
        // TERRAIN3D branches removed — see the file comment.
        vertexShader: `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;

uniform vec3 u_lightcolor;
uniform lowp vec3 u_lightpos;
${isGlobe ? 'uniform lowp vec3 u_lightpos_globe;' : ''}
uniform lowp float u_lightintensity;
uniform float u_vertical_gradient;
uniform lowp float u_opacity;
uniform vec2 u_fill_translate;

attribute vec2 a_pos;
attribute vec4 a_normal_ed;
${hasTerrain ? 'attribute vec2 a_centroid;' : ''}

varying vec4 v_color;
${vertexDeclarations(binders)}
${UNPACK_GLSL}
${terrainGlsl(hasTerrain)}
${projectionGlsl(isGlobe)}
void main() {
${vertexInitializers(binders)}

    vec3 normal = a_normal_ed.xyz;

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

    // Relative luminance (how dark/bright is the surface color?)
    float colorvalue = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;

    v_color = vec4(0.0, 0.0, 0.0, 1.0);

    // Add slight ambient lighting so no extrusions are totally black
    vec4 ambientlight = vec4(0.03, 0.03, 0.03, 1.0);
    color += ambientlight;

    // Calculate cos(theta), where theta is the angle between surface normal and diffuse light ray
    vec3 normalForLighting = normal / 16384.0;
    float directional = clamp(dot(normalForLighting, u_lightpos), 0.0, 1.0);
${isGlobe ?
    '    // Rotate the wall normal into the sphere\'s tangent frame, so a\n' +
        '    // building on the far side is lit from the same direction as one in\n' +
        '    // front. Upstream interpolates the **dot product**, not the normals.\n' +
        '    mat3 rotMatrix = globeGetRotationMatrix(spherePos);\n' +
        '    normalForLighting = rotMatrix * normalForLighting;\n' +
        '    directional = mix(directional, clamp(dot(normalForLighting, u_lightpos_globe), 0.0, 1.0), u_projection_transition);' :
    ''}

    // Adjust directional so that
    // the range of values for highlight/shading is narrower
    // with lower light intensity
    // and with lighter/brighter surface colors
    directional = mix((1.0 - u_lightintensity), max((1.0 - colorvalue + u_lightintensity), 1.0), directional);

    // Add gradient along z axis of side surfaces
    if (normal.y != 0.0) {
        // This avoids another branching statement, but multiplies by a constant of 0.84 if no vertical gradient,
        // and otherwise calculates the gradient based on base + height
        directional *= (
            (1.0 - u_vertical_gradient) +
            (u_vertical_gradient * clamp((t + base) * pow(height / 150.0, 0.5), mix(0.7, 0.98, 1.0 - u_lightintensity), 1.0)));
    }

    // Assign final color based on surface + ambient light color, diffuse light directional, and light color
    // with lower bounds adjusted to hue of light
    // so that shading is tinted with the complementary (opposite) color to the light color
    v_color.r += clamp(color.r * directional * u_lightcolor.r, mix(0.0, 0.3, 1.0 - u_lightcolor.r), 1.0);
    v_color.g += clamp(color.g * directional * u_lightcolor.g, mix(0.0, 0.3, 1.0 - u_lightcolor.g), 1.0);
    v_color.b += clamp(color.b * directional * u_lightcolor.b, mix(0.0, 0.3, 1.0 - u_lightcolor.b), 1.0);
    v_color *= u_opacity;
}
`,
        // Body verbatim from src/shaders/fill_extrusion.fragment.glsl.
        fragmentShader: `
precision highp float;
varying vec4 v_color;
${fragmentDeclarations(binders)}
void main() {
${fragmentInitializers(binders)}
    gl_FragColor = v_color;
}
`,
        uniforms: {
            u_lightcolor: {value: new Vector3()},
            u_lightpos: {value: new Vector3()},
            u_lightintensity: {value: 0},
            u_vertical_gradient: {value: 0},
            u_opacity: {value: 1},
            u_fill_translate: {value: new Vector2()},
            ...uniformSlots(binders),
            ...(hasTerrain ? terrainUniformSlots() : {}),
            ...(isGlobe ? {u_lightpos_globe: {value: new Vector3()}, ...globeUniformSlots()} : {}),
        },
    });
}

/**
 * One material per program key, built on demand.
 *
 * Bounded by the number of distinct paint *shapes* in a style, not by tiles or
 * layers, so it needs no eviction.
 */
export class FillExtrusionMaterialCache {
    private readonly _materials = new Map<string, RawShaderMaterial>();

    get(
        binders: ReadonlyArray<BinderDescription>,
        hasTerrain: boolean,
        isGlobe: boolean,
    ): RawShaderMaterial {
        const key = `${hasTerrain ? 't' : '-'}${isGlobe ? 'g' : '-'}|${fillExtrusionProgramKey(binders)}`;
        let material = this._materials.get(key);
        if (!material) {
            material = createFillExtrusionMaterial(binders, hasTerrain, isGlobe);
            this._materials.set(key, material);
        }
        return material;
    }

    dispose(): void {
        for (const material of this._materials.values()) material.dispose();
        this._materials.clear();
    }
}
