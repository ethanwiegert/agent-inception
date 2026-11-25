import { frameWgsl, lightingWgsl } from "./frame.ts";
import type { SurfaceTexture } from "./surface.ts";
import type { Layouts, Quality } from "./renderer.ts";

/** Particles of ambient life drawn in one instanced call. */
const COUNT = 320;
/** Low tier keeps the same mix with fewer instances: ambience stays, vertex work drops 70%. */
const COUNT_LOW = 96;
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
  @location(3) @interpolate(flat) kind: u32,
  @location(4) flap: f32,
  @location(5) seed: f32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var out: Out;
  out.pos = vec4f(0.0, 0.0, -1.0, 1.0);
  out.uv = vec2f(0.0);
  out.color = vec3f(0.0);
  out.alpha = 0.0;
  out.kind = 0u;
  out.flap = 0.0;
  out.seed = 0.0;
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
  s = pcg(s); let h6 = f32(s) / 4294967296.0;
  s = pcg(s); let h7 = f32(s) / 4294967296.0;
  s = pcg(s); let h8 = f32(s) / 4294967296.0;

  // Night-only instances become daytime insects and motes when the sun is up, and day insects
  // join the fireflies after dark. The population crossfades by hash, so the same slots are
  // useful around the clock instead of a fifth of them sitting invisible half the day.
  let baseKind = kind;
  if (baseKind == 4u && h6 < dayness * 0.8) { kind = 1u; }
  if (baseKind == 5u && h6 < dayness) { kind = 0u; }
  let darkness = 1.0 - dayness;
  if (baseKind == 1u && h6 < darkness) { kind = 4u; }
  if (baseKind == 2u && h6 < darkness * 0.8) { kind = 4u; }
  if (baseKind == 3u && h6 < darkness * 0.5) { kind = 4u; }

  // A wandering anchor in a ring around the camera; winged things stay near their anchor.
  let ang = h1 * 6.2831853;
  let rad = 8.0 + h2 * 44.0;
  var anchorXZ = frame.cameraPos.xz + vec2f(cos(ang) * rad + (h3 - 0.5) * 8.0,
    sin(ang) * rad + (h4 - 0.5) * 8.0);
  // Put a share of the small daytime/nighttime insects in the spectator's forward band, so the
  // meadow always has a few visible travelers instead of hiding them all behind the camera.
  if ((kind == 0u || kind == 1u || kind == 4u) && h8 < 0.45) {
    let forward = frame.qualityParams.zw;
    let side = vec2f(-forward.y, forward.x);
    let ahead = 6.0 + h1 * 24.0;
    let lateral = (h2 - 0.5) * 24.0;
    anchorXZ = frame.cameraPos.xz + forward * ahead + side * lateral;
  }
  let anchor = vec3f(anchorXZ.x, 0.0, anchorXZ.y);
  let cell = textureLoad(surface, vec2i(floor(anchor.xz)), 0);
  let ground = f32(cell.r) + 1.0;
  let water = cell.a > 0u && f32(cell.a - 1u) > f32(cell.r);

  var world = vec3f(anchor.x, ground + 1.0, anchor.z);
  var color = vec3f(0.8);
  var alpha = 0.0;
  var size = 0.05;
  var flap = 0.0;

  let painterly = frame.lookParams.y;
  let twilight = frame.lookParams.z;
  switch kind {
    case 0u: {
      // Pollen and golden sanctuary motes: slow warm drift through sunlit air and dusk.
      let weave = t * (0.16 + h2 * 0.08) + h4 * 6.2831853;
      world += vec3f(
        sin(t * 0.31 + h1 * 6.0) * 1.2 + sin(weave) * 2.4,
        0.4 + h2 * 2.5 + sin(t * 0.5 + h3 * 9.0) * 0.45,
        cos(t * 0.27 + h4 * 6.0) * 1.2 + cos(weave * 0.7) * 1.8);
      // Low tier already uses the cheaper forward path; cloud light alone keeps these motes
      // responsive there while medium/high still pick out the sun shafts.
      var lit = cloudLight(world);
      if (frame.qualityParams.x >= 0.5) { lit = keyLightFast(world); }
      color = mix(vec3f(1.0, 0.95, 0.8), vec3f(1.0, 0.86, 0.45), painterly * 0.7) *
        (0.25 + lit * (1.4 + 1.2 * painterly));
      alpha = (0.1 + lit * (0.6 + 0.35 * painterly)) * max(dayness, twilight * 0.9);
      size = (0.06 + h5 * 0.05) * (1.0 + 0.55 * painterly);
    }
    case 1u: {
      // Butterflies weave over the meadow in daylight, drifting sideways between flowers.
      let w1 = t * (0.9 + h2 * 0.6) + h1 * 6.2831853;
      let cruise = t * (0.42 + h7 * 0.28) + h6 * 6.2831853;
      world += vec3f(
        cos(w1) * 1.6 + cos(cruise) * 1.1,
        1.15 + h3 * 1.15 + sin(t * 2.3 + h4 * 9.0) * 0.45,
        sin(w1 * 1.3) * 1.6 + sin(cruise) * 1.1);
      let petals = array<vec3f, 3>(vec3f(1.0, 0.46, 0.08), vec3f(0.95, 0.72, 0.12), vec3f(0.55, 0.34, 0.85));
      color = petals[min(u32(h5 * 3.0), 2u)] * 0.95;
      alpha = select(0.0, 0.95, cell.g == 1u || cell.g == 2u) * dayness;
      size = 0.24 + h8 * 0.06;
      flap = sin(t * (10.0 + h5 * 6.0) + h1 * 9.0);
    }
    case 2u: {
      // Most gulls travel in loose little flocks across the sky; a few sweep through the
      // foreground so their wingbeats read clearly, and the rest circle thermals.
      if (h6 < 0.52) {
        let fi = u32(h2 * 3.0);
        let flock = f32(fi);
        let flockAngle = flock * 2.0943951 + 0.45;
        let dir = vec2f(cos(flockAngle), sin(flockAngle));
        let side = vec2f(-dir.y, dir.x);
        // Shared by every member of a flock; rank and jitter in the V stay per-bird.
        let travel = fract(t * (0.032 + flock * 0.006) + flock * 0.37);
        let ri = u32(h4 * 6.0);
        let rank = f32(ri);
        let sideSign = select(-1.0, 1.0, (ri & 1u) == 0u);
        let along = (travel - 0.5) * 150.0 - rank * 2.1 + (h7 - 0.5) * 1.2;
        let lane = (flock - 1.0) * 18.0 + sideSign * rank * 1.45 + (h8 - 0.5) * 1.1;
        let across = frame.cameraPos.xz + dir * along + side * lane;
        world = vec3f(
          across.x,
          frame.extra.z + 12.0 + h3 * 7.0 + sin(t * 0.55 + h6 * 9.0) * 0.8,
          across.y);
        let edge = smoothstep(0.02, 0.12, travel) * (1.0 - smoothstep(0.88, 0.98, travel));
        alpha = 0.9 * dayness * edge;
      } else if (h6 < 0.68) {
        let forward = frame.qualityParams.zw;
        let side = vec2f(-forward.y, forward.x);
        let travel = fract(t * (0.045 + h7 * 0.018) + h1);
        let sweepSign = select(-1.0, 1.0, h8 < 0.5);
        let sweep = (travel - 0.5) * 34.0 * sweepSign;
        let ahead = 12.0 + h2 * 14.0 + sin(t * 0.31 + h3 * 6.0) * 1.5;
        let across = frame.cameraPos.xz + forward * ahead + side * sweep;
        let below = textureLoad(surface, vec2i(floor(across)), 0);
        world = vec3f(
          across.x,
          f32(below.r) + 5.0 + h3 * 4.0 + sin(t * 0.8 + h4 * 9.0) * 0.7,
          across.y);
        let edge = smoothstep(0.03, 0.16, travel) * (1.0 - smoothstep(0.84, 0.97, travel));
        alpha = dayness * edge;
      } else {
        let w2 = t * (0.14 + h7 * 0.08) + h1 * 6.2831853;
        let radius = 10.0 + h5 * 8.0;
        world = vec3f(
          anchor.x + cos(w2) * radius,
          frame.extra.z + 13.0 + h3 * 7.0 + sin(t * 0.7 + h4 * 9.0) * 0.9,
          anchor.z + sin(w2) * radius);
        // Circling birds favor the coast, with enough inland strays to keep the sky inhabited.
        let coast = mix(0.45, 1.0, select(0.0, 1.0, water));
        alpha = 0.78 * dayness * coast;
      }
      color = vec3f(0.58, 0.64, 0.73) * (0.85 + h5 * 0.3) * (0.5 + dayness * 0.6);
      size = 0.78 + h8 * 0.16;
      if (h6 >= 0.52 && h6 < 0.68) { size *= 0.75; }
      // Wing beats come in bursts; between them the bird glides with wings nearly level.
      let glide = smoothstep(0.1, 0.75, sin(t * (0.21 + h7 * 0.1) + h6 * 6.2831853));
      flap = sin(t * (2.8 + h7 * 1.5) + h4 * 9.0) * (1.0 - glide * 0.75);
    }
    case 3u: {
      // An autumn leaf spirals down under a crown, drifting downwind as it falls.
      let fall = fract(t * (0.12 + h2 * 0.1) + h1);
      world += vec3f(
        sin(t * 2.1 + h3 * 9.0) * 0.55 + fall * 2.2,
        3.5 * (1.0 - fall) + 0.1,
        cos(t * 1.7 + h4 * 9.0) * 0.55 + fall * 0.8);
      color = vec3f(0.55, 0.4, 0.12) * (0.7 + h5 * 0.6);
      let field = fieldAt(anchor.xz);
      let fallFade = smoothstep(0.0, 0.12, fall) * (1.0 - smoothstep(0.82, 0.98, fall));
      // Crowns are where the field map is dim; leaves need both crown shade and daylight.
      alpha = smoothstep(0.75, 0.45, field.x) * 0.85 * fallFade;
      size = 0.13 + h8 * 0.03;
      flap = sin(t * 5.0 + h5 * 9.0) * 0.7;
    }
    case 4u: {
      // Fireflies and terrarium spores: warm amber and bioluminescent cyan-mint at dusk and night.
      world += vec3f(
        sin(t * 0.4 + h1 * 9.0) * 2.7,
        0.5 + h3 * 1.8 + sin(t * 0.9 + h4 * 9.0) * 0.4,
        cos(t * 0.33 + h2 * 9.0) * 2.7);
      let blink = smoothstep(0.15, 0.8, sin(t * (1.5 + h5) + h1 * 20.0));
      let sporeColor = select(vec3f(1.0, 0.78, 0.3), vec3f(0.35, 1.0, 0.88), h5 > 0.55);
      color = mix(vec3f(0.6, 1.0, 0.35), sporeColor, painterly) * (3.2 + 1.5 * painterly) * blink;
      let duskNight = max(night, twilight * 0.85);
      let field = fieldAt(anchor.xz);
      let area = mix(
        smoothstep(0.62, 0.45, field.y) * select(0.0, 1.0, cell.g == 1u || cell.g == 2u),
        1.0,
        painterly * 0.85,
      );
      alpha = duskNight * blink * area;
      size = 0.08 + 0.035 * painterly;
    }
    default: {
      // Moths bat around lamps at night: they only show where lamplight reaches.
      let w5 = t * (1.6 + h2) + h1 * 6.2831853;
      world += vec3f(cos(w5) * 0.9, 1.2 + h3 * 0.8 + sin(t * 3.0 + h4 * 9.0) * 0.35,
        sin(w5 * 1.4) * 0.9);
      let lamp = lampLight(world, vec3f(0.0, 1.0, 0.0));
      color = vec3f(0.7, 0.62, 0.5) * (0.4 + lamp * 4.0);
      alpha = night * clamp(dot(lamp, vec3f(1.0)) * 6.0, 0.0, 0.85);
      size = 0.09;
      flap = sin(t * 14.0 + h5 * 9.0);
    }
  }

  let dist = distance(world, frame.cameraPos.xyz);
  var reach = ${REACH}.0;
  if (kind == 2u) { reach = 90.0; }
  alpha *= 1.0 - smoothstep(reach * 0.7, reach, dist);
  if (alpha <= 0.003) { return out; }

  // A camera-facing quad. Winged creatures narrow a little at the stroke's extremes; gulls keep
  // a broad span so their silhouette reads at distance.
  var pinch = mix(1.0, 0.38, abs(flap));
  if (kind == 2u) { pinch = mix(1.0, 0.68, abs(flap)); }
  if (kind == 0u || kind == 3u || kind == 4u) { pinch = 1.0; }
  var xsize = size;
  var ysize = size;
  if (kind == 2u) {
    xsize = size * 1.8;
    ysize = size;
  }
  if (kind == 1u || kind == 5u) {
    xsize = size * 1.15;
    ysize = size * 1.05;
  }
  let c = (array<vec2f, 6>(
    vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5),
    vec2f(-0.5, -0.5), vec2f(0.5, 0.5), vec2f(-0.5, 0.5),
  ))[vi];
  let f = normalize(frame.cameraPos.xyz - world);
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), f) + vec3f(1e-5, 0.0, 0.0));
  let up = cross(f, right);
  world += right * c.x * xsize * pinch + up * c.y * ysize;
  out.pos = frame.viewProj * vec4f(world, 1.0);
  out.uv = c;
  out.color = color;
  out.alpha = alpha;
  out.kind = kind;
  out.flap = flap;
  out.seed = h5;
  return out;
}

