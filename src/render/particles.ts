import { type DesignContent, deviceKind, type MaterialContent } from "../sim/catalog.ts";
import { deviceLit } from "../sim/light.ts";
import type { Objects } from "../sim/objects.ts";
import { poseBoxes } from "../sim/physics.ts";
import { FIRE_STRIDE } from "../sim/protocol.ts";
import { hash2 } from "../sim/rng.ts";
import type { BodyPose } from "../simclient.ts";
import { commonWgsl, frameWgsl } from "./frame.ts";
import type { Layouts } from "./renderer.ts";

/**
 * Fire, smoke, lamp halos and signal sparks: camera-facing quads shaded procedurally. Flames and
 * light add to the scene (they glow); smoke is blended over it. Everything is rebuilt each frame
 * from what burns and shines, so nothing here holds state but the sparks in flight.
 */

/** Floats per particle: position, kind, size (w, h), seed, fade, color, strength. */
const FLOATS = 12;
const MAX = 2048;
const Kind = { Flame: 0, Halo: 1, Spark: 2, Smoke: 3 } as const;
/** How long a signal's sparks take to arrive, seconds. */
const SPARK_SECONDS = 0.8;

const shader = frameWgsl + commonWgsl + /* wgsl */ `
struct P { pos: vec3f, kind: f32, size: vec2f, seed: f32, fade: f32, color: vec3f, strength: f32 };
@group(1) @binding(0) var<storage, read> parts: array<P>;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) kind: u32,
  @location(2) seed: f32,
  @location(3) fade: f32,
  @location(4) color: vec3f,
  @location(5) world: vec3f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  let p = parts[ii];
  let corners = array<vec2f, 6>(vec2f(-0.5, 0.0), vec2f(0.5, 0.0), vec2f(0.5, 1.0),
    vec2f(-0.5, 0.0), vec2f(0.5, 1.0), vec2f(-0.5, 1.0));
  let c = corners[vi];
  let toCam = frame.cameraPos.xyz - p.pos;
  var world: vec3f;
  if (p.kind < 0.5) {
    // Flames stand upright from their base, turned to face the camera.
    let right = normalize(vec3f(toCam.z, 0.0, -toCam.x) + vec3f(1e-5, 0.0, 0.0));
    world = p.pos + right * c.x * p.size.x + vec3f(0.0, c.y * p.size.y, 0.0);
  } else {
    let f = normalize(toCam);
    let right = normalize(cross(vec3f(0.0, 1.0, 0.0), f) + vec3f(1e-5, 0.0, 0.0));
    let up = cross(f, right);
    world = p.pos + right * c.x * p.size.x + up * (c.y - 0.5) * p.size.y;
  }
  var out: Out;
  out.pos = frame.viewProj * vec4f(world, 1.0);
  out.uv = c;
  out.kind = u32(p.kind + 0.5);
  out.seed = p.seed;
  out.fade = p.fade;
  out.color = p.color * p.strength;
  out.world = world;
  return out;
}

/** Fog thins far particles away (they add light, so they fade to nothing rather than to sky). */
fn farFade(world: vec3f) -> f32 {
  let d = max(length(world - frame.cameraPos.xyz) - 90.0, 0.0);
  return exp(-d * frame.skyHorizon.w);
}

fn flame(uv: vec2f, seed: f32) -> vec4f {
  let t = frame.cameraPos.w;
  let n1 = valueNoise(vec2f(uv.x * 4.0 + seed * 13.0, uv.y * 3.0 - t * 4.5));
  let n2 = valueNoise(vec2f(uv.x * 9.0 - seed * 7.0, uv.y * 6.0 - t * 7.5));
  let x = abs(uv.x + (n1 - 0.5) * 0.3 * uv.y);
  let width = 0.46 * pow(max(1.0 - uv.y, 0.0), 0.7) * (0.55 + 0.45 * smoothstep(0.0, 0.2, uv.y));
  let d = x / max(width, 1e-3);
  let top = uv.y + (n2 - 0.5) * 0.35;
  let body = (1.0 - smoothstep(0.5, 1.0, d)) * (1.0 - smoothstep(0.55, 0.95, top));
  let core = (1.0 - smoothstep(0.0, 0.55, d)) * (1.0 - smoothstep(0.05, 0.5, top));
  let col = mix(vec3f(0.9, 0.16, 0.02), vec3f(1.0, 0.55, 0.12), body) + vec3f(1.0, 0.85, 0.5) * core;
  return vec4f(col * body, body);
}

@fragment fn fsGlow(in: Out) -> @location(0) vec4f {
  var c = vec3f(0.0);
  if (in.kind == 0u) {
    c = flame(in.uv, in.seed).rgb * in.color;
  } else {
    let r = length(vec2f(in.uv.x, in.uv.y - 0.5)) * 2.0;
    let k = select(5.0, 14.0, in.kind == 2u);
    var a = exp(-r * r * k) * (1.0 - smoothstep(0.85, 1.0, r));
    // Halos are for the dark: by day a lamp's glow hardly shows.
    if (in.kind == 1u) { a *= mix(0.1, 0.6, 1.0 - frame.extra.y); }
    c = in.color * a;
  }
  return vec4f(c * in.fade * farFade(in.world) / mix(1.0, frame.skyZenith.w, 0.7), 0.0);
}

@fragment fn fsSmoke(in: Out) -> @location(0) vec4f {
  let r = length(vec2f(in.uv.x, in.uv.y - 0.5)) * 2.0;
  let n = valueNoise(in.uv * 3.0 + vec2f(in.seed * 5.0, frame.cameraPos.w * 0.3));
  let a = (1.0 - smoothstep(0.35, 1.0, r + (n - 0.5) * 0.4)) * in.fade * 0.45 * farFade(in.world);
  // Grey, lit by the sky (without its blue: smoke at night isn't blue) and the key light; its
  // color carries the fire's glow from below.
  let sky = dot(frame.skyZenith.rgb, vec3f(0.3, 0.5, 0.2)) * frame.sunColor.w;
  let lit = vec3f(sky * 1.5) + frame.sunColor.rgb * frame.sunDir.w * 0.25;
  return vec4f(in.color * lit * a, a);
}
`;

