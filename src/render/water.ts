import { frameWgsl, lightingWgsl } from "./frame.ts";
import type { Layouts } from "./renderer.ts";
import type { SurfaceTexture } from "./surface.ts";

/**
 * Water: one quad per wet column, generated in the vertex shader from the
 * shared surface texture (no meshes to rebuild when agents dig ponds), plus an
 * ocean plane out to the horizon. Waves, reflections and foam are procedural.
 */
const shader = frameWgsl + lightingWgsl + /* wgsl */ `
@group(1) @binding(0) var surface: texture_2d<u32>;

const SURFACE_DROP = 0.12;
const OCEAN_REACH = 3000.0;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
};

fn culled() -> Out {
  var out: Out;
  out.pos = vec4f(0.0, 0.0, -1.0, 1.0);
  return out;
}

fn corner(vi: u32) -> vec2f {
  return vec2f(f32(vi & 1u), f32(vi >> 1u));
}

@vertex fn vsColumns(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  let size = vec2i(textureDimensions(surface));
  let cell = vec2i(i32(ii) % size.x, i32(ii) / size.x);
  let s = textureLoad(surface, cell, 0);
  if (s.a == 0u) { return culled(); }
  let p = vec3f(f32(cell.x), f32(s.a) - SURFACE_DROP, f32(cell.y)) + vec3f(corner(vi).x, 0.0, corner(vi).y);
  return Out(frame.viewProj * vec4f(p, 1.0), p);
}

@vertex fn vsOcean(@builtin(vertex_index) vi: u32) -> Out {
  let c = (corner(vi) * 2.0 - 1.0) * OCEAN_REACH;
  let p = vec3f(frame.cameraPos.x + c.x, frame.extra.z + 1.0 - SURFACE_DROP, frame.cameraPos.z + c.y);
  return Out(frame.viewProj * vec4f(p, 1.0), p);
}

/** Ground height under the water, bilinear between column centers (deep sea outside the world). */
fn floorAt(xz: vec2f) -> f32 {
  let size = vec2i(textureDimensions(surface));
  let p = xz - 0.5;
  let i = vec2i(floor(p));
  let f = fract(p);
  var h = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  for (var k = 0; k < 4; k++) {
    let c = i + vec2i(k & 1, k >> 1);
    if (any(c < vec2i(0)) || any(c >= size)) {
      h[k] = frame.extra.z - 8.0;
    } else {
      let s = textureLoad(surface, c, 0);
      h[k] = f32(s.r) + 1.0 - f32(countOneBits(s.b & 15u)) * 0.25;
    }
  }
  return mix(mix(h[0], h[1], f.x), mix(h[2], h[3], f.x), f.y);
}

fn waveSlope(xz: vec2f, t: f32) -> vec2f {
  var g = vec2f(0.0);
  let dirs = array<vec2f, 4>(vec2f(0.8, 0.6), vec2f(-0.4, 0.9), vec2f(0.95, -0.3), vec2f(-0.7, -0.7));
  let freqs = array<f32, 4>(0.9, 1.7, 3.1, 5.3);
  let amps = array<f32, 4>(0.05, 0.03, 0.016, 0.008);
  for (var i = 0; i < 4; i++) {
    let phase = dot(dirs[i], xz) * freqs[i] + t * (1.2 + f32(i) * 0.4);
    g += dirs[i] * cos(phase) * amps[i] * freqs[i];
  }
  // Fine noise ripples break up the regular sines.
  let e = 0.15;
  let r = xz * 2.3 + vec2f(t * 0.6, -t * 0.45);
  g += vec2f(valueNoise(r + vec2f(e, 0.0)) - valueNoise(r - vec2f(e, 0.0)),
             valueNoise(r + vec2f(0.0, e)) - valueNoise(r - vec2f(0.0, e))) * 0.12;
  return g;
}

fn shadeWater(world: vec3f) -> vec4f {
  let t = frame.cameraPos.w;
  let g = waveSlope(world.xz, t);
  let n = normalize(vec3f(-g.x, 1.0, -g.y));
  let toEye = frame.cameraPos.xyz - world;
  let view = normalize(toEye);
  let ndv = max(dot(n, view), 0.0);
  let fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  let depth = max(world.y - floorAt(world.xz), 0.0);
  let light = keyLightFast(world);
  let ambient = frame.skyZenith.rgb * frame.sunColor.w * 0.9 + frame.groundAmbient.rgb * 0.3;
  let lit = ambient + frame.sunColor.rgb * frame.sunDir.w * max(frame.sunDir.y, 0.0) * light * 0.6;
  let shallow = vec3f(0.035, 0.13, 0.11);
  let deep = vec3f(0.006, 0.03, 0.045);
  let body = mix(shallow, deep, smoothstep(0.0, 3.0, depth)) * lit;

  let r = reflect(-view, n);
  var color = mix(body, skyColor(vec3f(r.x, abs(r.y), r.z)), fresnel);
  let spec = pow(max(dot(r, frame.sunDir.xyz), 0.0), 600.0) * 30.0 + pow(max(dot(r, frame.sunDir.xyz), 0.0), 60.0) * 0.4;
  color += frame.sunColor.rgb * frame.sunDir.w * spec * light;

  // Foam where the water thins out against the shore.
  let foamNoise = valueNoise(world.xz * 3.0 + vec2f(t * 0.3, t * 0.2)) * valueNoise(world.xz * 7.0 - t * 0.25);
  let foam = smoothstep(0.35, 0.0, depth) * smoothstep(0.08, 0.25, foamNoise + 0.15);
  color = mix(color, (ambient + frame.sunColor.rgb * frame.sunDir.w * light * 0.5) * 0.9, foam);

  // The floor below is already darkened by absorption, so the surface itself can stay fairly clear.
  let alpha = clamp(max(mix(0.25, 0.85, smoothstep(0.0, 3.5, depth)), fresnel) + foam, 0.0, 1.0);
  return vec4f(fog(color, world), alpha);
}

@fragment fn fsColumns(in: Out) -> @location(0) vec4f {
  return shadeWater(in.world);
}

@fragment fn fsOcean(in: Out) -> @location(0) vec4f {
  // Inside the world the per-column water takes over.
  let size = vec2f(textureDimensions(surface));
  if (all(in.world.xz >= vec2f(0.0)) && all(in.world.xz <= size)) { discard; }
  return shadeWater(in.world);
}
`;

