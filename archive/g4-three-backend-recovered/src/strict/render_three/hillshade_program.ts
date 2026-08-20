import {RawShaderMaterial, Vector2, Vector4} from 'three';

import {globeUniformSlots, projectionGlsl} from './projection_globe';

/**
 * The `hillshade` material — MapLibre's `hillshade` program.
 *
 * ## Only the second half of the layer
 *
 * `drawHillshade` runs in **two render passes**. In `offscreen` it computes the
 * terrain's slope from the DEM into a per-tile framebuffer; in `translucent` it
 * shades that result. This backend takes only the second. The first is handed
 * back to MapLibre, which is not a gap to close later — it is a deliberate
 * split, and the reason is in `hillshade_layer.ts`.
 *
 * ## `NUM_ILLUMINATION_SOURCES` is a compile-time constant
 *
 * `hillshade-highlight-color` may hold several colours, one per light. The
 * shader sizes four uniform arrays by that count and loops over them, so the
 * count cannot be a uniform — it is a `#define`, and a different count is a
 * different program. Hence a material cache keyed by the number, not one
 * material like `raster`.
 *
 * ## The framebuffer's texture is already complete
 *
 * `fbo.colorAttachment.get()` is a raw `WebGLTexture` with no MapLibre `Texture`
 * wrapper to call `bind(filter, wrap)` on — which is the exact shape that made
 * the image atlas sample opaque black through `ExternalTexture` (§6.4). It is
 * safe here for a specific reason: `prepareHillshade` calls
 * `renderTexture.bind(...)` **once, at creation**, before handing the handle to
 * the framebuffer. Same reason the line atlas is safe, opposite of the image
 * atlas. Verified by reading, not assumed.
 */

