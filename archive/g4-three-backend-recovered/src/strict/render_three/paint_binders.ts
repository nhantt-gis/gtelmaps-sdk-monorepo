import {InterleavedAttributes, type MapLibreVertexBuffer} from './attribute_bridge';

import type {ProgramConfiguration} from '../../data/program_configuration';

/**
 * Reproduces MapLibre's data-driven paint machinery for the Three backend.
 *
 * ## What MapLibre actually does, and why it cannot just be called
 *
 * A paint property like `fill-color` is not one thing. Depending on the style it
 * compiles to one of three shapes, and the **shader source differs in each**:
 *
 * | Expression | Storage | Shader |
 * |---|---|---|
 * | constant | uniform | `uniform highp vec4 u_color;` |
 * | source (`["get", …]`) | vertex attribute | `attribute highp vec4 a_color;` |
 * | composite (source + zoom) | attribute **and** uniform | attribute plus `u_color_t` to interpolate |
 *
 * MapLibre bridges the three with a `#pragma mapbox` abstraction that
 * `src/shaders/shaders.ts#prepare` expands into `#ifdef HAS_UNIFORM_u_*`
 * branches, and then compiles a *different program per configuration*, cached by
 * `ProgramConfiguration.cacheKey`.
 *
 * None of that machinery is reusable from here: it is welded to `Program`,
 * `Context` and MapLibre's own shader set. What *is* reusable is the data — the
 * binders have already evaluated every feature and uploaded the results. So this
 * module reads the binders, emits the equivalent GLSL, and points Three at the
 * paint buffers MapLibre already has on the GPU.
 *
 * ## The packing, which is not guessable
 *
 * A float property is stored as **two** floats (`vec2`: the value at zoom Z and
 * at Z+1) and read back with `unpack_mix_vec2`. A colour is stored as two floats
 * per colour — four channels packed pairwise into 16-bit halves — so a colour
 * attribute is a `vec4` read back with `unpack_mix_color`. Both unpack helpers
 * are copied verbatim from `_prelude.vertex.glsl` below; re-deriving them is how
 * colours end up subtly wrong rather than obviously broken.
 *
 * A **source** binder supplies only the first half (2 floats for a colour, 1 for
 * a float) while the shader still declares the full `vec4`/`vec2`. That is not a
 * mismatch: WebGL pads missing components, and with no `u_*_t` uniform the
 * interpolation factor defaults to 0, so `mix` returns the first half. This is
 * MapLibre's own arrangement, kept because diverging from it would mean
 * re-packing every buffer.
 */

/** Verbatim from `src/shaders/_prelude.vertex.glsl`. */
export const UNPACK_GLSL = `
vec2 unpack_float(const float packedValue) {
    int packedIntValue = int(packedValue);
    int v0 = packedIntValue / 256;
    return vec2(v0, packedIntValue - v0 * 256);
}

vec4 decode_color(const vec2 encodedColor) {
    return vec4(
        unpack_float(encodedColor[0]) / 255.0,
        unpack_float(encodedColor[1]) / 255.0
    );
}

float unpack_mix_vec2(const vec2 packedValue, const float t) {
    return mix(packedValue[0], packedValue[1], t);
}

vec4 unpack_mix_color(const vec4 packedColors, const float t) {
    vec4 minColor = decode_color(vec2(packedColors[0], packedColors[1]));
    vec4 maxColor = decode_color(vec2(packedColors[2], packedColors[3]));
    return mix(minColor, maxColor, t);
}
`;

/** One paint property a shader reads, as the shader sees it. */
export type PaintPropertySpec = {
    /** Style-spec name, e.g. `fill-color`. */
    property: string;
    /** Shader-side name, e.g. `color` — MapLibre's `paintAttributeNames`. */
    name: string;
    glslType: 'float' | 'vec4';
    precision: 'lowp' | 'mediump' | 'highp';
    /**
     * Whether the fragment shader reads this property too.
     *
     * MapLibre's expansion treats the two cases differently and the difference
     * is not cosmetic: a property both stages read becomes a **varying**, while
     * one only the vertex stage reads becomes a **local**. `line` has three of
     * the latter — `gapwidth`, `offset`, `width` — and declaring them as
     * varyings would burn interpolators the fragment shader never reads, which
     * on a tight mobile budget is the difference between linking and not.
     */
    inFragment: boolean;
};

