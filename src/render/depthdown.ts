import { commonWgsl, frameWgsl } from "./frame.ts";
import type { Layouts } from "./renderer.ts";

/** Scene depth (1x or MSAA) → half-res linear view depth (r16float), for AO and shafts. */
const shader = (msaa: boolean) =>
  frameWgsl + commonWgsl + /* wgsl */ `
@group(1) @binding(0) var sceneDepth: ${
    msaa ? "texture_depth_multisampled_2d" : "texture_depth_2d"
  };

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let x = f32((vi << 1u) & 2u);
  let y = f32(vi & 2u);
  return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) f32 {
  // The farthest of the 2×2 footprint's sample-0 depths, so thin silhouettes keep their depth
  // rather than bleeding the sky's over AO and shafts.
  let dim = vec2i(textureDimensions(sceneDepth)) - 1;
  let base = min(vec2i(p.xy) * 2, dim);
  var d = textureLoad(sceneDepth, base, 0);
  d = max(d, textureLoad(sceneDepth, min(base + vec2i(1, 0), dim), 0));
  d = max(d, textureLoad(sceneDepth, min(base + vec2i(0, 1), dim), 0));
  d = max(d, textureLoad(sceneDepth, min(base + vec2i(1, 1), dim), 0));
  return linearDepth(d);
}
`;

export class DepthDown {
  private layout: GPUBindGroupLayout;
  private pipeline: GPURenderPipeline;
  private bound = new WeakMap<GPUTextureView, GPUBindGroup>();

  constructor(private device: GPUDevice, layouts: Layouts) {
    const msaa = layouts.samples > 1;
    this.layout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "depth", multisampled: msaa, viewDimension: "2d" },
      }],
    });
    const module = device.createShaderModule({ code: shader(msaa), label: "depthdown" });
    this.pipeline = device.createRenderPipeline({
      label: "depthdown",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [layouts.shadowFrame, this.layout],
      }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: "r16float" }] },
      primitive: { topology: "triangle-list" },
    });
  }

  private bind(device: GPUDevice, depthView: GPUTextureView): GPUBindGroup {
    let group = this.bound.get(depthView);
    if (!group) {
      group = device.createBindGroup({
        layout: this.layout,
        entries: [{ binding: 0, resource: depthView }],
      });
      this.bound.set(depthView, group);
    }
    return group;
  }

  /** Draw into the half-res linear depth target. */
  draw(
    encoder: GPUCommandEncoder,
    view: GPUTextureView,
    depthView: GPUTextureView,
    frameBind: GPUBindGroup,
  ) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, frameBind);
    pass.setBindGroup(1, this.bind(this.device, depthView));
    pass.draw(3);
    pass.end();
  }
}
