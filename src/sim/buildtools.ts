import type { DesignContent, Entry } from "./catalog.ts";
import {
  type Args,
  give,
  type Handler,
  inventoryText,
  num,
  reach,
  route,
  solidProp,
  walk,
  work,
} from "./jobs.ts";
import {
  costText,
  designSpan,
  Objects,
  PART_TICKS,
  partCost,
  turnPoint,
  type WorldObject,
} from "./objects.ts";
import { octile } from "./path.ts";
import { type Agent, Anim, type Sim, TICK_HZ } from "./sim.ts";
import type { ToolDef } from "./tools.ts";
import { solid } from "./world.ts";

/**
 * Building: lay blocks one column at a time or a whole area, dig them back out, and build a
 * Design: its block grid, then its parts as one Object. Every call stays under MCP timeouts by
 * capping the cells it touches; `build` picks up where the last call stopped, so agents just call
 * it again.
 */

/** Columns one call may cover, as for till and plant. */
const MAX_COLUMNS = 16;
/** Blocks stacked or dug per column in one call. */
const MAX_LAYERS = 4;
/** Blocks one call may place or dig (about half a minute of work). */
export const MAX_CELLS = 48;
/** Ticks to lay or set a block; stacking more on a column you're at goes quicker. */
const PLACE_TICKS = 20, STACK_TICKS = 12, BUILD_TICKS = 12;
/** A build call stops starting new blocks after this long, to answer within about a minute. */
const BUILD_BUDGET = 50 * TICK_HZ;

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
    description: "Build a Design with its west-north corner at (x, z): its blocks bottom layer " +
      "first, then its parts as one Object (a bench, a fence, a statue) that villagers walk " +
      "around, or stand on if its top is at most a block high. It stands on the highest ground " +
      "under it unless you give `y`; `turn` rotates it clockwise. You need everything it still " +
      "needs before you start: each block, and for each part its volume in its Material (at " +
      "least 1); the refusal lists what's missing. Cells already right are kept; cells taken by " +
      `something else are skipped. Lays at most ${MAX_CELLS} blocks per call: call it again with ` +
      "the same design, x, z and turn to carry on (it also stops after about 50 seconds of " +
      "work). interact takes an Object apart again. Find Designs with catalog_find kind " +
      "design; make your own with catalog_add.",
    inputSchema: {
      type: "object",
      properties: {
        design: { type: "string", description: "The Design's name or id." },
        x: int("West edge (the design's first column)."),
        z: int("North edge (the design's first row)."),
        y: int("Optional height of the bottom layer."),
        turn: {
          type: "integer",
          enum: [0, 90, 180, 270],
          description: "Degrees clockwise seen from above (east turns south). Default 0.",
        },
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
          const why = placeRefusal(sim, agent, x, y, z, y0 !== undefined);
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
          const late = placeRefusal(sim, agent, x, y, z, y0 !== undefined);
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
    const cols = digOrder(columns(args));
    const stack = count(args.layers, "layers");
    const y0 = args.y === undefined ? undefined : num(args.y, "y");
    checkCells(cols.length * stack);
    // Don't stand in what's been dug: a villager climbs one block, so a pit could trap them.
    const dugAt = new Set<number>();
    const inPit = (x: number, z: number) => dugAt.has(z * sim.world.sizeX + x);
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
            yield* reach(sim, agent, x, z, y, inPit);
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
          dugAt.add(z * sim.world.sizeX + x);
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
    const content = design.content as DesignContent;
    const x0 = num(args.x, "x"), z0 = num(args.z, "z");
    const turn = quarterTurns(args.turn);
    const span = designSpan(content);
    const cells = designCells(sim, content, turn, span);
    const partTiles = content.parts.length
      ? Objects.cover(sim.world, Objects.boxes(content, x0, 0, z0, turn))
      : [];
    const sizeX = sim.world.sizeX;
    const columnsOf = [
      ...cells.map((c) => (z0 + c.dz) * sizeX + x0 + c.dx),
      ...partTiles,
    ];
    if (
      columnsOf.every((key) => sim.world.heightAt(key % sizeX, Math.floor(key / sizeX)) < 0) ||
      sim.world.heightAt(x0, z0) < 0
    ) {
      throw new Error(`(${x0}, ${z0}) is outside the world.`);
    }
    if (args.y !== undefined && !cells.length) {
      throw new Error(
        `"${design.name}" is only parts: its Object stands on the ground, so leave out y.`,
      );
    }
    const base = args.y !== undefined
      ? num(args.y, "y")
      : cells.length
      ? findBase(sim, cells, x0, z0)
      : groundBase(sim, partTiles);
    const layers = content.blocks?.layers.length ?? 0;
    if (base < 1 || base + layers > sim.world.sizeY - 2) {
      throw new Error(
        `y=${base} is out of range: 1-${sim.world.sizeY - 2 - layers} for this Design.`,
      );
    }
    const at = (c: Cell) => [x0 + c.dx, base + c.dy, z0 + c.dz] as const;
    const left = () => cells.filter((c) => sim.world.get(...at(c)) !== c.id);
    const name = `"${design.name}"`;
    const place = `at x=${x0} y=${base} z=${z0}${turn ? ` turned ${turn * 90}°` : ""}`;
    const builtHere = () =>
      sim.objects.list.find((o) =>
        o.design === design.id && o.x === x0 && o.z === z0 && o.turn === turn
      );
    const partsLeft = content.parts.length > 0 && !builtHere();
    const todo = left();
    if (!todo.length && !partsLeft) return `${name} is already complete ${place}.`;
    // Everything still needed, up front: a half-built house helps nobody.
    const needs = tally(todo);
    if (partsLeft) {
      for (const [m, n] of partCost(content)) needs.set(m, (needs.get(m) ?? 0) + n);
    }
    const short = new Map([...needs].filter(([m, n]) => (agent.inventory[m] ?? 0) < n));
    if (short.size) {
      throw new Error(
        `You're short of ` +
          `${[...short].map(([m, n]) => `${n - (agent.inventory[m] ?? 0)} ${m}`).join(", ")} ` +
          `for ${name}, which still needs ${needText(needs, agent)}. Gather it all before you ` +
          "build (craft makes some Materials from others).",
      );
    }
    if (partsLeft) {
      const why = objectRefusal(sim, agent, partTiles);
      if (why) throw new Error(`${name} can't stand ${place}: ${why}.`);
    }
    const footprint = new Set(columnsOf);
    const inFootprint = (x: number, z: number) => footprint.has(z * sizeX + x);
    // Keep off anything of theirs two above the base: a villager steps down only two blocks.
    const high = (x: number, z: number) =>
      inFootprint(x, z) && sim.world.heightAt(x, z) >= base + 2;
    const shutIn = () => !route(sim, agent, (cx, cz) => !inFootprint(cx, cz), () => 0);
    /** Whether a block at (x, y, z) would leave the builder no way out: try it, look, undo. */
    const wouldShutIn = (x: number, y: number, z: number, id: number) => {
      const w = sim.world, was = w.get(x, y, z);
      w.set(x, y, z, id);
      const stuck = shutIn();
      w.set(x, y, z, was);
      return stuck;
    };
    return (function* () {
      let built = 0;
      const skipped: string[] = [];
      const deferred: Cell[] = [];
      const started = sim.tick;
      const spent = () => built >= MAX_CELLS || sim.tick - started > BUILD_BUDGET;
      /** Lay one cell standing somewhere `avoid` allows; false if it would shut the builder in. */
      function* lay(c: Cell, avoid: (x: number, z: number) => boolean): Generator<void, boolean> {
        const [x, y, z] = at(c);
        const why = placeRefusal(sim, agent, x, y, z, false);
        if (why) {
          skipped.push(`(${x},${y},${z}) ${why}`);
          return true;
        }
        try {
          yield* reach(sim, agent, x, z, y, avoid);
        } catch {
          skipped.push(`(${x},${y},${z}) out of reach`);
          return true;
        }
        if (wouldShutIn(x, y, z, c.id)) return false;
        yield* work(agent, Anim.Build, BUILD_TICKS);
        const late = placeRefusal(sim, agent, x, y, z, false);
        if (late) {
          skipped.push(`(${x},${y},${z}) ${late}`);
          return true;
        }
        agent.inventory[c.material]--;
        sim.setBlock(x, y, z, c.id);
        sim.fire("placed", agent, x, y, z, c.material);
        built++;
        return true;
      }
      for (const c of todo) {
        if (spent()) break;
        if (sim.world.get(...at(c)) === c.id || !agent.inventory[c.material]) continue;
        if (!(yield* lay(c, high))) deferred.push(c);
      }
      // Blocks that would have closed the builder in go in last, laid from outside.
      for (const c of deferred) {
        if (spent()) break;
        if (sim.world.get(...at(c)) === c.id || !agent.inventory[c.material]) continue;
        if (!(yield* lay(c, inFootprint))) skipped.push(`(${at(c).join(",")}) would shut you in`);
      }
      const rest = left();
      // The parts go up as one Object once the blocks under them are in.
      let object: WorldObject | null = null;
      if (partsLeft && !rest.length && !spent()) {
        const r = yield* raise(sim, agent, design.id, content, x0, base, z0, turn, partTiles);
        if (typeof r === "string") skipped.push(r);
        else object = r;
      }
      const done = cells.length - rest.length;
      let text = cells.length
        ? `Built ${built} block${built === 1 ? "" : "s"} of ${name} ${place}: ` +
          `${done} of ${cells.length} done.`
        : object
        ? `Built ${name} ${place}.`
        : `Didn't build ${name} ${place}.`;
      if (object) {
        const n = content.parts.length;
        text += ` Its ${n} part${n === 1 ? "" : "s"} stand as one Object (${
          costText(partCost(content))
        } used).`;
      }
      const unfinished = rest.length || (partsLeft && !object);
      if (unfinished) {
        const stuck = new Set(skipped.map((s) => s.slice(0, s.indexOf(")") + 1)));
        const open = rest.filter((c) => !stuck.has(`(${at(c).join(",")})`));
        text += open.length || (partsLeft && !object && !skipped.length)
          ? ` To carry on, call build again with design ${name}, x=${x0}, z=${z0}, y=${base}` +
            `${turn ? `, turn=${turn * 90}` : ""}.`
          : " The rest is blocked.";
      }
      if (shutIn()) text += " You're shut in by your own work: break_block a wall to get out.";
      return text + skippedText(skipped) + ` ${inventoryText(agent)}`;
    })();
  },
};

