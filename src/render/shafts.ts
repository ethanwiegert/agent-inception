import { frameWgsl, lightingWgsl } from "./frame.ts";
import type { Layouts } from "./renderer.ts";

/**
 * Phase 4: light in the air. A quarter-res raymarch from the eye out to the scene's linear depth
 * (capped at 180 blocks): each step deposits `shadow × cloudLight × phase` sun- or moonlight, plus
 * isotropic lamplight when anything casts it, weighed by a thin haze and the low mist. The output
 * is additive in-scattered light only — `fog()` in the forward shaders stays the extinction term —
 * and it's upsampled depth-aware straight into the resolved scene ahead of bloom, so strong
 * shafts bloom slightly.
 */

/** Haze aloft: barely-there everywhere, so noon only gains a little valley depth. */
const HAZE = 0.0016;
/** How fast the low mist (frame.grassBase.w) thins with height above the sea. */
const MIST_FALL = 0.16;
/** March the ray no farther than this (blocks) — shafts past it live in the fog anyway. */
const MAX_DIST = 180.0;
/** Henyey-Greenstein asymmetry: 0.7 throws the light visibly toward the sun. */
const G = 0.7;

const shader = (steps: number) =>
  frameWgsl + lightingWgsl + /* wgsl */ `
@group(1) @binding(0) var halfDepthTex: texture_2d<f32>;
@group(1) @binding(1) var smp: sampler;

struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return Out(vec4f(p * 2.0 - 1.0, 0.0, 1.0), vec2f(p.x, 1.0 - p.y));
}

fn ign(px: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(px, vec2f(0.06711056, 0.00583715))));
}

/** Isotropic lamplight at a point in the air (lampLight() offsets along a surface normal). */
fn lampAt(wp: vec3f) -> vec3f {
  if (frame.extra.w <= 0.0) { return vec3f(0.0); }
  let s = textureSampleLevel(
    lightField, lightSampler, wp / vec3f(textureDimensions(lightField)), 0.0);
  let t = frame.cameraPos.w;
  let flicker = 1.0 + s.a * ((valueNoise(wp.xz * 0.9 + vec2f(t * 6.0, t * 2.3)) - 0.5) * 0.7);
  return s.rgb * s.rgb * LAMP_INTENSITY * flicker / mix(1.0, frame.skyZenith.w, 0.6);
}

fn phase(cos: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (12.56637 * pow(1.0 + g2 - 2.0 * g * cos, 1.5));
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  // pos is a quarter-res pixel; linearDepth is half res, so uv = pos * 2 / size.
  let size = vec2f(textureDimensions(halfDepthTex));
  let uv = pos.xy * 2.0 / size;
  // Sky and open water have no opaque depth: march to the cap anyway, so haze and lamp glow
  // reach the horizon instead of cutting off at silhouettes.
  let L = min(textureSampleLevel(halfDepthTex, smp, uv, 0.0).r, ${MAX_DIST.toFixed(1)});

  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  let w = frame.invViewProj * ndc;
  let dir = normalize(w.xyz / w.w - frame.cameraPos.xyz);
  let eye = frame.cameraPos.xyz;

  // Strongest at a low sun through broken cloud; nearly absent at noon or under full cover.
  let low = 1.0 - clamp(abs(frame.sunDir.y) * 2.4, 0.0, 1.0);
  let broken = smoothstep(0.04, 0.25, frame.weather.x) *
    (1.0 - 0.75 * smoothstep(0.55, 0.9, frame.weather.x));
  let strength = low * broken;

  let sunCos = dot(dir, frame.sunDir.xyz);
  let sunPhase = phase(sunCos, ${G.toFixed(2)}) * frame.sunDir.w;
  let moonPhase = phase(dot(dir, frame.moonDir.xyz), 0.4) * frame.moonDir.w * 0.5;
  let sea = frame.extra.z;
  let mist = frame.grassBase.w * 0.05;

  let maxT = min(L, ${MAX_DIST.toFixed(1)});
  let dt = maxT / ${steps}.0;
  var t = dt * ign(pos.xy);
  var trans = 1.0;
  var sum = vec3f(0.0);
  for (var i = 0; i < ${steps}; i++) {
    let wp = eye + dir * t;
    let d = ${HAZE.toFixed(4)} + mist * exp(-max(wp.y - sea, 0.0) * ${MIST_FALL.toFixed(2)});
    var light = (frame.sunColor.rgb * sunPhase + vec3f(0.55, 0.65, 1.0) * moonPhase) *
      shadowFast(wp) * cloudLight(wp);
    light += lampAt(wp);
    sum += trans * light * d * dt;
    trans *= exp(-d * dt);
    t += dt;
  }
  // The alpha channel rides the upsample: it carries the ray's length for the depth-aware taps.
  // The gain lifts the thin haze's scatter into view without touching the ambient light.
  return vec4f(sum * (0.15 + 0.85 * strength) * 4.5, L);
}
`;