export class WaterRenderer {
  private bindGroup: GPUBindGroup;
  private columns: GPURenderPipeline;
  private ocean: GPURenderPipeline;
  private cells: number;

  constructor(device: GPUDevice, surface: SurfaceTexture, layouts: Layouts) {
    this.cells = surface.texture.width * surface.texture.height;
    const layout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        texture: { sampleType: "uint" },
      }],
    });
    this.bindGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: surface.view }],
    });
    const module = device.createShaderModule({ code: shader, label: "water" });
    const pipeline = (vs: string, fs: string) =>
      device.createRenderPipeline({
        label: `water-${vs}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layout] }),
        vertex: { module, entryPoint: vs },
        fragment: {
          module,
          entryPoint: fs,
          targets: [{
            format: layouts.colorFormat,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          }],
        },
        primitive: { topology: "triangle-strip", cullMode: "none" },
        depthStencil: {
          format: layouts.depthFormat,
          depthWriteEnabled: false,
          depthCompare: "less",
        },
        multisample: { count: layouts.samples },
      });
    this.columns = pipeline("vsColumns", "fsColumns");
    this.ocean = pipeline("vsOcean", "fsOcean");
  }

  /** Draw after all opaque geometry. */
  draw(pass: GPURenderPassEncoder) {
    pass.setBindGroup(1, this.bindGroup);
    pass.setPipeline(this.ocean);
    pass.draw(4);
    pass.setPipeline(this.columns);
    pass.draw(4, this.cells);
  }
}
