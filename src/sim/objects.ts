import type { Catalog, DesignContent, DesignPart, Vec3 } from "./catalog.ts";
import type { World } from "./world.ts";

/**
 * Objects: Designs built from Parts, standing on the tile grid. An Object is anchored at its
 * Design's first cell, turned in quarter turns, and costs each part's volume in that part's
 * Material. For walking (physics phase 1) every part is rasterized to the tiles it covers: a low
 * top (up to a block above the ground) is stood on, anything taller is walked around, and parts
 * two blocks or more above the ground leave room to walk underneath.
 */

export interface WorldObject {
  id: number;
  /** The Design entry it was built from. */
  design: number;
  /** West-north corner of the turned Design, and the height its bottom (y = 0) stands at. */
  x: number;
  y: number;
  z: number;
  /** Quarter turns clockwise seen from above (east toward south), 0-3. */
  turn: number;
  /** Who built it. */
  by: string;
}

/** Tops lower than this over the ground are flat (a rug): no lift, nothing in the way. */
const FLAT = 0.05;
/** How far a part must reach into a tile to cover it. */
const COVER = 0.2;
/** A part whose bottom is this high over the ground leaves room to walk under it. */
const HEADROOM = 2;
/** Volume of each shape as a share of its bounding box. */
const FILL: Record<string, number> = {
  box: 1,
  sphere: Math.PI / 6,
  cylinder: Math.PI / 4,
  cone: Math.PI / 12,
};

const DEG = Math.PI / 180;

/** A part's bounding box in Design space, after its own turn and tilt: [min, max]. */
export function partBounds(p: DesignPart): [Vec3, Vec3] {
  const ct = Math.cos(p.tilt * DEG), st = Math.sin(p.tilt * DEG);
  const cy = Math.cos(p.turn * DEG), sy = Math.sin(p.turn * DEG);
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const vx = (i & 1 ? 0.5 : -0.5) * p.size[0];
    const vy = (i & 2 ? 0.5 : -0.5) * p.size[1];
    const vz = (i & 4 ? 0.5 : -0.5) * p.size[2];
    // The renderer's turn·tilt (render/designs.ts): tilt about x, then turn about y.
    const ty = ct * vy - st * vz, tz = st * vy + ct * vz;
    const x = cy * vx + sy * tz, z = -sy * vx + cy * tz;
    const v: Vec3 = [p.at[0] + x, p.at[1] + ty, p.at[2] + z];
    for (let k = 0; k < 3; k++) lo[k] = Math.min(lo[k], v[k]), hi[k] = Math.max(hi[k], v[k]);
  }
  return [lo, hi];
}

/** Columns × rows a Design spans before turning: its block grid and its parts, at least 1 × 1. */
export function designSpan(d: DesignContent): [number, number] {
  let w = 1, dd = 1;
  if (d.blocks) {
    for (const layer of d.blocks.layers) {
      dd = Math.max(dd, layer.length);
      for (const row of layer) w = Math.max(w, [...row].length);
    }
  }
  for (const p of d.parts) {
    const [, hi] = partBounds(p);
    w = Math.max(w, Math.ceil(hi[0] - 1e-6)), dd = Math.max(dd, Math.ceil(hi[2] - 1e-6));
  }
  return [w, dd];
}

/**
 * A point (x, z) of a `span` Design turned `turn` quarter turns within its bounds, so the turned
 * Design still starts at its west-north corner.
 */
export function turnPoint(
  x: number,
  z: number,
  turn: number,
  span: [number, number],
): [number, number] {
  const [w, d] = span;
  switch (turn & 3) {
    case 1:
      return [d - z, x];
    case 2:
      return [w - x, d - z];
    case 3:
      return [z, w - x];
    default:
      return [x, z];
  }
}

/** What building a Design's parts costs: each part's volume in its Material, at least 1. */
export function partCost(d: DesignContent): Map<string, number> {
  const cost = new Map<string, number>();
  for (const p of d.parts) {
    const v = p.size[0] * p.size[1] * p.size[2] * (FILL[p.part] ?? 1);
    cost.set(p.material, (cost.get(p.material) ?? 0) + Math.max(1, Math.ceil(v - 1e-6)));
  }
  return cost;
}

/** One part's box in the world: x0, x1, y0, y1, z0, z1. */
type Box = [number, number, number, number, number, number];

export class Objects {
  readonly list: WorldObject[] = [];
  version = 0;
  private boxes = new Map<number, Box[]>();
  private tiles = new Map<number, number[]>();

  constructor(readonly world: World, public catalog: Catalog) {}

  get(id: number): WorldObject | undefined {
    return this.list.find((o) => o.id === id);
  }

