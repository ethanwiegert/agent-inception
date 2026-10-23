import { frameWgsl } from "./frame.ts";
import type { Layouts } from "./renderer.ts";

const shader = frameWgsl + /* wgsl */ `
struct Out { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return Out(vec4f(p, 1.0, 1.0), p);
}

fn hash3(p: vec3f) -> f32 {
  return fract(sin(dot(p, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  let near = frame.invViewProj * vec4f(in.ndc, 0.0, 1.0);
  let far = frame.invViewProj * vec4f(in.ndc, 1.0, 1.0);
  let dir = normalize(far.xyz / far.w - near.xyz / near.w);

  let up = clamp(dir.y, -1.0, 1.0);
  var color = mix(frame.skyHorizon.rgb, frame.skyZenith.rgb, pow(max(up, 0.0), 0.6));
  color = mix(color, frame.skyHorizon.rgb * 0.6, smoothstep(0.0, -0.3, up));

  let sun = max(dot(dir, frame.sunDir.xyz), 0.0);
  color += frame.sunColor.rgb * frame.sunDir.w * (pow(sun, 800.0) * 4.0 + pow(sun, 12.0) * 0.08);

  let cell = floor(dir * 180.0);
  let star = step(0.997, hash3(cell)) * frame.extra.x * smoothstep(0.0, 0.2, up);
  color += vec3f(star);
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

  /** Draw last: depth test against the far plane only fills uncovered pixels. */
  draw(pass: GPURenderPassEncoder, frameBindGroup: GPUBindGroup) {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, frameBindGroup);
    pass.draw(3);
  }
}
