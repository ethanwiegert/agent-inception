import {
  type Catalog,
  type DesignContent,
  type Entry,
  type Habitat,
  type MaterialContent,
  natureCatalog,
  type Zone,
} from "./catalog.ts";
import { BUILTIN_BLOCKS } from "./blocks.ts";
import { fbm2 } from "./noise.ts";
import { hash2 } from "./rng.ts";
import { Block, World } from "./world.ts";
import { SEA_LEVEL } from "./worldgen.ts";

/**
 * Props are plants and boulders standing on a tile: Objects grown from nature's Designs (trees,
 * bushes, flowers, reeds, rocks, lily pads) or planted by villagers. At most one per tile. The
 * generated set is rebuilt from the seed and nature's Catalog; saves keep only the difference.
 */

/** `planted` for things that were always there (fully grown). */
export const GROWN = -(2 ** 31);

export interface Prop {
  /** The Design entry it was grown from. */
  design: number;
  /** Tick it was planted, or GROWN. */
  planted: number;
  /** Ticks from planting to full size, fixed when planted; 0 for things that don't grow. */
  grow: number;
}

/** Saved/streamed changes: tile keys removed from the generated set, and props added or changed. */
export interface PropDiff {
  removed: number[];
  /** [tile key, design, planted, grow] */
  added: [number, number, number, number][];
}

/** What the engine reads off a plant's Design. */
export interface PlantInfo {
  entry: Entry;
  mark: string;
  /** Hard parts (hardness 3 and up, like bark and stone) block walking and building. */
  solid: boolean;
  /** Thin things (every part thinner than 0.1) are ground cover: no shadow, drawn near only. */
  small: boolean;
  /** Low, light things float on water instead of standing on the bed. */
  floats: boolean;
  habitat: Habitat | null;
}

const infoCache = new WeakMap<Catalog, Map<number, PlantInfo>>();

/** The engine's reading of Design `id`, cached (entries never change). */
export function plantInfo(catalog: Catalog, id: number): PlantInfo | null {
  let cache = infoCache.get(catalog);
  if (!cache) infoCache.set(catalog, cache = new Map());
  const hit = cache.get(id);
  if (hit) return hit;
  const entry = catalog.get(id);
  if (!entry || entry.kind !== "design") return null;
  const d = entry.content as DesignContent;
  const mat = (name: string) => catalog.byName(name)?.content as MaterialContent | undefined;
  let top = 0;
  for (const p of d.parts) top = Math.max(top, p.at[1] + p.size[1] / 2);
  const info: PlantInfo = {
    entry,
    // An omitted mark takes the first look-map-safe character. Names may start with a digit
    // ("2 clover"); a digit would read as another villager.
    mark: d.mark ?? [...entry.name].find((ch) => ch.charCodeAt(0) >= 33 && !/[\s\d@]/.test(ch)) ??
      "?",
    solid: d.parts.some((p) => (mat(p.material)?.hardness ?? 0) >= 3),
    small: d.parts.every((p) => Math.min(...p.size) < 0.1),
    floats: top <= 0.25 && d.parts.every((p) => (mat(p.material)?.density ?? 1) < 1),
    habitat: d.habitat ?? null,
  };
  info.small &&= !info.solid;
  cache.set(id, info);
  return info;
}

/**
 * Why a plant's habitat refuses this tile: the ground isn't in `on`, or it's underwater and the
 * plant neither floats nor lists shore or shallows. The same check `plant` uses.
 */
export function habitatRefusal(
  world: World,
  info: PlantInfo,
  x: number,
  z: number,
  ground: string,
): string | void {
  const h = info.habitat;
  if (!h) return "isn't a plant";
  if (!h.on.includes(ground)) return `grows on ${h.on.join(" or ")}, not ${ground}`;
  const wet = info.floats || h.zones.some((zone) => zone === "shallows" || zone === "shore");
  if (!wet && world.waterTop[z * world.sizeX + x] >= 0) return "under water";
}

export class Props {
  readonly map: Map<number, Prop>;
  version = 0;
  private generated: Map<number, Prop>;

  /**
   * Generate from a pristine world (before any edits) and `seed`, or take an already generated set
   * (the page mirrors the worker's). `catalog` says what each Design is.
   */
  constructor(readonly world: World, seed: number | Int32Array, public catalog: Catalog) {
    this.generated = typeof seed === "number" ? generateProps(world, seed) : unpack(seed);
    this.map = new Map(this.generated);
    for (const [key, p] of this.map) world.propSolid[key] = this.solid(p) ? 1 : 0;
  }

