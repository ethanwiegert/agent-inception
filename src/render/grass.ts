import { F, frameWgsl, lightingWgsl } from "./frame.ts";
import { grassWeightWgsl, slopeDropWgsl, type SurfaceTexture } from "./surface.ts";
import type { Layouts } from "./renderer.ts";

/** Blades the compact buffer can hold (32 bytes each). */
const MAX_BLADES = 900_000;
/** Wildflower blades held in a separate small buffer so opaque grass keeps hardware Early-Z. */
const MAX_FLOWERS = 32_768;
const WORKGROUP = 64;
const DETAIL_RADIUS = 32;
const CANOPY_BUDGET = 600_000;

/**
 * GPU-generated grass in two steps:
 *  1. A compute pass walks a sparse world grid and a dense grid around the eye (hash-placed,
 *     `bladesPerBlock` per column), culls them against the surface texture, the organic
 *     grass edge and the frustum, and writes survivors to compact buffers (opaque grass blades
 *     and alpha-tested wildflowers separately) with their color, wind bend and shadowing worked out.
 *  2. Two indirect draws render the survivors: opaque 5-vertex strips (Early-Z enabled) for grass,
 *     and 8-vertex strips for the small fraction of nodding wildflowers.
 */
const common = frameWgsl + lightingWgsl + slopeDropWgsl + grassWeightWgsl + /* wgsl */ `
const GRASS = 1u;
const GRASS_SEGMENTS = 2u;
const FLOWER_SEGMENTS = 3u;
const MAX_BLADES = ${MAX_BLADES}u;
const MAX_FLOWERS = ${MAX_FLOWERS}u;

struct Blade {
  pos: vec3f,
  heightWidth: u32,   // pack2x16float(height, width)
  facingLight: u32,   // pack2x16unorm(facing / 2π, key light)
  bend: u32,          // pack2x16float(bend x, bend z) at the tip
  base: u32,          // pack4x8unorm(sqrt(root color)); alpha = how hard a gust presses the blade
  tip: u32,           // pack4x8unorm(sqrt(tip color)); alpha = flower kind (0 = none)
};
`;

