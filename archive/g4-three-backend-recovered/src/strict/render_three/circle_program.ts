import {RawShaderMaterial, Vector2, Vector4} from 'three';

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
 * Builds the `circle` material, one per paint configuration.
 *
 * ## There is no circle
 *
 * Each feature is a **quad**, two triangles, and the roundness happens entirely
 * in the fragment shader: the vertex stage writes the corner's extrusion vector
 * into `v_data.xy`, and the fragment stage keeps the pixels whose
 * `length(extrude)` is under 1. So a "circle" is a square with its corners
 * discarded — which is why the fragment shader's `discard` is a throughput
 * decision rather than a correctness one, and is copied over verbatim.
 *
 * ## The position is not a position
 *
 * `a_pos` is a single `Int16×2` carrying **two** things at once. The bucket
 * writes `(x * 8 + extrudeX, y * 8 + extrudeY) - 32768`, so the vertex shader
 * adds 32768 back, takes `mod 8` for the corner and `floor(/8)` for the centre.
 * The `/ 7.0 * 2.0 - 1.0` that follows maps the stored 0..7 to -1..1.
 *
 * That packing is the reason the shader cannot be simplified: there is no
 * separate extrusion attribute to read instead, and any arithmetic drift here
 * moves every circle by a fraction of its radius rather than failing loudly.
 *
 * ## Two independent switches, four behaviours
 *
 * `circle-pitch-alignment` decides whether the quad lies **in the map plane** or
 * faces the screen; `circle-pitch-scale` decides whether its size follows the
 * map's scale or stays constant in pixels. They are separate uniforms
 * (`u_pitch_with_map`, `u_scale_with_map`) and all four combinations are real
 * styles — the `circle-pitch-alignment` fixtures cover exactly that matrix.
 *
 * ## Globe: the one layer where the extrude is an angle, not an offset
 *
 * Every other migrated layer reaches globe by swapping `projectTile`. `circle`
 * cannot, because its quad is built by **adding a screen-space offset to a
 * position** — and on a sphere that offset leaves the surface. Upstream instead
 * projects the centre to a unit vector, converts the offset into a pair of
 * **angles** (`u_globe_extrude_scale`, computed per tile from
 * `pixelRatio / (EXTENT * 2^z) * 2PI`), and rotates the centre vector inside its
 * own tangent frame with `globeRotateVector`. That is what keeps a circle round
 * at the limb instead of shearing into an ellipse.
 *
 * `corner_position` is still tracked in tile space alongside it, because
 * `interpolateProjection` needs the flat position to blend against during a
 * globe↔mercator transition. Both halves are required; carrying only the vector
 * makes circles jump at the moment the transition ends.
 *
 * The mercator variant is emitted **exactly as before** — no `angle_scale`, no
 * unused uniform — so that any change the gate reports is attributable to the
 * globe path alone.
 *
 * ## Terrain: elevation and visibility, both real now
 *
 * `circle` is one of the four layers terrain draws **live** rather than through
 * the render pool, so it raises its own centre with `get_elevation` and fades
 * itself behind hills with `calculate_visibility` — see `terrain_bridge.ts`.
 *
 * `v_visibility` used to be omitted with the argument that
 * `calculate_visibility` returns exactly `1.0` without terrain and multiplying
 * by 1.0 is an identity. True, and now beside the point: with terrain it is not
 * 1.0, and the varying is emitted in both variants so that the fragment body
 * stays one string.
 *
 * ## What is omitted, and why that is safe
 *
 * - **`blur` in the fragment shader.** MapLibre declares it in both stages, but
 *   the fragment body never reads it — it reads `v_data.z`, the antialiasing
 *   blur the vertex stage already folded it into. See `PaintPropertySpec`.
 */

/** Paint properties the circle shader reads, as MapLibre's pragmas name them. */
export const CIRCLE_SPECS: ReadonlyArray<PaintPropertySpec> = [
    {property: 'circle-color', name: 'color', glslType: 'vec4', precision: 'highp', inFragment: true},
    {property: 'circle-radius', name: 'radius', glslType: 'float', precision: 'mediump', inFragment: true},
    // Vertex-only: the fragment shader reads `v_data.z`, which already contains
    // it. See the class comment.
    {property: 'circle-blur', name: 'blur', glslType: 'float', precision: 'lowp', inFragment: false},
    {property: 'circle-opacity', name: 'opacity', glslType: 'float', precision: 'lowp', inFragment: true},
    {property: 'circle-stroke-color', name: 'stroke_color', glslType: 'vec4', precision: 'highp', inFragment: true},
    {property: 'circle-stroke-width', name: 'stroke_width', glslType: 'float', precision: 'mediump', inFragment: true},
    {property: 'circle-stroke-opacity', name: 'stroke_opacity', glslType: 'float', precision: 'lowp', inFragment: true},
];

