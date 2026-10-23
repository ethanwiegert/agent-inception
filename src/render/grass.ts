import { World } from "../sim/world.ts";
import { frameWgsl, lightingWgsl } from "./frame.ts";
import type { Layouts } from "./renderer.ts";

/**
 * GPU-generated grass. No per-blade buffers: instance ids map to a grid of
 * cells around the camera, each cell gets `bladesPerBlock` blades placed by
 * hash, and a surface texture (top height, top block) says where grass grows.
 * Editing the world only touches one texel.
 */
const shader = frameWgsl + lightingWgsl + /* wgsl */ `
@group(1) @binding(0) var surface: texture_2d<u32>;

const GRASS = 1u;
const SEGMENTS = 3u;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rand(seed: ptr<function, u32>) -> f32 {
  *seed = pcg(*seed);
  return f32(*seed) / 4294967296.0;
}

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) t: f32,
};

fn culled() -> Out {
  var out: Out;
  out.pos = vec4f(0.0, 0.0, -1.0, 1.0);
  return out;
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  let bladesPerBlock = u32(frame.grass.z);
  let radius = i32(frame.grass.w);
  let side = u32(radius * 2);
  let cell = ii / bladesPerBlock;
  let k = ii % bladesPerBlock;
  let cx = i32(cell % side) - radius + i32(frame.grassCenter.x);
  let cz = i32(cell / side) - radius + i32(frame.grassCenter.y);
  if (cx < 0 || cz < 0 || f32(cx) >= frame.grassCenter.z || f32(cz) >= frame.grassCenter.w) {
    return culled();
  }
  let s = textureLoad(surface, vec2i(cx, cz), 0);
  if (s.g != GRASS) { return culled(); }

  var seed = pcg((u32(cx) * 73856093u) ^ (u32(cz) * 19349663u) ^ (k * 83492791u));
  let base = vec3f(f32(cx) + rand(&seed), f32(s.r) + 1.0, f32(cz) + rand(&seed));

  // Thin out with distance from the view center and fade to nothing at the edge.
  let d = distance(base.xz, frame.grassCenter.xy);
  let r = f32(radius);
  let keep = mix(1.0, 0.3, smoothstep(r * 0.35, r, d));
  if (f32(k) >= f32(bladesPerBlock) * keep) { return culled(); }
  let fade = 1.0 - smoothstep(r * 0.75, r, d);

  let clip = frame.viewProj * vec4f(base, 1.0);
  if (any(abs(clip.xy) > vec2f(clip.w * 1.1 + 1.5))) { return culled(); }

  let heightRand = rand(&seed);
  let angle = rand(&seed) * 6.2831853;
  let lean = rand(&seed);
  let tone = rand(&seed);
  let flower = rand(&seed) < frame.grassTip.w;
  let flowerKind = rand(&seed);

  let h = frame.grass.x * (0.55 + 0.9 * heightRand * heightRand) * fade * select(1.0, 1.25, flower);
  let w = frame.grass.y / sqrt(keep);
  let level = min(vi / 2u, SEGMENTS);
  let t = f32(level) / f32(SEGMENTS);
  let sideSign = select(-0.5, 0.5, (vi & 1u) == 1u);

  let facing = vec3f(cos(angle), 0.0, sin(angle));
  let right = vec3f(-facing.z, 0.0, facing.x);
  let time = frame.cameraPos.w;
  let windDir = vec3f(frame.wind.x, 0.0, frame.wind.y);
  let gust = valueNoise(base.xz * 0.06 - frame.wind.xy * time * 0.8);
  let sway = sin(time * 2.1 + dot(base.xz, frame.wind.xy) * 0.6 + lean * 6.0) * 0.25;
  let wind = windDir * frame.wind.z * (gust * 0.9 + sway * 0.4) * h;
  let bend = facing * (0.1 + 0.35 * lean) * h + wind;
  let curve = t * t;
  var p = base + right * sideSign * w * (1.0 - t) + vec3f(0.0, h * t, 0.0) + bend * curve;
  p.y -= length(bend) * curve * 0.3;

  var out: Out;
  out.pos = frame.viewProj * vec4f(p, 1.0);
  out.world = p;
  out.normal = normalize(vec3f(0.0, 1.0, 0.0) * 0.75 + facing * 0.45);
  out.t = t;

  let meadow = meadowColor(frame.grassBase.rgb, base.xz);
  let tip = meadowColor(frame.grassTip.rgb, base.xz) * (0.8 + 0.4 * tone);
  var color = mix(meadow, tip, smoothstep(0.0, 1.0, t));
  if (flower && level >= 2u) {
    let petals = array<vec3f, 3>(vec3f(0.9, 0.85, 0.7), vec3f(0.95, 0.65, 0.08), vec3f(0.45, 0.25, 0.75));
    color = petals[u32(flowerKind * 2.999)];
  }
  // Dense grass shades its own roots.
  out.color = color * mix(1.0, mix(0.35, 1.0, t), frame.groundAmbient.w);
  return out;
}

@fragment fn fs(in: Out, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let n = select(in.normal * vec3f(-1.0, 1.0, -1.0), in.normal, front);
  var c = shade(in.color, n, in.world, 1.0, 0.5);
  // Light through the blade tips when looking toward the sun.
  let view = normalize(frame.cameraPos.xyz - in.world);
  let back = pow(max(dot(-view, frame.sunDir.xyz), 0.0), 3.0);
  c += in.color * frame.sunColor.rgb * frame.sunDir.w * back * in.t * 0.6;
  return vec4f(fog(c, in.world), 1.0);
}
`;

