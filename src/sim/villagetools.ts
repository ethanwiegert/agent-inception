import { type DesignContent, type Entry, type PartContent, rigOf } from "./catalog.ts";
import { clock, type Handler, inventoryText, num, reach, work } from "./jobs.ts";
import type { WorldObject } from "./objects.ts";
import { quatMatrix } from "./physics.ts";
import { heldMaterial } from "./rules.ts";
import { type Agent, Anim, type Sim } from "./sim.ts";
import { TICK_HZ, TICKS_PER_DAY } from "./time.ts";
import type { ToolDef } from "./tools.ts";
import { NEEDS, pct, VILLAGE_LIMITS } from "./village.ts";
import { food } from "./worth.ts";

/**
 * Village Life for agents: `eat` what you carry, `sleep` at night (best in a bed), and the
 * world's `errands`. Needs only run down in Village Life; in a Sandbox eating and sleeping still
 * work but nothing asks for them.
 */

const HOUR = TICKS_PER_DAY / 24;
/** Bites one eat call takes at most, about a second each. */
const MAX_BITES = 8;
/** One sleep call lasts at most this long (2 game hours, 50 real seconds), then call again. */
const MAX_SLEEP = HOUR * 2;
/** How far sleep looks for a free bed. */
const BED_RANGE = 16;
/** Sleep from this hour of the evening until this hour of the morning. */
export const NIGHT: [number, number] = [19, 6];

export const VILLAGE_TOOL_DEFS: ToolDef[] = [
  {
    name: "eat",
    description: "Eat food you carry to fill your hunger (Village Life: a villager empties in " +
      "about a game day and walks and works slower under 25%). Wheat, berries, eggs, milk and " +
      "fish fill a little; bread baked at an oven fills most. A Material's food says how much " +
      "one fills (catalog_find property food). About a second a bite; stops when you're full.",
    inputSchema: {
      type: "object",
      properties: {
        item: { type: "string", description: "What to eat; default the best food you carry." },
        count: { type: "integer", description: `Bites, 1-${MAX_BITES}. Default 1.` },
      },
    },
  },
  {
    name: "sleep",
    description: `Sleep at night (${NIGHT[0]}:00 to 0${NIGHT[1]}:00) to rest. You walk to the ` +
      `nearest free bed within ${BED_RANGE} tiles (any Design with a mattress part, like ` +
      `nature's "bed") and rest fully in ${NEEDS.bedHours} game hours, or sleep on the ground ` +
      `and take ${NEEDS.groundHours}. One call sleeps up to 2 game hours (50 real seconds), ` +
      "until you're rested or morning comes; call again to sleep on.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "errands",
    description: "The world's errands (Village Life): small goals any villager may take or " +
      "ignore. Each pays village points (the village grows from camp to hamlet to village and " +
      "unlocks Parts and Materials) and a loaf of bread. action list (default) shows the board; " +
      `take an errand by id (at most ${VILLAGE_LIMITS.held} at once, a game day each); give hands ` +
      "over what a bring errand asks for; drop puts one back.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "take", "give", "drop"] },
        id: { type: "integer", description: "The errand's number, as the board lists it." },
      },
    },
  },
];