const cullShader = common + /* wgsl */ `
struct DrawArgs { vertexCount: u32, instanceCount: atomic<u32>, firstVertex: u32, firstInstance: u32 };

@group(1) @binding(0) var surface: texture_2d<u32>;
@group(1) @binding(1) var<storage, read_write> blades: array<Blade>;
@group(1) @binding(2) var<storage, read_write> args: DrawArgs;
@group(1) @binding(3) var<storage, read_write> flowers: array<Blade>;
@group(1) @binding(4) var<storage, read_write> flowerArgs: DrawArgs;

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
  let canopy = max(1u, (bladesPerBlock + 4u) / 8u);
  let detail = bladesPerBlock - canopy;
  let stride = u32(frame.wind.w);
  let extent = vec2u(frame.grassCenter.zw);
  let grid = (extent + stride - 1u) / stride;
  let canopyCount = grid.x * grid.y * canopy;
  let side = u32(radius * 2);
  let ii = gid.x;
  if (ii >= canopyCount + side * side * detail) { return; }

  var k: u32;
  var cell: vec2i;
  if (ii < canopyCount) {
    let tile = ii / canopy;
    k = ii % canopy;
    var col = vec2u(tile % grid.x, tile / grid.x) * stride;
    if (stride > 1u) {
      // Larger worlds sample a stable column inside each tile, including partial edge tiles.
      let pick = pcg(ii);
      col += vec2u(pick, pcg(pick)) % min(vec2u(stride), extent - col);
    }
    cell = vec2i(col);
  } else {
    let j = ii - canopyCount;
    let tile = j / detail;
    k = canopy + j % detail;
    cell = vec2i(vec2u(tile % side, tile / side)) - radius + vec2i(frame.grassCenter.xy);
  }
  let cx = cell.x;
  let cz = cell.y;
  if (cx < 0 || cz < 0 || f32(cx) >= frame.grassCenter.z || f32(cz) >= frame.grassCenter.w) { return; }

  let s = textureLoad(surface, vec2i(cx, cz), 0);
  // Grass grows on grass, and fringes onto neighbouring natural ground; never under water.
  let natural = s.g == GRASS || s.g == 2u || s.g == 6u || s.g == 7u || s.g == 8u;
  if (!natural || s.a > s.r + 1u || (s.g != GRASS && (s.b >> 4u) == 0u)) { return; }

  // Reject off-screen columns before hashing every blade in them. The two-block margin keeps
  // the blade jitter and its wind bend safely inside the old per-blade frustum test's coverage.
  let clip = frame.viewProj * vec4f(f32(cx) + 0.5, f32(s.r) + 1.0, f32(cz) + 0.5, 1.0);
  if (clip.w <= 0.0 || clip.z > clip.w || any(abs(clip.xy) > vec2f(clip.w * 1.1 + 2.0))) { return; }

  let cellSeed = (u32(cx) * 73856093u) ^ (u32(cz) * 19349663u);
  var seed = pcg(cellSeed ^ (k * 83492791u));
  // Three or four leaves share a crown. The first few crowns also represent this tile far away.
  let crowns = (bladesPerBlock + 3u) / 4u;
  var tuft = pcg((cellSeed ^ ((k % crowns) * 2654435761u)) + 47u);
  let fx = 0.08 + 0.84 * rand(&tuft) + (rand(&seed) - 0.5) * 0.14;
  let fz = 0.08 + 0.84 * rand(&tuft) + (rand(&seed) - 0.5) * 0.14;
  let base = vec3f(f32(cx) + fx, f32(s.r) + 1.0 - slopeDrop(s.b & 15u, fx, fz), f32(cz) + fz);
  let d = distance(base, frame.cameraPos.xyz);
  let far = smoothstep(8.0, f32(radius) - 1.0, d);
  // Beyond the mid-range, thin canopy blades smoothly down to 1-2 wider tufts per column so
  // distant slopes stay velvety without rasterizing sub-pixel triangle soup.
  let veryFar = smoothstep(50.0, 130.0, d);
  let farCanopy = mix(f32(canopy), min(f32(canopy), 1.5), veryFar);
  let count = mix(f32(bladesPerBlock), farCanopy, far);
  let growth = clamp(count - f32(k), 0.0, 1.0);
  if (growth <= 0.0 || !isGrassy(s, base.xz)) { return; }

  // Clumping at the 2-4 block scale: tufts grow taller and richer together, thin patches stay
  // short and pale, and some blades never sprout in the bare spots.
  let clump = valueNoise(base.xz * 0.3);
  if (rand(&seed) > mix(0.55, 1.0, smoothstep(0.3, 0.5, clump))) { return; }
  let dry = smoothstep(0.55, 0.75, valueNoise(base.xz * 0.18 + 61.0));

  let heightRand = rand(&seed);
  let angle = rand(&seed);
  let lean = rand(&seed);
  let tone = rand(&seed);
  // Flowers come in drifts, not a uniform chance.
  let flower = d < 95.0 &&
    rand(&seed) < frame.grassTip.w * (1.0 - far * 0.8) * smoothstep(0.42, 0.62, valueNoise(base.xz * 0.11 + 40.0)) * 1.7;
  let flowerKind = rand(&seed);
  // Drier patches grow taller blades with pale seed heads (tip kind 3).
  let seedHead = !flower && rand(&seed) < dry * 0.04;
  let tipKind = select(min(u32(flowerKind * 3.0), 2u), 3u, seedHead);
  let hasTip = flower || seedHead;

  var h = frame.grass.x * (0.55 + 0.9 * heightRand * heightRand) * (0.75 + 0.55 * clump) * growth *
    select(1.0, 1.25, flower) * select(1.0, 1.3, seedHead) * mix(1.0, 1.16, far);
  let w = frame.grass.y * mix(1.0, mix(2.15, 2.7, veryFar), far) * (0.74 + 0.48 * tone);
  let facing = vec2f(cos(angle * 6.2831853), sin(angle * 6.2831853));
  let time = frame.cameraPos.w;
  let gust = valueNoise(base.xz * 0.06 - frame.wind.xy * time * 0.8);
  let sway = sin(time * 2.1 + dot(base.xz, frame.wind.xy) * 0.6 + lean * 6.0) * 0.25;
  var bend = facing * (0.24 + 0.56 * lean) * h + frame.wind.xy * frame.wind.z * (gust * 0.9 + sway * 0.4) * h;

  // The field map: crowns pool shade, villagers press a parting through the blades.
  let field = fieldAt(base.xz);
  var press = 0.0;
  for (var i = 0; i < 16; i++) {
    let pu = frame.pushers[i];
    if (pu.w <= 0.0) { break; }
    let dvec = base.xz - pu.xz;
    let dist = length(dvec);
    if (dist >= pu.w) { continue; }
    let pk = 1.0 - dist / pu.w;
    bend += (dvec / max(dist, 0.01)) * pk * h * 0.9;
    press = max(press, pk);
  }
  h *= 1.0 - press * 0.55;

  let occ = mix(1.0, field.x, 0.85);
  let shoreLush = smoothstep(0.64, 0.52, field.y);
  let lushTint = vec3f(0.82, 1.07, 0.9);
  // Evaluate meadowColor's noise once and tint both root and tip from it.
  let mt = smoothstep(0.35, 0.85, valueNoise(base.xz * 0.045) * 0.7 + valueNoise(base.xz * 0.17) * 0.3);
  let meadowMult = mix(vec3f(0.82, 1.04, 0.9), vec3f(1.3, 1.12, 0.6), mt);
  var root = frame.grassBase.rgb * meadowMult;
  var tip = frame.grassTip.rgb * meadowMult * (0.8 + 0.4 * tone);
  let commonMul = mix(vec3f(1.0), lushTint, shoreLush * 0.7) * occ * (0.85 + 0.3 * clump);
  root = root * commonMul * (1.0 - press * 0.25);
  tip = tip * commonMul * mix(vec3f(0.78, 0.99, 1.12), vec3f(1.22, 1.02, 0.77), dry);
  let midPos = base + vec3f(0.0, h * 0.5, 0.0);
  var light = 0.0;
  if (frame.sunDir.w > 0.001) {
    var sh = 1.0;
    if (frame.qualityParams.x < 0.5) {
      sh = shadowPoint(midPos);
    } else {
      sh = shadowFast(midPos);
    }
    light = sh * cloudLight(midPos) * occ;
  }

  let packed = Blade(
    base,
    pack2x16float(vec2f(h, w)),
    pack2x16unorm(vec2f(angle, light)),
    pack2x16float(bend),
    pack4x8unorm(vec4f(sqrt(root), smoothstep(0.5, 0.9, gust) * min(frame.wind.z, 1.0))),
    pack4x8unorm(vec4f(sqrt(tip), select(0.0, 0.25 + 0.75 * (f32(tipKind) + 0.5) / 4.0, hasTip))));

  if (flower) {
    let idx = atomicAdd(&flowerArgs.instanceCount, 1u);
    if (idx < MAX_FLOWERS) { flowers[idx] = packed; }
  } else {
    let idx = atomicAdd(&args.instanceCount, 1u);
    if (idx < MAX_BLADES) { blades[idx] = packed; }
  }
}
`;

