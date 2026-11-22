import { materialWgsl } from "./materials.ts";
import type { Vec3 } from "../math.ts";
import { frameWgsl, lightingWgsl } from "./frame.ts";
import {
  INSTANCE_FLOATS,
  type InstanceBatch,
  type MeshLibrary,
  type MeshRange,
  VERTEX_BYTES,
} from "./meshes.ts";
import type { Layouts } from "./renderer.ts";

/**
 * Instanced mesh templates: bodies, animals, trees, rocks and anything agents define. Every
 * template lives in one shared vertex/index buffer; a batch draws each template once with all its
 * instances. Vertex colors are multiplied by the instance tint, and vertices sway in the wind by
 * their sway weight times the instance's wind weight (bodies use 0).
 *
 * Big batches (props) are culled on the GPU per view: a compute pass tests each instance's
 * bounding sphere against the view's frustum (and fade distance), packs the survivors per template
 * and writes the indirect draw arguments, so neither the view nor the shadow map draws what it
 * can't see.
 */
const shader = frameWgsl + lightingWgsl + materialWgsl + /* wgsl */ `
struct Instance { model: mat4x4f, tint: vec4f };
@group(1) @binding(0) var<storage, read> instances: array<Instance>;
/** x: distance beyond which instances aren't drawn (0 = always), y: fade band width. */
@group(1) @binding(1) var<uniform> batch: vec4f;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec4f,
  @location(2) color: vec4f,
  @location(3) surf: vec4f,
};

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) glow: f32,
  /** How loose in the wind (0-1): leaves and needles, which light shines through. */
  @location(4) leaf: f32,
  /** Surface roughness, from the Material's pattern (metal and glass glint, wood doesn't). */
  @location(5) rough: f32,
  @location(6) local: vec3f,
  @location(7) localNormal: vec3f,
  @location(8) @interpolate(flat) pattern: u32,
};

/** Wind sway: a slow lean with the gusts plus a quick flutter, scaled by how loose a vertex is. */
fn windOffset(world: vec3f, origin: vec3f, sway: f32) -> vec3f {
  if (sway <= 0.0) { return vec3f(0.0); }
  let t = frame.cameraPos.w;
  let w = frame.wind;
  let gust = valueNoise(origin.xz * 0.06 - w.xy * t * 0.8);
  let lean = gust * 0.8 + sin(t * 1.3 + dot(origin.xz, vec2f(0.37, 0.23))) * 0.25;
  // Three scales: the whole tree leans with the gusts (the same field the grass reads), branches
  // lag a slower sway of their own, and leaf tips flutter fast.
  let branch = sin(t * 2.9 + dot(origin.xz, vec2f(0.53, 0.71)) + gust * 4.0) * 0.12;
  let flutter = sin(t * 6.0 + dot(world, vec3f(3.1, 1.7, 2.3))) * 0.05;
  return (vec3f(w.x, 0.0, w.y) * (lean * 0.22 + branch) + vec3f(flutter, flutter * 0.5, -flutter)) *
    w.z * sway;
}

fn place(v: VIn, ii: u32) -> vec3f {
  let inst = instances[ii];
  let world = (inst.model * vec4f(v.pos, 1.0)).xyz;
  return world + windOffset(world, inst.model[3].xyz, v.color.a * inst.tint.a);
}

@vertex fn vs(v: VIn, @builtin(instance_index) ii: u32) -> Out {
  let inst = instances[ii];
  let world = place(v, ii);
  let n = normalize((inst.model * vec4f(v.normal.xyz, 0.0)).xyz);
  var albedo = pow(v.color.rgb, vec3f(2.2)) * inst.tint.rgb;
  // Per-instance hue/value jitter so a stand of one species doesn't read as copies of one tree.
  albedo *= 0.9 + 0.2 * hash21(inst.model[3].xz);
  var clip = frame.viewProj * vec4f(world, 1.0);
  if (batch.x > 0.0) {
    // Small things shrink into the ground past the fade distance, then aren't rasterized at all.
    let d = distance(inst.model[3].xyz, frame.cameraPos.xyz);
    let k = 1.0 - smoothstep(batch.x - batch.y, batch.x, d);
    let sunk = mix(inst.model[3].xyz, world, k);
    clip = select(frame.viewProj * vec4f(sunk, 1.0), vec4f(0.0, 0.0, 2.0, 1.0), k <= 0.0);
  }
  // Glow: positive always; negative only while the instance's lights are on (tint.a >= 0).
  let g = v.normal.w;
  let glow = select(max(-g, 0.0) * step(0.0, inst.tint.a), g, g > 0.0);
  return Out(clip, world, n, albedo, glow, clamp(v.color.a * inst.tint.a, 0.0, 1.0), v.surf.x,
    v.pos, v.normal.xyz, u32(round(v.surf.y * 255.0)));
}

@vertex fn vsShadow(v: VIn, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  return frame.lightViewProj * vec4f(place(v, ii), 1.0);
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  // Triplanar in the undeformed mesh so paint follows rig motion and wind. World-scale
  // templates share the same brush size regardless of their primitive tessellation.
  let p = in.local * 0.92;
  let sides = pow(abs(in.localNormal), vec3f(4.0));
  let weights = sides / max(dot(sides, vec3f(1.0)), 1e-5);
  let grain = dot(weights, vec3f(
    textureSample(grainTiles, grainSampler, p.zy, in.pattern).r,
    textureSample(grainTiles, grainSampler, p.xz, in.pattern).r,
    textureSample(grainTiles, grainSampler, p.xy, in.pattern).r));
  let albedo = in.color * (1.0 + (grain - 0.5) * vec3f(0.98, 0.82, 0.7));
  let n = reliefNormal(normalize(in.normal), in.world, grain * 0.018);
  let view = normalize(frame.cameraPos.xyz - in.world);
  var c = shade(albedo, n, in.world, 1.0, 0.25) + selfLit(albedo * in.glow * EMISSIVE);
  // Plants sit in the meadow's pooled shade like the grass does; bodies and props keep theirs.
  if (in.leaf > 0.3) { c *= mix(1.0, fieldAt(in.world.xz).x, 0.5); }
  // The same specular term the terrain's pattern surfaces get: smooth Materials catch the sun,
  // wood and cloth stay matte. Off for leaves, whose sheen is the translucency below.
  let gloss = (1.0 - in.rough) * (1.0 - in.leaf);
  if (gloss > 0.02) {
    let hdir = normalize(view + frame.sunDir.xyz);
    c += frame.sunColor.rgb * frame.sunDir.w * keyLight(in.world, n) *
      pow(max(dot(n, hdir), 0.0), mix(12.0, 180.0, gloss * gloss)) * gloss * gloss * 0.6;
    c += skyColor(reflect(-view, n)) * pow(1.0 - max(dot(n, view), 0.0), 5.0) * gloss * 0.5;
  }
  // Sky light grazing the silhouette rounds off low-poly shapes and lifts them off the ground.
  let painterly = frame.lookParams.y;
  let rimPow = mix(3.0, 2.35, painterly);
  let rim = pow(clamp(1.0 - dot(n, view), 0.0, 1.0), rimPow) * (0.4 + 0.6 * max(n.y, 0.0));
  c += albedo * mix(frame.skyHorizon.rgb, frame.skyZenith.rgb, max(n.y, 0.0)) *
    frame.sunColor.w * rim * mix(0.6, 0.92, painterly);
  // Soft warm painted-ceramic top sheen in Miniature mode (gives figurines their sculptural feel).
  if (painterly > 0.01 && in.leaf < 0.25) {
    let upLift = smoothstep(0.15, 0.95, n.y) * (1.0 - in.rough * 0.5) * 0.14 * painterly;
    c += albedo * mix(vec3f(1.0, 0.94, 0.82), vec3f(0.72, 0.78, 1.0), frame.extra.x) * upLift;
  }
  // Crowns between the eye and the sun glow: light comes through the leaves.
  let back = pow(max(dot(-view, frame.sunDir.xyz), 0.0), 3.0) * in.leaf;
  if (back > 0.004) {
    c += albedo * frame.sunColor.rgb * frame.sunDir.w * back * 0.45 * cloudLight(in.world);
  }
  return vec4f(fog(c, in.world), 1.0);
}
`;