  /** The Object covering tile (x, z), if any. */
  at(x: number, z: number): WorldObject | undefined {
    const w = this.world;
    if (x < 0 || z < 0 || x >= w.sizeX || z >= w.sizeZ) return undefined;
    const id = w.objectAt[z * w.sizeX + x];
    return id ? this.get(id) : undefined;
  }

  design(o: WorldObject): DesignContent | null {
    const e = this.catalog.get(o.design);
    return e?.kind === "design" ? e.content as DesignContent : null;
  }

  /** The world boxes of Design `d`'s parts placed at (x, y, z) turned `turn`. */
  static boxes(d: DesignContent, x: number, y: number, z: number, turn: number): Box[] {
    const span = designSpan(d);
    return d.parts.map((p) => {
      const [lo, hi] = partBounds(p);
      const a = turnPoint(lo[0], lo[2], turn, span), b = turnPoint(hi[0], hi[2], turn, span);
      return [
        x + Math.min(a[0], b[0]),
        x + Math.max(a[0], b[0]),
        y + lo[1],
        y + hi[1],
        z + Math.min(a[1], b[1]),
        z + Math.max(a[1], b[1]),
      ];
    });
  }

  /** Tile keys a set of part boxes covers. */
  static cover(world: World, boxes: Box[]): number[] {
    const keys = new Set<number>();
    for (const [x0, x1, , , z0, z1] of boxes) {
      let tx0 = Math.floor(x0 + COVER), tx1 = Math.ceil(x1 - COVER) - 1;
      let tz0 = Math.floor(z0 + COVER), tz1 = Math.ceil(z1 - COVER) - 1;
      if (tx1 < tx0) tx0 = tx1 = Math.floor((x0 + x1) / 2);
      if (tz1 < tz0) tz0 = tz1 = Math.floor((z0 + z1) / 2);
      for (let tz = tz0; tz <= tz1; tz++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          if (tx >= 0 && tz >= 0 && tx < world.sizeX && tz < world.sizeZ) {
            keys.add(tz * world.sizeX + tx);
          }
        }
      }
    }
    return [...keys];
  }

  add(o: WorldObject) {
    this.list.push(o);
    this.raster(o);
    this.version++;
  }

  remove(o: WorldObject) {
    const i = this.list.indexOf(o);
    if (i < 0) return;
    this.list.splice(i, 1);
    this.clear(o);
    this.version++;
  }

  /** The ground under column (x, z) changed: re-rasterize the Object standing there. */
  refresh(x: number, z: number) {
    const o = this.at(x, z);
    if (!o) return;
    this.clear(o);
    this.raster(o);
  }

  /** Replace everything (load, or the page mirroring the worker's list). */
  reset(list: WorldObject[]) {
    for (const o of [...this.list]) this.clear(o);
    this.list.length = 0;
    for (const o of list) this.list.push({ ...o }), this.raster(this.list[this.list.length - 1]);
    this.version++;
  }

  nextId(): number {
    return this.list.reduce((m, o) => Math.max(m, o.id), 0) + 1;
  }

  private clear(o: WorldObject) {
    const w = this.world;
    for (const key of this.tiles.get(o.id) ?? []) {
      if (w.objectAt[key] !== o.id) continue;
      w.objectAt[key] = 0, w.objSolid[key] = 0, w.objLift[key] = 0;
    }
    this.tiles.delete(o.id);
    this.boxes.delete(o.id);
  }

  /** Mark the tiles `o` covers: stood on (lift), in the way (solid), or just under it. */
  private raster(o: WorldObject) {
    const d = this.design(o);
    if (!d) return;
    const w = this.world;
    const boxes = Objects.boxes(d, o.x, o.y, o.z, o.turn);
    const keys = Objects.cover(w, boxes);
    this.boxes.set(o.id, boxes);
    this.tiles.set(o.id, keys);
    for (const key of keys) {
      const tx = key % w.sizeX, tz = Math.floor(key / w.sizeX);
      const ground = w.top[key] + 1;
      let top = -Infinity;
      for (const b of boxes) {
        const [x0, x1, y0, y1, z0, z1] = b;
        if (x1 <= tx || x0 >= tx + 1 || z1 <= tz || z0 >= tz + 1) continue;
        if (y0 - ground >= HEADROOM || y1 <= ground) continue; // overhead, or buried
        top = Math.max(top, y1);
      }
      const lift = top - ground;
      w.objectAt[key] = o.id;
      w.objSolid[key] = lift > 1 ? 1 : 0;
      w.objLift[key] = lift > FLAT && lift <= 1 ? lift : 0;
    }
  }
}

/** Ticks to put up or take apart one part. */
export const PART_TICKS = 10;

/** Short "2 planks, 1 stone" text for a cost. */
export function costText(cost: Map<string, number>): string {
  return [...cost].map(([m, n]) => `${n} ${m}`).join(", ");
}