/** Soft-edged ellipse in normalized quad coordinates. */
fn ellipse(p: vec2f, c: vec2f, r: vec2f, feather: f32) -> f32 {
  let d = length((p - c) / r);
  return 1.0 - smoothstep(1.0 - feather, 1.0, d);
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  let uv = in.uv * 2.0;
  var color = in.color;
  var shape = 0.0;
  if (in.kind == 0u) {
    // Motes stay soft round specks; their visibility comes from the sun catching them.
    let r = length(uv);
    shape = exp(-r * r * 7.0) * (1.0 - smoothstep(0.8, 1.0, r));
  } else if (in.kind == 4u) {
    // A firefly is a hot core inside a wider halo, so bloom has something small to amplify.
    let r = length(uv);
    let core = exp(-r * r * 24.0);
    let halo = exp(-r * r * 5.0) * (1.0 - smoothstep(0.8, 1.0, r));
    shape = max(core, halo * 0.7);
  } else if (in.kind == 2u) {
    // Gull silhouette: two tapered wings around a small body, with darkening wingtips. The
    // wing line hinges up and down with the signed flap value, then relaxes into a glide.
    let ax = abs(uv.x);
    let center = -0.02 + ax * 0.12 + in.flap * ax * 0.5;
    let thick = 0.018 + 0.075 * sin(3.14159265 * ax);
    let wingBand = 1.0 - smoothstep(thick, thick + 0.025, abs(uv.y - center));
    let span = 1.0 - smoothstep(0.88, 1.0, ax);
    let awayFromBody = smoothstep(0.1, 0.24, ax);
    let wing = wingBand * span * awayFromBody;
    let body = ellipse(uv, vec2f(0.0, -0.01), vec2f(0.07, 0.19), 0.3);
    let tip = smoothstep(0.55, 0.95, ax);
    color = mix(color, color * vec3f(0.42, 0.48, 0.58), tip * 0.65);
    shape = max(wing * 0.95, body);
  } else if (in.kind == 1u || in.kind == 5u) {
    // Butterflies and moths have upper and lower wing lobes around a dark little body.
    let ax = abs(uv.x);
    let upper = ellipse(vec2f(ax, uv.y), vec2f(0.42, 0.16), vec2f(0.46, 0.34), 0.22);
    let lower = ellipse(vec2f(ax, uv.y), vec2f(0.34, -0.22), vec2f(0.36, 0.29), 0.22);
    let body = ellipse(uv, vec2f(0.0, 0.0), vec2f(0.09, 0.55), 0.25);
    let wing = max(upper, lower * 0.88);
    let edge = smoothstep(0.52, 0.95, ax) * wing;
    color = mix(color, color * 0.62, edge * 0.5);
    color = mix(color, vec3f(0.09, 0.06, 0.045), smoothstep(0.25, 0.8, body));
    shape = max(wing * 0.95, body);
  } else {
    // Falling leaves are pointed ovals with a center vein, tumbling in the screen plane.
    let angle = in.seed * 6.2831853 + frame.cameraPos.w * 1.7 + in.flap;
    let ca = cos(angle);
    let sa = sin(angle);
    let p = vec2f(ca * uv.x - sa * uv.y, sa * uv.x + ca * uv.y);
    shape = ellipse(p, vec2f(0.0), vec2f(0.38, 0.78), 0.18);
    let vein = (1.0 - smoothstep(0.015, 0.05, abs(p.x))) * (1.0 - smoothstep(0.72, 0.95, abs(p.y)));
    color = mix(color, color * 0.58, vein * 0.5);
  }
  shape = min(shape, 1.0);
  let a = shape * in.alpha;
  return vec4f(color * a, a);
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

  draw(pass: GPURenderPassEncoder, quality: Quality) {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(1, this.bindGroup);
    pass.draw(6, quality === "low" ? COUNT_LOW : COUNT);
  }
}
