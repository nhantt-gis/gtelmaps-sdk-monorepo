import {type QueryIntersectsFeatureParams, StyleLayer} from '../style_layer';

import {BuildingGlassBucket} from '../../data/bucket/building_glass_bucket';
import {checkIntersection, projectExtrusion, projectQueryGeometry} from './fill_extrusion_style_layer';
import properties, {type BuildingGlassPaintPropsPossiblyEvaluated} from './building_glass_style_layer_properties.g';
import {translateDistance, translate} from '../query_utils';
import {type Transitionable, type Transitioning, type PossiblyEvaluated} from '../properties';

import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {BucketParameters} from '../../data/bucket';
import type {BuildingGlassPaintProps} from './building_glass_style_layer_properties.g';

export const isBuildingGlassStyleLayer = (layer: StyleLayer): layer is BuildingGlassStyleLayer =>
    layer.type === 'building-glass';

/**
 * An extruded footprint drawn as glass: a translucent fresnel fill plus an edge
 * wireframe.
 *
 * A GTEL layer type, with no upstream MapLibre counterpart. That has one
 * consequence worth stating here rather than discovering in the renderer: when
 * the Three backend declines this layer, **nobody** draws it. Every other
 * migrated type falls back to MapLibre. See `BuildingGlassRenderer.canDraw`.
 */
export class BuildingGlassStyleLayer extends StyleLayer {
    _transitionablePaint: Transitionable<BuildingGlassPaintProps>;
    _transitioningPaint: Transitioning<BuildingGlassPaintProps>;
    paint: PossiblyEvaluated<BuildingGlassPaintProps, BuildingGlassPaintPropsPossiblyEvaluated>;

    constructor(layer: LayerSpecification, globalState: Record<string, any>) {
        super(layer, properties, globalState);
    }

    createBucket(parameters: BucketParameters<BuildingGlassStyleLayer>) {
        // The one cast in this feature, and it is at a type boundary rather than
        // inside logic. `FillExtrusionBucket` is not generic — it is typed to
        // `FillExtrusionStyleLayer` — but the only place it touches a layer's
        // *paint* is the pattern probe, which `BuildingGlassBucket` disables.
        // Everything else it uses (`id`, `_featureFilter`, `isStateDependent`)
        // is on `StyleLayer` and identical for both types.
        return new BuildingGlassBucket(parameters as unknown as BucketParameters<never>);
    }

    queryRadius(): number {
        return translateDistance(this.paint.get('building-glass-translate'));
    }

    is3D(): boolean {
        return true;
    }

    queryIntersectsFeature({
        queryGeometry,
        feature,
        featureState,
        geometry,
        transform,
        pixelsToTileUnits,
        pixelPosMatrix}: QueryIntersectsFeatureParams
    ): boolean | number {
        const translatedPolygon = translate(queryGeometry,
            this.paint.get('building-glass-translate'),
            this.paint.get('building-glass-translate-anchor'),
            -transform.bearingInRadians, pixelsToTileUnits);

        const height = this.paint.get('building-glass-height').evaluate(feature, featureState);
        const base = this.paint.get('building-glass-base').evaluate(feature, featureState);

        const projectedQueryGeometry = projectQueryGeometry(translatedPolygon, pixelPosMatrix, 0);
        const [projectedBase, projectedTop] = projectExtrusion(geometry, base, height, pixelPosMatrix);
        return checkIntersection(projectedBase, projectedTop, projectedQueryGeometry);
    }
}
