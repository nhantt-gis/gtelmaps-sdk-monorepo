import {Matrix4, Vector4} from 'three';

import type {RawShaderMaterial} from 'three';
import type {ProjectionData} from '../../geo/projection/projection_data';

/**
 * The globe projection, as GLSL and as uniforms, shared by every migrated program.
 *
 * ## Why this is a second projection rather than a different matrix
 *
 * Every layer so far reaches the screen through one multiply:
 * `projectionMatrix * modelViewMatrix * vec4(pos, 0, 1)`, where the bridge has
 * folded MapLibre's whole transform into `mainMatrix` (see `projection_bridge.ts`).
 * That works because mercator projection *is* a matrix.
 *
 * Globe is not. A vertex is first mapped from tile space onto the surface of a
 * **unit sphere** — a transcendental function, not a linear one — and only then
 * multiplied by `mainMatrix`. So `mainMatrix` keeps its role unchanged and the
 * bridge keeps working; what changes is that something happens *before* it.
 *
 * ## Three things the sphere brings that a matrix never did
 *
 * 1. **Poles are sentinel coordinates, not positions.** A vertex with
 *    `rawPos.y < -32767.5` is the north pole and `> 32766.5` the south, and they
 *    are snapped to the axis rather than projected. The check is on the
 *    **untranslated** position, which is why `projectTile` has a two-argument
 *    form: a layer that applies `u_fill_translate` would otherwise stop
 *    recognising its own pole vertices.
 * 2. **Z is replaced, not computed.** Depth comes from a clipping plane through
 *    the planet's horizon, so geometry on the far side of the sphere is clipped
 *    by the hardware. A vertex shader that keeps the matrix's own Z draws the
 *    back of the planet through the front.
 * 3. **The transition is per vertex.** `u_projection_transition` blends globe
 *    against a mercator fallback matrix over the zoom range where globe turns
 *    into a flat map — and poles are faded out over the last 2% of it, on their
 *    own curve. This is why a "globe or mercator" boolean is not enough: for
 *    most of the animation the answer is *both*.
 *
 * ## Emitted as source, not compiled per projection
 *
 * Upstream keys its program cache by projection and compiles two variants. Here
 * the GLSL is included in a program's source only when that program's globe
 * variant is built, so the mercator variant carries none of it — same outcome,
 * reached by composing strings rather than by a preprocessor.
 */

/** `PI`, which upstream's prelude defines and these snippets rely on. */
const PI_GLSL = '#define PI 3.1415926535897932384626433832795\n';

/**
 * Verbatim from `src/shaders/_projection_globe.vertex.glsl`, minus the entry
 * points that no migrated layer calls yet (`projectTileWithElevation`,
 * `projectTileFor3D` — symbol and fill-extrusion).
 *
 * Copied rather than adapted. The pole thresholds, the `atan(exp(...))` inverse
 * Mercator, and the `z_globeness_threshold` constants are all values whose
 * failure mode is a slightly wrong globe rather than an obviously broken one.
 */
