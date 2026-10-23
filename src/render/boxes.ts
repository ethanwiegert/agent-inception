import { frameWgsl, lightingWgsl } from "./frame.ts";
import type { Layouts } from "./renderer.ts";

/** Floats per instance: model matrix (16) + color (4). */
export const BOX_FLOATS = 20;

/**
 * Instanced unit cubes with arbitrary transforms: the building block for
 * bodies, animals and anything built from parts. Cube geometry comes from the
 * vertex index, so the only buffer is the instance data.
 */
const shader = frameWgsl + lightingWgsl + /* wgsl */ `
struct Box { model: mat4x4f, color: vec4f };
@group(1) @binding(0) var<storage, read> boxes: array<Box>;

// 6 faces × 2 triangles; corners of the unit cube centered at the origin.
fn corner(vi: u32) -> vec3f {
  let face = vi / 6u;
  let quad = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let q = quad[vi % 6u] * 0.5;
  let n = faceNormal(face);
  // Two in-plane axes with cross(u, v) = n so triangles wind counter-clockwise from outside.
  let u = select(vec3f(n.y, n.z, n.x), vec3f(n.z, n.x, n.y), n.x + n.y + n.z > 0.0);
  let v = cross(n, u);
  return n * 0.5 + u * q.x + v * q.y;
}

fn faceNormal(face: u32) -> vec3f {
  let normals = array<vec3f, 6>(
    vec3f(1.0, 0.0, 0.0), vec3f(-1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0),
    vec3f(0.0, -1.0, 0.0), vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, -1.0));
  return normals[face];
}

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) local: vec3f,
  @location(3) @interpolate(flat) color: vec4f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  let box = boxes[ii];
  let local = corner(vi);
  let world = (box.model * vec4f(local, 1.0)).xyz;
  let n = normalize((box.model * vec4f(faceNormal(vi / 6u), 0.0)).xyz);
  return Out(frame.viewProj * vec4f(world, 1.0), world, n, local, box.color);
}

@vertex fn vsShadow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  return frame.lightViewProj * (boxes[ii].model * vec4f(corner(vi), 1.0));
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  // Soft contact darkening toward the bottom of each part, and crisp edges.
  let ao = mix(1.0, mix(0.75, 1.0, smoothstep(-0.5, 0.2, in.local.y)), in.color.a);
  let a = abs(in.local);
  let m = max(max(a.x, a.y), a.z);
  let second = a.x + a.y + a.z - m - min(min(a.x, a.y), a.z);
  let edge = 1.0 - frame.grassBase.w * 0.6 * smoothstep(0.42, 0.5, second);
  let c = shade(in.color.rgb * edge, in.normal, in.world, mix(1.0, ao, frame.groundAmbient.w), 0.2);
  return vec4f(fog(c, in.world), 1.0);
}
`;

export class BoxRenderer {
  private pipeline: GPURenderPipeline;
  private shadowPipeline: GPURenderPipeline;
  private layout: GPUBindGroupLayout;
  private buffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private count = 0;

  constructor(private device: GPUDevice, layouts: Layouts) {
    this.layout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      }],
    });
    const module = device.createShaderModule({ code: shader, label: "boxes" });
    this.pipeline = device.createRenderPipeline({
      label: "boxes",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, this.layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: layouts.colorFormat }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: { format: layouts.depthFormat, depthWriteEnabled: true, depthCompare: "less" },
      multisample: { count: layouts.samples },
    });
    this.shadowPipeline = device.createRenderPipeline({
      label: "boxes-shadow",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.shadowFrame, this.layout] }),
      vertex: { module, entryPoint: "vsShadow" },
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

  /** Upload `count` instances packed as BOX_FLOATS each. */
  update(data: Float32Array, count: number) {
    this.count = count;
    if (!count) return;
    const bytes = count * BOX_FLOATS * 4;
    if (!this.buffer || this.buffer.size < bytes) {
      this.buffer?.destroy();
      this.buffer = this.device.createBuffer({
        size: Math.max(bytes * 2, 4096),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.bindGroup = this.device.createBindGroup({
        layout: this.layout,
        entries: [{ binding: 0, resource: { buffer: this.buffer } }],
      });
    }
    this.device.queue.writeBuffer(this.buffer, 0, data, 0, count * BOX_FLOATS);
  }

  draw(pass: GPURenderPassEncoder) {
    this.drawWith(pass, this.pipeline);
  }

  drawShadow(pass: GPURenderPassEncoder) {
    this.drawWith(pass, this.shadowPipeline);
  }

  private drawWith(pass: GPURenderPassEncoder, pipeline: GPURenderPipeline) {
    if (!this.count || !this.bindGroup) return;
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.bindGroup);
    pass.draw(36, this.count);
  }
}
