import type { DesignContent, Entry } from "./catalog.ts";
import {
  type Args,
  give,
  type Handler,
  inventoryText,
  num,
  reach,
  solidProp,
  work,
} from "./jobs.ts";
import { type Agent, Anim, type Sim } from "./sim.ts";
import type { ToolDef } from "./tools.ts";
import { solid } from "./world.ts";

/**
 * Building: lay blocks one column at a time or a whole area, dig them back out, and build a
 * Design's block grid. Every call stays under MCP timeouts by capping the cells it touches;
 * `build` picks up where the last call stopped, so agents just call it again.
 */

/** Columns one call may cover, as for till and plant. */
const MAX_COLUMNS = 16;
/** Blocks stacked or dug per column in one call. */
const MAX_LAYERS = 4;
/** Blocks one call may place or dig (about half a minute of work). */
export const MAX_CELLS = 48;
/** Ticks to lay or set a block; stacking more on a column you're at goes quicker. */
const PLACE_TICKS = 20, STACK_TICKS = 12, BUILD_TICKS = 12;

const int = (description: string) => ({ type: "integer", description });
const area = {
  x: int("West edge of the area (x grows east)."),
  z: int("North edge of the area (z grows south)."),
  width: { ...int("Columns along x, default 1."), minimum: 1, maximum: MAX_COLUMNS },
  depth: { ...int("Columns along z, default 1."), minimum: 1, maximum: MAX_COLUMNS },
};
const layers = (what: string) => ({
  ...int(`${what}, 1-${MAX_LAYERS}. Default 1.`),
  minimum: 1,
  maximum: MAX_LAYERS,
});

export const BUILD_TOOL_DEFS: ToolDef[] = [
  {
    name: "place_block",
    description: "Lay blocks from your inventory: any block Material you hold (dirt, stone, " +
      "sand, planks…). Covers width × depth columns (at most 16) starting at (x, z), stacking " +
      "`layers` blocks on top of each column, so one call can lay a floor or raise a wall. With " +
      "`y`, blocks go at that height instead (from y upward), for bridges and roofs; each needs " +
      `a solid neighbour. At most ${MAX_CELLS} blocks per call. You walk to each column yourself.`,
    inputSchema: {
      type: "object",
      properties: {
        ...area,
        block: { type: "string", description: 'Material name, e.g. "stone" or "planks".' },
        layers: layers("Blocks to stack per column"),
        y: int("Optional height of the lowest block, instead of on top of each column."),
      },
      required: ["x", "z", "block"],
    },
  },
  {
    name: "break_block",
    description: "Dig blocks into your inventory. A block gives what its drops Relations say " +
      "(grass and farmland give dirt), or itself; harder blocks take longer. Covers width × depth " +
      "columns (at most 16) starting at (x, z), digging `layers` blocks down from the top of each. " +
      "With `y`, digs from that height upward instead (a doorway in a wall: y = the floor " +
      `block above the ground, layers 2). At most ${MAX_CELLS} blocks per call.`,
    inputSchema: {
      type: "object",
      properties: {
        ...area,
        layers: layers("Blocks to dig per column"),
        y: int("Optional height of the lowest block to dig, instead of the top of each column."),
      },
      required: ["x", "z"],
    },
  },
  {
    name: "build",
    description: "Build a Design's blocks (its `blocks` grid) with its west-north corner at " +
      "(x, z): bottom layer first, using block Materials from your inventory. It stands on the " +
      "highest ground under it unless you give `y`. Cells already right are kept; cells taken by " +
      `something else are skipped. Lays at most ${MAX_CELLS} blocks per call: call it again with ` +
      "the same design, x and z to carry on. Find Designs with catalog_find kind design; make " +
      "your own with catalog_add.",
    inputSchema: {
      type: "object",
      properties: {
        design: { type: "string", description: "The Design's name or id." },
        x: int("West edge (the design's first column)."),
        z: int("North edge (the design's first row)."),
        y: int("Optional height of the bottom layer."),
      },
      required: ["design", "x", "z"],
    },
  },
];

