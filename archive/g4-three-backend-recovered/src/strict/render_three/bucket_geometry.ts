import {GLBufferAttribute} from 'three';

import {InterleavedAttributes, type MapLibreVertexBuffer} from './attribute_bridge';

import type {BufferGeometry} from 'three';

/**
 * Points Three at a MapLibre bucket's **already-uploaded GL buffers**.
 *
 * ## Why this does not read the bucket's arrays
 *
 * The obvious bridge — take `bucket.layoutVertexArray.int16`, hand Three a
 * `BufferAttribute` over it — cannot work, and fails in a way worth recording.
 * `VertexBuffer` and `IndexBuffer` both call `array.freeBufferAfterUpload()` in
 * their constructors, which replaces the backing store with a zero-length
 * `ArrayBuffer` and refreshes the typed views. By the time a layer draws, the
 * bucket's CPU arrays are **empty** — `src/util/struct_array.test.ts` asserts
 * exactly this.
 *
 * Building the geometries earlier, before the free, would work but is the wrong
 * trade: it pins a CPU copy of every bucket that MapLibre deliberately released,
 * and Three would then upload a *second* copy to the GPU. At the scale this SDK
 * targets that is not a rounding error.
 *
 * So instead Three is pointed at the same `WebGLBuffer` MapLibre already
 * uploaded. Nothing is copied and nothing is uploaded twice — the geometry here
 * is pure description.
 *
 * ## Segments, and the offset that has to come from somewhere
 *
 * A bucket holds one vertex buffer plus a `SegmentVector`, and **indices within
 * a segment are relative to that segment's own vertex base** — which is why
 * `SegmentVector.MAX_VERTEX_ARRAY_LENGTH` is 2^16. MapLibre honours this by
 * rebinding the vertex attribute at `vertexOffset` before each segment's
 * `drawElements`. WebGL has no `drawElementsBaseVertex`, so the offset has to be
 * expressed through the attribute binding.
 *
 * A bare `GLBufferAttribute` cannot: Three's `setupVertexAttributes` passes
 * stride 0 and offset 0 for plain attributes. An `InterleavedBufferAttribute`
 * can — that branch uses `data.stride` and `attribute.offset`. So the vertex
 * buffer is wrapped as a `GLBufferAttribute` carrying a `stride`, and each
 * segment gets an `InterleavedBufferAttribute` over it at the right offset.
 * "Interleaved" is a misnomer here; it is the only binding Three offers that
 * takes an offset.
 *
 * The index window needs no such trick: one `GLBufferAttribute` over the whole
 * index buffer plus `geometry.setDrawRange` gives Three the segment's slice.
 *
 * ## The rule that must not be broken
 *
 * **Never call `dispose()` on a geometry bound through here.** Three's
 * `onGeometryDispose` calls `WebGLAttributes.remove`, which calls
 * `gl.deleteBuffer` unconditionally — including for `GLBufferAttribute`, whose
 * buffer it did not create. Disposing would delete **MapLibre's** vertex and
 * index buffers out from under it, and the symptom would be tiles going blank at
 * random rather than anything pointing back here.
 *
 * That inverts the rule for CPU-backed geometry, where `dispose()` is mandatory.
 * It is safe here precisely because this module allocates no GPU memory: there
 * is nothing of Three's to free.
 */

/** The shape this needs from a `SegmentVector` entry. */
export type BucketSegment = {
    vertexOffset: number;
    vertexLength: number;
    primitiveOffset: number;
    primitiveLength: number;
    /**
     * Set only by buckets whose layer has a sort key — `circle` today.
     *
     * It has to travel with the segment rather than be looked up later, because
     * {@link BucketBuffers} drops empty segments: an index into the filtered list
     * no longer matches `bucket.segments.get()`. Reading the key back by index
     * would silently pair a segment with another feature's sort order, and only
     * for buckets that happen to contain an empty segment.
     */
    sortKey?: number;
};

export type BucketBufferSource = {
    /**
     * The bucket's layout buffers — `layoutVertexBuffer`, plus any extra one a
     * layer carries. Their members describe themselves; see `attribute_bridge`.
     */
    layoutBuffers: ReadonlyArray<MapLibreVertexBuffer>;
    /** `bucket.indexBuffer.buffer` or `indexBuffer2.buffer`. */
    indexBuffer: WebGLBuffer;
    /** GL type of one index, e.g. `gl.UNSIGNED_SHORT`. */
    indexType: number;
    indexBytes: 1 | 2 | 4;
    /** Total indices in the buffer, i.e. primitives × `indicesPerPrimitive`. */
    indexCount: number;
    segments: ReadonlyArray<BucketSegment>;
    /** Indices per primitive — 3 for triangles, 2 for outline lines. */
    indicesPerPrimitive: number;
    gl: WebGLRenderingContext;
};

/**
 * One bucket's buffers, in the form Three needs, plus the segment windows.
 *
 * Holds no GPU memory of its own — every field is a descriptor pointing at
 * memory MapLibre owns.
 */
export class BucketBuffers {
    readonly segments: ReadonlyArray<BucketSegment>;

    private readonly _layout: InterleavedAttributes;
    private readonly _indices: GLBufferAttribute;
    private readonly _indicesPerPrimitive: number;

    constructor(source: BucketBufferSource) {
        this._indicesPerPrimitive = source.indicesPerPrimitive;
        this.segments = source.segments.filter(
            (segment) => segment.primitiveLength > 0 && segment.vertexLength > 0);

        this._layout = new InterleavedAttributes(source.layoutBuffers, source.gl);
        this._indices = new GLBufferAttribute(
            source.indexBuffer,
            source.indexType,
            1,
            source.indexBytes,
            source.indexCount,
        );
    }

    /** Attribute names this binds, for the binder cross-check. */
    get names(): Array<string> {
        return this._layout.names;
    }

    /**
     * Points `geometry` at one segment: its layout attributes at the segment's
     * vertex base, and the index window as a draw range.
     *
     * Cheap enough to call per segment per frame — small descriptors, no GPU
     * memory.
     */
    bindSegment(geometry: BufferGeometry, index: number): void {
        const segment = this.segments[index];

        this._layout.bindSegment(geometry, segment.vertexOffset);
        geometry.setIndex(this._indices as unknown as Parameters<BufferGeometry['setIndex']>[0]);
        geometry.setDrawRange(
            segment.primitiveOffset * this._indicesPerPrimitive,
            segment.primitiveLength * this._indicesPerPrimitive,
        );
    }
}

/**
 * Keeps one {@link BucketBuffers} per bucket, keyed by identity.
 *
 * A `WeakMap` is correct here, and would not have been for CPU-backed geometry.
 * These entries own no GPU memory, so letting a dead bucket's entry be collected
 * releases everything there is to release — there is no `dispose()` that must
 * run first, and calling one would delete MapLibre's buffers (see the module
 * comment).
 */
export class BucketBuffersCache {
    private readonly _byBucket = new WeakMap<object, BucketBuffers>();

    get(bucket: object, build: () => BucketBufferSource): BucketBuffers {
        const cached = this._byBucket.get(bucket);
        if (cached) return cached;

        const buffers = new BucketBuffers(build());
        this._byBucket.set(bucket, buffers);
        return buffers;
    }
}
