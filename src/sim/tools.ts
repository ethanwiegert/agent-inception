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
import { BUILD_HANDLERS, BUILD_TOOL_DEFS } from "./buildtools.ts";
import { MAKE_HANDLERS, MAKE_TOOL_DEFS } from "./maketools.ts";
import { BODY_HANDLERS, BODY_TOOL_DEFS, CARRY_MAX, kg, PUSH_MAX } from "./bodytools.ts";
import { CATALOG_HANDLERS, CATALOG_TOOL_DEFS, catalogSummary } from "./catalogtools.ts";
import { octile } from "./path.ts";
import type { DesignContent, Entry, RelationContent } from "./catalog.ts";
import { partBounds } from "./objects.ts";
import { habitatRefusal, plantInfo } from "./props.ts";
import { type Agent, Anim, type Job, type Sim, TICK_HZ, TICKS_PER_DAY } from "./sim.ts";
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

/** A body Design fits in this box (x, height, z), in blocks. */
export const BODY_SIZE = [1.2, 2.4, 1.2] as const;
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
      "with heights, crops, plants, built blocks and other villagers. Cheap; use it whenever " +
      "you need to orient.",
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
    description: "Plant something from your inventory that grows, one per tile: wheat seeds on " +
      "farmland (ripe in about 18 game hours), or a sapling (oak, birch, pine) on grass or dirt " +
      "(a tree in about 2 game days; trees block the tile). What grows from what, on which " +
      `ground and how fast is in the Catalog (grows_into Relations, a Design's habitat). ${areaNote}`,
    inputSchema: {
      type: "object",
      properties: {
        ...area,
        seed: {
          type: "string",
          description: 'What to plant: "wheat seeds" (the default), "oak sapling", or the ' +
            'plant\'s name ("wheat", "oak", "birch", "pine").',
        },
      },
      required: ["x", "z"],
    },
  },
  {
    name: "harvest",
    description: "Harvest ripe crops on farmland: wheat gives 1 wheat and 2 wheat seeds per " +
      `tile (a crop's drops Relations say what). Unripe crops are left alone. ${areaNote}`,
    inputSchema: { type: "object", properties: area, required: ["x", "z"] },
  },
  ...BUILD_TOOL_DEFS,
  ...MAKE_TOOL_DEFS,
  ...BODY_TOOL_DEFS,
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
    name: "set_body",
    description: "Choose how you look: your body becomes any Design with a part whose role " +
      'is "body" and that fits in about 1.2 × 2.4 × 1.2 blocks (stand on (0.5, 0, 0.5)). Its ' +
      "roles move: head turns, arms and legs swing; parts with other roles ride on the body. " +
      'Read the "farmer" Design (catalog_get) as the worked example, fork it with your own ' +
      'parts and Materials, then set_body it. design "farmer" goes back to the default look.',
    inputSchema: {
      type: "object",
      properties: {
        design: { type: "string", description: 'The Design\'s name or id, e.g. "farmer".' },
      },
      required: ["design"],
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
    // An argument the tool doesn't take is a mistake to point out, not to ignore quietly.
    const known = TOOL_DEFS.find((t) => t.name === name)?.inputSchema.properties;
    const unknown = known && Object.keys(args ?? {}).filter((k) => !(k in known));
    if (unknown?.length) {
      const takes = Object.keys(known!);
      return done(
        `${name} doesn't take ${unknown.map((k) => `"${k}"`).join(", ")}. ` +
          (takes.length ? `It takes ${takes.join(", ")}.` : "It takes no arguments."),
        true,
      );
    }
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
    "to ripen, harvest, and build what you like: place_block lays a floor or raises a wall in " +
    "one call, break_block digs, and build puts up a whole Design (its blocks, and its parts as " +
    "an Object like a bench). interact chops trees, breaks rocks, picks flowers and shears, " +
    "milks or collects from animals; craft turns logs into planks, stone into cobble and clay " +
    "into brick. Objects built from parts are real things: they fall, stack, roll, float or " +
    "sink, and you can push them along or carry light ones and put_down them anywhere (mind " +
    "anyone standing downhill of a rolling boulder). People are watching " +
    "you live here, so take your time and narrate now and then with say. Choose how you look " +
    "with set_body: any Design with a body part, like the farmer you are now.\n" +
    "Everything that can exist here is listed in the Catalog, and you can add to it: new " +
    "Materials, Designs, Rules that make things happen, and Relations between them " +
    "(catalog_find, catalog_get, catalog_add, catalog_fork). What you carry is a Material too " +
    "(seeds, saplings, wheat, wool, milk, eggs, fish), counted by its Catalog name. Changing " +
    `shared entries goes through propose and vote. ${catalogSummary(sim)}\nStart with look.` +
    (returning && agent.journal.length
      ? "\nYour journal has notes from before — journal_read."
      : "");
}

