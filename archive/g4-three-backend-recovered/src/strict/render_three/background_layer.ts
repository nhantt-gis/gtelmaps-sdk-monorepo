import {
    BackSide,
    BufferAttribute,
    BufferGeometry,
    CustomBlending,
    ExternalTexture,
    FrontSide,
    Mesh,
    OneFactor,
    OneMinusSrcAlphaFactor,
    RawShaderMaterial,
    Vector4,
} from 'three';

import {DepthMode} from '../../gl/depth_mode';
import {EXTENT} from '../../data/extent';
import {applyProjectionData, tileProjectionOptions} from './projection_bridge';
import {applyGlobeProjectionData, globeUniformSlots, projectionGlsl} from './projection_globe';
import {BucketBuffersCache, type BucketBuffers} from './bucket_geometry';
import {applyBackgroundPatternUniforms, createBackgroundPatternMaterial} from './background_pattern_program';
import {bgPatternUniformValues} from '../../render/program/pattern';

import type {Camera, WebGLRenderer} from 'three';
import type {BackgroundStyleLayer} from '../../style/style_layer/background_style_layer';
import type {OverscaledTileID} from '../../tile/tile_id';
import type {Painter} from '../../render/painter';

/**
 * Draws `background` through Three, for the cases it can, and says so when it
 * cannot.
 *
 * ## Scope, stated up front
 *
 * This covers **solid-colour background on the mercator projection without
 * terrain**. Everything else — `background-pattern`, active terrain, globe or a
 * globe transition, the overdraw inspector — returns `false` and MapLibre draws
 * it exactly as before.
 *
 * That partial coverage is the thing most likely to be misread. A render suite
 * run against this scores the same 1558 whether Three drew the backgrounds or
 * fell back on every single one, because the fallback is pixel-identical *by
 * being the same code*. So the pass count alone proves nothing here, which is
 * why {@link BackgroundRenderer.stats} counts draws and fallbacks separately and
 * `probe-backend` asserts the draw count is non-zero.
 *
 * ## Matching MapLibre exactly
 *
 * The fragment shader is `src/shaders/background.fragment.glsl` verbatim:
 * `fragColor = u_color * u_opacity`. `u_color` arrives premultiplied, which is
 * why blending is `ONE, ONE_MINUS_SRC_ALPHA` rather than Three's `NormalBlending`.
 *
 * Geometry is the same quad MapLibre caches — four corners of the tile in in-tile
 * coordinates `0..EXTENT` — and placement comes from the projection bridge, so a
 * vertex lands where `drawBackground` would have put it.
 *
 * ## `depthRange`, which Three has no concept of
 *
 * MapLibre separates layers within the opaque pass by collapsing each sublayer to
 * a single depth value via `gl.depthRange(d, d)`, computed from the layer's index.
 * Three exposes `depthTest` and `depthWrite` on a material but not `depthRange`,
 * so it is set on the raw context around the draw and restored afterwards.
 * Skipping it would put the background at the near plane and hide the entire map.
 */
export type BackgroundStats = {
    /** Tiles drawn by Three. */
    drawn: number;
    /** Layer draws handed back to MapLibre, by reason. */
    fellBack: Record<string, number>;
};

const QUAD_POSITIONS = new Float32Array([
    0, 0,
    EXTENT, 0,
    0, EXTENT,
    EXTENT, EXTENT,
]);

/**
 * Both triangles wound the same way, and wound **clockwise in tile space**.
 *
 * Two things have to be right here and neither is guessable:
 *
 * 1. **Consistency.** `[0,1,2, 1,2,3]` reads as the obvious quad and is wrong:
 *    with vertices at (0,0), (E,0), (0,E), (E,E) its second triangle winds
 *    opposite to its first, so back-face culling drops one and every tile loses
 *    a diagonal half.
 * 2. **Which direction.** The consistent *counter-clockwise* ordering
 *    (`[0,1,2, 1,3,2]`) draws nothing at all — the projection matrix flips Y, so
 *    tile-space CCW arrives at the rasteriser as CW and both triangles are
 *    culled. Measured, not reasoned: that ordering produced an empty
 *    framebuffer, identical for three different background colours.
 *
 * Failure mode 1 is invisible to a centre-pixel check, because the centre can
 * land in the surviving triangle. It survived until `probe-pixels` began hashing
 * whole framebuffers, and it was the cause of the 534-fixture G4-2 failure.
 */
