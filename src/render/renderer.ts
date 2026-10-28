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
import { anyGrowing, buildObjects, buildProps, FloraModels } from "./flora.ts";
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
  blocks: BlockRegistry;
  /** What everything looks like: Materials and Designs. */
  catalog: Catalog;
  props: Props | null;
  /** Built Designs, drawn from their parts. */
  objects: { design: number; x: number; y: number; z: number }[];
  objectsVersion: number;
  tick: number;
  day: number;
  weather: Weather;
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
  private flora = new ModelBatch(new InstanceBatch());
  private groundCover = new ModelBatch(new InstanceBatch(), 70);
  private built = new ModelBatch(new InstanceBatch());
  private floraVersion = -1;
  private objectsVersion = -1;
  private floraBuiltAt = 0;
  private crops: CropRenderer;
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
    private world: World,
  ) {
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
    this.water = new WaterRenderer(device, this.surface, this.layouts);
    this.sky = new SkyRenderer(device, this.layouts);
    this.post = new PostRenderer(device, this.layouts, format);
    this.bodyModels = new BodyModels(this.library);
    this.floraModels = new FloraModels(this.library);
    this.faunaModels = new FaunaModels(this.library);
    this.fishModels = defineFishModels(this.library);
    this.models = new ModelRenderer(device, this.layouts, this.library);
    this.crops = new CropRenderer(device, this.layouts);
    this.timer = device.features.has("timestamp-query") ? new GpuTimer(device) : null;
  }

  render(camera: Camera, look: Look, timeOfDay: number, time: number, scene: SceneState) {
    const { device } = this;
    const canvas = this.context.canvas as HTMLCanvasElement;
    this.ensureTargets(canvas.width, canvas.height);
    const targets = this.targets!;

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
    this.updateObjects(scene);

    const fd = this.frameData;
    camera.update(targets.width / targets.height);
    fd.set(camera.viewProj, F.viewProj);
    fd.set(camera.invViewProj, F.invViewProj);
    fd.set(camera.eye, F.cameraPos);
    fd[F.cameraPos + 3] = time;
    applyLook(fd, look, timeOfDay, scene.day, scene.weather);
    fd[F.extra + 2] = SEA_LEVEL;
    frustumPlanes(this.planes, camera.viewProj);
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
    if (!this.debug.has("shadow")) {
      this.terrain.drawShadow(shadowPass);
      this.models.drawShadow(shadowPass, this.bodies);
      if (!this.debug.has("props")) {
        this.models.drawShadow(shadowPass, this.flora);
        this.models.drawShadow(shadowPass, this.built);
      }
    }
    shadowPass.end();
    if (!this.debug.has("grass")) this.grass.cull(encoder, this.frameBindGroup, blades);

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
    const skip = this.debug;
    if (!skip.has("terrain")) this.terrain.draw(main, this.planes);
    if (!skip.has("bodies")) this.models.draw(main, this.bodies);
    if (!skip.has("props")) {
      this.models.draw(main, this.flora);
      this.models.draw(main, this.built);
      this.models.draw(main, this.groundCover);
    }
    this.crops.draw(main);
    if (!skip.has("grass")) this.grass.draw(main);
    if (!skip.has("sky")) this.sky.draw(main, this.plainFrameBindGroup);
    // Transparent last: water blends over everything opaque, including the sky at the horizon.
    main.setBindGroup(0, this.frameBindGroup);
    if (!skip.has("water")) this.water.draw(main);
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

  /** Rebuild part Objects when one is built or taken down. */
  private updateObjects(scene: SceneState) {
    if (scene.objectsVersion === this.objectsVersion) return;
    this.objectsVersion = scene.objectsVersion;
    buildObjects(scene.objects, scene.catalog, this.built.instances, this.floraModels);
    this.models.upload(this.built);
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
