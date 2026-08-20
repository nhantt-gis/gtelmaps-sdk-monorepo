import {
    BackSide,
    BufferGeometry,
    CustomBlending,
    FrontSide,
    Mesh,
    OneFactor,
    OneMinusSrcAlphaFactor,
} from 'three';

import {DepthMode} from '../../gl/depth_mode';
import {StencilMode} from '../../gl/stencil_mode';
import {translatePosition} from '../../util/util';
import {circleUniformValues} from '../../render/program/circle_program';
import {applyProjectionData} from './projection_bridge';
import {applyGlobeProjectionData} from './projection_globe';
import {applyTerrainData} from './terrain_bridge';
import {applyStencilMode} from './stencil_bridge';
import {BucketBuffersCache, type BucketBuffers} from './bucket_geometry';
import {
    attributesCoverBinders,
    compositeInterpolationFactor,
    describeBinders,
    PaintAttributesCache,
    type BinderDescription,
    type PaintAttributes,
} from './paint_binders';
import {CIRCLE_SPECS, CircleMaterialCache} from './circle_program';

import type {Camera, RawShaderMaterial, WebGLRenderer} from 'three';
import type {Color} from '@maplibre/maplibre-gl-style-spec';
import type {CircleBucket} from '../../data/bucket/circle_bucket';
import type {CircleStyleLayer} from '../../style/style_layer/circle_style_layer';
import type {OverscaledTileID} from '../../tile/tile_id';
import type {Painter, RenderOptions} from '../../render/painter';
import type {ProgramConfiguration} from '../../data/program_configuration';
import type {ProjectionData} from '../../geo/projection/projection_data';
import type {TerrainData} from '../../render/terrain';
import type {TileManager} from '../../tile/tile_manager';
import type {CircleUniformsType} from '../../render/program/circle_program';
import type {UniformValues} from '../../render/uniform_binding';

/**
 * Draws `circle` through Three, for the cases it can, and says so when it cannot.
 *
 * ## What is new relative to the layers before it
 *
 * **Draw order is not tile order.** Every layer so far walked `coords` and drew
 * each tile's segments as it went. `circle-sort-key` breaks that: the segments of
 * *all* tiles are flattened into one list, sorted by key, and drawn in that
 * order — so a feature in one tile can be drawn between two features of another.
 *
 * That is why the tile loop below resolves state without drawing, and a second
 * loop draws. The alternative — a sorted path bolted beside an unsorted one —
 * gives two code paths where the fixtures only exercise one of them properly
 * (`circle-sort-key` has a single fixture, every other circle fixture is
 * unsorted), so the sorted path would be the one that rots. Here both run the
 * same code and the sort is a `sort` call.
 *
 * `Array.prototype.sort` is stable in every engine this targets, so an unsorted
 * layer that never calls it, and a layer whose keys are all equal, produce the
 * same order as the nested loop did.
 *
 * ## No stencil at all
 *
 * `drawCircles` uses `StencilMode.disabled`, deliberately: a circle whose centre
 * sits near a tile edge extends past it, and clipping to the tile would slice it
 * in half. So unlike `fill` and `line` there is no per-tile stencil call here —
 * and no `stencilModeForClipping`, which also advances the painter's stencil id
 * as a side effect.
 *
 * ## Where the uniform values come from
 *
 * `circleUniformValues` is imported from `src/render/program/circle_program.ts`
 * and called directly. It is pure arithmetic over the transform, the tile and the
 * layer — no GL, no `Program` — and it holds the pitch-alignment/pitch-scale
 * matrix that decides how a radius in pixels becomes an extrusion. Copying it
 * would mean two implementations of that matrix, and a divergence would show up
 * as circles that are slightly the wrong size only when pitched.
 */
export type CircleStats = {
    drawn: number;
    fellBack: Record<string, number>;

    /** Tiles skipped inside a claimed draw, by reason. See `FillStats.skipped` in `fill_layer.ts` for why this exists. */
    skipped: Record<string, number>;
};

