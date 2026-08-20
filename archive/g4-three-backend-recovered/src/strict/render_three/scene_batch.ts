import {BufferGeometry, Mesh, Scene} from 'three';

import type {Camera, Object3D, RawShaderMaterial, WebGLRenderer} from 'three';
import type {ProjectionData} from '../../geo/projection/projection_data';

/**
 * Collects a layer's draws and issues them as **one** `renderer.render()`.
 *
 * ## Why one shared mesh had to become many
 *
 * Every renderer so far reuses one geometry, one mesh and one material,
 * repointing them before each draw. That is why each draw has to be issued
 * immediately: the next iteration overwrites the state it depends on. It also
 * costs a `renderer.render()` per segment per tile per layer.
 *
 * §7c measured what that costs, on a synthetic mesh shaped like a real one:
 *
 * | | µs per draw |
 * |---|---|
 * | shared geometry, repointed, `N × render(mesh)` | 2,26 |
 * | `N` geometries bound once, `1 × render(scene)` | 1,03 |
 *
 * About 0,7 µs of the difference is `render()`'s own fixed cost and the rest is
 * the re-binding. **Both** need separate objects per draw, which is what this
 * class hands out.
 *
 * §7c also measured the honest ceiling: that 2,26 µs is a fifth of the ~11 µs
 * the backend actually spends per draw, so this removes roughly a tenth of the
 * transitional cost, not most of it. The rest is the backend's own per-tile
 * JavaScript, and it is not addressed here.
 *
 * ## The rule that must not be broken, inherited
 *
 * These geometries bind MapLibre's GL buffers, so **none of them may ever be
 * `dispose()`d** — see `bucket_geometry.ts`. That is why slots are cached by key
 * and reused across frames rather than built per frame: the cache is bounded by
 * the visible tiles of one layer, and nothing in it needs freeing because
 * nothing in it owns GPU memory.
 *
 * ## Draw order
 *
 * The map is a painter's algorithm; Three's own sorting would reorder it. So
 * `sortObjects` is turned off and slots render in the order they were added.
 * Three still splits its render list into opaque and transparent, so a caller
 * must not mix the two within one flush — every renderer that uses this
 * batches a single pass, where `transparent` is constant.
 */
export type BatchSlot = {
    mesh: Object3D;
    geometry: BufferGeometry;
    material: RawShaderMaterial;
    /** True on the frame the slot was created, so constants are set once. */
    isNew: boolean;
};

type CachedSlot = {
    base: RawShaderMaterial;
    mesh: Object3D;
    geometry: BufferGeometry;
    material: RawShaderMaterial;
};

/**
 * How to wrap a geometry for drawing.
 *
 * Not always a `Mesh`: `fill`'s outline pass draws **line primitives**, and
 * handing those to a `Mesh` renders the outline as filled triangles instead —
 * which looks like a slightly wrong fill rather than a missing outline. The
 * first version of this file did exactly that, and `fill_layer.test.ts` caught
 * it before the gate did.
 */
export type SlotFactory = (geometry: BufferGeometry, material: RawShaderMaterial) => Object3D;

export class SceneBatch {
    private readonly _scene = new Scene();
    private readonly _cache = new Map<string, CachedSlot>();
    private readonly _pending: Array<Object3D> = [];
    /** What the scene currently holds, so an unchanged pass rebuilds nothing. */
    private _current: Array<Object3D> = [];

    constructor(private readonly _create: SlotFactory = (geometry, material) => new Mesh(geometry, material)) {}

    /** Starts a pass. Slots added before this are forgotten, not drawn. */
    begin(): void {
        this._pending.length = 0;
    }

    /**
     * A mesh/geometry/material triple for one draw, cached under `key`.
     *
     * `isNew` says whether the caller still has to write the values that do not
     * change between frames — the constant uniforms and the material's blend and
     * depth state. Writing them every frame for every tile would hand back a
     * good part of what the batching just saved.
     *
     * The clone is what makes per-draw uniforms possible at all. Three caches
     * compiled programs by shader source, so every clone of one base shares a
     * single program.
     */
    slot(key: string, base: RawShaderMaterial): BatchSlot {
        let cached = this._cache.get(key);
        let isNew = false;
        // A different base means a different paint configuration, so the clone
        // is stale — its uniform set no longer matches the shader.
        if (!cached || cached.base !== base) {
            const material = base.clone() as RawShaderMaterial;
            const geometry = new BufferGeometry();
            const mesh = this._create(geometry, material);
            // With an identity projection every bounding sphere collides, so
            // Three's culling would be arbitrary — see `projection_bridge.ts`.
            mesh.frustumCulled = false;
            mesh.matrixAutoUpdate = false;
            mesh.matrixWorldAutoUpdate = false;
            cached = {base, mesh, geometry, material};
            this._cache.set(key, cached);
            isNew = true;
        }
        this._pending.push(cached.mesh);
        return {mesh: cached.mesh, geometry: cached.geometry, material: cached.material, isNew};
    }

    /** Draws everything added since {@link begin}, in that order. Returns the count. */
    flush(renderer: WebGLRenderer, camera: Camera): number {
        const count = this._pending.length;
        if (count === 0) return 0;

        // Rebuilt only when the set or its order actually changed. `Scene.clear`
        // followed by `add` re-parents every child and dispatches `removed` and
        // `added` for each, which on a small pass costs more than the batching
        // saves — the first measurement of this class showed exactly that, with
        // one-layer scenes getting *slower*. Between frames the set is normally
        // identical, so normally this does nothing.
        if (!sameObjects(this._current, this._pending)) {
            this._scene.clear();
            for (const mesh of this._pending) this._scene.add(mesh);
            this._current = [...this._pending];
        }
        // The map is a painter's algorithm; Three's sort would reorder it.
        renderer.sortObjects = false;
        renderer.render(this._scene, camera);
        this._pending.length = 0;
        return count;
    }
}

function sameObjects(a: ReadonlyArray<Object3D>, b: ReadonlyArray<Object3D>): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/** Puts a tile-space slot where `data` says it goes. Mirrors `applyProjectionData`. */
export function positionSlot(slot: BatchSlot, data: ProjectionData): void {
    slot.mesh.matrix.fromArray(data.mainMatrix as unknown as ArrayLike<number>);
    slot.mesh.matrixWorld.copy(slot.mesh.matrix);
}
