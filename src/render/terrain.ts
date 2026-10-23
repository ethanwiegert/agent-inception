import { CHUNK, World } from "../sim/world.ts";
import { frameWgsl, lightingWgsl } from "./frame.ts";
import { meshChunk } from "./mesher.ts";
import type { Layouts } from "./renderer.ts";

const shader = frameWgsl + lightingWgsl + /* wgsl */ `
@group(1) @binding(0) var<storage, read> chunkOrigins: array<vec4f>;

const GRASS = 1u;
const DIRT = 2u;
const STONE = 3u;
const FARMLAND = 4u;

struct Vertex { pos: vec3f, face: u32, ao: f32, block: u32 };

fn unpack(v: u32, chunk: u32) -> Vertex {
  let local = vec3f(f32(v & 63u), f32((v >> 6u) & 127u), f32((v >> 13u) & 63u));
  let aoLevels = array<f32, 4>(0.45, 0.65, 0.83, 1.0);
  return Vertex(chunkOrigins[chunk].xyz + local, (v >> 19u) & 7u, aoLevels[(v >> 22u) & 3u], v >> 24u);
}

fn faceNormal(face: u32) -> vec3f {
  let normals = array<vec3f, 6>(
    vec3f(1.0, 0.0, 0.0), vec3f(-1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0),
    vec3f(0.0, -1.0, 0.0), vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, -1.0));
  return normals[face];
}

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) ao: f32,
  @location(2) @interpolate(flat) face: u32,
  @location(3) @interpolate(flat) block: u32,
};

@vertex fn vs(@location(0) packed: u32, @builtin(instance_index) chunk: u32) -> Out {
  let v = unpack(packed, chunk);
  return Out(frame.viewProj * vec4f(v.pos, 1.0), v.pos, v.ao, v.face, v.block);
}

@vertex fn vsShadow(@location(0) packed: u32, @builtin(instance_index) chunk: u32) -> @builtin(position) vec4f {
  return frame.lightViewProj * vec4f(unpack(packed, chunk).pos, 1.0);
}

fn blockAlbedo(block: u32, face: u32, world: vec3f, n: vec3f) -> vec3f {
  let cell = floor(world - n * 0.5);
  let jitter = 0.94 + 0.12 * hash21(cell.xz + cell.y * 17.0);
  let dirt = vec3f(0.22, 0.12, 0.06);
  var albedo = vec3f(0.18, 0.18, 0.19);
  if (block == GRASS) {
    let green = meadowColor(frame.grassBase.rgb, world.xz) * 0.85;
    if (face == 2u) {
      albedo = green;
    } else {
      // Green fringe hanging over the dirt on the sides of grass blocks.
      let fringe = step(0.78 + 0.1 * hash21(floor(world.xz * 4.0 + world.y)), fract(world.y));
      albedo = mix(dirt, green, fringe);
    }
  } else if (block == DIRT) {
    albedo = dirt;
  } else if (block == FARMLAND) {
    albedo = dirt;
    if (face == 2u) {
      // Dark tilled soil with furrows running east-west.
      let furrow = 0.7 + 0.3 * smoothstep(0.2, 0.5, abs(fract(world.z * 3.0) - 0.5));
      albedo = vec3f(0.09, 0.045, 0.022) * furrow;
    }
  }
  return albedo * jitter;
}

/** Darken block edges for the crisp look; 0 strength disables it. */
fn edgeFactor(world: vec3f, n: vec3f) -> f32 {
  let f = abs(fract(world) - 0.5);
  let a = abs(n);
  // Distance to the nearest edge measured in the face's own plane.
  let planar = select(f, vec3f(0.0), a > vec3f(0.5));
  let edge = 0.5 - max(max(planar.x, planar.y), planar.z);
  return 1.0 - frame.grassBase.w * (1.0 - smoothstep(0.0, 0.07, edge));
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  let n = faceNormal(in.face);
  let albedo = blockAlbedo(in.block, in.face, in.world, n) * edgeFactor(in.world, n);
  let ao = mix(1.0, in.ao, frame.groundAmbient.w);
  return vec4f(fog(shade(albedo, n, in.world, ao, 0.0), in.world), 1.0);
}
`;

interface ChunkMesh {
  buffer: GPUBuffer | null;
  quads: number;
  version: number;
}

/** Owns chunk meshes and draws them; remeshes chunks whose world version changed. */
export class TerrainRenderer {
  private chunks: ChunkMesh[];
  private indexBuffer: GPUBuffer | null = null;
  private indexQuads = 0;
  private originsBindGroup: GPUBindGroup;
  private pipeline: GPURenderPipeline;
  private shadowPipeline: GPURenderPipeline;

  constructor(private device: GPUDevice, private world: World, layouts: Layouts) {
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

    const chunkLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      }],
    });
    this.originsBindGroup = device.createBindGroup({
      layout: chunkLayout,
      entries: [{ binding: 0, resource: { buffer: originBuffer } }],
    });

    const module = device.createShaderModule({ code: shader, label: "terrain" });
    const vertex: GPUVertexState = {
      module,
      entryPoint: "vs",
      buffers: [{
        arrayStride: 4,
        attributes: [{ shaderLocation: 0, offset: 0, format: "uint32" }],
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
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.shadowFrame, chunkLayout] }),
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
      chunk.quads = verts.length / 4;
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

  draw(pass: GPURenderPassEncoder) {
    pass.setPipeline(this.pipeline);
    this.drawChunks(pass);
  }

  drawShadow(pass: GPURenderPassEncoder) {
    pass.setPipeline(this.shadowPipeline);
    this.drawChunks(pass);
  }

  private drawChunks(pass: GPURenderPassEncoder) {
    if (!this.indexBuffer) return;
    pass.setBindGroup(1, this.originsBindGroup);
    pass.setIndexBuffer(this.indexBuffer, "uint32");
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      if (!chunk.buffer) continue;
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