/** Body from `src/shaders/hillshade.fragment.glsl`, verbatim below the prelude. */
const HILLSHADE_FRAGMENT_BODY = `
#define PI 3.141592653589793

#define STANDARD 0
#define COMBINED 1
#define IGOR 2
#define MULTIDIRECTIONAL 3
#define BASIC 4

float get_aspect(vec2 deriv)
{
    return deriv.x != 0.0 ? atan(deriv.y, -deriv.x) : PI / 2.0 * (deriv.y > 0.0 ? 1.0 : -1.0);
}

void igor_hillshade(vec2 deriv)
{
    deriv = deriv * u_exaggeration * 2.0;
    float aspect = get_aspect(deriv);
    float azimuth = u_azimuths[0] + PI;
    float slope_stength = atan(length(deriv)) * 2.0/PI;
    float aspect_strength = 1.0 - abs(mod((aspect + azimuth) / PI + 0.5, 2.0) - 1.0);
    float shadow_strength = slope_stength * aspect_strength;
    float highlight_strength = slope_stength * (1.0-aspect_strength);
    gl_FragColor = u_shadows[0] * shadow_strength + u_highlights[0] * highlight_strength;
}

void standard_hillshade(vec2 deriv)
{
    float azimuth = u_azimuths[0] + PI;

    float slope = atan(0.625 * length(deriv));
    float aspect = get_aspect(deriv);

    float intensity = u_exaggeration;

    float base = 1.875 - intensity * 1.75;
    float maxValue = 0.5 * PI;
    float scaledSlope = intensity != 0.5 ? ((pow(base, slope) - 1.0) / (pow(base, maxValue) - 1.0)) * maxValue : slope;

    float accent = cos(scaledSlope);
    vec4 accent_color = (1.0 - accent) * u_accent * clamp(intensity * 2.0, 0.0, 1.0);
    float shade = abs(mod((aspect + azimuth) / PI + 0.5, 2.0) - 1.0);
    vec4 shade_color = mix(u_shadows[0], u_highlights[0], shade) * sin(scaledSlope) * clamp(intensity * 2.0, 0.0, 1.0);
    gl_FragColor = accent_color * (1.0 - shade_color.a) + shade_color;
}

void basic_hillshade(vec2 deriv)
{
    deriv = deriv * u_exaggeration * 2.0;
    float azimuth = u_azimuths[0] + PI;
    float cos_az = cos(azimuth);
    float sin_az = sin(azimuth);
    float cos_alt = cos(u_altitudes[0]);
    float sin_alt = sin(u_altitudes[0]);

    float cang = (sin_alt - (deriv.y*cos_az*cos_alt - deriv.x*sin_az*cos_alt)) / sqrt(1.0 + dot(deriv, deriv));

    float shade = clamp(cang, 0.0, 1.0);
    if(shade > 0.5)
    {
        gl_FragColor = u_highlights[0]*(2.0*shade - 1.0);
    }
    else
    {
        gl_FragColor = u_shadows[0]*(1.0 - 2.0*shade);
    }
}

void multidirectional_hillshade(vec2 deriv)
{
    deriv = deriv * u_exaggeration * 2.0;
    gl_FragColor = vec4(0,0,0,0);

    for(int i = 0; i < NUM_ILLUMINATION_SOURCES; i++)
    {
        float cos_alt = cos(u_altitudes[i]);
        float sin_alt = sin(u_altitudes[i]);
        float cos_az = -cos(u_azimuths[i]);
        float sin_az = -sin(u_azimuths[i]);

        float cang = (sin_alt - (deriv.y*cos_az*cos_alt - deriv.x*sin_az*cos_alt)) / sqrt(1.0 + dot(deriv, deriv));

        float shade = clamp(cang, 0.0, 1.0);

        if(shade > 0.5)
        {
            gl_FragColor += u_highlights[i]*(2.0*shade - 1.0)/float(NUM_ILLUMINATION_SOURCES);
        }
        else
        {
            gl_FragColor += u_shadows[i]*(1.0 - 2.0*shade)/float(NUM_ILLUMINATION_SOURCES);
        }
    }
}

void combined_hillshade(vec2 deriv)
{
    deriv = deriv * u_exaggeration * 2.0;
    float azimuth = u_azimuths[0] + PI;
    float cos_az = cos(azimuth);
    float sin_az = sin(azimuth);
    float cos_alt = cos(u_altitudes[0]);
    float sin_alt = sin(u_altitudes[0]);

    float cang = acos((sin_alt - (deriv.y*cos_az*cos_alt - deriv.x*sin_az*cos_alt)) / sqrt(1.0 + dot(deriv, deriv)));

    cang = clamp(cang, 0.0, PI/2.0);

    float shade = cang* atan(length(deriv)) * 4.0/PI/PI;
    float highlight = (PI/2.0-cang)* atan(length(deriv)) * 4.0/PI/PI;

    gl_FragColor = u_shadows[0]*shade + u_highlights[0]*highlight;
}

void main() {
    vec4 pixel = texture2D(u_image, v_pos);

    float scaleFactor = cos(radians((u_latrange[0] - u_latrange[1]) * (1.0 - v_pos.y) + u_latrange[1]));

    vec2 deriv = ((pixel.rg * 8.0) - 4.0) / scaleFactor;

    if (u_method == BASIC) {
        basic_hillshade(deriv);
    } else if (u_method == COMBINED) {
        combined_hillshade(deriv);
    } else if (u_method == IGOR) {
        igor_hillshade(deriv);
    } else if (u_method == MULTIDIRECTIONAL) {
        multidirectional_hillshade(deriv);
    } else if (u_method == STANDARD) {
        standard_hillshade(deriv);
    } else {
        standard_hillshade(deriv);
    }
}
`;

function illuminationSlots(sources: number): Record<string, {value: unknown}> {
    const zeros = (n: number) => Array.from({length: n}, () => 0);
    const colours = (n: number) => Array.from({length: n}, () => new Vector4());
    return {
        u_altitudes: {value: zeros(sources)},
        u_azimuths: {value: zeros(sources)},
        u_shadows: {value: colours(sources)},
        u_highlights: {value: colours(sources)},
    };
}

