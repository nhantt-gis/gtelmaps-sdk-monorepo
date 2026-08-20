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

/**
 * Builds the `line` material, one per paint configuration.
 *
 * ## Six properties, and three of them the fragment shader never sees
 *
 * `line` is the first layer where the vertex/fragment split matters. `color`,
 * `blur` and `opacity` are read by both stages and become varyings; `gapwidth`,
 * `offset` and `width` are consumed entirely in the vertex shader, where they
 * decide how far each vertex is pushed along its extrusion normal. Declaring
 * those three as varyings would reserve interpolators nothing reads — see
 * `PaintPropertySpec.inFragment`.
 *
 * ## The geometry is not a line
 *
 * MapLibre draws lines as **triangles**, extruded in the shader. Each vertex
 * carries a position at half resolution plus a packed normal, and `a_data` holds
 * the extrusion vector, a direction flag, and the distance along the line. The
 * arithmetic below is copied from `line.vertex.glsl` rather than rewritten: the
 * bit-packing (`floor(a_pos_normal * 0.5)`, `mod(a_data.z, 4.0)`) has no margin
 * for a plausible-looking variation.
 *
 * `scale` is `1/63`, not `1/127`: extrude normals are stored at length 63 so
 * that the "special" normals used for round joins can reach 126 without
 * overflowing a signed byte.
 *
 * ## Globe, and the one thing lines cannot do
 *
 * A line is drawn as triangles whose winding is decided **in the shader**, so
 * upstream cannot cull its back faces the way every other layer keeps the far
 * side of the planet off the screen. Instead it carries `z/w` across as a
 * varying and discards in the fragment stage — the same software clip
 * `fill_outline` needs, for the same hardware reason, and shared with it here.
 *
 * The `TERRAIN3D` branch stays dropped: it is declined before this material is
 * selected, and it sets `v_gamma_scale` to a constant, which would silently
 * disable the perspective correction if it were ever reached by mistake. What
 * survives of it is the `u_flat_gamma` uniform, which is that same term
 * expressed as a value rather than a second program.
 */

/** Paint properties the line shader reads, as MapLibre's pragmas name them. */
export const LINE_SPECS: ReadonlyArray<PaintPropertySpec> = [
    {property: 'line-color', name: 'color', glslType: 'vec4', precision: 'highp', inFragment: true},
    {property: 'line-blur', name: 'blur', glslType: 'float', precision: 'lowp', inFragment: true},
    {property: 'line-opacity', name: 'opacity', glslType: 'float', precision: 'lowp', inFragment: true},
    // Vertex-only: these shape the extrusion, and the fragment stage is done
    // with them by the time it runs.
    // `line-gap-width` in the style spec; `gapwidth` in the shader, via
    // MapLibre's `paintAttributeNames` exception table. Writing the shader name
    // in the property slot made `paint.get()` return undefined, and this
    // renderer then declined every line layer in every style — invisibly, since
    // the fallback is pixel-identical.
    {property: 'line-gap-width', name: 'gapwidth', glslType: 'float', precision: 'mediump', inFragment: false},
    {property: 'line-offset', name: 'offset', glslType: 'float', precision: 'lowp', inFragment: false},
    {property: 'line-width', name: 'width', glslType: 'float', precision: 'mediump', inFragment: false},
];

/**
 * Signature that decides whether two configurations can share a material.
 *
 * The projection is part of it because it changes the shader source.
 */
