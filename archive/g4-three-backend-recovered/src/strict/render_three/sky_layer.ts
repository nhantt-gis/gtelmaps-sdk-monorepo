import {BufferGeometry, DoubleSide, Mesh, RawShaderMaterial, Vector2, Vector4} from 'three';

import {getSkyMesh} from '../../render/draw_sky';
import {applyColorMode} from './color_mode_bridge';
import {skyUniformValues} from '../../render/program/sky_program';
import {BucketBuffersCache, type BucketBuffers} from './bucket_geometry';

import type {Camera, WebGLRenderer} from 'three';
import type {Color} from '@maplibre/maplibre-gl-style-spec';
import type {Painter} from '../../render/painter';
import type {Sky} from '../../style/sky';

export type SkyStats = {
    drawn: number;
    fellBack: Record<string, number>;
    skipped: Record<string, number>;
};

const INDICES_PER_TRIANGLE = 3;

export class SkyRenderer {
    readonly stats: SkyStats = {drawn: 0, fellBack: {}, skipped: {}};

    private readonly _buffers = new BucketBuffersCache();
    private readonly _material: RawShaderMaterial;
    private readonly _geometry = new BufferGeometry();
    private readonly _mesh: Mesh;

    constructor() {
        this._material = createSkyMaterial();
        this._mesh = new Mesh(this._geometry, this._material);
        this._mesh.matrixAutoUpdate = false;
        this._mesh.matrixWorldAutoUpdate = false;
        this._mesh.frustumCulled = false;
    }

    private _fallBack(reason: string): false {
        this.stats.fellBack[reason] = (this.stats.fellBack[reason] ?? 0) + 1;
        return false;
    }

    canDraw(painter: Painter): boolean {
        if (painter.options.showOverdrawInspector) return this._fallBack('overdraw-inspector');
        if ((painter.style.projection?.transitionState ?? 0) > 0) return this._fallBack('globe');
        return true;
    }

    draw(renderer: WebGLRenderer, camera: Camera, painter: Painter, sky: Sky): boolean {
        const gl = painter.context.gl;

        const mesh = getSkyMesh(painter.context, sky);
        const buffers = this._buffersFor(mesh, gl);
        if (!buffers || buffers.segments.length === 0) {
            this.stats.skipped['no-quad'] = (this.stats.skipped['no-quad'] ?? 0) + 1;
            return true;
        }

        const material = this._material;
        const values = skyUniformValues(sky, painter.style.map.transform, painter.pixelRatio);
        setColor(material.uniforms.u_sky_color.value as Vector4, values.u_sky_color as unknown as Color);
        setColor(material.uniforms.u_horizon_color.value as Vector4, values.u_horizon_color as unknown as Color);
        (material.uniforms.u_horizon.value as Vector2).fromArray(values.u_horizon as [number, number]);
        (material.uniforms.u_horizon_normal.value as Vector2).fromArray(values.u_horizon_normal as [number, number]);
        material.uniforms.u_sky_horizon_blend.value = values.u_sky_horizon_blend;
        material.uniforms.u_sky_blend.value = values.u_sky_blend;

        material.depthTest = true;
        material.depthWrite = true;
        material.stencilWrite = false;
        material.side = DoubleSide;

        // Read rather than assumed: `drawSky` runs before `renderPass` becomes
        // `opaque`, so which colour mode it gets depends on what the offscreen
        // section left behind. **Translated**, not cast — Three's blend factors
        // are not the GL enums, and casting them cost this layer three rounds of
        // investigation. See `color_mode_bridge.ts`.
        applyColorMode(material, painter.colorModeForRenderPass());
        material.needsUpdate = true;

        gl.depthRange(0, 1);
        for (let i = 0; i < buffers.segments.length; i++) {
            buffers.bindSegment(this._geometry, i);
            renderer.render(this._mesh, camera);
            this.stats.drawn++;
        }
        return true;
    }

    private _buffersFor(
        mesh: {
            vertexBuffer?: {buffer?: WebGLBuffer};
            indexBuffer?: {buffer?: WebGLBuffer};
            segments: {segments: Array<{primitiveLength: number}>};
        },
        gl: WebGLRenderingContext,
    ): BucketBuffers | null {
        if (!mesh.vertexBuffer?.buffer || !mesh.indexBuffer?.buffer) return null;
        return this._buffers.get(mesh, () => ({
            layoutBuffers: [mesh.vertexBuffer as never],
            indexBuffer: mesh.indexBuffer!.buffer!,
            indexType: gl.UNSIGNED_SHORT,
            indexBytes: 2,
            indexCount: mesh.segments.segments.reduce(
                (total, segment) => total + segment.primitiveLength, 0) * INDICES_PER_TRIANGLE,
            segments: mesh.segments.segments as never,
            indicesPerPrimitive: INDICES_PER_TRIANGLE,
            gl,
        }));
    }

    destroy(): void {
        this._material.dispose();
    }
}

function setColor(target: Vector4, color: Color): void {
    target.set(color.r, color.g, color.b, color.a);
}

function createSkyMaterial(): RawShaderMaterial {
    return new RawShaderMaterial({
        vertexShader: `
precision highp float;
attribute vec2 a_pos;

void main() {
    gl_Position = vec4(a_pos, 1.0, 1.0);
}
`,
        fragmentShader: `
precision highp float;
uniform vec4 u_sky_color;
uniform vec4 u_horizon_color;
uniform vec2 u_horizon;
uniform vec2 u_horizon_normal;
uniform float u_sky_horizon_blend;
uniform float u_sky_blend;

void main() {
    vec4 color = vec4(0.0);
    float x = gl_FragCoord.x;
    float y = gl_FragCoord.y;
    float blend = (y - u_horizon.y) * u_horizon_normal.y + (x - u_horizon.x) * u_horizon_normal.x;
    if (blend > 0.0) {
        if (blend < u_sky_horizon_blend) {
            color = mix(u_sky_color, u_horizon_color, pow(1.0 - blend / u_sky_horizon_blend, 2.0));
        } else {
            color = u_sky_color;
        }
    }
    gl_FragColor = mix(color, vec4(vec3(0.0), 0.0), u_sky_blend);
}
`,
        uniforms: {
            u_sky_color: {value: new Vector4()},
            u_horizon_color: {value: new Vector4()},
            u_horizon: {value: new Vector2()},
            u_horizon_normal: {value: new Vector2()},
            u_sky_horizon_blend: {value: 0},
            u_sky_blend: {value: 0},
        },
    });
}