const QUAD_INDICES = new Uint16Array([0, 2, 1, 1, 2, 3]);

/**
 * One body, compiled twice.
 *
 * `projectTile` is the seam: under mercator it is the same matrix multiply this
 * shader always did, under globe it maps the vertex onto a unit sphere first and
 * replaces Z with a horizon-clipping value.
 *
 * The **one-argument** form, as `background.vertex.glsl` writes it — even though
 * a globe background mesh does carry pole vertices. The one-argument
 * `projectToSphere` passes `vec2(0.0)` as `rawPos`, so the explicit pole snap
 * never fires and the pole is placed by the formula instead. That is not a
 * bug upstream left in: for a pole sentinel the mercator Y lands far outside
 * the tile, `atan(exp(...))` saturates, and the formula converges on
 * `(0, ±1, 0)` — the same point the snap would have written.
 *
 * This file used the two-argument form until §18. It agreed, and agreeing by
 * arithmetic is exactly what this port does not bank on.
 */
function colourVertexShader(isGlobe: boolean): string {
    return `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
attribute vec2 a_pos;
${projectionGlsl(isGlobe)}
void main() {
    gl_Position = projectTile(a_pos);
}
`;
}

// Verbatim from src/shaders/background.fragment.glsl.
const FRAGMENT_SHADER = `
precision highp float;
uniform vec4 u_color;
uniform float u_opacity;
void main() {
    gl_FragColor = u_color * u_opacity;
}
`;

export class BackgroundRenderer {
    readonly stats: BackgroundStats = {drawn: 0, fellBack: {}};

    private readonly _geometry: BufferGeometry;
    private readonly _material: RawShaderMaterial;
    private readonly _globeMaterial: RawShaderMaterial;
    private readonly _patternMaterial: RawShaderMaterial;
    private readonly _globePatternMaterial: RawShaderMaterial;
    private readonly _meshBuffers = new BucketBuffersCache();
    private readonly _globeGeometry = new BufferGeometry();
    private _globeMesh!: Mesh;
    private readonly _mesh: Mesh;
    private readonly _externalTextures = new WeakMap<WebGLTexture, ExternalTexture>();

    constructor() {
        this._geometry = new BufferGeometry();
        this._geometry.setAttribute('a_pos', new BufferAttribute(QUAD_POSITIONS, 2));
        this._geometry.setIndex(new BufferAttribute(QUAD_INDICES, 1));

        this._material = new RawShaderMaterial({
            vertexShader: colourVertexShader(false),
            fragmentShader: FRAGMENT_SHADER,
            uniforms: {
                u_color: {value: new Vector4()},
                u_opacity: {value: 1},
            },
            // MapLibre's CullFaceMode.backCCW: cull back faces, CCW front. Three's
            // FrontSide with its default CCW winding is the same state.
            side: FrontSide,
            // u_color is premultiplied, so NormalBlending would double-apply alpha.
            blending: CustomBlending,
            blendSrc: OneFactor,
            blendDst: OneMinusSrcAlphaFactor,
        });

        this._globeMaterial = new RawShaderMaterial({
            vertexShader: colourVertexShader(true),
            fragmentShader: FRAGMENT_SHADER,
            uniforms: {
                u_color: {value: new Vector4()},
                u_opacity: {value: 1},
                ...globeUniformSlots(),
            },
            side: BackSide,
            blending: CustomBlending,
            blendSrc: OneFactor,
            blendDst: OneMinusSrcAlphaFactor,
        });

        this._patternMaterial = createBackgroundPatternMaterial(false);
        this._globePatternMaterial = createBackgroundPatternMaterial(true);
        for (const material of [this._patternMaterial, this._globePatternMaterial]) {
            material.blending = CustomBlending;
            material.blendSrc = OneFactor;
            material.blendDst = OneMinusSrcAlphaFactor;
        }
        this._patternMaterial.side = FrontSide;
        this._globePatternMaterial.side = BackSide;

        this._mesh = new Mesh(this._geometry, this._material);
        this._globeMesh = new Mesh(this._globeGeometry, this._globeMaterial);
    }

    /** Three needs one wrapper per raw texture; see `raster_layer.ts`. */
    private _externalTexture(texture: WebGLTexture): ExternalTexture {
        let wrapper = this._externalTextures.get(texture);
        if (!wrapper) {
            wrapper = new ExternalTexture(texture);
            this._externalTextures.set(texture, wrapper);
        }
        return wrapper;
    }

