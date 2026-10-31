import { frameWgsl, lightingWgsl } from "./frame.ts";
import { grassWeightWgsl, slopeDropWgsl, type SurfaceTexture } from "./surface.ts";
import type { Layouts } from "./renderer.ts";

/** Blades the compact buffer can hold (32 bytes each). */
const MAX_BLADES = 900_000;
const WORKGROUP = 64;

/**
 * GPU-generated grass in two steps:
 *  1. A compute pass walks a grid of candidate blades around the camera (hash-placed,
 *     `bladesPerBlock` per column), culls them against the surface texture, the organic
 *     grass edge, distance and the frustum, and writes survivors to a compact buffer with
 *     their color, wind bend and shadowing already worked out.
 *  2. An indirect draw renders exactly the survivors; the vertex shader just builds the
 *     7-vertex strip, so per-blade work happens once instead of once per vertex.
 */
const common = frameWgsl + lightingWgsl + slopeDropWgsl + grassWeightWgsl + /* wgsl */ `
const GRASS = 1u;
const SEGMENTS = 3u;
const MAX_BLADES = ${MAX_BLADES}u;

struct Blade {
  pos: vec3f,
  heightWidth: u32,   // pack2x16float(height, width)
  facingLight: u32,   // pack2x16unorm(facing / 2π, key light)
  bend: u32,          // pack2x16float(bend x, bend z) at the tip
  base: u32,          // pack4x8unorm(root color * 4)
  tip: u32,           // pack4x8unorm(tip color * 4); alpha = flower kind (0 = none)
};
`;

const cullShader = common + /* wgsl */ `
struct DrawArgs { vertexCount: u32, instanceCount: atomic<u32>, firstVertex: u32, firstInstance: u32 };

@group(1) @binding(0) var surface: texture_2d<u32>;
@group(1) @binding(1) var<storage, read_write> blades: array<Blade>;
@group(1) @binding(2) var<storage, read_write> args: DrawArgs;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rand(seed: ptr<function, u32>) -> f32 {
  *seed = pcg(*seed);
  return f32(*seed) / 4294967296.0;
}

@compute @workgroup_size(${WORKGROUP}) fn cull(@builtin(global_invocation_id) gid: vec3u) {
  let bladesPerBlock = u32(frame.grass.z);
  let radius = i32(frame.grass.w);
  let side = u32(radius * 2);
  let ii = gid.x;
  if (ii >= side * side * bladesPerBlock) { return; }
  let cell = ii / bladesPerBlock;
  let k = ii % bladesPerBlock;
  let cx = i32(cell % side) - radius + i32(frame.grassCenter.x);
  let cz = i32(cell / side) - radius + i32(frame.grassCenter.y);
  if (cx < 0 || cz < 0 || f32(cx) >= frame.grassCenter.z || f32(cz) >= frame.grassCenter.w) { return; }

  let s = textureLoad(surface, vec2i(cx, cz), 0);
  // Grass grows on grass, and fringes onto neighbouring natural ground; never under water.
  let natural = s.g == GRASS || s.g == 2u || s.g == 6u || s.g == 7u || s.g == 8u;
  if (!natural || s.a > s.r + 1u || (s.g != GRASS && (s.b >> 4u) == 0u)) { return; }

  var seed = pcg((u32(cx) * 73856093u) ^ (u32(cz) * 19349663u) ^ (k * 83492791u));
  let fx = rand(&seed);
  let fz = rand(&seed);
  let base = vec3f(f32(cx) + fx, f32(s.r) + 1.0 - slopeDrop(s.b & 15u, fx, fz), f32(cz) + fz);

  // Thin out with distance from the view center and fade to nothing at the edge.
  let d = distance(base.xz, frame.grassCenter.xy);
  let r = f32(radius);
  let keep = mix(1.0, 0.3, smoothstep(r * 0.35, r, d));
  if (f32(k) >= f32(bladesPerBlock) * keep) { return; }
  let clip = frame.viewProj * vec4f(base, 1.0);
  if (clip.w <= 0.0 || any(abs(clip.xy) > vec2f(clip.w * 1.1 + 1.5))) { return; }
  if (!isGrassy(s, base.xz)) { return; }
  let fade = 1.0 - smoothstep(r * 0.75, r, d);

  let heightRand = rand(&seed);
  let angle = rand(&seed);
  let lean = rand(&seed);
  let tone = rand(&seed);
  let flower = rand(&seed) < frame.grassTip.w;
  let flowerKind = rand(&seed);

  let h = frame.grass.x * (0.55 + 0.9 * heightRand * heightRand) * fade * select(1.0, 1.25, flower);
  let w = frame.grass.y / sqrt(keep);
  let facing = vec2f(cos(angle * 6.2831853), sin(angle * 6.2831853));
  let time = frame.cameraPos.w;
  let gust = valueNoise(base.xz * 0.06 - frame.wind.xy * time * 0.8);
  let sway = sin(time * 2.1 + dot(base.xz, frame.wind.xy) * 0.6 + lean * 6.0) * 0.25;
  let bend = facing * (0.1 + 0.35 * lean) * h + frame.wind.xy * frame.wind.z * (gust * 0.9 + sway * 0.4) * h;

  let root = meadowColor(frame.grassBase.rgb, base.xz);
  let tip = meadowColor(frame.grassTip.rgb, base.xz) * (0.8 + 0.4 * tone);
  let light = keyLightFast(base + vec3f(0.0, h * 0.5, 0.0));

  let idx = atomicAdd(&args.instanceCount, 1u);
  if (idx >= MAX_BLADES) { return; }
  blades[idx] = Blade(
    base,
    pack2x16float(vec2f(h, w)),
    pack2x16unorm(vec2f(angle, light)),
    pack2x16float(bend),
    pack4x8unorm(vec4f(root * 4.0, 0.0)),
    pack4x8unorm(vec4f(tip * 4.0, select(0.0, 0.25 + flowerKind * 0.75, flower))));
}
`;

