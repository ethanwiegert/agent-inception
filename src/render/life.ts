import { frameWgsl, lightingWgsl } from "./frame.ts";
import type { SurfaceTexture } from "./surface.ts";
import type { Layouts } from "./renderer.ts";

/** Particles of ambient life drawn in one instanced call. */
const COUNT = 320;
/** Everything fades out by this distance from the camera, in blocks. */
const REACH = 60;

/**
 * Ambient life: pollen, butterflies, gulls, falling leaves, fireflies and moths, generated
 * entirely in the vertex shader from a hash of the instance index and the frame's time. There
 * is no CPU particle state and nothing the sim or agents can interact with; each particle loops
 * its own small trajectory in a ring around the camera. All of them fade out by ~60 blocks.
 * `?debug=life` skips the draw.
 */
const shader = frameWgsl + lightingWgsl + /* wgsl */ `
@group(1) @binding(0) var surface: texture_2d<u32>;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
  @location(2) alpha: f32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var out: Out;
  out.pos = vec4f(0.0, 0.0, -1.0, 1.0);
  out.uv = vec2f(0.0);
  out.color = vec3f(0.0);
  out.alpha = 0.0;
  let t = frame.cameraPos.w;
  let night = frame.extra.x;
  let dayness = frame.extra.y;
  var s = ii * 2654435761u + 1013904223u;
  s = pcg(s);
  let k = f32(s) / 4294967296.0;
  // kind: 0 dust mote, 1 butterfly, 2 gull, 3 falling leaf, 4 firefly, 5 moth
  var kind = 0u;
  if (k > 0.40) { kind = 1u; }
  if (k > 0.55) { kind = 2u; }
  if (k > 0.65) { kind = 3u; }
  if (k > 0.80) { kind = 4u; }
  if (k > 0.95) { kind = 5u; }

  s = pcg(s); let h1 = f32(s) / 4294967296.0;
  s = pcg(s); let h2 = f32(s) / 4294967296.0;
  s = pcg(s); let h3 = f32(s) / 4294967296.0;
  s = pcg(s); let h4 = f32(s) / 4294967296.0;
  s = pcg(s); let h5 = f32(s) / 4294967296.0;

  // A wandering anchor in a ring around the camera; winged things stay near their anchor.
  let ang = h1 * 6.2831853;
  let rad = 8.0 + h2 * 44.0;
  let anchor = vec3f(
    frame.cameraPos.x + cos(ang) * rad + (h3 - 0.5) * 8.0,
    0.0,
    frame.cameraPos.z + sin(ang) * rad + (h4 - 0.5) * 8.0);
  let cell = textureLoad(surface, vec2i(floor(anchor.xz)), 0);
  let ground = f32(cell.r) + 1.0;
  let water = cell.a > 0u && f32(cell.a - 1u) > f32(cell.r);
  let field = fieldAt(anchor.xz);

  var world = vec3f(anchor.x, ground + 1.0, anchor.z);
  var color = vec3f(0.8);
  var alpha = 0.0;
  var size = 0.05;
  var flap = 0.0;

  switch kind {
    case 0u: {
      // Pollen and dust: slow drift, lit only where the key light reaches (bright inside shafts).
      world += vec3f(sin(t * 0.31 + h1 * 6.0) * 1.5, 0.4 + h2 * 2.5 + sin(t * 0.5 + h3 * 9.0) * 0.4,
        cos(t * 0.27 + h4 * 6.0) * 1.5);
      let lit = keyLightFast(world);
      color = vec3f(1.0, 0.95, 0.8) * (0.25 + lit * 1.4);
      alpha = (0.06 + lit * 0.5) * dayness;
      size = 0.035 + h5 * 0.03;
    }
    case 1u: {
      // Butterflies weave over the meadow in daylight.
      let w1 = t * (0.9 + h2 * 0.6) + h1 * 6.2831853;
      world += vec3f(cos(w1) * 1.6, 0.8 + h3 + sin(t * 2.3 + h4 * 9.0) * 0.4, sin(w1 * 1.3) * 1.6);
      let petals = array<vec3f, 3>(vec3f(0.9, 0.85, 0.7), vec3f(0.95, 0.65, 0.1), vec3f(0.5, 0.3, 0.8));
      color = petals[min(u32(h5 * 3.0), 2u)] * 0.9;
      alpha = select(0.0, 0.85, cell.g == 1u || cell.g == 2u) * dayness;
      size = 0.09;
      flap = abs(sin(t * (10.0 + h5 * 6.0) + h1 * 9.0));
    }
    case 2u: {
      // Gulls circle high over the coast.
      let w2 = t * 0.18 + h1 * 6.2831853;
      world = vec3f(anchor.x + cos(w2) * 14.0, frame.extra.z + 24.0 + h3 * 8.0,
        anchor.z + sin(w2) * 14.0);
      color = vec3f(0.85, 0.87, 0.9);
      alpha = 0.8 * dayness;
      size = 0.35;
      flap = abs(sin(t * 3.0 + h4 * 9.0));
    }
    case 3u: {
      // An autumn leaf spirals down under a crown, over and over.
      let fall = fract(t * (0.12 + h2 * 0.1) + h1);
      world += vec3f(sin(t * 2.1 + h3 * 9.0) * 0.5, 3.5 * (1.0 - fall) + 0.1,
        cos(t * 1.7 + h4 * 9.0) * 0.5);
      color = vec3f(0.55, 0.4, 0.12) * (0.7 + h5 * 0.6);
      // Crowns are where the field map is dim; leaves need both crown shade and daylight.
      alpha = smoothstep(0.75, 0.45, field.x) * 0.8;
      size = 0.08;
      flap = sin(t * 5.0 + h5 * 9.0) * 0.7;
    }
    case 4u: {
      // Fireflies blink over the meadow near water after dark.
      world += vec3f(sin(t * 0.4 + h1 * 9.0) * 2.2, 0.5 + h3 * 1.2 + sin(t * 0.9 + h4 * 9.0) * 0.3,
        cos(t * 0.33 + h2 * 9.0) * 2.2);
      let blink = smoothstep(0.2, 0.8, sin(t * (1.5 + h5) + h1 * 20.0));
      color = vec3f(0.6, 1.0, 0.35) * 3.0 * blink;
      alpha = night * blink * smoothstep(0.62, 0.45, field.y) *
        select(0.0, 1.0, cell.g == 1u || cell.g == 2u);
      size = 0.07;
    }
    default: {
      // Moths bat around lamps at night: they only show where lamplight reaches.
      let w5 = t * (1.6 + h2) + h1 * 6.2831853;
      world += vec3f(cos(w5) * 0.7, 1.2 + h3 * 0.8 + sin(t * 3.0 + h4 * 9.0) * 0.3,
        sin(w5 * 1.4) * 0.7);
      let lamp = lampLight(world, vec3f(0.0, 1.0, 0.0));
      color = vec3f(0.7, 0.62, 0.5) * (0.4 + lamp * 4.0);
      alpha = night * clamp(dot(lamp, vec3f(1.0)) * 6.0, 0.0, 0.8);
      size = 0.06;
      flap = abs(sin(t * 14.0 + h5 * 9.0));
    }
  }

  let dist = distance(world, frame.cameraPos.xyz);
  alpha *= 1.0 - smoothstep(${REACH}.0 * 0.7, ${REACH}.0, dist);
  if (alpha <= 0.003) { return out; }

  // A camera-facing quad; wings flap by pinching the quad's x.
  let c = (array<vec2f, 6>(vec2f(-0.5), vec2f(0.5), vec2f(0.5, 0.5),
    vec2f(-0.5), vec2f(0.5, 0.5), vec2f(-0.5, 0.5)))[vi] + vec2f(0.0, -0.5);
  let f = normalize(frame.cameraPos.xyz - world);
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), f) + vec3f(1e-5, 0.0, 0.0));
  let up = cross(f, right);
  world += right * c.x * size * mix(1.0, 0.25, flap) + up * c.y * size;
  out.pos = frame.viewProj * vec4f(world, 1.0);
  out.uv = c;
  out.color = color;
  out.alpha = alpha;
  return out;
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  let r = length(in.uv) * 2.0;
  let a = exp(-r * r * 6.0) * (1.0 - smoothstep(0.8, 1.0, r)) * in.alpha;
  return vec4f(in.color * a, a);
}
`;

export class LifeRenderer {
  private pipeline: GPURenderPipeline;
  private bindGroup: GPUBindGroup;

  constructor(device: GPUDevice, surface: SurfaceTexture, layouts: Layouts) {
    const layout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        texture: { sampleType: "uint" },
      }],
    });
    this.bindGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: surface.view }],
    });
    const module = device.createShaderModule({ code: shader, label: "life" });
    this.pipeline = device.createRenderPipeline({
      label: "life",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{
          format: layouts.colorFormat,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: layouts.depthFormat,
        depthWriteEnabled: false,
        depthCompare: "less",
      },
      multisample: { count: layouts.samples },
    });
  }

  draw(pass: GPURenderPassEncoder) {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(1, this.bindGroup);
    pass.draw(6, COUNT);
  }
}