/**
 * Signature that decides whether two configurations can share a material.
 *
 * The projection is part of it because it changes the shader source.
 */
export function circleProgramKey(
    binders: ReadonlyArray<BinderDescription>,
    isGlobe: boolean,
    hasTerrain: boolean,
): string {
    return `${isGlobe ? 'g' : 'm'}${hasTerrain ? 't' : ''}|${binders.map((binder) => `${binder.name}:${binder.kind}`).join('|')}`;
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

/**
 * `projectTileWithElevation`, inlined from `_projection_mercator.vertex.glsl`.
 *
 * The elevation argument is kept even though every caller passes 0. It is the
 * third component of the position, so removing it would change the matrix
 * multiplication's shape rather than merely dropping a term, and the next
 * backend that does carry elevation would have to put it back exactly here.
 */
export function createCircleMaterial(
    binders: ReadonlyArray<BinderDescription>,
    isGlobe: boolean,
    hasTerrain: boolean,
): RawShaderMaterial {
    return new RawShaderMaterial({
        // Body from src/shaders/circle.vertex.glsl, with the terrain lookups
        // removed — see the file comment.
        vertexShader: `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform bool u_scale_with_map;
uniform bool u_pitch_with_map;
uniform vec2 u_extrude_scale;
uniform lowp float u_device_pixel_ratio;
uniform highp float u_camera_to_center_distance;
uniform vec2 u_translate;
${isGlobe ? 'uniform highp float u_globe_extrude_scale;' : ''}

attribute vec2 a_pos;

varying vec3 v_data;
varying float v_visibility;
${vertexDeclarations(binders)}
${UNPACK_GLSL}
${terrainGlsl(hasTerrain)}
${projectionGlsl(isGlobe)}
void main(void) {
${vertexInitializers(binders)}

    // decode the extrusion vector that we snuck into the a_pos vector
    vec2 pos_raw = a_pos + 32768.0;
    vec2 extrude = vec2(mod(pos_raw, 8.0) / 7.0 * 2.0 - 1.0);

    // Divide a_pos by 8, since we had it * 8 in order to sneak
    // in extrusion data
    vec2 circle_center = floor(pos_raw / 8.0) + u_translate;
    float ele = get_elevation(circle_center);
    v_visibility = calculate_visibility(projectTileWithElevation(circle_center, ele));

    if (u_pitch_with_map) {
${isGlobe ? '        vec3 center_vector = projectToSphere(circle_center);\n        float angle_scale = u_globe_extrude_scale;' : ''}
        // Keep track of "2D" corner position to allow smooth interpolation between globe and mercator
        vec2 corner_position = circle_center;
        if (u_scale_with_map) {
${isGlobe ? '            angle_scale *= (radius + stroke_width);' : ''}
            corner_position += extrude * u_extrude_scale * (radius + stroke_width);
        } else {
            // Pitching the circle with the map effectively scales it with the map
            // To counteract the effect for pitch-scale: viewport, we rescale the
            // whole circle based on the pitch scaling effect at its central point
            vec4 projected_center = ${isGlobe ?
                'interpolateProjection(circle_center, center_vector, ele)' :
                'projectTileWithElevation(circle_center, ele)'};
            corner_position += extrude * u_extrude_scale * (radius + stroke_width) * (projected_center.w / u_camera_to_center_distance);
${isGlobe ? '            angle_scale *= (radius + stroke_width) * (projected_center.w / u_camera_to_center_distance);' : ''}
        }

${isGlobe ?
    '        vec2 angles = extrude * angle_scale;\n' +
        '        vec3 corner_vector = globeRotateVector(center_vector, angles);\n' +
        '        gl_Position = interpolateProjection(corner_position, corner_vector, ele);' :
    '        gl_Position = projectTileWithElevation(corner_position, ele);'}
    } else {
        gl_Position = projectTileWithElevation(circle_center, ele);

        if (gl_Position.z / gl_Position.w > 1.0) {
            // Same as in fill_outline.fragment.glsl and line.fragment.glsl, we need to account for some hardware
            // doing glFragDepth and clipping in the wrong order by doing clipping manually in the shader.
            // For screenspace (not u_pitch_with_map) circles, it is enough to detect whether the anchor
            // point should be clipped here in the vertex shader, and clip it by moving in beyond the
            // renderable range -1..1 in X and Y (moving it to 10000 is more than enough).
            gl_Position.xy = vec2(10000.0);
        }

        if (u_scale_with_map) {
            gl_Position.xy += extrude * (radius + stroke_width) * u_extrude_scale * u_camera_to_center_distance;
        } else {
            gl_Position.xy += extrude * (radius + stroke_width) * u_extrude_scale * gl_Position.w;
        }
    }

    // This is a minimum blur distance that serves as a faux-antialiasing for
    // the circle. since blur is a ratio of the circle's size and the intent is
    // to keep the blur at roughly 1px, the two are inversely related.
    float antialiasblur = -max(1.0 / u_device_pixel_ratio / (radius + stroke_width), blur);

    v_data = vec3(extrude.x, extrude.y, antialiasblur);
}
`,
        // Body from src/shaders/circle.fragment.glsl.
        fragmentShader: `
precision highp float;
varying vec3 v_data;
varying float v_visibility;
${fragmentDeclarations(binders)}

void main() {
${fragmentInitializers(binders)}

    vec2 extrude = v_data.xy;
    float extrude_length = length(extrude);
    float antialiased_blur = v_data.z;

    float opacity_t = smoothstep(0.0, antialiased_blur, extrude_length - 1.0);

    float color_t = stroke_width < 0.01 ? 0.0 : smoothstep(antialiased_blur, 0.0, extrude_length - radius / (radius + stroke_width));

    gl_FragColor = v_visibility * opacity_t * mix(color * opacity, stroke_color * stroke_opacity, color_t);

    const float epsilon = 0.5 / 255.0;
    if (gl_FragColor.r < epsilon && gl_FragColor.g < epsilon && gl_FragColor.b < epsilon && gl_FragColor.a < epsilon) {
        // If this pixel wouldn't affect the framebuffer contents in any way, discard it for performance.
        // This disables early-Z test, but that is likely irrelevant for circles, performance wise.
        // But many circles might put a lot of load on the blending and framebuffer output hardware due to using a lot of pixels,
        // and this discard will help in that case.
        // Also, each circle will at most use ~3/4 of its rasterized pixels, due to being a circle approximated with a square,
        // this will discard the unused 1/4.
        discard;
    }
}
`,
        uniforms: {
            u_scale_with_map: {value: 0},
            u_pitch_with_map: {value: 0},
            u_extrude_scale: {value: new Vector2()},
            u_device_pixel_ratio: {value: 1},
            u_camera_to_center_distance: {value: 0},
            u_translate: {value: new Vector2()},
            ...uniformSlots(binders),
            // Only under globe. `circleUniformValues` always computes it, but on
            // mercator nothing reads it, and a slot that exists and is never
            // read is indistinguishable from one written wrongly.
            ...(isGlobe ? {u_globe_extrude_scale: {value: 0}, ...globeUniformSlots()} : {}),
            ...(hasTerrain ? terrainUniformSlots() : {}),
        },
    });
}

/**
 * One material per program key, built on demand.
 *
 * Bounded by the number of distinct paint *shapes* in a style, not by tiles or
 * layers, so it needs no eviction.
 */
export class CircleMaterialCache {
    private readonly _materials = new Map<string, RawShaderMaterial>();

    get(
        binders: ReadonlyArray<BinderDescription>,
        isGlobe: boolean,
        hasTerrain: boolean,
    ): RawShaderMaterial {
        const key = circleProgramKey(binders, isGlobe, hasTerrain);
        let material = this._materials.get(key);
        if (!material) {
            material = createCircleMaterial(binders, isGlobe, hasTerrain);
            this._materials.set(key, material);
        }
        return material;
    }

    dispose(): void {
        // Materials are Three's own, unlike the geometries — disposing them
        // frees compiled programs and nothing MapLibre owns.
        for (const material of this._materials.values()) material.dispose();
        this._materials.clear();
    }
}
