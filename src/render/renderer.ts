import { frustumPlanes, lookAt, mat4, multiply, ortho, type Vec3 } from "../math.ts";
import type { BlockRegistry } from "../sim/blocks.ts";
import type { Catalog } from "../sim/catalog.ts";
import type { LightField } from "../sim/light.ts";
import type { Objects } from "../sim/objects.ts";
import type { Props } from "../sim/props.ts";
import { World } from "../sim/world.ts";
import { SEA_LEVEL } from "../sim/worldgen.ts";
import type { Camera } from "../camera.ts";
import type { AgentView, AnimalView, BodyPose } from "../simclient.ts";
import { BodyModels, buildBodies } from "./body.ts";
import { CropRenderer } from "./crops.ts";
import { AmbientOcclusion, type AoTargets } from "./ao.ts";
import { FloatseeDecals } from "./decals.ts";
import { DepthDown } from "./depthdown.ts";
import { createMaterialTexture } from "./materials.ts";
import { FieldMap } from "./fieldmap.ts";
import { buildAnimals, buildFish, defineFishModels, FaunaModels, type FishModel } from "./fauna.ts";
import { anyGrowing, buildObjects, buildProps, CropLooks, FloraModels } from "./flora.ts";
import { F } from "./frame.ts";
import { GrassRenderer } from "./grass.ts";
import { applyLook, type Look, type Weather } from "./look.ts";
import { LightTexture } from "./lighttex.ts";
import { InstanceBatch, MeshLibrary } from "./meshes.ts";
import { ModelBatch, ModelRenderer } from "./models.ts";
import { LifeRenderer } from "./life.ts";
import { ParticleRenderer } from "./particles.ts";
import { type Bloom, PostRenderer } from "./post.ts";
import { LightShafts, type ShaftTargets } from "./shafts.ts";
import { SkyRenderer } from "./sky.ts";
import { SurfaceTexture } from "./surface.ts";
import { TerrainRenderer } from "./terrain.ts";
import { WaterRenderer } from "./water.ts";

export interface Layouts {
  /** Group 0 for lit passes: frame uniforms, shadow map, comparison sampler, light field. */
  frame: GPUBindGroupLayout;
  /** Group 0 for passes that only need frame uniforms (shadow, sky, post). */
  shadowFrame: GPUBindGroupLayout;
  /** Group for transparent passes: resolved opaque color, MSAA scene depth, half linear depth. */
  scene: GPUBindGroupLayout;
  colorFormat: GPUTextureFormat;
  depthFormat: GPUTextureFormat;
  samples: number;
}

const SHADOW_SIZE = 2048;
/** Blocks from the eye past which props draw with their low mesh, per quality tier. */
const LOD_DISTANCES: Record<Quality, number> = { low: 28, medium: 48, high: 75 };

export interface RendererOptions {
  /** Use single-sample targets and smaller shadow maps on mobile and software adapters. */
  lightweight?: boolean;
}

interface DepthEffects {
  depthDown: DepthDown;
  ao: AmbientOcclusion;
  shafts: LightShafts;
}

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
  objects: Objects | null;
  /** Where each Object is this frame. */
  bodies: Map<number, BodyPose>;
  tick: number;
  day: number;
  weather: Weather;
  /** Lamplight, firelight and glowing blocks (the page's copy of the sim's field). */
  light: LightField | null;
  /** What burns (FIRE_STRIDE each). */
  fires: Float32Array;
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

/** Feature tier: `low` (software adapters) keeps the single forward pass; `medium` adds scene
 * depth, AO and shafts; `high` adds SSR and the cloud slab. See the tier table in
 * docs/plans/visual-overhaul.md. */
export type Quality = "low" | "medium" | "high";