const HANDLERS: Record<string, Handler> = {
  ...CATALOG_HANDLERS,
  ...BUILD_HANDLERS,
  ...MAKE_HANDLERS,
  ...BODY_HANDLERS,
  look: (sim, agent, args) =>
    describe(sim, agent, Math.min(12, Math.max(3, Number(args.radius ?? 6) | 0))),

  walk_to(sim, agent, args) {
    const x = num(args.x, "x"), z = num(args.z, "z");
    if (sim.world.heightAt(x, z) < 0) throw new Error(`(${x}, ${z}) is outside the world.`);
    const inWay = solidProp(sim, x, z) ??
      (sim.world.objSolid[z * sim.world.sizeX + x] ? objectThere(sim, x, z) : undefined);
    if (inWay) {
      throw new Error(
        `You can't stand at (${x}, ${z}): ${inWay}, in the way (too tall, or light enough to ` +
          "kick away). Walk to a tile beside it.",
      );
    }
    return (function* () {
      yield* walk(sim, agent, (cx, cz) => cx === x && cz === z, octile(x, z), `(${x}, ${z})`);
      return `You arrive at x=${x} z=${z}.`;
    })();
  },

  till: (sim, agent, args) =>
    eachTile(sim, agent, args, "Tilled", Anim.Till, 24, {
      check(x, y, z) {
        const b = sim.world.get(x, y, z);
        const blocked = solidProp(sim, x, z) ?? objectThere(sim, x, z);
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
    const { seed, design, grow } = plantable(sim, agent, args.seed);
    const info = plantInfo(sim.catalog, design.id)!;
    const sizeX = sim.world.sizeX;
    return eachTile(sim, agent, args, `Planted ${design.name} on`, Anim.Plant, 16, {
      check(x, y, z) {
        const key = z * sizeX + x;
        const b = sim.blocks.name(sim.world.get(x, y, z));
        const ground = habitatRefusal(sim.world, info, x, z, b);
        if (ground?.startsWith("grows on")) return `${design.name} ${ground}`;
        if (ground) return ground;
        if (sim.crops.has(key)) return "already planted";
        const object = objectThere(sim, x, z);
        if (object) return object;
        const prop = sim.props.at(x, z);
        if (prop) return `${sim.props.info(prop)?.entry.name ?? "something"} already there`;
        if (info.solid && Math.floor(agent.x) === x && Math.floor(agent.z) === z) {
          return "you're standing there";
        }
        if (!agent.inventory[seed]) return `out of ${seed}`;
      },
      apply(x, y, z) {
        agent.inventory[seed]--;
        const plant = { design: design.id, planted: sim.tick, grow };
        if (sim.world.get(x, y, z) === Block.Farmland) {
          sim.crops.set(z * sizeX + x, plant);
          sim.cropsVersion++;
        } else sim.props.set(x, z, plant);
        sim.fire("planted", agent, x, y, z, design.name);
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
        const key = z * sim.world.sizeX + x;
        const crop = sim.crops.get(key)!;
        sim.crops.delete(key);
        sim.cropsVersion++;
        const design = sim.catalog.get(crop.design);
        for (const [item, n] of design ? sim.drops(design) : []) give(agent, item, n);
        sim.fire("harvested", agent, x, y, z, design?.name ?? "crop");
      },
    }),

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
        const name = sim.produce(FISH[species].name);
        if (!name) continue; // retired with nothing in its place: nothing bites
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

  set_body(sim, agent, args) {
    const e = sim.catalog.resolve(args.design, "Design");
    if (e.kind !== "design") throw new Error(`"${e.name}" is a ${e.kind}, not a Design.`);
    const live = sim.catalog.current(e);
    if (!live) throw new Error(`"${e.name}" is retired, so nobody takes its shape now.`);
    const farmer = sim.catalog.byName("farmer");
    if (farmer && sim.catalog.current(farmer)?.id === live.id) {
      agent.body = null;
      sim.agentsVersion++;
      return `You look like the "${live.name}" again, in your own shirt and skin.`;
    }
    const why = bodyRefusal(live.content as DesignContent);
    if (why) throw new Error(`"${live.name}" can't be a body: ${why}.`);
    agent.body = live.id;
    sim.agentsVersion++;
    return `You now look like "${live.name}". Anyone watching sees the change.`;
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

/** Marks of every plant Design in the Catalog (they're the ones look maps), per Catalog version. */
const plantMarkCache = new WeakMap<Sim, { version: number; marks: string[] }>();
function plantMarks(sim: Sim): string[] {
  const hit = plantMarkCache.get(sim);
  if (hit?.version === sim.catalog.version) return hit.marks;
  const marks = new Set<string>();
  for (const e of sim.catalog.entries) {
    if (e.kind === "design" && (e.content as DesignContent).habitat) {
      const info = plantInfo(sim.catalog, e.id);
      if (info) marks.add(info.mark);
    }
  }
  const out = { version: sim.catalog.version, marks: [...marks] };
  plantMarkCache.set(sim, out);
  return out.marks;
}

/** Why an Object on (x, z) stops work there, or nothing. */
function objectThere(sim: Sim, x: number, z: number): string | undefined {
  const o = sim.objects.at(x, z);
  return o ? `the ${sim.catalog.get(o.design)?.name ?? "Object"} stands there` : undefined;
}

/**
 * Which held Material to plant and what it grows into: by its name ("oak sapling"), the start of
 * it ("wheat" for "wheat seeds"), or the plant's name ("oak"). Its grows_into Relation says the
 * Design and how long it takes; a replaced Design grows its replacement.
 */
function plantable(
  sim: Sim,
  agent: Agent,
  wanted: unknown,
): { seed: string; design: Entry; grow: number } {
  const c = sim.catalog;
  const want = String(wanted ?? "wheat seeds").trim().toLowerCase().replace(/_/g, " ");
  const options: { seed: string; design: Entry; rel: RelationContent }[] = [];
  for (const [item, n] of Object.entries(agent.inventory)) {
    const e = n > 0 ? c.byName(item) : undefined;
    if (!e) continue;
    for (const { entry, rel } of c.links(e.id, "grows_into")) {
      options.push({ seed: e.name, design: entry, rel });
    }
  }
  const hit = options.find((o) => o.seed.toLowerCase() === want) ??
    options.find((o) => o.design.name.toLowerCase() === want) ??
    options.find((o) => o.seed.toLowerCase().startsWith(want + " ")) ??
    options.find((o) => o.design.name.toLowerCase().startsWith(want + " "));
  if (!hit) {
    const have = [...new Set(options.map((o) => o.seed))];
    throw new Error(
      `You have nothing to plant called "${want}". ` +
        (have.length ? `You can plant: ${have.join(", ")}.` : "You have no seeds or saplings."),
    );
  }
  const design = c.current(hit.design);
  if (!design) {
    throw new Error(`"${hit.design.name}" is retired, so nothing grows from ${hit.seed} now.`);
  }
  if (!(design.content as DesignContent).habitat) {
    throw new Error(
      `"${design.name}" isn't a plant (no habitat), so nothing grows from ${hit.seed} now.`,
    );
  }
  return { seed: hit.seed, design, grow: Math.round(((hit.rel.hours ?? 24) / 24) * TICKS_PER_DAY) };
}

/**
 * Why a Design can't be a villager's body, or nothing: it needs a "body" part and has to fit a
 * villager's space, standing on its first cell.
 */
export function bodyRefusal(d: DesignContent): string | void {
  if (!d.parts.some((p) => p.role === "body")) return 'none of its parts has the role "body"';
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of d.parts) {
    const [a, b] = partBounds(p);
    for (let k = 0; k < 3; k++) lo[k] = Math.min(lo[k], a[k]), hi[k] = Math.max(hi[k], b[k]);
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  if (hi[0] - lo[0] > BODY_SIZE[0] || hi[2] - lo[2] > BODY_SIZE[2]) {
    return `it's ${r(hi[0] - lo[0])} × ${r(hi[2] - lo[2])} across; a body fits in ` +
      `${BODY_SIZE[0]} × ${BODY_SIZE[2]}`;
  }
  if (hi[1] > BODY_SIZE[1]) return `it's ${r(hi[1])} tall; a body is at most ${BODY_SIZE[1]}`;
  if (lo[1] < -0.1) return "it reaches below the ground (y < 0)";
  if (Math.abs((lo[0] + hi[0]) / 2 - 0.5) > 0.35 || Math.abs((lo[2] + hi[2]) / 2 - 0.5) > 0.35) {
    return "it isn't centered on (0.5, 0, 0.5), where a villager stands";
  }
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

/** Map marks for the ground the terrain is made of. */
const NATURAL_MARKS: Record<number, string> = {
  [Block.Grass]: ".",
  [Block.Dirt]: "d",
  [Block.Stone]: "#",
  [Block.Farmland]: ",",
  [Block.Sand]: ":",
  [Block.Gravel]: ":",
  [Block.Clay]: ":",
};
/** Marks the legend already means something by (villagers are digits). */
const FIXED_MARKS = "@.,swWd#:~≈ft+";
/** For built blocks once their names' letters are all taken. */
const SPARE_MARKS = "$=^!?;<>";

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
  /** Map marks of the plants in view, and what they are. */
  const marks = new Map<string, Set<string>>();
  // Built blocks (planks, brick, anything agents invent) get a mark no plant or animal uses.
  // Every plant's mark is reserved, in view or not, so built things never read as plants and keep
  // the same mark from one look to the next.
  const taken = new Set([...FIXED_MARKS, ...SPECIES.map((d) => d.mark), ...plantMarks(sim)]);
  for (let z = az - r; z <= az + r; z++) {
    for (let x = ax - r; x <= ax + r; x++) {
      const prop = sim.props.at(x, z);
      const info = prop && sim.props.info(prop);
      if (info) taken.add(info.mark);
    }
  }
  const built = new Map<number, string>();
  /** Marks for Objects in view by Design, and how bodies get past each. */
  const objMarks = new Map<number, { mark: string; name: string; how: string }>();
  const objectMark = (x: number, z: number): string | null => {
    const o = sim.objects.at(x, z);
    if (!o) return null;
    let m = objMarks.get(o.design);
    if (!m) {
      const e = sim.catalog.get(o.design);
      const name = e?.name ?? "Object";
      const own = (e?.content as DesignContent | undefined)?.mark;
      const mark = own && !taken.has(own) ? own : [
        ...name.toUpperCase(),
        ...name.toLowerCase(),
        ...SPARE_MARKS,
      ].find((ch) => /[^\s\d]/.test(ch) && !taken.has(ch)) ?? "?";
      taken.add(mark);
      objMarks.set(o.design, m = { mark, name, how: "" });
    }
    const key = z * w.sizeX + x;
    const how = w.objSolid[key] ? "in the way" : w.objLift[key] ? "stand on" : "walk under";
    if (!m.how.includes(how)) m.how = m.how ? `${m.how}/${how}` : how;
    return m.mark;
  };
  const blockMark = (b: number) => {
    let mark = NATURAL_MARKS[b] ?? built.get(b);
    if (mark) return mark;
    const name = sim.blocks.name(b);
    mark = [...name.toUpperCase(), ...name.toLowerCase(), ...SPARE_MARKS]
      .find((ch) => /[^\s\d]/.test(ch) && !taken.has(ch)) ?? "?";
    taken.add(mark);
    built.set(b, mark);
    return mark;
  };

  for (let z = az - r; z <= az + r; z++) {
    let row = "", hrow = "";
    for (let x = ax - r; x <= ax + r; x++) {
      const h = w.heightAt(x, z);
      if (h < 0) {
        row += " ", hrow += " ";
        continue;
      }
      let c = blockMark(w.get(x, h, z));
      if (w.waterTop[z * w.sizeX + x] >= 0) c = w.waterTop[z * w.sizeX + x] - h > 1 ? "≈" : "~";
      const prop = sim.props.at(x, z);
      const info = prop && sim.props.info(prop);
      if (prop && info) {
        const young = sim.props.growth(prop, sim.tick) < 1;
        c = young ? "t" : info.mark;
        const names = marks.get(c) ?? new Set();
        marks.set(c, names.add(young ? `young ${info.entry.name}` : info.entry.name));
      }
      const om = objectMark(x, z);
      if (om) c = om;
      const crop = sim.crops.get(z * w.sizeX + x);
      if (crop) {
        const g = sim.cropGrowth(crop);
        c = g >= 1 ? "W" : g >= 0.4 ? "w" : "s";
        if (g >= 1) ripe++;
        else growing++, soonest = Math.min(soonest, (1 - g) * crop.grow);
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
    `Legend: @ you  . grass  , farmland  s seedling  w growing crop  W ripe crop  d dirt  # stone  ` +
    `: sand/gravel  ~ shallow water (wade)  ≈ deep water (swim, slow)  f fish school  ${
      SPECIES.map((d) => `${d.mark} ${d.name}`).join("  ")
    }  1-9 other villagers | height = same, 1-9 higher, a-i lower`,
    ...(built.size
      ? [`Blocks: ${[...built].map(([b, m]) => `${m} ${sim.blocks.name(b)}`).join("  ")}`]
      : []),
    ...(objMarks.size
      ? [
        `Objects: ${
          [...objMarks.values()].map((m) => `${m.mark} ${m.name} (${m.how})`).join("  ")
        } (interact takes one apart)`,
      ]
      : []),
    ...(marks.size
      ? [
        `Plants: ${
          [...marks].sort().map(([m, names]) => `${m} ${[...names].sort().join("/")}`).join("  ")
        } (trees and rocks block walking)`,
      ]
      : []),
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
      const body = sim.catalog.byName(def.name);
      const product = def.productEvery && body ? sim.drops(body)[0]?.[0] : undefined;
      const ready = product
        ? `, ${mine.filter(({ a }) => sim.tick >= a.readyAt).length} with ${product} ready`
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
      "  (Animals shy away from villagers walking right at them, and follow anyone carrying " +
        "their food: is_food_for in the Catalog. interact shears, milks or collects eggs when " +
        "theirs is ready.)",
    );
  }
  // Objects that move: where they are now and what it takes to move them.
  const things = sim.objects.list
    .filter((o) => sim.physics.shape(o.design)?.fixed === false)
    .map((o) => ({ o, c: sim.physics.center(o) }))
    .map((t) => ({ ...t, d: Math.hypot(t.c[0] - agent.x, t.c[2] - agent.z) }))
    .filter((t) => t.d <= r * 1.5)
    .sort((a, b) => a.d - b.d);
  if (things.length) {
    lines.push("", "Things that move:");
    for (const { o, c, d } of things.slice(0, 8)) {
      const mass = sim.physics.shape(o.design)!.mass;
      const how = o.held === agent.id
        ? "you carry it"
        : o.held
        ? `carried by ${sim.agents.find((a) => a.id === o.held)?.name ?? "someone"}`
        : mass <= CARRY_MAX
        ? "carry or push"
        : mass <= PUSH_MAX
        ? "push"
        : "too heavy to move";
      const motion = !o.asleep && !o.held && Math.hypot(...o.vel) > 0.3 ? ", moving" : "";
      lines.push(
        `  ${sim.catalog.get(o.design)?.name ?? "Object"} at x=${Math.floor(c[0])} z=${
          Math.floor(c[2])
        } (${Math.round(d)} tiles, ${kg(mass)}: ${how}${motion})`,
      );
    }
    if (things.length > 8) lines.push(`  …and ${things.length - 8} more`);
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
