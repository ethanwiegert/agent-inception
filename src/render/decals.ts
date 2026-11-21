import { type Mat4 } from "../math.ts";
import { type Expression, type FloatseeArt, isPixelArt, type PixelArt } from "../sim/floatsee.ts";
import { frameWgsl, lightingWgsl } from "./frame.ts";
import type { Layouts } from "./renderer.ts";

/** Size of each texture slot in the decal atlas (64×64 RGBA8). */
const TEX_SIZE = 64;
/** Maximum cached art layers in the 2D texture array (~1.5 MB GPU memory). */
const MAX_LAYERS = 96;
/** Floats per decal instance: mat4 (16) + vec4 (layer, emissive, boost, alpha). */
const DECAL_FLOATS = 20;

export const DECAL_FLAT = 0;
export const DECAL_SPHERE = 1;
export const DECAL_CYL = 2;

const shader = frameWgsl + lightingWgsl + /* wgsl */ `
struct DecalInst {
  model: mat4x4f,
  params: vec4f, // x: layer, y: emissive (0 lit tee, 1 glowing face), z: boost, w: alpha
};
@group(1) @binding(0) var<storage, read> instances: array<DecalInst>;
@group(1) @binding(1) var atlas: texture_2d_array<f32>;
@group(1) @binding(2) var smp: sampler;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
};

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) @interpolate(flat) params: vec4f,
};

@vertex fn vs(v: VIn, @builtin(instance_index) ii: u32) -> Out {
  let inst = instances[ii];
  let world = (inst.model * vec4f(v.pos, 1.0)).xyz;
  let n = normalize((inst.model * vec4f(v.normal, 0.0)).xyz);
  return Out(frame.viewProj * vec4f(world, 1.0), world, n, v.uv, inst.params);
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  let layer = i32(in.params.x + 0.5);
  let tex = textureSample(atlas, smp, in.uv, layer);
  let a = tex.a * in.params.w;
  if (a < 0.02) { discard; }
  let linear = pow(tex.rgb, vec3f(2.2));
  var c = vec3f(0.0);
  if (in.params.y > 0.5) {
    // Glowing facial expression: dark storybook outline stays crisp by day while bright cores bloom at twilight.
    let luma = dot(linear, vec3f(0.299, 0.587, 0.114));
    let glowCore = smoothstep(0.14, 0.52, luma);
    let nightBoost = mix(1.0, 1.55, frame.extra.x);
    let mult = mix(0.45, in.params.z * nightBoost, glowCore);
    c = selfLit(linear * mult);
  } else {
    // Framed graphic tee artwork: naturally lit by sun, sky, shadows and nearby lanterns.
    let n = normalize(in.normal);
    c = shade(linear, n, in.world, 1.0, 0.25);
  }
  return vec4f(fog(c, in.world) * a, a);
}
`;

interface ShapeSlice {
  firstIndex: number;
  indexCount: number;
}

