import { identity, mat4, rotateY, scale, translate } from "../math.ts";
import type { Catalog, DesignContent } from "../sim/catalog.ts";
import type { Props } from "../sim/props.ts";
import { hash2 } from "../sim/rng.ts";
import type { World } from "../sim/world.ts";
import { meshDesign } from "./designs.ts";
import type { InstanceBatch, MeshLibrary } from "./meshes.ts";

/** Water surfaces sit this far below the top of their water block (see water.ts). */
const SURFACE_DROP = 0.12;

/** Mesh templates for plant Designs, made the first time each Design is drawn. */
export class FloraModels {
  private ids = new Map<number, number>();
  private catalog: Catalog | null = null;

  constructor(private lib: MeshLibrary) {}

  /** Template id for Design `design` in `catalog`, or -1 if it isn't a drawable Design. */
  template(catalog: Catalog, design: number): number {
    if (catalog !== this.catalog) this.catalog = catalog, this.ids.clear();
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
}

const m = mat4();

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
) {
  out.clear();
  small.clear();
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

/**
 * Built Designs, drawn from their parts. The instance origin is the tile center on the design's
 * base, which is where `meshDesign` puts (0.5, 0, 0.5). Blocks of the same Design are voxels.
 */
export function buildObjects(
  objects: { design: number; x: number; y: number; z: number }[],
  catalog: Catalog,
  out: InstanceBatch,
  models: FloraModels,
) {
  out.clear();
  for (const o of objects) {
    const e = catalog.get(o.design);
    if (e?.kind !== "design" || !(e.content as DesignContent).parts.length) continue;
    const tid = models.template(catalog, o.design);
    if (tid < 0) continue;
    identity(m);
    translate(m, o.x + 0.5, o.y, o.z + 0.5);
    out.add(tid, m, 1, 1, 1, 1);
  }
}

/** Whether any prop is still growing (so the batch needs refreshing now and then). */
export function anyGrowing(props: Props, tick: number): boolean {
  for (const p of props.map.values()) if (props.growth(p, tick) < 1) return true;
  return false;
}
