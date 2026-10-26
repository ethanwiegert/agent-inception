import type { Mat4 } from "../math.ts";

/** Linear RGB, 0-1. Stored as sRGB bytes so darks keep their precision. */
export type Rgb = readonly [number, number, number];

/** Bytes per vertex: position f32×3, normal snorm8×4, sRGB color + sway unorm8×4. */
export const VERTEX_BYTES = 20;
/** Floats per instance: model matrix (16) + linear tint rgb and wind weight (4). */
export const INSTANCE_FLOATS = 20;

/**
 * How a primitive is painted. `sway` and `ao` run bottom → top over the primitive's own height:
 * a trunk sways [0, 0.3], a canopy 1; `ao` darkens the bottom by that fraction. `jitter` varies
 * brightness per vertex for organic surfaces.
 */
export interface Style {
  color: Rgb;
  sway?: number | readonly [number, number];
  ao?: number;
  jitter?: number;
}

export interface SphereOptions {
  /** Icosahedron subdivisions, 0-3. */
  detail?: number;
  /** Radius wobble as a fraction of the radius (lumpy rocks, bushy canopies). */
  noise?: number;
  seed?: number;
  /** Faceted normals instead of smooth ones. */
  flat?: boolean;
}

export interface CylinderOptions {
  segments?: number;
  caps?: boolean;
  flat?: boolean;
}

/**
 * Builds a mesh from primitives, each placed by an optional transform (no mirroring: winding
 * isn't flipped). Colors are linear; boxes and spheres are centered on their origin, cylinders
 * and cones grow up from y = 0.
 */
