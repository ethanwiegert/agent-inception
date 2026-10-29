import { type Animal, SPECIES } from "./animals.ts";
import type { DesignContent, Entry, MaterialContent } from "./catalog.ts";
import { give, type Handler, inventoryText, num, reach, work } from "./jobs.ts";
import { PART_TICKS, partCost, type WorldObject } from "./objects.ts";
import { type Agent, Anim, type Sim, TICK_HZ } from "./sim.ts";
import type { ToolDef } from "./tools.ts";

/**
 * Making and gathering: `craft` turns one Material into another along made_from Relations, and
 * `interact` gathers from what stands on a tile (chop a tree, pick flowers, break a rock, dig up a
 * sapling, take an Object apart) and collects from animals (shear, milk, eggs). What comes out is
 * Catalog data: made_from and drops Relations, each following replaced_by.
 */

const MAX_AREA = 16;
/** Batches one craft call may run (about a second each). */
const MAX_TIMES = 16;
const CRAFT_TICKS = TICK_HZ;
/** How close a villager has to get to an animal to shear, milk or collect from it. */
const ANIMAL_REACH = 2.2;

const int = (description: string) => ({ type: "integer", description });

export const MAKE_TOOL_DEFS: ToolDef[] = [
  {
    name: "craft",
    description: "Make a Material from another you carry, by its recipe (a made_from Relation): " +
      "4 planks from 1 log, cobble from stone, brick or tiles from clay. Works anywhere, about a " +
      "second per batch. Find recipes with catalog_find property type=made_from; invent your " +
      "own Material and add a made_from Relation to craft it.",
    inputSchema: {
      type: "object",
      properties: {
        item: { type: "string", description: 'What to make, e.g. "planks".' },
        times: {
          ...int(`How many batches, 1-${MAX_TIMES}. Default 1.`),
          minimum: 1,
          maximum: MAX_TIMES,
        },
        from: {
          type: "string",
          description: "Which ingredient to use, when the item has more than one recipe.",
        },
      },
      required: ["item"],
    },
  },
  {
    name: "interact",
    description: "Gather from what's on the tiles: chop a grown tree (logs and a sapling), break " +
      "a rock (stone), pick flowers, reeds or lily pads (to replant elsewhere), pick berries off " +
      "a bush, dig up a young sapling (you get it back), or take apart an Object someone built " +
      "(you get its Materials back). Also shears sheep, milks cows and collects eggs from " +
      "animals in the area when theirs is ready; you approach slowly so they stay put. What " +
      "each gives is its drops Relations in the Catalog. Covers width × depth tiles (at most " +
      `${MAX_AREA}) from (x, z); \`target\` limits it to things with that name.`,
    inputSchema: {
      type: "object",
      properties: {
        x: int("West edge of the area."),
        z: int("North edge of the area."),
        width: { ...int("Tiles along x, default 1."), minimum: 1, maximum: MAX_AREA },
        depth: { ...int("Tiles along z, default 1."), minimum: 1, maximum: MAX_AREA },
        target: {
          type: "string",
          description: 'Only this kind of thing, e.g. "sheep", "oak", "poppies" or an Object.',
        },
      },
      required: ["x", "z"],
    },
  },
];

