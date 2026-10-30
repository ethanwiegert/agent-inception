import type { Catalog, DesignContent, MaterialContent } from "./catalog.ts";
import { deviceKind } from "./catalog.ts";
import { poseBoxes, type Quat } from "./physics.ts";
import type { BlockRegistry } from "./blocks.ts";
import type { WorldObject } from "./objects.ts";
import { solid, type World } from "./world.ts";

/**
 * Light (physics phase 4, fields). Lamps, tame flames, wild fire and glowing Materials light the
 * cells around them: each source floods outward through open cells, so walls stop it and it bends
 * round corners, fading with the length of the way it took. Sources combine by the brightest in
 * each color. The field is kept in 16³ chunks, recomputed only where a source or a block near one
 * changed; the sim reads it for Rules and `look`, and the page uploads the same chunks to the GPU.
 */

export const LIGHT_CHUNK = 16;
/** How far each kind of source reaches, in blocks. */
export const LAMP_REACH = 8;
export const FLAME_REACH = 7;
export const FIRE_REACH = 6;
/** A glowing Material reaches this much per unit of `glows`, plus two. */
const GLOW_REACH = 5;
/** Tame and wild fire light: warm orange, linear rgb. */
export const FIRE_COLOR: [number, number, number] = [1, 0.42, 0.12];
/** How a source's light fades over the way it travelled: (1 - d / reach) ^ FALLOFF. */
const FALLOFF = 1.6;

export interface LightSource {
  /** Stable identity, so a moved or switched source is told apart from a new one. */
  key: string;
  x: number;
  y: number;
  z: number;
  /** Linear rgb times brightness, 0-1. */
  r: number;
  g: number;
  b: number;
  reach: number;
  /** 1 for fire (it flickers), 0 for steady light. */
  flicker: number;
}

const C = LIGHT_CHUNK, C3 = C * C * C;

/** The 26 neighbour steps: offsets, lengths (tenths of a block), and the cells each passes. */
const STEP_D: [number, number, number][] = [];
const STEP_COST: number[] = [];
const STEP_VIA: [number, number, number][][] = [];
for (let dz = -1; dz <= 1; dz++) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const n = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
      if (!n) continue;
      // A diagonal step needs the cells it squeezes past open, so light can't leak through cracks.
      const via: [number, number, number][] = [];
      for (let m = 1; m < 7; m++) {
        const v: [number, number, number] = [m & 1 ? dx : 0, m & 2 ? dy : 0, m & 4 ? dz : 0];
        const k = Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2]);
        if (k && k < n && !via.some((u) => u[0] === v[0] && u[1] === v[1] && u[2] === v[2])) {
          via.push(v);
        }
      }
      STEP_D.push([dx, dy, dz]);
      STEP_COST.push([0, 10, 14, 17][n]);
      STEP_VIA.push(via);
    }
  }
}

/** The steps as index offsets in a box `P` cells wide: [offset, cost, via count, ...via]. */
interface StepTable {
  offset: Int32Array;
  cost: Int32Array;
  viaStart: Int32Array;
  via: Int32Array;
}
const stepTables = new Map<number, StepTable>();
function stepTable(P: number): StepTable {
  let t = stepTables.get(P);
  if (t) return t;
  const at = ([x, y, z]: [number, number, number]) => (z * P + y) * P + x;
  const via: number[] = [], viaStart = new Int32Array(27);
  STEP_VIA.forEach((vs, i) => {
    viaStart[i] = via.length;
    for (const v of vs) via.push(at(v));
  });
  viaStart[26] = via.length;
  t = {
    offset: Int32Array.from(STEP_D.map(at)),
    cost: Int32Array.from(STEP_COST),
    viaStart,
    via: Int32Array.from(via),
  };
  stepTables.set(P, t);
  return t;
}

