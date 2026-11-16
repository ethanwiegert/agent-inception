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
  grassBase: 72, // rgb, mist over low ground 0-1
  grassTip: 76, // rgb, flower chance
  grass: 80, // blade height, blade width, blades per block, radius (blocks)
  grassCenter: 84, // center x, center z, world size x, world size z
  wind: 88, // dir x, dir z, strength, grass radius / old-FOV grass radius
  grade: 92, // saturation, contrast, warmth, vignette
  extra: 96, // star visibility, 1 - moonlit grading, sea level, 1 if anything casts lamplight
  sunPos: 100, // xyz toward the sun, visibility
  moonDir: 104, // xyz toward the moon, brightness
  weather: 108, // cloud cover 0-1, cloud drift speed, ticks since the crops were sent, bloom
  depthParams: 112, // camera near, camera far, 1/width, 1/height of the scene depth
  /** Villagers and animals nearest the camera target: xyz, radius (0 = slot unused). */
  pushers: 116,
  /** The wide shadow cascade (±260 blocks around the target), drawn at most every other frame. */
  lightViewProj1: 180,
  size: 116 + 16 * 4 + 16,
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
  depthParams: vec4f,
  pushers: array<vec4f, 16>,
  lightViewProj1: mat4x4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
`;

/** Noise, sky and cloud helpers that only need the frame uniforms. */
export const commonWgsl = /* wgsl */ `
const CLOUD_HEIGHT = 260.0;

/** View distance of a raw depth-buffer value (camera.ts's perspective, near/far in depthParams). */
fn linearDepth(d: f32) -> f32 {
  let n = frame.depthParams.x;
  let f = frame.depthParams.y;
  return n * f / (f - d * (f - n));
}

/** The world position of the pixel on screen (from its depth), via the inverse view projection. */
fn worldAt(pixel: vec2f, d: f32) -> vec3f {
  let ndc = vec4f(pixel.x * frame.depthParams.z * 2.0 - 1.0,
    1.0 - pixel.y * frame.depthParams.w * 2.0, d, 1.0);
  let w = frame.invViewProj * ndc;
  return w.xyz / w.w;
}

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
  let lo = 0.95 - frame.weather.x;
  return smoothstep(lo - 0.03, lo + 0.2, n);
}

/**
 * The same layer as the sky draws it: the shadow-casting shape with its edges firmed up and
 * eroded by finer noise, so clouds read as heaps rather than smears. Sky pixels only. Returns
 * the density and the fine noise (the billows, to shade by).
 */
fn cloudShape(xz: vec2f) -> vec2f {
  let drift = frame.wind.xy * frame.cameraPos.w * frame.weather.y;
  let q = (xz + drift) * 0.0045;
  let fine = valueNoise(q * 6.1 + vec2f(3.7, 9.2)) * 0.6 + valueNoise(q * 13.7 + vec2f(21.3, 4.4)) * 0.4;
  let lo = 0.95 - frame.weather.x;
  return vec2f(smoothstep(lo - 0.03, lo + 0.13, fbm(q) + (fine - 0.5) * 0.14), fine);
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
  // Around sunrise and sunset a warm band hugs the horizon, deepest on the sun's side.
  let twilight = clamp(1.0 - abs(frame.sunPos.y) / 0.25, 0.0, 1.0);
  let flat = vec2f(dir.x, dir.z);
  let sunFlat = vec2f(frame.sunPos.x, frame.sunPos.z);
  let toward = dot(flat, sunFlat) / max(length(flat) * length(sunFlat), 1e-4) * 0.5 + 0.5;
  let band = exp(-max(up, 0.0) * 9.0) * twilight * (0.25 + 0.75 * toward * toward);
  // (Over the exposure: the band and the sun's glow show as bright at dusk as by day, or the
  // eyes adjusting would wash the sunset out.)
  c += vec3f(1.0, 0.42, 0.14) * band * 0.55 / frame.skyZenith.w;
  let s = max(dot(dir, frame.sunPos.xyz), 0.0);
  let glow = mix(vec3f(1.0, 0.55, 0.25), vec3f(1.0, 0.9, 0.75), clamp(frame.sunPos.y * 3.0, 0.0, 1.0));
  c += glow * frame.sunPos.w * (pow(s, 6.0) * 0.18 + pow(s, 48.0) * 0.5) / frame.skyZenith.w;
  let m = max(dot(dir, frame.moonDir.xyz), 0.0);
  c += vec3f(0.55, 0.65, 1.0) * frame.moonDir.w * pow(m, 24.0) * 0.08;
  return c;
}
`;

/**
 * Lighting helpers for shaders that receive shadows and lamplight (group 0 bindings 1-4): the
 * shadow map, its comparison sampler, and the light field (sim/light.ts) as a 3D texture over
 * every cell, rgb stored as square roots, alpha the share of fire (it flickers).
 */
export const lightingWgsl = commonWgsl + /* wgsl */ `
@group(0) @binding(1) var shadowMap: texture_depth_2d_array;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
@group(0) @binding(3) var lightField: texture_3d<f32>;
@group(0) @binding(4) var lightSampler: sampler;
// Binding 5: the field map (render/fieldmap.ts) — r sky occlusion, g shore distance.
@group(0) @binding(5) var fieldmap: texture_2d<f32>;
@group(0) @binding(6) var fieldmapSampler: sampler;