    /** Mirrors `raster_layer._buffersFor`: MapLibre's mesh, bound not copied. */
    private _buffersFor(
        mesh: {
            vertexBuffer?: {buffer?: WebGLBuffer};
            indexBuffer?: {buffer?: WebGLBuffer};
            segments: {segments: Array<{primitiveLength: number}>};
        },
        gl: WebGLRenderingContext,
    ): BucketBuffers | null {
        if (!mesh.vertexBuffer?.buffer || !mesh.indexBuffer?.buffer) return null;

        return this._meshBuffers.get(mesh, () => ({
            layoutBuffers: [mesh.vertexBuffer as never],
            indexBuffer: mesh.indexBuffer!.buffer!,
            indexType: gl.UNSIGNED_SHORT,
            indexBytes: 2,
            indexCount: mesh.segments.segments.reduce(
                (total, segment) => total + segment.primitiveLength, 0) * 3,
            segments: mesh.segments.segments as never,
            indicesPerPrimitive: 3,
            gl,
        }));
    }

    private _fallBack(reason: string): false {
        this.stats.fellBack[reason] = (this.stats.fellBack[reason] ?? 0) + 1;
        return false;
    }

    /**
     * Whether this renderer can draw `layer` at all — asked **before** the
     * context is handed to Three.
     *
     * Separate from {@link draw} because the handover is not free of side
     * effects. It calls `WebGLRenderer.resetState()` and then MapLibre's
     * `setBaseState()`, and the latter includes `bindFramebuffer.setDefault()`.
     * Doing that around a layer this renderer then declines is not a harmless
     * no-op: under terrain, MapLibre is rendering into an offscreen framebuffer,
     * and resetting the binding mid-pass sends the rest of the layer to the
     * screen instead.
     *
     * That was measured, not theorised. With the handover unconditional, the
     * render suite failed **52 fixtures, every one of them a terrain fixture**,
     * while this renderer had correctly declined every single one of them.
     */
    canDraw(painter: Painter, layer: BackgroundStyleLayer, isRenderingToTexture: boolean): boolean {
        if (painter.options.showOverdrawInspector) return this._fallBack('overdraw-inspector');
        // Under terrain this layer is drawn **only** into the terrain render
        // pool, never straight to the screen — see `three_backend._openThree`.
        // The 52 fixtures above are still the reason `canDraw` sits outside the
        // handover; what changed is which of them this renderer now accepts.
        if (painter.style.map.terrain && !isRenderingToTexture) return this._fallBack('terrain-direct');
        if (!painter.style.map.terrain && isRenderingToTexture) return this._fallBack('render-to-texture');
        return true;
    }

