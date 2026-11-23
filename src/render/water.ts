import { aabbVisible } from "../math.ts";
import { CHUNK } from "../sim/world.ts";
import { frameWgsl, lightingWgsl } from "./frame.ts";
import type { Layouts } from "./renderer.ts";
import type { SurfaceTexture } from "./surface.ts";

/**
 * Water: one quad per wet column, generated in the vertex shader from the
 * shared surface texture (no meshes to rebuild when agents dig ponds), plus an
 * ocean plane out to the horizon. Waves, reflections and foam are procedural.
 * Wet columns are listed once per surface change, grouped by chunk, so a frame
 * draws only the wet columns of visible chunks.
 */
/** Bound when the frame stores its opaque pass (medium and high): resolved opaque color, the
 * MSAA scene depth, and the half-res linear depth, for refraction and soft shorelines. */
const sceneWgsl = (msaa: boolean) => /* wgsl */ `
@group(2) @binding(0) var sceneColor: texture_2d<f32>;
@group(2) @binding(1) var sceneSampler: sampler;
@group(2) @binding(2) var sceneDepth: ${
  msaa ? "texture_depth_multisampled_2d" : "texture_depth_2d"
};
@group(2) @binding(3) var sceneLinearDepth: texture_2d<f32>;
`;

const shader = (sceneInputs: boolean, ssr: boolean, msaa: boolean) =>
  frameWgsl + lightingWgsl + (sceneInputs ? sceneWgsl(msaa) : "") + /* wgsl */ `
@group(1) @binding(0) var surface: texture_2d<u32>;
@group(1) @binding(1) var<storage, read> wet: array<u32>;

const SURFACE_DROP = 0.12;
const OCEAN_REACH = 3000.0;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
};

fn culled() -> Out {
  var out: Out;
  out.pos = vec4f(0.0, 0.0, -1.0, 1.0);
  return out;
}

fn corner(vi: u32) -> vec2f {
  return vec2f(f32(vi & 1u), f32(vi >> 1u));
}

@vertex fn vsColumns(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  let size = vec2i(textureDimensions(surface));
  let key = i32(wet[ii]);
  let cell = vec2i(key % size.x, key / size.x);
  let s = textureLoad(surface, cell, 0);
  if (s.a == 0u) { return culled(); }
  let p = vec3f(f32(cell.x), f32(s.a) - SURFACE_DROP, f32(cell.y)) + vec3f(corner(vi).x, 0.0, corner(vi).y);
  return Out(frame.viewProj * vec4f(p, 1.0), p);
}

@vertex fn vsOcean(@builtin(vertex_index) vi: u32) -> Out {
  let c = (corner(vi) * 2.0 - 1.0) * OCEAN_REACH;
  let p = vec3f(frame.cameraPos.x + c.x, frame.extra.z + 1.0 - SURFACE_DROP, frame.cameraPos.z + c.y);
  return Out(frame.viewProj * vec4f(p, 1.0), p);
}

/** Ground height under the water, bilinear between column centers (deep sea outside the world). */
fn floorAt(xz: vec2f) -> f32 {
  let size = vec2i(textureDimensions(surface));
  let p = xz - 0.5;
  let i = vec2i(floor(p));
  let f = fract(p);
  var h = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  for (var k = 0; k < 4; k++) {
    let c = i + vec2i(k & 1, k >> 1);
    if (any(c < vec2i(0)) || any(c >= size)) {
      h[k] = frame.extra.z - 8.0;
    } else {
      let s = textureLoad(surface, c, 0);
      h[k] = f32(s.r) + 1.0 - f32(countOneBits(s.b & 15u)) * 0.25;
    }
  }
  return mix(mix(h[0], h[1], f.x), mix(h[2], h[3], f.x), f.y);
}

/**
 * The water's slope at xz. reach is how far xz moves across one pixel: a wave finer than the
 * pixels it lands on fades out, where it used to alias into moiré rings on the far sea.
 */
fn waveSlope(xz: vec2f, t: f32, reach: f32, fetch: f32) -> vec2f {
  var g = vec2f(0.0);
  // The two longest waves run with the wind, spread a few degrees apart; their height grows with
  // open-water fetch (depth standing in for shore distance), so ponds stay calm.
  let wdir = frame.wind.xy / max(length(frame.wind.xy), 0.2);
  let wa = atan2(wdir.y, wdir.x);
  let dirs = array<vec2f, 6>(
    vec2f(cos(wa + 0.35), sin(wa + 0.35)), vec2f(cos(wa - 0.3), sin(wa - 0.3)),
    vec2f(-0.4, 0.9), vec2f(0.95, -0.3), vec2f(-0.7, -0.7), vec2f(0.3, -0.95));
  let freqs = array<f32, 6>(0.9, 1.3, 1.7, 3.1, 5.3, 7.7);
  let amps = array<f32, 6>(
    0.05 * mix(0.3, 1.0, fetch), 0.04 * mix(0.3, 1.0, fetch), 0.03, 0.016, 0.008, 0.005);
  for (var i = 0; i < 6; i++) {
    let w = 1.0 - smoothstep(0.5, 1.6, freqs[i] * reach);
    if (w <= 0.0) { break; }
    let phase = dot(dirs[i], xz) * freqs[i] + t * (1.2 + f32(i) * 0.4);
    g += dirs[i] * cos(phase) * amps[i] * freqs[i] * w;
  }
  // Fine noise ripples and cat's paws fade out on the far sea; skip their noise when faded.
  let fineW = 1.0 - smoothstep(0.25, 0.8, 2.3 * reach);
  if (fineW > 0.0) {
    let e = 0.15;
    let r = xz * 2.3 + vec2f(t * 0.6, -t * 0.45);
    g += vec2f(valueNoise(r + vec2f(e, 0.0)) - valueNoise(r - vec2f(e, 0.0)),
               valueNoise(r + vec2f(0.0, e)) - valueNoise(r - vec2f(0.0, e))) * 0.12 * fineW;
    let paw = valueNoise(vec2f(dot(xz, wdir) * 0.08 - t * 0.9, dot(xz, vec2f(-wdir.y, wdir.x)) * 0.3));
    g += wdir * smoothstep(0.6, 0.9, paw) * fetch * 0.06 * (1.0 - smoothstep(0.2, 0.7, 2.3 * reach));
  }
  return g;
}

/** Ripples spreading from anything wading: rings around each pusher near the surface. */
fn rippleSlope(xz: vec2f, t: f32) -> vec2f {
  var g = vec2f(0.0);
  for (var i = 0; i < 16; i++) {
    let p = frame.pushers[i];
    if (p.w <= 0.0) { break; }
    let d = xz - p.xz;
    let dist = length(d);
    if (dist > p.w * 3.0 + 3.0) { continue; }
    let ring = sin(dist * 6.0 - t * 6.0) * exp(-(dist - p.w) * 0.8);
    g += (d / max(dist, 0.01)) * ring * 0.35;
  }
  return g;
}

/** Sky + cloud reflection along the bent reflect ray, shared by both tiers. */
fn skyMirror(r: vec3f, world: vec3f) -> vec3f {
  let up = vec3f(r.x, abs(r.y), r.z);
  var sky = skyColor(up);
  // The clouds overhead show in the water, soft: the same layer that shades the ground.
  let cloudAt = world.xz + up.xz * ((CLOUD_HEIGHT - world.y) / max(up.y, 0.08));
  let cloud = frame.sunColor.rgb * frame.sunDir.w * 0.38 + frame.skyZenith.rgb * 0.9 +
    frame.skyHorizon.rgb * 0.4;
  sky = mix(sky, cloud, cloudDensity(cloudAt) * smoothstep(0.05, 0.3, up.y) * 0.8);
  return sky;
}

/** Ray-length per view-depth unit at a screen uv (linear depth is stored along the forward). */
fn rayScaleAt(uv: vec2f) -> f32 {
  let w = frame.invViewProj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  return length(w.xyz / w.w - frame.cameraPos.xyz) / frame.depthParams.x;
}

fn shadeWater(world: vec3f, pos: vec4f) -> vec4f {
  let t = frame.cameraPos.w;
  let depth = max(world.y - floorAt(world.xz), 0.0);
  let fetch = smoothstep(0.3, 3.0, depth);
  var g = waveSlope(world.xz, t, max(length(dpdx(world.xz)), length(dpdy(world.xz))), fetch);
  g += rippleSlope(world.xz, t);
  let n = normalize(vec3f(-g.x, 1.0, -g.y));
  let toEye = frame.cameraPos.xyz - world;
  let dist = length(toEye);
  let view = toEye / dist;
  let ndv = max(dot(n, view), 0.0);
  let fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  let light = keyLightFast(world);
  let ambient = frame.skyZenith.rgb * frame.sunColor.w * 0.9 + frame.groundAmbient.rgb * 0.3;
  let lit = ambient + frame.sunColor.rgb * frame.sunDir.w * max(frame.sunDir.y, 0.0) * light * 0.6;
  let painterly = frame.lookParams.y;
  let shallow = mix(vec3f(0.035, 0.13, 0.11), vec3f(0.045, 0.175, 0.165), painterly);
  let deep = mix(vec3f(0.006, 0.03, 0.045), vec3f(0.01, 0.048, 0.078), painterly);
  var body = mix(shallow, deep, smoothstep(0.0, 3.0, depth)) * lit;

  var alpha: f32;
  var base = body;
  var foamDepth = depth;
  ${
    sceneInputs
      ? /* wgsl */ `
    // Refraction: the opaque color offset by the wave normal, rejected where a nearer opaque
    // surface (a hull, a rock) would be pulled under the water. The floor's view depth comes
    // from the half-res linear depth, scaled by the ray's slant to match the eye distance.
    let ndcUv = pos.xy * frame.depthParams.zw;
    let centerRay = rayScaleAt(ndcUv);
    let centerBackL = textureSampleLevel(sceneLinearDepth, sceneSampler, ndcUv, 0.0).r * centerRay;
    foamDepth = min(depth, max(centerBackL - dist, 0.0) * 1.4);
    var uv = ndcUv + n.xz * (min(depth, 2.5) * 0.035) / max(dist * 0.002, 1.0);
    var backL = textureSampleLevel(sceneLinearDepth, sceneSampler, uv, 0.0).r * centerRay;
    if (backL < dist - 0.05) {
      uv = ndcUv;
      backL = centerBackL;
    }
    let path = max(backL - dist, 0.0);
    var refracted = textureSampleLevel(sceneColor, sceneSampler, uv, 0.0).rgb;
    // Absorption along the true path through the water: wading things and reeds sink into the
    // color instead of cutting a line; the shallow teal over sand stays.
    refracted *= exp(-path * vec3f(0.5, 0.22, 0.18));
    refracted += mix(shallow, deep, smoothstep(0.0, 4.0, path)) * lit * (1.0 - exp(-path * 0.9));
    var refl = skyMirror(reflect(-view, n), world);
    ${
        ssr
          ? /* wgsl */ `
    // Screen-space reflections (high): march the reflected ray against the half-res linear
    // depth (clip.w is linear view depth) and fetch opaque color; fall back to sky mirror at edges.
    if (n.y > 0.6 && dist < 220.0) {
      let rr = reflect(-view, n);
      var hit = false;
      var hp = vec2f(0.0);
      for (var i = 0; i < 12; i++) {
        let st = 0.4 + 60.0 * (f32(i) / 12.0) * (f32(i) / 12.0);
        let wp = world + rr * st;
        let clip = frame.viewProj * vec4f(wp, 1.0);
        if (clip.w <= 0.0) { continue; }
        let sp = clip.xy / clip.w * vec2f(0.5, -0.5) + 0.5;
        if (sp.x < 0.0 || sp.x > 1.0 || sp.y < 0.0 || sp.y > 1.0) { break; }
        let sl = textureSampleLevel(sceneLinearDepth, sceneSampler, sp, 0.0).r;
        if (sl < 3000.0 && clip.w > sl && clip.w - sl < 1.5) { hit = true; hp = sp; break; }
      }
      if (hit) {
        let edge = smoothstep(0.0, 0.06, hp.x) * smoothstep(1.0, 0.94, hp.x) *
          smoothstep(0.0, 0.06, hp.y) * smoothstep(1.0, 0.94, hp.y);
        refl = mix(refl, textureSampleLevel(sceneColor, sceneSampler, hp, 0.0).rgb,
          edge * smoothstep(0.15, 0.3, n.y));
      }
    }`
          : ""
      }
    base = mix(refracted, refl, fresnel);
    alpha = 1.0;
  `
      : /* wgsl */ `
    base = mix(body, skyMirror(reflect(-view, n), world), fresnel);
    // The floor below is already darkened by absorption, so the surface itself can stay fairly
    // clear. Deep water hides its floor: the open sea has none, and the world's edge would show.
    let clear = mix(0.25, 0.85, smoothstep(0.0, 3.5, depth)) + 0.15 * smoothstep(3.5, 6.5, depth);
    alpha = clamp(max(clear, fresnel), 0.0, 1.0);
  `
  }

  let r = reflect(-view, n);
  var color = base;
  // Sun glitter: a wide path at low sun, a tight sparkle overhead; Miniature adds golden water glints.
  let sunD = max(dot(r, frame.sunDir.xyz), 0.0);
  let glitter = mix(240.0, 52.0, smoothstep(0.32, 0.0, frame.sunDir.y));
  let spec = pow(sunD, glitter) * (30.0 + 18.0 * painterly) + pow(sunD, 50.0) * (0.4 + 0.35 * painterly);
  color += frame.sunColor.rgb * frame.sunDir.w * spec * light;
  color += vec3f(0.55, 0.65, 1.0) * frame.moonDir.w * pow(max(dot(r, frame.moonDir.xyz), 0.0), 420.0) * (8.0 + 6.0 * painterly) * light;

  // Foam where the water thins out against the shore. In the scene variant the soft intersection
  // also softens where anything opaque meets the surface.
  let foamNoise = valueNoise(world.xz * 3.0 + vec2f(t * 0.3, t * 0.2)) * valueNoise(world.xz * 7.0 - t * 0.25);
  // A slow swash wets and dries the sand band; lapping lines ride in on it.
  let swash = depth - sin(t * 0.5 + valueNoise(world.xz * 0.25) * 8.0) * 0.22;
  let lap = smoothstep(0.82, 1.0, sin(swash * 11.0 + t * 1.3 + valueNoise(world.xz * 0.7) * 6.0)) *
    smoothstep(0.75, 0.3, swash) * smoothstep(0.03, 0.12, swash) * smoothstep(0.0, 0.2, foamNoise);
  let foam = max(smoothstep(0.35, 0.0, foamDepth) * smoothstep(0.08, 0.25, foamNoise + 0.15), lap * 0.7);
  color = mix(color, (ambient + frame.sunColor.rgb * frame.sunDir.w * light * 0.5) * 0.9, foam);
  alpha = clamp(max(alpha, foam), 0.0, 1.0);
  return vec4f(fog(color, world), alpha);
}

@fragment fn fsColumns(in: Out) -> @location(0) vec4f {
  return shadeWater(in.world, in.pos);
}

@fragment fn fsOcean(in: Out) -> @location(0) vec4f {
  // Inside the world the per-column water takes over. The two overlap by a pixel, or the sky
  // would show between them as a dotted line.
  let size = vec2f(textureDimensions(surface));
  let edge = fwidth(in.world.xz);
  if (all(in.world.xz >= edge) && all(in.world.xz <= size - edge)) { discard; }
  return shadeWater(in.world, in.pos);
}
`;