export class LightField {
  /** Chunk index → rgb + fire share per cell (x fastest, then y, then z), as GPU bytes. */
  readonly chunks = new Map<number, Uint8Array<ArrayBuffer>>();
  /** Chunks recomputed since the page last uploaded them. */
  readonly changed = new Set<number>();
  /** Bumps whenever the field changed. */
  version = 0;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  private sources = new Map<string, LightSource>();
  private dirty = new Set<number>();
  // Flood scratch, reused.
  private dist = new Uint16Array(0);
  private stamp = new Uint32Array(0);
  private open = new Uint8Array(0);
  private gen = 0;
  private buckets: number[][] = [];

  constructor(readonly world: World) {
    this.cx = Math.ceil(world.sizeX / C);
    this.cy = Math.ceil(world.sizeY / C);
    this.cz = Math.ceil(world.sizeZ / C);
  }

  /** Whether any source lights the world (the shaders skip the field when none does). */
  get lit(): boolean {
    return this.sources.size > 0;
  }

  /** A block changed at (x, y, z): the light of every source that reaches it is redone. */
  blockChanged(x: number, y: number, z: number) {
    for (const s of this.sources.values()) {
      const r = s.reach + 1;
      if (
        Math.abs(s.x - x - 0.5) <= r && Math.abs(s.y - y - 0.5) <= r && Math.abs(s.z - z - 0.5) <= r
      ) {
        this.markSource(s);
      }
    }
  }

  /** Recompute where sources appeared, moved, changed or went out. True if anything changed. */
  update(sources: LightSource[]): boolean {
    const seen = new Set<string>();
    for (const s of sources) {
      seen.add(s.key);
      const old = this.sources.get(s.key);
      if (
        old && Math.abs(old.x - s.x) < 0.02 && Math.abs(old.y - s.y) < 0.02 &&
        Math.abs(old.z - s.z) < 0.02 && old.r === s.r && old.g === s.g && old.b === s.b &&
        old.reach === s.reach && old.flicker === s.flicker
      ) continue;
      if (old) this.markSource(old);
      this.markSource(s);
      this.sources.set(s.key, s);
    }
    for (const [key, s] of this.sources) {
      if (!seen.has(key)) this.markSource(s), this.sources.delete(key);
    }
    if (!this.dirty.size) return false;
    const dirty = this.dirty;
    this.dirty = new Set();
    for (const c of dirty) this.chunks.get(c)?.fill(0);
    for (const s of this.sources.values()) {
      if (this.touches(s, dirty)) this.flood(s, dirty);
    }
    for (const c of dirty) {
      const data = this.chunks.get(c);
      if (data && !data.some((v) => v)) this.chunks.delete(c);
      this.changed.add(c);
    }
    this.version++;
    return true;
  }

  /** Light at cell (x, y, z), 0-1: the brightest color channel. */
  at(x: number, y: number, z: number): number {
    x = Math.floor(x), y = Math.floor(y), z = Math.floor(z);
    const w = this.world;
    if (x < 0 || y < 0 || z < 0 || x >= w.sizeX || y >= w.sizeY || z >= w.sizeZ) return 0;
    const data = this.chunks.get(this.chunkOf(x, y, z));
    if (!data) return 0;
    const i = this.cellOf(x, y, z) * 4;
    const m = Math.max(data[i], data[i + 1], data[i + 2]) / 255;
    return m * m;
  }

  /** Chunk index from cell coordinates. */
  chunkOf(x: number, y: number, z: number): number {
    return (Math.floor(z / C) * this.cy + Math.floor(y / C)) * this.cx + Math.floor(x / C);
  }

  /** Where chunk `c` starts, in cells. */
  chunkOrigin(c: number): [number, number, number] {
    return [
      (c % this.cx) * C,
      (Math.floor(c / this.cx) % this.cy) * C,
      Math.floor(c / (this.cx * this.cy)) * C,
    ];
  }

  private cellOf(x: number, y: number, z: number): number {
    return ((z % C) * C + (y % C)) * C + (x % C);
  }

  private box(s: LightSource): [number, number, number, number, number, number] {
    const r = Math.ceil(s.reach);
    const x = Math.floor(s.x), y = Math.floor(s.y), z = Math.floor(s.z);
    return [x - r, y - r, z - r, x + r, y + r, z + r];
  }

