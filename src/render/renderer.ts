import { lookAt, mat4, multiply, ortho, type Vec3 } from "../math.ts";
import { World } from "../sim/world.ts";
import type { Camera } from "../camera.ts";
import type { AgentView } from "../simclient.ts";
import { buildBodies, MAX_BOXES_PER_AGENT } from "./body.ts";
import { BOX_FLOATS, BoxRenderer } from "./boxes.ts";
import { CropRenderer } from "./crops.ts";
import { F } from "./frame.ts";
import { GrassRenderer } from "./grass.ts";
import { applyLook, type Look } from "./look.ts";
import { PostRenderer } from "./post.ts";
import { SkyRenderer } from "./sky.ts";
import { TerrainRenderer } from "./terrain.ts";

export interface Layouts {
  /** Group 0 for lit passes: frame uniforms + shadow map + comparison sampler. */
  frame: GPUBindGroupLayout;
  /** Group 0 for passes that only need frame uniforms (shadow, sky, post). */
  shadowFrame: GPUBindGroupLayout;
  colorFormat: GPUTextureFormat;
  depthFormat: GPUTextureFormat;
  samples: number;
}

const SHADOW_SIZE = 2048;

/** What's in the world this frame besides terrain. */
export interface SceneState {
  agents: AgentView[];
  crops: Float32Array;
  cropsVersion: number;
}

export interface RenderStats {
  gpuMs: number;
  grassBlades: number;
  chunksRebuilt: number;
}

export class Renderer {
  readonly stats: RenderStats = { gpuMs: 0, grassBlades: 0, chunksRebuilt: 0 };
  private layouts: Layouts;
  private frameData = new Float32Array(F.size);
  private frameBuffer: GPUBuffer;
  private frameBindGroup: GPUBindGroup;
  private plainFrameBindGroup: GPUBindGroup;
  private shadowView: GPUTextureView;
  private terrain: TerrainRenderer;
  private grass: GrassRenderer;
  private sky: SkyRenderer;
  private post: PostRenderer;
  private boxes: BoxRenderer;
  private crops: CropRenderer;
  private boxData = new Float32Array(MAX_BOXES_PER_AGENT * BOX_FLOATS * 2);
  private targets: {
    width: number;
    height: number;
    color: GPUTexture;
    resolve: GPUTexture;
    depth: GPUTexture;
  } | null = null;
  private timer: GpuTimer | null;
  private lightView = mat4();
  private lightProj = mat4();