interface SparkFlight {
  from: [number, number, number];
  to: number[];
  on: boolean;
  start: number;
}

export class ParticleRenderer {
  private data = new Float32Array(MAX * FLOATS);
  private buffer: GPUBuffer;
  private bindGroup: GPUBindGroup;
  private glow: GPURenderPipeline;
  private smoke: GPURenderPipeline;
  private glowCount = 0;
  private smokeCount = 0;
  private flights: SparkFlight[] = [];
  /** Smoke goes after everything that glows, so it's staged here first. */
  private smokeData = new Float32Array(MAX / 4 * FLOATS);

  constructor(private device: GPUDevice, layouts: Layouts) {
    this.buffer = device.createBuffer({
      size: this.data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const layout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      }],
    });
    this.bindGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: this.buffer } }],
    });
    const module = device.createShaderModule({ code: shader, label: "particles" });
    const pipeline = (entryPoint: string, blend: GPUBlendState) =>
      device.createRenderPipeline({
        label: `particles-${entryPoint}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layout] }),
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint, targets: [{ format: layouts.colorFormat, blend }] },
        primitive: { topology: "triangle-list" },
        depthStencil: {
          format: layouts.depthFormat,
          depthWriteEnabled: false,
          depthCompare: "less",
        },
        multisample: { count: layouts.samples },
      });
    this.glow = pipeline("fsGlow", {
      color: { srcFactor: "one", dstFactor: "one", operation: "add" },
      alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
    });
    this.smoke = pipeline("fsSmoke", {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
    });
  }

  /** A signal ran from a sender to receivers (flat x, y, z): sparks fly along the way. */
  spark(from: [number, number, number], to: number[], on: boolean, now: number) {
    if (!to.length) return;
    this.flights.push({ from, to, on, start: now });
    if (this.flights.length > 32) this.flights.shift();
  }

  /** Gather this frame's particles from what burns and shines. `now` is in seconds. */
  update(
    objects: Objects | null,
    poses: Map<number, BodyPose>,
    fires: Float32Array,
    now: number,
  ) {
    let n = 0, s = 0;
    const d = this.data, sd = this.smokeData;
    const put = (
      x: number,
      y: number,
      z: number,
      kind: number,
      w: number,
      h: number,
      seed: number,
      fade: number,
      r: number,
      g: number,
      b: number,
      strength: number,
    ) => {
      const smoke = kind === Kind.Smoke;
      if (smoke ? s >= MAX / 4 : n >= MAX - MAX / 4) return;
      const a = smoke ? sd : d, o = (smoke ? s++ : n++) * FLOATS;
      a[o] = x, a[o + 1] = y, a[o + 2] = z, a[o + 3] = kind, a[o + 4] = w, a[o + 5] = h;
      a[o + 6] = seed, a[o + 7] = fade, a[o + 8] = r, a[o + 9] = g, a[o + 10] = b;
      a[o + 11] = strength;
    };
    // Tame flames and lit lamps on Objects, where their pieces are this frame.
    for (const o of objects?.list ?? []) {
      const e = objects!.catalog.get(o.design);
      if (e?.kind !== "design") continue;
      const des = e.content as DesignContent;
      if (!des.parts.some((p) => deviceKind(p.part) === "flame" || deviceKind(p.part) === "lamp")) {
        continue;
      }
      const root = poses.get(o.id * 16);
      if (!root) continue;
      const pieces = o.pieces?.map((p, k) => {
        const at = poses.get(o.id * 16 + k + 1);
        return at ? { ...p, pos: at.pos, rot: at.rot } : p;
      });
      const boxes = poseBoxes(des, root.pos, root.rot, pieces);
      des.parts.forEach((p, i) => {
        const kind = deviceKind(p.part);
        if ((kind !== "flame" && kind !== "lamp") || !deviceLit(o, i)) return;
        const b = boxes[i];
        const cx = (b[0] + b[1]) / 2,
          cz = (b[4] + b[5]) / 2,
          w = Math.max(b[1] - b[0], b[5] - b[4]);
        const seed = hash2(o.id, i, 5);
        if (kind === "flame") {
          const h = b[3] - b[2];
          put(cx, b[2], cz, Kind.Flame, w * 1.5, h * 1.6, seed, 1, 1, 1, 1, 3);
          put(cx, b[2] + h * 0.6, cz, Kind.Halo, 1.2 + w, 1.2 + w, seed, 1, 1, 0.45, 0.12, 0.5);
          if (w > 0.3) {
            for (let k = 0; k < 2; k++) {
              const ph = (now * 0.3 + seed + k / 2) % 1;
              put(
                cx,
                b[3] + 0.2 + ph * 2.5,
                cz,
                Kind.Smoke,
                0.5 + ph,
                0.5 + ph,
                seed + k,
                Math.min(1, ph * 5) * (1 - ph) * 0.5,
                0.45,
                0.44,
                0.43,
                1,
              );
            }
          }
        } else {
          const m = objects!.catalog.byName(p.material)?.content as MaterialContent | undefined;
          const c = parseInt((m?.color ?? "#ffffff").slice(1), 16);
          const lin = (v: number) => Math.pow(v / 255, 2.2);
          put(
            cx,
            (b[2] + b[3]) / 2,
            cz,
            Kind.Halo,
            0.9 + w * 1.5,
            0.9 + w * 1.5,
            seed,
            1,
            lin(c >> 16),
            lin((c >> 8) & 255),
            lin(c & 255),
            0.7,
          );
        }
      });
    }
    // Wild fire: flames over what burns, smoke rising from it.
    for (let i = 0; i < fires.length; i += FIRE_STRIDE) {
      const [x0, x1, y0, y1, z0, z1, kind, seed0] = fires.subarray(i, i + FIRE_STRIDE);
      const w = x1 - x0, h = y1 - y0, dz = z1 - z0;
      const count = kind === 1 ? 4 : kind === 3 ? Math.min(5, 1 + Math.round(w * dz)) : 2;
      for (let k = 0; k < count; k++) {
        const u = hash2(seed0, k, 11), v = hash2(seed0, k, 12), q = hash2(seed0, k, 13);
        // Blocks burn on top; trees all the way up; Objects and crops over their bodies.
        const base = kind === 0 ? y1 - 0.15 : y0 + h * (kind === 1 ? 0.15 + 0.75 * q : 0.3 * q);
        const size = kind === 1 ? 1.4 : kind === 2 ? 0.8 : 1;
        put(
          x0 + w * (0.2 + 0.6 * u),
          base,
          z0 + dz * (0.2 + 0.6 * v),
          Kind.Flame,
          size * 0.9,
          size * (1 + 0.4 * q),
          seed0 + k,
          1,
          1,
          1,
          1,
          3.2,
        );
      }
      put((x0 + x1) / 2, y0 + h * 0.6, (z0 + z1) / 2, Kind.Halo, 3, 3, seed0, 1, 1, 0.4, 0.1, 0.6);
      for (let k = 0; k < 3; k++) {
        const ph = (now * 0.25 + hash2(seed0, k, 14) + k / 3) % 1;
        put(
          (x0 + x1) / 2 + (hash2(seed0, k, 15) - 0.5) * w,
          y1 + 0.3 + ph * 4,
          (z0 + z1) / 2 + (hash2(seed0, k, 16) - 0.5) * dz,
          Kind.Smoke,
          0.9 + ph * 1.6,
          0.9 + ph * 1.6,
          seed0 + k,
          Math.min(1, ph * 6) * (1 - ph),
          0.35,
          0.33,
          0.32,
          1,
        );
      }
    }
    // Signal sparks: a little train of light along each link, arcing over.
    this.flights = this.flights.filter((f) => now - f.start < SPARK_SECONDS + 0.6);
    for (const f of this.flights) {
      const age = now - f.start;
      const [r, g, b] = f.on ? [1, 0.85, 0.4] : [0.45, 0.6, 1];
      for (let j = 0; j < f.to.length; j += 3) {
        const tx = f.to[j], ty = f.to[j + 1], tz = f.to[j + 2];
        const dist = Math.hypot(tx - f.from[0], tz - f.from[2]);
        for (let k = 0; k < 4; k++) {
          const t = age / SPARK_SECONDS - k * 0.07;
          if (t < 0 || t > 1.4) continue;
          const tt = Math.min(1, t), fade = t > 1 ? 1 - (t - 1) / 0.4 : 1 - k * 0.2;
          const lift = Math.sin(Math.PI * tt) * (0.4 + dist * 0.12);
          put(
            f.from[0] + (tx - f.from[0]) * tt,
            f.from[1] + (ty - f.from[1]) * tt + lift,
            f.from[2] + (tz - f.from[2]) * tt,
            Kind.Spark,
            0.35,
            0.35,
            k,
            fade,
            r,
            g,
            b,
            4,
          );
        }
      }
    }
    this.glowCount = n;
    this.smokeCount = s;
    if (s) d.set(sd.subarray(0, s * FLOATS), n * FLOATS);
    if (n + s) this.device.queue.writeBuffer(this.buffer, 0, d, 0, (n + s) * FLOATS);
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.glowCount && !this.smokeCount) return;
    pass.setBindGroup(1, this.bindGroup);
    if (this.smokeCount) {
      pass.setPipeline(this.smoke);
      pass.draw(6, this.smokeCount, 0, this.glowCount);
    }
    if (this.glowCount) {
      pass.setPipeline(this.glow);
      pass.draw(6, this.glowCount, 0, 0);
    }
  }
}
