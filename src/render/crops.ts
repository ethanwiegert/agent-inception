import { CROP_STRIDE } from "../sim/protocol.ts";
import { frameWgsl, lightingWgsl } from "./frame.ts";
import type { Layouts } from "./renderer.ts";

const STALKS = 10;

/**
 * Crops drawn like grass: blades generated in the vertex shader, ten per tile in two rows. Each
 * crop brings its colors from the Catalog: young stalks in its stalk Material, ripe ears in the
 * color of what it drops.
 */
const shader = frameWgsl + lightingWgsl + /* wgsl */ `
@group(1) @binding(0) var<storage, read> crops: array<vec4f>;
const STALKS = ${STALKS}u;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rand(seed: ptr<function, u32>) -> f32 {
  *seed = pcg(*seed);
  return f32(*seed) / 4294967296.0;
}
/** sRGB 0xRRGGBB carried in a float, to linear. */
fn unpackColor(packed: f32) -> vec3f {
  let c = u32(packed);
  let srgb = vec3f(f32((c >> 16u) & 255u), f32((c >> 8u) & 255u), f32(c & 255u)) / 255.0;
  return pow(srgb, vec3f(2.2));
}

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) color: vec3f,
  @location(2) t: f32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  let crop = crops[(ii / STALKS) * 2u];
  let look = crops[(ii / STALKS) * 2u + 1u];
  let k = ii % STALKS;
  let g = crop.w;
  var seed = pcg((u32(crop.x) * 73856093u) ^ (u32(crop.z) * 19349663u) ^ (k * 83492791u));
  let col = f32(k % 5u);
  let row = f32(k / 5u);
  let base = vec3f(
    crop.x + 0.14 + col * 0.18 + (rand(&seed) - 0.5) * 0.06,
    crop.y,
    crop.z + 0.3 + row * 0.4 + (rand(&seed) - 0.5) * 0.08);

  let ripe = smoothstep(0.85, 1.0, g);
  let h = (0.1 + 0.85 * g) * (0.85 + 0.3 * rand(&seed));
  let level = min(vi / 2u, 3u);
  let t = f32(level) / 3.0;
  let sideSign = select(-0.5, 0.5, (vi & 1u) == 1u);
  let angle = rand(&seed) * 6.2831853;
  let facing = vec3f(cos(angle), 0.0, sin(angle));
  let right = vec3f(-facing.z, 0.0, facing.x);

  // Ripe stalks carry a fat ear on the top segment.
  var w = 0.045 * (1.0 - t * 0.6);
  if (level >= 2u) { w = mix(w, 0.11, ripe * select(0.6, 1.0, level == 2u)); }
  let time = frame.cameraPos.w;
  let sway = sin(time * 1.7 + base.x * 0.7 + base.z * 0.5) * 0.08 * frame.wind.z;
  let bend = (vec3f(frame.wind.x, 0.0, frame.wind.y) * sway + facing * 0.05) * h;
  let p = base + right * sideSign * w + vec3f(0.0, h * t, 0.0) + bend * t * t;

  let young = unpackColor(look.x) * vec3f(0.6, 0.93, 0.6);
  let ear = unpackColor(look.y);
  let mature = ear * 0.63;
  var color = mix(young, mature, smoothstep(0.55, 1.0, g)) * mix(0.55, 1.0, t);
  if (level >= 2u) { color = mix(color, ear, ripe); }

  var out: Out;
  out.pos = frame.viewProj * vec4f(p, 1.0);
  out.world = p;
  out.color = color;
  out.t = t;
  return out;
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  let c = shade(in.color, vec3f(0.0, 1.0, 0.0), in.world, 1.0, 0.5);
  return vec4f(fog(c, in.world), 1.0);
}
`;

export class CropRenderer {
  private pipeline: GPURenderPipeline;
  private layout: GPUBindGroupLayout;
  private buffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private count = 0;
  private version = -1;

  constructor(private device: GPUDevice, layouts: Layouts) {
    this.layout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      }],
    });
    const module = device.createShaderModule({ code: shader, label: "crops" });
    this.pipeline = device.createRenderPipeline({
      label: "crops",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, this.layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: layouts.colorFormat }] },
      primitive: { topology: "triangle-strip", cullMode: "none" },
      depthStencil: { format: layouts.depthFormat, depthWriteEnabled: true, depthCompare: "less" },
      multisample: { count: layouts.samples },
    });
  }

  update(crops: Float32Array, version: number) {
    if (version === this.version) return;
    this.version = version;
    this.count = crops.length / CROP_STRIDE;
    if (!this.count) return;
    if (!this.buffer || this.buffer.size < crops.byteLength) {
      this.buffer?.destroy();
      this.buffer = this.device.createBuffer({
        size: Math.max(crops.byteLength * 2, 1024),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.bindGroup = this.device.createBindGroup({
        layout: this.layout,
        entries: [{ binding: 0, resource: { buffer: this.buffer } }],
      });
    }
    this.device.queue.writeBuffer(this.buffer, 0, crops);
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.count || !this.bindGroup) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(1, this.bindGroup);
    pass.draw(7, this.count * STALKS);
  }
}