  constructor(
    private device: GPUDevice,
    private context: GPUCanvasContext,
    format: GPUTextureFormat,
    world: World,
  ) {
    this.layouts = {
      frame: device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
        ],
      }),
      shadowFrame: device.createBindGroupLayout({
        entries: [{
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {},
        }],
      }),
      colorFormat: "rgba16float",
      depthFormat: "depth24plus",
      samples: 4,
    };

    this.frameBuffer = device.createBuffer({
      size: this.frameData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.shadowView = device.createTexture({
      size: [SHADOW_SIZE, SHADOW_SIZE],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    }).createView();
    const shadowSampler = device.createSampler({
      compare: "less",
      magFilter: "linear",
      minFilter: "linear",
    });
    this.frameBindGroup = device.createBindGroup({
      layout: this.layouts.frame,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: this.shadowView },
        { binding: 2, resource: shadowSampler },
      ],
    });
    this.plainFrameBindGroup = device.createBindGroup({
      layout: this.layouts.shadowFrame,
      entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
    });

    this.terrain = new TerrainRenderer(device, world, this.layouts);
    this.grass = new GrassRenderer(device, world, this.layouts);
    this.sky = new SkyRenderer(device, this.layouts);
    this.post = new PostRenderer(device, this.layouts, format);
    this.boxes = new BoxRenderer(device, this.layouts);
    this.crops = new CropRenderer(device, this.layouts);
    this.timer = device.features.has("timestamp-query") ? new GpuTimer(device) : null;
  }

  render(camera: Camera, look: Look, timeOfDay: number, time: number, scene: SceneState) {
    const { device } = this;
    const canvas = this.context.canvas as HTMLCanvasElement;
    this.ensureTargets(canvas.width, canvas.height);
    const targets = this.targets!;

    this.stats.chunksRebuilt = this.terrain.update();
    this.grass.update();
    this.crops.update(scene.crops, scene.cropsVersion);
    const boxCapacity = scene.agents.length * MAX_BOXES_PER_AGENT * BOX_FLOATS;
    if (this.boxData.length < boxCapacity) this.boxData = new Float32Array(boxCapacity * 2);
    this.boxes.update(this.boxData, buildBodies(scene.agents, time, this.boxData, camera.yaw));

    const fd = this.frameData;
    camera.update(targets.width / targets.height);
    fd.set(camera.viewProj, F.viewProj);
    fd.set(camera.invViewProj, F.invViewProj);
    fd.set(camera.eye, F.cameraPos);
    fd[F.cameraPos + 3] = time;
    applyLook(fd, look, timeOfDay);
    this.updateLight(camera.target, camera.distance);

    const radius = Math.round(Math.min(72, Math.max(20, camera.distance * 0.85)));
    fd[F.grass + 3] = radius;
    fd[F.grassCenter] = Math.floor(camera.target[0]);
    fd[F.grassCenter + 1] = Math.floor(camera.target[2]);
    fd[F.grassCenter + 2] = camera.worldSize[0];
    fd[F.grassCenter + 3] = camera.worldSize[1];
    device.queue.writeBuffer(this.frameBuffer, 0, fd);
    const blades = GrassRenderer.instanceCount(radius, look.bladesPerBlock);
    this.stats.grassBlades = blades;

    const encoder = device.createCommandEncoder();

    const shadowPass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.shadowView,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
      timestampWrites: this.timer?.writes(0),
    });
    shadowPass.setBindGroup(0, this.plainFrameBindGroup);
    this.terrain.drawShadow(shadowPass);
    this.boxes.drawShadow(shadowPass);
    shadowPass.end();

    const main = encoder.beginRenderPass({
      colorAttachments: [{
        view: targets.color.createView(),
        resolveTarget: targets.resolve.createView(),
        loadOp: "clear",
        storeOp: "discard",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
      depthStencilAttachment: {
        view: targets.depth.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });
    main.setBindGroup(0, this.frameBindGroup);
    this.terrain.draw(main);
    this.boxes.draw(main);
    this.crops.draw(main);
    this.grass.draw(main, blades);
    this.sky.draw(main, this.plainFrameBindGroup);
    main.end();

    const post = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
      timestampWrites: this.timer?.writes(1),
    });
    this.post.draw(post, this.plainFrameBindGroup);
    post.end();

    this.timer?.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    this.timer?.read((ms) => (this.stats.gpuMs = ms));
  }

  /** Orthographic sun/moon shadow volume around the view target, snapped to texels to stop shimmer. */
  private updateLight(target: Vec3, distance: number) {
    const fd = this.frameData;
    const dir: Vec3 = [fd[F.sunDir], fd[F.sunDir + 1], fd[F.sunDir + 2]];
    const half = Math.max(24, distance * 1.1);
    const eye: Vec3 = [
      target[0] + dir[0] * 120,
      target[1] + dir[1] * 120,
      target[2] + dir[2] * 120,
    ];
    const up: Vec3 = Math.abs(dir[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
    lookAt(this.lightView, eye, target, up);
    ortho(this.lightProj, half, half, 1, 260);
    const m = fd.subarray(F.lightViewProj, F.lightViewProj + 16);
    multiply(m, this.lightProj, this.lightView);
    const texels = SHADOW_SIZE / 2;
    const ox = m[12] * texels, oy = m[13] * texels;
    m[12] += (Math.round(ox) - ox) / texels;
    m[13] += (Math.round(oy) - oy) / texels;
  }

  private ensureTargets(width: number, height: number) {
    if (this.targets && this.targets.width === width && this.targets.height === height) return;
    if (this.targets) {
      this.targets.color.destroy();
      this.targets.resolve.destroy();
      this.targets.depth.destroy();
    }
    const { samples, colorFormat, depthFormat } = this.layouts;
    const make = (format: GPUTextureFormat, sampleCount: number, usage: number) =>
      this.device.createTexture({ size: [width, height], format, sampleCount, usage });
    this.targets = {
      width,
      height,
      color: make(colorFormat, samples, GPUTextureUsage.RENDER_ATTACHMENT),
      resolve: make(
        colorFormat,
        1,
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      ),
      depth: make(depthFormat, samples, GPUTextureUsage.RENDER_ATTACHMENT),
    };
    this.post.setInput(this.targets.resolve.createView());
  }
}

/** Measures GPU time from the start of the shadow pass to the end of the post pass. */
class GpuTimer {
  private querySet: GPUQuerySet;
  private resolveBuffer: GPUBuffer;
  private readBuffer: GPUBuffer;
  private busy = false;
  private pendingCopy = false;
  private smoothed = 0;

  constructor(device: GPUDevice) {
    this.querySet = device.createQuerySet({ type: "timestamp", count: 2 });
    this.resolveBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.readBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }

  writes(which: 0 | 1): GPURenderPassTimestampWrites {
    return which === 0
      ? { querySet: this.querySet, beginningOfPassWriteIndex: 0 }
      : { querySet: this.querySet, endOfPassWriteIndex: 1 };
  }

  resolve(encoder: GPUCommandEncoder) {
    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuffer, 0);
    this.pendingCopy = !this.busy;
    if (this.pendingCopy) encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, 16);
  }

  read(onMs: (ms: number) => void) {
    if (!this.pendingCopy) return;
    this.busy = true;
    this.readBuffer.mapAsync(GPUMapMode.READ).then(() => {
      const [start, end] = new BigInt64Array(this.readBuffer.getMappedRange());
      this.readBuffer.unmap();
      this.busy = false;
      const ms = Number(end - start) / 1e6;
      if (ms > 0 && ms < 1000) {
        this.smoothed = this.smoothed ? this.smoothed * 0.9 + ms * 0.1 : ms;
        onMs(this.smoothed);
      }
    });
  }
}
