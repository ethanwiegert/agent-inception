import { commonWgsl, frameWgsl } from "./frame.ts";
import type { Layouts } from "./renderer.ts";

/** World-space radius the horizons march, in blocks. */
const RADIUS = 1.5;
/** tan(fovY/2): camera.ts's perspective, for the screen-space step length. */
const TAN_HALF_FOV = 0.354;

/**
 * Ground-truth ambient occlusion ("GTAO"): at half resolution each pixel reconstructs its
 * surface from the linear depth, walks a few slices of its hemisphere for the highest
 * blocker it can see, and keeps how much of the sky is left. A 4x4 depth-aware blur turns
 * the march's sparse taps into a smooth pool of shade. The post pass multiplies it in,
 * faded on bright pixels so it eats ambient, not sunlight.
 */
const shader = (slices: number, steps: number) =>
  frameWgsl + commonWgsl + /* wgsl */ `
@group(1) @binding(0) var halfDepthTex: texture_2d<f32>;
@group(1) @binding(1) var smp: sampler;

const RADIUS = ${RADIUS.toFixed(1)};

struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return Out(vec4f(p * 2.0 - 1.0, 0.0, 1.0), vec2f(p.x, 1.0 - p.y));
}

/** World position of the surface under half-res pixel px at view depth L. */
fn worldFromLinear(px: vec2f, L: f32) -> vec3f {
  // The near-plane point on this ray, marched out along it by the view depth.
  let near = frame.depthParams.x;
  let pNear = worldAt(px, 0.0);
  let cam = frame.cameraPos.xyz;
  return cam + (pNear - cam) * (L / near);
}

fn ign(px: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(px, vec2f(0.06711056, 0.00583715))));
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  let px = floor(in.pos.xy);
  let size = vec2i(textureDimensions(halfDepthTex));
  let L = textureLoad(halfDepthTex, vec2i(px), 0).r;
  if (L > 3000.0) { return vec4f(1.0); }
  let p0 = worldFromLinear(px, L);
  // Surface normal from the two right/down neighbours' reconstructed positions.
  let qx = clamp(vec2i(px) + vec2i(1, 0), vec2i(0), size - 1);
  let qy = clamp(vec2i(px) + vec2i(0, 1), vec2i(0), size - 1);
  var n = normalize(cross(
    worldFromLinear(vec2f(qx), textureLoad(halfDepthTex, qx, 0).r) - p0,
    worldFromLinear(vec2f(qy), textureLoad(halfDepthTex, qy, 0).r) - p0,
  ));
  if (dot(n, frame.cameraPos.xyz - p0) < 0.0) { n = -n; }

  // Screen-space march length: RADIUS blocks projected at this depth, spread over STEPS.
  let radiusPx = clamp(RADIUS * f32(size.y) * 0.5 / max(L, 1.0) / ${TAN_HALF_FOV}, 1.5, 18.0);
  var occ = 0.0;
  for (var s = 0; s < ${slices}; s++) {
    let ang = (f32(s) + ign(px)) * 3.14159265 / ${slices.toFixed(1)};
    let dir = vec2f(cos(ang), sin(ang));
    var horizon = -1.0;
    for (var k = 1; k <= ${steps}; k++) {
      let q = vec2i(px + dir * (f32(k) * radiusPx / ${steps.toFixed(1)}));
      if (any(q < vec2i(0)) || any(q >= size)) { continue; }
      let v = worldFromLinear(vec2f(q), textureLoad(halfDepthTex, q, 0).r) - p0;
      let dist = length(v);
      if (dist > RADIUS || dist < 1e-3) { continue; }
      horizon = max(horizon, dot(v, n) / dist);
    }
    occ += sqrt(max(0.0, 1.0 - horizon * horizon));
  }
  var ao = occ / ${slices.toFixed(1)};
  ao = mix(ao, 1.0, smoothstep(90.0, 120.0, L));
  return vec4f(ao);
}
`;

const blurShader = frameWgsl + commonWgsl + /* wgsl */ `
@group(1) @binding(0) var halfDepthTex: texture_2d<f32>;
@group(1) @binding(1) var smp: sampler;
@group(1) @binding(2) var src: texture_2d<f32>;

struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return Out(vec4f(p * 2.0 - 1.0, 0.0, 1.0), vec2f(p.x, 1.0 - p.y));
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  let px = vec2i(in.pos.xy);
  let size = vec2i(textureDimensions(halfDepthTex));
  let L0 = textureLoad(halfDepthTex, px, 0).r;
  var sum = 0.0;
  var weight = 0.0;
  for (var k = 0; k < 16; k++) {
    let q = px + vec2i(k & 3, k >> 2) - 2;
    if (any(q < vec2i(0)) || any(q >= size)) { continue; }
    // Depth-aware: taps on the other side of an edge (a silhouette, a step) don't bleed.
    let w = exp(-abs(textureLoad(halfDepthTex, q, 0).r - L0) * 0.6);
    sum += textureLoad(src, q, 0).r * w;
    weight += w;
  }
  return vec4f(sum / max(weight, 1e-4));
}
`;