/**
 * How a property reaches the shader — the **emitter** shape.
 *
 * Cross-faded properties are deliberately absent. They are not a fourth shape:
 * MapLibre's expansion gives a constant pattern the same `uniform` declaration
 * as any constant, and a data-driven one the same `attribute` declaration as any
 * source property. What differs is where the *value* comes from — an atlas
 * rectangle, and a buffer chosen per frame by the crossfade state — which is a
 * data path, not a GLSL shape. {@link BinderDescription.crossFaded} carries that
 * separately.
 */
export type BinderKind = 'uniform' | 'source' | 'composite';

/** Just enough of `PossiblyEvaluatedPropertyValue` to classify it. */
type ClassifiablePaintValue = {
    value?: {kind?: string};
    property?: {specification?: {'property-type'?: string}};
};

/**
 * Classifies a paint property from the expression itself.
 *
 * This reads the same field `ProgramConfiguration`'s own constructor branches
 * on, so the two cannot disagree about what a property is. The alternative —
 * inspecting the constructed binder objects — means duck-typing classes
 * `program_configuration.ts` does not export, on a fork whose entire maintenance
 * story is rebasing onto new upstream tags. A renamed private field there would
 * silently reclassify every property here.
 *
 * `constant` maps to `uniform`; anything else this does not recognise is
 * refused rather than guessed at.
 */
/** Emitter shape plus the data path it is fed from. */
export type PaintClassification = {kind: BinderKind; crossFaded: boolean};

/**
 * Classifies a paint property: which GLSL shape, and which data path.
 *
 * The two are independent, and conflating them was a mistake worth naming. A
 * *constant* `fill-pattern` reports `kind: 'constant'`, so classifying on kind
 * alone calls it a plain uniform — but MapLibre feeds that uniform from the
 * image atlas via `setConstantPatternPositions`, not from the style value. A
 * data-driven one declares an ordinary attribute, but the buffer behind it is
 * chosen per frame by the crossfade state.
 *
 * So the shape comes from `value.kind` and the path from `property-type`, which
 * is exactly the pair `ProgramConfiguration`'s own constructor branches on.
 */
export function classifyPaintValue(value: unknown): PaintClassification | null {
    const candidate = value as ClassifiablePaintValue | null;
    const crossFaded = Boolean(
        candidate?.property?.specification?.['property-type']?.startsWith('cross-faded'));

    const kind = candidate?.value?.kind;
    if (kind === 'constant') return {kind: 'uniform', crossFaded};
    if (kind === 'source') return {kind: 'source', crossFaded};
    if (kind === 'composite') return {kind: 'composite', crossFaded};
    return null;
}

export type BinderDescription = PaintPropertySpec & PaintClassification;

/** The `layer.paint` surface this needs, without depending on a layer type. */
export type PaintValueSource = {get(property: string): unknown};

/**
 * The kind of each property in `specs`, or `null` if any of them is a shape this
 * backend does not implement.
 *
 * All-or-nothing on purpose: a partially understood configuration would compile
 * a shader that disagrees with the buffers actually bound, and the result draws
 * *something* — the failure would be wrong colours, not an error.
 */
export function describeBinders(
    paint: PaintValueSource,
    specs: ReadonlyArray<PaintPropertySpec>,
    allowCrossFaded = false,
): Array<BinderDescription> | null {
    const out: Array<BinderDescription> = [];
    for (const spec of specs) {
        const classified = classifyPaintValue(paint.get(spec.property));
        if (!classified) return null;
        // Refused **by default**, and opted into per call site rather than
        // loosened globally. The GLSL for a cross-faded property is already
        // covered — that is the point of separating shape from path — but the
        // *data* is not: atlas rectangles for the constant case, a buffer chosen
        // per frame for the driven one. A caller that has neither would emit a
        // uniform for something no uniform backs, and would do so silently.
        //
        // Keeping the refusal here rather than trusting `canDraw` to sit
        // upstream is deliberate: that upstream check is where §6.1's
        // "incidentally safe" problem lived.
        if (classified.crossFaded && !allowCrossFaded) return null;
        out.push({...spec, ...classified});
    }
    return out;
}

/**
 * Whether a bucket carries a buffer for every attribute these binders declare.
 *
 * The classification comes from the layer and the buffers from the bucket, and
 * nothing structurally forces the two to agree — a property that is data-driven
 * in the style but has no buffer would compile an attribute that reads whatever
 * happens to be bound. This is the cross-check.
 *
 * **Coverage, not equality.** A bucket's `ProgramConfiguration` holds every paint
 * property of the layer at once, while these binders describe one *pass*: the
 * fill pass sees no `a_outline_color`, the outline pass no `a_color`. Requiring
 * the two sets to match exactly rejects every ordinary data-driven fill — which
 * it did, and because the rejection happened per tile after the layer had
 * already been claimed, the layer vanished from the frame entirely rather than
 * falling back. Extra attributes are not a hazard: Three binds vertex attributes
 * by iterating the *compiled program's* inputs, so buffers the shader never
 * declares are simply not looked at.
 */
