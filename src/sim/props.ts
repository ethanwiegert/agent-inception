import { fbm2 } from "./noise.ts";
import { hash2 } from "./rng.ts";
import { Block, World } from "./world.ts";
import { SEA_LEVEL } from "./worldgen.ts";

/**
 * Props are things that stand on a tile without being blocks: trees, bushes, flowers, reeds,
 * rocks, lily pads. At most one per tile. The generated set is rebuilt from the seed; saves keep
 * only the difference.
 */
export interface PropDef {
  name: string;
  /** Blocks walking and building on its tile. */
  solid: boolean;
  variants: number;
  /** Ticks from sapling to full size; 0 for things that don't grow. */
  growTicks: number;
  /** What `look` shows for it. */
  mark: string;
}

export const PropKind = {
  Oak: 0,
  Birch: 1,
  Pine: 2,
  Bush: 3,
  Flowers: 4,
  Reeds: 5,
  Rock: 6,
  LilyPad: 7,
} as const;

/** A sapling planted now takes two game days to grow into a tree (20 real minutes at 1×). */
const TREE_GROW = 20 * 600 * 2;

export const PROP_DEFS: PropDef[] = [
  { name: "oak", solid: true, variants: 3, growTicks: TREE_GROW, mark: "T" },
  { name: "birch", solid: true, variants: 3, growTicks: TREE_GROW, mark: "T" },
  { name: "pine", solid: true, variants: 3, growTicks: TREE_GROW, mark: "A" },
  { name: "bush", solid: false, variants: 2, growTicks: 0, mark: "b" },
  { name: "flowers", solid: false, variants: 4, growTicks: 0, mark: "*" },
  { name: "reeds", solid: false, variants: 2, growTicks: 0, mark: "|" },
  { name: "rock", solid: true, variants: 3, growTicks: 0, mark: "o" },
  { name: "lily pad", solid: false, variants: 2, growTicks: 0, mark: "%" },
];

/** `planted` for things that were always there (fully grown). */
export const GROWN = -(2 ** 31);

export interface Prop {
  kind: number;
  variant: number;
  /** Tick it was planted, or GROWN. */
  planted: number;
}

/** Saved/streamed changes: tile keys removed from the generated set, and props added or changed. */
export interface PropDiff {
  removed: number[];
  /** [tile key, kind, variant, planted] */
  added: [number, number, number, number][];
}

export class Props {
  readonly map: Map<number, Prop>;
  version = 0;
  private generated: Map<number, Prop>;

  /** Generate from a pristine world (before any edits). */
  constructor(readonly world: World, seed: number) {
    this.generated = generateProps(world, seed);
    this.map = new Map(this.generated);
    for (const [key, p] of this.map) if (PROP_DEFS[p.kind].solid) world.propSolid[key] = 1;
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
    this.world.propSolid[key] = prop && PROP_DEFS[prop.kind].solid ? 1 : 0;
    this.version++;
  }

  /** 0-1: how grown a prop is at `tick`. */
  growth(p: Prop, tick: number): number {
    const grow = PROP_DEFS[p.kind]?.growTicks ?? 0;
    if (!grow || p.planted === GROWN) return 1;
    return Math.min(1, Math.max(0, (tick - p.planted) / grow));
  }

  diff(): PropDiff {
    const removed: number[] = [];
    const added: PropDiff["added"] = [];
    for (const key of this.generated.keys()) if (!this.map.has(key)) removed.push(key);
    for (const [key, p] of this.map) {
      const g = this.generated.get(key);
      if (!g || g.kind !== p.kind || g.variant !== p.variant || g.planted !== p.planted) {
        added.push([key, p.kind, p.variant, p.planted]);
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
      if (PROP_DEFS[p.kind].solid) this.world.propSolid[key] = 1;
    }
    this.applyDiff(d);
    this.version++;
  }

  applyDiff(d: PropDiff) {
    const w = this.world.sizeX;
    for (const key of d.removed) this.set(key % w, Math.floor(key / w), null);
    for (const [key, kind, variant, planted] of d.added) {
      if (!PROP_DEFS[kind]) continue;
      this.set(key % w, Math.floor(key / w), { kind, variant, planted });
    }
  }
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Trees on a jittered grid (one candidate per 3×3 cell), then smaller things by habitat. */
export function generateProps(world: World, seed: number): Map<number, Prop> {
  const { sizeX, sizeZ } = world;
  const props = new Map<number, Prop>();
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
      const kind = altitude > 7
        ? PropKind.Pine
        : fbm2(x * 0.04, z * 0.04, seed + 700, 2) > 0.2
        ? PropKind.Birch
        : PropKind.Oak;
      props.set(z * sizeX + x, {
        kind,
        variant: Math.floor(hash2(x, z, seed + 104) * PROP_DEFS[kind].variants),
        planted: GROWN,
      });
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
      const variantRoll = hash2(x, z, seed + 202);
      let kind = -1;
      if (water(x, z)) {
        const depth = world.waterTop[key] - h;
        const calm = fbm2(x * 0.06, z * 0.06, seed + 820, 2);
        if (depth === 1 && nearLand(x, z) && roll < 0.3) kind = PropKind.Reeds;
        else if (depth <= 2 && calm > 0.15 && roll < 0.3) kind = PropKind.LilyPad;
      } else if (block === Block.Grass || block === Block.Sand) {
        const sand = block === Block.Sand;
        const f = forest(x, z);
        const flowers = fbm2(x * 0.07, z * 0.07, seed + 800, 2);
        if (nearWater(x, z) && roll < (sand ? 0.18 : 0.3)) kind = PropKind.Reeds;
        else if (slope(x, z) >= 2 && roll < 0.08 * clearing(x, z)) kind = PropKind.Rock;
        else if (roll < 0.006 * clearing(x, z)) kind = PropKind.Rock;
        else if (
          !sand && roll < 0.006 + 0.05 * smoothstep(-0.2, 0.2, f) * smoothstep(0.5, 0.2, f)
        ) {
          kind = PropKind.Bush; // forest edges
        } else if (!sand && flowers > 0.3 && roll < 0.3 * clearing(x, z) + 0.05) {
          kind = PropKind.Flowers;
        }
      } else if (block === Block.Gravel && roll < 0.05) {
        kind = PropKind.Rock;
      }
      if (kind < 0) continue;
      // Flower patches share a color; everything else picks a variant per tile.
      const variant = kind === PropKind.Flowers
        ? Math.floor(hash2(Math.floor(x / 9), Math.floor(z / 9), seed + 803) * 4)
        : Math.floor(variantRoll * PROP_DEFS[kind].variants);
      props.set(key, { kind, variant, planted: GROWN });
    }
  }
  return props;
}
