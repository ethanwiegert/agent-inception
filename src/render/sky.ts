import { commonWgsl, frameWgsl } from "./frame.ts";
import type { Layouts } from "./renderer.ts";

const shader = frameWgsl + commonWgsl + /* wgsl */ `
struct Out { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return Out(vec4f(p, 1.0, 1.0), p);
}

fn hash3(p: vec3f) -> f32 {
  return fract(sin(dot(p, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
}

/**
 * Stars: one candidate per cell of a grid on the sky, kept with chance 1 - rarity, drawn as a
 * round twinkling point of radius size (in cells) at a jittered spot in its cell.
 */
fn stars(dir: vec3f, scale: f32, rarity: f32, size: f32) -> vec3f {
  let g = dir * scale;
  let cell = floor(g);
  let spot = cell + 0.5 + (vec3f(hash3(cell + 1.0), hash3(cell + 2.0), hash3(cell + 3.0)) - 0.5) * 0.6;
  let point = smoothstep(size, 0.0, length(g - spot)) * step(rarity, hash3(cell));
  let twinkle = 0.6 + 0.4 * sin(frame.cameraPos.w * (2.0 + hash3(cell + 4.0) * 4.0) + hash3(cell) * 30.0);
  let tint = mix(vec3f(1.0, 0.82, 0.62), vec3f(0.72, 0.85, 1.0), hash3(cell + 6.0));
  return tint * point * twinkle;
}

/** A disc of angular radius r around direction d, with a soft edge. Returns coverage and the sphere normal. */
fn disc(dir: vec3f, d: vec3f, r: f32) -> vec4f {
  let side = normalize(cross(d, vec3f(0.0, 1.0, 0.001)));
  let up = cross(side, d);
  let q = vec2f(dot(dir, side), dot(dir, up)) / r;
  let cover = smoothstep(1.0, 0.92, length(q)) * step(0.0, dot(dir, d));
  let z = sqrt(max(1.0 - dot(q, q), 0.0));
  return vec4f(cover, side * q.x + up * q.y - d * z);
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  let near = frame.invViewProj * vec4f(in.ndc, 0.0, 1.0);
  let far = frame.invViewProj * vec4f(in.ndc, 1.0, 1.0);
  let dir = normalize(far.xyz / far.w - near.xyz / near.w);
  var color = skyColor(dir);
  let above = smoothstep(-0.02, 0.03, dir.y);

  // Only once the sky is dark: fields of faint stars in a few magnitudes (more of them, dimmer
  // near the moon and the horizon), and the Milky Way as a faint mottled band, strongest on
  // moonless nights.
  if (frame.extra.x > 0.0 && dir.y > -0.02) {
    var night = stars(dir, 160.0, 0.993, 0.16) * (0.5 + 1.5 * hash3(floor(dir * 160.0) + 5.0));
    night += stars(dir, 96.0, 0.985, 0.12) * 1.2;
    night += stars(dir, 64.0, 0.988, 0.11) * 3.0;
    let off = dot(dir, vec3f(0.42, 0.48, -0.77)) * 3.6;
    let band = exp(-off * off);
    night += vec3f(0.5, 0.6, 0.95) * band * (0.2 + 0.8 * fbm(dir.xz * 7.0 + dir.y * 4.0)) * 0.045;
    night *= mix(1.5, 0.6, frame.moonDir.w);
    night *= 1.0 - 0.45 * max(dot(dir, frame.moonDir.xyz), 0.0);
    // A rare shooting star: one hashed streak every few seconds, gone in a blink.
    let epoch = floor(frame.cameraPos.w * 0.9);
    if (hash21(vec2f(epoch, 3.7)) > 0.985) {
      let when = fract(frame.cameraPos.w * 0.9);
      let ca = hash3(vec3f(epoch, 1.0, 0.0)) * 6.2832;
      let tail = vec3f(cos(ca), 0.35 + hash3(vec3f(epoch, 2.0, 0.0)) * 0.3, sin(ca)) * 0.06;
      let head = normalize(vec3f(hash3(vec3f(epoch, 3.0, 0.0)) - 0.5, 0.55, hash3(vec3f(epoch, 4.0, 0.0)) - 0.5));
      let rel = dir - head;
      let along = clamp(dot(rel, tail) / dot(tail, tail), 0.0, 1.0);
      let offS = length(rel - tail * along);
      night += vec3f(1.0, 0.95, 0.85) * smoothstep(0.004, 0.0, offS) * (1.0 - along) *
        sin(min(when / 0.07, 1.0) * 3.1416) * 8.0;
    }
    color += night * frame.extra.x * above * smoothstep(0.0, 0.28, dir.y);
  }

  // The sun: a bright disc that the horizon haze reddens and squashes, darker at its limbs.
  let squash = mix(1.0, 0.72, exp(-max(dir.y, 0.0) * 7.0));
  let sunDir = normalize(vec3f(dir.x, dir.y / squash, dir.z));
  let sun = disc(sunDir, frame.sunPos.xyz, 0.02);
  let sunTint = mix(vec3f(1.0, 0.38, 0.15), vec3f(1.0, 0.95, 0.85), clamp(frame.sunPos.y * 3.5, 0.0, 1.0));
  let limb = 0.55 + 0.45 * smoothstep(0.0, 0.4, sun.x);
  color += sunTint * sun.x * limb * 18.0 * frame.sunPos.w * above;
  // A soft corona, so the disc sits in its own light rather than being cut out of the sky.
  let corona = pow(max(dot(dir, frame.sunPos.xyz), 0.0), 1500.0);
  color += sunTint * corona * 1.6 * frame.sunPos.w * above / frame.skyZenith.w;

  // The moon: lit from the sun's side so its phase follows the sun-moon angle, with soft maria.
  let moon = disc(dir, frame.moonDir.xyz, 0.0125);
  if (moon.x > 0.0) {
    let lit = smoothstep(-0.05, 0.15, dot(moon.yzw, frame.sunPos.xyz));
    let maria = 0.75 + 0.25 * valueNoise(moon.yz * 9.0 + moon.w * 5.0);
    let face = vec3f(0.85, 0.87, 0.92) * maria * (0.06 + 2.2 * lit);
    color = mix(color, face * (0.4 + 0.6 * frame.moonDir.w), moon.x * above);
  }
  // A soft halo through thin cloud, widening with cover.
  let haloDot = max(dot(dir, frame.moonDir.xyz), 0.0);
  color += vec3f(0.55, 0.65, 1.0) * frame.moonDir.w * pow(haloDot, 40.0) *
    (0.1 + 0.5 * frame.weather.x) * above;

  // A drifting cloud layer, the same one that casts shadows on the ground.
  if (dir.y > 0.01) {
    // Overhead this is the flat layer whose shadows fall on the ground; toward the horizon it
    // curves down like a dome, so far clouds stay heaps instead of thinning into streaks.
    let t = (CLOUD_HEIGHT - frame.cameraPos.y) / (dir.y + 0.22 * (1.0 - dir.y) * (1.0 - dir.y));
    let p = frame.cameraPos.xz + dir.xz * t;
    let shape = cloudShape(p);
    let d = shape.x;
    if (d > 0.002) {
      // How much cloud the key light crosses to get here: the side toward the light is bright,
      // the far side and the thick cores are shaded, so clouds have form.
      let toward = frame.sunDir.xz / max(length(frame.sunDir.xz), 0.2);
      let through = exp(-cloudShape(p + toward * 34.0).x * 1.7);
      let sunSide = max(dot(dir, frame.sunPos.xyz), 0.0);
      // (Moonlit clouds stay dim, or they'd outshine the stars.)
      let lit = frame.sunColor.rgb * frame.sunDir.w * mix(0.5, 1.0, frame.extra.y);
      let sky = frame.skyZenith.rgb * 1.1 + frame.skyHorizon.rgb * 0.45;
      let ambient = mix(sky, vec3f(dot(sky, vec3f(0.33))), 0.6) * 0.62;
      let thick = smoothstep(0.35, 1.0, d);
      var cloud = ambient * mix(1.0, 0.8, thick) + lit * mix(0.07, 0.48, through) * mix(1.0, 0.8, thick) * (0.72 + 0.56 * shape.y);
      // Thin edges toward the sun catch a silver lining.
      cloud += lit * pow(sunSide, 6.0) * (1.0 - thick) * 0.8;
      // Far clouds sink into the haze instead of streaking to the horizon.
      cloud = mix(color, cloud, exp(-t * 0.0007));
      color = mix(color, cloud, smoothstep(0.0, 0.55, d) * smoothstep(0.01, 0.1, dir.y) * 0.96);
    }
  }
  return vec4f(color, 1.0);
}
`;

export class SkyRenderer {
  private pipeline: GPURenderPipeline;

  constructor(device: GPUDevice, layouts: Layouts) {
    const module = device.createShaderModule({ code: shader, label: "sky" });
    this.pipeline = device.createRenderPipeline({
      label: "sky",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.shadowFrame] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: layouts.colorFormat }] },
      depthStencil: {
        format: layouts.depthFormat,
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
      multisample: { count: layouts.samples },
    });
  }

  /** Draw after opaque geometry: depth test against the far plane only fills uncovered pixels. */
  draw(pass: GPURenderPassEncoder, frameBindGroup: GPUBindGroup) {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, frameBindGroup);
    pass.draw(3);
  }
}