/**
 * Put up a Design's parts as one Object: stand beside it (off its tiles), work a while per part,
 * check again, pay, and place it. Returns the Object, or why it couldn't.
 */
function* raise(
  sim: Sim,
  agent: Agent,
  design: number,
  content: DesignContent,
  x: number,
  y: number,
  z: number,
  turn: number,
  tiles: number[],
): Generator<void, WorldObject | string> {
  const sizeX = sim.world.sizeX;
  const mine = new Set(tiles);
  const onIt = (cx: number, cz: number) => mine.has(cz * sizeX + cx);
  const name = sim.catalog.get(design)!.name;
  // Anywhere beside its tiles will do; its parts go up from the ground or its own blocks.
  const beside = (cx: number, cz: number) => {
    if (onIt(cx, cz)) return false;
    for (const key of tiles) {
      const tx = key % sizeX, tz = Math.floor(key / sizeX);
      if (Math.max(Math.abs(tx - cx), Math.abs(tz - cz)) <= 2) return true;
    }
    return false;
  };
  if (!beside(Math.floor(agent.x), Math.floor(agent.z))) {
    try {
      yield* walk(sim, agent, beside, octile(x, z), "its side");
    } catch {
      return `${name}: you can't get beside it to put its parts up`;
    }
  }
  // Step off its tiles so it isn't built around you.
  if (onIt(Math.floor(agent.x), Math.floor(agent.z))) {
    try {
      yield* walk(sim, agent, (cx, cz) => !onIt(cx, cz), () => 0, "clear ground");
    } catch {
      return `${name}: you can't step off its tiles`;
    }
  }
  yield* work(agent, Anim.Build, Math.min(8 * TICK_HZ, PART_TICKS * content.parts.length));
  const cost = partCost(content);
  const why = objectRefusal(sim, agent, tiles) ??
    [...cost].filter(([m, n]) => (agent.inventory[m] ?? 0) < n).map(([m]) => `out of ${m}`)[0];
  if (why) return `${name}: ${why}`;
  for (const [m, n] of cost) agent.inventory[m] -= n;
  // Flowers and tall grass under it are cleared; anything solid already refused.
  for (const key of tiles) {
    const tx = key % sizeX, tz = Math.floor(key / sizeX);
    if (sim.props.at(tx, tz)) sim.props.set(tx, tz, null);
  }
  const o: WorldObject = { id: sim.objects.nextId(), design, x, y, z, turn, by: agent.name };
  sim.objects.add(o);
  sim.fire("built", agent, x, y, z, name);
  return o;
}