export function attributesCoverBinders(
    binders: ReadonlyArray<BinderDescription>,
    attributeNames: ReadonlyArray<string>,
): boolean {
    const available = new Set(attributeNames);
    return binders
        .filter((binder) => binder.kind !== 'uniform')
        .every((binder) => available.has(`a_${binder.name}`));
}

/** GLSL attribute type for a property — the stored width, not the value width. */
function attributeType(spec: PaintPropertySpec): string {
    return spec.glslType === 'float' ? 'vec2' : 'vec4';
}

/**
 * How the value is recovered from the attribute, mirroring `shaders.ts#prepare`:
 *
 * ```js
 * const unpackType = name.match(/color/) ? 'color' : attrType;
 * ```
 *
 * The rule keys off the **name**, not the type, and that is not a quirk worth
 * normalising away. A `vec4` attribute means two different things depending on
 * it: a colour is four channels packed pairwise into two floats *twice*, for the
 * two zoom endpoints, and must be unpacked; a pattern's `vec4` holds four plain
 * numbers — the atlas rectangle — and is assigned straight through.
 *
 * Inferring "packed" from `glslType === 'vec4'`, which this did before any
 * unpacked case existed, would emit `unpack_mix_color` over a rectangle. That
 * compiles, runs, and yields a plausible wrong image.
 */
function unpackType(spec: PaintPropertySpec): string {
    return /color/.test(spec.name) ? 'color' : attributeType(spec);
}

function unpackCall(spec: PaintPropertySpec): string {
    // `vec4` here means unpacked — see `unpackType`.
    return unpackType(spec) === 'vec4' ?
        `a_${spec.name}` :
        `unpack_mix_${unpackType(spec)}(a_${spec.name}, u_${spec.name}_t)`;
}

/**
 * Vertex-shader declarations, mirroring the `#ifndef HAS_UNIFORM_u_*` branch of
 * `shaders.ts#prepare` for properties the fragment shader also reads.
 */
export function vertexDeclarations(binders: ReadonlyArray<BinderDescription>): string {
    return binders.map((binder) => {
        if (binder.kind === 'uniform') return `uniform ${binder.precision} ${binder.glslType} u_${binder.name};`;
        const lines = [
            `uniform lowp float u_${binder.name}_t;`,
            `attribute ${binder.precision} ${attributeType(binder)} a_${binder.name};`,
        ];
        // Only a property the fragment shader also reads becomes a varying.
        if (binder.inFragment) lines.push(`varying ${binder.precision} ${binder.glslType} ${binder.name};`);
        return lines.join('\n');
    }).join('\n');
}

/** Statements for the top of `main()`, assigning each property its value. */
export function vertexInitializers(binders: ReadonlyArray<BinderDescription>): string {
    return binders.map((binder) => {
        if (binder.kind === 'uniform') {
            return `    ${binder.precision} ${binder.glslType} ${binder.name} = u_${binder.name};`;
        }
        // Assigning a varying that is already declared, versus declaring a local.
        return binder.inFragment ?
            `    ${binder.name} = ${unpackCall(binder)};` :
            `    ${binder.precision} ${binder.glslType} ${binder.name} = ${unpackCall(binder)};`;
    }).join('\n');
}

export function fragmentDeclarations(binders: ReadonlyArray<BinderDescription>): string {
    return binders
        .filter((binder) => binder.inFragment)
        .map((binder) => binder.kind === 'uniform' ?
            `uniform ${binder.precision} ${binder.glslType} u_${binder.name};` :
            `varying ${binder.precision} ${binder.glslType} ${binder.name};`)
        .join('\n');
}

export function fragmentInitializers(binders: ReadonlyArray<BinderDescription>): string {
    // Nothing for attribute-backed properties: the varying already carries the
    // property's own name, exactly as MapLibre's expansion arranges.
    return binders
        .filter((binder) => binder.inFragment && binder.kind === 'uniform')
        .map((binder) => `    ${binder.precision} ${binder.glslType} ${binder.name} = u_${binder.name};`)
        .join('\n');
}

/**
 * Names of the Three uniforms a material needs for these binders.
 *
 * Constant properties need their value; composite ones need the interpolation
 * factor. Source properties need neither — and must still leave `u_<name>_t`
 * declared, defaulting to 0 so `mix` returns the low end.
 */