  private markSource(s: LightSource) {
    const [x0, y0, z0, x1, y1, z1] = this.box(s), w = this.world;
    const cx0 = Math.max(0, Math.floor(x0 / C)), cx1 = Math.min(this.cx - 1, Math.floor(x1 / C));
    const cy0 = Math.max(0, Math.floor(y0 / C)), cy1 = Math.min(this.cy - 1, Math.floor(y1 / C));
    const cz0 = Math.max(0, Math.floor(z0 / C)), cz1 = Math.min(this.cz - 1, Math.floor(z1 / C));
    if (x1 < 0 || z1 < 0 || x0 >= w.sizeX || z0 >= w.sizeZ) return;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) this.dirty.add((cz * this.cy + cy) * this.cx + cx);
      }
    }
  }

  private touches(s: LightSource, dirty: Set<number>): boolean {
    const [x0, y0, z0, x1, y1, z1] = this.box(s);
    for (const c of dirty) {
      const [ox, oy, oz] = this.chunkOrigin(c);
      if (x1 >= ox && x0 < ox + C && y1 >= oy && y0 < oy + C && z1 >= oz && z0 < oz + C) {
        return true;
      }
    }
    return false;
  }

  /**
   * Spread one source's light through open cells (Dijkstra in tenths), into the dirty chunks. The
   * box around it has a closed border a cell wide, beyond its reach, so steps need no bounds checks.
   */
  private flood(s: LightSource, dirty: Set<number>) {
    const w = this.world, R = Math.ceil(s.reach), P = 2 * R + 3, P2 = P * P, n = P2 * P;
    if (this.dist.length < n) {
      this.dist = new Uint16Array(n);
      this.stamp = new Uint32Array(n);
      this.open = new Uint8Array(n);
      this.gen = 0;
    }
    const gen = ++this.gen, dist = this.dist, stamp = this.stamp, open = this.open;
    const sx = Math.floor(s.x), sy = Math.floor(s.y), sz = Math.floor(s.z);
    const ox = sx - R - 1, oy = sy - R - 1, oz = sz - R - 1;
    // Which cells of the box light passes through (outside the world and the border: none).
    for (let lz = 0; lz < P; lz++) {
      for (let ly = 0; ly < P; ly++) {
        for (let lx = 0, i = (lz * P + ly) * P; lx < P; lx++, i++) {
          const x = ox + lx, y = oy + ly, z = oz + lz;
          const edge = lx === 0 || ly === 0 || lz === 0 || lx === P - 1 || ly === P - 1 ||
            lz === P - 1;
          open[i] = !edge && w.inBounds(x, y, z) && !solid(w.blocks[w.index(x, y, z)]) ? 1 : 0;
        }
      }
    }
    // The source's own block lets its light out.
    const start = ((R + 1) * P + R + 1) * P + R + 1;
    open[start] = 1;
    const max = Math.floor(s.reach * 10);
    const buckets = this.buckets;
    for (let i = 0; i <= max; i++) (buckets[i] ??= []).length = 0;
    stamp[start] = gen, dist[start] = 0;
    buckets[0].push(start);
    const { offset, cost, viaStart, via } = stepTable(P);
    let lastChunk = -1, data: Uint8Array<ArrayBuffer> | null = null;
    for (let d = 0; d <= max; d++) {
      const bucket = buckets[d];
      const f = Math.pow(Math.max(0, 1 - d / 10 / s.reach), FALLOFF);
      const r = s.r * f, g = s.g * f, b = s.b * f, a = s.flicker * f;
      for (let q = 0; q < bucket.length; q++) {
        const cell = bucket[q];
        if (dist[cell] !== d) continue;
        const lx = cell % P, ly = Math.floor(cell / P) % P, lz = Math.floor(cell / P2);
        const x = ox + lx, y = oy + ly, z = oz + lz;
        if (!w.inBounds(x, y, z)) continue;
        // Light this cell, if it's in a chunk being redone.
        const c = this.chunkOf(x, y, z);
        if (c !== lastChunk) {
          data = dirty.has(c) ? this.chunks.get(c) ?? null : null;
          if (!data && dirty.has(c)) this.chunks.set(c, data = new Uint8Array(C3 * 4));
          lastChunk = c;
        }
        if (data) {
          const i = this.cellOf(x, y, z) * 4;
          put(data, i, r), put(data, i + 1, g), put(data, i + 2, b), put(data, i + 3, a);
        }
        // Walls stop the light (they're lit on their faces, but nothing passes).
        if (!open[cell]) continue;
        for (let k = 0; k < 26; k++) {
          const nd = d + cost[k];
          if (nd > max) continue;
          const next = cell + offset[k];
          if (stamp[next] === gen && dist[next] <= nd) continue;
          let squeezed = false;
          for (let v = viaStart[k]; v < viaStart[k + 1]; v++) {
            if (!open[cell + via[v]]) {
              squeezed = true;
              break;
            }
          }
          if (squeezed) continue;
          stamp[next] = gen, dist[next] = nd;
          buckets[nd].push(next);
        }
      }
    }
  }
}