const drawGrassShader = common + /* wgsl */ `
@group(1) @binding(0) var<storage, read> blades: array<Blade>;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) t: f32,
  @location(4) light: f32,
  @location(5) lamp: vec3f,
  /** How hard a gust presses the blade flat: drives the sheen across the laid-over side. */
  @location(6) press: f32,
  @location(7) across: f32,
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

  let level = min(vi / 2u, GRASS_SEGMENTS);
  let t = f32(level) / f32(GRASS_SEGMENTS);
  let isTip = level == GRASS_SEGMENTS;
  let sideSign = select(select(-0.5, 0.5, (vi & 1u) == 1u), 0.0, isTip);
  let curve = t * t;
  let painterly = frame.lookParams.y;
  let rootc = unpack4x8unorm(b.base);
  let root = rootc.rgb * rootc.rgb;
  let tipc = unpack4x8unorm(b.tip);
  let taper = mix(1.0 - t, pow(max(1.0 - t, 0.0), 0.58), painterly);
  var p = b.pos + right * sideSign * hw.y * taper + vec3f(0.0, hw.x * t, 0.0) + bend * curve;
  p.y -= length(bend) * curve * 0.25;

  var color = mix(root, tipc.rgb * tipc.rgb, smoothstep(0.0, 1.0, t));
  color = mix(color, color * 1.28 + vec3f(0.03, 0.036, 0.01), rootc.a * t);
  if (tipc.a > 0.85 && level >= 1u) {
    color = mix(color, vec3f(0.42, 0.36, 0.16), 0.6);
  }
  out.pos = frame.viewProj * vec4f(p, 1.0);
  out.world = p;
  let fan = mix(0.8, 0.36, painterly);
  out.normal = normalize(vec3f(0.0, mix(0.75, 0.92, painterly), 0.0) + facing * 0.32 + right * sideSign * fan);
  out.t = t;
  out.across = sideSign * 2.0;
  out.light = fl.y;
  out.lamp = lampLight(p, vec3f(0.0, 1.0, 0.0));
  out.press = rootc.a * t;
  let rootDark = mix(0.35, 0.68, painterly);
  out.color = color * mix(1.0, mix(rootDark, 1.0, t), frame.groundAmbient.w);
  return out;
}

@fragment fn fs(in: Out, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let n = select(in.normal * vec3f(-1.0, 1.0, -1.0), in.normal, front);
  // A folded leaf has a lit midrib and a cooler half in shade. Filter the line at subpixel widths.
  let line = 1.0 - smoothstep(0.06, 0.28, abs(in.across));
  let resolved = 1.0 - smoothstep(0.24, 0.9, fwidth(in.across));
  let fold = (line * 0.24 - in.across * 0.13) * resolved * smoothstep(0.06, 0.35, in.t);
  let albedo = in.color * (1.0 + fold);
  var c = shadeWith(albedo, n, in.light, 1.0, 0.5) + albedo * in.lamp;
  // Light through the blade tips when looking toward the sun.
  let view = normalize(frame.cameraPos.xyz - in.world);
  let back = pow(max(dot(-view, frame.sunDir.xyz), 0.0), 3.0);
  c += in.color * frame.sunColor.rgb * frame.sunDir.w * back * in.t * 0.6 * in.light;
  // A faint specular sheen along blades a gust has laid flat.
  let hdir = normalize(view + frame.sunDir.xyz);
  c += frame.sunColor.rgb * frame.sunDir.w * in.light *
    pow(max(dot(n, hdir), 0.0), 12.0) * in.press * 0.15;
  return vec4f(fog(c, in.world), 1.0);
}
`;