const cullShader = /* wgsl */ `
struct Instance { model: mat4x4f, tint: vec4f };
struct Args {
  indexCount: u32,
  instanceCount: atomic<u32>,
  firstIndex: u32,
  baseVertex: i32,
  firstInstance: u32,
};
struct Cull { planes: array<vec4f, 6>, eye: vec3f, fade: f32, count: u32, templates: u32, lod: f32 };
@group(0) @binding(0) var<uniform> cull: Cull;
@group(0) @binding(1) var<storage, read> src: array<Instance>;
@group(0) @binding(2) var<storage, read> templates: array<u32>;
@group(0) @binding(3) var<storage, read> radii: array<f32>;
@group(0) @binding(4) var<storage, read_write> dst: array<Instance>;
@group(0) @binding(5) var<storage, read_write> args: array<Args>;

@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= cull.count) { return; }
  let inst = src[i];
  let t = templates[i];
  let m = inst.model;
  let c = m[3].xyz;
  // The template's radius around its origin, scaled, plus room for the wind to sway it.
  let r = radii[t] * max(length(m[0].xyz), max(length(m[1].xyz), length(m[2].xyz))) + 0.5;
  for (var p = 0; p < 6; p++) {
    let plane = cull.planes[p];
    if (dot(plane.xyz, c) + plane.w < -r * length(plane.xyz)) { return; }
  }
  let d = distance(c, cull.eye);
  if (cull.fade > 0.0 && d > cull.fade) { return; }
  // Near survivors pack into template t's record, far ones into its low-mesh record.
  let slot = select(t, cull.templates + t, d >= cull.lod);
  let k = atomicAdd(&args[slot].instanceCount, 1u);
  dst[args[slot].firstInstance + k] = inst;
}
`;

