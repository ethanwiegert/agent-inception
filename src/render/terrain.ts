import { type BlockRegistry, MAX_BLOCKS, Pattern } from "../sim/blocks.ts";
import { CHUNK, World } from "../sim/world.ts";
import { aabbVisible } from "../math.ts";
import { frameWgsl, lightingWgsl } from "./frame.ts";
import { meshChunk } from "./mesher.ts";
import { grassWeightWgsl, type SurfaceTexture } from "./surface.ts";
import type { Layouts } from "./renderer.ts";

const P = Pattern;
const shader = frameWgsl + lightingWgsl + grassWeightWgsl + /* wgsl */ `
@group(1) @binding(0) var<storage, read> chunkOrigins: array<vec4f>;
/** Per block id: linear rgb, pattern index + glow (its fraction, 0-0.99). */
@group(1) @binding(1) var<storage, read> blockInfo: array<vec4f, ${MAX_BLOCKS}>;
@group(1) @binding(2) var surface: texture_2d<u32>;

fn natural(b: u32) -> bool {
  return b == 1u || b == 2u || b == 6u || b == 7u || b == 8u;
}

struct Vertex { pos: vec3f, normal: vec3f, face: u32, ao: f32, block: u32 };

fn unpack(v: u32, nrm: u32, chunk: u32) -> Vertex {
  let local = vec3f(f32(v & 63u), f32((v >> 6u) & 127u), f32((v >> 13u) & 63u));
  let aoLevels = array<f32, 4>(0.45, 0.65, 0.83, 1.0);
  return Vertex(
    chunkOrigins[chunk].xyz + local,
    unpack4x8snorm(nrm).xyz,
    (v >> 19u) & 7u,
    aoLevels[(v >> 22u) & 3u],
    v >> 24u);
}

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) ao: f32,
  @location(3) @interpolate(flat) face: u32,
  @location(4) @interpolate(flat) block: u32,
};

@vertex fn vs(@location(0) packed: u32, @location(1) nrm: u32, @builtin(instance_index) chunk: u32) -> Out {
  let v = unpack(packed, nrm, chunk);
  return Out(frame.viewProj * vec4f(v.pos, 1.0), v.pos, v.normal, v.ao, v.face, v.block);
}

@vertex fn vsShadow(@location(0) packed: u32, @location(1) nrm: u32, @builtin(instance_index) chunk: u32) -> @builtin(position) vec4f {
  return frame.lightViewProj * vec4f(unpack(packed, nrm, chunk).pos, 1.0);
}

fn faceNormalXZ(face: u32) -> vec2f {
  let n = array<vec2f, 6>(vec2f(1.0, 0.0), vec2f(-1.0, 0.0), vec2f(0.0), vec2f(0.0), vec2f(0.0, 1.0), vec2f(0.0, -1.0));
  return n[face];
}

/** 2D coordinates across a face, in blocks. */
fn faceUV(world: vec3f, face: u32) -> vec2f {
  if (face < 2u) { return world.zy; }
  if (face < 4u) { return world.xz; }
  return world.xy;
}

fn dirtTone(uv: vec2f) -> f32 {
  return (0.85 + 0.3 * valueNoise(uv * 4.0)) * (0.9 + 0.2 * valueNoise(uv * 13.0));
}

fn patternAlbedo(pattern: u32, base: vec3f, world: vec3f, face: u32) -> vec3f {
  let uv = faceUV(world, face);
  let top = face == 2u || face == 3u;
  switch pattern {
    case ${P.grass}u: {
      let painterly = frame.lookParams.y;
      var green = meadowColor(frame.grassBase.rgb, world.xz) * mix(0.85, 0.96, painterly);
      // Lusher close to the waterline; the field map's shore distance fades it inland.
      let shoreLush = smoothstep(0.64, 0.52, fieldAt(world.xz).y);
      green = mix(green, green * vec3f(0.82, 1.07, 0.9), shoreLush * 0.7);
      if (face == 2u) {
        // Velvety painterly moss mottling (warm sunlit olive-gold pockets + cool sage patches).
        let blotch = valueNoise(world.xz * 0.65 + 11.3);
        let micro = valueNoise(world.xz * 3.8 + 4.7);
        let warmMoss = meadowColor(frame.grassTip.rgb, world.xz) * 0.84;
        let velvety = mix(green * (0.9 + 0.16 * micro), warmMoss, smoothstep(0.38, 0.78, blotch) * 0.52);
        let nearCol = mix(green, velvety, painterly);
        // Past the blades' reach the ground stands in for them: fade from shaded roots to the
        // canopy's color so the edge of the grass doesn't show as a darker band on far hills.
        let far = smoothstep(frame.grass.w * 0.55, frame.grass.w, distance(world.xz, frame.grassCenter.xy));
        let canopy = mix(nearCol, meadowColor(frame.grassTip.rgb, world.xz) * 0.84, 0.5);
        return mix(nearCol, canopy, far);
      }
      // Side faces: thick scalloped mossy overhang draping over hand-carved diorama stone & warm earth!
      let outward = vec2i(faceNormalXZ(face));
      let c = vec2i(floor(world.xz - faceNormalXZ(face) * 0.5));
      let s = textureLoad(surface, c, 0);
      let n = textureLoad(surface, clamp(c + outward, vec2i(0), vec2i(textureDimensions(surface)) - 1), 0);
      if (i32(s.r) - i32(n.r) <= 1 && u32(floor(world.y)) == s.r) { return green * 0.92; }
      let wave = valueNoise(vec2f(uv.x * 3.2, floor(world.y) * 2.1)) * 0.65 +
        valueNoise(vec2f(uv.x * 7.5 + 3.1, floor(world.y) * 1.3)) * 0.35;
      let cutoff = mix(0.78 + 0.1 * hash21(floor(world.xz * 4.0 + world.y)), 0.66 + 0.16 * wave, painterly);
      let fringe = smoothstep(cutoff - 0.05 * painterly, cutoff + 0.02, fract(world.y));
      // Hand-carved mossy stone blocks & warm terracotta earth underneath the moss cap (mockup 01/02/06).
      let row = floor(uv.y * 2.0);
      let bu = uv.x * 1.5 + row * 0.45;
      let vSeam = smoothstep(0.06, 0.0, fract(bu));
      let hSeam = smoothstep(0.08, 0.0, fract(uv.y * 2.0));
      let mortar = max(hSeam, vSeam);
      let stoneTone = 0.86 + 0.2 * hash21(vec2f(floor(bu), row));
      let carvedStone = vec3f(0.32, 0.27, 0.2) * stoneTone * dirtTone(uv) * (1.0 - 0.28 * mortar);
      let earth = mix(vec3f(0.2, 0.11, 0.055) * dirtTone(uv), carvedStone, painterly * 0.85);
      // Soft dark moss shadow lip directly beneath the scalloped overhang.
      let lipShadow = smoothstep(cutoff - 0.14, cutoff - 0.02, fract(world.y)) * (1.0 - fringe) * painterly;
      let mossCap = mix(green * 0.92, meadowColor(frame.grassTip.rgb, world.xz) * 0.95, smoothstep(cutoff, 1.0, fract(world.y)) * 0.55);
      return mix(earth * (1.0 - 0.28 * lipShadow), mossCap, fringe);
    }
    case ${P.dirt}u: { return base * dirtTone(uv); }
    case ${P.farmland}u: {
      if (face != 2u) { return vec3f(0.2, 0.11, 0.055) * dirtTone(uv); }
      let furrow = 0.7 + 0.3 * smoothstep(0.2, 0.5, abs(fract(world.z * 3.0) - 0.5));
      return base * furrow * (0.9 + 0.2 * valueNoise(uv * 9.0));
    }
    case ${P.stone}u: {
      let painterly = frame.lookParams.y;
      let crack = smoothstep(0.03, 0.0, abs(valueNoise(uv * 2.5) - 0.5));
      let row = floor(uv.y * 2.0);
      let bu = uv.x * 1.5 + row * 0.5;
      let joint = max(smoothstep(0.08, 0.0, fract(uv.y * 2.0)), smoothstep(0.06, 0.0, fract(bu)));
      let stone = base * (0.8 + 0.3 * fbm(uv * 1.7)) * (1.0 - 0.3 * crack) * (1.0 - 0.25 * joint * painterly);
      // Subtle moss tucked into upper crevices on miniature cliffs.
      let moss = smoothstep(0.55, 0.85, valueNoise(uv * 2.2 + 7.1)) * smoothstep(0.45, 0.95, fract(world.y)) * painterly * 0.38;
      return mix(stone, meadowColor(frame.grassBase.rgb, world.xz) * 0.95, moss);
    }
    case ${P.sand}u: {
      return base * (0.9 + 0.08 * valueNoise(uv * 3.0) + 0.1 * valueNoise(uv * 23.0));
    }
    case ${P.planks}u: {
      let board = floor(uv.y * 4.0);
      let grain = valueNoise(vec2f(uv.x * 1.2 + board * 3.1, uv.y * 40.0));
      let gap = smoothstep(0.06, 0.0, fract(uv.y * 4.0));
      return base * (0.85 + 0.15 * hash21(vec2f(board, floor(uv.x))) + 0.12 * grain) * (1.0 - 0.5 * gap);
    }
    case ${P.bricks}u: {
      let row = floor(uv.y * 4.0);
      let bu = uv.x * 2.0 + row * 0.5;
      let mortar = max(smoothstep(0.07, 0.0, fract(uv.y * 4.0)), smoothstep(0.04, 0.0, fract(bu)));
      let tone = 0.85 + 0.25 * hash21(vec2f(floor(bu), row));
      return mix(base * tone * (0.92 + 0.1 * valueNoise(uv * 20.0)), vec3f(0.55, 0.53, 0.5), mortar);
    }
    case ${P.log}u: {
      if (top) {
        let r = length(fract(uv) - 0.5);
        return base * vec3f(1.5, 1.35, 1.1) * (0.85 + 0.15 * sin(r * 40.0)) * (1.0 - 0.4 * smoothstep(0.42, 0.5, r));
      }
      return base * (0.7 + 0.35 * valueNoise(vec2f(uv.x * 9.0, uv.y * 1.2)));
    }
    case ${P.thatch}u: {
      let straw = valueNoise(vec2f(uv.x * 28.0 + uv.y * 4.0, uv.y * 2.5));
      return base * (0.75 + 0.4 * straw) * (1.0 - 0.25 * smoothstep(0.7, 1.0, fract(uv.y * 3.0)));
    }
    case ${P.cobble}u: {
      let n = valueNoise(uv * 3.0) + 0.5 * valueNoise(uv * 6.0);
      let gap = smoothstep(0.12, 0.0, abs(fract(n * 2.5) - 0.5));
      return base * (0.8 + 0.3 * hash21(floor(uv * 3.0 + n))) * (1.0 - 0.45 * gap);
    }
    case ${P.tiles}u: {
      let row = fract(uv.y * 3.0);
      let col = fract(uv.x * 3.0 + floor(uv.y * 3.0) * 0.5);
      let edge = smoothstep(0.75, 1.0, row) + smoothstep(0.06, 0.0, col) * 0.6;
      return base * (0.9 + 0.15 * hash21(floor(uv * 3.0))) * (1.0 - 0.35 * clamp(edge, 0.0, 1.0));
    }
    default: { return base * (0.93 + 0.1 * valueNoise(uv * 6.0)); }
  }
}

/** Relief height per pattern (the gaps and joints in patternAlbedo): mortar, plank and tile
 * edges, furrows, cobble joints and strata are low, the faces between them high. */
fn patternHeight(pattern: u32, world: vec3f, face: u32) -> f32 {
  let uv = faceUV(world, face);
  switch pattern {
    case ${P.farmland}u: {
      return select(1.0, smoothstep(0.0, 0.45, abs(fract(world.z * 3.0) - 0.5) * 2.0), face == 2u);
    }
    case ${P.stone}u: { return valueNoise(uv * 2.5) * 0.4 + 0.5; }
    case ${P.planks}u: { return smoothstep(0.09, 0.16, fract(uv.y * 4.0)) * 0.7 + 0.3; }
    case ${P.bricks}u: {
      let row = floor(uv.y * 4.0);
      let bu = uv.x * 2.0 + row * 0.5;
      let mortar = max(smoothstep(0.11, 0.05, fract(uv.y * 4.0)), smoothstep(0.08, 0.02, fract(bu)));
      return 1.0 - mortar;
    }
    case ${P.log}u: {
      if (top(world, face)) { return 0.5 + 0.5 * sin(length(fract(uv) - 0.5) * 40.0); }
      return valueNoise(vec2f(uv.x * 9.0, uv.y * 1.2));
    }
    case ${P.cobble}u: {
      let n = valueNoise(uv * 3.0) + 0.5 * valueNoise(uv * 6.0);
      return 1.0 - smoothstep(0.16, 0.05, abs(fract(n * 2.5) - 0.5)) * 0.8;
    }
    case ${P.tiles}u: {
      let row = fract(uv.y * 3.0);
      let col = fract(uv.x * 3.0 + floor(uv.y * 3.0) * 0.5);
      return 1.0 - clamp(smoothstep(0.7, 0.95, row) + smoothstep(0.1, 0.02, col), 0.0, 1.0) * 0.6;
    }
    case ${P.thatch}u: { return 0.6 + 0.4 * valueNoise(vec2f(uv.x * 28.0 + uv.y * 4.0, uv.y * 2.5)); }
    default: { return 0.5; }
  }
}

fn top(world: vec3f, face: u32) -> bool { return face == 2u || face == 3u; }

/** Specular roughness per pattern: sand and plain ground stay rough, tiles and dressed stone shine. */
fn patternRough(pattern: u32) -> f32 {
  switch pattern {
    case ${P.tiles}u: { return 0.42; }
    case ${P.stone}u: { return 0.78; }
    case ${P.cobble}u: { return 0.85; }
    case ${P.planks}u: { return 0.8; }
    case ${P.bricks}u: { return 0.88; }
    case ${P.log}u: { return 0.9; }
    case ${P.thatch}u: { return 0.95; }
    case ${P.farmland}u, ${P.dirt}u: { return 0.95; }
    case ${P.grass}u, ${P.sand}u: { return 0.92; }
    default: { return 0.85; }
  }
}

/** Perturb the face normal by the screen-space gradient of the pattern's height field (classic
 * derivative bump mapping), fading out before the relief would shimmer at a distance. */
fn bumpNormal(n: vec3f, world: vec3f, h: f32) -> vec3f {
  // Derivatives must all run in uniform control flow, so every dpdx/dpdy comes first.
  let dpx = dpdx(world);
  let dpy = dpdy(world);
  let dhx = dpdx(h);
  let dhy = dpdy(h);
  let foot = max(length(dpx), length(dpy));
  let fade = 1.0 - smoothstep(0.2, 0.9, foot);
  let t0 = dpx - n * dot(n, dpx);
  let tl = max(length(t0), 1e-4);
  let t = t0 / tl;
  let b = cross(n, t);
  let hx = dhx / tl;
  let hy = dhy / max(length(dpy), 1e-4);
  let bumped = normalize(n - (t * hx + b * hy) * 0.4 * fade);
  return select(bumped, n, fade <= 0.0 || length(t0) < 1e-5);
}

/**
 * Natural ground tops blend across material edges along organic boundaries rather than block
 * steps: grass by the same edge the grass blades use, so meadow and beach meet in curves; other
 * ground (sand, gravel, clay, dirt) by reading the column under a noise-wobbled position, so
 * riverbed patches are blobs, not squares. Only neighbours within a block of height blend.
 */
fn groundMaterial(block: u32, world: vec3f) -> u32 {
  let c = vec2i(floor(world.xz));
  let s = textureLoad(surface, c, 0);
  if (s.g != block || !natural(block)) { return block; }
  let grassy = isGrassy(s, world.xz);
  if (grassy) { return 1u; }
  let last = vec2i(textureDimensions(surface)) - 1;
  if (block != 1u) {
    let wobble = vec2f(valueNoise(world.xz * 1.3), valueNoise(world.xz * 1.3 + 31.7)) - 0.5 +
      (vec2f(valueNoise(world.xz * 4.1 + 7.3), valueNoise(world.xz * 4.1 + 3.9)) - 0.5) * 0.35;
    let q = vec2i(floor(world.xz + wobble * 0.9));
    if (all(q == c)) { return block; }
    let n = textureLoad(surface, clamp(q, vec2i(0), last), 0);
    let near = abs(i32(n.r) - i32(s.r)) <= 1;
    if (near && n.g != 1u && natural(n.g)) { return n.g; }
    return block;
  }
  // A grass column on the losing side of the edge: borrow the neighbouring material.
  let d = vec2i(select(-1, 1, fract(world.x) >= 0.5), select(-1, 1, fract(world.z) >= 0.5));
  let offsets = array<vec2i, 3>(vec2i(d.x, 0), vec2i(0, d.y), d);
  for (var i = 0; i < 3; i++) {
    let nb = textureLoad(surface, clamp(c + offsets[i], vec2i(0), last), 0).g;
    if (nb != 1u && natural(nb)) { return nb; }
  }
  return block;
}

/** How wet the ground at world is (0-1): the field map's shore distance, with a noise
 * wobble so the band wiggles at any angle. g is 0.5 at the waterline and rises inland. */
fn wetness(world: vec3f) -> f32 {
  let g = fieldAt(world.xz).y + (valueNoise(world.xz * 2.1) - 0.5) * 0.05;
  return smoothstep(0.64, 0.53, g);
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  let block = select(in.block, groundMaterial(in.block, in.world), in.face == 2u);
  let info = blockInfo[block];
  let n = normalize(in.normal);
  let cell = floor(in.world - n * 0.5);
  let jitter = 0.95 + 0.1 * hash21(cell.xz + cell.y * 17.0);
  var albedo = patternAlbedo(u32(info.w), info.rgb, in.world, in.face) * jitter;
  let s = textureLoad(surface, vec2i(floor(in.world.xz)), 0);
  let depth = f32(s.a) - 0.12 - in.world.y;
  // Bare ground at the waterline is wet: darker and richer, along a wobbling edge. Under the
  // water the absorption below takes over.
  if (in.face == 2u && block != 1u && natural(block) && (s.a == 0u || depth < 0.3)) {
    let above = 1.0 - smoothstep(0.0, 0.3, select(depth, 0.0, s.a == 0u));
    albedo *= mix(vec3f(1.0), vec3f(0.6, 0.64, 0.7), wetness(in.world) * above);
  }
  // The meadow floor takes the blades' clump and occlusion terms, so thin or sparse grass never
  // exposes a flat green sheet underneath.
  if (in.face == 2u && block == 1u) {
    albedo *= 0.85 + 0.3 * valueNoise(in.world.xz * 0.3);
  }
  // The field map: ambient falls off under crowns and at the foot of cliffs and walls, and
  // villagers/animals sit in a soft contact blob.
  let field = fieldAt(in.world.xz);
  if (in.face == 2u && block == 1u) { albedo *= mix(1.0, field.x, 0.5); }
  let ao = mix(1.0, in.ao, frame.groundAmbient.w) * mix(1.0, field.x, 0.8) *
    (1.0 - pusherShade(in.world.xz) * 0.4);
  let pattern = u32(info.w);
  let h = patternHeight(pattern, in.world, in.face);
  let n2 = bumpNormal(n, in.world, h);
  var color = shade(albedo, n2, in.world, ao, 0.0) +
    selfLit(albedo * fract(info.w) * EMISSIVE * mix(1.0, 1.8, frame.extra.x));

  // One specular lobe for the key light and a Fresnel-weighted sky sheen for smooth or wet
  // surfaces: stone and tiles get a soft sheen, the wet band goes glossy.
  let view = normalize(frame.cameraPos.xyz - in.world);
  var rough = patternRough(pattern);
  if (in.face == 2u) { rough = mix(rough, 0.2, wetness(in.world)); }
  let gloss = 1.0 - rough;
  if (gloss > 0.03) {
    let hdir = normalize(view + frame.sunDir.xyz);
    color += frame.sunColor.rgb * frame.sunDir.w * keyLight(in.world, n2) *
      pow(max(dot(n2, hdir), 0.0), mix(10.0, 200.0, gloss * gloss)) * gloss * gloss * 0.55;
    color += skyColor(reflect(-view, n2)) * pow(1.0 - max(dot(n2, view), 0.0), 5.0) * gloss * 0.6;
  }

  // Cliff faces: strata bands and darker seams on tall stone and dirt sides, moss where the
  // field map says the face is shaded and grass is near.
  let painterly = frame.lookParams.y;
  if (in.face != 2u && natural(block)) {
    let col = hash21(floor(in.world.xz));
    let strata = 0.9 + 0.1 * sin(in.world.y * 2.3 + col * 9.0) +
      0.08 * valueNoise(vec2f(in.world.y * 1.4, col * 5.0));
    let seam = smoothstep(0.85, 0.98, sin(in.world.y * 1.9 + col * 6.0));
    color *= strata * (1.0 - 0.28 * seam);
    let mossBase = smoothstep(0.6 + 0.25 * painterly, 0.25, field.x) *
      smoothstep(0.6 + 0.2 * painterly, 0.3, field.y);
    let moss = mossBase * smoothstep(0.4 - 0.1 * painterly, 0.7, valueNoise(in.world.xz * 2.6 + in.world.y));
    color = mix(color, vec3f(0.11, 0.24, 0.065) * dirtTone(faceUV(in.world, in.face)) *
      (frame.skyZenith.rgb * frame.sunColor.w * 0.55 + frame.groundAmbient.rgb * 0.35 +
        keyLight(in.world, n2) * frame.sunColor.rgb * frame.sunDir.w), moss * mix(0.7, 0.88, painterly));
  }
  // Miniature tactile bevel on non-natural built blocks and cliff steps (subtle carved edge shade).
  if (painterly > 0.01 && (!natural(block) || in.face != 2u)) {
    let fuv = fract(faceUV(in.world, in.face));
    let edge = min(min(fuv.x, 1.0 - fuv.x), min(fuv.y, 1.0 - fuv.y));
    let bevel = smoothstep(0.0, 0.08, edge);
    let topEdge = smoothstep(0.86, 0.96, fuv.y) * select(0.0, 1.0, in.face != 2u && in.face != 3u);
    color *= mix(1.0, 0.86 + 0.14 * bevel + topEdge * 0.08, painterly * 0.85);
  }

  // Under water: light is absorbed with depth (red first) and dances in caustics.
  if (s.a > 0u && depth > 0.0) {
    let t = frame.cameraPos.w;
    let q = in.world.xz * 1.3;
    let c1 = valueNoise(q + vec2f(t * 0.35, t * 0.2));
    let c2 = valueNoise(q * 1.7 - vec2f(t * 0.25, -t * 0.3));
    let caustic = pow(1.0 - abs(c1 - c2), 6.0) * smoothstep(0.0, 0.6, depth) * exp(-depth * 0.5);
    color += albedo * frame.sunColor.rgb * frame.sunDir.w * caustic * 0.5 * keyLight(in.world, n);
    color *= exp(-depth * vec3f(0.85, 0.36, 0.26));
  }
  return vec4f(fog(color, in.world), 1.0);
}
`;