/** The bucket surface this needs, without depending on private fields. */
type SegmentedCircleBucket = CircleBucket<CircleStyleLayer> & {
    zoom: number;
    segments: {segments: Array<{vertexOffset: number; vertexLength: number; primitiveOffset: number; primitiveLength: number; sortKey?: number}>};
    programConfigurations: {get(layerId: string): ProgramConfiguration};
};

/** Everything one tile contributes, resolved before any drawing happens. */
type CircleTileState = {
    /** MapLibre's per-tile DEM lookup, or `null` when the map has no terrain. */
    terrainData: TerrainData | null;
    buffers: BucketBuffers;
    paint: PaintAttributes;
    bucketZoom: number;
    uniforms: UniformValues<CircleUniformsType>;
    projectionData: ProjectionData;
};

/** One segment of one tile, at the position the sort key puts it. */
type CircleSegmentDraw = {
    state: CircleTileState;
    segmentIndex: number;
    sortKey: number;
};

const INDICES_PER_TRIANGLE = 3;

export class CircleRenderer {
    readonly stats: CircleStats = {drawn: 0, fellBack: {}, skipped: {}};

    private readonly _buffers = new BucketBuffersCache();
    private readonly _paintAttributes = new PaintAttributesCache();
    private readonly _materials = new CircleMaterialCache();

    /**
     * One geometry, repointed per segment — same reasoning as `fill`: Three keys
     * binding state by `geometry.id` and releases it only on `dispose()`, which
     * these geometries must never receive.
     */
    private readonly _geometry = new BufferGeometry();
    private readonly _mesh = new Mesh(this._geometry);

    private _fallBack(reason: string): false {
        this.stats.fellBack[reason] = (this.stats.fellBack[reason] ?? 0) + 1;
        return false;
    }

    /** Every `continue` in the resolve loop goes through here. See `FillStats.skipped` in `fill_layer.ts`. */
    private _skip(reason: string): void {
        this.stats.skipped[reason] = (this.stats.skipped[reason] ?? 0) + 1;
    }

    /**
     * Whether this renderer can draw `layer` — asked **before** the context is
     * handed to Three, and before ownership of the layer is claimed. See
     * `LineRenderer.canDraw` for why both halves matter.
     */
    canDraw(
        painter: Painter,
        tileManager: TileManager,
        layer: CircleStyleLayer,
        coords: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
    ): boolean {
        if (painter.options.showOverdrawInspector) return this._fallBack('overdraw-inspector');
        if (renderOptions.isRenderingToTexture) return this._fallBack('render-to-texture');

        const binders = describeBinders(layer.paint as never, CIRCLE_SPECS);
        if (!binders) return this._fallBack('unsupported-expression');

        for (const coord of coords) {
            const bucket = tileManager.getTile(coord)?.getBucket(layer) as SegmentedCircleBucket | undefined;
            if (!bucket?.programConfigurations) continue;
            const paint = this._paintAttributesFor(bucket, layer.id, painter.context.gl);
            if (!attributesCoverBinders(binders, paint.names)) return this._fallBack('binder-mismatch');
        }

        return true;
    }

