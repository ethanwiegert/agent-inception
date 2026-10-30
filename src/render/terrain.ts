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
      var green = meadowColor(frame.grassBase.rgb, world.xz) * 0.85;
      if (face == 2u) {
        // Past the blades' reach the ground stands in for them: fade from shaded roots to the
        // canopy's color so the edge of the grass doesn't show as a darker band on far hills.
        let far = smoothstep(frame.grass.w * 0.55, frame.grass.w, distance(world.xz, frame.grassCenter.xy));
        let canopy = mix(green, meadowColor(frame.grassTip.rgb, world.xz) * 0.8, 0.55);
        return mix(green, canopy, far);
      }
      // One-block banks between slopes are turf; taller cliffs show dirt under a grass fringe.
      // Side fragments sit on the column boundary; step back inside to find the owning column.
      let outward = vec2i(faceNormalXZ(face));
      let c = vec2i(floor(world.xz - faceNormalXZ(face) * 0.5));
      let s = textureLoad(surface, c, 0);
      let n = textureLoad(surface, clamp(c + outward, vec2i(0), vec2i(textureDimensions(surface)) - 1), 0);
      if (i32(s.r) - i32(n.r) <= 1 && u32(floor(world.y)) == s.r) { return green * 0.9; }
      let fringe = step(0.78 + 0.1 * hash21(floor(world.xz * 4.0 + world.y)), fract(world.y));
      return mix(vec3f(0.2, 0.11, 0.055) * dirtTone(uv), green, fringe);
    }
    case ${P.dirt}u: { return base * dirtTone(uv); }
    case ${P.farmland}u: {
      if (face != 2u) { return vec3f(0.2, 0.11, 0.055) * dirtTone(uv); }
      let furrow = 0.7 + 0.3 * smoothstep(0.2, 0.5, abs(fract(world.z * 3.0) - 0.5));
      return base * furrow * (0.9 + 0.2 * valueNoise(uv * 9.0));
    }
    case ${P.stone}u: {
      let crack = smoothstep(0.03, 0.0, abs(valueNoise(uv * 2.5) - 0.5));
      return base * (0.78 + 0.35 * fbm(uv * 1.7)) * (1.0 - 0.35 * crack);
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

@fragment fn fs(in: Out) -> @location(0) vec4f {
  let block = select(in.block, groundMaterial(in.block, in.world), in.face == 2u);
  let info = blockInfo[block];
  let n = normalize(in.normal);
  let cell = floor(in.world - n * 0.5);
  let jitter = 0.95 + 0.1 * hash21(cell.xz + cell.y * 17.0);
  let albedo = patternAlbedo(u32(info.w), info.rgb, in.world, in.face) * jitter;
  let ao = mix(1.0, in.ao, frame.groundAmbient.w);
  var color = shade(albedo, n, in.world, ao, 0.0) + selfLit(albedo * fract(info.w) * EMISSIVE);

  // Under water: light is absorbed with depth (red first) and dances in caustics.
  let s = textureLoad(surface, vec2i(floor(in.world.xz)), 0);
  let depth = f32(s.a) - 0.12 - in.world.y;
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
    const originBuffer = device.createBuffer({
      size: origins.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(originBuffer, 0, origins);
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
        { binding: 0, resource: { buffer: originBuffer } },
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
}