/** Column-wise (x, z) -> fieldmap uv: r open sky, g shore distance (0.5 = waterline). */
fn fieldAt(xz: vec2f) -> vec2f {
  return textureSampleLevel(fieldmap, fieldmapSampler, xz / frame.grassCenter.zw, 0.0).rg;
}

/** Soft contact shade under a pusher (villager or animal), 0 off, 1 centred on it. */
fn pusherShade(xz: vec2f) -> f32 {
  var dark = 0.0;
  for (var i = 0; i < 16; i++) {
    let p = frame.pushers[i];
    if (p.w <= 0.0) { continue; }
    let d = distance(xz, p.xz) / p.w;
    dark += max(0.0, 1.0 - d * d);
  }
  return min(dark, 1.0);
}

/** How bright the field's full light is, in the scene's HDR units. */
const LAMP_INTENSITY = 2.2;
/** How bright glowing Materials look in themselves. */
const EMISSIVE = 1.2;

/**
 * Light that shines by itself (glowing Materials, fire) as the scene sees it: eyes adjust to the
 * dark (the night exposure), but a lamp shouldn't blaze white for it.
 */
fn selfLit(c: vec3f) -> vec3f {
  return c / mix(1.0, frame.skyZenith.w, 0.7);
}

/** Lamplight reaching a surface at world with normal n: the field in the open cell in front of it. */
fn lampLight(world: vec3f, n: vec3f) -> vec3f {
  if (frame.extra.w <= 0.0) { return vec3f(0.0); }
  let size = vec3f(textureDimensions(lightField));
  let s = textureSampleLevel(lightField, lightSampler, (world + n * 0.45) / size, 0.0);
  let t = frame.cameraPos.w;
  let flicker = 1.0 + s.a * ((valueNoise(world.xz * 0.9 + vec2f(t * 6.0, t * 2.3)) - 0.5) * 0.7);
  // Eyes open up in the dark, but a lamp's pool of light shouldn't look like noon.
  return s.rgb * s.rgb * LAMP_INTENSITY * flicker / mix(1.0, frame.skyZenith.w, 0.6);
}

const POISSON = array<vec2f, 12>(
  vec2f(-0.326, -0.406), vec2f(-0.840, -0.074), vec2f(-0.696, 0.457), vec2f(-0.203, 0.621),
  vec2f(0.962, -0.195), vec2f(0.473, -0.480), vec2f(0.519, 0.767), vec2f(0.185, -0.893),
  vec2f(0.507, 0.064), vec2f(0.896, 0.412), vec2f(-0.322, -0.933), vec2f(-0.792, -0.598));

/**
 * The wide cascade (layer 1): four taps and a bigger normal bias suit its coarser texels. Shadows
 * fade out at its rim — the cloud-shadow term takes over beyond it.
 */
fn shadowWide(world: vec3f, n: vec3f) -> f32 {
  let p = frame.lightViewProj1 * vec4f(world + n * 0.2, 1.0);
  let ndc = p.xyz / p.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + 0.5;
  let inside = all(uv > vec2f(0.0)) && all(uv < vec2f(1.0)) && ndc.z < 1.0;
  if (!inside) { return 1.0; }
  let t = 1.5 / vec2f(textureDimensions(shadowMap).xy);
  let sum = textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(-t.x, -t.y), 1, ndc.z) +
    textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(t.x, -t.y), 1, ndc.z) +
    textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(-t.x, t.y), 1, ndc.z) +
    textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(t.x, t.y), 1, ndc.z);
  let rim = smoothstep(0.86, 0.98, max(abs(ndc.x), abs(ndc.y)));
  return mix(sum * 0.25, 1.0, rim);
}