    /**
     * Draws the layer. Only valid after {@link canDraw} has returned `true`.
     *
     * Always returns `true`: once this renderer owns the layer it owns it even
     * when there is nothing to paint — a zero-opacity layer, or a visit in the
     * pass this layer does not belong to. Returning `false` there would let
     * MapLibre draw it as well.
     */
    draw(
        renderer: WebGLRenderer,
        camera: Camera,
        painter: Painter,
        layer: BackgroundStyleLayer,
        coords: Array<OverscaledTileID> | null,
        tileIDs: Array<OverscaledTileID>,
        isRenderingToTexture: boolean,
    ): boolean {
        const color = layer.paint.get('background-color');
        const opacity = layer.paint.get('background-opacity');

        // From here on this renderer owns the layer, so every exit returns true.
        if (opacity === 0) return true;

        const image = layer.paint.get('background-pattern');
        // A pattern whose image has not finished loading: `drawBackground`
        // returns outright rather than drawing an untextured quad, and so must
        // this — the layer is still owned, it simply paints nothing this frame.
        if (image && painter.isPatternMissing(image)) return true;

        // A pattern always carries alpha, so it is never an opaque-pass layer.
        const isOpaque = !image && color.a === 1 && opacity === 1 && painter.opaquePassEnabledForLayer();
        const pass = isOpaque ? 'opaque' : 'translucent';
        if (painter.renderPass !== pass) return true;

        const isGlobe = (painter.style.projection?.transitionState ?? 0) > 0;
        const depthMode = painter.getDepthModeForSublayer(0, isOpaque ? DepthMode.ReadWrite : DepthMode.ReadOnly);
        const material = image ?
            (isGlobe ? this._globePatternMaterial : this._patternMaterial) :
            (isGlobe ? this._globeMaterial : this._material);
        // **Both** meshes, because which one is drawn is decided per tile below
        // and the globe mesh was built with the plain-colour material bound. A
        // patterned globe background with only `_mesh` updated draws the plain
        // material's colour, which is whatever the last solid background left
        // in `u_color`.
        this._mesh.material = material;
        this._globeMesh.material = material;

        if (!image) {
            material.uniforms.u_color.value.set(color.r, color.g, color.b, color.a);
            material.uniforms.u_opacity.value = opacity;
        }
        material.depthTest = depthMode.func !== painter.context.gl.ALWAYS;
        material.depthWrite = Boolean(depthMode.mask);
        material.transparent = !isOpaque;
        material.needsUpdate = true;

        const gl = painter.context.gl;
        const ids = coords && coords.length ? coords : tileIDs;

        const context = painter.context;
        const crossfade = image ? layer.getCrossfadeParameters() : null;
        if (image) {
            // For the **parameter** side effect as much as the binding: Three
            // skips `setTextureParameters` for an external texture, so the atlas
            // would keep whatever filtering it last had. See `texture_bridge.ts`.
            context.activeTexture.set(gl.TEXTURE0);
            painter.imageManager.bind(context);
            material.uniforms.u_image.value =
                this._externalTexture(painter.imageManager.atlasTexture!.texture);
        }

        // See the class comment: Three has no depthRange, and without it the
        // background lands on the near plane and covers the map.
        gl.depthRange(depthMode.range[0], depthMode.range[1]);
        try {
            for (const tileID of ids) {
                // Under globe the geometry comes from **MapLibre's own mesh**:
                // subdivided, and carrying pole vertices. The subdivision is
                // what makes a straight tile edge follow the sphere's curve, and
                // a flat quad would cut a chord across it. Under mercator that
                // same call returns a cached two-triangle quad, so the local one
                // below is kept — it avoids a per-tile lookup and its winding is
                // already paid for (see `QUAD_INDICES`).
                let buffers: BucketBuffers | null = null;
                if (isGlobe) {
                    const mesh = painter.style.projection!.getMeshFromTileID(
                        context, tileID.canonical, false, true, 'raster');
                    buffers = this._buffersFor(mesh as never, gl);
                    if (!buffers || buffers.segments.length === 0) continue;
                    applyGlobeProjectionData(material, painter.transform.getProjectionData(
                        tileProjectionOptions(tileID, isRenderingToTexture)));
                }
                if (image) {
                    // Per tile, not per layer: the pattern's phase depends on
                    // the tile's world-pixel origin, so hoisting this out of the
                    // loop makes every tile repeat the first tile's offset.
                    applyBackgroundPatternUniforms(material, bgPatternUniformValues(
                        image, crossfade!, painter,
                        {tileID, tileSize: painter.transform.tileSize}) as never);
                    material.uniforms.u_opacity.value = opacity;
                }
                // The mesh **being drawn**, not `this._mesh`. Applying it to the
                // wrong one leaves the globe mesh on an identity matrix, which
                // does not fail — it draws the unit sphere in raw clip space, a
                // correct-looking planet at roughly twice the right size.
                applyProjectionData(
                    buffers ? this._globeMesh : this._mesh,
                    painter.transform.getProjectionData(tileProjectionOptions(tileID, isRenderingToTexture)));
                if (!buffers) {
                    renderer.render(this._mesh, camera);
                    this.stats.drawn++;
                    continue;
                }
                for (let i = 0; i < buffers.segments.length; i++) {
                    buffers.bindSegment(this._globeGeometry, i);
                    renderer.render(this._globeMesh, camera);
                    this.stats.drawn++;
                }
            }
        } finally {
            gl.depthRange(0, 1);
        }

        return true;
    }

    destroy(): void {
        // The globe geometry is deliberately **not** disposed: its attributes
        // point at MapLibre's GL buffers. See `bucket_geometry.ts`. Only
        // `_geometry` is this renderer's own.
        this._geometry.dispose();
        // All four, not just the first. Three of them were leaking compiled
        // programs since the globe and pattern variants were added.
        for (const material of [
            this._material, this._globeMaterial,
            this._patternMaterial, this._globePatternMaterial,
        ]) {
            material.dispose();
        }
    }
}