export function lineProgramKey(binders: ReadonlyArray<BinderDescription>, isGlobe: boolean): string {
    return `${isGlobe ? 'g' : 'm'}|${binders.map((binder) => `${binder.name}:${binder.kind}`).join('|')}`;
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
 * The declarations every line vertex shader needs, before its binders.
 *
 * Shared with `line_pattern_program.ts`. Kept as one string rather than copied
 * because the alternative is two copies of the same bit-packing drifting apart —
 * and a drifted copy renders lines, just the wrong shape.
 */
export const LINE_VERTEX_PREAMBLE = `
precision highp float;
#define scale 0.015873016

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform vec2 u_translation;
uniform mediump float u_ratio;
uniform vec2 u_units_to_pixels;
uniform lowp float u_device_pixel_ratio;
// 1.0 when drawing into a terrain render pool; see v_gamma_scale below.
uniform lowp float u_flat_gamma;

attribute vec2 a_pos_normal;
attribute vec4 a_data;

varying vec2 v_normal;
varying vec2 v_width2;
varying float v_gamma_scale;
varying highp float v_linesofar;`;

/** The extra varying a globe line carries, declared in both stages. */
export const LINE_GLOBE_VARYING = 'varying float v_depth;';

/**
 * Upstream's software back-face clip for lines, verbatim from
 * `line.fragment.glsl` — shared by all four line fragment shaders.
 */
export const LINE_GLOBE_CLIP_GLSL = `
    if (v_depth > 1.0) {
        // Hides lines that are visible on the backfacing side of the globe.
        // This is needed, because some hardware seems to apply glDepthRange first and then apply clipping, which is the wrong order.
        // Other layers fix this by using backface culling, but the line layer's geometry (actually drawn as polygons) is complex and partly resolved in the shader,
        // so we can't easily ensure that all triangles have the proper winding order in the vertex buffer creation step.
        // Thus we render line geometry without face culling, and clip the lines manually here.
        discard;
    }`;

/**
 * The extrusion arithmetic, copied from `line.vertex.glsl`.
 *
 * `tail` is appended inside `main()`: the plain program adds nothing, the
 * pattern program adds `v_width`. Everything above it is byte-identical between
 * the two, which is the point — `line_program.test.ts` pins the emitted string
 * precisely so a future variant cannot quietly reshape this body while adding
 * itself to it.
 */
export function lineVertexMain(
    binders: ReadonlyArray<BinderDescription>,
    isGlobe: boolean,
    tail: string = '',
): string {
    return `void main() {
${vertexInitializers(binders)}

    float ANTIALIASING = 1.0 / u_device_pixel_ratio / 2.0;

    vec2 a_extrude = a_data.xy - 128.0;
    float a_direction = mod(a_data.z, 4.0) - 1.0;

    v_linesofar = (floor(a_data.z / 4.0) + a_data.w * 64.0) * 2.0;

    vec2 pos = floor(a_pos_normal * 0.5);

    // x is 1 if it's a round cap, 0 otherwise
    // y is 1 if the normal points up, and -1 if it points down
    mediump vec2 normal = a_pos_normal - 2.0 * pos;
    normal.y = normal.y * 2.0 - 1.0;
    v_normal = normal;

    gapwidth = gapwidth / 2.0;
    float halfwidth = width / 2.0;
    offset = -1.0 * offset;

    float inset = gapwidth + (gapwidth > 0.0 ? ANTIALIASING : 0.0);
    float outset = gapwidth + halfwidth * (gapwidth > 0.0 ? 2.0 : 1.0) + (halfwidth == 0.0 ? 0.0 : ANTIALIASING);

    mediump vec2 dist = outset * a_extrude * scale;

    mediump float u = 0.5 * a_direction;
    mediump float t = 1.0 - abs(u);
    mediump vec2 offset2 = offset * a_extrude * scale * normal.y * mat2(t, -u, u, t);

    // Verbatim now, including \`adjustedThickness\`. It used to be dropped with
    // a comment saying it is 1.0 on mercator — true, and true only because
    // \`projectLineThickness\` returns 1.0 there. Since \`projection_globe.ts\`
    // defines that function in **both** variants, the upstream line compiles
    // unchanged and the divergence is gone rather than annotated.
    float adjustedThickness = projectLineThickness(pos.y);
    vec4 projected_no_extrude = projectTile(pos + offset2 / u_ratio * adjustedThickness + u_translation);
    vec4 projected_with_extrude = projectTile(pos + offset2 / u_ratio * adjustedThickness + u_translation + dist / u_ratio * adjustedThickness);
    gl_Position = projected_with_extrude;
${isGlobe ? '    v_depth = gl_Position.z / gl_Position.w;' : ''}

    // Upstream guards this whole calculation with #ifdef TERRAIN3D, setting
    // v_gamma_scale = 1.0 instead - "not needed, because this is done
    // automatically via the mesh". It is not an elevation branch, which is why
    // it survived a reading that only looked for get_elevation: under terrain
    // the line is drawn flat into a render pool and the perspective squish is
    // applied later, when the terrain mesh samples that texture. Correcting for
    // it here as well applies it twice.
    //
    // A uniform rather than a second program: the difference is one term, and a
    // terrain-keyed material cache would double every line program for it.
    float extrude_length_without_perspective = length(dist);
    float extrude_length_with_perspective = length((projected_with_extrude.xy - projected_no_extrude.xy) / projected_with_extrude.w * u_units_to_pixels);
    v_gamma_scale = mix(extrude_length_without_perspective / extrude_length_with_perspective, 1.0, u_flat_gamma);

    v_width2 = vec2(outset, inset);${tail}
}
`;
}

/** Uniforms every line program needs regardless of its binders. */
export function lineTileUniformSlots(): Record<string, {value: unknown}> {
    return {
        u_translation: {value: new Vector2()},
        u_ratio: {value: 1},
        u_device_pixel_ratio: {value: 1},
        u_units_to_pixels: {value: new Vector2()},
        u_flat_gamma: {value: 0},
    };
}

export function createLineMaterial(
    binders: ReadonlyArray<BinderDescription>,
    isGlobe: boolean,
): RawShaderMaterial {
    return new RawShaderMaterial({
        // Body copied from src/shaders/line.vertex.glsl, with the TERRAIN3D
        // branch removed — see the file comment.
        vertexShader: `${LINE_VERTEX_PREAMBLE}
${isGlobe ? LINE_GLOBE_VARYING : ''}
${vertexDeclarations(binders)}
${UNPACK_GLSL}
${projectionGlsl(isGlobe)}
${lineVertexMain(binders, isGlobe)}`,
        // Body verbatim from src/shaders/line.fragment.glsl.
        fragmentShader: `
precision highp float;
uniform lowp float u_device_pixel_ratio;

varying vec2 v_width2;
varying vec2 v_normal;
varying float v_gamma_scale;
${isGlobe ? LINE_GLOBE_VARYING : ''}
${fragmentDeclarations(binders)}

void main() {
${fragmentInitializers(binders)}

    float dist = length(v_normal) * v_width2.s;
    float blur2 = (blur + 1.0 / u_device_pixel_ratio) * v_gamma_scale;
    float alpha = clamp(min(dist - (v_width2.t - blur2), v_width2.s - dist) / blur2, 0.0, 1.0);

    gl_FragColor = color * (alpha * opacity);
${isGlobe ? LINE_GLOBE_CLIP_GLSL : ''}
}
`,
        uniforms: {
            ...lineTileUniformSlots(),
            ...uniformSlots(binders),
            ...(isGlobe ? globeUniformSlots() : {}),
        },
    });
}

/**
 * One material per program key, built on demand.
 *
 * Bounded by the number of distinct paint *shapes* in a style, not by tiles or
 * layers, so it needs no eviction.
 */
export class LineMaterialCache {
    private readonly _materials = new Map<string, RawShaderMaterial>();

    constructor(
        private readonly _create:
        (binders: ReadonlyArray<BinderDescription>, isGlobe: boolean) => RawShaderMaterial = createLineMaterial,
    ) {}

    get(binders: ReadonlyArray<BinderDescription>, isGlobe: boolean): RawShaderMaterial {
        const key = lineProgramKey(binders, isGlobe);
        let material = this._materials.get(key);
        if (!material) {
            material = this._create(binders, isGlobe);
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