export class MeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly sways: number[] = [];
  readonly indices: number[] = [];

  get vertexCount() {
    return this.positions.length / 3;
  }

  /** A box of `size`, optionally with edges rounded by `round` (clamped to half the smallest side). */
  box(m: Mat4 | null, size: readonly [number, number, number], style: Style, round = 0) {
    const h = [size[0] / 2, size[1] / 2, size[2] / 2];
    const r = Math.max(0, Math.min(round, h[0], h[1], h[2]));
    // Sample coordinates per axis: flat middle plus two angular steps across each rounded edge.
    const axis = (half: number) => {
      const inner = half - r;
      if (r <= 1e-6) return [-half, half];
      const t = Math.tan(Math.PI / 8) * r;
      return [-half, -inner - t, -inner, inner, inner + t, half];
    };
    const coords = [axis(h[0]), axis(h[1]), axis(h[2])];
    const part = this.part(m, style, -h[1], h[1]);
    for (let face = 0; face < 6; face++) {
      const a = face >> 1, sign = face & 1 ? -1 : 1;
      // In-plane axes ordered so (u × v) points along the outward normal.
      const u = (a + (sign > 0 ? 1 : 2)) % 3, v = (a + (sign > 0 ? 2 : 1)) % 3;
      const cu = coords[u], cv = coords[v];
      const base = this.vertexCount;
      for (const pv of cv) {
        for (const pu of cu) {
          const p = [0, 0, 0];
          p[a] = sign * h[a], p[u] = pu, p[v] = pv;
          // Project onto the rounded box: nearest point of the inner box plus r along the offset.
          const n = [0, 0, 0];
          let len = 0;
          for (let k = 0; k < 3; k++) {
            const inner = Math.max(-(h[k] - r), Math.min(h[k] - r, p[k]));
            n[k] = p[k] - inner;
            len += n[k] * n[k];
          }
          len = Math.sqrt(len);
          if (len < 1e-6 || r <= 1e-6) {
            n[0] = n[1] = n[2] = 0;
            n[a] = sign;
          } else {
            for (let k = 0; k < 3; k++) {
              n[k] /= len;
              p[k] = Math.max(-(h[k] - r), Math.min(h[k] - r, p[k])) + n[k] * r;
            }
          }
          part.vertex(p[0], p[1], p[2], n[0], n[1], n[2]);
        }
      }
      const w = cu.length;
      for (let j = 0; j + 1 < cv.length; j++) {
        for (let i = 0; i + 1 < w; i++) {
          const q = base + j * w + i;
          this.quad(q, q + 1, q + w + 1, q + w);
        }
      }
    }
    return this;
  }

  /** An ico-sphere with radii `radii`, optionally lumpy and faceted. */
  sphere(
    m: Mat4 | null,
    radii: readonly [number, number, number],
    style: Style,
    o: SphereOptions = {},
  ) {
    const { dirs, tris } = icosphere(Math.max(0, Math.min(3, o.detail ?? 1)));
    const noise = o.noise ?? 0, seed = o.seed ?? 0;
    const pts = dirs.map(([x, y, z]) => {
      const k = 1 + noise * (noise3(x * 1.7 + 3, y * 1.7, z * 1.7, seed) * 2 - 1);
      return [x * radii[0] * k, y * radii[1] * k, z * radii[2] * k];
    });
    const part = this.part(m, style, -radii[1], radii[1]);
    if (o.flat) {
      for (let t = 0; t < tris.length; t += 3) {
        const [a, b, c] = [pts[tris[t]], pts[tris[t + 1]], pts[tris[t + 2]]];
        const n = faceNormal(a, b, c);
        const base = this.vertexCount;
        for (const p of [a, b, c]) part.vertex(p[0], p[1], p[2], n[0], n[1], n[2]);
        this.indices.push(base, base + 1, base + 2);
      }
      return this;
    }
    // Smooth: average the face normals around each (displaced) vertex.
    const acc = new Float64Array(pts.length * 3);
    for (let t = 0; t < tris.length; t += 3) {
      const n = faceNormal(pts[tris[t]], pts[tris[t + 1]], pts[tris[t + 2]]);
      for (let k = 0; k < 3; k++) {
        for (let c = 0; c < 3; c++) acc[tris[t + k] * 3 + c] += n[c];
      }
    }
    const base = this.vertexCount;
    pts.forEach((p, i) =>
      part.vertex(p[0], p[1], p[2], acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2])
    );
    for (const i of tris) this.indices.push(base + i);
    return this;
  }

  /** A cylinder (or cone, or frustum) from y = 0 up to `height`. */
  cylinder(
    m: Mat4 | null,
    rBottom: number,
    rTop: number,
    height: number,
    style: Style,
    o: CylinderOptions = {},
  ) {
    const seg = Math.max(3, o.segments ?? 8);
    const part = this.part(m, style, 0, height);
    // Side normals tilt by the slope so cones shade like cones.
    const slope = (rBottom - rTop) / height;
    const ny = slope / Math.hypot(1, slope), nr = 1 / Math.hypot(1, slope);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const base = this.vertexCount;
      if (o.flat) {
        const am = (a0 + a1) / 2;
        const nx = Math.cos(am) * nr, nz = Math.sin(am) * nr;
        part.vertex(Math.cos(a0) * rBottom, 0, Math.sin(a0) * rBottom, nx, ny, nz);
        part.vertex(Math.cos(a1) * rBottom, 0, Math.sin(a1) * rBottom, nx, ny, nz);
        part.vertex(Math.cos(a1) * rTop, height, Math.sin(a1) * rTop, nx, ny, nz);
        part.vertex(Math.cos(a0) * rTop, height, Math.sin(a0) * rTop, nx, ny, nz);
      } else {
        // Top vertices take the mid-angle normal so a cone's apex doesn't pinch the shading.
        const am = (a0 + a1) / 2;
        const top = rTop > 0 ? [a0, a1] : [am, am];
        part.vertex(
          Math.cos(a0) * rBottom,
          0,
          Math.sin(a0) * rBottom,
          Math.cos(a0) * nr,
          ny,
          Math.sin(a0) * nr,
        );
        part.vertex(
          Math.cos(a1) * rBottom,
          0,
          Math.sin(a1) * rBottom,
          Math.cos(a1) * nr,
          ny,
          Math.sin(a1) * nr,
        );
        part.vertex(
          Math.cos(a1) * rTop,
          height,
          Math.sin(a1) * rTop,
          Math.cos(top[1]) * nr,
          ny,
          Math.sin(top[1]) * nr,
        );
        part.vertex(
          Math.cos(a0) * rTop,
          height,
          Math.sin(a0) * rTop,
          Math.cos(top[0]) * nr,
          ny,
          Math.sin(top[0]) * nr,
        );
      }
      // Counter-clockwise seen from outside: going around +angle is clockwise from above.
      this.quad(base, base + 3, base + 2, base + 1);
    }
    if (o.caps ?? true) {
      for (const [y, r, up] of [[0, rBottom, -1], [height, rTop, 1]] as const) {
        if (r <= 0) continue;
        const center = this.vertexCount;
        part.vertex(0, y, 0, 0, up, 0);
        for (let i = 0; i < seg; i++) {
          const a = (i / seg) * Math.PI * 2;
          part.vertex(Math.cos(a) * r, y, Math.sin(a) * r, 0, up, 0);
        }
        for (let i = 0; i < seg; i++) {
          const a = center + 1 + i, b = center + 1 + ((i + 1) % seg);
          if (up > 0) this.indices.push(center, b, a);
          else this.indices.push(center, a, b);
        }
      }
    }
    return this;
  }

  cone(m: Mat4 | null, radius: number, height: number, style: Style, o: CylinderOptions = {}) {
    return this.cylinder(m, radius, 0, height, style, o);
  }

  /** Append another mesh, e.g. a shared part. */
  merge(other: MeshBuilder) {
    const base = this.vertexCount;
    this.positions.push(...other.positions);
    this.normals.push(...other.normals);
    this.colors.push(...other.colors);
    this.sways.push(...other.sways);
    for (const i of other.indices) this.indices.push(base + i);
    return this;
  }

  private quad(a: number, b: number, c: number, d: number) {
    this.indices.push(a, b, c, a, c, d);
  }

  /** A vertex writer that applies the transform and the style gradients for one primitive. */
  private part(m: Mat4 | null, style: Style, y0: number, y1: number) {
    const nm = m ? normalMatrix(m) : null;
    const [s0, s1] = typeof style.sway === "number"
      ? [style.sway, style.sway]
      : style.sway ?? [0, 0];
    const ao = style.ao ?? 0, jitter = style.jitter ?? 0;
    return {
      vertex: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
        const t = y1 > y0 ? Math.max(0, Math.min(1, (y - y0) / (y1 - y0))) : 1;
        let px = x, py = y, pz = z;
        if (m) {
          px = m[0] * x + m[4] * y + m[8] * z + m[12];
          py = m[1] * x + m[5] * y + m[9] * z + m[13];
          pz = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
        if (nm) {
          const ax = nm[0] * nx + nm[3] * ny + nm[6] * nz;
          const ay = nm[1] * nx + nm[4] * ny + nm[7] * nz;
          const az = nm[2] * nx + nm[5] * ny + nm[8] * nz;
          nx = ax, ny = ay, nz = az;
        }
        const len = Math.hypot(nx, ny, nz) || 1;
        this.positions.push(px, py, pz);
        this.normals.push(nx / len, ny / len, nz / len);
        const k = (1 - ao * (1 - t)) * (1 + jitter * (hash3(px, py, pz) * 2 - 1));
        this.colors.push(style.color[0] * k, style.color[1] * k, style.color[2] * k);
        this.sways.push(s0 + (s1 - s0) * t);
      },
    };
  }
}