export const VILLAGE_HANDLERS: Record<string, Handler> = {
  eat(sim, agent, args) {
    const bites = args.count === undefined ? 1 : num(args.count, "count");
    if (bites < 1 || bites > MAX_BITES) throw new Error(`count is 1-${MAX_BITES} bites.`);
    if (agent.fed >= 0.99) throw new Error(`You're full (fed ${pct(agent.fed)}).`);
    const foods = heldFoods(sim, agent);
    let item: string;
    if (args.item === undefined) {
      if (!foods.length) throw new Error(`You carry nothing to eat. ${foodHint(sim)}`);
      // The one that fills you best without going to waste.
      const room = 1 - agent.fed;
      item = ([...foods].sort((a, b) => b[1] - a[1]).find(([, f]) => f <= room + 0.05) ??
        [...foods].sort((a, b) => a[1] - b[1])[0])[0];
    } else {
      const e = heldMaterial(sim.catalog, args.item, "item");
      if (!food(sim.catalog, e)) {
        throw new Error(
          `${e.name} isn't food.${
            foods.length ? ` You could eat: ${foods.map(([n]) => n).join(", ")}.` : ""
          } ${foodHint(sim)}`,
        );
      }
      if (!agent.inventory[e.name]) throw new Error(`You have no ${e.name}. ${foodHint(sim)}`);
      item = e.name;
    }
    const fills = food(sim.catalog, sim.catalog.byName(item)!);
    return (function* () {
      const before = agent.fed;
      let eaten = 0;
      for (let i = 0; i < bites && agent.fed < 0.99 && (agent.inventory[item] ?? 0) > 0; i++) {
        yield* work(agent, Anim.Eat, TICK_HZ);
        if (!agent.inventory[item]) break;
        agent.inventory[item]--;
        agent.fed = Math.min(1, agent.fed + fills);
        eaten++;
        const fx = Math.floor(agent.x), fz = Math.floor(agent.z);
        sim.fire("ate", agent, fx, sim.world.heightAt(fx, fz), fz, item);
      }
      const full = agent.fed >= 0.99 && eaten < bites ? " You're full." : "";
      return `You ate ${eaten} ${item}: fed ${pct(before)} → ${pct(agent.fed)}.${full}` +
        (sim.village.life ? "" : " (Sandbox: nobody gets hungry here.)") +
        ` ${inventoryText(agent)}`;
    })();
  },

  sleep(sim, agent) {
    const h = sim.timeOfDay() * 24;
    if (!night(h)) {
      throw new Error(
        `It's ${clock(sim.timeOfDay())}: villagers sleep at night, from ${NIGHT[0]}:00 to ` +
          `0${NIGHT[1]}:00. You're rested ${pct(agent.rested)}` +
          (agent.rested < NEEDS.low ? " and slow with it; nightfall puts that right." : "."),
      );
    }
    if (agent.rested >= 0.99) throw new Error(`You're wide awake (rested ${pct(agent.rested)}).`);
    if (sim.carried(agent)) throw new Error("Put down what you carry before you lie down.");
    return (function* () {
      let bed = freeBed(sim, agent);
      if (bed) {
        try {
          yield* reach(sim, agent, bed.tileX, bed.tileZ);
        } catch {
          bed = null;
        }
      }
      // Someone else may have lain down meanwhile.
      if (bed && sim.agents.some((a) => a !== agent && a.sleeping === bed!.o.id)) bed = null;
      const stood = { x: agent.x, y: agent.y, z: agent.z, yaw: agent.yaw };
      const start = sim.tick, from = agent.rested;
      const rate = 1 / ((bed ? NEEDS.bedHours : NEEDS.groundHours) * HOUR);
      agent.sleeping = bed ? bed.o.id : 0;
      agent.anim = Anim.Sleep;
      let woke = "";
      try {
        for (;;) {
          if (bed) {
            const at = bedPose(sim, bed.o, bed.part);
            if (!at) {
              woke = "your bed moved";
              break;
            }
            agent.x = at.x, agent.y = at.y, agent.z = at.z, agent.yaw = at.yaw;
          }
          if (agent.rested >= 1) break;
          if (!night(sim.timeOfDay() * 24)) {
            woke = "morning came";
            break;
          }
          if (sim.tick - start >= MAX_SLEEP) break;
          agent.rested = Math.min(1, agent.rested + rate);
          yield;
        }
      } finally {
        delete agent.sleeping;
        agent.anim = Anim.Idle;
        if (bed) Object.assign(agent, stood);
      }
      const slept = sim.tick - start;
      if (slept >= HOUR / 2) {
        const fx = Math.floor(agent.x), fz = Math.floor(agent.z);
        sim.fire("slept", agent, fx, sim.world.heightAt(fx, fz), fz, bed ? "bed" : "ground");
      }
      const where = bed
        ? `in the ${sim.catalog.get(bed.o.design)?.name ?? "bed"} at (${bed.tileX}, ${bed.tileZ})`
        : "on the ground";
      const more = agent.rested >= 1
        ? " You're fully rested."
        : woke
        ? ` You woke: ${woke}.`
        : " Call sleep again to sleep on.";
      const hint = bed ? "" : ' A bed (catalog_get "bed") rests you twice as fast.';
      return `You slept ${duration(slept)} ${where} and woke at ${clock(sim.timeOfDay())}: ` +
        `rested ${pct(from)} → ${pct(agent.rested)}.${more}${hint}`;
    })();
  },

  errands(sim, agent, args) {
    const v = sim.village;
    const action = String(args.action ?? "list").trim().toLowerCase();
    if (!["list", "take", "give", "drop"].includes(action)) {
      throw new Error('action is "list", "take", "give" or "drop".');
    }
    if (!v.life) {
      throw new Error(
        "The world is a Sandbox: no errands, no needs, everything unlocked. Do what you like.",
      );
    }
    if (action === "list") {
      const lines = v.errands.map((e) => `  ${v.line(e, agent)}`);
      return `Errands on the board. The village is ${v.levelText()}.\n` +
        (lines.length ? lines.join("\n") : "  none right now; new ones are posted every hour.") +
        '\nTake one with errands action "take" and its id.';
    }
    if (args.id === undefined) throw new Error(`Say which errand to ${action} (id).`);
    const id = num(args.id, "id");
    const e = v.errands.find((x) => x.id === id);
    if (!e) {
      throw new Error(
        `There's no errand #${id} on the board${
          v.errands.length ? ` (open: #${v.errands.map((x) => x.id).join(", #")})` : ""
        }.`,
      );
    }
    if (action === "take") return v.take(agent, e);
    if (action === "drop") return v.drop(agent, e);
    return v.give(agent, e) + ` ${inventoryText(agent)}`;
  },
};

// ---------------------------------------------------------------- helpers

function night(h: number): boolean {
  return h >= NIGHT[0] || h < NIGHT[1];
}

function duration(ticks: number): string {
  const m = Math.round((ticks / TICKS_PER_DAY) * 24 * 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/** Foods the villager carries, with how much one fills. */
function heldFoods(sim: Sim, agent: Agent): [string, number][] {
  const out: [string, number][] = [];
  for (const [item, n] of Object.entries(agent.inventory)) {
    const e = n > 0 ? sim.catalog.byName(item) : undefined;
    const f = e ? food(sim.catalog, e) : 0;
    if (f > 0) out.push([item, f]);
  }
  return out;
}

function foodHint(sim: Sim): string {
  const foods = sim.catalog.entries.filter((e) => !e.retired && food(sim.catalog, e) > 0)
    .sort((a, b) => food(sim.catalog, b) - food(sim.catalog, a)).slice(0, 8)
    .map((e) => `${e.name} ${pct(food(sim.catalog, e))}`);
  return `Food: ${foods.join(", ")} (harvest wheat, pick berries, collect eggs, milk, fish; bake ` +
    "bread at an oven).";
}

/** The mattress part of a bed Object's Design, or -1 if it has none. */
function mattressOf(sim: Sim, o: WorldObject): number {
  const d = sim.catalog.get(o.design)?.content as DesignContent | undefined;
  return d?.parts.findIndex((p) =>
    (sim.catalog.byName(p.part)?.content as PartContent | undefined)?.furniture === "mattress"
  ) ?? -1;
}

/** Where a sleeper lies on a bed: on top of its mattress, along it; null if it's tipped over. */
function bedPose(sim: Sim, o: WorldObject, part: number) {
  if (!sim.objects.get(o.id) || o.held) return null;
  const d = sim.catalog.get(o.design)!.content as DesignContent;
  const p = d.parts[part], piece = rigOf(d).pieceOf[part];
  const at = piece ? o.pieces?.[piece - 1] ?? o : o;
  const R = quatMatrix(at.rot, new Float64Array(9));
  if (R[4] < 0.8) return null; // tipped over: nobody lies on that
  const [lx, ly, lz] = p.at;
  const top = ly + p.size[1] / 2;
  const x = at.pos[0] + R[0] * lx + R[1] * top + R[2] * lz;
  const y = at.pos[1] + R[3] * lx + R[4] * top + R[5] * lz;
  const z = at.pos[2] + R[6] * lx + R[7] * top + R[8] * lz;
  // Along the mattress's long side, feet away from where it starts (its headboard end).
  const t = (p.turn * Math.PI) / 180;
  const [ax, az] = p.size[2] >= p.size[0]
    ? [Math.sin(t), Math.cos(t)]
    : [Math.cos(t), -Math.sin(t)];
  const dx = R[0] * ax + R[2] * az, dz = R[6] * ax + R[8] * az;
  return { x, y, z, yaw: Math.atan2(dx, dz) };
}

/** The nearest bed within range nobody sleeps in, and a tile to walk to beside it. */
function freeBed(sim: Sim, agent: Agent) {
  let best: { o: WorldObject; part: number; tileX: number; tileZ: number; d: number } | null = null;
  for (const o of sim.objects.list) {
    const part = mattressOf(sim, o);
    if (part < 0 || sim.agents.some((a) => a !== agent && a.sleeping === o.id)) continue;
    const at = bedPose(sim, o, part);
    if (!at) continue;
    const d = Math.hypot(at.x - agent.x, at.z - agent.z);
    if (d > BED_RANGE || (best && best.d <= d)) continue;
    best = { o, part, tileX: Math.floor(at.x), tileZ: Math.floor(at.z), d };
  }
  return best;
}

/** Nearest Object of Design `design` (or what replaced it) within `range`, for a workbench. */
export function nearestOf(
  sim: Sim,
  design: Entry,
  x: number,
  z: number,
  range: number,
): { o: WorldObject; x: number; z: number; d: number } | null {
  const c = sim.catalog, want = c.current(design)?.id ?? design.id;
  let best: { o: WorldObject; x: number; z: number; d: number } | null = null;
  for (const o of sim.objects.list) {
    const e = c.get(o.design);
    if (!e || (c.current(e)?.id ?? e.id) !== want || o.held) continue;
    const ctr = sim.physics.center(o);
    const d = Math.hypot(ctr[0] - x, ctr[2] - z);
    if (d <= range && (!best || d < best.d)) {
      best = { o, x: Math.floor(ctr[0]), z: Math.floor(ctr[2]), d };
    }
  }
  return best;
}
