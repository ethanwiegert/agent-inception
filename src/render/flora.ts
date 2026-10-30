import { identity, mat4, rotateX, rotateY, scale, translate } from "../math.ts";
import { type Catalog, type DesignContent, deviceKind, rigOf, type Vec3 } from "../sim/catalog.ts";
import { deviceOn } from "../sim/signals.ts";
import { CROP_STRIDE } from "../sim/protocol.ts";
import type { Props } from "../sim/props.ts";
import type { Objects } from "../sim/objects.ts";
import { hash2 } from "../sim/rng.ts";
import type { World } from "../sim/world.ts";
import { ANCHOR, meshDesign } from "./designs.ts";
import type { BodyPose } from "../simclient.ts";
import type { InstanceBatch, MeshLibrary } from "./meshes.ts";

/** Water surfaces sit this far below the top of their water block (see water.ts). */
const SURFACE_DROP = 0.12;

/** Mesh templates for plant Designs, made the first time each Design is drawn. */
export class FloraModels {
  private ids = new Map<number, number>();
  /** Built Objects' templates, one per piece, by design × 16 + piece. */
  private still = new Map<number, number>();
  /** Levers and plates, one template per part (they move on their own), by `design:part`. */
  private loose = new Map<string, number>();
  private catalog: Catalog | null = null;

  constructor(private lib: MeshLibrary) {}

  /** Template id for Design `design` in `catalog`, or -1 if it isn't a drawable Design. */
  template(catalog: Catalog, design: number): number {
    if (catalog !== this.catalog) this.forget(catalog);
    let id = this.ids.get(design);
    if (id !== undefined) return id;
    const e = catalog.get(design);
    id = -1;
    if (e?.kind === "design") {
      id = this.lib.define(
        `design:${design}`,
        (b) => meshDesign(b, catalog, e.content as DesignContent, { role: null }),
      );
    }
    this.ids.set(design, id);
    return id;
  }

  /**
   * The same, held still (built Objects don't sway in the wind), for one piece of a jointed
   * Design: its parts in Design space, so each piece is drawn at its own pose.
   */
  stillTemplate(catalog: Catalog, design: number, piece = 0): number {
    if (catalog !== this.catalog) this.forget(catalog);
    const key = design * 16 + piece;
    let id = this.still.get(key);
    if (id !== undefined) return id;
    const e = catalog.get(design);
    id = -1;
    if (e?.kind === "design") {
      const d = e.content as DesignContent, of = rigOf(d).pieceOf;
      id = this.lib.define(
        `object:${design}:${piece}`,
        (b) =>
          meshDesign(b, catalog, d, {
            only: (p, i) => of[i] === piece && !movesAlone(p.part),
            sway: false,
          }),
      );
    }
    this.still.set(key, id);
    return id;
  }

  /** A lever's or plate's own template, around its pivot (a lever's foot, a plate's center). */
  partTemplate(catalog: Catalog, design: number, part: number, pivot: Vec3): number {
    if (catalog !== this.catalog) this.forget(catalog);
    const key = `${design}:${part}`;
    let id = this.loose.get(key);
    if (id !== undefined) return id;
    const e = catalog.get(design);
    id = -1;
    if (e?.kind === "design") {
      const d = e.content as DesignContent;
      id = this.lib.define(
        `part:${key}`,
        (b) =>
          meshDesign(b, catalog, d, { only: (_, i) => i === part, sway: false, origin: pivot }),
      );
    }
    this.loose.set(key, id);
    return id;
  }

  private forget(catalog: Catalog) {
    this.catalog = catalog;
    this.ids.clear(), this.still.clear(), this.loose.clear();
  }
}

/** Levers swing and plates sink on their own, so they're drawn apart from their piece. */
const movesAlone = (part: string) => part === "lever" || part === "plate";
/** How far a lever leans each way (radians), and how far a pressed plate sinks. */
const LEVER_SWING = 0.6, PLATE_SINK = 0.03;
const DEG = Math.PI / 180;

const m = mat4();

/**
 * Crops split by their Design's look: `"look": "blades"` crops (wheat) go to the GPU blade field,
 * every other crop is drawn as its own parts, growing, with the props.
 */