export const BUILD_HANDLERS: Record<string, Handler> = {
  place_block(sim, agent, args) {
    const block = heldBlock(sim, agent, args.block);
    const cols = columns(args);
    const stack = count(args.layers, "layers");
    const y0 = args.y === undefined ? undefined : num(args.y, "y");
    checkCells(cols.length * stack);
    return (function* () {
      let placed = 0, ranOut = false;
      const skipped: string[] = [];
      for (const [x, z] of cols) {
        for (let k = 0; k < stack && !ranOut; k++) {
          if (!agent.inventory[block.name]) {
            ranOut = true;
            break;
          }
          const y = y0 === undefined ? sim.world.heightAt(x, z) + 1 : y0 + k;
          const why = placeRefusal(sim, x, y, z, y0 !== undefined);
          if (why) {
            skipped.push(`(${x},${y},${z}) ${why}`);
            if (y0 === undefined) break; // the column's top won't change
            continue;
          }
          try {
            yield* reach(sim, agent, x, z, y);
          } catch {
            skipped.push(`(${x},${y},${z}) out of reach`);
            continue;
          }
          yield* work(agent, Anim.Build, k ? STACK_TICKS : PLACE_TICKS);
          const late = placeRefusal(sim, x, y, z, y0 !== undefined);
          if (late) {
            skipped.push(`(${x},${y},${z}) ${late}`);
            continue;
          }
          agent.inventory[block.name]--;
          sim.setBlock(x, y, z, block.id);
          sim.fire("placed", agent, x, y, z, block.name);
          placed++;
        }
      }
      return `Placed ${placed} ${block.name}${where(cols)}.` + skippedText(skipped) +
        (ranOut ? ` Ran out of ${block.name}.` : "") + ` ${inventoryText(agent)}`;
    })();
  },

  break_block(sim, agent, args) {
    const cols = columns(args);
    const stack = count(args.layers, "layers");
    const y0 = args.y === undefined ? undefined : num(args.y, "y");
    checkCells(cols.length * stack);
    return (function* () {
      let dug = 0;
      const got = new Map<string, number>();
      const skipped: string[] = [];
      const dugWhat = new Map<string, number>();
      for (const [x, z] of cols) {
        for (let k = 0; k < stack; k++) {
          const y = y0 === undefined ? sim.world.heightAt(x, z) : y0 + k;
          const why = digRefusal(sim, x, y, z);
          if (why) {
            skipped.push(`(${x},${y},${z}) ${why}`);
            if (y0 === undefined) break;
            continue;
          }
          try {
            yield* reach(sim, agent, x, z, y);
          } catch {
            skipped.push(`(${x},${y},${z}) out of reach`);
            continue;
          }
          const b = sim.world.get(x, y, z);
          const entry = sim.catalog.get(sim.blocks.get(b)?.entry ?? 0);
          const hardness = (entry?.content as { hardness?: number } | undefined)?.hardness ?? 1;
          yield* work(agent, Anim.Build, Math.round(16 + hardness * 4));
          const late = digRefusal(sim, x, y, z);
          if (late) {
            skipped.push(`(${x},${y},${z}) ${late}`);
            continue;
          }
          const name = sim.blocks.name(sim.world.get(x, y, z));
          sim.setBlock(x, y, z, 0);
          for (const [item, n] of entry ? sim.drops(entry) : []) {
            give(agent, item, n);
            got.set(item, (got.get(item) ?? 0) + n);
          }
          dugWhat.set(name, (dugWhat.get(name) ?? 0) + 1);
          sim.fire("broken", agent, x, y, z, name);
          dug++;
        }
      }
      const list = (m: Map<string, number>) => [...m].map(([k, n]) => `${n} ${k}`).join(", ");
      const what = dug ? `Dug ${list(dugWhat)}${where(cols)}` : `Dug nothing${where(cols)}`;
      return `${what}, got ${got.size ? list(got) : "nothing"}.` + skippedText(skipped) +
        ` ${inventoryText(agent)}`;
    })();
  },

  build(sim, agent, args) {
    const design = buildable(sim, args.design);
    const blocks = (design.content as DesignContent).blocks!;
    const x0 = num(args.x, "x"), z0 = num(args.z, "z");
    const cells = designCells(sim, blocks);
    const base = args.y === undefined ? findBase(sim, cells, x0, z0) : num(args.y, "y");
    const at = (c: Cell) => [x0 + c.dx, base + c.dy, z0 + c.dz] as const;
    const left = () => cells.filter((c) => sim.world.get(...at(c)) !== c.id);
    const todo = left();
    const name = `"${design.name}"`;
    const place = `at x=${x0} y=${base} z=${z0}`;
    if (!todo.length) return `${name} is already complete ${place}.`;
    const needs = tally(todo);
    if (![...needs.keys()].some((m) => agent.inventory[m] > 0)) {
      throw new Error(`You have none of what ${name} still needs: ${needText(needs, agent)}.`);
    }
    return (function* () {
      let built = 0, layer = -1, short = false;
      const skipped: string[] = [];
      for (const c of todo) {
        if (built >= MAX_CELLS) break;
        // Bottom up: a layer left unfinished for want of material holds back the ones above.
        if (c.dy !== layer) {
          if (short) break;
          layer = c.dy;
        }
        const [x, y, z] = at(c);
        if (sim.world.get(x, y, z) === c.id) continue;
        if (!agent.inventory[c.material]) {
          short = true; // counted in what's still needed
          continue;
        }
        const why = placeRefusal(sim, x, y, z, false);
        if (why) {
          skipped.push(`(${x},${y},${z}) ${why}`);
          continue;
        }
        try {
          yield* reach(sim, agent, x, z, y);
        } catch {
          skipped.push(`(${x},${y},${z}) out of reach`);
          continue;
        }
        yield* work(agent, Anim.Build, BUILD_TICKS);
        const late = placeRefusal(sim, x, y, z, false);
        if (late) {
          skipped.push(`(${x},${y},${z}) ${late}`);
          continue;
        }
        agent.inventory[c.material]--;
        sim.setBlock(x, y, z, c.id);
        sim.fire("placed", agent, x, y, z, c.material);
        built++;
      }
      const rest = left();
      const done = cells.length - rest.length;
      let text = `Built ${built} block${built === 1 ? "" : "s"} of ${name} ${place}: ` +
        `${done} of ${cells.length} done.`;
      if (rest.length) {
        const stuck = new Set(skipped.map((s) => s.slice(0, s.indexOf(")") + 1)));
        const open = rest.filter((c) => !stuck.has(`(${at(c).join(",")})`));
        const missing = tally(open.filter((c) => !agent.inventory[c.material]));
        text += open.length
          ? ` To carry on, call build again with design ${name}, x=${x0}, z=${z0}, y=${base}.`
          : " The rest is blocked.";
        if (missing.size) text += ` Still needed: ${needText(missing, agent)}.`;
      }
      return text + skippedText(skipped) + ` ${inventoryText(agent)}`;
    })();
  },
};

