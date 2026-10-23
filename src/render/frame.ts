/**
 * Per-frame uniforms shared by every shader. The TS offsets and the WGSL struct
 * must stay in lockstep; everything is mat4 or vec4 so there's no padding.
 */
export const F = {
  viewProj: 0,
  invViewProj: 16,
  lightViewProj: 32,
  cameraPos: 48, // xyz, time (s)
  sunDir: 52, // xyz toward light, intensity
  sunColor: 56, // rgb, ambient strength
  skyZenith: 60, // rgb, exposure
  skyHorizon: 64, // rgb, fog density
  groundAmbient: 68, // rgb, AO strength
  grassBase: 72, // rgb, block edge darkening
  grassTip: 76, // rgb, flower chance
  grass: 80, // blade height, blade width, blades per block, radius (blocks)
  grassCenter: 84, // center x, center z, world size x, world size z
  wind: 88, // dir x, dir z, strength, -
  grade: 92, // saturation, contrast, warmth, vignette
  extra: 96, // star visibility, daylight, -, -
  size: 100,
} as const;

export const frameWgsl = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  lightViewProj: mat4x4f,
  cameraPos: vec4f,
  sunDir: vec4f,
  sunColor: vec4f,
  skyZenith: vec4f,
  skyHorizon: vec4f,
  groundAmbient: vec4f,
  grassBase: vec4f,
  grassTip: vec4f,
  grass: vec4f,
  grassCenter: vec4f,
  wind: vec4f,
  grade: vec4f,
  extra: vec4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
`;

/** Lighting helpers for shaders that receive shadows (group 0 bindings 1 and 2). */
export const lightingWgsl = /* wgsl */ `
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

fn valueNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** Low-frequency meadow tint so the grass isn't one flat green. */
fn meadowColor(base: vec3f, xz: vec2f) -> vec3f {
  let t = valueNoise(xz * 0.045) * 0.7 + valueNoise(xz * 0.17) * 0.3;
  let dry = base * vec3f(1.35, 1.15, 0.55);
  let lush = base * vec3f(0.8, 1.05, 0.9);
  return mix(lush, dry, smoothstep(0.35, 0.85, t));
}

fn shadowAt(world: vec3f, n: vec3f) -> f32 {
  let p = frame.lightViewProj * vec4f(world + n * 0.04, 1.0);
  let ndc = p.xyz / p.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + 0.5;
  let texel = 1.0 / vec2f(textureDimensions(shadowMap));
  var sum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(f32(x), f32(y)) * texel, ndc.z);
    }
  }
  let inside = all(uv > vec2f(0.0)) && all(uv < vec2f(1.0)) && ndc.z < 1.0;
  return select(1.0, sum / 9.0, inside);
}

fn shade(albedo: vec3f, n: vec3f, world: vec3f, ao: f32, wrap: f32) -> vec3f {
  let l = frame.sunDir.xyz;
  let ndl = clamp((dot(n, l) + wrap) / (1.0 + wrap), 0.0, 1.0);
  let direct = frame.sunColor.rgb * frame.sunDir.w * ndl * shadowAt(world, n);
  let hemi = mix(frame.groundAmbient.rgb, frame.skyZenith.rgb, n.y * 0.5 + 0.5);
  return albedo * (direct + hemi * frame.sunColor.w * ao);
}

fn fog(color: vec3f, world: vec3f) -> vec3f {
  // Top-down views sit 30-80 blocks from the ground; only haze what's beyond that.
  let d = max(distance(world, frame.cameraPos.xyz) - 60.0, 0.0);
  let f = 1.0 - exp(-d * frame.skyHorizon.w);
  return mix(color, frame.skyHorizon.rgb * 0.7, f);
}
`;