/** Build the 3 curved/flat decal meshes (flat, spherical face patch, cylindrical face patch). */
function buildDecalGeometry(): {
  vertices: Float32Array;
  indices: Uint16Array;
  slices: ShapeSlice[];
} {
  const verts: number[] = [];
  const idx: number[] = [];
  const slices: ShapeSlice[] = [];

  const pushPatch = (
    nx: number,
    ny: number,
    evalPt: (u: number, v: number) => [number, number, number, number, number, number],
  ) => {
    const firstIndex = idx.length;
    const base = verts.length / 8;
    for (let j = 0; j <= ny; j++) {
      const v = j / ny;
      for (let i = 0; i <= nx; i++) {
        const u = i / nx;
        const [x, y, z, nmx, nmy, nmz] = evalPt(u, v);
        verts.push(x, y, z, nmx, nmy, nmz, u, 1 - v);
      }
    }
    const stride = nx + 1;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const q = base + j * stride + i;
        idx.push(q, q + 1, q + stride + 1, q, q + stride + 1, q + stride);
      }
    }
    slices.push({ firstIndex, indexCount: idx.length - firstIndex });
  };

  // 0: Flat quad in XY plane facing +Z.
  pushPatch(1, 1, (u, v) => [u - 0.5, v - 0.5, 0, 0, 0, 1]);

  // 1: Gently curved spherical patch (wraps cleanly onto a Floatsee orb/star/cloud face).
  pushPatch(4, 4, (u, v) => {
    const ax = (u - 0.5) * 0.92;
    const ay = (v - 0.5) * 0.78;
    const ca = Math.cos(ax), sa = Math.sin(ax);
    const cb = Math.cos(ay), sb = Math.sin(ay);
    const nx = sa * cb, ny = sb, nz = ca * cb;
    return [nx * 0.54, ny * 0.54, (nz - 1) * 0.54, nx, ny, nz];
  });

  // 2: Horizontally curved cylindrical patch (wraps cleanly onto a teacup head).
  pushPatch(5, 1, (u, v) => {
    const ax = (u - 0.5) * 1.02;
    const nx = Math.sin(ax), nz = Math.cos(ax);
    return [nx * 0.5, v - 0.5, (nz - 1) * 0.5, nx, 0, nz];
  });

  return {
    vertices: new Float32Array(verts),
    indices: new Uint16Array(idx),
    slices,
  };
}

/**
 * Renders Floatsee glowing facial expressions and framed front/back graphic tee artworks
 * using a cached 2D texture array. Zero allocations in the hot draw loop once art is cached.
 */
export class FloatseeDecals {
  private pipeline: GPURenderPipeline;
  private bindLayout: GPUBindGroupLayout;
  private vertexBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;
  private slices: ShapeSlice[];
  private atlas: GPUTexture;
  private sampler: GPUSampler;
  private instBuffer: GPUBuffer;
  private instCapacity = 64;
  private bindGroup: GPUBindGroup;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private layerByKey = new Map<string, number>();
  private nextLayer = 0;

  // Per-frame buckets grouped by shape (flat, sphere, cyl).
  private buckets: [number[], number[], number[]] = [[], [], []];
  private uploadBuf = new Float32Array(64 * DECAL_FLOATS);
  private drawCounts: [number, number, number] = [0, 0, 0];
  private drawOffsets: [number, number, number] = [0, 0, 0];

  constructor(private device: GPUDevice, layouts: Layouts) {
    const geom = buildDecalGeometry();
    this.slices = geom.slices;
    this.vertexBuffer = device.createBuffer({
      size: geom.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vertexBuffer, 0, geom.vertices);
    this.indexBuffer = device.createBuffer({
      size: Math.ceil(geom.indices.byteLength / 4) * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, geom.indices);

    this.atlas = device.createTexture({
      size: [TEX_SIZE, TEX_SIZE, MAX_LAYERS],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.bindLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float", viewDimension: "2d-array" },
        },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.instBuffer = device.createBuffer({
      size: this.instCapacity * DECAL_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = this.makeBindGroup();

    const module = device.createShaderModule({ code: shader, label: "floatsee-decals" });
    this.pipeline = device.createRenderPipeline({
      label: "floatsee-decals",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, this.bindLayout] }),
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [{
          arrayStride: 8 * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x2" },
          ],
        }],
      },
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
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: {
        format: layouts.depthFormat,
        depthWriteEnabled: false,
        depthCompare: "less-equal",
        depthBias: -2,
        depthBiasSlopeScale: -1,
      },
      multisample: { count: layouts.samples },
    });

    this.canvas = document.createElement("canvas");
    this.canvas.width = TEX_SIZE;
    this.canvas.height = TEX_SIZE;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  }

