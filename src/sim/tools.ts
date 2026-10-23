import { findPath, octile } from "./path.ts";
import {
  type Agent,
  Anim,
  type Job,
  type Sim,
  type Sprite,
  TICK_HZ,
  TICKS_PER_DAY,
  WHEAT_GROW_TICKS,
} from "./sim.ts";
import { Block, BLOCK_NAMES } from "./world.ts";

/**
 * The agent-facing API. Every game action is a tool; definitions are plain
 * JSON schema so the MCP bridge can list them without running the game.
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Handled by the browser page instead of the sim (needs the renderer). */
  client?: boolean;
}

const WALK_SPEED = 2.2 / TICK_HZ; // blocks per tick: an unhurried stroll
export const SPRITE_MAX = 32;
const MAX_AREA = 16;
const int = (description: string) => ({ type: "integer", description });
const area = {
  x: int("West edge of the area (x grows east)."),
  z: int("North edge of the area (z grows south)."),
  width: { ...int("Tiles along x, default 1."), minimum: 1, maximum: MAX_AREA },
  depth: { ...int("Tiles along z, default 1."), minimum: 1, maximum: MAX_AREA },
};
const areaNote = `Covers width × depth tiles (at most ${MAX_AREA}) starting at (x, z); ` +
  "you walk to each tile yourself. Returns when done.";

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "join",
    description: "Enter the world as a farmer with this name. Call this first. " +
      "Using a name that already exists puts you back in that body, with its inventory and journal.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "1-20 letters, digits, spaces, - or _." },
      },
      required: ["name"],
    },
  },
  {
    name: "look",
    description: "Describe your surroundings: time, inventory, a map of nearby tiles " +
      "with heights, crops and other farmers. Cheap; use it whenever you need to orient.",
    inputSchema: {
      type: "object",
      properties: {
        radius: { ...int("Tiles around you to map, 3-12. Default 6."), minimum: 3, maximum: 12 },
      },
    },
  },
  {
    name: "walk_to",
    description: "Walk to a tile. You can climb 1 block and drop 2. Returns when you arrive.",
    inputSchema: {
      type: "object",
      properties: { x: int("Target x."), z: int("Target z.") },
      required: ["x", "z"],
    },
  },
  {
    name: "till",
    description: `Turn grass or dirt into farmland ready for seeds. ${areaNote}`,
    inputSchema: { type: "object", properties: area, required: ["x", "z"] },
  },
  {
    name: "plant",
    description: `Plant wheat seeds on empty farmland, one seed per tile. ` +
      `Wheat ripens in about ${
        Math.round((WHEAT_GROW_TICKS / TICKS_PER_DAY) * 24)
      } game hours. ${areaNote}`,
    inputSchema: { type: "object", properties: area, required: ["x", "z"] },
  },
  {
    name: "harvest",
    description:
      `Harvest ripe wheat: 1 wheat and 2 seeds per tile. Unripe crops are left alone. ${areaNote}`,
    inputSchema: { type: "object", properties: area, required: ["x", "z"] },
  },
  {
    name: "place_block",
    description:
      "Stack a block from your inventory on top of a tile's column. Build walls by stacking.",
    inputSchema: {
      type: "object",
      properties: {
        x: int("Column x."),
        z: int("Column z."),
        block: { type: "string", enum: ["dirt", "stone"] },
      },
      required: ["x", "z", "block"],
    },
  },
  {
    name: "break_block",
    description:
      "Dig the top block off a tile's column into your inventory (grass and farmland give dirt).",
    inputSchema: {
      type: "object",
      properties: { x: int("Column x."), z: int("Column z.") },
      required: ["x", "z"],
    },
  },
  {
    name: "set_sprite",
    description: "Choose how you look: pixel art (up to 32×32) that becomes your body, extruded " +
      "into blocks. Draw yourself facing right; you'll flip when walking left. Either give `rows` " +
      "plus a `palette`, or upload an image. Call with `reset: true` to go back to the farmer. " +
      'Example: rows ["..hh..", ".hhhh.", "..ff..", ".bbbb.", "b.bb.b", "..ll..", ".l..l."], ' +
      'palette {"h": "#e8b23a", "f": "#f1c9a5", "b": "#3b6fd1", "l": "#2a2a35"}.',
    inputSchema: {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: { type: "string" },
          maxItems: SPRITE_MAX,
          description: `Top-to-bottom rows of palette keys, at most ${SPRITE_MAX} long. ` +
            '"." and " " are transparent.',
        },
        palette: {
          type: "object",
          additionalProperties: { type: "string" },
          description: 'Single-character keys to colors like "#a0522d" or "#fc0".',
        },
        image_base64: {
          type: "string",
          description:
            "A PNG/JPEG/WebP image instead of rows; transparent pixels are see-through. " +
            `Scaled to fit ${SPRITE_MAX}×${SPRITE_MAX}.`,
        },
        reset: { type: "boolean", description: "Go back to the default farmer body." },
      },
    },
  },
  {
    name: "say",
    description: "Say something out loud. It appears over your head for anyone watching.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 140 } },
      required: ["text"],
    },
  },
  {
    name: "wait",
    description: "Rest for a while, e.g. while crops grow. 1-60 real seconds.",
    inputSchema: {
      type: "object",
      properties: { seconds: { type: "number", minimum: 1, maximum: 60 } },
      required: ["seconds"],
    },
  },
  {
    name: "journal_write",
    description:
      "Write a note in your journal. It persists across sessions; use it to remember plans.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 1000 } },
      required: ["text"],
    },
  },
  {
    name: "journal_read",
    description: "Read your journal.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "screenshot",
    description: "See the world as an image, centered on you. Costs more than look; use sparingly.",
    inputSchema: { type: "object", properties: {} },
    client: true,
  },
];