/** A template's slice of the shared buffers. */
export interface MeshRange {
  firstIndex: number;
  indexCount: number;
  baseVertex: number;
  /** Bounding radius around the template origin, for culling. */
  radius: number;
}

/**
 * Named mesh templates packed into one vertex and one index buffer. Templates can be added at
 * any time (e.g. agent-defined objects); `version` bumps so the GPU side re-uploads.
 */
export class MeshLibrary {
  version = 0;
  private names = new Map<string, number>();
  private meshes: MeshBuilder[] = [];

  /** Add or replace a template; returns its id. */
  define(name: string, build: (b: MeshBuilder) => void): number {
    const b = new MeshBuilder();
    build(b);
    let id = this.names.get(name);
    if (id === undefined) {
      id = this.meshes.length;
      this.names.set(name, id);
      this.meshes.push(b);
    } else {
      this.meshes[id] = b;
    }
    this.version++;
    return id;
  }

  id(name: string): number {
    const id = this.names.get(name);
    if (id === undefined) throw new Error(`no model template "${name}"`);
    return id;
  }

  get size() {
    return this.meshes.length;
  }

  pack(): {
    vertices: Uint8Array<ArrayBuffer>;
    indices: Uint32Array<ArrayBuffer>;
    ranges: MeshRange[];
  } {
    let vertexCount = 0, indexCount = 0;
    for (const m of this.meshes) vertexCount += m.vertexCount, indexCount += m.indices.length;
    const vertices = new Uint8Array(Math.max(1, vertexCount) * VERTEX_BYTES);
    const view = new DataView(vertices.buffer);
    const indices = new Uint32Array(Math.max(1, indexCount));
    const ranges: MeshRange[] = [];
    let v = 0, ix = 0;
    const snorm = (x: number) => Math.round(Math.max(-1, Math.min(1, x)) * 127);
    const srgb = (x: number) => Math.round(Math.pow(Math.max(0, Math.min(1, x)), 1 / 2.2) * 255);
    for (const m of this.meshes) {
      let radius = 0;
      for (let i = 0; i < m.vertexCount; i++) {
        const o = (v + i) * VERTEX_BYTES;
        const [x, y, z] = [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
        radius = Math.max(radius, Math.hypot(x, y, z));
        view.setFloat32(o, x, true);
        view.setFloat32(o + 4, y, true);
        view.setFloat32(o + 8, z, true);
        for (let c = 0; c < 3; c++) view.setInt8(o + 12 + c, snorm(m.normals[i * 3 + c]));
        for (let c = 0; c < 3; c++) view.setUint8(o + 16 + c, srgb(m.colors[i * 3 + c]));
        view.setUint8(o + 19, Math.round(Math.max(0, Math.min(1, m.sways[i])) * 255));
      }
      indices.set(m.indices, ix);
      ranges.push({ firstIndex: ix, indexCount: m.indices.length, baseVertex: v, radius });
      v += m.vertexCount;
      ix += m.indices.length;
    }
    return { vertices, indices, ranges };
  }
}

/**
 * Instances added in any order, grouped by template for drawing. Reused frame to frame: `clear`,
 * `add` many, then `sort`. Grows (rarely) but never shrinks, so steady state allocates nothing.
 */
export class InstanceBatch {
  count = 0;
  /** Instances grouped by template, ready to upload. */
  sorted = new Float32Array(INSTANCE_FLOATS * 64);
  /** Per template: first instance and count in `sorted`. */
  first = new Uint32Array(16);
  counts = new Uint32Array(16);
  private data = new Float32Array(INSTANCE_FLOATS * 64);
  private ids = new Uint32Array(64);

