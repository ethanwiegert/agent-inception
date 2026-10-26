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
 */
const shader = frameWgsl + lightingWgsl + /* wgsl */ `
struct Instance { model: mat4x4f, tint: vec4f };
@group(1) @binding(0) var<storage, read> instances: array<Instance>;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec4f,
  @location(2) color: vec4f,
};

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
};

/** Wind sway: a slow lean with the gusts plus a quick flutter, scaled by how loose a vertex is. */
fn windOffset(world: vec3f, origin: vec3f, sway: f32) -> vec3f {
  if (sway <= 0.0) { return vec3f(0.0); }
  let t = frame.cameraPos.w;
  let w = frame.wind;
  let gust = valueNoise(origin.xz * 0.06 - w.xy * t * 0.8);
  let lean = gust * 0.8 + sin(t * 1.3 + dot(origin.xz, vec2f(0.37, 0.23))) * 0.25;
  let flutter = sin(t * 6.0 + dot(world, vec3f(3.1, 1.7, 2.3))) * 0.05;
  return (vec3f(w.x, 0.0, w.y) * lean * 0.22 + vec3f(flutter, flutter * 0.5, -flutter)) * w.z * sway;
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
  let albedo = pow(v.color.rgb, vec3f(2.2)) * inst.tint.rgb;
  return Out(frame.viewProj * vec4f(world, 1.0), world, n, albedo);
}

@vertex fn vsShadow(v: VIn, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  return frame.lightViewProj * vec4f(place(v, ii), 1.0);
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  let c = shade(in.color, normalize(in.normal), in.world, 1.0, 0.25);
  return vec4f(fog(c, in.world), 1.0);
}
`;

const vertexLayout: GPUVertexBufferLayout = {
  arrayStride: VERTEX_BYTES,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "snorm8x4" },
    { shaderLocation: 2, offset: 16, format: "unorm8x4" },
  ],
};

/** GPU copy of an `InstanceBatch`. */
export class ModelBatch {
  private buffer: GPUBuffer | null = null;
  bindGroup: GPUBindGroup | null = null;

  constructor(readonly instances: InstanceBatch) {}

  upload(device: GPUDevice, layout: GPUBindGroupLayout, templates: number) {
    const b = this.instances;
    b.sort(templates);
    if (!b.count) return;
    const bytes = b.count * INSTANCE_FLOATS * 4;
    if (!this.buffer || this.buffer.size < bytes) {
      this.buffer?.destroy();
      this.buffer = device.createBuffer({
        size: Math.max(bytes * 2, 4096),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.bindGroup = device.createBindGroup({
        layout,
        entries: [{ binding: 0, resource: { buffer: this.buffer } }],
      });
    }
    device.queue.writeBuffer(this.buffer, 0, b.sorted, 0, b.count * INSTANCE_FLOATS);
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

  constructor(private device: GPUDevice, layouts: Layouts, readonly library: MeshLibrary) {
    this.layout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      }],
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
  }

  upload(batch: ModelBatch) {
    this.syncLibrary();
    batch.upload(this.device, this.layout, this.library.size);
  }

  draw(pass: GPURenderPassEncoder, batch: ModelBatch) {
    this.drawWith(pass, this.pipeline, batch);
  }

  drawShadow(pass: GPURenderPassEncoder, batch: ModelBatch) {
    this.drawWith(pass, this.shadowPipeline, batch);
  }

  private drawWith(pass: GPURenderPassEncoder, pipeline: GPURenderPipeline, batch: ModelBatch) {
    const b = batch.instances;
    if (!b.count || !batch.bindGroup || !this.vertices || !this.indices) return;
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, batch.bindGroup);
    pass.setVertexBuffer(0, this.vertices);
    pass.setIndexBuffer(this.indices, "uint32");
    for (let t = 0; t < this.ranges.length; t++) {
      const n = b.counts[t];
      if (!n) continue;
      const r = this.ranges[t];
      pass.drawIndexed(r.indexCount, n, r.firstIndex, r.baseVertex, b.first[t]);
    }
  }
}