const drawFlowerShader = common + /* wgsl */ `
@group(1) @binding(0) var<storage, read> blades: array<Blade>;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) t: f32,
  @location(4) light: f32,
  @location(5) lamp: vec3f,
  @location(6) press: f32,
  @location(7) across: f32,
  @location(8) @interpolate(flat) flower: u32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var out: Out;
  if (ii >= MAX_FLOWERS) {
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

  let level = min(vi / 2u, FLOWER_SEGMENTS);
  let t = f32(level) / f32(FLOWER_SEGMENTS);
  let sideSign = select(-0.5, 0.5, (vi & 1u) == 1u);
  let curve = t * t;
  let painterly = frame.lookParams.y;
  let rootc = unpack4x8unorm(b.base);
  let root = rootc.rgb * rootc.rgb;
  let tipc = unpack4x8unorm(b.tip);
  let taper = mix(1.0 - t, pow(max(1.0 - t, 0.0), 0.58), painterly);
  var p = b.pos + right * sideSign * hw.y * taper * 0.32 + vec3f(0.0, hw.x * t, 0.0) + bend * curve;
  p.y -= length(bend) * curve * 0.25;

  var color = mix(root, tipc.rgb * tipc.rgb, smoothstep(0.0, 1.0, t));
  color = mix(color, color * 1.28 + vec3f(0.03, 0.036, 0.01), rootc.a * t);
  let flower = u32(clamp((tipc.a - 0.25) / 0.75 * 4.0, 0.0, 3.0)) + 1u;
  out.flower = flower;
  if (level >= 2u) {
    let radius = hw.x * 0.16;
    let axis = facing * 0.78 + vec3f(0.0, 0.62, 0.0);
    p = b.pos + vec3f(0.0, hw.x - length(bend) * 0.25, 0.0) + bend +
      radius * (right * sideSign * 2.0 + axis * select(-1.0, 1.0, level == 3u));
  }
  out.pos = frame.viewProj * vec4f(p, 1.0);
  out.world = p;
  let fan = mix(0.8, 0.36, painterly);
  out.normal = normalize(vec3f(0.0, mix(0.75, 0.92, painterly), 0.0) + facing * 0.32 + right * sideSign * fan);
  out.t = t;
  out.across = sideSign * 2.0;
  out.light = fl.y;
  out.lamp = lampLight(p, vec3f(0.0, 1.0, 0.0));
  out.press = rootc.a * t;
  let rootDark = mix(0.35, 0.68, painterly);
  out.color = color * mix(1.0, mix(rootDark, 1.0, t), frame.groundAmbient.w);
  return out;
}

@fragment fn fs(in: Out, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let n = select(in.normal * vec3f(-1.0, 1.0, -1.0), in.normal, front);
  var albedo = in.color;
  if (in.t >= 2.0 / 3.0) {
    let uv = vec2f(in.across, in.t * 6.0 - 5.0);
    let r = length(uv);
    let lobes = cos(5.0 * atan2(uv.y, uv.x));
    if (r > 0.72 + 0.24 * lobes) { discard; }
    let petals = array<vec3f, 3>(vec3f(0.88, 0.83, 0.65), vec3f(0.9, 0.56, 0.08), vec3f(0.8, 0.33, 0.49));
    albedo = mix(vec3f(0.64, 0.32, 0.04), petals[in.flower - 1u] * (0.82 + 0.18 * r),
      smoothstep(0.18, 0.32, r));
  }
  var c = shadeWith(albedo, n, in.light, 1.0, 0.5) + albedo * in.lamp;
  let view = normalize(frame.cameraPos.xyz - in.world);
  let back = pow(max(dot(-view, frame.sunDir.xyz), 0.0), 3.0);
  c += in.color * frame.sunColor.rgb * frame.sunDir.w * back * in.t * 0.6 * in.light;
  return vec4f(fog(c, in.world), 1.0);
}
`;

