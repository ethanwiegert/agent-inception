import type { Catalog, MaterialContent } from "./catalog.ts";

/**
 * Blocks are Materials laid in the world's voxel grid. The terrain generator and the engine know
 * the built-in ones by fixed id; every other Material that can be a block gets an id the first time
 * it shows up in the Catalog. Looks (color, pattern) come from the Material entry.
 */

export const Block = {
  Air: 0,
  Grass: 1,
  Dirt: 2,
  Stone: 3,
  Farmland: 4,
  Water: 5,
  Sand: 6,
  Gravel: 7,
  Clay: 8,
  Log: 9,
  Planks: 10,
  Cobble: 11,
  Brick: 12,
  Thatch: 13,
  Tiles: 14,
} as const;
export type BlockId = number;

/** Nature's block Materials by fixed id (index = id). */
export const BUILTIN_BLOCKS = [
  "air",
  "grass",
  "dirt",
  "stone",
  "farmland",
  "water",
  "sand",
  "gravel",
  "clay",
  "log",
  "planks",
  "cobble",
  "brick",
  "thatch",
  "tiles",
] as const;

/** Procedural surface patterns the terrain shader and the part mesher know how to draw. */
export const Pattern = {
  plain: 0,
  grass: 1,
  farmland: 2,
  stone: 3,
  sand: 4,
  planks: 5,
  bricks: 6,
  log: 7,
  thatch: 8,
  cobble: 9,
  tiles: 10,
  dirt: 11,
  leaves: 12,
  fleece: 13,
} as const;
export type PatternName = keyof typeof Pattern;

export interface BlockDef {
  id: number;
  name: string;
  /** The Material entry it was made from. */
  entry: number;
  /** sRGB 0xRRGGBB. */
  color: number;
  pattern: PatternName;
}

export const FIRST_CUSTOM_BLOCK = 64;
export const MAX_BLOCKS = 256;

/** Ground that softens into slopes; worked and placed blocks keep square edges. */
export const slopes = (b: BlockId) =>
  b === Block.Grass || b === Block.Dirt || b === Block.Sand || b === Block.Gravel ||
  b === Block.Clay;
/** Everything but air and water occupies its cell. */
export const solid = (b: BlockId) => b !== Block.Air && b !== Block.Water;

const AIR: BlockDef = { id: 0, name: "air", entry: 0, color: 0, pattern: "plain" };

/** Block ids for the Catalog's Materials, following the Catalog as it grows (append-only). */
export class BlockRegistry {
  readonly defs: (BlockDef | undefined)[] = [AIR];
  version = 0;
  private catalog: Catalog | null = null;
  private seen = 0;
  private names = new Map<string, BlockDef>([["air", AIR]]);

  /** Give block ids to Materials added since the last sync. Cheap when nothing changed. */
  sync(catalog: Catalog): this {
    if (catalog !== this.catalog) {
      this.catalog = catalog;
      this.seen = 0;
      this.defs.length = 1;
      this.names = new Map([["air", AIR]]);
      this.version++;
    }
    const entries = catalog.entries;
    if (this.seen === entries.length) return this;
    for (; this.seen < entries.length; this.seen++) {
      const e = entries[this.seen];
      if (e.kind !== "material") continue;
      const m = e.content as MaterialContent;
      if (m.form === "item") continue;
      let id = e.author === "nature" ? BUILTIN_BLOCKS.indexOf(e.name as "air") : -1;
      if (id <= 0 || this.defs[id]) {
        id = FIRST_CUSTOM_BLOCK;
        while (this.defs[id]) id++;
        if (id >= MAX_BLOCKS) continue; // no room: it stays an item-only Material
      }
      const def: BlockDef = {
        id,
        name: e.name,
        entry: e.id,
        color: parseInt(m.color.slice(1), 16),
        pattern: m.pattern,
      };
      this.defs[id] = def;
      this.names.set(e.name.toLowerCase(), def);
    }
    this.version++;
    return this;
  }

  get(id: number): BlockDef | undefined {
    return this.defs[id];
  }

  byName(name: string): BlockDef | undefined {
    return this.names.get(name.trim().toLowerCase());
  }

  name(id: number): string {
    return this.defs[id]?.name ?? "unknown";
  }
}
