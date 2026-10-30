import { identity, mat4, rotateY, scale, translate } from "../math.ts";
import type { Catalog, DesignContent } from "../sim/catalog.ts";
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
  private still = new Map<number, number>();
  private catalog: Catalog | null = null;

  constructor(private lib: MeshLibrary) {}

  /** Template id for Design `design` in `catalog`, or -1 if it isn't a drawable Design. */
  template(catalog: Catalog, design: number): number {
    if (catalog !== this.catalog) this.catalog = catalog, this.ids.clear(), this.still.clear();
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

  /** The same, held still: built Objects don't sway in the wind. */
  stillTemplate(catalog: Catalog, design: number): number {
    if (catalog !== this.catalog) this.catalog = catalog, this.ids.clear(), this.still.clear();
    let id = this.still.get(design);
    if (id !== undefined) return id;
    const e = catalog.get(design);
    id = -1;
    if (e?.kind === "design") {
      id = this.lib.define(
        `object:${design}`,
        (b) => meshDesign(b, catalog, e.content as DesignContent, { role: null, sway: false }),
      );
    }
    this.still.set(design, id);
    return id;
  }
}

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
    const pose = poses.get(o.id);
    const tid = pose ? models.stillTemplate(objects.catalog, o.design) : -1;
    if (tid < 0) continue;
    const [x, y, z, w] = pose!.rot;
    // translate(pos) · R(rot) · translate(ANCHOR): the template's origin is the Design's anchor.
    m[0] = 1 - 2 * (y * y + z * z), m[1] = 2 * (x * y + z * w), m[2] = 2 * (x * z - y * w);
    m[3] = 0;
    m[4] = 2 * (x * y - z * w), m[5] = 1 - 2 * (x * x + z * z), m[6] = 2 * (y * z + x * w);
    m[7] = 0;
    m[8] = 2 * (x * z + y * w), m[9] = 2 * (y * z - x * w), m[10] = 1 - 2 * (x * x + y * y);
    m[11] = 0;
    m[12] = pose!.pos[0], m[13] = pose!.pos[1], m[14] = pose!.pos[2], m[15] = 1;
    translate(m, ANCHOR[0], ANCHOR[1], ANCHOR[2]);
    out.add(tid, m, 1, 1, 1, 1);
  }
}

/** Whether any prop is still growing (so the batch needs refreshing now and then). */
export function anyGrowing(props: Props, tick: number): boolean {
  for (const p of props.map.values()) if (props.growth(p, tick) < 1) return true;
  return false;
}
