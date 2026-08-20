import {FillExtrusionBucket} from './fill_extrusion_bucket';
import {register} from '../../util/web_worker_transfer';

/**
 * The `building-glass` geometry — which is exactly the `fill-extrusion`
 * geometry.
 *
 * Glass differs from an extrusion in its material, not in its mesh: same
 * footprint, same walls and roof, same `a_normal_ed` packing. Subclassing rather
 * than copying keeps the two in step through every upstream rebase of the
 * extrusion maths, which is the part that actually changes.
 *
 * The only override is the pattern probe. `building-glass` declares no
 * `-pattern` property on purpose, and the base class would otherwise ask a
 * layer for a property it does not have — see `hasPatternSupport`.
 */
export class BuildingGlassBucket extends FillExtrusionBucket {
    protected override get hasPatternSupport(): boolean { return false; }
    protected override get patternPropertyPrefix(): string { return 'building-glass'; }
}

// **Not optional, and its absence does not error.** Buckets are built in a
// worker and rebuilt on the main thread by `deserialize`, which looks the class
// up by `_classRegistryKey`. That key is set by `register` as a *static*
// property, and static properties are inherited through the class chain — so an
// unregistered subclass silently resolves to its parent's key and comes back
// across the worker boundary as a `FillExtrusionBucket`. No error, no warning,
// just the wrong class. Every other concrete bucket in this directory registers
// itself for the same reason.
register('BuildingGlassBucket', BuildingGlassBucket, {omit: ['layers', 'features']});