/** Keep the brighter of a cell's light and `v` (0-1, stored as its square root). */
function put(data: Uint8Array, i: number, v: number) {
  const byte = Math.round(Math.sqrt(Math.min(1, v)) * 255);
  if (byte > data[i]) data[i] = byte;
}

// ---------------------------------------------------------------- sources

const srgbToLinear = (c: number) => Math.pow(c / 255, 2.2);
function linear(hex: string): [number, number, number] {
  const c = parseInt(hex.slice(1), 16);
  return [srgbToLinear(c >> 16), srgbToLinear((c >> 8) & 255), srgbToLinear(c & 255)];
}

/** What casts light: Objects (by pose), glowing blocks and wild fires. */
export interface LightInputs {
  catalog: Catalog;
  objects: readonly WorldObject[];
  /** Where an Object's piece is now: its origin and turn. */
  pose?: (o: WorldObject, piece: number) => { pos: [number, number, number]; rot: Quat } | null;
  world: World;
  blocks: BlockRegistry;
  /** Block indices of glowing blocks. */
  glowing: Iterable<number>;
  /** Burning things: their box center and top. */
  fires: Iterable<{ key: string; x: number; y: number; z: number }>;
}

/** Whether a device part shines now: lamps and flames are lit unless switched off. */
export function deviceLit(o: WorldObject, part: number): boolean {
  return o.devices?.[part]?.on !== false;
}

