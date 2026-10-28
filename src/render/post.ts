import { frameWgsl } from "./frame.ts";
import type { Layouts } from "./renderer.ts";

/** HDR resolve → exposure, ACES tonemap, grading, vignette, sRGB, dither. */
const shader = frameWgsl + /* wgsl */ `
@group(1) @binding(0) var scene: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return vec4f(p, 0.0, 1.0);
}

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn toSrgb(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(scene));
  var c = textureLoad(scene, vec2i(pos.xy), 0).rgb * frame.skyZenith.w;
  c = toSrgb(aces(c));

  let g = frame.grade;
  let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = mix(vec3f(luma), c, g.x);
  c = (c - 0.5) * g.y + 0.5;
  c += vec3f(g.z, g.z * 0.3, -g.z) * 0.06;
  c *= mix(vec3f(0.6, 0.78, 1.3), vec3f(1.0), frame.extra.y); // moonlight

  let uv = pos.xy / size - 0.5;
  c *= 1.0 - g.w * dot(uv, uv) * 1.6;

  let noise = fract(sin(dot(pos.xy, vec2f(12.9898, 78.233))) * 43758.5453);
  c += (noise - 0.5) / 255.0;
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

export class PostRenderer {
  /** One pipeline per output format: the canvas's, and rgba8unorm for captures. */
  private pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  private layout: GPUBindGroupLayout;
  private module: GPUShaderModule;
  private pipelineLayout: GPUPipelineLayout;

  constructor(private device: GPUDevice, layouts: Layouts) {
    this.layout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "unfilterable-float" },
      }],
    });
    this.module = device.createShaderModule({ code: shader, label: "post" });
    this.pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [layouts.shadowFrame, this.layout],
    });
  }

  /** A bind group that reads `view` as the HDR scene. */
  bindInput(view: GPUTextureView): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.layout,
      entries: [{ binding: 0, resource: view }],
    });
  }

  draw(
    pass: GPURenderPassEncoder,
    frameBindGroup: GPUBindGroup,
    input: GPUBindGroup,
    format: GPUTextureFormat,
  ) {
    pass.setPipeline(this.pipeline(format));
    pass.setBindGroup(0, frameBindGroup);
    pass.setBindGroup(1, input);
    pass.draw(3);
  }

  private pipeline(format: GPUTextureFormat): GPURenderPipeline {
    let p = this.pipelines.get(format);
    if (!p) {
      p = this.device.createRenderPipeline({
        label: `post-${format}`,
        layout: this.pipelineLayout,
        vertex: { module: this.module, entryPoint: "vs" },
        fragment: { module: this.module, entryPoint: "fs", targets: [{ format }] },
      });
      this.pipelines.set(format, p);
    }
    return p;
  }
}