  info(p: Prop): PlantInfo | null {
    return plantInfo(this.catalog, p.design);
  }

  at(x: number, z: number): Prop | undefined {
    const w = this.world;
    if (x < 0 || z < 0 || x >= w.sizeX || z >= w.sizeZ) return undefined;
    return this.map.get(z * w.sizeX + x);
  }

  set(x: number, z: number, prop: Prop | null) {
    const key = z * this.world.sizeX + x;
    if (prop) this.map.set(key, prop);
    else this.map.delete(key);
    this.world.propSolid[key] = prop && this.solid(prop) ? 1 : 0;
    this.version++;
  }

  /** 0-1: how grown a prop is at `tick`. */
  growth(p: Prop, tick: number): number {
    if (!p.grow || p.planted === GROWN) return 1;
    return Math.min(1, Math.max(0, (tick - p.planted) / p.grow));
  }

  /** The generated set as flat [tile key, design, planted, grow] quads, for the page's mirror. */
  packGenerated(): Int32Array<ArrayBuffer> {
    const out = new Int32Array(this.generated.size * 4);
    let i = 0;
    for (const [key, p] of this.generated) {
      out[i++] = key, out[i++] = p.design, out[i++] = p.planted, out[i++] = p.grow;
    }
    return out;
  }

  diff(): PropDiff {
    const removed: number[] = [];
    const added: PropDiff["added"] = [];
    for (const key of this.generated.keys()) if (!this.map.has(key)) removed.push(key);
    for (const [key, p] of this.map) {
      const g = this.generated.get(key);
      if (!g || g.design !== p.design || g.planted !== p.planted || g.grow !== p.grow) {
        added.push([key, p.design, p.planted, p.grow]);
      }
    }
    return { removed, added };
  }

  /** Back to the generated set plus `d` (the page mirrors full diffs this way). */
  reset(d: PropDiff) {
    for (const key of this.map.keys()) this.world.propSolid[key] = 0;
    this.map.clear();
    for (const [key, p] of this.generated) {
      this.map.set(key, p);
      if (this.solid(p)) this.world.propSolid[key] = 1;
    }
    this.applyDiff(d);
    this.version++;
  }

  applyDiff(d: PropDiff) {
    const w = this.world.sizeX;
    for (const key of d.removed) this.set(key % w, Math.floor(key / w), null);
    for (const [key, design, planted, grow] of d.added) {
      if (!plantInfo(this.catalog, design)) continue;
      this.set(key % w, Math.floor(key / w), { design, planted, grow });
    }
  }

  private solid(p: Prop): boolean {
    return this.info(p)?.solid ?? false;
  }
}