export const GLOBE_PROJECTION_GLSL = `${PI_GLSL}
#define GLOBE_RADIUS 6371008.8

uniform highp vec4 u_projection_tile_mercator_coords;
uniform highp vec4 u_projection_clipping_plane;
uniform highp float u_projection_transition;
uniform mat4 u_projection_fallback_matrix;

// Rotates a unit vector within its own tangent frame. Used by circle to walk a
// screen-space extrude offset ALONG the sphere's surface instead of across the
// chord, which is what keeps a circle round near the limb.
vec3 globeRotateVector(vec3 vec, vec2 angles) {
    vec3 axisRight = vec3(vec.z, 0.0, -vec.x); // Equivalent to cross(vec3(0.0, 1.0, 0.0), vec)
    vec3 axisUp = cross(axisRight, vec);
    axisRight = normalize(axisRight);
    axisUp = normalize(axisUp);
    vec2 t = tan(angles);
    return normalize(vec + axisRight * t.x + axisUp * t.y);
}

// Builds the tangent frame at a point on the sphere: right, down, and the
// outward normal. fill-extrusion rotates its wall normals through this so that
// a building on the far side of the planet is lit from the same direction as
// one in front.
mat3 globeGetRotationMatrix(vec3 spherePos) {
    vec3 axisRight = vec3(spherePos.z, 0.0, -spherePos.x); // Equivalent to cross(vec3(0.0, 1.0, 0.0), vec)
    vec3 axisDown = cross(axisRight, spherePos);
    axisRight = normalize(axisRight);
    axisDown = normalize(axisDown);
    return mat3(
        axisRight,
        axisDown,
        spherePos
    );
}

// Consider this private, do not use in other shaders directly!
// Use projectLineThickness instead.
float circumferenceRatioAtTileY(float tileY) {
    float mercator_pos_y = u_projection_tile_mercator_coords.y + u_projection_tile_mercator_coords.w * tileY;
    float spherical_y = 2.0 * atan(exp(PI - (mercator_pos_y * PI * 2.0))) - PI * 0.5;
    return cos(spherical_y);
}

// A line of constant screen width in tile units gets thinner towards the poles
// on a sphere, because a tile there wraps a smaller circumference. The mercator
// variant of this function returns a flat 1.0.
float projectLineThickness(float tileY) {
    float thickness = 1.0 / circumferenceRatioAtTileY(tileY);
    if (u_projection_transition < 0.999) {
        return mix(1.0, thickness, u_projection_transition);
    } else {
        return thickness;
    }
}

vec3 projectToSphere(vec2 translatedPos, vec2 rawPos) {
    vec2 mercator_pos = u_projection_tile_mercator_coords.xy + u_projection_tile_mercator_coords.zw * translatedPos;

    vec2 spherical;
    spherical.x = mercator_pos.x * PI * 2.0 + PI;
    spherical.y = 2.0 * atan(exp(PI - (mercator_pos.y * PI * 2.0))) - PI * 0.5;

    float len = cos(spherical.y);
    vec3 pos = vec3(
        sin(spherical.x) * len,
        sin(spherical.y),
        cos(spherical.x) * len
    );

    // North pole
    if (rawPos.y < -32767.5) {
        pos = vec3(0.0, 1.0, 0.0);
    }
    // South pole
    if (rawPos.y > 32766.5) {
        pos = vec3(0.0, -1.0, 0.0);
    }

    return pos;
}

vec3 projectToSphere(vec2 posInTile) {
    return projectToSphere(posInTile, vec2(0.0, 0.0));
}

float globeComputeClippingZ(vec3 spherePos) {
    return (1.0 - (dot(spherePos, u_projection_clipping_plane.xyz) + u_projection_clipping_plane.w));
}

vec4 interpolateProjection(vec2 posInTile, vec3 spherePos, float elevation) {
    vec3 elevatedPos = spherePos * (1.0 + elevation / GLOBE_RADIUS);
    vec4 globePosition = projectionMatrix * modelViewMatrix * vec4(elevatedPos, 1.0);
    globePosition.z = globeComputeClippingZ(elevatedPos) * globePosition.w;

    if (u_projection_transition > 0.999) {
        return globePosition;
    }

    vec4 flatPosition = u_projection_fallback_matrix * vec4(posInTile, elevation, 1.0);
    const float z_globeness_threshold = 0.2;
    vec4 result = globePosition;
    result.z = mix(0.0, globePosition.z, clamp((u_projection_transition - z_globeness_threshold) / (1.0 - z_globeness_threshold), 0.0, 1.0));
    result.xyw = mix(flatPosition.xyw, globePosition.xyw, u_projection_transition);
    if ((posInTile.y < -32767.5) || (posInTile.y > 32766.5)) {
        result = globePosition;
        const float poles_hidden_anim_percentage = 0.02;
        result.z = mix(globePosition.z, 100.0, pow(max((1.0 - u_projection_transition) / poles_hidden_anim_percentage, 0.0), 8.0));
    }
    return result;
}

vec4 projectTile(vec2 posInTile) {
    return interpolateProjection(posInTile, projectToSphere(posInTile), 0.0);
}

vec4 projectTile(vec2 posInTile, vec2 rawPos) {
    return interpolateProjection(posInTile, projectToSphere(posInTile, rawPos), 0.0);
}

vec4 projectTileWithElevation(vec2 posInTile, float elevation) {
    return interpolateProjection(posInTile, projectToSphere(posInTile), elevation);
}

// Screen-space projection that **keeps the matrix's own Z** rather than
// replacing it with the horizon clipping value. A 3D layer needs real depth
// against its own geometry; it hides the far side of the planet by culling
// instead.
vec4 interpolateProjectionFor3D(vec2 posInTile, vec3 spherePos, float elevation) {
    vec3 elevatedPos = spherePos * (1.0 + elevation / GLOBE_RADIUS);
    vec4 globePosition = projectionMatrix * modelViewMatrix * vec4(elevatedPos, 1.0);

    if (u_projection_transition > 0.999) {
        return globePosition;
    }

    vec4 fallbackPosition = u_projection_fallback_matrix * vec4(posInTile, elevation, 1.0);
    return mix(fallbackPosition, globePosition, u_projection_transition);
}

vec4 projectTileFor3D(vec2 posInTile, float elevation) {
    vec3 spherePos = projectToSphere(posInTile, posInTile);
    return interpolateProjectionFor3D(posInTile, spherePos, elevation);
}
`;