export class CropLooks {
  /** Blade crops, packed as the worker sent them. */
  blades = new Float32Array(0);
  /** Bumps when `blades` changes. */
  version = 0;
  /** Indices (into the worker's crops) of crops drawn as parts. */
  parts: number[] = [];
  private seen = -1;
  private seenCatalog = -1;

  /** Re-split when the crops or the Catalog changed; true if anything did. */
  update(crops: Float32Array, cropsVersion: number, catalog: Catalog): boolean {
    if (cropsVersion === this.seen && catalog.version === this.seenCatalog) return false;
    this.seen = cropsVersion, this.seenCatalog = catalog.version;
    const n = crops.length / CROP_STRIDE;
    const blades: number[] = [];
    this.parts = [];
    for (let i = 0; i < n; i++) {
      const e = catalog.get(crops[i * CROP_STRIDE + 7]);
      const d = e?.kind === "design" ? e.content as DesignContent : null;
      if (!d || d.look === "blades" || !d.parts.length) blades.push(i);
      else this.parts.push(i);
    }
    this.blades = new Float32Array(blades.length * CROP_STRIDE);
    blades.forEach((i, j) =>
      this.blades.set(crops.subarray(i * CROP_STRIDE, (i + 1) * CROP_STRIDE), j * CROP_STRIDE)
    );
    this.version++;
    return true;
  }

  /** Whether any part-drawn crop is still growing at `age` ticks after the crops were sent. */
  growing(crops: Float32Array, age: number): boolean {
    return this.parts.some((i) => cropGrowth(crops, i, age) < 1);
  }
}

/** 0-1 growth of crop `i`, `age` ticks after the message its planting tick is relative to. */
function cropGrowth(crops: Float32Array, i: number, age: number): number {
  const planted = crops[i * CROP_STRIDE + 3], grow = crops[i * CROP_STRIDE + 6];
  return grow ? Math.min(1, Math.max(0, (age - planted) / grow)) : 1;
}

/**
 * Fill the batches with every prop (big ones in `out`, ground cover in `small`): jittered within
 * its tile, turned and sized per tile, grown. Floating plants sit on the water.
 */
export function buildProps(
  props: Props,
  world: World,
  tick: number,
  out: InstanceBatch,
  small: InstanceBatch,
  models: FloraModels,
  crops?: { data: Float32Array; looks: CropLooks; age: number },
) {
  out.clear();
  small.clear();
  // Crops that aren't blade fields: their own parts, grown like saplings, upright in the row.
  for (const i of crops?.looks.parts ?? []) {
    const c = crops!.data, k = i * CROP_STRIDE;
    const tid = models.template(props.catalog, c[k + 7]);
    if (tid < 0) continue;
    const size = 0.15 + 0.85 * cropGrowth(c, i, crops!.age);
    identity(m);
    translate(m, c[k] + 0.5, c[k + 1], c[k + 2] + 0.5);
    rotateY(m, hash2(c[k], c[k + 2], 4) * Math.PI * 2);
    scale(m, size, size, size);
    out.add(tid, m, 1, 1, 1, 1);
  }
  const w = world.sizeX;
  for (const [key, p] of props.map) {
    const info = props.info(p);
    if (!info) continue;
    const tid = models.template(props.catalog, p.design);
    if (tid < 0) continue;
    const tx = key % w, tz = Math.floor(key / w);
    const jx = hash2(tx, tz, 1) - 0.5, jz = hash2(tx, tz, 2) - 0.5;
    const big = info.solid;
    const x = tx + 0.5 + jx * (big ? 0.3 : 0.5), z = tz + 0.5 + jz * (big ? 0.3 : 0.5);
    const water = world.waterTop[key];
    const y = info.floats && water >= 0
      ? water + 1 - SURFACE_DROP
      : world.surfaceY(x, z) - (big ? 0.15 : 0.02);
    const size = (0.85 + hash2(tx, tz, 3) * 0.3) * (0.15 + 0.85 * props.growth(p, tick));
    // Trees vary in height a little more than in girth.
    const tall = 0.9 + hash2(tx, tz, 5) * 0.25;
    identity(m);
    translate(m, x, y, z);
    rotateY(m, hash2(tx, tz, 4) * Math.PI * 2);
    scale(m, size, size * (big ? tall : 1), size);
    (info.small ? small : out).add(tid, m, 1, 1, 1, 1);
  }
}