function unpack(packed: Int32Array): Map<number, Prop> {
  const map = new Map<number, Prop>();
  for (let i = 0; i < packed.length; i += 4) {
    map.set(packed[i], { design: packed[i + 1], planted: packed[i + 2], grow: packed[i + 3] });
  }
  return map;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Nature's wild plants by zone, in Catalog order: [design id, ground it grows on, share]. */
function wildPlants(): Map<Zone, { id: number; on: Set<string>; share: number }[]> {
  const zones = new Map<Zone, { id: number; on: Set<string>; share: number }[]>();
  for (const e of natureCatalog().entries) {
    const h = e.kind === "design" ? (e.content as DesignContent).habitat : undefined;
    if (!h) continue;
    for (const z of h.zones) {
      const list = zones.get(z) ?? [];
      list.push({ id: e.id, on: new Set(h.on), share: h.share });
      zones.set(z, list);
    }
  }
  return zones;
}

/**
 * Plants on a jittered grid for trees (one candidate per 3×3 cell), then smaller things by
 * habitat. The world generator reads the terrain (forest noise, altitude, slopes, water) to find
 * each tile's zone; which Designs grow in a zone, on what ground and how often, is Catalog data.
 */
export function generateProps(world: World, seed: number): Map<number, Prop> {
  const { sizeX, sizeZ } = world;
  const props = new Map<number, Prop>();
  const plants = wildPlants();
  const ground = (x: number, z: number) => {
    const h = world.heightAt(x, z);
    return BUILTIN_BLOCKS[world.get(x, h, z)] ?? "";
  };
  /** A Design for this zone that grows on this ground, picked in patches so kinds form groves. */
  const pick = (zone: Zone, x: number, z: number): number => {
    const all = plants.get(zone);
    if (!all) return -1;
    const g = ground(x, z);
    const fit = all.filter((p) => p.on.has(g));
    if (fit.length <= 1) return fit[0]?.id ?? -1;
    // Trees form groves; small plants form patches.
    const cell = zone === "forest" || zone === "highland" ? 20 : 9;
    const wx = x + fbm2(x * 0.05, z * 0.05, seed + 830, 2) * cell * 0.7;
    const wz = z + fbm2(x * 0.05, z * 0.05, seed + 840, 2) * cell * 0.7;
    let u = hash2(Math.floor(wx / cell), Math.floor(wz / cell), seed + 803 + zone.length);
    const total = fit.reduce((s, p) => s + p.share, 0);
    for (const p of fit) {
      u -= p.share / total;
      if (u < 0) return p.id;
    }
    return fit[fit.length - 1].id;
  };
  const water = (x: number, z: number) =>
    x >= 0 && z >= 0 && x < sizeX && z < sizeZ && world.waterTop[z * sizeX + x] >= 0;
  const nearWater = (x: number, z: number) =>
    water(x + 1, z) || water(x - 1, z) || water(x, z + 1) || water(x, z - 1);
  const nearLand = (x: number, z: number) =>
    !water(x + 1, z) || !water(x - 1, z) || !water(x, z + 1) || !water(x, z - 1);
  const slope = (x: number, z: number) => {
    const h = world.heightAt(x, z);
    let s = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = world.heightAt(x + dx, z + dz);
      if (n >= 0) s = Math.max(s, Math.abs(n - h));
    }
    return s;
  };
  // Leave a clearing around the spawn point so farmers have room.
  const clearing = (x: number, z: number) =>
    smoothstep(12, 26, Math.hypot(x - sizeX / 2, z - sizeZ / 2));
  const forest = (x: number, z: number) => fbm2(x * 0.018, z * 0.018, seed + 600, 3);
  const put = (x: number, z: number, design: number) => {
    if (design >= 0) props.set(z * sizeX + x, { design, planted: GROWN, grow: 0 });
  };

  const CELL = 3;
  for (let cz = 0; cz < sizeZ; cz += CELL) {
    for (let cx = 0; cx < sizeX; cx += CELL) {
      const x = cx + Math.floor(hash2(cx, cz, seed + 101) * CELL);
      const z = cz + Math.floor(hash2(cx, cz, seed + 102) * CELL);
      if (x >= sizeX || z >= sizeZ) continue;
      const h = world.heightAt(x, z);
      if (world.get(x, h, z) !== Block.Grass || water(x, z) || nearWater(x, z)) continue;
      if (slope(x, z) > 1) continue;
      const density = (smoothstep(0.0, 0.4, forest(x, z)) * 0.85 + 0.035) * clearing(x, z);
      if (hash2(x, z, seed + 103) >= density) continue;
      const altitude = h - SEA_LEVEL + fbm2(x * 0.05, z * 0.05, seed + 650, 2) * 3;
      put(x, z, pick(altitude > 7 ? "highland" : "forest", x, z));
    }
  }

  for (let z = 0; z < sizeZ; z++) {
    for (let x = 0; x < sizeX; x++) {
      const key = z * sizeX + x;
      if (props.has(key)) continue;
      const h = world.heightAt(x, z);
      if (h < 0) continue;
      const block = world.get(x, h, z);
      const roll = hash2(x, z, seed + 201);
      let design = -1;
      if (water(x, z)) {
        const depth = world.waterTop[key] - h;
        const calm = fbm2(x * 0.06, z * 0.06, seed + 820, 2);
        if (depth === 1 && nearLand(x, z) && roll < 0.3) design = pick("shore", x, z);
        else if (depth <= 2 && calm > 0.15 && roll < 0.3) design = pick("shallows", x, z);
      } else if (block === Block.Grass || block === Block.Sand) {
        const sand = block === Block.Sand;
        const f = forest(x, z);
        const flowers = fbm2(x * 0.07, z * 0.07, seed + 800, 2);
        if (nearWater(x, z) && roll < (sand ? 0.18 : 0.3)) design = pick("shore", x, z);
        else if (slope(x, z) >= 2 && roll < 0.08 * clearing(x, z)) design = pick("slope", x, z);
        else if (roll < 0.006 * clearing(x, z)) design = pick("scattered", x, z);
        else if (
          !sand && roll < 0.006 + 0.05 * smoothstep(-0.2, 0.2, f) * smoothstep(0.5, 0.2, f)
        ) {
          design = pick("forest edge", x, z);
        } else if (!sand && flowers > 0.3 && roll < 0.3 * clearing(x, z) + 0.05) {
          design = pick("meadow", x, z);
        }
      } else if (block === Block.Gravel && roll < 0.05) {
        design = pick("riverbed", x, z);
      }
      put(x, z, design);
    }
  }
  return props;
}