  clear() {
    this.count = 0;
  }

  /** Add an instance of template `id` with a linear tint and a wind weight (0 = rigid). */
  add(id: number, m: Mat4, r = 1, g = 1, b = 1, wind = 0) {
    if (this.count === this.ids.length) this.grow();
    const o = this.count * INSTANCE_FLOATS;
    this.data.set(m, o);
    this.data[o + 16] = r;
    this.data[o + 17] = g;
    this.data[o + 18] = b;
    this.data[o + 19] = wind;
    this.ids[this.count++] = id;
  }

  /** Counting sort by template id into `sorted`, filling `first`/`counts`. */
  sort(templates: number) {
    if (this.counts.length < templates) {
      this.counts = new Uint32Array(templates * 2);
      this.first = new Uint32Array(templates * 2);
    }
    if (this.sorted.length < this.data.length) this.sorted = new Float32Array(this.data.length);
    const { counts, first, ids, data, sorted } = this;
    counts.fill(0);
    for (let i = 0; i < this.count; i++) counts[ids[i]]++;
    let sum = 0;
    for (let t = 0; t < counts.length; t++) first[t] = sum, sum += counts[t];
    // Reuse `counts` as the running cursor, then restore it.
    for (let i = 0; i < this.count; i++) {
      const t = ids[i];
      const src = i * INSTANCE_FLOATS, dst = (first[t] + --counts[t]) * INSTANCE_FLOATS;
      for (let k = 0; k < INSTANCE_FLOATS; k++) sorted[dst + k] = data[src + k];
    }
    for (let i = 0; i < this.count; i++) counts[ids[i]]++;
  }

