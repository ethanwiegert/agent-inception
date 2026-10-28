import type { Catalog, DesignContent, DesignPart, MaterialContent } from "./catalog.ts";
import { plantInfo } from "./props.ts";
import type { World } from "./world.ts";

/**
 * Objects are Designs a villager built. Every built Design is recorded so `look` can name it.
 * Only a solid Design (a part whose Material has hardness 3 or more, the same line as
 * `PlantInfo.solid`) gets collision this milestone: each of its hard parts stamps the cells its
 * shape covers, and bodies walk around those cells and stand on them. Softer parts do not collide.
 */

export interface GameObject {
  id: number;
  /** The Design entry it was built from. */
  design: number;
  /** Design origin: block (x, y, z) is local cell (0, 0, 0). (0.5, 0, 0.5) is the tile center. */
  x: number;
  y: number;
  z: number;
}

const DEG = Math.PI / 180;
/** Hardness at which a part blocks walking. Matches `PlantInfo.solid`. */
const SOLID = 3;

export class Objects {
  list: GameObject[] = [];
  version = 0;
  private next = 1;

  constructor(readonly world: World) {}

  find(design: number, x: number, y: number, z: number): GameObject | undefined {
    return this.list.find((o) => o.design === design && o.x === x && o.y === y && o.z === z);
  }

  /** Objects whose origin tile is (x, z). */
  at(x: number, z: number): GameObject[] {
    return this.list.filter((o) => o.x === x && o.z === z);
  }

  add(catalog: Catalog, design: number, x: number, y: number, z: number): GameObject {
    const o: GameObject = { id: this.next++, design, x, y, z };
    this.list.push(o);
    this.stamp(catalog, o);
    this.version++;
    return o;
  }

  /** Replace the list from a save and rebuild collision. */
  restore(catalog: Catalog, rows: [number, number, number, number][]) {
    this.list = rows.map(([design, x, y, z], i) => ({ id: i + 1, design, x, y, z }));
    this.next = this.list.length + 1;
    this.rebuild(catalog);
  }

  /** Take an Object out of the world and rebuild whatever collision remains. */
  remove(id: number, catalog: Catalog): GameObject | undefined {
    const i = this.list.findIndex((o) => o.id === id);
    if (i < 0) return;
    const [gone] = this.list.splice(i, 1);
    this.rebuild(catalog);
    return gone;
  }

  private rebuild(catalog: Catalog) {
    this.world.clearObjectCells();
    for (const o of this.list) this.stamp(catalog, o);
    this.version++;
  }

  private stamp(catalog: Catalog, o: GameObject) {
    if (!plantInfo(catalog, o.design)?.solid) return;
    const entry = catalog.get(o.design);
    if (!entry || entry.kind !== "design") return;
    for (const p of (entry.content as DesignContent).parts) {
      const mat = catalog.byName(p.material)?.content as MaterialContent | undefined;
      if (!mat || mat.hardness < SOLID) continue;
      stampPart(this.world, o, p);
    }
  }
}

/** Whether local point (lx, ly, lz) lies in the part's shape, centered on the part. */
export function shapeContains(
  shape: string,
  lx: number,
  ly: number,
  lz: number,
  sx: number,
  sy: number,
  sz: number,
): boolean {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  if (hx <= 0 || hy <= 0 || hz <= 0) return false;
  if (shape === "box") return Math.abs(lx) <= hx && Math.abs(ly) <= hy && Math.abs(lz) <= hz;
  if (shape === "sphere") {
    const x = lx / hx, y = ly / hy, z = lz / hz;
    return x * x + y * y + z * z <= 1;
  }
  if (shape === "cylinder") {
    const x = lx / hx, z = lz / hz;
    return x * x + z * z <= 1 && Math.abs(ly) <= hy;
  }
  if (shape === "cone") {
    if (ly < -hy || ly > hy) return false;
    const radius = 1 - (ly + hy) / (hy * 2);
    if (radius <= 0) return lx === 0 && lz === 0;
    const x = lx / (hx * radius), z = lz / (hz * radius);
    return x * x + z * z <= 1;
  }
  return false;
}

/**
 * World offset to part-local coordinates. The mesh is Ry(turn) then Rx(tilt); this is the inverse,
 * so collision matches the rendered part.
 */
function toLocal(
  wx: number,
  wy: number,
  wz: number,
  px: number,
  py: number,
  pz: number,
  turn: number,
  tilt: number,
): [number, number, number] {
  const cy = Math.cos(turn), sy = Math.sin(turn);
  const cx = Math.cos(tilt), sx = Math.sin(tilt);
  const x = wx - px, y = wy - py, z = wz - pz;
  const x1 = cy * x - sy * z;
  const z1 = sy * x + cy * z;
  return [x1, cx * y + sx * z1, -sx * y + cx * z1];
}

function stampPart(world: World, o: GameObject, p: DesignPart) {
  const [sx, sy, sz] = p.size;
  const px = o.x + p.at[0], py = o.y + p.at[1], pz = o.z + p.at[2];
  const reach = 0.5 * Math.hypot(sx, sy, sz);
  const x0 = Math.max(0, Math.floor(px - reach));
  const y0 = Math.max(0, Math.floor(py - reach));
  const z0 = Math.max(0, Math.floor(pz - reach));
  const x1 = Math.min(world.sizeX - 1, Math.floor(px + reach));
  const y1 = Math.min(world.sizeY - 1, Math.floor(py + reach));
  const z1 = Math.min(world.sizeZ - 1, Math.floor(pz + reach));
  const turn = p.turn * DEG, tilt = p.tilt * DEG;
  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (cellHits(p.part, px, py, pz, sx, sy, sz, turn, tilt, x, y, z)) {
          world.fillObjectCell(x, y, z);
        }
      }
    }
  }
}

/** A cell is solid when the shape contains its center or another sample inside it. */
function cellHits(
  shape: string,
  px: number,
  py: number,
  pz: number,
  sx: number,
  sy: number,
  sz: number,
  turn: number,
  tilt: number,
  x: number,
  y: number,
  z: number,
): boolean {
  for (const fy of [0.5, 0.2, 0.8]) {
    for (const fz of [0.5, 0.2, 0.8]) {
      for (const fx of [0.5, 0.2, 0.8]) {
        const [lx, ly, lz] = toLocal(x + fx, y + fy, z + fz, px, py, pz, turn, tilt);
        if (shapeContains(shape, lx, ly, lz, sx, sy, sz)) return true;
      }
    }
  }
  return false;
}
