import { frustumPlanes, lookAt, mat4, multiply, ortho, type Vec3 } from "../math.ts";
import type { BlockRegistry } from "../sim/blocks.ts";
import type { Catalog } from "../sim/catalog.ts";
import type { Props } from "../sim/props.ts";
import { World } from "../sim/world.ts";
import { SEA_LEVEL } from "../sim/worldgen.ts";
import type { Camera } from "../camera.ts";
import type { AgentView, AnimalView } from "../simclient.ts";
import { BodyModels, buildBodies } from "./body.ts";
import { CropRenderer } from "./crops.ts";
import { buildAnimals, buildFish, defineFishModels, FaunaModels } from "./fauna.ts";
import { anyGrowing, buildProps, FloraModels } from "./flora.ts";
import { F } from "./frame.ts";
import { GrassRenderer } from "./grass.ts";
import { applyLook, type Look, type Weather } from "./look.ts";
import { InstanceBatch, MeshLibrary } from "./meshes.ts";
import { ModelBatch, ModelRenderer } from "./models.ts";
import { PostRenderer } from "./post.ts";
import { SkyRenderer } from "./sky.ts";
import { SurfaceTexture } from "./surface.ts";
import { TerrainRenderer } from "./terrain.ts";
import { WaterRenderer } from "./water.ts";

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
  animals: AnimalView[];
  schools: Float32Array;
  crops: Float32Array;
  cropsVersion: number;
  /** The tick the crops' planting times are relative to. */
  cropsTick: number;
  blocks: BlockRegistry;
  /** What everything looks like: Materials and Designs. */
  catalog: Catalog;
  props: Props | null;
  tick: number;
  day: number;
  weather: Weather;
}

/** Where a frame ends up: the canvas, or an offscreen texture for captures. */
export interface RenderTarget {
  view: GPUTextureView;
  width: number;
  height: number;
  format: GPUTextureFormat;
}

/** Pixels read back from a capture: tightly packed RGBA8, top row first. */
export interface Capture {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

export interface RenderStats {
  gpuMs: number;
  grassBlades: number;
  chunksRebuilt: number;
}

export class Renderer {
  readonly stats: RenderStats = { gpuMs: 0, grassBlades: 0, chunksRebuilt: 0 };
  /** Passes to skip, for profiling: "shadow", "terrain", "grass", "water", "sky", "bodies",
   * "props". */
  debug = new Set<string>();
  private layouts: Layouts;
  private frameData = new Float32Array(F.size);
  private frameBuffer: GPUBuffer;
  private frameBindGroup: GPUBindGroup;
  private plainFrameBindGroup: GPUBindGroup;
  private shadowView: GPUTextureView;
  private terrain: TerrainRenderer;
  private grass: GrassRenderer;
  private surface: SurfaceTexture;
  private water: WaterRenderer;
  private planes = new Float32Array(24);
  private lightPlanes = new Float32Array(24);
  private sky: SkyRenderer;
  private post: PostRenderer;
  /** Mesh templates for everything drawn as instanced models. */
  readonly library = new MeshLibrary();
  private models: ModelRenderer;
  private bodyModels: BodyModels;
  private bodies = new ModelBatch(new InstanceBatch());
  private floraModels: FloraModels;
  private faunaModels: FaunaModels;
  private fishModels: number[];
  /** Culled on the GPU twice: for the view (0) and for the shadow map (1). */
  private flora = new ModelBatch(new InstanceBatch(), 0, 2);
  private groundCover = new ModelBatch(new InstanceBatch(), 70, 1);
  private floraVersion = -1;
  private floraBuiltAt = 0;
  private crops: CropRenderer;
  /** MSAA scene targets for the view, and a separate set for captures at their own size. */
  private viewTargets: SceneTargets | null = null;
  private shotTargets: SceneTargets | null = null;
  private shot: { texture: GPUTexture; buffer: GPUBuffer; bytesPerRow: number } | null = null;
  private timer: GpuTimer | null;
  private lightView = mat4();
  private lightProj = mat4();