/** Bytes of one drawIndexedIndirect record. */
const ARGS_BYTES = 20;

/** One view's culled copy of a batch: packed survivors and their draw arguments. */
interface CullView {
  instances: GPUBuffer;
  args: GPUBuffer;
  uniform: GPUBuffer;
  /** Bound on first cull (and again whenever the template radii move). */
  cullGroup: GPUBindGroup | null;
  drawGroup: GPUBindGroup;
}

const vertexLayout: GPUVertexBufferLayout = {
  arrayStride: VERTEX_BYTES,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "snorm8x4" },
    { shaderLocation: 2, offset: 16, format: "unorm8x4" },
    { shaderLocation: 3, offset: 20, format: "unorm8x4" },
  ],
};

/** GPU copy of an `InstanceBatch`. */
export class ModelBatch {
  private buffer: GPUBuffer | null = null;
  private params: GPUBuffer | null = null;
  bindGroup: GPUBindGroup | null = null;
  /** Template ids per instance, read by the cull pass. */
  private ids: GPUBuffer | null = null;
  /** Templates the instances were sorted for; the args buffer holds 2 records per template. */
  templates = 0;
  /** Fresh draw arguments (no instances yet) per template, copied in before each cull. */
  private argsInit = new Uint32Array(0);
  views: CullView[] = [];
  /** The template radii the cull bind groups read; rebound when the library repacks. */
  private boundRadii: GPUBuffer | null = null;
  private cullData = new Float32Array(32);
  private cullU32 = new Uint32Array(this.cullData.buffer);

  /**
   * `fade`: instances farther than this from the camera aren't drawn (0 = always drawn).
   * `cullViews`: how many views cull this batch on the GPU (0 draws every instance).
   */
  constructor(readonly instances: InstanceBatch, readonly fade = 0, readonly cullViews = 0) {}