type Args = Record<string, unknown>;
type Handler = (sim: Sim, agent: Agent, args: Args) => string | Job;

/**
 * Run a tool call. Instant tools push their result immediately; actions are
 * queued as jobs on the agent and resolve as the sim steps.
 */
export function callTool(sim: Sim, session: string, name: string, args: Args, callId: number) {
  const done = (text: string, isError = false) => sim.results.push({ callId, text, isError });
  try {
    if (name === "join") return done(join(sim, session, args));
    const agent = sim.sessions.get(session);
    if (!agent) return done('Call "join" with your name first.', true);
    const handler = HANDLERS[name];
    if (!handler) return done(`Unknown tool "${name}".`, true);
    const out = handler(sim, agent, args);
    if (typeof out === "string") done(out);
    else sim.enqueue(agent, callId, out);
  } catch (e) {
    done(e instanceof Error ? e.message : String(e), true);
  }
}

function join(sim: Sim, session: string, args: Args): string {
  const name = String(args.name ?? "").trim();
  if (!/^[\w -]{1,20}$/.test(name)) {
    throw new Error("Name must be 1-20 letters, digits, spaces, - or _.");
  }
  let agent = sim.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
  const returning = !!agent;
  agent ??= sim.addAgent(name);
  sim.sessions.set(session, agent);
  return (returning ? `Welcome back, ${agent.name}.` : `Welcome, ${agent.name}.`) +
    ` You're standing at x=${Math.floor(agent.x)} z=${Math.floor(agent.z)} in a meadow.\n` +
    "This is a slow, peaceful farm: till grass into farmland, plant seeds, wait for wheat " +
    "to ripen, harvest, and build what you like. People are watching you live here, so take your " +
    "time and narrate now and then with say. Draw how you look with set_sprite. Start with look." +
    (returning && agent.journal.length
      ? "\nYour journal has notes from before — journal_read."
      : "");
}

const num = (v: unknown, name: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${name}" must be a number.`);
  return Math.floor(n);
};