/** Built Objects, wherever physics has them: their Design's origin at `pos`, turned `rot`. */
export function buildObjects(
  objects: Objects,
  poses: Map<number, BodyPose>,
  out: InstanceBatch,
  models: FloraModels,
) {
  for (const o of objects.list) {
    const d = objects.design(o);
    if (!d) continue;
    const of = rigOf(d).pieceOf;
    for (let k = 0; k <= (o.pieces?.length ?? 0); k++) {
      const pose = poses.get(o.id * 16 + k);
      if (!pose) continue;
      // A piece's lamps glow while any of them is lit (tint alpha below 0 when all are dark).
      let lamps = 0, lit = 0;
      d.parts.forEach((p, i) => {
        if (of[i] !== k || deviceKind(p.part) !== "lamp") return;
        lamps++;
        if (deviceOn(o, i, "lamp")) lit++;
      });
      addPose(
        out,
        pose,
        models.stillTemplate(objects.catalog, o.design, k),
        lamps && !lit ? -1 : 1,
      );
      d.parts.forEach((p, i) => {
        if (of[i] !== k || !movesAlone(p.part)) return;
        const lever = p.part === "lever", on = deviceOn(o, i, lever ? "lever" : "plate");
        // A lever turns about its foot, across the way it's turned; a pressed plate sinks a little.
        const c = Math.cos(p.tilt * DEG), sn = Math.sin(p.tilt * DEG), h = p.size[1] / 2;
        const pivot: Vec3 = lever
          ? [
            p.at[0] - Math.sin(p.turn * DEG) * sn * h,
            p.at[1] - c * h,
            p.at[2] - Math.cos(p.turn * DEG) * sn * h,
          ]
          : [...p.at];
        const tid = models.partTemplate(objects.catalog, o.design, i, pivot);
        if (tid < 0) return;
        posed(pose);
        translate(m, pivot[0], pivot[1] - (!lever && on ? PLATE_SINK : 0), pivot[2]);
        if (lever) {
          rotateY(m, p.turn * DEG);
          rotateX(m, on ? LEVER_SWING : -LEVER_SWING);
          rotateY(m, -p.turn * DEG);
        }
        out.add(tid, m, 1, 1, 1, 1);
      });
    }
  }
}

/** `m` = the Design origin's pose: translate(pos) · R(rot). */
function posed(pose: BodyPose) {
  const [x, y, z, w] = pose.rot;
  m[0] = 1 - 2 * (y * y + z * z), m[1] = 2 * (x * y + z * w), m[2] = 2 * (x * z - y * w);
  m[3] = 0;
  m[4] = 2 * (x * y - z * w), m[5] = 1 - 2 * (x * x + z * z), m[6] = 2 * (y * z + x * w);
  m[7] = 0;
  m[8] = 2 * (x * z + y * w), m[9] = 2 * (y * z - x * w), m[10] = 1 - 2 * (x * x + y * y);
  m[11] = 0;
  m[12] = pose.pos[0], m[13] = pose.pos[1], m[14] = pose.pos[2], m[15] = 1;
}

/** One piece's template at its pose; `lit` below 0 darkens its lamps. */
function addPose(out: InstanceBatch, pose: BodyPose, tid: number, lit = 1) {
  if (tid < 0) return;
  const [x, y, z, w] = pose.rot;
  // translate(pos) · R(rot) · translate(ANCHOR): the template's origin is the Design's anchor.
  m[0] = 1 - 2 * (y * y + z * z), m[1] = 2 * (x * y + z * w), m[2] = 2 * (x * z - y * w);
  m[3] = 0;
  m[4] = 2 * (x * y - z * w), m[5] = 1 - 2 * (x * x + z * z), m[6] = 2 * (y * z + x * w);
  m[7] = 0;
  m[8] = 2 * (x * z + y * w), m[9] = 2 * (y * z - x * w), m[10] = 1 - 2 * (x * x + y * y);
  m[11] = 0;
  m[12] = pose.pos[0], m[13] = pose.pos[1], m[14] = pose.pos[2], m[15] = 1;
  translate(m, ANCHOR[0], ANCHOR[1], ANCHOR[2]);
  out.add(tid, m, 1, 1, 1, lit);
}

/** Whether any prop is still growing (so the batch needs refreshing now and then). */
export function anyGrowing(props: Props, tick: number): boolean {
  for (const p of props.map.values()) if (props.growth(p, tick) < 1) return true;
  return false;
}