// ---------------------------------------------------------------- helpers

/** The block Material named `value` that `agent` holds, with its block id. */
function heldBlock(sim: Sim, agent: Agent, value: unknown): { id: number; name: string } {
  const want = String(value ?? "").trim().toLowerCase().replace(/_/g, " ");
  if (!want) throw new Error('Say which block to place, e.g. block: "stone".');
  const def = sim.blocks.byName(want);
  const held = placeableHeld(sim, agent);
  const hint = held.length
    ? ` You can place: ${held.join(", ")}.`
    : " Dig some with break_block (grass gives dirt; deeper down there's stone).";
  if (!def || def.id === 0 || !sim.holdable(def.name)) {
    throw new Error(`"${want}" isn't a block Material.${hint}`);
  }
  if (!agent.inventory[def.name]) throw new Error(`You have no ${def.name}.${hint}`);
  return { id: def.id, name: def.name };
}

/** Block Materials in the inventory, as "stone 3". */
function placeableHeld(sim: Sim, agent: Agent): string[] {
  return Object.entries(agent.inventory)
    .filter(([item, n]) => n > 0 && (sim.blocks.byName(item)?.id ?? 0) > 0 && sim.holdable(item))
    .map(([item, n]) => `${item} ${n}`);
}

/** The width × depth columns at (x, z), in a serpentine sweep. */
function columns(args: Args): [number, number][] {
  const x0 = num(args.x, "x"), z0 = num(args.z, "z");
  const width = Math.max(1, num(args.width ?? 1, "width"));
  const depth = Math.max(1, num(args.depth ?? 1, "depth"));
  if (width * depth > MAX_COLUMNS) throw new Error(`At most ${MAX_COLUMNS} columns per call.`);
  const out: [number, number][] = [];
  for (let j = 0; j < depth; j++) {
    for (let i = 0; i < width; i++) out.push([x0 + (j % 2 ? width - 1 - i : i), z0 + j]);
  }
  return out;
}

function count(value: unknown, name: string): number {
  const n = value === undefined ? 1 : num(value, name);
  if (n < 1 || n > MAX_LAYERS) throw new Error(`"${name}" is 1-${MAX_LAYERS}.`);
  return n;
}

function checkCells(n: number) {
  if (n > MAX_CELLS) {
    throw new Error(`That's ${n} blocks; at most ${MAX_CELLS} per call. Split it up.`);
  }
}

function where(cols: [number, number][]): string {
  const [x, z] = cols[0];
  if (cols.length === 1) return ` at x=${x} z=${z}`;
  const xs = cols.map((c) => c[0]), zs = cols.map((c) => c[1]);
  return ` over x=${Math.min(...xs)}..${Math.max(...xs)} z=${Math.min(...zs)}..${Math.max(...zs)}`;
}

/** Up to eight skip reasons, then a count, so a big area doesn't bury the result. */
function skippedText(skipped: string[]): string {
  if (!skipped.length) return "";
  const shown = skipped.slice(0, 8).join("; ");
  return ` Skipped: ${shown}${skipped.length > 8 ? `; and ${skipped.length - 8} more` : ""}.`;
}