export function createHillshadeMaterial(sources: number, isGlobe: boolean): RawShaderMaterial {
    return new RawShaderMaterial({
        // Body from src/shaders/hillshade.vertex.glsl, verbatim — including the
        // two pole branches, which upstream writes **without** an `#ifdef GLOBE`
        // around them. On mercator they never fire; keeping them means the two
        // variants differ only in `projectTile`.
        vertexShader: `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;

attribute vec2 a_pos;

varying vec2 v_pos;
${projectionGlsl(isGlobe)}
void main() {
    gl_Position = projectTile(a_pos, a_pos);
    v_pos = a_pos / 8192.0;
    if (a_pos.y < -32767.5) {
        v_pos.y = 0.0;
    }
    if (a_pos.y > 32766.5) {
        v_pos.y = 1.0;
    }
}
`,
        fragmentShader: `
precision highp float;
#define NUM_ILLUMINATION_SOURCES ${sources}

uniform sampler2D u_image;
varying vec2 v_pos;

uniform vec2 u_latrange;
uniform float u_exaggeration;
uniform vec4 u_accent;
uniform int u_method;
uniform float u_altitudes[NUM_ILLUMINATION_SOURCES];
uniform float u_azimuths[NUM_ILLUMINATION_SOURCES];
uniform vec4 u_shadows[NUM_ILLUMINATION_SOURCES];
uniform vec4 u_highlights[NUM_ILLUMINATION_SOURCES];
${HILLSHADE_FRAGMENT_BODY}`,
        uniforms: {
            u_image: {value: null},
            u_latrange: {value: new Vector2()},
            u_exaggeration: {value: 0},
            u_accent: {value: new Vector4()},
            u_method: {value: 0},
            ...illuminationSlots(sources),
            ...(isGlobe ? globeUniformSlots() : {}),
        },
    });
}

/**
 * One material per (illumination-source count, projection) pair.
 *
 * Bounded by how many distinct light counts a style uses — one or two in
 * practice — times two projections, so it needs no eviction. The projection
 * belongs in the key rather than in a uniform for the same reason the light
 * count does: it changes the shader source, not a value inside it.
 */
export class HillshadeMaterialCache {
    private readonly _materials = new Map<string, RawShaderMaterial>();

    get(sources: number, isGlobe: boolean): RawShaderMaterial {
        const key = `${sources}${isGlobe ? 'g' : 'm'}`;
        let material = this._materials.get(key);
        if (!material) {
            material = createHillshadeMaterial(sources, isGlobe);
            this._materials.set(key, material);
        }
        return material;
    }

    dispose(): void {
        for (const material of this._materials.values()) material.dispose();
        this._materials.clear();
    }
}

type ColourLike = {r: number; g: number; b: number; a: number};

/**
 * Copies MapLibre's own `hillshadeUniformValues` output onto the material.
 *
 * Four of the nine are arrays sized by the light count, and two of those are
 * arrays of colours. Three wants `Vector4[]` for a `vec4[]` uniform and a plain
 * number array for a `float[]` one, so the shapes are converted here rather than
 * assumed to line up.
 *
 * `u_image` is skipped: upstream sets it to the literal unit `0`, while Three
 * assigns the unit itself. See `raster_program.ts`.
 */
export function applyHillshadeUniforms(
    material: RawShaderMaterial,
    values: Record<string, unknown>,
): void {
    for (const [name, value] of Object.entries(values)) {
        if (name === 'u_image') continue;
        const slot = material.uniforms[name];
        if (!slot) continue;

        if (name === 'u_shadows' || name === 'u_highlights') {
            const colours = value as ReadonlyArray<ColourLike>;
            const target = slot.value as Array<Vector4>;
            for (let i = 0; i < target.length; i++) {
                const colour = colours[Math.min(i, colours.length - 1)];
                target[i].set(colour.r, colour.g, colour.b, colour.a);
            }
        } else if (name === 'u_accent') {
            const colour = value as ColourLike;
            (slot.value as Vector4).set(colour.r, colour.g, colour.b, colour.a);
        } else if (Array.isArray(value)) {
            const target = slot.value as Array<number> | Vector2;
            if (Array.isArray(target)) {
                for (let i = 0; i < target.length; i++) target[i] = value[Math.min(i, value.length - 1)] as number;
            } else {
                target.fromArray(value as Array<number>);
            }
        } else {
            slot.value = value;
        }
    }
}