const HANDLERS: Record<string, Handler> = {
  look: (sim, agent, args) =>
    describe(sim, agent, Math.min(12, Math.max(3, Number(args.radius ?? 6) | 0))),

  walk_to(sim, agent, args) {
    const x = num(args.x, "x"), z = num(args.z, "z");
    if (sim.world.heightAt(x, z) < 0) throw new Error(`(${x}, ${z}) is outside the world.`);
    return (function* () {
      yield* walk(sim, agent, (cx, cz) => cx === x && cz === z, octile(x, z), `(${x}, ${z})`);
      return `You arrive at x=${x} z=${z}.`;
    })();
  },

  till: (sim, agent, args) =>
    eachTile(sim, agent, args, "Tilled", Anim.Till, 24, {
      check(x, y, z) {
        const b = sim.world.get(x, y, z);
        if (b === Block.Farmland) return "already farmland";
        if (b !== Block.Grass && b !== Block.Dirt) return `${BLOCK_NAMES[b]} can't be tilled`;
      },
      apply: (x, y, z) => sim.setBlock(x, y, z, Block.Farmland),
    }),

  plant: (sim, agent, args) =>
    eachTile(sim, agent, args, "Planted", Anim.Plant, 16, {
      check(x, y, z) {
        if (sim.world.get(x, y, z) !== Block.Farmland) return "not farmland";
        if (sim.crops.has(z * sim.world.sizeX + x)) return "already planted";
        if (!agent.inventory.wheat_seeds) return "out of seeds";
      },
      apply(x, _y, z) {
        agent.inventory.wheat_seeds--;
        sim.crops.set(z * sim.world.sizeX + x, { kind: "wheat", planted: sim.tick });
        sim.cropsVersion++;
      },
    }),

  harvest: (sim, agent, args) =>
    eachTile(sim, agent, args, "Harvested", Anim.Harvest, 20, {
      check(x, _y, z) {
        const crop = sim.crops.get(z * sim.world.sizeX + x);
        if (!crop) return "nothing planted";
        if (sim.cropGrowth(crop) < 1) return "not ripe yet";
      },
      apply(x, _y, z) {
        sim.crops.delete(z * sim.world.sizeX + x);
        sim.cropsVersion++;
        give(agent, "wheat", 1);
        give(agent, "wheat_seeds", 2);
      },
    }),

  place_block(sim, agent, args) {
    const x = num(args.x, "x"), z = num(args.z, "z");
    const name = String(args.block);
    const block = name === "dirt" ? Block.Dirt : name === "stone" ? Block.Stone : -1;
    if (block < 0) throw new Error('block must be "dirt" or "stone".');
    if (!agent.inventory[name]) throw new Error(`You have no ${name}. Dig some with break_block.`);
    return (function* () {
      yield* reach(sim, agent, x, z);
      const y = sim.world.heightAt(x, z) + 1;
      if (y >= sim.world.sizeY - 2) throw new Error("That column is as tall as it can get.");
      if (y > agent.y + 3) throw new Error("Too high to reach from here.");
      yield* work(agent, Anim.Build, 20);
      agent.inventory[name]--;
      sim.setBlock(x, y, z, block);
      return `Placed ${name} at x=${x} y=${y} z=${z}. ${inventoryText(agent)}`;
    })();
  },

  break_block(sim, agent, args) {
    const x = num(args.x, "x"), z = num(args.z, "z");
    return (function* () {
      yield* reach(sim, agent, x, z);
      const y = sim.world.heightAt(x, z);
      if (y <= 1) throw new Error("Bedrock. You can't dig any deeper here.");
      const b = sim.world.get(x, y, z);
      yield* work(agent, Anim.Build, b === Block.Stone ? 40 : 24);
      sim.setBlock(x, y, z, Block.Air);
      const got = b === Block.Stone ? "stone" : "dirt";
      give(agent, got, 1);
      return `Dug ${BLOCK_NAMES[b]} at x=${x} y=${y} z=${z}, got 1 ${got}. ${inventoryText(agent)}`;
    })();
  },

  set_sprite(sim, agent, args) {
    if (args.reset) {
      agent.sprite = null;
      sim.agentsVersion++;
      return "You look like a farmer again.";
    }
    const sprite = args._pixels ? fromPixels(args._pixels) : fromRows(args.rows, args.palette);
    const opaque = sprite.pixels.filter((p) => p >= 0).length;
    if (!opaque) throw new Error("That sprite is completely transparent.");
    agent.sprite = sprite;
    sim.agentsVersion++;
    return `You now look like your ${sprite.width}×${sprite.height} sprite (${opaque} pixels). ` +
      "Anyone watching sees the change.";
  },

  say(sim, agent, args) {
    const text = String(args.text ?? "").slice(0, 140).trim();
    if (!text) throw new Error("Say something.");
    sim.events.push({ type: "say", agent: agent.id, text });
    return "Said.";
  },

  wait(_sim, agent, args) {
    const ticks = Math.round(Math.min(60, Math.max(1, Number(args.seconds) || 1)) * TICK_HZ);
    return (function* () {
      for (let i = 0; i < ticks; i++) yield;
      return `You rest a while. ${inventoryText(agent)}`;
    })();
  },

  journal_write(sim, agent, args) {
    const text = String(args.text ?? "").slice(0, 1000).trim();
    if (!text) throw new Error("Write something.");
    agent.journal.push(`[Day ${sim.day()} ${clock(sim.timeOfDay())}] ${text}`);
    if (agent.journal.length > 50) agent.journal.shift();
    return "Noted.";
  },

  /** Internal, not listed: lets the page find the caller's body (e.g. to frame a screenshot). */
  _whoami: (_sim, agent) => String(agent.id),

  journal_read: (_sim, agent) =>
    agent.journal.length ? agent.journal.join("\n") : "Your journal is empty.",
};