export const MAKE_HANDLERS: Record<string, Handler> = {
  craft(sim, agent, args) {
    const times = args.times === undefined ? 1 : num(args.times, "times");
    if (times < 1 || times > MAX_TIMES) throw new Error(`times is 1-${MAX_TIMES}.`);
    const recipe = pickRecipe(sim, agent, args.item, args.from);
    return (function* () {
      let made = 0, used = 0;
      for (let i = 0; i < times; i++) {
        if ((agent.inventory[recipe.input] ?? 0) < 1) break;
        yield* work(agent, Anim.Build, CRAFT_TICKS);
        if ((agent.inventory[recipe.input] ?? 0) < 1) break;
        agent.inventory[recipe.input]--;
        give(agent, recipe.output, recipe.count);
        used++, made += recipe.count;
        const fx = Math.floor(agent.x), fz = Math.floor(agent.z);
        sim.fire("crafted", agent, fx, sim.world.heightAt(fx, fz), fz, recipe.output);
      }
      const short = used < times ? ` You ran out of ${recipe.input} after ${used}.` : "";
      return `Crafted ${made} ${recipe.output} from ${used} ${recipe.input}.${short} ` +
        inventoryText(agent);
    })();
  },

  interact(sim, agent, args) {
    const x0 = num(args.x, "x"), z0 = num(args.z, "z");
    const width = Math.max(1, num(args.width ?? 1, "width"));
    const depth = Math.max(1, num(args.depth ?? 1, "depth"));
    if (width * depth > MAX_AREA) throw new Error(`At most ${MAX_AREA} tiles per call.`);
    const target = args.target === undefined
      ? null
      : String(args.target).trim().toLowerCase().replace(/_/g, " ");
    const fits = (name: string) => !target || nameMatches(name, target);
    const w = sim.world;
    const tiles: [number, number][] = [];
    for (let j = 0; j < depth; j++) {
      for (let i = 0; i < width; i++) tiles.push([x0 + (j % 2 ? width - 1 - i : i), z0 + j]);
    }
    if (tiles.every(([x, z]) => w.heightAt(x, z) < 0)) {
      throw new Error(`(${x0}, ${z0}) is outside the world.`);
    }
    // Animals standing in (or a step outside) the area now: they wander, so look a tile wider.
    const near = (a: Animal) =>
      a.x >= x0 - 1 && a.x < x0 + width + 1 && a.z >= z0 - 1 && a.z < z0 + depth + 1;
    const animals = sim.animals.filter((a) =>
      near(a) && SPECIES[a.species].productEvery > 0 && fits(SPECIES[a.species].name)
    );
    const seen = new Set<number>();
    const things = tiles.filter(([x, z]) => {
      const o = sim.objects.at(x, z);
      if (o) {
        if (seen.has(o.id) || !fits(objectName(sim, o))) return false;
        seen.add(o.id);
        return true;
      }
      const p = sim.props.at(x, z);
      return !!p && fits(sim.props.info(p)?.entry.name ?? "");
    });
    if (!things.length && !animals.length) {
      const what = target ? `no ${target}` : "nothing to gather";
      throw new Error(
        `There's ${what} ${where(x0, z0, width, depth)}. interact works on trees, rocks, ` +
          "flowers, reeds, lily pads, bushes, saplings, built Objects, and sheep, cows and " +
          "chickens (look shows where they are).",
      );
    }
    return (function* () {
      const got = new Map<string, number>();
      const did: string[] = [];
      const skipped: string[] = [];
      const take = (items: [string, number][]) => {
        for (const [item, n] of items) {
          give(agent, item, n);
          got.set(item, (got.get(item) ?? 0) + n);
        }
      };
      for (const [x, z] of things) {
        const o = sim.objects.at(x, z);
        const p = o ? undefined : sim.props.at(x, z);
        const label = o ? objectName(sim, o) : p ? sim.props.info(p)?.entry.name ?? "" : "";
        if (!o && !p) {
          skipped.push(`(${x},${z}) nothing there now`);
          continue;
        }
        // What a plant gives is known before walking over, so hopeless tiles cost nothing.
        const plant = p ? gatherPlant(sim, p) : null;
        if (plant && !plant.items.length) {
          skipped.push(`(${x},${z}) the ${label} gives nothing (it has no drops Relation)`);
          continue;
        }
        try {
          yield* reach(sim, agent, x, z);
        } catch {
          skipped.push(`(${x},${z}) unreachable`);
          continue;
        }
        if (o) {
          const content = sim.objects.design(o);
          const parts = content?.parts.length ?? 1;
          yield* work(agent, Anim.Build, Math.min(8 * TICK_HZ, PART_TICKS * parts));
          if (!sim.objects.get(o.id)) {
            skipped.push(`(${x},${z}) the ${label} is gone`);
            continue;
          }
          sim.objects.remove(o);
          take(content ? [...partCost(content)] : []);
          did.push(`took apart the ${label}`);
          sim.fire("gathered", agent, x, w.heightAt(x, z), z, label);
          continue;
        }
        yield* work(agent, plant!.anim, plant!.ticks);
        const still = sim.props.at(x, z);
        if (still !== p) {
          skipped.push(`(${x},${z}) the ${label} is gone`);
          continue;
        }
        sim.props.set(x, z, null);
        take(plant!.items);
        did.push(`${plant!.verb} the ${label}`);
        sim.fire("gathered", agent, x, w.heightAt(x, z), z, label);
      }
      for (const a of animals) {
        const def = SPECIES[a.species];
        const body = sim.catalog.byName(def.name);
        const live = body && sim.catalog.current(body);
        const items = live ? sim.drops(live) : [];
        if (!items.length) {
          skipped.push(`the ${def.name} gives nothing now (no drops Relation)`);
          continue;
        }
        if (sim.tick < a.readyAt) {
          const mins = Math.ceil(((a.readyAt - sim.tick) / sim.ticksPerDay) * 24 * 60);
          skipped.push(
            `the ${def.name} at (${Math.floor(a.x)},${Math.floor(a.z)}) has no ` +
              `${items[0][0]} yet (ready in ~${
                mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`
              })`,
          );
          continue;
        }
        if (!(yield* approach(sim, agent, a))) {
          skipped.push(`the ${def.name} kept out of reach`);
          continue;
        }
        yield* work(agent, Anim.Harvest, TICK_HZ * 2);
        if (sim.tick < a.readyAt) continue;
        a.readyAt = sim.tick + def.productEvery;
        take(items);
        did.push(`${VERBS[def.name] ?? "collected from"} a ${def.name}`);
        const fx = Math.floor(a.x), fz = Math.floor(a.z);
        sim.fire("gathered", agent, fx, w.heightAt(fx, fz), fz, def.name);
      }
      const gotText = got.size ? `, got ${[...got].map(([k, n]) => `${n} ${k}`).join(", ")}` : "";
      const head = did.length ? `You ${summarize(did)}${gotText}.` : "You gathered nothing.";
      return head + (skipped.length ? ` Skipped: ${skipped.slice(0, 8).join("; ")}.` : "") +
        ` ${inventoryText(agent)}`;
    })();
  },
};

const VERBS: Record<string, string> = {
  sheep: "sheared",
  cow: "milked",
  chicken: "collected eggs from",
};

// ---------------------------------------------------------------- helpers

/** "chopped the oak, chopped the oak, picked the poppies" → "chopped the oak ×2, picked…". */
function summarize(did: string[]): string {
  const counts = new Map<string, number>();
  for (const d of did) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts].map(([d, n]) => (n > 1 ? `${d} ×${n}` : d)).join(", ");
}

function where(x: number, z: number, width: number, depth: number): string {
  return width * depth === 1
    ? `at (${x}, ${z})`
    : `over x=${x}..${x + width - 1} z=${z}..${z + depth - 1}`;
}

/** Whole words of `name` start with `want` ("oak" matches "oak", "sheep" matches "sheep"). */
function nameMatches(name: string, want: string): boolean {
  const n = name.toLowerCase();
  return n === want || n.startsWith(want + " ") || n.endsWith(" " + want) ||
    n.includes(` ${want} `);
}

function objectName(sim: Sim, o: WorldObject): string {
  return sim.catalog.get(o.design)?.name ?? "Object";
}

/**
 * What gathering a prop gives and how long it takes: a young plant gives back what it grew from;
 * a grown one its drops (following replaced_by). Harder Materials take longer.
 */
function gatherPlant(
  sim: Sim,
  p: { design: number; planted: number; grow: number },
): { items: [string, number][]; verb: string; ticks: number; anim: number } {
  const c = sim.catalog;
  const stored = c.get(p.design);
  const entry: Entry | undefined = (stored && c.current(stored)) || stored;
  if (!entry) return { items: [], verb: "", ticks: 0, anim: Anim.Harvest };
  const d = entry.content as DesignContent;
  const hard = Math.max(
    0,
    ...d.parts.map((part) => (c.byName(part.material)?.content as MaterialContent)?.hardness ?? 0),
  );
  const ticks = Math.round(16 + 6 * hard);
  if (sim.props.growth(p, sim.tick) < 1) {
    const seed = c.links(entry.id, "grows_into", true)
      .map(({ entry: e }) => c.current(e))
      .find((e) => e?.kind === "material");
    return {
      items: seed ? [[seed.name, 1]] : [],
      verb: "dug up",
      ticks: 16,
      anim: Anim.Plant,
    };
  }
  const solid = sim.props.info(p)?.solid ?? false;
  const stone = d.parts.some((part) =>
    (c.byName(part.material)?.content as MaterialContent)?.pattern === "stone"
  );
  return {
    items: sim.drops(entry),
    verb: stone ? "broke" : solid ? "chopped down" : "picked",
    ticks,
    anim: solid ? Anim.Build : Anim.Harvest,
  };
}

/** Walk up to an animal slowly, following it a few times if it wanders. False if it got away. */
function* approach(sim: Sim, agent: Agent, a: Animal): Generator<void, boolean> {
  agent.gentle = true;
  try {
    for (let tries = 0; tries < 4; tries++) {
      if (Math.hypot(a.x - agent.x, a.z - agent.z) <= ANIMAL_REACH) return true;
      try {
        yield* reach(sim, agent, Math.floor(a.x), Math.floor(a.z));
      } catch {
        return false;
      }
    }
    return Math.hypot(a.x - agent.x, a.z - agent.z) <= ANIMAL_REACH;
  } finally {
    agent.gentle = false;
  }
}

interface Recipe {
  output: string;
  input: string;
  count: number;
}

/**
 * The recipe for `item`: its made_from Relations, the one whose ingredient you hold (or the one
 * `from` names). Both ends follow replaced_by: a replaced output makes its replacement, and a
 * replaced ingredient is used under its new name.
 */
function pickRecipe(sim: Sim, agent: Agent, item: unknown, from: unknown): Recipe {
  const c = sim.catalog;
  const want = String(item ?? "").trim().toLowerCase().replace(/_/g, " ");
  if (!want) throw new Error('Say what to craft, e.g. item: "planks".');
  const e = c.byName(want);
  const craftable = craftableNow(sim, agent);
  const hint = craftable.length
    ? ` With what you carry you can craft: ${craftable.join(", ")}.`
    : " Nothing you carry is an ingredient yet (logs, stone and clay are).";
  if (!e || e.kind !== "material") {
    throw new Error(`"${want}" isn't a Material in the Catalog.${hint}`);
  }
  const output = c.current(e);
  if (!output) throw new Error(`"${e.name}" is retired, so nobody crafts it now.${hint}`);
  const recipes = recipesFor(sim, e);
  if (!recipes.length) {
    throw new Error(
      `Nothing makes ${e.name}: it has no made_from Relation.${hint} Recipes: catalog_find ` +
        "property type=made_from.",
    );
  }
  const fromName = from === undefined ? null : String(from).trim().toLowerCase();
  const pick = fromName
    ? recipes.find((r) => r.input.toLowerCase() === fromName)
    : recipes.find((r) => (agent.inventory[r.input] ?? 0) > 0) ?? recipes[0];
  if (!pick) {
    throw new Error(
      `${e.name} isn't made from ${fromName}; it's made from ${
        recipes.map((r) => r.input).join(" or ")
      }.`,
    );
  }
  if (!agent.inventory[pick.input]) {
    throw new Error(
      `You need ${pick.input} to craft ${output.name} (${pick.count} from each).${hint}`,
    );
  }
  return { ...pick, output: output.name };
}

/** made_from recipes of Material `e`, ingredients under their current names. */
function recipesFor(sim: Sim, e: Entry): Recipe[] {
  const c = sim.catalog;
  const out: Recipe[] = [];
  for (const { entry, rel } of c.links(e.id, "made_from")) {
    const input = c.current(entry);
    if (input) out.push({ output: e.name, input: input.name, count: rel.count });
  }
  return out;
}

/** "planks (from log)" for every recipe whose ingredient the villager holds. */
function craftableNow(sim: Sim, agent: Agent): string[] {
  const c = sim.catalog, out: string[] = [];
  for (const [item, n] of Object.entries(agent.inventory)) {
    const e = n > 0 ? c.byName(item) : undefined;
    if (!e) continue;
    for (const { entry } of c.links(e.id, "made_from", true)) {
      const made = c.current(entry);
      if (made) out.push(`${made.name} (from ${item})`);
    }
  }
  return out;
}