fn shadowAt(world: vec3f, n: vec3f) -> f32 {
  let p = frame.lightViewProj * vec4f(world + n * 0.05, 1.0);
  let ndc = p.xyz / p.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + 0.5;
  let m = smoothstep(0.9, 1.0, max(abs(ndc.x), abs(ndc.y)));
  var s = 1.0;
  if (m < 1.0 && ndc.z < 1.0) {
    let texel = 1.8 / vec2f(textureDimensions(shadowMap).xy);
    // Rotate the disc per pixel so the 12 taps blur into soft penumbrae instead of banding.
    let a = hash21(floor(world.xz * 37.0) + world.y) * 6.2831853;
    let rot = mat2x2f(cos(a), sin(a), -sin(a), cos(a));
    var sum = 0.0;
    for (var i = 0; i < 12; i++) {
      sum += textureSampleCompareLevel(
        shadowMap, shadowSampler, uv + rot * POISSON[i] * texel, 0, ndc.z);
    }
    s = sum / 12.0;
  }
  // Blend into the wide cascade over the near box's last tenth: no seam, no pop when orbiting.
  if (m > 0.0) { s = mix(s, shadowWide(world, n), m); }
  return s;
}

/** Four hardware-filtered taps: cheap enough for every grass vertex or water pixel. */
fn shadowFast(world: vec3f) -> f32 {
  let p = frame.lightViewProj * vec4f(world, 1.0);
  let ndc = p.xyz / p.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + 0.5;
  let m = smoothstep(0.9, 1.0, max(abs(ndc.x), abs(ndc.y)));
  var s = 1.0;
  if (m < 1.0 && ndc.z < 1.0) {
    let t = 1.2 / vec2f(textureDimensions(shadowMap).xy);
    let sum =
      textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(-t.x, -t.y * 0.5), 0, ndc.z) +
      textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(t.x * 0.5, -t.y), 0, ndc.z) +
      textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(t.x, t.y * 0.5), 0, ndc.z) +
      textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(-t.x * 0.5, t.y), 0, ndc.z);
    s = sum * 0.25;
  }
  if (m > 0.0) { s = mix(s, shadowWide(world, vec3f(0.0, 1.0, 0.0)), m); }
  return s;
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

/**
 * Sunlight the ground throws back: it warms what faces down and away from the sun, so shade isn't
 * one flat sky blue. Nothing for what faces up (the ground itself, grass).
 */
fn groundBounce(n: vec3f) -> vec3f {
  return frame.groundAmbient.rgb * frame.sunDir.w * 0.1 *
    clamp(0.6 - n.y, 0.0, 1.0) * (0.5 - 0.5 * dot(n, frame.sunDir.xyz));
}

fn shade(albedo: vec3f, n: vec3f, world: vec3f, ao: f32, wrap: f32) -> vec3f {
  return shadeWith(albedo, n, keyLight(world, n), ao, wrap) +
    albedo * (lampLight(world, n) + groundBounce(n)) * ao;
}

/**
 * Aerial perspective: distant things fade toward the sky color in their direction. At dawn and
 * dusk a thin mist also pools over low ground and water, much nearer than the haze.
 */
fn fog(color: vec3f, world: vec3f) -> vec3f {
  let v = world - frame.cameraPos.xyz;
  let len = length(v);
  // Haze thins with height by day too: valleys keep more of it than the hilltops.
  let thin = mix(1.0, 0.45, clamp((world.y - frame.extra.z) / 90.0, 0.0, 1.0));
  var keep = exp(-max(len - 90.0, 0.0) * frame.skyHorizon.w * thin);
  if (frame.grassBase.w > 0.0) {
    let low = exp(-max(world.y - frame.extra.z - 1.5, 0.0) * 0.22);
    keep *= 1.0 - frame.grassBase.w * low * (1.0 - exp(-len * 0.009));
  }
  let dir = normalize(v);
  var scatter = skyColor(normalize(vec3f(dir.x, max(dir.y, 0.0), dir.z))) * 0.9;
  // The in-scatter leans toward the key light near its bearing, like real air.
  scatter += frame.sunColor.rgb * frame.sunDir.w * pow(max(dot(dir, frame.sunDir.xyz), 0.0), 5.0)
    * 0.12;
  return mix(scatter, color, keep);
}
`;