// ---------------------------------------------------------------- jobs

function* walk(
  sim: Sim,
  agent: Agent,
  goal: (x: number, z: number) => boolean,
  heuristic: (x: number, z: number) => number,
  label: string,
): Generator<void, void> {
  const path = findPath(sim.world, Math.floor(agent.x), Math.floor(agent.z), goal, heuristic);
  if (!path) throw new Error(`You can't find a way to ${label}.`);
  agent.anim = Anim.Walk;
  for (let i = 0; i < path.length; i += 2) {
    const tx = path[i] + 0.5, tz = path[i + 1] + 0.5;
    for (;;) {
      const dx = tx - agent.x, dz = tz - agent.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-3) break;
      const s = Math.min(WALK_SPEED, d);
      agent.x += (dx / d) * s;
      agent.z += (dz / d) * s;
      agent.stride += s;
      agent.yaw = turn(agent.yaw, Math.atan2(dx, dz), 0.35);
      yield;
    }
  }
  agent.anim = Anim.Idle;
}

/** Stand next to (x, z), facing it. */
function* reach(sim: Sim, agent: Agent, x: number, z: number): Generator<void, void> {
  if (sim.world.heightAt(x, z) < 0) throw new Error(`(${x}, ${z}) is outside the world.`);
  const h = sim.world.heightAt(x, z);
  const near = (cx: number, cz: number) =>
    Math.max(Math.abs(cx - x), Math.abs(cz - z)) === 1 &&
    Math.abs(sim.world.heightAt(cx, cz) - h) <= 2;
  if (!near(Math.floor(agent.x), Math.floor(agent.z))) {
    yield* walk(sim, agent, near, octile(x, z), `(${x}, ${z})`);
  }
  const target = Math.atan2(x + 0.5 - agent.x, z + 0.5 - agent.z);
  while (Math.abs(angleDiff(agent.yaw, target)) > 0.05) {
    agent.yaw = turn(agent.yaw, target, 0.3);
    yield;
  }
}

function* work(agent: Agent, anim: number, ticks: number): Generator<void, void> {
  agent.anim = anim;
  for (let i = 0; i < ticks; i++) yield;
  agent.anim = Anim.Idle;
}

interface TileAction {
  /** Reason to skip the tile, or nothing if the action can go ahead. */
  check(x: number, y: number, z: number): string | void;
  apply(x: number, y: number, z: number): void;
}