  private grow() {
    const ids = new Uint32Array(this.ids.length * 2);
    ids.set(this.ids);
    this.ids = ids;
    const data = new Float32Array(this.data.length * 2);
    data.set(this.data);
    this.data = data;
  }
}

/** Inverse-transpose of the upper 3×3, so normals stay perpendicular under non-uniform scale. */
function normalMatrix(m: Mat4): number[] {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  // Columns of the cofactor matrix are the rows of the inverse transpose (up to 1/det, which
  // normalization removes; keep its sign so mirrored parts don't flip their normals inward).
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  const s = det < 0 ? -1 : 1;
  return [
    s * (e * i - f * h),
    s * (g * f - d * i),
    s * (d * h - g * e),
    s * (h * c - b * i),
    s * (a * i - g * c),
    s * (g * b - a * h),
    s * (b * f - e * c),
    s * (d * c - a * f),
    s * (a * e - d * b),
  ];
}

function faceNormal(a: number[], b: number[], c: number[]): number[] {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / len, n[1] / len, n[2] / len];
}

const icoCache = new Map<number, { dirs: number[][]; tris: number[] }>();

/** Unit icosphere: directions and counter-clockwise triangles, subdivided `detail` times. */
function icosphere(detail: number) {
  const cached = icoCache.get(detail);
  if (cached) return cached;
  const t = (1 + Math.sqrt(5)) / 2;
  const dirs: number[][] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map(unit);
  // deno-fmt-ignore
  let tris = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6,
    7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7,
    9, 8, 1,
  ];
  for (let d = 0; d < detail; d++) {
    const mids = new Map<number, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      let m = mids.get(key);
      if (m === undefined) {
        m = dirs.length;
        dirs.push(
          unit([dirs[a][0] + dirs[b][0], dirs[a][1] + dirs[b][1], dirs[a][2] + dirs[b][2]]),
        );
        mids.set(key, m);
      }
      return m;
    };
    const next: number[] = [];
    for (let i = 0; i < tris.length; i += 3) {
      const [a, b, c] = [tris[i], tris[i + 1], tris[i + 2]];
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    tris = next;
  }
  const out = { dirs, tris };
  icoCache.set(detail, out);
  return out;
}

function unit(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Integer hash of a lattice point to [0, 1). */
function lattice(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 974634899) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 3D value noise in [0, 1). */
export function noise3(x: number, y: number, z: number, seed = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const at = (dx: number, dy: number, dz: number) => lattice(ix + dx, iy + dy, iz + dz, seed);
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  return mix(
    mix(mix(at(0, 0, 0), at(1, 0, 0), sx), mix(at(0, 1, 0), at(1, 1, 0), sx), sy),
    mix(mix(at(0, 0, 1), at(1, 0, 1), sx), mix(at(0, 1, 1), at(1, 1, 1), sx), sy),
    sz,
  );
}

/** Per-vertex brightness jitter that's stable for a position. */
function hash3(x: number, y: number, z: number): number {
  return lattice(Math.round(x * 97), Math.round(y * 97), Math.round(z * 97), 7);
}