/** Depth-aware 4-tap upsample: quarter-res shafts onto the full-res resolve, additively. */
const upShader = frameWgsl + /* wgsl */ `
@group(1) @binding(0) var halfDepthTex: texture_2d<f32>;
@group(1) @binding(1) var shafts: texture_2d<f32>;
@group(1) @binding(2) var smp: sampler;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let hs = vec2f(textureDimensions(halfDepthTex));
  let L = textureSampleLevel(halfDepthTex, smp, pos.xy * 0.5 / hs, 0.0).r;
  let size = vec2f(textureDimensions(shafts));
  let q = pos.xy * size / (hs * 2.0) - 0.5;
  let base = floor(q);
  var sum = vec3f(0.0);
  var wsum = 0.0;
  for (var y = 0; y < 2; y++) {
    for (var x = 0; x < 2; x++) {
      let c = clamp(base + vec2f(f32(x), f32(y)), vec2f(0.0), size - 1.0);
      let s = textureLoad(shafts, vec2i(c), 0);
      let b = (1.0 - abs(q.x - c.x)) * (1.0 - abs(q.y - c.y));
      // Depth awareness: a tap whose ray ran shorter (a silhouette) counts less.
      let w = b * exp(-abs(L - s.a) * 0.12);
      sum += s.rgb * w;
      wsum += w;
    }
  }
  return vec4f(sum / max(wsum, 1e-4), 0.0);
}
`;

/** The quarter-res march output (`rgba` = light, `a` = ray length). */
export interface ShaftTargets {
  texture: GPUTexture;
  view: GPUTextureView;
}

export class LightShafts {
  private layout: GPUBindGroupLayout;
  private upLayout: GPUBindGroupLayout;
  private march: [GPURenderPipeline, GPURenderPipeline];
  private up: GPURenderPipeline;
  private sampler: GPUSampler;
  private group: GPUBindGroup | null = null;
  private upGroup: GPUBindGroup | null = null;

  constructor(private device: GPUDevice, private layouts: Layouts) {
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.upLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.march = [8, 16].map((steps) => {
      const module = device.createShaderModule({
        code: shader(steps),
        label: `shafts-${steps}`,
      });
      return device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [layouts.frame, this.layout],
        }),
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: "rgba16float" }] },
        primitive: { topology: "triangle-list" },
        label: `shafts-${steps}`,
      });
    }) as [GPURenderPipeline, GPURenderPipeline];
    const upModule = device.createShaderModule({ code: upShader, label: "shafts-up" });
    this.up = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [layouts.shadowFrame, this.upLayout],
      }),
      vertex: { module: upModule, entryPoint: "vs" },
      fragment: {
        module: upModule,
        entryPoint: "fs",
        targets: [{
          format: layouts.colorFormat,
          blend: {
            color: { srcFactor: "one", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      label: "shafts-up",
    });
    this.sampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
  }

  /** Quarter-res target for `draw`, matching the scene size; rebuilt when it moves. */
  allocate(width: number, height: number): ShaftTargets {
    const q = [Math.max(1, Math.ceil(width / 4)), Math.max(1, Math.ceil(height / 4))];
    const texture = this.device.createTexture({
      size: q,
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    return { texture, view: texture.createView() };
  }

  /** March the quarter-res buffer from the half-res linear depth. */
  draw(
    encoder: GPUCommandEncoder,
    targets: ShaftTargets,
    halfView: GPUTextureView,
    frameBindGroup: GPUBindGroup,
    high: boolean,
  ) {
    if (!this.group || this.lastHalf !== halfView) {
      this.lastHalf = halfView;
      this.group = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: halfView },
          { binding: 1, resource: this.sampler },
        ],
      });
    }
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: targets.view,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
      label: "shafts",
    });
    pass.setPipeline(this.march[high ? 1 : 0]);
    pass.setBindGroup(0, frameBindGroup);
    pass.setBindGroup(1, this.group);
    pass.draw(3);
    pass.end();
  }

  /** Add the shafts onto the resolved scene (before bloom), depth-aware at full res. */
  composite(
    encoder: GPUCommandEncoder,
    resolveView: GPUTextureView,
    targets: ShaftTargets,
    halfView: GPUTextureView,
    plainFrameBindGroup: GPUBindGroup,
  ) {
    if (!this.upGroup || this.upHalf !== halfView || this.upShafts !== targets.view) {
      this.upHalf = halfView;
      this.upShafts = targets.view;
      this.upGroup = this.device.createBindGroup({
        layout: this.upLayout,
        entries: [
          { binding: 0, resource: halfView },
          { binding: 1, resource: targets.view },
          { binding: 2, resource: this.sampler },
        ],
      });
    }
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: resolveView, loadOp: "load", storeOp: "store" }],
      label: "shafts-up",
    });
    pass.setPipeline(this.up);
    pass.setBindGroup(0, plainFrameBindGroup);
    pass.setBindGroup(1, this.upGroup);
    pass.draw(3);
    pass.end();
  }

  private lastHalf: GPUTextureView | null = null;
  private upHalf: GPUTextureView | null = null;
  private upShafts: GPUTextureView | null = null;
}
