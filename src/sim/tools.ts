import { SPECIES } from "./animals.ts";
import { FISH, FISH_REGROW, waterHabitat } from "./fish.ts";
import {
  angleDiff,
  type Args,
  clock,
  give,
  type Handler,
  inventoryText,
  num,
  reach,
  solidProp,
  turn,
  walk,
  work,
} from "./jobs.ts";
import { CATALOG_HANDLERS, CATALOG_TOOL_DEFS, catalogSummary } from "./catalogtools.ts";
import { octile } from "./path.ts";
import { PROP_DEFS, PropKind } from "./props.ts";
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
import { Block } from "./world.ts";

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

export const SPRITE_MAX = 32;
const MAX_AREA = 16;
const CAST_RANGE = 4;
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
    description: "Enter the world as a villager with this name. Call this first. " +
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
      } game hours. Or plant a tree sapling (oak, birch or pine) on grass or dirt; trees take ` +
      `about ${
        Math.round(PROP_DEFS[PropKind.Oak].growTicks / TICKS_PER_DAY)
      } game days to grow and block the tile. ${areaNote}`,
    inputSchema: {
      type: "object",
      properties: {
        ...area,
        seed: {
          type: "string",
          enum: ["wheat", "oak", "birch", "pine"],
          description: "What to plant, default wheat. Trees use saplings from your inventory.",
        },
      },
      required: ["x", "z"],
    },
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
    name: "fish",
    description: "Cast a line into water at (x, z) from the bank (you walk to within " +
      `${CAST_RANGE} tiles) and wait for a bite. Fish bite best where a school is ` +
      "(f on the look map), at dawn and dusk, and under clouds. Rivers hold minnow, trout and " +
      "perch; the sea holds mackerel and cod. Caught fish go to your inventory.",
    inputSchema: {
      type: "object",
      properties: {
        x: int("Water tile x."),
        z: int("Water tile z."),
        casts: {
          ...int("How many times to cast before returning, 1-5. Default 1."),
          minimum: 1,
          maximum: 5,
        },
      },
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
  ...CATALOG_TOOL_DEFS,
  {
    name: "screenshot",
    description: "See the world as an image, centered on you. Costs more than look; use sparingly.",
    inputSchema: { type: "object", properties: {} },
    client: true,
  },
];

/**
 * Run a tool call. Instant tools push their result immediately; actions are
 * queued as jobs on the agent and resolve as the sim steps.
 */
export function callTool(sim: Sim, session: string, name: string, args: Args, callId: number) {
  let agent = sim.sessions.get(session) ?? null;
  const done = (text: string, isError = false) => sim.finish(agent, callId, text, isError);
  try {
    if (name === "join") {
      const text = join(sim, session, args);
      agent = sim.sessions.get(session)!;
      return done(text);
    }
    if (!agent) return done('Call "join" with your name first.', true);
    const handler = HANDLERS[name];
    if (!handler) return done(`Unknown tool "${name}".`, true);
    if (name !== "_whoami") agent.lastActive = sim.tick;
    const out = handler(sim, agent, args ?? {});
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
  agent.lastActive = sim.tick;
  const fx = Math.floor(agent.x), fz = Math.floor(agent.z);
  sim.fire("joined", agent, fx, sim.world.heightAt(fx, fz), fz, agent.name);
  return (returning ? `Welcome back, ${agent.name}.` : `Welcome, ${agent.name}.`) +
    ` You're standing at x=${Math.floor(agent.x)} z=${Math.floor(agent.z)} in a meadow.\n` +
    "This is a slow, peaceful farm: till grass into farmland, plant seeds, wait for wheat " +
    "to ripen, harvest, and build what you like. People are watching you live here, so take your " +
    "time and narrate now and then with say. Draw how you look with set_sprite.\n" +
    "Everything that can exist here is listed in the Catalog, and you can add to it: new " +
    "Materials, Designs, Rules that make things happen, and Relations between them " +
    "(catalog_find, catalog_get, catalog_add, catalog_fork). Changing shared entries goes " +
    `through propose and vote. ${catalogSummary(sim)}\nStart with look.` +
    (returning && agent.journal.length
      ? "\nYour journal has notes from before — journal_read."
      : "");
}