export class GrassRenderer {
  private cullPipeline: GPUComputePipeline;
  private drawPipeline: GPURenderPipeline;
  private flowerPipeline: GPURenderPipeline;
  private cullBindGroup: GPUBindGroup;
  private drawBindGroup: GPUBindGroup;
  private flowerBindGroup: GPUBindGroup;
  private args: GPUBuffer;
  private flowerArgs: GPUBuffer;
  private blades: GPUBuffer;
  private flowers: GPUBuffer;
  private static readonly ZERO = new Uint32Array([0]);

  constructor(private device: GPUDevice, surface: SurfaceTexture, layouts: Layouts) {
    const blades = this.blades = device.createBuffer({
      size: MAX_BLADES * 32,
      usage: GPUBufferUsage.STORAGE,
    });
    const flowers = this.flowers = device.createBuffer({
      size: MAX_FLOWERS * 32,
      usage: GPUBufferUsage.STORAGE,
    });
    this.args = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.flowerArgs = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.args, 0, new Uint32Array([5, 0, 0, 0]));
    device.queue.writeBuffer(this.flowerArgs, 0, new Uint32Array([8, 0, 0, 0]));

    const C = GPUShaderStage.COMPUTE;
    const cullLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: C, texture: { sampleType: "uint" } },
        { binding: 1, visibility: C, buffer: { type: "storage" } },
        { binding: 2, visibility: C, buffer: { type: "storage" } },
        { binding: 3, visibility: C, buffer: { type: "storage" } },
        { binding: 4, visibility: C, buffer: { type: "storage" } },
      ],
    });
    this.cullBindGroup = device.createBindGroup({
      layout: cullLayout,
      entries: [
        { binding: 0, resource: surface.view },
        { binding: 1, resource: { buffer: blades } },
        { binding: 2, resource: { buffer: this.args } },
        { binding: 3, resource: { buffer: flowers } },
        { binding: 4, resource: { buffer: this.flowerArgs } },
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
    this.flowerBindGroup = device.createBindGroup({
      layout: drawLayout,
      entries: [{ binding: 0, resource: { buffer: flowers } }],
    });
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [layouts.frame, drawLayout],
    });
    const makeDraw = (code: string, label: string) => {
      const module = device.createShaderModule({ code, label });
      return device.createRenderPipeline({
        label,
        layout: pipelineLayout,
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: layouts.colorFormat }] },
        primitive: { topology: "triangle-strip", cullMode: "none" },
        depthStencil: {
          format: layouts.depthFormat,
          depthWriteEnabled: true,
          depthCompare: "less",
        },
        multisample: { count: layouts.samples },
      });
    };
    this.drawPipeline = makeDraw(drawGrassShader, "grass");
    this.flowerPipeline = makeDraw(drawFlowerShader, "grass-flowers");
  }

  /** Write the two GPU grid dimensions and bound the dispatch even for large imported worlds. */
  static candidates(frame: Float32Array, width: number, depth: number, bladesPerBlock: number) {
    const canopy = Math.max(1, Math.round(bladesPerBlock / 8));
    let stride = Math.max(1, Math.ceil(Math.sqrt(width * depth * canopy / CANOPY_BUDGET)));
    while (Math.ceil(width / stride) * Math.ceil(depth / stride) * canopy > CANOPY_BUDGET) stride++;
    frame[F.wind + 3] = stride;
    frame[F.grass + 3] = DETAIL_RADIUS;
    return Math.ceil(width / stride) * Math.ceil(depth / stride) * canopy +
      (DETAIL_RADIUS * 2) ** 2 * (bladesPerBlock - canopy);
  }

  /**
   * Cull candidates into the compact buffers. Needs this frame's shadow map, so encode it
   * after the shadow pass and before the pass that draws the grass.
   */
  cull(encoder: GPUCommandEncoder, frameBindGroup: GPUBindGroup, candidates: number) {
    this.device.queue.writeBuffer(this.args, 4, GrassRenderer.ZERO);
    this.device.queue.writeBuffer(this.flowerArgs, 4, GrassRenderer.ZERO);
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
    pass.setPipeline(this.flowerPipeline);
    pass.setBindGroup(1, this.flowerBindGroup);
    pass.drawIndirect(this.flowerArgs, 0);
  }

  destroy() {
    this.blades.destroy();
    this.flowers.destroy();
    this.args.destroy();
    this.flowerArgs.destroy();
  }
}
