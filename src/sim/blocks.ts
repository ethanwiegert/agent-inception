/**
 * Block registry. Built-in blocks have fixed ids; agents can define more with
 * `define_block` (stored in the sim, saved, and mirrored to the renderer).
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

/** Procedural surface patterns the terrain shader knows how to draw. */
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
} as const;
export type PatternName = keyof typeof Pattern;

export interface BlockDef {
  id: number;
  name: string;
  /** sRGB 0xRRGGBB. */
  color: number;
  pattern: PatternName;
  /** What digging it gives (item name), or null if it can't be dug. */
  drops: string | null;
  /** Whether agents can place it from their inventory (item name = block name). */
  placeable: boolean;
  description: string;
  custom?: boolean;
}

export const BUILTIN_BLOCKS: BlockDef[] = [
  {
    id: 0,
    name: "air",
    color: 0,
    pattern: "plain",
    drops: null,
    placeable: false,
    description: "",
  },
  {
    id: 1,
    name: "grass",
    color: 0x4a8a2a,
    pattern: "grass",
    drops: "dirt",
    placeable: false,
    description: "Meadow ground.",
  },
  {
    id: 2,
    name: "dirt",
    color: 0x7a5232,
    pattern: "dirt",
    drops: "dirt",
    placeable: true,
    description: "Soil; piles into mounds.",
  },
  {
    id: 3,
    name: "stone",
    color: 0x8a8a88,
    pattern: "stone",
    drops: "stone",
    placeable: true,
    description: "Bedrock under the soil.",
  },
  {
    id: 4,
    name: "farmland",
    color: 0x3c2414,
    pattern: "farmland",
    drops: "dirt",
    placeable: false,
    description: "Tilled soil for seeds.",
  },
  {
    id: 5,
    name: "water",
    color: 0x2a6f8a,
    pattern: "plain",
    drops: null,
    placeable: false,
    description: "Rivers, lakes and the sea.",
  },
  {
    id: 6,
    name: "sand",
    color: 0xb8a272,
    pattern: "sand",
    drops: "sand",
    placeable: true,
    description: "Beaches and riverbeds.",
  },
  {
    id: 7,
    name: "gravel",
    color: 0x7a6f62,
    pattern: "cobble",
    drops: "gravel",
    placeable: true,
    description: "Loose stones under water.",
  },
  {
    id: 8,
    name: "clay",
    color: 0x8a7c68,
    pattern: "dirt",
    drops: "clay",
    placeable: true,
    description: "Riverbank clay; craft into bricks.",
  },
  {
    id: 9,
    name: "log",
    color: 0x6b4a2c,
    pattern: "log",
    drops: "log",
    placeable: true,
    description: "Tree trunks; craft into planks.",
  },
  {
    id: 10,
    name: "planks",
    color: 0xb08850,
    pattern: "planks",
    drops: "planks",
    placeable: true,
    description: "Sawn wood for floors and walls.",
  },
  {
    id: 11,
    name: "cobble",
    color: 0x77756f,
    pattern: "cobble",
    drops: "cobble",
    placeable: true,
    description: "Rough stone for walls and paths.",
  },
  {
    id: 12,
    name: "brick",
    color: 0xa4523a,
    pattern: "bricks",
    drops: "brick",
    placeable: true,
    description: "Fired clay bricks.",
  },
  {
    id: 13,
    name: "thatch",
    color: 0xc9a85a,
    pattern: "thatch",
    drops: "thatch",
    placeable: true,
    description: "Bundled straw for roofs.",
  },
  {
    id: 14,
    name: "tiles",
    color: 0x9a4a35,
    pattern: "tiles",
    drops: "tiles",
    placeable: true,
    description: "Fired roof tiles.",
  },
];

export const FIRST_CUSTOM_BLOCK = 64;
export const MAX_BLOCKS = 256;

/** Ground that softens into slopes; worked and placed blocks keep square edges. */
export const slopes = (b: BlockId) =>
  b === Block.Grass || b === Block.Dirt || b === Block.Sand || b === Block.Gravel ||
  b === Block.Clay;
/** Everything but air and water occupies its cell. */
export const solid = (b: BlockId) => b !== Block.Air && b !== Block.Water;

export class BlockRegistry {
  readonly defs: (BlockDef | undefined)[] = [];
  version = 0;

  constructor() {
    for (const d of BUILTIN_BLOCKS) this.defs[d.id] = d;
  }

  get(id: number): BlockDef | undefined {
    return this.defs[id];
  }

  byName(name: string): BlockDef | undefined {
    const n = name.trim().toLowerCase();
    return this.defs.find((d) => d?.name === n);
  }

  name(id: number): string {
    return this.defs[id]?.name ?? "unknown";
  }

  /** Add or update an agent-defined block. Built-ins can't be redefined. */
  define(def: Omit<BlockDef, "id" | "custom">): BlockDef {
    const existing = this.byName(def.name);
    if (existing && !existing.custom) throw new Error(`"${def.name}" is a built-in block.`);
    let id = existing?.id;
    if (id === undefined) {
      id = FIRST_CUSTOM_BLOCK;
      while (this.defs[id]) id++;
      if (id >= MAX_BLOCKS) throw new Error("The world has no room for more block types.");
    }
    const full: BlockDef = { ...def, id, custom: true };
    this.defs[id] = full;
    this.version++;
    return full;
  }

  customs(): BlockDef[] {
    return this.defs.filter((d): d is BlockDef => !!d?.custom);
  }

  load(customs: BlockDef[]) {
    for (const d of customs) this.defs[d.id] = { ...d, custom: true };
    this.version++;
  }
}
