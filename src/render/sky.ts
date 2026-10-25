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

  // Stars, twinkling, only once the sky is dark.
  // Stars: one candidate per cell, drawn as a tiny round point at a jittered spot in it.
  let g = dir * 160.0;
  let cell = floor(g);
  let spot = cell + 0.5 + (vec3f(hash3(cell + 1.0), hash3(cell + 2.0), hash3(cell + 3.0)) - 0.5) * 0.6;
  let point = smoothstep(0.16, 0.0, length(g - spot));
  let twinkle = 0.6 + 0.4 * sin(frame.cameraPos.w * (2.0 + hash3(cell + 4.0) * 4.0) + hash3(cell) * 30.0);
  let bright = step(0.993, hash3(cell)) * (0.5 + 1.5 * hash3(cell + 5.0));
  color += vec3f(0.9, 0.95, 1.0) * point * bright * twinkle * frame.extra.x * above;

  // The sun: a bright disc that the horizon haze reddens.
  let sun = disc(dir, frame.sunPos.xyz, 0.02);
  let sunTint = mix(vec3f(1.0, 0.45, 0.2), vec3f(1.0, 0.95, 0.85), clamp(frame.sunPos.y * 4.0, 0.0, 1.0));
  color += sunTint * sun.x * 18.0 * frame.sunPos.w * above;

  // The moon: lit from the sun's side so its phase follows the sun-moon angle, with soft maria.
  let moon = disc(dir, frame.moonDir.xyz, 0.016);
  if (moon.x > 0.0) {
    let lit = smoothstep(-0.05, 0.15, dot(moon.yzw, frame.sunPos.xyz));
    let maria = 0.75 + 0.25 * valueNoise(moon.yz * 9.0 + moon.w * 5.0);
    let face = vec3f(0.85, 0.87, 0.92) * maria * (0.06 + 2.2 * lit);
    color = mix(color, face * (0.4 + 0.6 * frame.moonDir.w), moon.x * above);
  }

  // A drifting cloud layer, the same one that casts shadows on the ground.
  if (dir.y > 0.01) {
    let t = (CLOUD_HEIGHT - frame.cameraPos.y) / dir.y;
    let p = frame.cameraPos.xz + dir.xz * t;
    let d = cloudDensity(p);
    let sunSide = max(dot(dir, frame.sunPos.xyz), 0.0);
    let cloud = (frame.skyHorizon.rgb * 0.6 + frame.sunColor.rgb * frame.sunDir.w * (0.35 + 0.5 * pow(sunSide, 4.0))) * mix(1.0, 0.7, d);
    color = mix(color, cloud, d * smoothstep(0.01, 0.15, dir.y) * 0.9);
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
