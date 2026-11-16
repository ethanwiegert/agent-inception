import { frameWgsl } from "./frame.ts";
import type { Layouts } from "./renderer.ts";

/** Bloom levels, each half the size of the one before; the first is a quarter of the scene. */
const BLOOM_LEVELS = 4;

/**
 * Bloom: what is brighter than white (the sun, glints on water, lamps, fire) spills a soft glow
 * around itself. The scene is cut down to a quarter of its size keeping only that light, halved
 * a few more times, then added back up level by level, so the whole chain shades about a sixth of
 * a screen's pixels with four taps each.
 */
const bloomShader = frameWgsl + /* wgsl */ `
@group(1) @binding(0) var src: texture_2d<f32>;
@group(1) @binding(1) var smp: sampler;

/** Exposed brightness where the glow starts, and the width of the soft knee below it. */
const THRESHOLD = 1.8;
const KNEE = 0.9;

struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return Out(vec4f(p * 2.0 - 1.0, 0.0, 1.0), vec2f(p.x, 1.0 - p.y));
}

/** The part of a pixel above the threshold, eased in over the knee so nothing pops. */
fn bright(color: vec3f) -> vec3f {
  let c = clamp(color, vec3f(0.0), vec3f(64.0));
  let peak = max(c.r, max(c.g, c.b)) * frame.skyZenith.w;
  let knee = clamp(peak - (THRESHOLD - KNEE), 0.0, 2.0 * KNEE);
  return c * max(knee * knee / (4.0 * KNEE), peak - THRESHOLD) / max(peak, 1e-4);
}

/** Four bilinear taps a texel out: together they average the 4×4 texels under the pixel. */
fn tap(uv: vec2f, k: i32, reach: f32) -> vec3f {
  let o = (vec2f(f32(k & 1), f32(k >> 1)) * 2.0 - 1.0) * reach;
  return textureSampleLevel(src, smp, uv + o / vec2f(textureDimensions(src)), 0.0).rgb;
}

@fragment fn fsFirst(in: Out) -> @location(0) vec4f {
  var sum = vec3f(0.0);
  var weight = 0.0;
  for (var k = 0; k < 4; k++) {
    let c = bright(tap(in.uv, k, 1.0));
    // Weigh bright taps down, or one glinting pixel flickers the whole glow.
    let w = 1.0 / (1.0 + max(c.r, max(c.g, c.b)) * frame.skyZenith.w);
    sum += c * w;
    weight += w;
  }
  return vec4f(sum / weight, 1.0);
}

@fragment fn fsDown(in: Out) -> @location(0) vec4f {
  return vec4f((tap(in.uv, 0, 1.0) + tap(in.uv, 1, 1.0) + tap(in.uv, 2, 1.0) + tap(in.uv, 3, 1.0)) * 0.25, 1.0);
}

/** A smaller level, smoothed, added onto the one above it (the pipeline blends one + one). */
@fragment fn fsUp(in: Out) -> @location(0) vec4f {
  return vec4f((tap(in.uv, 0, 0.5) + tap(in.uv, 1, 0.5) + tap(in.uv, 2, 0.5) + tap(in.uv, 3, 0.5)) * 0.25, 1.0);
}
`;

/**
 * HDR resolve → bloom, exposure, tonemap, grading, vignette, sRGB, light sharpening, dither.
 * The tonemap is Khronos PBR Neutral: it compresses highlights without shifting hues, so a
 * Material's authored color reads as that color on screen, skies stay blue rather than going
 * grey-white, and sunsets keep their color. It has no filmic midtone lift, hence the gain.
 */
