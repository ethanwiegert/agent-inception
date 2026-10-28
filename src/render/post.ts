import { frameWgsl } from "./frame.ts";
import type { Layouts } from "./renderer.ts";

/**
 * HDR resolve → exposure, tonemap, grading, vignette, sRGB, light sharpening, dither.
 * The tonemap is Khronos PBR Neutral: it compresses highlights without shifting hues, so a
 * Material's authored color reads as that color on screen, skies stay blue rather than going
 * grey-white, and sunsets keep their color. It has no filmic midtone lift, hence the gain.
 */
const shader = frameWgsl + /* wgsl */ `
@group(1) @binding(0) var scene: texture_2d<f32>;

/** Midtone gain ahead of the tonemap (brightness parity with a filmic curve). */
const GAIN = 1.6;
/** Contrast-adaptive sharpening strength, 0 (off) to 1. */
const SHARPEN = 0.5;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return vec4f(p, 0.0, 1.0);
}

fn neutral(color: vec3f) -> vec3f {
  let start = 0.76;
  let desaturation = 0.15;
  let x = min(color.r, min(color.g, color.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  var c = color - offset;
  let peak = max(c.r, max(c.g, c.b));
  if (peak < start) { return c; }
  let d = 1.0 - start;
  let top = 1.0 - d * d / (peak + d - start);
  c *= top / peak;
  let g = 1.0 - 1.0 / (desaturation * (peak - top) + 1.0);
  return mix(c, vec3f(top), g);
}

fn toSrgb(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

/** One scene pixel, exposed, tonemapped, graded and in sRGB (before the vignette). */
fn display(p: vec2i) -> vec3f {
  let size = vec2i(textureDimensions(scene));
  let raw = textureLoad(scene, clamp(p, vec2i(0), size - 1), 0).rgb * frame.skyZenith.w;
  var c = toSrgb(neutral(raw * GAIN));
  let g = frame.grade;
  let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = mix(vec3f(luma), c, g.x);
  c = (c - 0.5) * g.y + 0.5;
  c += vec3f(g.z, g.z * 0.3, -g.z) * 0.06;
  return c * mix(vec3f(0.6, 0.78, 1.3), vec3f(1.0), frame.extra.y); // moonlight
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(scene));
  let p = vec2i(pos.xy);
  var c = display(p);
  if (SHARPEN > 0.0) {
    // Lift each pixel away from its neighbours in proportion to how much local contrast
    // headroom it has, so edges crisp up without halos and flat areas stay smooth.
    let n = display(p + vec2i(0, -1));
    let s = display(p + vec2i(0, 1));
    let e = display(p + vec2i(1, 0));
    let w = display(p + vec2i(-1, 0));
    let lo = min(c, min(min(n, s), min(e, w)));
    let hi = max(c, max(max(n, s), max(e, w)));
    let amp = sqrt(clamp(min(lo, 1.0 - hi) / max(hi, vec3f(1e-4)), vec3f(0.0), vec3f(1.0)));
    let k = -amp * mix(0.125, 0.2, SHARPEN);
    c = clamp((c + (n + s + e + w) * k) / (1.0 + 4.0 * k), vec3f(0.0), vec3f(1.0));
  }
  let uv = pos.xy / size - 0.5;
  c *= 1.0 - frame.grade.w * dot(uv, uv) * 1.6;

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