export class WaterRenderer {
  private layout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup | null = null;
  /** [plain, scene, scene+ssr] pipeline pairs; scene variants see the opaque pass's output. */
  private columns: GPURenderPipeline[] = [];
  private ocean: GPURenderPipeline[] = [];
  private wet: GPUBuffer | null = null;
  private keys: Uint32Array;
  /** Per chunk: first entry and count in `wet`. */
  private first: Uint32Array;
  private counts: Uint32Array;
  private version = -1;
  private chunksX: number;

  constructor(
    private device: GPUDevice,
    private surface: SurfaceTexture,
    layouts: Layouts,
    /** World height, the top of each chunk's bounds. */
    private worldHeight: number,
  ) {
    const { width, height } = surface.texture;
    this.keys = new Uint32Array(width * height);
    this.chunksX = Math.ceil(width / CHUNK);
    const chunks = this.chunksX * Math.ceil(height / CHUNK);
    this.first = new Uint32Array(chunks);
    this.counts = new Uint32Array(chunks);
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: VF, texture: { sampleType: "uint" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    const variants: [boolean, boolean, string][] = [
      [false, false, "water"],
      [true, false, "water-scene"],
      [true, true, "water-ssr"],
    ];
    const modules = variants.map(([scene, ssr, label]) =>
      device.createShaderModule({ code: shader(scene, ssr, layouts.samples > 1), label })
    );
    const pipeline = (module: GPUShaderModule, scene: boolean, vs: string, fs: string) =>
      device.createRenderPipeline({
        label: `water-${vs}${scene ? "-scene" : ""}`,
        layout: device.createPipelineLayout({
          bindGroupLayouts: scene
            ? [layouts.frame, this.layout, layouts.scene]
            : [layouts.frame, this.layout],
        }),
        vertex: { module, entryPoint: vs },
        fragment: {
          module,
          entryPoint: fs,
          targets: [{
            format: layouts.colorFormat,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          }],
        },
        primitive: { topology: "triangle-strip", cullMode: "none" },
        depthStencil: {
          format: layouts.depthFormat,
          depthWriteEnabled: false,
          depthCompare: "less",
        },
        multisample: { count: layouts.samples },
      });
    for (let v = 0; v < 3; v++) {
      const scene = v > 0;
      this.columns.push(pipeline(modules[v], scene, "vsColumns", "fsColumns"));
      this.ocean.push(pipeline(modules[v], scene, "vsOcean", "fsOcean"));
    }
  }

  /** Relist the wet columns, chunk by chunk, after the surface changed. */
  private update() {
    const s = this.surface;
    if (s.version === this.version) return;
    this.version = s.version;
    const { width, height } = s.texture;
    let n = 0;
    for (let c = 0; c < this.counts.length; c++) {
      const x0 = (c % this.chunksX) * CHUNK, z0 = Math.floor(c / this.chunksX) * CHUNK;
      this.first[c] = n;
      for (let z = z0; z < Math.min(height, z0 + CHUNK); z++) {
        for (let x = x0; x < Math.min(width, x0 + CHUNK); x++) {
          const key = z * width + x;
          if (s.texels[key * 4 + 3] > 0) this.keys[n++] = key;
        }
      }
      this.counts[c] = n - this.first[c];
    }
    const bytes = Math.max(4, n * 4);
    if (!this.wet || this.wet.size < bytes) {
      this.wet?.destroy();
      this.wet = this.device.createBuffer({
        size: Math.max(bytes, this.keys.byteLength / 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.bindGroup = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: this.surface.view },
          { binding: 1, resource: { buffer: this.wet } },
        ],
      });
    }
    if (n) this.device.queue.writeBuffer(this.wet, 0, this.keys, 0, n);
  }

  /** Draw after all opaque geometry; `planes` cull chunks outside the view. `scene` is the
   * opaque pass's output when the frame keeps it (medium and high tiers). */
  draw(pass: GPURenderPassEncoder, planes: Float32Array, scene: GPUBindGroup | null, high = false) {
    this.update();
    if (!this.bindGroup) return;
    pass.setBindGroup(1, this.bindGroup);
    const variant = scene ? (high ? 2 : 1) : 0;
    if (scene) pass.setBindGroup(2, scene);
    pass.setPipeline(this.ocean[variant]);
    pass.draw(4);
    pass.setPipeline(this.columns[variant]);
    for (let c = 0; c < this.counts.length; c++) {
      const n = this.counts[c];
      if (!n) continue;
      const x = (c % this.chunksX) * CHUNK, z = Math.floor(c / this.chunksX) * CHUNK;
      if (!aabbVisible(planes, x, 0, z, x + CHUNK, this.worldHeight, z + CHUNK)) continue;
      pass.draw(4, n, 0, this.first[c]);
    }
  }

  destroy() {
    this.wet?.destroy();
  }
}