const shader = frameWgsl + /* wgsl */ `
@group(1) @binding(0) var scene: texture_2d<f32>;
@group(1) @binding(1) var bloom: texture_2d<f32>;
@group(1) @binding(2) var bloomSampler: sampler;

/** Midtone gain ahead of the tonemap (brightness parity with a filmic curve). */
const GAIN = 1.6;
/** Contrast-adaptive sharpening strength, 0 (off) to 1. */
const SHARPEN = 0.35;

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

/** One scene pixel plus its glow, exposed, tonemapped, graded and in sRGB (before the vignette). */
fn display(p: vec2i, glow: vec3f) -> vec3f {
  let size = vec2i(textureDimensions(scene));
  let raw = (textureLoad(scene, clamp(p, vec2i(0), size - 1), 0).rgb + glow) * frame.skyZenith.w;
  var c = toSrgb(neutral(raw * GAIN));
  let g = frame.grade;
  // Moonlit grading (washed-out colors, a blue cast) is for things lit only by the moon; what a
  // lamp or a fire lights is bright enough to keep its color, as eyes see it.
  let lit = max(frame.extra.y, smoothstep(0.12, 0.55, max(raw.r, max(raw.g, raw.b))));
  let day = 1.0 - 0.55 * (1.0 - frame.extra.y);
  let saturation = mix(g.x, g.x / day, lit * 0.7);
  let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = mix(vec3f(luma), c, saturation);
  c = (c - 0.5) * g.y + 0.5;
  c += vec3f(g.z, g.z * 0.3, -g.z) * 0.06;
  return c * mix(vec3f(0.6, 0.78, 1.3), vec3f(1.0), lit); // moonlight
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(scene));
  let p = vec2i(pos.xy);
  // The glow is smooth: one sample serves the pixel and the neighbours the sharpening reads.
  let glow = textureSampleLevel(bloom, bloomSampler, pos.xy / size, 0.0).rgb *
    (frame.weather.w / ${BLOOM_LEVELS}.0);
  var c = display(p, glow);
  if (SHARPEN > 0.0) {
    // Lift each pixel away from its neighbours in proportion to how much local contrast
    // headroom it has, so edges crisp up without halos and flat areas stay smooth.
    let n = display(p + vec2i(0, -1), glow);
    let s = display(p + vec2i(0, 1), glow);
    let e = display(p + vec2i(1, 0), glow);
    let w = display(p + vec2i(-1, 0), glow);
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

/** A scene's bloom levels, largest first; the first ends up holding the whole glow. */
export interface Bloom {
  textures: GPUTexture[];
  views: GPUTextureView[];
  /** Reads the resolved scene, for the first level. */
  scene: GPUBindGroup;
  /** Reads each level, for the one below or above it. */
  levels: GPUBindGroup[];
}

export class PostRenderer {
  /** One pipeline per output format: the canvas's, and rgba8unorm for captures. */
  private pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  private layout: GPUBindGroupLayout;
  private module: GPUShaderModule;
  private pipelineLayout: GPUPipelineLayout;
  private sampler: GPUSampler;
  private bloomLayout: GPUBindGroupLayout;
  private bloomFirst: GPURenderPipeline;
  private bloomDown: GPURenderPipeline;
  private bloomUp: GPURenderPipeline;

  constructor(private device: GPUDevice, private layouts: Layouts) {
    const FRAGMENT = GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        { binding: 1, visibility: FRAGMENT, texture: {} },
        { binding: 2, visibility: FRAGMENT, sampler: {} },
      ],
    });
    this.module = device.createShaderModule({ code: shader, label: "post" });
    this.pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [layouts.shadowFrame, this.layout],
    });

    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.bloomLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: FRAGMENT, texture: {} },
        { binding: 1, visibility: FRAGMENT, sampler: {} },
      ],
    });
    const module = device.createShaderModule({ code: bloomShader, label: "bloom" });
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [layouts.shadowFrame, this.bloomLayout],
    });
    const pipeline = (entryPoint: string, blend?: GPUBlendState) =>
      device.createRenderPipeline({
        label: `bloom-${entryPoint}`,
        layout,
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint, targets: [{ format: layouts.colorFormat, blend }] },
      });
    this.bloomFirst = pipeline("fsFirst");
    this.bloomDown = pipeline("fsDown");
    const add: GPUBlendComponent = { srcFactor: "one", dstFactor: "one" };
    this.bloomUp = pipeline("fsUp", { color: add, alpha: add });
  }

  /** The bloom levels for a scene of this size, and the bind groups the passes read them by. */
  bloomFor(scene: GPUTextureView, width: number, height: number): Bloom {
    const { device } = this;
    const textures: GPUTexture[] = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      textures.push(device.createTexture({
        label: `bloom-${i}`,
        size: [Math.max(1, width >> (i + 2)), Math.max(1, height >> (i + 2))],
        format: this.layouts.colorFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }));
    }
    const views = textures.map((t) => t.createView());
    const read = (view: GPUTextureView) =>
      device.createBindGroup({
        layout: this.bloomLayout,
        entries: [{ binding: 0, resource: view }, { binding: 1, resource: this.sampler }],
      });
    return { textures, views, scene: read(scene), levels: views.map(read) };
  }

  /** Fill `bloom` from the resolved scene: down the levels, then back up into the first. */
  drawBloom(encoder: GPUCommandEncoder, frameBindGroup: GPUBindGroup, bloom: Bloom) {
    const draw = (
      pipeline: GPURenderPipeline,
      from: GPUBindGroup,
      to: GPUTextureView,
      loadOp: GPULoadOp,
    ) => {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: to, loadOp, storeOp: "store" }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, frameBindGroup);
      pass.setBindGroup(1, from);
      pass.draw(3);
      pass.end();
    };
    draw(this.bloomFirst, bloom.scene, bloom.views[0], "clear");
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      draw(this.bloomDown, bloom.levels[i - 1], bloom.views[i], "clear");
    }
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
      draw(this.bloomUp, bloom.levels[i], bloom.views[i - 1], "load");
    }
  }

  /** A bind group that reads `view` as the HDR scene and `bloom` as the glow to add to it. */
  bindInput(view: GPUTextureView, bloom: Bloom): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: view },
        { binding: 1, resource: bloom.views[0] },
        { binding: 2, resource: this.sampler },
      ],
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