  constructor(private device: GPUDevice, private world: World) {
    // Grass culls in a compute pass and samples shadows there, so the frame group is visible everywhere.
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
    this.layouts = {
      frame: device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: VF, buffer: {} },
          { binding: 1, visibility: VF, texture: { sampleType: "depth" } },
          { binding: 2, visibility: VF, sampler: { type: "comparison" } },
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

    this.surface = new SurfaceTexture(device, world);
    this.terrain = new TerrainRenderer(device, world, this.surface, this.layouts);
    this.grass = new GrassRenderer(device, this.surface, this.layouts);
    this.water = new WaterRenderer(device, this.surface, this.layouts, world.sizeY);
    this.sky = new SkyRenderer(device, this.layouts);
    this.post = new PostRenderer(device, this.layouts);
    this.bodyModels = new BodyModels(this.library);
    this.floraModels = new FloraModels(this.library);
    this.faunaModels = new FaunaModels(this.library);
    this.fishModels = defineFishModels(this.library);
    this.models = new ModelRenderer(device, this.layouts, this.library);
    this.crops = new CropRenderer(device, this.layouts);
    this.timer = device.features.has("timestamp-query") ? new GpuTimer(device) : null;
  }

  /** Draw one frame into `out`; `capture` renders use their own scene targets. */
  render(
    camera: Camera,
    look: Look,
    timeOfDay: number,
    time: number,
    scene: SceneState,
    out: RenderTarget,
    capture = false,
  ) {
    const { device } = this;
    const targets = capture
      ? (this.shotTargets = this.sceneTargets(this.shotTargets, out.width, out.height))
      : (this.viewTargets = this.sceneTargets(this.viewTargets, out.width, out.height));

    this.terrain.setBlocks(scene.blocks);
    this.stats.chunksRebuilt = this.terrain.update();
    this.surface.update();
    this.crops.update(scene.crops, scene.cropsVersion);
    this.bodies.instances.clear();
    buildBodies(
      scene.agents,
      time,
      this.bodies.instances,
      camera.yaw,
      this.bodyModels,
      scene.catalog,
    );
    buildAnimals(scene.animals, time, this.bodies.instances, this.faunaModels, scene.catalog);
    buildFish(scene.schools, this.world, time, this.bodies.instances, this.fishModels);
    this.models.upload(this.bodies);
    this.updateFlora(scene, time);

    const fd = this.frameData;
    camera.update(targets.width / targets.height);
    fd.set(camera.viewProj, F.viewProj);
    fd.set(camera.invViewProj, F.invViewProj);
    fd.set(camera.eye, F.cameraPos);
    fd[F.cameraPos + 3] = time;
    applyLook(fd, look, timeOfDay, scene.day, scene.weather);
    fd[F.extra + 2] = SEA_LEVEL;
    fd[F.weather + 2] = scene.tick - scene.cropsTick;
    frustumPlanes(this.planes, camera.viewProj);
    this.updateLight(camera.target, camera.distance);
    frustumPlanes(this.lightPlanes, fd.subarray(F.lightViewProj, F.lightViewProj + 16));

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
    if (!this.debug.has("props")) {
      const cull = encoder.beginComputePass({ label: "models-cull" });
      this.models.cull(cull, this.flora, 0, this.planes, camera.eye);
      this.models.cull(cull, this.flora, 1, this.lightPlanes, camera.eye);
      this.models.cull(cull, this.groundCover, 0, this.planes, camera.eye);
      cull.end();
    }

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
    if (!this.debug.has("shadow")) {
      this.terrain.drawShadow(shadowPass, this.lightPlanes);
      this.models.drawShadow(shadowPass, this.bodies);
      if (!this.debug.has("props")) this.models.drawShadow(shadowPass, this.flora, 1);
    }
    shadowPass.end();
    if (!this.debug.has("grass")) this.grass.cull(encoder, this.frameBindGroup, blades);

    const main = encoder.beginRenderPass({
      colorAttachments: [{
        view: targets.colorView,
        resolveTarget: targets.resolveView,
        loadOp: "clear",
        storeOp: "discard",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
      depthStencilAttachment: {
        view: targets.depthView,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });
    main.setBindGroup(0, this.frameBindGroup);
    const skip = this.debug;
    if (!skip.has("terrain")) this.terrain.draw(main, this.planes);
    if (!skip.has("bodies")) this.models.draw(main, this.bodies);
    if (!skip.has("props")) {
      this.models.draw(main, this.flora);
      this.models.draw(main, this.groundCover);
    }
    this.crops.draw(main);
    if (!skip.has("grass")) this.grass.draw(main);
    if (!skip.has("sky")) this.sky.draw(main, this.plainFrameBindGroup);
    // Transparent last: water blends over everything opaque, including the sky at the horizon.
    main.setBindGroup(0, this.frameBindGroup);
    if (!skip.has("water")) this.water.draw(main, this.planes);
    main.end();

    const post = encoder.beginRenderPass({
      colorAttachments: [{
        view: out.view,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
      timestampWrites: this.timer?.writes(1),
    });
    this.post.draw(post, this.plainFrameBindGroup, targets.post, out.format);
    post.end();

    this.timer?.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    this.timer?.read((ms) => (this.stats.gpuMs = ms));
  }

  /** Rebuild the prop instances when props change, and every couple of seconds while some grow. */
  private updateFlora(scene: SceneState, time: number) {
    const props = scene.props;
    if (!props) return;
    const stale = props.version !== this.floraVersion ||
      (time - this.floraBuiltAt > 2 && anyGrowing(props, scene.tick));
    if (!stale) return;
    this.floraVersion = props.version;
    this.floraBuiltAt = time;
    const { flora, groundCover } = this;
    buildProps(
      props,
      this.world,
      scene.tick,
      flora.instances,
      groundCover.instances,
      this.floraModels,
    );
    this.models.upload(flora);
    this.models.upload(groundCover);
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

  private sceneTargets(have: SceneTargets | null, width: number, height: number): SceneTargets {
    if (have && have.width === width && have.height === height) return have;
    have?.destroy();
    return new SceneTargets(this.device, this.layouts, this.post, width, height);
  }

  /**
   * Render one frame offscreen at `width` × `height` and read it back. `draw` renders the frame
   * into the target it's given (so the caller can pose the camera for it).
   */
  async capture(
    width: number,
    height: number,
    draw: (target: RenderTarget) => void,
  ): Promise<Capture> {
    const { device } = this;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    let shot = this.shot;
    if (!shot || shot.texture.width !== width || shot.texture.height !== height) {
      shot?.texture.destroy();
      shot?.buffer.destroy();
      shot = this.shot = {
        texture: device.createTexture({
          size: [width, height],
          format: "rgba8unorm",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        }),
        buffer: device.createBuffer({
          size: bytesPerRow * height,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
        bytesPerRow,
      };
    }
    draw({ view: shot.texture.createView(), width, height, format: "rgba8unorm" });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: shot.texture },
      { buffer: shot.buffer, bytesPerRow },
      [width, height],
    );
    device.queue.submit([encoder.finish()]);
    await shot.buffer.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(shot.buffer.getMappedRange());
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      data.set(src.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    }
    shot.buffer.unmap();
    return { width, height, data };
  }
}

/** The multisampled HDR scene, its resolve, depth, and the post pass's binding of the resolve. */
class SceneTargets {
  readonly color: GPUTexture;
  readonly resolve: GPUTexture;
  readonly depth: GPUTexture;
  readonly colorView: GPUTextureView;
  readonly resolveView: GPUTextureView;
  readonly depthView: GPUTextureView;
  readonly post: GPUBindGroup;

  constructor(
    device: GPUDevice,
    layouts: Layouts,
    post: PostRenderer,
    readonly width: number,
    readonly height: number,
  ) {
    const { samples, colorFormat, depthFormat } = layouts;
    const make = (format: GPUTextureFormat, sampleCount: number, usage: number) =>
      device.createTexture({ size: [width, height], format, sampleCount, usage });
    this.color = make(colorFormat, samples, GPUTextureUsage.RENDER_ATTACHMENT);
    this.resolve = make(
      colorFormat,
      1,
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    );
    this.depth = make(depthFormat, samples, GPUTextureUsage.RENDER_ATTACHMENT);
    this.colorView = this.color.createView();
    this.resolveView = this.resolve.createView();
    this.depthView = this.depth.createView();
    this.post = post.bindInput(this.resolveView);
  }

  destroy() {
    this.color.destroy();
    this.resolve.destroy();
    this.depth.destroy();
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
      if (ms > 0 && ms < 60_000) { // software adapters take seconds
        this.smoothed = this.smoothed ? this.smoothed * 0.9 + ms * 0.1 : ms;
        onMs(this.smoothed);
      }
    });
  }
}