const drawShader = common + /* wgsl */ `
@group(1) @binding(0) var<storage, read> blades: array<Blade>;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) t: f32,
  @location(4) light: f32,
  @location(5) lamp: vec3f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var out: Out;
  if (ii >= MAX_BLADES) {
    out.pos = vec4f(0.0, 0.0, -1.0, 1.0);
    return out;
  }
  let b = blades[ii];
  let hw = unpack2x16float(b.heightWidth);
  let fl = unpack2x16unorm(b.facingLight);
  let bend2 = unpack2x16float(b.bend);
  let angle = fl.x * 6.2831853;
  let facing = vec3f(cos(angle), 0.0, sin(angle));
  let right = vec3f(-facing.z, 0.0, facing.x);
  let bend = vec3f(bend2.x, 0.0, bend2.y);

  let level = min(vi / 2u, SEGMENTS);
  let t = f32(level) / f32(SEGMENTS);
  let sideSign = select(-0.5, 0.5, (vi & 1u) == 1u);
  let curve = t * t;
  var p = b.pos + right * sideSign * hw.y * (1.0 - t) + vec3f(0.0, hw.x * t, 0.0) + bend * curve;
  p.y -= length(bend) * curve * 0.3;

  let root = unpack4x8unorm(b.base).rgb * 0.25;
  let tipc = unpack4x8unorm(b.tip);
  var color = mix(root, tipc.rgb * 0.25, smoothstep(0.0, 1.0, t));
  if (tipc.a > 0.0 && level >= 2u) {
    let petals = array<vec3f, 3>(vec3f(0.9, 0.85, 0.7), vec3f(0.95, 0.65, 0.08), vec3f(0.45, 0.25, 0.75));
    color = petals[min(u32((tipc.a - 0.25) / 0.75 * 3.0), 2u)];
  }
  out.pos = frame.viewProj * vec4f(p, 1.0);
  out.world = p;
  out.normal = normalize(vec3f(0.0, 0.75, 0.0) + facing * 0.45);
  out.t = t;
  out.light = fl.y;
  out.lamp = lampLight(p, vec3f(0.0, 1.0, 0.0));
  // Dense grass shades its own roots.
  out.color = color * mix(1.0, mix(0.35, 1.0, t), frame.groundAmbient.w);
  return out;
}

@fragment fn fs(in: Out, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let n = select(in.normal * vec3f(-1.0, 1.0, -1.0), in.normal, front);
  var c = shadeWith(in.color, n, in.light, 1.0, 0.5) + in.color * in.lamp;
  // Light through the blade tips when looking toward the sun.
  let view = normalize(frame.cameraPos.xyz - in.world);
  let back = pow(max(dot(-view, frame.sunDir.xyz), 0.0), 3.0);
  c += in.color * frame.sunColor.rgb * frame.sunDir.w * back * in.t * 0.6 * in.light;
  return vec4f(fog(c, in.world), 1.0);
}
`;