  upload(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    templates: number,
    cull: { layout: GPUBindGroupLayout; radii: GPUBuffer } | null,
  ) {
    const b = this.instances;
    b.sort(templates);
    this.templates = templates;
    if (!b.count) return;
    const bytes = b.count * INSTANCE_FLOATS * 4;
    if (!this.params) {
      this.params = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(
        this.params,
        0,
        new Float32Array([this.fade, this.fade * 0.2, 0, 0]),
      );
    }
    const views = cull ? this.cullViews : 0;
    const argsTooSmall = views > 0 && (this.views[0]?.args.size ?? 0) < templates * 2 * ARGS_BYTES;
    if (!this.buffer || this.buffer.size < bytes || this.views.length !== views || argsTooSmall) {
      this.buffer?.destroy();
      this.ids?.destroy();
      for (const v of this.views) v.instances.destroy(), v.args.destroy(), v.uniform.destroy();
      const size = Math.max(bytes * 2, 4096);
      const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      this.buffer = device.createBuffer({ size, usage: storage });
      this.ids = device.createBuffer({ size: size / (INSTANCE_FLOATS * 4) * 4, usage: storage });
      this.bindGroup = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: this.buffer } },
          { binding: 1, resource: { buffer: this.params } },
        ],
      });
      this.views = [];
      for (let v = 0; v < views; v++) {
        // The low records' survivors pack into a second region starting at instance `count`.
        const instances = device.createBuffer({ size: size * 2, usage: GPUBufferUsage.STORAGE });
        const args = device.createBuffer({
          size: Math.max(ARGS_BYTES, templates * 2 * ARGS_BYTES),
          usage: GPUBufferUsage.INDIRECT | storage,
        });
        const uniform = device.createBuffer({
          size: this.cullData.byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.views.push({
          instances,
          args,
          uniform,
          cullGroup: null,
          drawGroup: device.createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: { buffer: instances } },
              { binding: 1, resource: { buffer: this.params } },
            ],
          }),
        });
      }
    }
    device.queue.writeBuffer(this.buffer, 0, b.sorted, 0, b.count * INSTANCE_FLOATS);
    if (views) device.queue.writeBuffer(this.ids!, 0, b.sortedIds, 0, b.count);
    this.boundRadii = null;
  }

  /**
   * Reset view `v`'s draw arguments and cull the batch against `planes` (and the fade). The
   * library may have repacked since the upload, so arguments come from today's `ranges`.
   */
  cull(
    device: GPUDevice,
    pass: GPUComputePassEncoder,
    v: number,
    planes: Float32Array,
    eye: Vec3,
    ranges: MeshRange[],
    cull: { layout: GPUBindGroupLayout; radii: GPUBuffer },
    lod: number,
  ) {
    const view = this.views[v];
    if (!view || !this.instances.count) return;
    if (this.boundRadii !== cull.radii) {
      this.boundRadii = cull.radii;
      for (const w of this.views) {
        w.cullGroup = device.createBindGroup({
          layout: cull.layout,
          entries: [
            { binding: 0, resource: { buffer: w.uniform } },
            { binding: 1, resource: { buffer: this.buffer! } },
            { binding: 2, resource: { buffer: this.ids! } },
            { binding: 3, resource: { buffer: cull.radii } },
            { binding: 4, resource: { buffer: w.instances } },
            { binding: 5, resource: { buffer: w.args } },
          ],
        });
      }
    }
    if (v === 0) this.fillArgs(ranges);
    const d = this.cullData;
    d.set(planes, 0);
    d.set(eye, 24);
    d[27] = this.fade;
    this.cullU32[28] = this.instances.count;
    this.cullU32[29] = this.templates;
    d[30] = lod;
    device.queue.writeBuffer(view.uniform, 0, d);
    device.queue.writeBuffer(view.args, 0, this.argsInit);
    pass.setBindGroup(0, view.cullGroup!);
    pass.dispatchWorkgroups(Math.ceil(this.instances.count / 64));
  }

  private fillArgs(ranges: MeshRange[]) {
    const n = this.templates, b = this.instances;
    if (this.argsInit.length !== n * 10) this.argsInit = new Uint32Array(n * 10);
    const args = this.argsInit;
    for (let t = 0; t < n; t++) {
      const r = ranges[t];
      args[t * 5] = r ? r.indexCount : 0;
      args[t * 5 + 1] = 0;
      args[t * 5 + 2] = r ? r.firstIndex : 0;
      args[t * 5 + 3] = r ? r.baseVertex : 0;
      args[t * 5 + 4] = b.first[t];
      // The low mesh's record: survivors pack after all `count` of the full records' region.
      const l = r?.low;
      args[(n + t) * 5] = l ? l.indexCount : 0;
      args[(n + t) * 5 + 1] = 0;
      args[(n + t) * 5 + 2] = l ? l.firstIndex : 0;
      args[(n + t) * 5 + 3] = l ? l.baseVertex : 0;
      args[(n + t) * 5 + 4] = b.count + b.first[t];
    }
  }

  destroy() {
    this.buffer?.destroy();
    this.params?.destroy();
    this.ids?.destroy();
    for (const v of this.views) v.instances.destroy(), v.args.destroy(), v.uniform.destroy();
  }
}

export class ModelRenderer {
  readonly layout: GPUBindGroupLayout;
  private pipeline: GPURenderPipeline;
  private shadowPipeline: GPURenderPipeline;
  private vertices: GPUBuffer | null = null;
  private indices: GPUBuffer | null = null;
  private ranges: MeshRange[] = [];
  private libraryVersion = -1;
  /** GPU culling needs indirect draws that start at an instance offset. */
  private culling: { pipeline: GPUComputePipeline; layout: GPUBindGroupLayout } | null = null;
  private radii: GPUBuffer | null = null;
  /** The bind-group inputs every batch's cull shares; rebuilt when the radii buffer moves. */
  private cullBind: { layout: GPUBindGroupLayout; radii: GPUBuffer } | null = null;