/** The AO surfaces for one scene target size: the raw march and the blurred result. */
export interface AoTargets {
  textures: GPUTexture[];
  raw: GPUTextureView;
  out: GPUTextureView;
  /** Binds the half-res depth, marching into `raw`. */
  march: GPUBindGroup;
  /** Binds depth + raw, blurring into `out`. */
  blur: GPUBindGroup;
}

export class AmbientOcclusion {
  private marchLayout: GPUBindGroupLayout;
  private blurLayout: GPUBindGroupLayout;
  private march: GPURenderPipeline[] = [];
  private blur: GPURenderPipeline;
  private sampler: GPUSampler;

  constructor(private device: GPUDevice, layouts: Layouts) {
    const FRAGMENT = GPUShaderStage.FRAGMENT;
    const entries = (extra?: GPUBindGroupLayoutEntry): GPUBindGroupLayoutEntry[] => [
      { binding: 0, visibility: FRAGMENT, texture: { sampleType: "unfilterable-float" } },
      { binding: 1, visibility: FRAGMENT, sampler: {} },
      ...(extra ? [extra] : []),
    ];
    this.marchLayout = device.createBindGroupLayout({ entries: entries() });
    this.blurLayout = device.createBindGroupLayout({
      entries: entries({
        binding: 2,
        visibility: FRAGMENT,
        texture: { sampleType: "unfilterable-float" },
      }),
    });
    const layoutFor = (group: GPUBindGroupLayout) =>
      device.createPipelineLayout({ bindGroupLayouts: [layouts.shadowFrame, group] });
    // medium: 2 slices x 4 steps; high: 3 x 6.
    const marchLayout = layoutFor(this.marchLayout);
    for (const [slices, steps] of [[2, 4], [3, 6]]) {
      const module = device.createShaderModule({
        code: shader(slices, steps),
        label: `ao-${slices}x${steps}`,
      });
      this.march.push(device.createRenderPipeline({
        label: `ao-${slices}x${steps}`,
        layout: marchLayout,
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: "r8unorm" }] },
      }));
    }
    const blurModule = device.createShaderModule({ code: blurShader, label: "ao-blur" });
    this.blur = device.createRenderPipeline({
      label: "ao-blur",
      layout: layoutFor(this.blurLayout),
      vertex: { module: blurModule, entryPoint: "vs" },
      fragment: { module: blurModule, entryPoint: "fs", targets: [{ format: "r8unorm" }] },
    });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  }

  /** Allocate the half-res surfaces and the bind groups reading them for a scene target. */
  allocate(depthView: GPUTextureView, width: number, height: number): AoTargets {
    const size = [Math.max(1, width >> 1), Math.max(1, height >> 1)];
    const make = () =>
      this.device.createTexture({
        size,
        format: "r8unorm",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    const [rawTex, outTex] = [make(), make()];
    const raw = rawTex.createView();
    const out = outTex.createView();
    const bind = (layout: GPUBindGroupLayout, src?: GPUTextureView) =>
      this.device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: depthView },
          { binding: 1, resource: this.sampler },
          ...(src ? [{ binding: 2, resource: src }] : []),
        ],
      });
    return {
      textures: [rawTex, outTex],
      raw,
      out,
      march: bind(this.marchLayout),
      blur: bind(this.blurLayout, raw),
    };
  }

  /** March the AO into `targets.raw`, then blur it into `targets.out`. */
  draw(
    encoder: GPUCommandEncoder,
    targets: AoTargets,
    frameBindGroup: GPUBindGroup,
    high: boolean,
  ) {
    const run = (pipeline: GPURenderPipeline, to: GPUTextureView, bind: GPUBindGroup) => {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: to, loadOp: "clear", storeOp: "store" }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, frameBindGroup);
      pass.setBindGroup(1, bind);
      pass.draw(3);
      pass.end();
    };
    run(this.march[high ? 1 : 0], targets.raw, targets.march);
    run(this.blur, targets.out, targets.blur);
  }
}
