import {GLBufferAttribute, InterleavedBufferAttribute} from 'three';

import type {BufferGeometry} from 'three';

/**
 * Binds MapLibre `VertexBuffer`s as Three attributes, at a segment's vertex base.
 *
 * ## One place, because every layer needs the same thing
 *
 * A bucket's layout buffer, a `line` bucket's second layout buffer, and the
 * paint buffers a `ProgramConfiguration` produces are all the same shape: a
 * `WebGLBuffer` MapLibre has already uploaded, plus a description of the members
 * packed into each vertex. Reading that description off the buffer rather than
 * writing it out per layer means it cannot drift from what the bucket actually
 * built — `line`'s layout is `a_pos_normal` as `Int16×2` followed by `a_data` as
 * `Uint8×4`, and hand-copying those offsets into a second place is how the two
 * quietly disagree after an upstream rebase.
 *
 * ## Mixed types in one buffer
 *
 * `line` is the first layer whose single vertex buffer holds members of
 * *different* types. Three's stride and offset are counted in elements of the
 * attribute's own type, so each member gets its own `GLBufferAttribute` — same
 * `WebGLBuffer`, different element size — and its own stride expressed in those
 * units. A single shared descriptor cannot express it.
 *
 * ## Nothing here owns GPU memory
 *
 * Every attribute points at a buffer MapLibre uploaded and owns. Geometries
 * bound through this must never be `dispose()`d; see `bucket_geometry.ts` for
 * what that would delete.
 */

/** The shape needed from a MapLibre `VertexBuffer`. */
export type MapLibreVertexBuffer = {
    buffer: WebGLBuffer;
    /** Bytes per vertex, across all members. */
    itemSize: number;
    attributes: ReadonlyArray<{name: string; type: string; components: number; offset: number}>;
};

/** MapLibre's `StructArrayMember` types, as GL enum name and byte width. */
const MEMBER_TYPES: Record<string, {glName: string; bytes: 1 | 2 | 4}> = {
    Int8: {glName: 'BYTE', bytes: 1},
    Uint8: {glName: 'UNSIGNED_BYTE', bytes: 1},
    Int16: {glName: 'SHORT', bytes: 2},
    Uint16: {glName: 'UNSIGNED_SHORT', bytes: 2},
    Int32: {glName: 'INT', bytes: 4},
    Uint32: {glName: 'UNSIGNED_INT', bytes: 4},
    Float32: {glName: 'FLOAT', bytes: 4},
};

type BoundAttribute = {
    name: string;
    data: GLBufferAttribute;
    components: number;
    /** Stride in units of this member's own type. */
    strideUnits: number;
    /** Offset within one vertex, in units of this member's own type. */
    offsetUnits: number;
};

export class InterleavedAttributes {
    private readonly _attributes: Array<BoundAttribute> = [];

    constructor(buffers: ReadonlyArray<MapLibreVertexBuffer>, gl: WebGLRenderingContext) {
        for (const vertexBuffer of buffers) {
            for (const member of vertexBuffer.attributes) {
                const type = MEMBER_TYPES[member.type];
                if (!type) {
                    // Binding an unknown type under a guessed GL enum would
                    // reinterpret the bytes rather than fail, so refuse.
                    throw new Error(`Unsupported attribute type '${member.type}' for '${member.name}'`);
                }
                if (member.offset % type.bytes !== 0 || vertexBuffer.itemSize % type.bytes !== 0) {
                    // Three expresses stride and offset in whole elements, so a
                    // member that is not aligned to its own type cannot be
                    // expressed at all. MapLibre's layouts are always aligned;
                    // this catches the day one is not.
                    throw new Error(`Attribute '${member.name}' is not aligned to its ${member.type} size`);
                }

                const data = new GLBufferAttribute(
                    vertexBuffer.buffer,
                    (gl as unknown as Record<string, number>)[type.glName],
                    member.components,
                    type.bytes,
                    0,
                    // Never normalized. Tile coordinates are raw `0..EXTENT`
                    // units, and `line`'s `a_data` is read as raw 0..255 bytes;
                    // normalising either would scale them into uselessness.
                    false,
                );
                // `InterleavedBufferAttribute` reads its stride from the buffer
                // it wraps, and `GLBufferAttribute` has no such field.
                (data as unknown as {stride: number}).stride = vertexBuffer.itemSize / type.bytes;

                this._attributes.push({
                    name: member.name,
                    data,
                    components: member.components,
                    strideUnits: vertexBuffer.itemSize / type.bytes,
                    offsetUnits: member.offset / type.bytes,
                });
            }
        }
    }

    /** Whether anything needs binding — false for an all-constant paint set. */
    get isEmpty(): boolean {
        return this._attributes.length === 0;
    }

    /** Attribute names, for tests and for the binder cross-check. */
    get names(): Array<string> {
        return this._attributes.map((attribute) => attribute.name);
    }

    /**
     * Binds every member for one segment.
     *
     * The same `vertexOffset` positions layout and paint buffers alike: paint
     * arrays are populated per vertex, in lockstep with the layout array.
     *
     * A **new** `InterleavedBufferAttribute` each call is deliberate. Three
     * decides whether to re-bind by comparing attribute **identity**, not
     * contents, so mutating `offset` in place would leave the previous segment's
     * binding active and silently draw the wrong vertices.
     */
    bindSegment(geometry: BufferGeometry, vertexOffset: number): void {
        for (const attribute of this._attributes) {
            geometry.setAttribute(attribute.name, new InterleavedBufferAttribute(
                attribute.data as unknown as ConstructorParameters<typeof InterleavedBufferAttribute>[0],
                attribute.components,
                vertexOffset * attribute.strideUnits + attribute.offsetUnits,
                false,
            ));
        }
    }
}