export function uniformNames(binders: ReadonlyArray<BinderDescription>): Array<string> {
    const names: Array<string> = [];
    for (const binder of binders) {
        if (binder.kind === 'uniform') names.push(`u_${binder.name}`);
        else names.push(`u_${binder.name}_t`);
    }
    return names;
}

/** The composite-expression surface needed to compute an interpolation factor. */
type CompositePaintValue = {
    value: {interpolationFactor(input: number, lower: number, upper: number): number};
    property?: {useIntegerZoom?: boolean};
};

/**
 * The `u_<name>_t` a composite property needs, for one bucket.
 *
 * A composite binder stores the property evaluated at the bucket's own zoom and
 * at that zoom plus one; this factor is where between them the current camera
 * sits. It is **per bucket**, not per layer, because an overzoomed tile carries
 * endpoints from a lower zoom than its neighbours — using one factor for the
 * whole layer would shade those tiles differently from MapLibre.
 *
 * Both endpoints come from public surfaces: the expression is the layer's own
 * `PossiblyEvaluatedValue`, and `bucket.zoom` is a field on the bucket. That
 * matters — the alternative is reading `zoom` and `expression` off the binder
 * object, which is the duck-typing on unexported classes that
 * {@link classifyPaintValue} exists to avoid.
 */
export function compositeInterpolationFactor(paintValue: unknown, bucketZoom: number, cameraZoom: number): number {
    const composite = paintValue as CompositePaintValue;
    const zoom = composite.property?.useIntegerZoom ? Math.floor(cameraZoom) : cameraZoom;
    const factor = composite.value.interpolationFactor(zoom, bucketZoom, bucketZoom + 1);
    // MapLibre clamps because a camera outside the endpoints would otherwise
    // extrapolate past the packed values.
    return Math.min(1, Math.max(0, factor));
}

/**
 * A bucket's paint vertex buffers, in the form Three binds them.
 *
 * Owns no GPU memory — the buffers belong to MapLibre — so geometries bound
 * through it must never be disposed. See `attribute_bridge.ts`.
 */
export class PaintAttributes extends InterleavedAttributes {
    /** The exact buffers this was built from; see {@link PaintAttributesCache}. */
    readonly sourceBuffers: ReadonlyArray<MapLibreVertexBuffer>;

    constructor(programConfiguration: ProgramConfiguration, gl: WebGLRenderingContext) {
        const buffers = programConfiguration.getPaintVertexBuffers() as unknown as ReadonlyArray<MapLibreVertexBuffer>;
        super(buffers, gl);
        this.sourceBuffers = [...buffers];
    }
}

/**
 * Caches {@link PaintAttributes} per bucket, and rebuilds when the buffers move.
 *
 * ## Why a plain per-bucket cache is a trap
 *
 * For constant, source and composite properties the buffer list is fixed once
 * `upload()` has run, so caching on the bucket is safe. **Cross-faded properties
 * break that**, and they are the next thing this backend will grow:
 *
 * ```js
 * updatePaintBuffers(crossfade) {
 *     const buf = crossfade.fromScale === 2 ? binder.zoomInPaintVertexBuffer
 *                                           : binder.zoomOutPaintVertexBuffer;
 * ```
 *
 * `drawFill` and `drawLine` call that **inside the tile loop, every frame**, and
 * which buffer comes back depends on the crossfade state. A cache keyed on the
 * bucket alone would keep serving the previous side, so a pattern would render
 * at the wrong scale — and only *while zooming*, since the two sides agree
 * everywhere else. No static fixture can catch that.
 *
 * So the buffer list is compared, not assumed. The comparison is a reference
 * check over a handful of entries once per bucket per frame, which is cheaper
 * than the mistake it prevents.
 */
export class PaintAttributesCache {
    private readonly _byBucket = new WeakMap<object, PaintAttributes>();

    get(bucket: object, programConfiguration: ProgramConfiguration, gl: WebGLRenderingContext): PaintAttributes {
        const cached = this._byBucket.get(bucket);
        if (cached && sameBuffers(cached.sourceBuffers, programConfiguration.getPaintVertexBuffers() as unknown as ReadonlyArray<MapLibreVertexBuffer>)) {
            return cached;
        }

        const attributes = new PaintAttributes(programConfiguration, gl);
        this._byBucket.set(bucket, attributes);
        return attributes;
    }
}

function sameBuffers(a: ReadonlyArray<MapLibreVertexBuffer>, b: ReadonlyArray<MapLibreVertexBuffer>): boolean {
    if (a.length !== b.length) return false;
    return a.every((buffer, i) => buffer === b[i]);
}