  private makeBindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.bindLayout,
      entries: [
        { binding: 0, resource: { buffer: this.instBuffer } },
        { binding: 1, resource: this.atlas.createView({ dimension: "2d-array" }) },
        { binding: 2, resource: this.sampler },
      ],
    });
  }

  clear() {
    this.buckets[0].length = 0;
    this.buckets[1].length = 0;
    this.buckets[2].length = 0;
  }

  /** Queue one decal instance for this frame. */
  add(
    shape: number,
    model: Mat4,
    layer: number,
    emissive: boolean,
    boost = 1.6,
    alpha = 1,
  ) {
    if (layer < 0) return;
    const b = this.buckets[shape] ?? this.buckets[0];
    for (let i = 0; i < 16; i++) b.push(model[i]);
    b.push(layer, emissive ? 1 : 0, boost, alpha);
  }

  /** Resolve a graphic tee art spec to an atlas layer (-1 for "none"). */
  teeLayer(art: FloatseeArt): number {
    if (art === "none") return -1;
    const key = "tee:" + artKey(art);
    const hit = this.layerByKey.get(key);
    if (hit !== undefined) return hit;
    const layer = this.allocLayer(key);
    this.renderTee(layer, art);
    return layer;
  }

  /** Resolve a Floatsee expression face to an atlas layer. */
  expressionLayer(mood: Expression, custom: FloatseeArt | undefined, glowHex: string): number {
    const key = `expr:${mood}:${glowHex}:${custom ? artKey(custom) : "classic"}`;
    const hit = this.layerByKey.get(key);
    if (hit !== undefined) return hit;
    const layer = this.allocLayer(key);
    this.renderExpression(layer, mood, custom, glowHex);
    return layer;
  }

  private allocLayer(key: string): number {
    const layer = this.nextLayer % MAX_LAYERS;
    if (this.nextLayer >= MAX_LAYERS) {
      for (const [k, v] of this.layerByKey) {
        if (v === layer) this.layerByKey.delete(k);
      }
    }
    this.nextLayer++;
    this.layerByKey.set(key, layer);
    return layer;
  }

  private uploadCanvas(layer: number) {
    const img = this.ctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
    this.device.queue.writeTexture(
      { texture: this.atlas, origin: [0, 0, layer] },
      img.data,
      { bytesPerRow: TEX_SIZE * 4, rowsPerImage: TEX_SIZE },
      [TEX_SIZE, TEX_SIZE, 1],
    );
  }

  private renderDataUrl(layer: number, url: string) {
    // Clear to transparent first so the slot never shows stale pixels while decoding.
    this.ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
    this.uploadCanvas(layer);
    const img = new Image();
    img.onload = () => {
      this.ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
      this.ctx.imageSmoothingEnabled = img.width > 24 || img.height > 24;
      this.ctx.drawImage(img, 0, 0, TEX_SIZE, TEX_SIZE);
      this.uploadCanvas(layer);
    };
    img.src = url;
  }

  private renderPixelArt(layer: number, art: PixelArt, bg?: string) {
    const { ctx } = this;
    ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
    }
    const rows = art.pixels.length;
    const cols = art.pixels[0]?.length ?? 1;
    const cell = Math.floor(TEX_SIZE / Math.max(rows, cols));
    const ox = Math.floor((TEX_SIZE - cols * cell) / 2);
    const oy = Math.floor((TEX_SIZE - rows * cell) / 2);
    for (let r = 0; r < rows; r++) {
      const row = art.pixels[r];
      for (let c = 0; c < cols; c++) {
        const ch = row[c];
        const col = art.palette[ch];
        if (!col) continue;
        ctx.fillStyle = col;
        ctx.fillRect(ox + c * cell, oy + r * cell, cell, cell);
      }
    }
    this.uploadCanvas(layer);
  }

  private renderTee(layer: number, art: FloatseeArt) {
    if (isPixelArt(art)) {
      this.renderPixelArt(layer, art, "#f2e5c8");
      return;
    }
    if (art.startsWith("data:")) {
      this.renderDataUrl(layer, art);
      return;
    }
    const { ctx } = this;
    const S = TEX_SIZE;
    ctx.clearRect(0, 0, S, S);
    drawTeePreset(ctx, art, S);
    this.uploadCanvas(layer);
  }

  private renderExpression(
    layer: number,
    mood: Expression,
    custom: FloatseeArt | undefined,
    glowHex: string,
  ) {
    if (custom && isPixelArt(custom)) {
      this.renderPixelArt(layer, custom);
      return;
    }
    if (typeof custom === "string" && custom.startsWith("data:")) {
      this.renderDataUrl(layer, custom);
      return;
    }
    const style = typeof custom === "string" ? custom : "classic";
    const { ctx } = this;
    ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
    drawExpression(ctx, mood, style, glowHex, TEX_SIZE);
    this.uploadCanvas(layer);
  }

  /** Upload this frame's queued decals to the GPU storage buffer. */
  upload() {
    let total = 0;
    for (let s = 0; s < 3; s++) {
      const n = this.buckets[s].length / DECAL_FLOATS;
      this.drawOffsets[s] = total;
      this.drawCounts[s] = n;
      total += n;
    }
    if (total === 0) return;
    if (total > this.instCapacity) {
      while (this.instCapacity < total) this.instCapacity *= 2;
      this.instBuffer.destroy();
      this.instBuffer = this.device.createBuffer({
        size: this.instCapacity * DECAL_FLOATS * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.bindGroup = this.makeBindGroup();
    }
    if (this.uploadBuf.length < total * DECAL_FLOATS) {
      this.uploadBuf = new Float32Array(this.instCapacity * DECAL_FLOATS);
    }
    let off = 0;
    for (let s = 0; s < 3; s++) {
      const b = this.buckets[s];
      if (!b.length) continue;
      this.uploadBuf.set(b, off);
      off += b.length;
    }
    this.device.queue.writeBuffer(this.instBuffer, 0, this.uploadBuf, 0, total * DECAL_FLOATS);
  }

  draw(pass: GPURenderPassEncoder) {
    const total = this.drawCounts[0] + this.drawCounts[1] + this.drawCounts[2];
    if (total === 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(1, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, "uint16");
    for (let s = 0; s < 3; s++) {
      const count = this.drawCounts[s];
      if (!count) continue;
      const sl = this.slices[s];
      pass.drawIndexed(sl.indexCount, count, sl.firstIndex, 0, this.drawOffsets[s]);
    }
  }

  destroy() {
    this.vertexBuffer.destroy();
    this.indexBuffer.destroy();
    this.atlas.destroy();
    this.instBuffer.destroy();
  }
}

function artKey(art: FloatseeArt): string {
  if (typeof art === "string") return art;
  return JSON.stringify(art);
}

// ---------------------------------------------------------------- Painterly Preset Artwork

/** Hand-crafted painterly graphic tee emblems matching mockup 04. */
function drawTeePreset(ctx: CanvasRenderingContext2D, name: string, s: number) {
  const grad = (y0: number, y1: number, c0: string, c1: string) => {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, c0);
    g.addColorStop(1, c1);
    return g;
  };
  switch (name) {
    case "sprout": {
      ctx.fillStyle = grad(0, s, "#f7ecd2", "#e8d3a9");
      ctx.fillRect(0, 0, s, s);
      // Warm soil mound.
      ctx.fillStyle = "#8a5a36";
      ctx.beginPath();
      ctx.ellipse(s * 0.5, s * 0.88, s * 0.44, s * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#6e4326";
      ctx.fillRect(0, s * 0.82, s, s * 0.18);
      // Curved fresh green sprout stem.
      ctx.strokeStyle = "#3f7d32";
      ctx.lineWidth = s * 0.075;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.78);
      ctx.quadraticCurveTo(s * 0.48, s * 0.5, s * 0.52, s * 0.34);
      ctx.stroke();
      // Left & right plump leaves.
      ctx.fillStyle = "#5ba63b";
      ctx.beginPath();
      ctx.ellipse(s * 0.35, s * 0.45, s * 0.16, s * 0.095, -0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#76c449";
      ctx.beginPath();
      ctx.ellipse(s * 0.65, s * 0.38, s * 0.17, s * 0.1, 0.5, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "sun": {
      ctx.fillStyle = grad(0, s, "#2d5d8c", "#4b8ab5");
      ctx.fillRect(0, 0, s, s);
      ctx.save();
      ctx.translate(s * 0.5, s * 0.5);
      // Alternating golden sun rays.
      ctx.strokeStyle = "#ffd66b";
      ctx.lineCap = "round";
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const r1 = i % 2 === 0 ? s * 0.42 : s * 0.35;
        ctx.lineWidth = i % 2 === 0 ? s * 0.055 : s * 0.038;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * s * 0.23, Math.sin(a) * s * 0.23);
        ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
        ctx.stroke();
      }
      ctx.fillStyle = "#ffbe3b";
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff1a8";
      ctx.beginPath();
      ctx.arc(-s * 0.04, -s * 0.04, s * 0.11, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }
    case "tree": {
      // Twilight sunset magenta-gold sky + purple blossom tree on green hill (mockup 04 back!).
      ctx.fillStyle = grad(0, s * 0.78, "#9c47b8", "#f6a65b");
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = "#4d8a3f";
      ctx.beginPath();
      ctx.ellipse(s * 0.5, s * 0.92, s * 0.65, s * 0.26, 0, 0, Math.PI * 2);
      ctx.fill();
      // Trunk & branches.
      ctx.strokeStyle = "#4a2a24";
      ctx.lineWidth = s * 0.11;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.84);
      ctx.lineTo(s * 0.5, s * 0.48);
      ctx.stroke();
      // Lush layered blossom canopy.
      const puffs: [number, number, number, string][] = [
        [0.32, 0.38, 0.19, "#8e349e"],
        [0.68, 0.4, 0.18, "#8e349e"],
        [0.5, 0.28, 0.23, "#c44ec7"],
        [0.38, 0.3, 0.17, "#e268cb"],
        [0.62, 0.32, 0.16, "#f28ad0"],
      ];
      for (const [x, y, r, col] of puffs) {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(s * x, s * y, s * r, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "campfire": {
      ctx.fillStyle = grad(0, s, "#f5e7c9", "#e4cda3");
      ctx.fillRect(0, 0, s, s);
      // Crossed cozy logs.
      ctx.strokeStyle = "#7a4726";
      ctx.lineWidth = s * 0.1;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s * 0.22, s * 0.82);
      ctx.lineTo(s * 0.78, s * 0.68);
      ctx.moveTo(s * 0.78, s * 0.82);
      ctx.lineTo(s * 0.22, s * 0.68);
      ctx.stroke();
      // Outer orange flame & inner gold core.
      ctx.fillStyle = "#f26b26";
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.15);
      ctx.quadraticCurveTo(s * 0.8, s * 0.45, s * 0.68, s * 0.7);
      ctx.quadraticCurveTo(s * 0.5, s * 0.76, s * 0.32, s * 0.7);
      ctx.quadraticCurveTo(s * 0.2, s * 0.45, s * 0.5, s * 0.15);
      ctx.fill();
      ctx.fillStyle = "#ffdd57";
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.34);
      ctx.quadraticCurveTo(s * 0.66, s * 0.54, s * 0.58, s * 0.68);
      ctx.quadraticCurveTo(s * 0.5, s * 0.72, s * 0.42, s * 0.68);
      ctx.quadraticCurveTo(s * 0.34, s * 0.54, s * 0.5, s * 0.34);
      ctx.fill();
      break;
    }
    case "stars": {
      // Deep indigo night sky over rolling hills with bright gold stars (mockup 04 back!).
      ctx.fillStyle = grad(0, s, "#1f2e66", "#3b569c");
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = "#263569";
      ctx.beginPath();
      ctx.ellipse(s * 0.28, s * 0.92, s * 0.48, s * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#1c2854";
      ctx.beginPath();
      ctx.ellipse(s * 0.75, s * 0.96, s * 0.52, s * 0.25, 0, 0, Math.PI * 2);
      ctx.fill();
      const draw4Star = (x: number, y: number, r: number) => {
        ctx.fillStyle = "#fff199";
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const rr = i % 2 === 0 ? r : r * 0.32;
          const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
      };
      draw4Star(s * 0.3, s * 0.28, s * 0.13);
      draw4Star(s * 0.72, s * 0.34, s * 0.11);
      draw4Star(s * 0.52, s * 0.52, s * 0.085);
      ctx.fillStyle = "#ffe896";
      for (const [x, y] of [[0.56, 0.2], [0.22, 0.54], [0.8, 0.58]]) {
        ctx.beginPath();
        ctx.arc(s * x, s * y, s * 0.03, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "shield": {
      ctx.fillStyle = grad(0, s, "#313b6e", "#22294f");
      ctx.fillRect(0, 0, s, s);
      ctx.beginPath();
      ctx.moveTo(s * 0.22, s * 0.18);
      ctx.lineTo(s * 0.78, s * 0.18);
      ctx.lineTo(s * 0.78, s * 0.5);
      ctx.quadraticCurveTo(s * 0.76, s * 0.76, s * 0.5, s * 0.86);
      ctx.quadraticCurveTo(s * 0.24, s * 0.76, s * 0.22, s * 0.5);
      ctx.closePath();
      ctx.fillStyle = "#485999";
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = "#d9e2f2";
      ctx.fillRect(s * 0.5, 0, s * 0.5, s);
      ctx.restore();
      ctx.strokeStyle = "#e6dcc8";
      ctx.lineWidth = s * 0.06;
      ctx.stroke();
      break;
    }
    case "flower": {
      ctx.fillStyle = grad(0, s, "#f7ecd2", "#e7d4af");
      ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = "#4a8b3b";
      ctx.lineWidth = s * 0.07;
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.88);
      ctx.lineTo(s * 0.5, s * 0.5);
      ctx.stroke();
      ctx.fillStyle = "#ec6d88";
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(
          s * 0.5 + Math.cos(a) * s * 0.16,
          s * 0.42 + Math.sin(a) * s * 0.16,
          s * 0.11,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.fillStyle = "#ffd659";
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.42, s * 0.11, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "heart":
    default: {
      ctx.fillStyle = grad(0, s, "#faf0dc", "#edd7b4");
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = "#df5668";
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.78);
      ctx.bezierCurveTo(s * 0.14, s * 0.56, s * 0.16, s * 0.24, s * 0.36, s * 0.24);
      ctx.bezierCurveTo(s * 0.46, s * 0.24, s * 0.5, s * 0.33, s * 0.5, s * 0.36);
      ctx.bezierCurveTo(s * 0.5, s * 0.33, s * 0.54, s * 0.24, s * 0.64, s * 0.24);
      ctx.bezierCurveTo(s * 0.84, s * 0.24, s * 0.86, s * 0.56, s * 0.5, s * 0.78);
      ctx.fill();
      break;
    }
  }
}

/** Glowing Floatsee expressions matching mockup 04 (happy, sad, angry, excited). */
function drawExpression(
  ctx: CanvasRenderingContext2D,
  mood: Expression,
  style: string,
  glowHex: string,
  s: number,
) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Helper: stroke a path with a soft dark-espresso storybook contour first so pastel heads
  // stay ultra-readable in bright sunlight while the inner core blooms warmly at twilight!
  const glowStroke = (lw: number, drawPath: () => void, coreColor = glowHex) => {
    ctx.save();
    ctx.shadowColor = "rgba(28, 20, 34, 0.55)";
    ctx.shadowBlur = s * 0.04;
    ctx.strokeStyle = "rgba(38, 28, 46, 0.84)";
    ctx.lineWidth = lw * 1.65;
    drawPath();
    ctx.stroke();
    ctx.shadowColor = coreColor;
    ctx.shadowBlur = s * 0.08;
    ctx.strokeStyle = coreColor;
    ctx.lineWidth = lw;
    drawPath();
    ctx.stroke();
    ctx.restore();
  };

  const glowFill = (drawPath: () => void, coreColor = glowHex, pad = s * 0.048) => {
    ctx.save();
    ctx.shadowColor = "rgba(28, 20, 34, 0.55)";
    ctx.shadowBlur = s * 0.04;
    ctx.strokeStyle = "rgba(38, 28, 46, 0.84)";
    ctx.lineWidth = pad;
    drawPath();
    ctx.stroke();
    ctx.shadowColor = coreColor;
    ctx.shadowBlur = s * 0.08;
    ctx.fillStyle = coreColor;
    drawPath();
    ctx.fill();
    ctx.restore();
  };

  if (style === "minimal") {
    // Cozy minimal dots + little mouth (like the fishing teacup Floatsee in mockup 06).
    const dot = (x: number, y: number, r: number) =>
      glowFill(() => {
        ctx.beginPath();
        ctx.arc(s * x, s * y, s * r, 0, Math.PI * 2);
      });
    if (mood === "happy") {
      dot(0.32, 0.44, 0.055);
      dot(0.68, 0.44, 0.055);
      glowStroke(s * 0.06, () => {
        ctx.beginPath();
        ctx.arc(s * 0.5, s * 0.52, s * 0.09, 0.15 * Math.PI, 0.85 * Math.PI);
      });
    } else if (mood === "sad") {
      dot(0.32, 0.46, 0.055);
      dot(0.68, 0.46, 0.055);
      glowStroke(s * 0.06, () => {
        ctx.beginPath();
        ctx.arc(s * 0.5, s * 0.66, s * 0.09, 1.2 * Math.PI, 1.8 * Math.PI);
      });
    } else if (mood === "angry") {
      glowStroke(s * 0.06, () => {
        ctx.beginPath();
        ctx.moveTo(s * 0.24, s * 0.35);
        ctx.lineTo(s * 0.4, s * 0.43);
        ctx.moveTo(s * 0.76, s * 0.35);
        ctx.lineTo(s * 0.6, s * 0.43);
      });
      dot(0.33, 0.49, 0.045);
      dot(0.67, 0.49, 0.045);
      glowStroke(s * 0.055, () => {
        ctx.beginPath();
        ctx.moveTo(s * 0.41, s * 0.63);
        ctx.lineTo(s * 0.59, s * 0.63);
      });
    } else {
      dot(0.32, 0.42, 0.068);
      dot(0.68, 0.42, 0.068);
      glowFill(() => {
        ctx.beginPath();
        ctx.arc(s * 0.5, s * 0.56, s * 0.11, 0, Math.PI);
      });
    }
    ctx.restore();
    return;
  }

  // Classic & kawaii glowing expressions (mockup 04!).
  const blush = (y: number) => {
    ctx.save();
    ctx.shadowBlur = s * 0.07;
    ctx.shadowColor = "#f2788f";
    ctx.fillStyle = "rgba(244, 118, 138, 0.82)";
    ctx.beginPath();
    ctx.ellipse(s * 0.19, s * y, s * 0.088, s * 0.052, 0, 0, Math.PI * 2);
    ctx.ellipse(s * 0.81, s * y, s * 0.088, s * 0.052, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  switch (mood) {
    case "happy": {
      blush(0.57);
      // Joyful ^ ^ eyes.
      glowStroke(s * 0.078, () => {
        ctx.beginPath();
        ctx.arc(s * 0.3, s * 0.49, s * 0.1, Math.PI * 1.12, Math.PI * 1.88);
      });
      glowStroke(s * 0.078, () => {
        ctx.beginPath();
        ctx.arc(s * 0.7, s * 0.49, s * 0.1, Math.PI * 1.12, Math.PI * 1.88);
      });
      // Sweet glowing u smile (or cat ω for kawaii).
      glowStroke(s * 0.072, () => {
        if (style === "kawaii") {
          ctx.beginPath();
          ctx.arc(s * 0.44, s * 0.56, s * 0.065, 0.08 * Math.PI, 0.92 * Math.PI);
          ctx.arc(s * 0.56, s * 0.56, s * 0.065, 0.08 * Math.PI, 0.92 * Math.PI);
        } else {
          ctx.beginPath();
          ctx.arc(s * 0.5, s * 0.54, s * 0.09, 0.12 * Math.PI, 0.88 * Math.PI);
        }
      });
      break;
    }
    case "sad": {
      // Droopy angled glowing brows / eyes.
      glowStroke(s * 0.076, () => {
        ctx.beginPath();
        ctx.moveTo(s * 0.21, s * 0.49);
        ctx.quadraticCurveTo(s * 0.31, s * 0.44, s * 0.4, s * 0.35);
        ctx.moveTo(s * 0.79, s * 0.49);
        ctx.quadraticCurveTo(s * 0.69, s * 0.44, s * 0.6, s * 0.35);
      });
      // Glowing cyan-white teardrops.
      const tear = (x: number, y: number) =>
        glowFill(
          () => {
            ctx.beginPath();
            ctx.moveTo(s * x, s * (y - 0.075));
            ctx.quadraticCurveTo(s * (x + 0.072), s * (y + 0.04), s * x, s * (y + 0.075));
            ctx.quadraticCurveTo(s * (x - 0.072), s * (y + 0.04), s * x, s * (y - 0.075));
            ctx.closePath();
          },
          "#b8f0ff",
          s * 0.04,
        );
      tear(0.24, 0.59);
      tear(0.76, 0.59);
      // Downturned glowing frown.
      glowStroke(s * 0.072, () => {
        ctx.beginPath();
        ctx.arc(s * 0.5, s * 0.71, s * 0.1, Math.PI * 1.18, Math.PI * 1.82);
      });
      break;
    }
    case "angry": {
      // Crisp fierce > < scrunched eyes (clearly separated like mockup 04).
      glowStroke(s * 0.068, () => {
        ctx.beginPath();
        ctx.moveTo(s * 0.22, s * 0.33);
        ctx.lineTo(s * 0.38, s * 0.44);
        ctx.lineTo(s * 0.23, s * 0.51);
        ctx.moveTo(s * 0.78, s * 0.33);
        ctx.lineTo(s * 0.62, s * 0.44);
        ctx.lineTo(s * 0.77, s * 0.51);
      });
      // Sharp grumpy arched frown.
      glowStroke(s * 0.068, () => {
        ctx.beginPath();
        ctx.arc(s * 0.5, s * 0.71, s * 0.115, Math.PI * 1.2, Math.PI * 1.8);
      });
      break;
    }
    case "excited": {
      blush(0.6);
      // Radiant 5-pointed star eyes.
      const star = (cx: number, cy: number, outer: number, inner: number) =>
        glowFill(
          () => {
            ctx.beginPath();
            for (let i = 0; i < 10; i++) {
              const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
              const r = i % 2 === 0 ? outer : inner;
              const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.closePath();
          },
          glowHex,
          s * 0.05,
        );
      star(s * 0.29, s * 0.41, s * 0.155, s * 0.068);
      star(s * 0.71, s * 0.41, s * 0.155, s * 0.068);
      // Wide open happy mouth with rosy coral tongue.
      ctx.save();
      ctx.fillStyle = "#4d1920";
      ctx.beginPath();
      ctx.moveTo(s * 0.36, s * 0.57);
      ctx.lineTo(s * 0.64, s * 0.57);
      ctx.quadraticCurveTo(s * 0.63, s * 0.8, s * 0.5, s * 0.8);
      ctx.quadraticCurveTo(s * 0.37, s * 0.8, s * 0.36, s * 0.57);
      ctx.fill();
      ctx.fillStyle = "#ff7678";
      ctx.beginPath();
      ctx.ellipse(s * 0.5, s * 0.73, s * 0.09, s * 0.052, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = glowHex;
      ctx.lineWidth = s * 0.036;
      ctx.beginPath();
      ctx.moveTo(s * 0.36, s * 0.57);
      ctx.lineTo(s * 0.64, s * 0.57);
      ctx.quadraticCurveTo(s * 0.63, s * 0.8, s * 0.5, s * 0.8);
      ctx.quadraticCurveTo(s * 0.37, s * 0.8, s * 0.36, s * 0.57);
      ctx.stroke();
      ctx.restore();
      break;
    }
  }
  ctx.restore();
}