    /**
     * Draws the layer. Only valid after {@link canDraw} has returned `true`.
     *
     * Always returns `true`: once claimed, the layer is owned in every pass,
     * including the passes that paint nothing.
     */
    draw(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        tileManager: TileManager,
        layer: CircleStyleLayer,
        coords: Array<OverscaledTileID>,
        renderOptions: RenderOptions,
    ): boolean {
        // `drawCircles` leaves immediately outside the translucent pass, so the
        // opaque visit is a no-op that still claims ownership.
        if (painter.renderPass !== 'translucent') return true;

        // Verbatim from `drawCircles`: a fully transparent fill *and* an absent
        // stroke means nothing can appear. Either alone is not enough — a
        // transparent circle with a stroke still draws its ring.
        const opacity = layer.paint.get('circle-opacity');
        const strokeWidth = layer.paint.get('circle-stroke-width');
        const strokeOpacity = layer.paint.get('circle-stroke-opacity');
        if (opacity.constantOr(1) === 0 && (strokeWidth.constantOr(1) === 0 || strokeOpacity.constantOr(1) === 0)) {
            return true;
        }

        const gl = painter.context.gl;
        const transform = painter.transform;
        const binders = describeBinders(layer.paint as never, CIRCLE_SPECS)!;
        const isGlobe = Boolean(painter.style.projection?.useSubdivision);
        const terrain = painter.style.map.terrain;
        const material = this._materials.get(binders, isGlobe, Boolean(terrain));
        this._mesh.material = material;
        this._setConstantUniforms(material, layer, binders);

        const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);
        material.depthTest = depthMode.func !== gl.ALWAYS;
        material.depthWrite = Boolean(depthMode.mask);
        material.transparent = true;
        // ColorMode.alphaBlended, against colours that arrive premultiplied.
        material.blending = CustomBlending;
        material.blendSrc = OneFactor;
        material.blendDst = OneMinusSrcAlphaFactor;
        // MapLibre's CullFaceMode.backCCW: cull back faces, CCW front. Three's
        // FrontSide with its default CCW winding is the same state.
        // MapLibre's CullFaceMode.backCCW, inverted under globe because Three
        // flips the winding itself — see `raster_layer.ts` and §14.
        material.side = isGlobe ? BackSide : FrontSide;
        // Set once, not per tile — see the class comment.
        applyStencilMode(material, StencilMode.disabled, gl);
        material.needsUpdate = true;

        // Only has an effect under globe, which is declined — but it is an input
        // to `circleUniformValues`, so it is read rather than assumed.
        const radiusCorrectionFactor = transform.getCircleRadiusCorrection();
        const translate = layer.paint.get('circle-translate');
        const translateAnchor = layer.paint.get('circle-translate-anchor');
        const sortFeaturesByKey = !layer.layout.get('circle-sort-key').isConstant();

        const draws: Array<CircleSegmentDraw> = [];

        for (const coord of coords) {
            const tile = tileManager.getTile(coord);
            const bucket = tile?.getBucket(layer) as SegmentedCircleBucket | undefined;
            if (!bucket) { this._skip('no-bucket'); continue; }

            const buffers = this._buffersFor(bucket, gl);
            if (!buffers || buffers.segments.length === 0) { this._skip('no-buffers'); continue; }

            const state: CircleTileState = {
                buffers,
                paint: this._paintAttributesFor(bucket, layer.id, gl),
                bucketZoom: bucket.zoom,
                uniforms: circleUniformValues(
                    painter, tile, layer,
                    translatePosition(transform, tile, translate, translateAnchor),
                    radiusCorrectionFactor,
                ),
                projectionData: transform.getProjectionData({
                    overscaledTileID: coord,
                    applyGlobeMatrix: !renderOptions.isRenderingToTexture,
                    applyTerrainMatrix: true,
                }),
                terrainData: terrain?.getTerrainData(coord) ?? null,
            };

            for (let i = 0; i < buffers.segments.length; i++) {
                draws.push({state, segmentIndex: i, sortKey: buffers.segments[i].sortKey ?? 0});
            }
        }

        if (sortFeaturesByKey) draws.sort((a, b) => a.sortKey - b.sortKey);

        gl.depthRange(depthMode.range[0], depthMode.range[1]);
        try {
            for (const draw of draws) {
                const {state} = draw;
                this._applyTileUniforms(material, state.uniforms);
                this._setCompositeFactors(material, layer, binders, state.bucketZoom, transform.zoom);
                if (isGlobe) applyGlobeProjectionData(material, state.projectionData);
                // Per tile: the DEM matrix and the DEM texture both belong to
                // the tile, and neighbours routinely resolve to different DEM
                // tiles. See `terrain_bridge.ts`.
                if (state.terrainData) applyTerrainData(material, state.terrainData);
                applyProjectionData(this._mesh, state.projectionData);

                state.buffers.bindSegment(this._geometry, draw.segmentIndex);
                state.paint.bindSegment(this._geometry, state.buffers.segments[draw.segmentIndex].vertexOffset);
                renderer.render(this._mesh, camera);
                this.stats.drawn++;
            }
        } finally {
            gl.depthRange(0, 1);
        }