export class GrassRenderer {
  private cullPipeline: GPUComputePipeline;
  private drawPipeline: GPURenderPipeline;
  private cullBindGroup: GPUBindGroup;
  private drawBindGroup: GPUBindGroup;
  private args: GPUBuffer;
  private static readonly ZERO = new Uint32Array([0]);

  constructor(private device: GPUDevice, surface: SurfaceTexture, layouts: Layouts) {
    const blades = device.createBuffer({ size: MAX_BLADES * 32, usage: GPUBufferUsage.STORAGE });
    this.args = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.args, 0, new Uint32Array([7, 0, 0, 0]));

    const C = GPUShaderStage.COMPUTE;
    const cullLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: C, texture: { sampleType: "uint" } },
        { binding: 1, visibility: C, buffer: { type: "storage" } },
        { binding: 2, visibility: C, buffer: { type: "storage" } },
      ],
    });
    this.cullBindGroup = device.createBindGroup({
      layout: cullLayout,
      entries: [
        { binding: 0, resource: surface.view },
        { binding: 1, resource: { buffer: blades } },
        { binding: 2, resource: { buffer: this.args } },
      ],
    });
    this.cullPipeline = device.createComputePipeline({
      label: "grass-cull",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, cullLayout] }),
      compute: {
        module: device.createShaderModule({ code: cullShader, label: "grass-cull" }),
        entryPoint: "cull",
      },
    });

    const drawLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      }],
    });
    this.drawBindGroup = device.createBindGroup({
      layout: drawLayout,
      entries: [{ binding: 0, resource: { buffer: blades } }],
    });
    const module = device.createShaderModule({ code: drawShader, label: "grass" });
    this.drawPipeline = device.createRenderPipeline({
      label: "grass",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, drawLayout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: layouts.colorFormat }] },
      primitive: { topology: "triangle-strip", cullMode: "none" },
      depthStencil: { format: layouts.depthFormat, depthWriteEnabled: true, depthCompare: "less" },
      multisample: { count: layouts.samples },
    });
  }

  /** Candidate blades for the current grass radius and density. */
  static instanceCount(radius: number, bladesPerBlock: number) {
    return (radius * 2) ** 2 * bladesPerBlock;
  }

  /**
   * Cull candidates into the compact buffer. Needs this frame's shadow map, so encode it
   * after the shadow pass and before the pass that draws the grass.
   */
  cull(encoder: GPUCommandEncoder, frameBindGroup: GPUBindGroup, candidates: number) {
    this.device.queue.writeBuffer(this.args, 4, GrassRenderer.ZERO);
    const pass = encoder.beginComputePass({ label: "grass-cull" });
    pass.setPipeline(this.cullPipeline);
    pass.setBindGroup(0, frameBindGroup);
    pass.setBindGroup(1, this.cullBindGroup);
    pass.dispatchWorkgroups(Math.ceil(candidates / WORKGROUP));
    pass.end();
  }

  draw(pass: GPURenderPassEncoder) {
    pass.setPipeline(this.drawPipeline);
    pass.setBindGroup(1, this.drawBindGroup);
    pass.drawIndirect(this.args, 0);
  }
}