/** Why an Object can't take these tiles, or nothing. `self` may stand there: they step aside. */
function objectRefusal(sim: Sim, self: Agent, tiles: number[]): string | undefined {
  const w = sim.world, sizeX = w.sizeX;
  for (const key of tiles) {
    const x = key % sizeX, z = Math.floor(key / sizeX);
    const where = `(${x},${z})`;
    if (w.heightAt(x, z) < 0) return `${where} is outside the world`;
    const other = sim.objects.at(x, z);
    if (other) {
      return `the ${sim.catalog.get(other.design)?.name ?? "Object"} at ${where} is in the way`;
    }
    const prop = solidProp(sim, x, z);
    if (prop) return `${prop} at ${where}`;
    if (w.waterTop[key] >= 0) return `${where} is water (Objects stand on dry ground)`;
    if (sim.crops.has(key)) return `a crop is growing at ${where}`;
    const v = sim.agents.find((a) => a !== self && Math.floor(a.x) === x && Math.floor(a.z) === z);
    if (v) return `${v.name} is standing at ${where}`;
  }
}

/** The bottom of a parts-only Design: on the highest ground under its tiles. */
function groundBase(sim: Sim, tiles: number[]): number {
  let top = 0;
  for (const key of tiles) {
    top = Math.max(
      top,
      sim.world.heightAt(key % sim.world.sizeX, Math.floor(key / sim.world.sizeX)),
    );
  }
  return top + 1;
}