export class Renderer {
  readonly stats: RenderStats = { gpuMs: 0, grassBlades: 0, chunksRebuilt: 0 };
  /** Passes to skip, for profiling: "shadow", "terrain", "grass", "water", "sky", "bodies",
   * "props", "fire", "bloom", "depthdown", "ao", "shafts", "life". */
  debug = new Set<string>();
  /**
   * Share of each look's grass blades to draw (0-1]; blades widen to keep the meadow's cover.
   * Grass is most of a software adapter's frame, so CPU-only machines draw fewer.
   */
  grassDensity = 1;
  /** Which passes and shader variants this renderer builds; recreated `SceneTargets` on change. */
  quality: Quality = "high";
  private layouts: Layouts;
  private frameData = new Float32Array(F.size);
  private farFrameData = new Float32Array(F.size);
  private frameBuffer: GPUBuffer;
  /** Same uniforms with the wide cascade's matrix in `lightViewProj`, for the far shadow pass. */
  private farFrameBuffer: GPUBuffer;
  private farFrameBindGroup: GPUBindGroup;
  private frameBindGroup: GPUBindGroup;
  private plainFrameBindGroup: GPUBindGroup;
  private shadowTexture: GPUTexture;
  private shadowView: GPUTextureView;
  private shadowFarView: GPUTextureView;
  private shadowAll: GPUTextureView;
  private farLightPlanes = new Float32Array(24);
  /** Cascade 1's last-drawn matrix and the frame parity it drew on (it redraws at most every
   * other frame, only when its snapped matrix moved). */
  private farDrawn = new Float32Array(16);
  private farEverDrawn = false;
  private farFrames = 0;
  private terrain: TerrainRenderer;
  private grass: GrassRenderer;
  private surface: SurfaceTexture;
  private materialTexture: GPUTexture;
  private fieldmap: FieldMap;
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
  private decals: FloatseeDecals;
  private floraModels: FloraModels;
  private faunaModels: FaunaModels;
  private fishModels: FishModel[];
  /** Culled on the GPU twice: for the view (0) and for the shadow map (1). */
  private flora = new ModelBatch(new InstanceBatch(), 0, 2);
  private groundCover = new ModelBatch(new InstanceBatch(), 70, 1);
  private floraVersion = -1;
  private floraBuiltAt = 0;
  private crops: CropRenderer;
  private cropLooks = new CropLooks();
  private cropLooksVersion = -1;
  /** MSAA scene targets for the view, and a separate set for captures at their own size. */
  private viewTargets: SceneTargets | null = null;
  private shotTargets: SceneTargets | null = null;
  private shot: { texture: GPUTexture; buffer: GPUBuffer; bytesPerRow: number } | null = null;
  private depthEffects: DepthEffects | null = null;
  private timer: GpuTimer | null;
  private lightView = mat4();
  private lightProj = mat4();
  private lightField: LightTexture;
  /** Fire, smoke, lamp halos and signal sparks. */
  readonly particles: ParticleRenderer;
  readonly life: LifeRenderer;

  private shadowSize: number;