const HANDLERS: Record<string, Handler> = {
  ...CATALOG_HANDLERS,
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
        const blocked = solidProp(sim, x, z);
        if (blocked) return blocked;
        if (b === Block.Farmland) return "already farmland";
        if (b !== Block.Grass && b !== Block.Dirt) return `${sim.blocks.name(b)} can't be tilled`;
      },
      apply(x, y, z) {
        const was = sim.blocks.name(sim.world.get(x, y, z));
        sim.setBlock(x, y, z, Block.Farmland);
        sim.fire("tilled", agent, x, y, z, was);
      },
    }),

  plant(sim, agent, args) {
    const seed = String(args.seed ?? "wheat");
    if (seed !== "wheat") return plantTrees(sim, agent, args, seed);
    return eachTile(sim, agent, args, "Planted", Anim.Plant, 16, {
      check(x, y, z) {
        if (sim.world.get(x, y, z) !== Block.Farmland) return "not farmland";
        if (sim.crops.has(z * sim.world.sizeX + x)) return "already planted";
        if (!agent.inventory.wheat_seeds) return "out of seeds";
      },
      apply(x, y, z) {
        agent.inventory.wheat_seeds--;
        sim.crops.set(z * sim.world.sizeX + x, { kind: "wheat", planted: sim.tick });
        sim.cropsVersion++;
        sim.fire("planted", agent, x, y, z, "wheat");
      },
    });
  },

  harvest: (sim, agent, args) =>
    eachTile(sim, agent, args, "Harvested", Anim.Harvest, 20, {
      check(x, _y, z) {
        const crop = sim.crops.get(z * sim.world.sizeX + x);
        if (!crop) return "nothing planted";
        if (sim.cropGrowth(crop) < 1) return "not ripe yet";
      },
      apply(x, y, z) {
        sim.crops.delete(z * sim.world.sizeX + x);
        sim.cropsVersion++;
        give(agent, "wheat", 1);
        give(agent, "wheat_seeds", 2);
        sim.fire("harvested", agent, x, y, z, "wheat");
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
      const blocked = solidProp(sim, x, z);
      if (blocked) throw new Error(`Can't build there: ${blocked}.`);
      const y = sim.world.heightAt(x, z) + 1;
      if (y >= sim.world.sizeY - 2) throw new Error("That column is as tall as it can get.");
      if (y > agent.y + 3) throw new Error("Too high to reach from here.");
      yield* work(agent, Anim.Build, 20);
      agent.inventory[name]--;
      sim.setBlock(x, y, z, block);
      sim.fire("placed", agent, x, y, z, name);
      return `Placed ${name} at x=${x} y=${y} z=${z}. ${inventoryText(agent)}`;
    })();
  },

  fish(sim, agent, args) {
    const x = num(args.x, "x"), z = num(args.z, "z");
    const casts = Math.min(5, Math.max(1, num(args.casts ?? 1, "casts")));
    const habitat = waterHabitat(sim.world, x, z);
    if (!habitat) throw new Error(`(${x}, ${z}) isn't water. Fish in a river, pond or the sea.`);
    return (function* () {
      const w = sim.world;
      const bank = (cx: number, cz: number) =>
        Math.max(Math.abs(cx - x), Math.abs(cz - z)) <= CAST_RANGE &&
        w.waterTop[cz * w.sizeX + cx] < 0;
      if (!bank(Math.floor(agent.x), Math.floor(agent.z))) {
        yield* walk(sim, agent, bank, octile(x, z), `the bank near (${x}, ${z})`);
      }
      const target = Math.atan2(x + 0.5 - agent.x, z + 0.5 - agent.z);
      while (Math.abs(angleDiff(agent.yaw, target)) > 0.05) {
        agent.yaw = turn(agent.yaw, target, 0.3);
        yield;
      }
      const caught: string[] = [];
      for (let c = 0; c < casts; c++) {
        // Wait 3-9 seconds for a nibble.
        yield* work(agent, Anim.Fish, Math.round((3 + sim.rng.next() * 6) * TICK_HZ));
        const school = sim.schools
          .filter((s) => s.count > 0 && Math.hypot(s.x - x - 0.5, s.z - z - 0.5) < 3.5)
          .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
        const t = sim.timeOfDay();
        const dawnDusk = (t > 0.2 && t < 0.32) || (t > 0.72 && t < 0.85);
        const night = t < 0.2 || t > 0.85;
        const mood = (dawnDusk ? 1.4 : night ? 0.6 : 1) * (sim.clouds() > 0.6 ? 1.25 : 1);
        const local = FISH.map((d, i) => ({ d, i })).filter(({ d }) => d.habitat === habitat);
        const species = school
          ? school.species
          : local[Math.floor(sim.rng.next() * local.length)].i;
        const chance = Math.min(0.95, (school ? 0.7 : 0.1) * FISH[species].bite * mood);
        if (sim.rng.next() >= chance) continue;
        if (school) {
          if (school.count === FISH[school.species].size) school.regrowAt = sim.tick + FISH_REGROW;
          school.count--;
        }
        const name = FISH[species].name;
        give(agent, name, 1);
        caught.push(name);
        sim.events.push({ type: "catch", agent: agent.id, fish: name });
        sim.fire("caught", agent, x, Math.max(0, w.waterTop[z * w.sizeX + x]), z, name);
      }
      agent.anim = Anim.Idle;
      const tries = casts === 1 ? "You cast" : `You cast ${casts} times`;
      if (!caught.length) {
        return `${tries} at (${x}, ${z}) but nothing bit. Fish where you see a school ` +
          `(f on the look map); dawn and dusk are best. ${inventoryText(agent)}`;
      }
      return `${tries} at (${x}, ${z}) and caught ${caught.length}: ${caught.join(", ")}. ` +
        inventoryText(agent);
    })();
  },

  break_block(sim, agent, args) {
    const x = num(args.x, "x"), z = num(args.z, "z");
    return (function* () {
      yield* reach(sim, agent, x, z);
      const blocked = solidProp(sim, x, z);
      if (blocked) throw new Error(`Can't dig there: ${blocked}.`);
      const y = sim.world.heightAt(x, z);
      if (y <= 1) throw new Error("Bedrock. You can't dig any deeper here.");
      const b = sim.world.get(x, y, z);
      yield* work(agent, Anim.Build, b === Block.Stone ? 40 : 24);
      sim.setBlock(x, y, z, Block.Air);
      const got = b === Block.Stone ? "stone" : "dirt";
      give(agent, got, 1);
      sim.fire("broken", agent, x, y, z, sim.blocks.name(b));
      return `Dug ${sim.blocks.name(b)} at x=${x} y=${y} z=${z}, got 1 ${got}. ${
        inventoryText(agent)
      }`;
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
    const fx = Math.floor(agent.x), fz = Math.floor(agent.z);
    sim.fire("said", agent, fx, sim.world.heightAt(fx, fz), fz, text);
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

const TREES: Record<string, number> = {
  oak: PropKind.Oak,
  birch: PropKind.Birch,
  pine: PropKind.Pine,
};

function plantTrees(sim: Sim, agent: Agent, args: Args, seed: string): Job {
  const kind = TREES[seed];
  if (kind === undefined) throw new Error('seed must be "wheat", "oak", "birch" or "pine".');
  const item = `${seed}_sapling`;
  if (!agent.inventory[item]) throw new Error(`You have no ${item}.`);
  return eachTile(sim, agent, args, `Planted ${seed} on`, Anim.Plant, 30, {
    check(x, y, z) {
      const b = sim.world.get(x, y, z);
      if (sim.props.at(x, z)) return `${PROP_DEFS[sim.props.at(x, z)!.kind].name} already there`;
      if (b !== Block.Grass && b !== Block.Dirt) {
        return `can't plant a tree in ${sim.blocks.name(b)}`;
      }
      if (sim.world.waterTop[z * sim.world.sizeX + x] >= 0) return "under water";
      if (Math.floor(agent.x) === x && Math.floor(agent.z) === z) return "you're standing there";
      if (!agent.inventory[item]) return `out of ${item}`;
    },
    apply(x, y, z) {
      agent.inventory[item]--;
      const variant = (x * 7 + z * 13) % PROP_DEFS[kind].variants;
      sim.props.set(x, z, { kind, variant, planted: sim.tick });
      sim.fire("planted", agent, x, y, z, seed);
    },
  });
}

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
  // Nearest first: the map marks them 1-9 (letters would read as wheat, trees or animals).
  const others = sim.agents.filter((a) => a !== agent)
    .sort((a, b) =>
      Math.hypot(a.x - agent.x, a.z - agent.z) - Math.hypot(b.x - agent.x, b.z - agent.z)
    );
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
        [Block.Sand]: ":",
        [Block.Gravel]: ":",
        [Block.Clay]: ":",
      } as Record<number, string>)[w.get(x, h, z)] ?? "?";
      if (w.waterTop[z * w.sizeX + x] >= 0) c = w.waterTop[z * w.sizeX + x] - h > 1 ? "≈" : "~";
      const prop = sim.props.at(x, z);
      if (prop) c = sim.props.growth(prop, sim.tick) < 1 ? "t" : PROP_DEFS[prop.kind].mark;
      const crop = sim.crops.get(z * w.sizeX + x);
      if (crop) {
        const g = sim.cropGrowth(crop);
        c = g >= 1 ? "W" : g >= 0.4 ? "w" : "s";
        if (g >= 1) ripe++;
        else growing++, soonest = Math.min(soonest, (1 - g) * WHEAT_GROW_TICKS);
      }
      if (sim.schools.some((f) => f.count > 0 && Math.floor(f.x) === x && Math.floor(f.z) === z)) {
        c = "f";
      }
      const animal = sim.animals.find((a) => Math.floor(a.x) === x && Math.floor(a.z) === z);
      if (animal) c = SPECIES[animal.species].mark;
      const other = others.find((a) => Math.floor(a.x) === x && Math.floor(a.z) === z);
      if (other) c = others.indexOf(other) < 9 ? String(others.indexOf(other) + 1) : "+";
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
    `: sand/gravel  ~ shallow water (wade)  ≈ deep water (swim, slow)  T tree  A pine  t sapling  o rock  b bush  ` +
    `* flowers  | reeds  % lily pads  f fish school  ${
      SPECIES.map((d) => `${d.mark} ${d.name}`).join("  ")
    }  1-9 other villagers (trees, pines and rocks block walking) | ` +
    `height = same, 1-9 higher, a-i lower`,
    ...tiles.map((row, i) => `${row}   ${heights[i]}`),
  ];
  if (ripe || growing) {
    const soon = growing ? `; next ripens in ~${gameDuration(soonest)}` : "";
    lines.push("", `Crops in view: ${ripe} ripe, ${growing} growing${soon}.`);
  }
  const seen = sim.animals
    .map((a) => ({ a, d: Math.hypot(a.x - agent.x, a.z - agent.z) }))
    .filter(({ d }) => d <= r * 1.5);
  if (seen.length) {
    lines.push("", "Animals nearby:");
    SPECIES.forEach((def, species) => {
      const mine = seen.filter(({ a }) => a.species === species).sort((p, q) => p.d - q.d);
      if (!mine.length) return;
      const n = mine[0].a;
      const ready = def.product
        ? `, ${mine.filter(({ a }) => sim.tick >= a.readyAt).length} with ${def.product.item} ready`
        : "";
      lines.push(
        `  ${mine.length} ${def.name}${
          mine.length === 1 || def.name === "sheep" ? "" : "s"
        } — nearest at x=${Math.floor(n.x)} z=${Math.floor(n.z)} (${
          Math.round(mine[0].d)
        } tiles)${ready}`,
      );
    });
    lines.push(
      "  (Animals shy away from farmers walking right at them, and follow anyone carrying wheat.)",
    );
  }
  const schools = sim.schools
    .map((f) => ({ f, d: Math.hypot(f.x - agent.x, f.z - agent.z) }))
    .filter(({ f, d }) => f.count > 0 && d <= r * 1.5)
    .sort((a, b) => a.d - b.d);
  if (schools.length) {
    lines.push("", "Fish in view:");
    for (const { f, d } of schools) {
      lines.push(
        `  a school of ${FISH[f.species].name} at x=${Math.floor(f.x)} z=${Math.floor(f.z)} ` +
          `(${Math.round(d)} tiles, ${f.count} fish)`,
      );
    }
  }
  if (others.length) {
    lines.push("", "Other villagers:");
    for (const [i, o] of others.entries()) {
      const d = Math.hypot(o.x - agent.x, o.z - agent.z);
      lines.push(
        `  ${i < 9 ? i + 1 : "+"} ${o.name} at x=${Math.floor(o.x)} z=${Math.floor(o.z)} (${
          Math.round(d)
        } tile${Math.round(d) === 1 ? "" : "s"} away)`,
      );
    }
  }
  lines.push("", catalogSummary(sim));
  return lines.join("\n");
}

function gameDuration(ticks: number): string {
  const minutes = Math.round((ticks / TICKS_PER_DAY) * 24 * 60);
  const real = Math.round(ticks / TICK_HZ);
  const game = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  return `${game} game time (${real >= 60 ? `${Math.round(real / 60)} min` : `${real} s`} real)`;
}