export class GrassRenderer {
  private texture: GPUTexture;
  private texels: Uint8Array;
  private bindGroup: GPUBindGroup;
  private pipeline: GPURenderPipeline;
  private versions: Uint32Array;

  constructor(private device: GPUDevice, private world: World, layouts: Layouts) {
    this.texture = device.createTexture({
      size: [world.sizeX, world.sizeZ],
      format: "rg8uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.texels = new Uint8Array(world.sizeX * world.sizeZ * 2);
    this.versions = new Uint32Array(world.chunkVersion.length);

    const layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "uint" } }],
    });
    this.bindGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: this.texture.createView() }],
    });
    const module = device.createShaderModule({ code: shader, label: "grass" });
    this.pipeline = device.createRenderPipeline({
      label: "grass",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: layouts.colorFormat }] },
      primitive: { topology: "triangle-strip", cullMode: "none" },
      depthStencil: { format: layouts.depthFormat, depthWriteEnabled: true, depthCompare: "less" },
      multisample: { count: layouts.samples },
    });
  }

  /** Re-upload the surface texture when any chunk changed. */
  update() {
    const { world } = this;
    let changed = false;
    for (let i = 0; i < this.versions.length; i++) {
      if (this.versions[i] !== world.chunkVersion[i]) {
        this.versions[i] = world.chunkVersion[i];
        changed = true;
      }
    }
    if (!changed) return;
    for (let i = 0; i < world.top.length; i++) {
      const h = world.top[i];
      const x = i % world.sizeX, z = (i / world.sizeX) | 0;
      this.texels[i * 2] = Math.max(h, 0);
      this.texels[i * 2 + 1] = h >= 0 ? world.get(x, h, z) : 0;
    }
    this.device.queue.writeTexture(
      { texture: this.texture },
      this.texels,
      { bytesPerRow: world.sizeX * 2 },
      [world.sizeX, world.sizeZ],
    );
  }

  /** Blade instances for the current grass radius and density. */
  static instanceCount(radius: number, bladesPerBlock: number) {
    return (radius * 2) ** 2 * bladesPerBlock;
  }

  draw(pass: GPURenderPassEncoder, instances: number) {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(1, this.bindGroup);
    pass.draw(2 * 3 + 1, instances);
  }
}