/**
 * The mercator `projectTile`, so a program body can call it either way.
 *
 * `projectionMatrix * modelViewMatrix` is `mainMatrix`, pinned by the bridge —
 * the same multiply every migrated program already does inline. Giving it the
 * upstream name means a program body is written once and compiled twice.
 */
export const MERCATOR_PROJECTION_GLSL = `
// Flat map: a line's thickness does not vary with latitude. Present so that a
// program body can be written once and compiled twice, the same reason the
// pole-kill branch below is kept on a projection that has no poles.
float projectLineThickness(float tileY) {
    return 1.0;
}

vec4 projectTile(vec2 posInTile) {
    return projectionMatrix * modelViewMatrix * vec4(posInTile, 0.0, 1.0);
}

vec4 projectTile(vec2 posInTile, vec2 rawPos) {
    vec4 result = projectionMatrix * modelViewMatrix * vec4(posInTile, 0.0, 1.0);
    // Pole vertices are pushed far enough in Z that the clipping hardware kills
    // the whole triangle — mercator has no poles to draw.
    if (rawPos.y < -32767.5 || rawPos.y > 32766.5) {
        result.z = -10000000.0;
    }
    return result;
}

vec4 projectTileWithElevation(vec2 posInTile, float elevation) {
    // Upstream's comment: only symbol shaders use this, and symbols never carry
    // pole vertices, so there is nothing to detect here.
    return projectionMatrix * modelViewMatrix * vec4(posInTile, elevation, 1.0);
}

// On a flat map the two differ only in which Z they keep, and mercator has only
// one — so upstream makes them the same function here, and so does this.
vec4 projectTileFor3D(vec2 posInTile, float elevation) {
    return projectTileWithElevation(posInTile, elevation);
}
`;

/** The projection GLSL for one variant. */
export function projectionGlsl(isGlobe: boolean): string {
    return isGlobe ? GLOBE_PROJECTION_GLSL : MERCATOR_PROJECTION_GLSL;
}

/**
 * The uniform slots a globe variant needs beyond `mainMatrix`.
 *
 * Absent from the mercator variant entirely: an unused uniform is not an error,
 * but a slot that exists and is never written is indistinguishable from one
 * that is written wrongly, and this file's whole risk is values that produce a
 * *slightly* wrong globe.
 */
export function globeUniformSlots(): Record<string, {value: unknown}> {
    return {
        u_projection_tile_mercator_coords: {value: new Vector4()},
        u_projection_clipping_plane: {value: new Vector4()},
        u_projection_transition: {value: 0},
        u_projection_fallback_matrix: {value: new Matrix4()},
    };
}

/**
 * Copies the globe half of a `ProjectionData` onto a material.
 *
 * The mercator half — `mainMatrix` — still travels on the mesh's world matrix
 * through `applyProjectionData`, unchanged. Call both.
 */
export function applyGlobeProjectionData(material: RawShaderMaterial, data: ProjectionData): void {
    const uniforms = material.uniforms;
    (uniforms.u_projection_tile_mercator_coords.value as Vector4).fromArray(data.tileMercatorCoords);
    (uniforms.u_projection_clipping_plane.value as Vector4).fromArray(data.clippingPlane);
    uniforms.u_projection_transition.value = data.projectionTransition;
    (uniforms.u_projection_fallback_matrix.value as Matrix4)
        .fromArray(data.fallbackMatrix as unknown as ArrayLike<number>);
}
