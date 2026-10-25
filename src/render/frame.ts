/**
 * Per-frame uniforms shared by every shader. The TS offsets and the WGSL struct
 * must stay in lockstep; everything is mat4 or vec4 so there's no padding.
 */
export const F = {
  viewProj: 0,
  invViewProj: 16,
  lightViewProj: 32,
  cameraPos: 48, // xyz, time (s)
  sunDir: 52, // xyz toward the key light (sun by day, moon by night), intensity
  sunColor: 56, // key light rgb, ambient strength
  skyZenith: 60, // rgb, exposure
  skyHorizon: 64, // rgb, fog density
  groundAmbient: 68, // rgb, AO strength
  grassBase: 72, // rgb, -
  grassTip: 76, // rgb, flower chance
  grass: 80, // blade height, blade width, blades per block, radius (blocks)
  grassCenter: 84, // center x, center z, world size x, world size z
  wind: 88, // dir x, dir z, strength, -
  grade: 92, // saturation, contrast, warmth, vignette
  extra: 96, // star visibility, daylight, sea level, -
  sunPos: 100, // xyz toward the sun, visibility
  moonDir: 104, // xyz toward the moon, brightness
  weather: 108, // cloud cover 0-1, cloud drift speed, -, -
  size: 112,
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
  sunPos: vec4f,
  moonDir: vec4f,
  weather: vec4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
`;

/** Noise, sky and cloud helpers that only need the frame uniforms. */
export const commonWgsl = /* wgsl */ `
const CLOUD_HEIGHT = 260.0;

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

fn fbm(p: vec2f) -> f32 {
  return valueNoise(p) * 0.55 + valueNoise(p * 2.03 + 17.1) * 0.3 + valueNoise(p * 4.1 + 41.7) * 0.15;
}

/** Low-frequency meadow tint so the grass isn't one flat green. */
fn meadowColor(base: vec3f, xz: vec2f) -> vec3f {
  let t = valueNoise(xz * 0.045) * 0.7 + valueNoise(xz * 0.17) * 0.3;
  let dry = base * vec3f(1.3, 1.12, 0.6);
  let lush = base * vec3f(0.82, 1.04, 0.9);
  return mix(lush, dry, smoothstep(0.35, 0.85, t));
}

/** Cloud density (0-1) of the cloud layer at a horizontal position. */
fn cloudDensity(xz: vec2f) -> f32 {
  let drift = frame.wind.xy * frame.cameraPos.w * frame.weather.y;
  let n = fbm((xz + drift) * 0.0045);
  let cover = frame.weather.x;
  return smoothstep(1.0 - cover - 0.05, 1.0 - cover + 0.25, n);
}

/** Fraction of key light that gets through the clouds above a point. */
fn cloudLight(world: vec3f) -> f32 {
  let l = frame.sunDir.xyz;
  let t = (CLOUD_HEIGHT - world.y) / max(l.y, 0.08);
  return 1.0 - 0.6 * cloudDensity(world.xz + l.xz * t);
}

/** Sky radiance along a view direction (no sun/moon discs), shared by sky, fog and water. */
fn skyColor(dir: vec3f) -> vec3f {
  let up = clamp(dir.y, -1.0, 1.0);
  let h = pow(1.0 - max(up, 0.0), 5.0);
  var c = mix(frame.skyZenith.rgb, frame.skyHorizon.rgb, h);
  c = mix(c, frame.skyHorizon.rgb * 0.8, smoothstep(0.0, -0.3, up));
  let s = max(dot(dir, frame.sunPos.xyz), 0.0);
  let glow = mix(vec3f(1.0, 0.55, 0.25), vec3f(1.0, 0.9, 0.75), clamp(frame.sunPos.y * 3.0, 0.0, 1.0));
  c += glow * frame.sunPos.w * (pow(s, 6.0) * 0.18 + pow(s, 48.0) * 0.5);
  let m = max(dot(dir, frame.moonDir.xyz), 0.0);
  c += vec3f(0.55, 0.65, 1.0) * frame.moonDir.w * pow(m, 24.0) * 0.08;
  return c;
}
`;

/** Lighting helpers for shaders that receive shadows (group 0 bindings 1 and 2). */
export const lightingWgsl = commonWgsl + /* wgsl */ `
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;

const POISSON = array<vec2f, 12>(
  vec2f(-0.326, -0.406), vec2f(-0.840, -0.074), vec2f(-0.696, 0.457), vec2f(-0.203, 0.621),
  vec2f(0.962, -0.195), vec2f(0.473, -0.480), vec2f(0.519, 0.767), vec2f(0.185, -0.893),
  vec2f(0.507, 0.064), vec2f(0.896, 0.412), vec2f(-0.322, -0.933), vec2f(-0.792, -0.598));

fn shadowAt(world: vec3f, n: vec3f) -> f32 {
  let p = frame.lightViewProj * vec4f(world + n * 0.05, 1.0);
  let ndc = p.xyz / p.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + 0.5;
  let texel = 1.8 / vec2f(textureDimensions(shadowMap));
  // Rotate the disc per pixel so the 12 taps blur into soft penumbrae instead of banding.
  let a = hash21(floor(world.xz * 37.0) + world.y) * 6.2831853;
  let rot = mat2x2f(cos(a), sin(a), -sin(a), cos(a));
  var sum = 0.0;
  for (var i = 0; i < 12; i++) {
    sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + rot * POISSON[i] * texel, ndc.z);
  }
  let inside = all(uv > vec2f(0.0)) && all(uv < vec2f(1.0)) && ndc.z < 1.0;
  return select(1.0, sum / 12.0, inside);
}