        return true;
    }

    /**
     * Copies MapLibre's own uniform values onto the material.
     *
     * `u_globe_extrude_scale` is written **only when the material declares it**,
     * which is only in the globe variant. Skipping it unconditionally was
     * correct while globe was declined, and became three red fixtures the
     * moment it stopped — `circle-planet` and both `pitch-alignment/map-scale-*`
     * cases, all three of them the `u_pitch_with_map` branch and none of the
     * `viewport` ones, because that uniform is read nowhere else.
     *
     * A slot check rather than an `isGlobe` flag: the material already knows
     * which variant it is, and the two cannot then disagree.
     */
    private _applyTileUniforms(
        material: RawShaderMaterial,
        uniforms: UniformValues<CircleUniformsType>,
    ): void {
        material.uniforms.u_camera_to_center_distance.value = uniforms.u_camera_to_center_distance;
        material.uniforms.u_scale_with_map.value = uniforms.u_scale_with_map;
        material.uniforms.u_pitch_with_map.value = uniforms.u_pitch_with_map;
        material.uniforms.u_device_pixel_ratio.value = uniforms.u_device_pixel_ratio;
        material.uniforms.u_extrude_scale.value.fromArray(uniforms.u_extrude_scale);
        material.uniforms.u_translate.value.fromArray(uniforms.u_translate);
        if (material.uniforms.u_globe_extrude_scale) {
            material.uniforms.u_globe_extrude_scale.value = uniforms.u_globe_extrude_scale;
        }
    }

    private _setConstantUniforms(
        material: RawShaderMaterial,
        layer: CircleStyleLayer,
        binders: ReadonlyArray<BinderDescription>,
    ): void {
        for (const binder of binders) {
            if (binder.kind !== 'uniform') continue;
            const slot = material.uniforms[`u_${binder.name}`];
            const value = (layer.paint.get(binder.property as never) as {constantOr(fallback: unknown): unknown})
                .constantOr(null);
            if (binder.glslType === 'float') {
                slot.value = value as number;
            } else {
                const color = value as Color;
                (slot.value as {set(r: number, g: number, b: number, a: number): void})
                    .set(color.r, color.g, color.b, color.a);
            }
        }
    }

    private _setCompositeFactors(
        material: RawShaderMaterial,
        layer: CircleStyleLayer,
        binders: ReadonlyArray<BinderDescription>,
        bucketZoom: number,
        cameraZoom: number,
    ): void {
        for (const binder of binders) {
            if (binder.kind !== 'composite') continue;
            material.uniforms[`u_${binder.name}_t`].value = compositeInterpolationFactor(
                layer.paint.get(binder.property as never), bucketZoom, cameraZoom);
        }
    }

    /** `null` when the bucket has not been uploaded yet. */
    private _buffersFor(bucket: SegmentedCircleBucket, gl: WebGLRenderingContext): BucketBuffers | null {
        if (!bucket.layoutVertexBuffer?.buffer || !bucket.indexBuffer?.buffer) return null;

        return this._buffers.get(bucket, () => ({
            layoutBuffers: [bucket.layoutVertexBuffer as never],
            indexBuffer: bucket.indexBuffer.buffer,
            indexType: gl.UNSIGNED_SHORT,
            indexBytes: 2,
            indexCount: bucket.indexArray.length * INDICES_PER_TRIANGLE,
            segments: bucket.segments.segments,
            indicesPerPrimitive: INDICES_PER_TRIANGLE,
            gl,
        }));
    }

    private _paintAttributesFor(bucket: SegmentedCircleBucket, layerId: string, gl: WebGLRenderingContext): PaintAttributes {
        return this._paintAttributes.get(bucket, bucket.programConfigurations.get(layerId), gl);
    }

    destroy(): void {
        // The geometry is deliberately not disposed: its attributes point at
        // MapLibre's GL buffers. See `bucket_geometry.ts`.
        this._materials.dispose();
    }
}