/** The villager whose body fills cell (x, y, z), if any. */
function villagerAt(sim: Sim, x: number, y: number, z: number): Agent | undefined {
  return sim.agents.find((a) =>
    Math.floor(a.x) === x && Math.floor(a.z) === z &&
    (y === Math.floor(a.y) || y === Math.floor(a.y) + 1)
  );
}

/** Why a block can't go in cell (x, y, z), or nothing. `free` placements need a neighbour. */
function placeRefusal(sim: Sim, x: number, y: number, z: number, free: boolean): string | void {
  const w = sim.world;
  const top = w.heightAt(x, z);
  if (top < 0) return "outside the world";
  if (y < 1) return "too low";
  if (y >= w.sizeY - 2) return "too high";
  const b = w.get(x, y, z);
  if (solid(b)) return `${sim.blocks.name(b)} is there`;
  if (y > top) {
    const prop = solidProp(sim, x, z);
    if (prop) return prop;
  }
  const v = villagerAt(sim, x, y, z);
  if (v) return `${v.name} is standing there`;
  if (free) {
    const attached = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
      .some(([dx, dy, dz]) => solid(w.get(x + dx, y + dy, z + dz)));
    if (!attached) return "nothing to attach it to";
  }
}

/** Why cell (x, y, z) can't be dug, or nothing. */
function digRefusal(sim: Sim, x: number, y: number, z: number): string | void {
  const w = sim.world;
  const top = w.heightAt(x, z);
  if (top < 0) return "outside the world";
  if (y <= 1) return "bedrock";
  if (!solid(w.get(x, y, z))) return "nothing there";
  if (y === top) {
    const prop = solidProp(sim, x, z);
    if (prop) return prop;
  }
}

interface Cell {
  dx: number;
  dy: number;
  dz: number;
  material: string;
  id: number;
}

/** The live Design named `value` that has blocks to build. */
function buildable(sim: Sim, value: unknown): Entry {
  const c = sim.catalog;
  const want = String(value ?? "").trim();
  const e = /^\d+$/.test(want) ? c.get(Number(want)) : c.byName(want);
  if (!e) throw new Error(`Nothing called "${want}" in the Catalog. Try catalog_find kind design.`);
  if (e.kind !== "design") throw new Error(`"${e.name}" is a ${e.kind}, not a Design.`);
  const live = c.current(e);
  if (!live) throw new Error(`"${e.name}" is retired, so nothing new is built from it.`);
  if (!(live.content as DesignContent).blocks) {
    throw new Error(
      `"${live.name}" has no blocks to build (only parts). Designs with a blocks grid can be built.`,
    );
  }
  return live;
}

/** Filled cells bottom layer first, each row swept back and forth so the builder walks less. */
function designCells(sim: Sim, blocks: NonNullable<DesignContent["blocks"]>): Cell[] {
  const cells: Cell[] = [];
  blocks.layers.forEach((layer, dy) => {
    layer.forEach((row, dz) => {
      const chars = [...row];
      const xs = chars.map((_, i) => i);
      if (dz % 2) xs.reverse();
      for (const dx of xs) {
        const ch = chars[dx];
        if (ch === "." || ch === " ") continue;
        const material = blocks.palette[ch];
        const id = sim.blocks.byName(material)?.id ?? 0;
        if (id) cells.push({ dx, dy, dz, material, id });
      }
    });
  });
  return cells;
}

/**
 * Where the bottom layer goes: on the highest ground under the footprint, unless part of the
 * Design already stands a little lower (an earlier call's work), in which case that height.
 * Only placed blocks count, so a stone floor never "finds" itself in the bedrock.
 */
function findBase(sim: Sim, cells: Cell[], x0: number, z0: number): number {
  const w = sim.world;
  let fresh = 0, height = 0;
  for (const c of cells) {
    fresh = Math.max(fresh, w.heightAt(x0 + c.dx, z0 + c.dz) + 1);
    height = Math.max(height, c.dy + 1);
  }
  let best = fresh, hits = 0;
  for (let b = fresh; b >= Math.max(1, fresh - height); b--) {
    let n = 0;
    for (const c of cells) {
      const x = x0 + c.dx, y = b + c.dy, z = z0 + c.dz;
      if (w.inBounds(x, y, z) && sim.edits.get(w.index(x, y, z)) === c.id) n++;
    }
    if (n > hits) best = b, hits = n;
  }
  return best;
}

function tally(cells: Cell[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cells) m.set(c.material, (m.get(c.material) ?? 0) + 1);
  return m;
}

function needText(needs: Map<string, number>, agent: Agent): string {
  return [...needs].map(([m, n]) => `${n} ${m} (you have ${agent.inventory[m] ?? 0})`).join(", ");
}