/** Four hardware-filtered taps: cheap enough for every grass vertex or water pixel. */
fn shadowFast(world: vec3f) -> f32 {
  let p = frame.lightViewProj * vec4f(world, 1.0);
  let ndc = p.xyz / p.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + 0.5;
  let t = 1.2 / vec2f(textureDimensions(shadowMap));
  let sum = textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(-t.x, -t.y * 0.5), ndc.z) +
    textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(t.x * 0.5, -t.y), ndc.z) +
    textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(t.x, t.y * 0.5), ndc.z) +
    textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(-t.x * 0.5, t.y), ndc.z);
  let inside = all(uv > vec2f(0.0)) && all(uv < vec2f(1.0)) && ndc.z < 1.0;
  return select(1.0, sum * 0.25, inside);
}

/** Direct key light reaching a point: shadows and clouds. */
fn keyLight(world: vec3f, n: vec3f) -> f32 {
  return shadowAt(world, n) * cloudLight(world);
}

fn keyLightFast(world: vec3f) -> f32 {
  return shadowFast(world) * cloudLight(world);
}

/** Lambert key light (with optional wrap) plus hemispheric sky/ground fill. */
fn shadeWith(albedo: vec3f, n: vec3f, light: f32, ao: f32, wrap: f32) -> vec3f {
  let l = frame.sunDir.xyz;
  let ndl = clamp((dot(n, l) + wrap) / (1.0 + wrap), 0.0, 1.0);
  let direct = frame.sunColor.rgb * frame.sunDir.w * ndl * light;
  let hemi = mix(frame.groundAmbient.rgb, frame.skyZenith.rgb, n.y * 0.5 + 0.5);
  return albedo * (direct + hemi * frame.sunColor.w * ao);
}

fn shade(albedo: vec3f, n: vec3f, world: vec3f, ao: f32, wrap: f32) -> vec3f {
  return shadeWith(albedo, n, keyLight(world, n), ao, wrap);
}

/** Aerial perspective: distant things fade toward the sky color in their direction. */
fn fog(color: vec3f, world: vec3f) -> vec3f {
  let v = world - frame.cameraPos.xyz;
  let d = max(length(v) - 90.0, 0.0);
  let f = 1.0 - exp(-d * frame.skyHorizon.w);
  return mix(color, skyColor(normalize(vec3f(v.x, max(v.y, 0.0), v.z))) * 0.9, f);
}
`;