interface ChunkMesh {
  buffer: GPUBuffer | null;
  quads: number;
  version: number;
}

const srgbToLinear = (c: number) => Math.pow(c / 255, 2.2);

/** Owns chunk meshes and draws them; remeshes chunks whose world version changed. */
export class TerrainRenderer {
  private chunks: ChunkMesh[];
  private indexBuffer: GPUBuffer | null = null;
  private originBuffer: GPUBuffer;
  private indexQuads = 0;
  private bindGroup: GPUBindGroup;
  private paletteBuffer: GPUBuffer;
  private palette = new Float32Array(MAX_BLOCKS * 4);
  private paletteVersion = -1;
  private pipeline: GPURenderPipeline;
  private shadowPipeline: GPURenderPipeline;

  constructor(
    private device: GPUDevice,
    private world: World,
    surface: SurfaceTexture,
    layouts: Layouts,
  ) {
    this.chunks = Array.from(
      { length: world.chunksX * world.chunksZ },
      () => ({ buffer: null, quads: 0, version: 0 }),
    );

    const origins = new Float32Array(this.chunks.length * 4);
    for (let i = 0; i < this.chunks.length; i++) {
      origins[i * 4] = (i % world.chunksX) * CHUNK;
      origins[i * 4 + 2] = Math.floor(i / world.chunksX) * CHUNK;
    }
    this.originBuffer = device.createBuffer({
      size: origins.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.originBuffer, 0, origins);
    this.paletteBuffer = device.createBuffer({
      size: this.palette.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const storage = (binding: number, visibility: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility,
      buffer: { type: "read-only-storage" },
    });
    const chunkLayout = device.createBindGroupLayout({
      entries: [
        storage(0, GPUShaderStage.VERTEX),
        storage(1, GPUShaderStage.FRAGMENT),
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
      ],
    });
    this.bindGroup = device.createBindGroup({
      layout: chunkLayout,
      entries: [
        { binding: 0, resource: { buffer: this.originBuffer } },
        { binding: 1, resource: { buffer: this.paletteBuffer } },
        { binding: 2, resource: surface.view },
      ],
    });

    const module = device.createShaderModule({ code: shader, label: "terrain" });
    const vertex: GPUVertexState = {
      module,
      entryPoint: "vs",
      buffers: [{
        arrayStride: 8,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "uint32" },
          { shaderLocation: 1, offset: 4, format: "uint32" },
        ],
      }],
    };
    this.pipeline = device.createRenderPipeline({
      label: "terrain",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, chunkLayout] }),
      vertex,
      fragment: { module, entryPoint: "fs", targets: [{ format: layouts.colorFormat }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: { format: layouts.depthFormat, depthWriteEnabled: true, depthCompare: "less" },
      multisample: { count: layouts.samples },
    });
    this.shadowPipeline = device.createRenderPipeline({
      label: "terrain-shadow",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [layouts.shadowFrame, chunkLayout],
      }),
      vertex: { ...vertex, entryPoint: "vsShadow" },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: "less",
        depthBias: 2,
        depthBiasSlopeScale: 2.5,
      },
    });
  }

  /** Upload block colors and patterns when the registry changed (e.g. an agent defined a block). */
  setBlocks(blocks: BlockRegistry) {
    if (blocks.version === this.paletteVersion) return;
    this.paletteVersion = blocks.version;
    for (let id = 0; id < MAX_BLOCKS; id++) {
      const def = blocks.get(id);
      if (!def) continue;
      const c = def.color;
      this.palette.set(
        [
          srgbToLinear(c >> 16),
          srgbToLinear((c >> 8) & 255),
          srgbToLinear(c & 255),
          Pattern[def.pattern] + Math.min(0.99, def.glows),
        ],
        id * 4,
      );
    }
    this.device.queue.writeBuffer(this.paletteBuffer, 0, this.palette);
  }

  /** Remesh chunks whose world version moved. Returns how many were rebuilt. */
  update(): number {
    let rebuilt = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      const version = this.world.chunkVersion[i];
      if (chunk.version === version) continue;
      const verts = meshChunk(
        this.world,
        i % this.world.chunksX,
        Math.floor(i / this.world.chunksX),
      );
      chunk.buffer?.destroy();
      chunk.buffer = null;
      chunk.quads = verts.length / 8;
      chunk.version = version;
      if (chunk.quads > 0) {
        chunk.buffer = this.device.createBuffer({
          size: verts.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(chunk.buffer, 0, verts);
        this.ensureIndices(chunk.quads);
      }
      rebuilt++;
    }
    return rebuilt;
  }

  /** Draw chunks whose bounds intersect the view frustum `planes`. */
  draw(pass: GPURenderPassEncoder, planes: Float32Array) {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(1, this.bindGroup);
    this.drawChunks(pass, planes);
  }

  /** Draw into the shadow map the chunks inside the light's frustum `planes`. */
  drawShadow(pass: GPURenderPassEncoder, planes: Float32Array) {
    pass.setPipeline(this.shadowPipeline);
    pass.setBindGroup(1, this.bindGroup);
    this.drawChunks(pass, planes);
  }

  private drawChunks(pass: GPURenderPassEncoder, planes: Float32Array) {
    if (!this.indexBuffer) return;
    pass.setIndexBuffer(this.indexBuffer, "uint32");
    const { chunksX } = this.world, h = this.world.sizeY;
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      if (!chunk.buffer) continue;
      const x = (i % chunksX) * CHUNK, z = Math.floor(i / chunksX) * CHUNK;
      if (!aabbVisible(planes, x, 0, z, x + CHUNK, h, z + CHUNK)) continue;
      pass.setVertexBuffer(0, chunk.buffer);
      pass.drawIndexed(chunk.quads * 6, 1, 0, 0, i);
    }
  }

  private ensureIndices(quads: number) {
    if (quads <= this.indexQuads) return;
    this.indexQuads = Math.max(quads, this.indexQuads * 2, 4096);
    const indices = new Uint32Array(this.indexQuads * 6);
    for (let q = 0; q < this.indexQuads; q++) {
      const v = q * 4;
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6);
    }
    this.indexBuffer?.destroy();
    this.indexBuffer = this.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.indexBuffer, 0, indices);
  }

  destroy() {
    for (const chunk of this.chunks) chunk.buffer?.destroy();
    this.indexBuffer?.destroy();
    this.originBuffer.destroy();
    this.paletteBuffer.destroy();
  }
}