  constructor(private device: GPUDevice, private world: World, options: RendererOptions = {}) {
    const samples = options.lightweight ? 1 : 4;
    this.shadowSize = options.lightweight ? SHADOW_SIZE / 2 : SHADOW_SIZE;
    // Grass culls in a compute pass and samples shadows there, so the frame group is visible everywhere.
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
    this.layouts = {
      frame: device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: VF, buffer: {} },
          {
            binding: 1,
            visibility: VF,
            texture: { sampleType: "depth", viewDimension: "2d-array" },
          },
          { binding: 2, visibility: VF, sampler: { type: "comparison" } },
          { binding: 3, visibility: VF, texture: { sampleType: "float", viewDimension: "3d" } },
          { binding: 4, visibility: VF, sampler: { type: "filtering" } },
          // The field map: sky occlusion and shore distance per world column (fieldmap.ts).
          { binding: 5, visibility: VF, texture: { sampleType: "float" } },
          { binding: 6, visibility: VF, sampler: { type: "filtering" } },
          {
            binding: 7,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { viewDimension: "2d-array" },
          },
          { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        ],
      }),
      shadowFrame: device.createBindGroupLayout({
        entries: [{
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {},
        }],
      }),
      scene: device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
          {
            binding: 2,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: "depth", multisampled: samples > 1, viewDimension: "2d" },
          },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        ],
      }),
      colorFormat: "rgba16float",
      depthFormat: "depth24plus",
      samples,
    };

    this.frameBuffer = device.createBuffer({
      size: this.frameData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.shadowTexture = device.createTexture({
      // Two layers: 0 the near box around the target, 1 the ±260-block horizon cascade.
      size: [this.shadowSize, this.shadowSize, 2],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shadowView = this.shadowTexture.createView({
      dimension: "2d",
      baseArrayLayer: 0,
      arrayLayerCount: 1,
    });
    this.shadowFarView = this.shadowTexture.createView({
      dimension: "2d",
      baseArrayLayer: 1,
      arrayLayerCount: 1,
    });
    this.shadowAll = this.shadowTexture.createView({ dimension: "2d-array" });
    const shadowSampler = device.createSampler({
      compare: "less",
      magFilter: "linear",
      minFilter: "linear",
    });
    this.lightField = new LightTexture(device, world);
    this.fieldmap = new FieldMap(device, world);
    this.materialTexture = createMaterialTexture(device);
    this.frameBindGroup = device.createBindGroup({
      layout: this.layouts.frame,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: this.shadowAll },
        { binding: 2, resource: shadowSampler },
        { binding: 3, resource: this.lightField.view },
        { binding: 4, resource: this.lightField.sampler },
        { binding: 5, resource: this.fieldmap.view },
        { binding: 6, resource: this.fieldmap.sampler },
        { binding: 7, resource: this.materialTexture.createView({ dimension: "2d-array" }) },
        {
          binding: 8,
          resource: device.createSampler({
            addressModeU: "repeat",
            addressModeV: "repeat",
            magFilter: "linear",
            minFilter: "linear",
            mipmapFilter: "linear",
          }),
        },
      ],
    });
    this.plainFrameBindGroup = device.createBindGroup({
      layout: this.layouts.shadowFrame,
      entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
    });
    this.farFrameBuffer = device.createBuffer({
      size: this.frameData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.farFrameBindGroup = device.createBindGroup({
      layout: this.layouts.shadowFrame,
      entries: [{ binding: 0, resource: { buffer: this.farFrameBuffer } }],
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
    this.decals = new FloatseeDecals(device, this.layouts);
    this.crops = new CropRenderer(device, this.layouts);
    this.particles = new ParticleRenderer(device, this.layouts);
    this.life = new LifeRenderer(device, this.surface, this.layouts);
    this.timer = device.features.has("timestamp-query") ? new GpuTimer(device) : null;
  }

  /** Free every GPU resource; the render loop must not draw this renderer again. */
  destroy() {
    this.frameBuffer.destroy();
    this.farFrameBuffer.destroy();
    this.shadowTexture.destroy();
    this.viewTargets?.destroy();
    this.shotTargets?.destroy();
    this.shot?.texture.destroy();
    this.shot?.buffer.destroy();
    this.surface.destroy();
    this.fieldmap.destroy();
    this.materialTexture.destroy();
    this.terrain.destroy();
    this.grass.destroy();
    this.water.destroy();
    this.lightField.destroy();
    this.models.destroy();
    this.decals.destroy();
    this.bodies.destroy();
    this.flora.destroy();
    this.groundCover.destroy();
    this.crops.destroy();
    this.particles.destroy();
    this.timer?.destroy();
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
    const low = this.quality === "low";
    const depthEffects = low ? null : (this.depthEffects ??= {
      depthDown: new DepthDown(device, this.layouts),
      ao: new AmbientOcclusion(device, this.layouts),
      shafts: new LightShafts(device, this.layouts),
    });
    const targets = capture
      ? (this.shotTargets = this.sceneTargets(this.shotTargets, out, depthEffects))
      : (this.viewTargets = this.sceneTargets(this.viewTargets, out, depthEffects));

    this.terrain.setBlocks(scene.blocks);
    this.stats.chunksRebuilt = this.terrain.update();
    this.surface.update();
    this.fieldmap.update(this.surface, scene.props, scene.tick);
    this.cropLooks.update(scene.crops, scene.cropsVersion, scene.catalog);
    this.crops.update(this.cropLooks.blades, this.cropLooks.version);
    this.bodies.instances.clear();
    this.decals.clear();
    buildBodies(
      scene.agents,
      time,
      this.bodies.instances,
      this.bodyModels,
      scene.catalog,
      this.decals,
    );
    buildAnimals(scene.animals, time, this.bodies.instances, this.faunaModels, scene.catalog);
    buildFish(scene.schools, this.world, time, this.bodies.instances, this.fishModels);
    if (scene.objects) {
      buildObjects(scene.objects, scene.bodies, this.bodies.instances, this.floraModels);
    }
    this.models.upload(this.bodies);
    this.decals.upload();
    this.updateFlora(scene, time);
    this.particles.update(
      scene.objects,
      scene.bodies,
      scene.agents,
      scene.catalog,
      scene.fires,
      time,
    );

    const fd = this.frameData;
    camera.update(targets.width / targets.height);
    fd.set(camera.viewProj, F.viewProj);
    fd.set(camera.invViewProj, F.invViewProj);
    fd.set(camera.eye, F.cameraPos);
    fd[F.cameraPos + 3] = time;
    applyLook(fd, look, timeOfDay, scene.day, scene.weather);
    fd[F.extra + 2] = SEA_LEVEL;
    this.lightField.update(scene.light);
    fd[F.extra + 3] = scene.light?.lit ? 1 : 0;
    fd[F.weather + 2] = scene.tick - scene.cropsTick;
    const skipBloom = low || this.debug.has("bloom");
    if (skipBloom) fd[F.weather + 3] = 0;
    fd[F.qualityParams] = low ? 0 : this.quality === "medium" ? 1 : 2;
    fd[F.qualityParams + 1] = !low && !this.debug.has("shadow") ? 1 : 0;
    const forwardX = camera.target[0] - camera.eye[0];
    const forwardZ = camera.target[2] - camera.eye[2];
    const forwardLen = Math.hypot(forwardX, forwardZ) || 1;
    fd[F.qualityParams + 2] = forwardX / forwardLen;
    fd[F.qualityParams + 3] = forwardZ / forwardLen;
    frustumPlanes(this.planes, camera.viewProj);
    this.updateLight(camera.target, camera.distance);
    frustumPlanes(this.lightPlanes, fd.subarray(F.lightViewProj, F.lightViewProj + 16));

    const density = Math.min(1, Math.max(0.05, this.grassDensity));
    const bladesPerBlock = Math.max(1, Math.round(look.bladesPerBlock * density));
    fd[F.grass + 1] *= Math.sqrt(look.bladesPerBlock / bladesPerBlock);
    fd[F.grass + 2] = bladesPerBlock;
    fd[F.grassCenter] = Math.floor(camera.eye[0]);
    fd[F.grassCenter + 1] = Math.floor(camera.eye[2]);
    fd[F.grassCenter + 2] = camera.worldSize[0];
    fd[F.grassCenter + 3] = camera.worldSize[1];
    fd[F.depthParams] = 0.5; // camera near (camera.ts perspective)
    fd[F.depthParams + 1] = 4000; // camera far
    fd[F.depthParams + 2] = 1 / targets.width;
    fd[F.depthParams + 3] = 1 / targets.height;
    const blades = GrassRenderer.candidates(
      fd,
      camera.worldSize[0],
      camera.worldSize[1],
      bladesPerBlock,
    );
    this.stats.grassBlades = blades;
    this.fillPushers(fd, scene, camera.target);
    device.queue.writeBuffer(this.frameBuffer, 0, fd);
    // The far shadow pass reads lightViewProj too: give it a copy carrying the wide matrix.
    if (!low) {
      this.farFrameData.set(fd);
      this.farFrameData.copyWithin(F.lightViewProj, F.lightViewProj1, F.lightViewProj1 + 16);
      device.queue.writeBuffer(this.farFrameBuffer, 0, this.farFrameData);
    }

    const encoder = device.createCommandEncoder();
    // The GPU timer's start stamp goes on the frame's first pass, whatever it turns out to be
    // (cull compute today; the cloud slab once it exists); the end stays on the post pass.
    this.stampStarted = false;
    const lodDist = LOD_DISTANCES[this.quality];
    if (!this.debug.has("props")) {
      const cull = encoder.beginComputePass({
        label: "models-cull",
        timestampWrites: this.firstStamp() as GPUComputePassTimestampWrites | undefined,
      });
      this.models.cull(cull, this.flora, 0, this.planes, camera.eye, lodDist);
      this.models.cull(cull, this.flora, 1, this.lightPlanes, camera.eye, 0);
      this.models.cull(cull, this.groundCover, 0, this.planes, camera.eye, lodDist);
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
      timestampWrites: this.firstStamp(),
    });
    shadowPass.setBindGroup(0, this.plainFrameBindGroup);
    if (!this.debug.has("shadow")) {
      this.terrain.drawShadow(shadowPass, this.lightPlanes);
      this.models.drawShadow(shadowPass, this.bodies);
      if (!this.debug.has("props")) this.models.drawShadow(shadowPass, this.flora, 1);
    }
    shadowPass.end();

    // Cascade 1 is skipped on low quality and amortized on medium/high: it redraws only when
    // its snapped matrix actually moved (sun turning or target leaving a texel).
    if (!low) {
      const fm = fd.subarray(F.lightViewProj1, F.lightViewProj1 + 16);
      let moved = false;
      for (let i = 0; i < 16; i++) {
        if (Math.abs(fm[i] - this.farDrawn[i]) > 1e-5) moved = true;
      }
      this.farFrames++;
      const cadence = this.quality === "medium" ? 4 : 2;
      // Posed captures always get a fresh cascade — the amortized layer could belong to the
      // previous frame's pose. With ?debug=shadow the pass still runs so the layer is cleared.
      if (
        capture || !this.farEverDrawn || moved && this.farFrames % cadence === 0 ||
        this.debug.has("shadow")
      ) {
        this.farDrawn.set(fm);
        this.farEverDrawn = true;
        const farPass = encoder.beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: this.shadowFarView,
            depthClearValue: 1,
            depthLoadOp: "clear",
            depthStoreOp: "store",
          },
        });
        farPass.setBindGroup(0, this.farFrameBindGroup);
        if (!this.debug.has("shadow")) {
          this.terrain.drawShadow(farPass, this.farLightPlanes);
          // Flora draws uncullled at its low mesh (view 2 doesn't exist, so drawWith draws all).
          if (!this.debug.has("props")) this.models.drawShadow(farPass, this.flora, 2);
        }
        farPass.end();
      }
    }
    if (!this.debug.has("grass")) this.grass.cull(encoder, this.frameBindGroup, blades);

    const skip = this.debug;
    const msaa = this.layouts.samples > 1;
    if (!depthEffects) {
      // Low tier keeps one forward pass: no stored depth, no opaque/trans split.
      const main = encoder.beginRenderPass({
        colorAttachments: [{
          view: targets.colorView,
          resolveTarget: msaa ? targets.resolveView : undefined,
          loadOp: "clear",
          storeOp: msaa ? "discard" : "store",
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
      if (!skip.has("terrain")) this.terrain.draw(main, this.planes);
      if (!skip.has("bodies")) {
        this.models.draw(main, this.bodies);
        this.decals.draw(main);
      }
      if (!skip.has("props")) {
        this.models.draw(main, this.flora);
        this.models.draw(main, this.groundCover);
      }
      this.crops.draw(main);
      if (!skip.has("grass")) this.grass.draw(main);
      if (!skip.has("sky")) this.sky.draw(main, this.plainFrameBindGroup);
      // Transparent last: water blends over everything opaque, including the sky at the horizon.
      main.setBindGroup(0, this.frameBindGroup);
      if (!skip.has("water")) this.water.draw(main, this.planes, null);
      if (!skip.has("fire")) this.particles.draw(main);
      if (!skip.has("life")) this.life.draw(main, this.quality);
      main.end();
    } else {
      // Opaque stores its color and depth and exposes `opaque`: the scene transparent
      // passes then read (refraction, soft shorelines, AO, shafts).
      const opaque = encoder.beginRenderPass({
        colorAttachments: [{
          view: targets.colorView,
          resolveTarget: msaa ? targets.opaqueView! : undefined,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
        depthStencilAttachment: {
          view: targets.depthView,
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      opaque.setBindGroup(0, this.frameBindGroup);
      if (!skip.has("terrain")) this.terrain.draw(opaque, this.planes);
      if (!skip.has("bodies")) {
        this.models.draw(opaque, this.bodies);
        this.decals.draw(opaque);
      }
      if (!skip.has("props")) {
        this.models.draw(opaque, this.flora);
        this.models.draw(opaque, this.groundCover);
      }
      this.crops.draw(opaque);
      if (!skip.has("grass")) this.grass.draw(opaque);
      if (!skip.has("sky")) this.sky.draw(opaque, this.plainFrameBindGroup);
      opaque.end();
      if (!msaa) {
        encoder.copyTextureToTexture(
          { texture: targets.resolve },
          { texture: targets.opaque! },
          [targets.width, targets.height],
        );
      }

      if (!skip.has("depthdown")) {
        depthEffects.depthDown.draw(
          encoder,
          targets.halfView!,
          targets.depthView,
          this.plainFrameBindGroup,
        );
      }
      if (!skip.has("ao") && targets.ao) {
        depthEffects.ao.draw(
          encoder,
          targets.ao,
          this.plainFrameBindGroup,
          this.quality === "high",
        );
      } else if (targets.ao) {
        // Skipped AO means no occlusion: clear the map to white so post multiplies by 1.
        const clear = encoder.beginRenderPass({
          colorAttachments: [{
            view: targets.ao.out,
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 1, g: 1, b: 1, a: 1 },
          }],
        });
        clear.end();
      }
      if (!skip.has("shafts") && targets.shafts) {
        depthEffects.shafts.draw(
          encoder,
          targets.shafts,
          targets.halfView!,
          this.frameBindGroup,
          this.quality === "high",
        );
      }

      // Transparent: loads the scene color, reads depth without writing, resolves to `resolve`.
      const trans = encoder.beginRenderPass({
        colorAttachments: [{
          view: targets.colorView,
          resolveTarget: msaa ? targets.resolveView : undefined,
          loadOp: "load",
          storeOp: msaa ? "discard" : "store",
        }],
        depthStencilAttachment: {
          view: targets.depthView,
          depthReadOnly: true,
        },
      });
      trans.setBindGroup(0, this.frameBindGroup);
      if (!skip.has("water")) {
        this.water.draw(trans, this.planes, targets.scene, this.quality === "high");
      }
      if (!skip.has("fire")) this.particles.draw(trans);
      if (!skip.has("life")) this.life.draw(trans, this.quality);
      trans.end();
      // In-scattered light lands on the resolve ahead of bloom, so strong shafts glow.
      if (!skip.has("shafts") && targets.shafts) {
        depthEffects.shafts.composite(
          encoder,
          targets.resolveView,
          targets.shafts,
          targets.halfView!,
          this.plainFrameBindGroup,
        );
      }
    }
    if (!skipBloom) this.post.drawBloom(encoder, this.plainFrameBindGroup, targets.bloom);

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
    const looks = this.cropLooks, age = scene.tick - scene.cropsTick;
    const stale = props.version !== this.floraVersion ||
      looks.version !== this.cropLooksVersion ||
      (time - this.floraBuiltAt > 2 &&
        (anyGrowing(props, scene.tick) || looks.growing(scene.crops, age)));
    if (!stale) return;
    this.floraVersion = props.version;
    this.cropLooksVersion = looks.version;
    this.floraBuiltAt = time;
    const { flora, groundCover } = this;
    buildProps(
      props,
      this.world,
      scene.tick,
      flora.instances,
      groundCover.instances,
      this.floraModels,
      { data: scene.crops, looks, age },
    );
    this.models.upload(flora);
    this.models.upload(groundCover);
  }

  /** Scratch distances for the pusher selection (squared, sorted ascending). */
  private pusherD2 = new Float32Array(16);

  private stampStarted = false;
  private pusherCount = 0;
  private pusherFd: Float32Array | null = null;
  private pusherTx = 0;
  private pusherTz = 0;

  /** The frame's first timestamp write — only one pass gets it. */
  private firstStamp() {
    if (this.stampStarted) return undefined;
    this.stampStarted = true;
    return this.timer?.writes(0);
  }

  private putPusher(x: number, y: number, z: number, radius: number) {
    const fd = this.pusherFd as Float32Array;
    const d2 = this.pusherD2;
    const dd = (x - this.pusherTx) ** 2 + (z - this.pusherTz) ** 2;
    if (this.pusherCount === 16 && dd >= d2[15]) return;
    let i = this.pusherCount < 16 ? this.pusherCount++ : 15;
    // Keep slots sorted by distance so the nearest pushers win the 16 slots.
    while (i > 0 && d2[i - 1] > dd) {
      d2[i] = d2[i - 1];
      fd.copyWithin(F.pushers + i * 4, F.pushers + (i - 1) * 4, F.pushers + i * 4);
      i--;
    }
    const o = F.pushers + i * 4;
    fd[o] = x;
    fd[o + 1] = y;
    fd[o + 2] = z;
    fd[o + 3] = radius;
    d2[i] = dd;
  }

  /** Fill `Frame.pushers` with the 16 villagers/animals nearest the camera target. */
  private fillPushers(fd: Float32Array, scene: SceneState, target: Vec3) {
    this.pusherCount = 0;
    this.pusherFd = fd;
    this.pusherTx = target[0];
    this.pusherTz = target[2];
    for (const a of scene.agents) this.putPusher(a.x, a.y, a.z, 0.9);
    for (const a of scene.animals) this.putPusher(a.x, a.y, a.z, 0.75);
    for (let i = this.pusherCount; i < 16; i++) fd[F.pushers + i * 4 + 3] = 0;
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
    const texels = this.shadowSize / 2;
    const ox = m[12] * texels, oy = m[13] * texels;
    m[12] += (Math.round(ox) - ox) / texels;
    m[13] += (Math.round(oy) - oy) / texels;

    // Cascade 1: a fixed ±260-block volume around the target so shadows reach the horizon. Its
    // snapped texels are ~half a block, so it only visibly moves when the sun turns.
    const farHalf = 260;
    const farEye: Vec3 = [
      target[0] + dir[0] * 520,
      target[1] + dir[1] * 520,
      target[2] + dir[2] * 520,
    ];
    lookAt(this.lightView, farEye, target, up);
    ortho(this.lightProj, farHalf, farHalf, 1, 1100);
    const fm = fd.subarray(F.lightViewProj1, F.lightViewProj1 + 16);
    multiply(fm, this.lightProj, this.lightView);
    const farTexels = this.quality === "medium" ? texels / 2 : texels;
    const fx = fm[12] * farTexels, fy = fm[13] * farTexels;
    fm[12] += (Math.round(fx) - fx) / farTexels;
    fm[13] += (Math.round(fy) - fy) / farTexels;
    frustumPlanes(this.farLightPlanes, fm);
  }

  private sceneTargets(
    have: SceneTargets | null,
    { width, height }: RenderTarget,
    depthEffects: DepthEffects | null,
  ): SceneTargets {
    if (
      have && have.width === width && have.height === height && have.quality === this.quality
    ) return have;
    have?.destroy();
    return new SceneTargets(
      this.device,
      this.layouts,
      this.post,
      depthEffects,
      width,
      height,
      this.quality,
    );
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
  readonly bloom: Bloom;
  readonly post: GPUBindGroup;
  /** Resolved opaque color (before water), readable by transparent passes; medium and up. */
  readonly opaque: GPUTexture | null;
  readonly opaqueView: GPUTextureView | null;
  /** Half-res linear view depth from `DepthDown`; medium and up. */
  readonly halfDepth: GPUTexture | null;
  readonly halfView: GPUTextureView | null;
  /** Opaque color + scene depth + half depth, bound to transparent passes; medium and up. */
  readonly scene: GPUBindGroup | null;
  /** GTAO surfaces from the half-res depth; medium and up. */
  readonly ao: AoTargets | null;
  /** Quarter-res light shafts; medium and up. */
  readonly shafts: ShaftTargets | null;

  constructor(
    device: GPUDevice,
    layouts: Layouts,
    post: PostRenderer,
    depthEffects: DepthEffects | null,
    readonly width: number,
    readonly height: number,
    readonly quality: Quality,
  ) {
    const { samples, colorFormat, depthFormat } = layouts;
    const msaa = samples > 1;
    const make = (format: GPUTextureFormat, sampleCount: number, usage: number) =>
      device.createTexture({ size: [width, height], format, sampleCount, usage });
    this.resolve = make(
      colorFormat,
      1,
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
        (msaa ? 0 : GPUTextureUsage.COPY_SRC),
    );
    this.color = msaa
      ? make(colorFormat, samples, GPUTextureUsage.RENDER_ATTACHMENT)
      : this.resolve;
    this.depth = make(
      depthFormat,
      samples,
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    );
    this.resolveView = this.resolve.createView();
    this.colorView = msaa ? this.color.createView() : this.resolveView;
    this.depthView = this.depth.createView();
    this.bloom = post.bloomFor(this.resolveView, width, height);
    if (!depthEffects) {
      this.opaque =
        this.opaqueView =
        this.halfDepth =
        this.halfView =
        this.scene =
          null;
      this.ao = null;
      this.shafts = null;
      this.post = post.bindInput(this.resolveView, this.bloom, null);
    } else {
      this.opaque = make(
        colorFormat,
        1,
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
          (msaa ? 0 : GPUTextureUsage.COPY_DST),
      );
      this.opaqueView = this.opaque.createView();
      const half = [Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2))];
      this.halfDepth = device.createTexture({
        size: half,
        format: "r16float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.halfView = this.halfDepth.createView();
      this.scene = device.createBindGroup({
        layout: layouts.scene,
        entries: [
          { binding: 0, resource: this.opaqueView },
          {
            binding: 1,
            resource: device.createSampler({ magFilter: "linear", minFilter: "linear" }),
          },
          { binding: 2, resource: this.depthView },
          { binding: 3, resource: this.halfView },
        ],
      });
      this.ao = depthEffects.ao.allocate(this.halfView, width, height);
      this.shafts = depthEffects.shafts.allocate(width, height);
      this.post = post.bindInput(this.resolveView, this.bloom, this.ao.out);
    }
  }

  destroy() {
    if (this.color !== this.resolve) this.color.destroy();
    this.resolve.destroy();
    this.depth.destroy();
    this.opaque?.destroy();
    this.halfDepth?.destroy();
    for (const t of this.ao?.textures ?? []) t.destroy();
    this.shafts?.texture.destroy();
    for (const t of this.bloom.textures) t.destroy();
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
    }).catch(() => {}); // destroyed mid-map on a world switch: nothing to read
  }

  destroy() {
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    this.readBuffer.destroy();
  }
}