/** Every light source in the world. */
export function lightSources(inp: LightInputs): LightSource[] {
  const out: LightSource[] = [];
  const mat = (name: string) => inp.catalog.byName(name)?.content as MaterialContent | undefined;
  for (const o of inp.objects) {
    const e = inp.catalog.get(o.design);
    if (e?.kind !== "design") continue;
    const d = e.content as DesignContent;
    let boxes: number[][] | null = null;
    d.parts.forEach((p, i) => {
      const kind = deviceKind(p.part), m = mat(p.material);
      const glows = m?.glows ?? 0;
      if (kind !== "lamp" && kind !== "flame" && !glows) return;
      if ((kind === "lamp" || kind === "flame") && !deviceLit(o, i)) return;
      boxes ??= objectBoxes(inp, o, d);
      const b = boxes[i];
      const x = (b[0] + b[1]) / 2, y = (b[2] + b[3]) / 2, z = (b[4] + b[5]) / 2;
      const key = `o${o.id}:${i}`;
      if (kind === "flame") {
        const [r, g, bl] = FIRE_COLOR;
        out.push({ key, x, y: b[3] - 0.1, z, r, g, b: bl, reach: FLAME_REACH, flicker: 1 });
      } else if (kind === "lamp") {
        const [r, g, bl] = linear(m?.color ?? "#ffffff");
        out.push({ key, x, y, z, r, g, b: bl, reach: LAMP_REACH, flicker: 0 });
      } else {
        const [r, g, bl] = linear(m!.color);
        out.push({
          key,
          x,
          y,
          z,
          r: r * glows,
          g: g * glows,
          b: bl * glows,
          reach: 2 + GLOW_REACH * glows,
          flicker: 0,
        });
      }
    });
  }
  // Glowing blocks light in groups of 2 × 2 × 2 cells (a glowing wall isn't a hundred lamps):
  // from the middle of a group's blocks that aren't buried, at the brightest of them.
  const w = inp.world;
  const groups = new Map<
    number,
    { n: number; x: number; y: number; z: number; r: number; g: number; b: number; glows: number }
  >();
  for (const index of inp.glowing) {
    const x = index % w.sizeX, z = Math.floor(index / w.sizeX) % w.sizeZ;
    const y = Math.floor(index / (w.sizeX * w.sizeZ));
    const def = inp.blocks.get(w.blocks[index]);
    if (!def?.glows) continue;
    const buried = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].every(
      ([dx, dy, dz]) => solid(w.get(x + dx, y + dy, z + dz)),
    );
    if (buried) continue;
    const key = ((z >> 1) * (w.sizeY >> 1) + (y >> 1)) * (w.sizeX >> 1) + (x >> 1);
    let gr = groups.get(key);
    if (!gr) groups.set(key, gr = { n: 0, x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, glows: 0 });
    const c = def.color, g = def.glows;
    gr.n++, gr.x += x, gr.y += y, gr.z += z;
    gr.r = Math.max(gr.r, srgbToLinear(c >> 16) * g);
    gr.g = Math.max(gr.g, srgbToLinear((c >> 8) & 255) * g);
    gr.b = Math.max(gr.b, srgbToLinear(c & 255) * g);
    gr.glows = Math.max(gr.glows, g);
  }
  for (const [key, gr] of groups) {
    out.push({
      key: `b${key}`,
      x: Math.round(gr.x / gr.n) + 0.5,
      y: Math.round(gr.y / gr.n) + 0.5,
      z: Math.round(gr.z / gr.n) + 0.5,
      r: gr.r,
      g: gr.g,
      b: gr.b,
      reach: 2 + GLOW_REACH * gr.glows,
      flicker: 0,
    });
  }
  for (const f of inp.fires) {
    const [r, g, b] = FIRE_COLOR;
    out.push({ key: `f${f.key}`, x: f.x, y: f.y, z: f.z, r, g, b, reach: FIRE_REACH, flicker: 1 });
  }
  return out;
}

function objectBoxes(inp: LightInputs, o: WorldObject, d: DesignContent): number[][] {
  if (!inp.pose) return poseBoxes(d, o.pos, o.rot, o.pieces);
  const root = inp.pose(o, 0);
  if (!root) return poseBoxes(d, o.pos, o.rot, o.pieces);
  const pieces = o.pieces?.map((p, k) => {
    const at = inp.pose!(o, k + 1);
    return at ? { ...p, pos: at.pos, rot: at.rot } : p;
  });
  return poseBoxes(d, root.pos, root.rot, pieces);
}

/** Block indices of every glowing block in `world`. */
export function glowingBlocks(world: World, blocks: BlockRegistry): Set<number> {
  const out = new Set<number>();
  const glows = new Uint8Array(256);
  let any = false;
  for (let id = 0; id < 256; id++) if (blocks.get(id)?.glows) glows[id] = 1, any = true;
  if (!any) return out;
  const b = world.blocks;
  for (let i = 0; i < b.length; i++) if (glows[b[i]]) out.add(i);
  return out;
}

// ---------------------------------------------------------------- daylight

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Daylight at a cell, 0-1: the sun's height (the renderer's arc), dimmed by clouds and by a roof
 * overhead. Moonlit nights give a little.
 */
export function daylight(
  world: World,
  timeOfDay: number,
  clouds: number,
  x: number,
  y: number,
  z: number,
): number {
  const a = (timeOfDay - 0.25) * Math.PI * 2;
  const v = [Math.cos(a) * 0.8, Math.sin(a), 0.45];
  const elev = v[1] / Math.hypot(v[0], v[1], v[2]);
  const sun = smooth(0, 0.25, elev) * (1 - 0.45 * clouds);
  const open = world.heightAt(x, z) < Math.floor(y);
  return Math.max(0.03, sun) * (open ? 1 : 0.3);
}