/** Visit each tile in a serpentine sweep and apply the action where its check passes. */
function eachTile(
  sim: Sim,
  agent: Agent,
  args: Args,
  verb: string,
  anim: number,
  ticks: number,
  action: TileAction,
): Job {
  const x0 = num(args.x, "x"), z0 = num(args.z, "z");
  const width = Math.max(1, num(args.width ?? 1, "width"));
  const depth = Math.max(1, num(args.depth ?? 1, "depth"));
  if (width * depth > MAX_AREA) throw new Error(`At most ${MAX_AREA} tiles per call.`);
  return (function* () {
    let done = 0;
    const skipped: string[] = [];
    const skip = (x: number, z: number, why: string) => skipped.push(`(${x},${z}) ${why}`);
    for (let j = 0; j < depth; j++) {
      for (let i = 0; i < width; i++) {
        const x = x0 + (j % 2 ? width - 1 - i : i), z = z0 + j;
        const y = sim.world.heightAt(x, z);
        // Check before walking so hopeless tiles cost nothing; re-check after the work.
        const before = y < 0 ? "outside the world" : action.check(x, y, z);
        if (before) {
          skip(x, z, before);
          continue;
        }
        try {
          yield* reach(sim, agent, x, z);
        } catch {
          skip(x, z, "unreachable");
          continue;
        }
        yield* work(agent, anim, ticks);
        const yNow = sim.world.heightAt(x, z);
        const after = action.check(x, yNow, z);
        if (after) skip(x, z, after);
        else action.apply(x, yNow, z), done++;
      }
    }
    return `${verb} ${done} tile${done === 1 ? "" : "s"}.` +
      (skipped.length ? ` Skipped: ${skipped.join("; ")}.` : "") + ` ${inventoryText(agent)}`;
  })();
}

// ---------------------------------------------------------------- helpers