/** 0-3 quarter turns from 0, 90, 180 or 270 degrees. */
function quarterTurns(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const deg = Number(value);
  if (![0, 90, 180, 270, 360, -90].includes(deg)) {
    throw new Error("turn is 0, 90, 180 or 270 degrees.");
  }
  return ((deg / 90) % 4 + 4) % 4;
}

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

/**
 * Columns inside an area first, its edge last: the inside is dug from the edge, the edge from
 * outside, so the digger finishes on solid ground instead of at the bottom of their own pit.
 */
function digOrder(cols: [number, number][]): [number, number][] {
  const xs = cols.map((c) => c[0]), zs = cols.map((c) => c[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const edge = ([x, z]: [number, number]) => x === x0 || x === x1 || z === z0 || z === z1;
  return [...cols.filter((c) => !edge(c)), ...cols.filter(edge)];
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

/** A villager other than `self` whose body fills cell (x, y, z), if any. */
function villagerAt(sim: Sim, x: number, y: number, z: number, self: Agent): Agent | undefined {
  return sim.agents.find((a) =>
    a !== self && Math.floor(a.x) === x && Math.floor(a.z) === z &&
    (y === Math.floor(a.y) || y === Math.floor(a.y) + 1)
  );
}

/**
 * Why `builder` can't put a block in cell (x, y, z), or nothing. Their own body doesn't count:
 * they step aside to work. `free` placements need a neighbour.
 */
function placeRefusal(
  sim: Sim,
  builder: Agent,
  x: number,
  y: number,
  z: number,
  free: boolean,
): string | void {
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
  if (y >= top) {
    const o = sim.objects.at(x, z);
    if (o) return `the ${sim.catalog.get(o.design)?.name ?? "Object"} is in the way`;
  }
  const v = villagerAt(sim, x, y, z, builder);
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
    const o = sim.objects.at(x, z);
    if (o) {
      return `the ${
        sim.catalog.get(o.design)?.name ?? "Object"
      } stands on it (interact takes it apart)`;
    }
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
  if (!want) throw new Error('Say which Design to build, e.g. design: "stone bench".');
  const e = /^\d+$/.test(want) ? c.get(Number(want)) : c.byName(want);
  if (!e) throw new Error(`Nothing called "${want}" in the Catalog. Try catalog_find kind design.`);
  if (e.kind !== "design") throw new Error(`"${e.name}" is a ${e.kind}, not a Design.`);
  const live = c.current(e);
  if (!live) throw new Error(`"${e.name}" is retired, so nothing new is built from it.`);
  return live;
}

/**
 * Filled cells bottom layer first, turned `turn` quarter turns, each row swept back and forth so
 * the builder walks less. In a layer the inside comes before its edge, so a roof is closed from
 * outside, last.
 */
function designCells(
  sim: Sim,
  d: DesignContent,
  turn: number,
  span: [number, number],
): Cell[] {
  const cells: Cell[] = [];
  const blocks = d.blocks;
  if (!blocks) return cells;
  blocks.layers.forEach((layer, dy) => {
    const start = cells.length;
    layer.forEach((row, dz) => {
      const chars = [...row];
      const xs = chars.map((_, i) => i);
      if (dz % 2) xs.reverse();
      for (const dx of xs) {
        const ch = chars[dx];
        if (ch === "." || ch === " ") continue;
        const material = blocks.palette[ch];
        const id = sim.blocks.byName(material)?.id ?? 0;
        const [tx, tz] = turnPoint(dx + 0.5, dz + 0.5, turn, span);
        if (id) cells.push({ dx: Math.floor(tx), dy, dz: Math.floor(tz), material, id });
      }
    });
    const mine = cells.splice(start);
    const dxs = mine.map((c) => c.dx), dzs = mine.map((c) => c.dz);
    const [x0, x1] = [Math.min(...dxs), Math.max(...dxs)];
    const [z0, z1] = [Math.min(...dzs), Math.max(...dzs)];
    const edge = (c: Cell) => c.dx === x0 || c.dx === x1 || c.dz === z0 || c.dz === z1;
    cells.push(...mine.filter((c) => !edge(c)), ...mine.filter(edge));
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
  // Look well below fresh ground: earlier work may have been built on since (a Rule's blocks).
  for (let b = fresh; b >= Math.max(1, fresh - height - 16); b--) {
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