  constructor(private device: GPUDevice, layouts: Layouts, readonly library: MeshLibrary) {
    if (device.features.has("indirect-first-instance")) {
      const C = GPUShaderStage.COMPUTE;
      const storage = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
        binding,
        visibility: C,
        buffer: { type },
      });
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: C, buffer: {} },
          storage(1, "read-only-storage"),
          storage(2, "read-only-storage"),
          storage(3, "read-only-storage"),
          storage(4, "storage"),
          storage(5, "storage"),
        ],
      });
      this.culling = {
        layout,
        pipeline: device.createComputePipeline({
          label: "models-cull",
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          compute: {
            module: device.createShaderModule({ code: cullShader, label: "models-cull" }),
            entryPoint: "main",
          },
        }),
      };
    }
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: {} },
      ],
    });
    const module = device.createShaderModule({ code: shader, label: "models" });
    this.pipeline = device.createRenderPipeline({
      label: "models",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, this.layout] }),
      vertex: { module, entryPoint: "vs", buffers: [vertexLayout] },
      fragment: { module, entryPoint: "fs", targets: [{ format: layouts.colorFormat }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: { format: layouts.depthFormat, depthWriteEnabled: true, depthCompare: "less" },
      multisample: { count: layouts.samples },
    });
    this.shadowPipeline = device.createRenderPipeline({
      label: "models-shadow",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.shadowFrame, this.layout] }),
      vertex: { module, entryPoint: "vsShadow", buffers: [vertexLayout] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: "less",
        depthBias: 2,
        depthBiasSlopeScale: 2.5,
      },
    });
  }

  /** Re-upload the template buffers if templates were added or changed. */
  private syncLibrary() {
    if (this.libraryVersion === this.library.version) return;
    this.libraryVersion = this.library.version;
    const { vertices, indices, ranges } = this.library.pack();
    this.vertices?.destroy();
    this.indices?.destroy();
    this.vertices = this.device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.indices = this.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertices, 0, vertices);
    this.device.queue.writeBuffer(this.indices, 0, indices);
    this.ranges = ranges;
    if (this.culling) {
      const radii = new Float32Array(Math.max(1, ranges.length));
      ranges.forEach((r, i) => (radii[i] = r.radius));
      this.radii?.destroy();
      this.radii = this.device.createBuffer({
        size: radii.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this.radii, 0, radii);
      this.cullBind = { layout: this.culling.layout, radii: this.radii };
    }
  }

  destroy() {
    this.vertices?.destroy();
    this.indices?.destroy();
    this.radii?.destroy();
  }

  upload(batch: ModelBatch) {
    this.syncLibrary();
    batch.upload(this.device, this.layout, this.library.size, this.cullBind);
  }

  /**
   * Cull `batch` for its view `view` against `planes`; draw it with the same view index. `lod` is
   * the distance from `eye` at and beyond which an instance is drawn with its low mesh; 0 draws
   * every instance low.
   */
  cull(
    pass: GPUComputePassEncoder,
    batch: ModelBatch,
    view: number,
    planes: Float32Array,
    eye: Vec3,
    lod: number,
  ) {
    if (!this.culling || !this.cullBind) return;
    pass.setPipeline(this.culling.pipeline);
    batch.cull(this.device, pass, view, planes, eye, this.ranges, this.cullBind, lod);
  }

  draw(pass: GPURenderPassEncoder, batch: ModelBatch, view = 0) {
    this.drawWith(pass, this.pipeline, batch, view, false);
  }

  drawShadow(pass: GPURenderPassEncoder, batch: ModelBatch, view = 0) {
    this.drawWith(pass, this.shadowPipeline, batch, view, true);
  }

  private drawWith(
    pass: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    batch: ModelBatch,
    view: number,
    low: boolean,
  ) {
    const b = batch.instances;
    if (!b.count || !batch.bindGroup || !this.vertices || !this.indices) return;
    const culled = batch.views[view];
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, culled ? culled.drawGroup : batch.bindGroup);
    pass.setVertexBuffer(0, this.vertices);
    pass.setIndexBuffer(this.indices, "uint32");
    for (let t = 0; t < this.ranges.length; t++) {
      const n = b.counts[t];
      if (!n) continue;
      if (culled) {
        pass.drawIndexedIndirect(culled.args, t * ARGS_BYTES);
        pass.drawIndexedIndirect(culled.args, (batch.templates + t) * ARGS_BYTES);
        continue;
      }
      const r = low ? this.ranges[t].low : this.ranges[t];
      pass.drawIndexed(r.indexCount, n, r.firstIndex, r.baseVertex, b.first[t]);
    }
  }
}