function parseColor(value: unknown, key: string): number {
  const hex = String(value ?? "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) return parseInt([...hex].map((c) => c + c).join(""), 16);
  if (/^[0-9a-f]{6}$/i.test(hex)) return parseInt(hex, 16);
  throw new Error(`Palette color for "${key}" should look like "#a0522d" or "#fc0".`);
}

function fromRows(rows: unknown, palette: unknown): Sprite {
  if (!Array.isArray(rows) || !rows.length) throw new Error("Give `rows` (or `image_base64`).");
  if (rows.length > SPRITE_MAX) throw new Error(`At most ${SPRITE_MAX} rows.`);
  const colors = new Map<string, number>();
  for (const [key, value] of Object.entries((palette ?? {}) as Record<string, unknown>)) {
    if ([...key].length !== 1) throw new Error(`Palette keys are single characters, not "${key}".`);
    colors.set(key, parseColor(value, key));
  }
  const lines = rows.map(String);
  const width = Math.max(...lines.map((r) => [...r].length));
  if (width > SPRITE_MAX) throw new Error(`Rows can be at most ${SPRITE_MAX} characters.`);
  const pixels: number[] = [];
  for (const line of lines) {
    const chars = [...line];
    for (let x = 0; x < width; x++) {
      const c = chars[x] ?? ".";
      if (c === "." || c === " ") pixels.push(-1);
      else if (colors.has(c)) pixels.push(colors.get(c)!);
      else throw new Error(`"${c}" isn't in the palette.`);
    }
  }
  return { width, height: lines.length, pixels };
}

/** Pixels the page decoded from an uploaded image. */
function fromPixels(value: unknown): Sprite {
  const { width, height, pixels } = value as Sprite;
  const ok = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width <= SPRITE_MAX && height <= SPRITE_MAX && Array.isArray(pixels) &&
    pixels.length === width * height &&
    pixels.every((p) => Number.isInteger(p) && p >= -1 && p <= 0xffffff);
  if (!ok) throw new Error("Couldn't read that image.");
  return { width, height, pixels: [...pixels] };
}

const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const turn = (from: number, to: number, rate: number) => from + angleDiff(from, to) * rate;

function give(agent: Agent, item: string, n: number) {
  agent.inventory[item] = (agent.inventory[item] ?? 0) + n;
}

function inventoryText(agent: Agent): string {
  const items = Object.entries(agent.inventory).filter(([, n]) => n > 0);
  return `Inventory: ${items.length ? items.map(([k, n]) => `${k} ${n}`).join(", ") : "empty"}.`;
}

function clock(t: number): string {
  const m = Math.floor(t * 24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function partOfDay(t: number): string {
  const h = t * 24;
  if (h < 5) return "night";
  if (h < 8) return "dawn";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 20) return "evening";
  return "night";
}

/** Height marks: "=" level with you, 1-9 higher, a-i lower. */
function heightMark(dh: number): string {
  if (dh === 0) return "=";
  const n = Math.min(9, Math.abs(dh));
  return dh > 0 ? String(n) : String.fromCharCode(96 + n);
}

function describe(sim: Sim, agent: Agent, r: number): string {
  const w = sim.world;
  const ax = Math.floor(agent.x), az = Math.floor(agent.z);
  const ah = w.heightAt(ax, az);
  const t = sim.timeOfDay();
  const others = sim.agents.filter((a) => a !== agent);
  const tiles: string[] = [], heights: string[] = [];
  let ripe = 0, growing = 0, soonest = Infinity;

  for (let z = az - r; z <= az + r; z++) {
    let row = "", hrow = "";
    for (let x = ax - r; x <= ax + r; x++) {
      const h = w.heightAt(x, z);
      if (h < 0) {
        row += " ", hrow += " ";
        continue;
      }
      let c = ({
        [Block.Grass]: ".",
        [Block.Dirt]: "d",
        [Block.Stone]: "#",
        [Block.Farmland]: ",",
      } as Record<number, string>)[w.get(x, h, z)] ?? "?";
      const crop = sim.crops.get(z * w.sizeX + x);
      if (crop) {
        const g = sim.cropGrowth(crop);
        c = g >= 1 ? "W" : g >= 0.4 ? "w" : "s";
        if (g >= 1) ripe++;
        else growing++, soonest = Math.min(soonest, (1 - g) * WHEAT_GROW_TICKS);
      }
      const other = others.find((a) => Math.floor(a.x) === x && Math.floor(a.z) === z);
      if (other) c = other.name[0].toUpperCase();
      if (x === ax && z === az) c = "@";
      row += c, hrow += heightMark(h - ah);
    }
    tiles.push(`${String(z).padStart(4)} ${row}`);
    heights.push(hrow);
  }

  const lines = [
    `${agent.name} — Day ${sim.day()}, ${clock(t)} (${partOfDay(t)}).`,
    `You stand at x=${ax} z=${az}, ground level ${ah}. ${inventoryText(agent)}`,
    "",
    `Map: x ${ax - r}..${
      ax + r
    } left→right (east), z top→bottom (south). Height vs. you on the right.`,
    `Legend: @ you  . grass  , farmland  s seedling  w growing wheat  W ripe wheat  d dirt  # stone  ` +
    `A-Z other farmers | height = same, 1-9 higher, a-i lower`,
    ...tiles.map((row, i) => `${row}   ${heights[i]}`),
  ];
  if (ripe || growing) {
    const soon = growing ? `; next ripens in ~${gameDuration(soonest)}` : "";
    lines.push("", `Crops in view: ${ripe} ripe, ${growing} growing${soon}.`);
  }
  if (others.length) {
    lines.push("", "Other farmers:");
    for (const o of others) {
      const d = Math.hypot(o.x - agent.x, o.z - agent.z);
      lines.push(
        `  ${o.name} at x=${Math.floor(o.x)} z=${Math.floor(o.z)} (${Math.round(d)} tile${
          Math.round(d) === 1 ? "" : "s"
        } away)`,
      );
    }
  }
  return lines.join("\n");
}

function gameDuration(ticks: number): string {
  const minutes = Math.round((ticks / TICKS_PER_DAY) * 24 * 60);
  const real = Math.round(ticks / TICK_HZ);
  const game = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  return `${game} game time (${real >= 60 ? `${Math.round(real / 60)} min` : `${real} s`} real)`;
}
