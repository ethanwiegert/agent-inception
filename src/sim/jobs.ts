import { findPath, levelAt, MAX_HOP_DOWN, octile } from "./path.ts";
import { type Agent, Anim, type Job, type Sim, TICK_HZ } from "./sim.ts";

/** Building blocks for tool handlers: walking, reaching, working and the inventory. */

const WALK_SPEED = 2.2 / TICK_HZ; // blocks per tick: an unhurried stroll
/** Share of walking pace while carrying something overhead. */
const CARRY_PACE = 0.75;

export type Args = Record<string, unknown>;
export type Handler = (sim: Sim, agent: Agent, args: Args) => string | Job;

export const num = (v: unknown, name: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${name}" must be a number.`);
  return Math.floor(n);
};

export function* walk(
  sim: Sim,
  agent: Agent,
  goal: (x: number, z: number) => boolean,
  heuristic: (x: number, z: number) => number,
  label: string,
): Generator<void, void> {
  const path = route(sim, agent, goal, heuristic);
  if (!path) {
    throw new Error(
      `You can't find a way to ${label}: you climb 1 block and drop 2, and trees, rocks and tall ` +
        "Objects are in the way. A step (place_block, or terraform) gets you up a bigger rise.",
    );
  }
  agent.anim = Anim.Walk;
  for (let i = 0; i < path.length; i += 2) {
    const tx = path[i] + 0.5, tz = path[i + 1] + 0.5;
    for (;;) {
      const dx = tx - agent.x, dz = tz - agent.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-3) break;
      // Something heavy overhead slows you down.
      const s = Math.min(WALK_SPEED * (sim.carried(agent) ? CARRY_PACE : 1), d);
      agent.x += (dx / d) * s;
      agent.z += (dz / d) * s;
      agent.stride += s;
      agent.yaw = turn(agent.yaw, Math.atan2(dx, dz), 0.35);
      yield;
    }
  }
  agent.anim = Anim.Idle;
}

/**
 * A path for `agent` to a column `goal` accepts: by ordinary steps, or, when those can't get
 * there, hopping down drops of up to four blocks (off a roof, out of a tree house). A hop is only
 * taken when there's an ordinary way back, or when the villager is stranded where they stand:
 * never into a pit they couldn't climb out of.
 */
export function route(
  sim: Sim,
  agent: Agent,
  goal: (x: number, z: number) => boolean,
  heuristic: (x: number, z: number) => number,
): number[] | null {
  const w = sim.world;
  const ax = Math.floor(agent.x), az = Math.floor(agent.z);
  const floor = levelAt(w, ax, az, agent.y);
  const plain = findPath(w, ax, az, floor, goal, heuristic);
  if (plain) return plain;
  const hop = findPath(w, ax, az, floor, goal, heuristic, 8000, MAX_HOP_DOWN);
  if (!hop?.length) return hop;
  const stranded = !findPath(
    w,
    ax,
    az,
    floor,
    (x, z) => Math.max(Math.abs(x - ax), Math.abs(z - az)) >= STRANDED,
    () => 0,
    2000,
  );
  if (stranded) return hop;
  const gx = hop[hop.length - 2], gz = hop[hop.length - 1];
  const back = findPath(
    w,
    gx,
    gz,
    levelAt(w, gx, gz, w.heightAt(gx, gz) + 1),
    (x, z) => x === ax && z === az,
    octile(ax, az),
  );
  return back ? hop : null;
}

/** A villager who can't walk this far by ordinary steps is stranded (on a roof, in a pit). */
const STRANDED = 6;

/** How far above or below their feet a farmer can place or dig a block. */
export const MAX_REACH = 3;

/**
 * Stand next to (x, z), facing it, or failing that within arm's length (two tiles). `avoid` marks
 * columns not to stand on if any other will do (the bottom of a pit being dug, the top of a
 * building going up).
 */
export function* reach(
  sim: Sim,
  agent: Agent,
  x: number,
  z: number,
  y?: number,
  avoid?: (x: number, z: number) => boolean,
): Generator<void, void> {
  if (sim.world.heightAt(x, z) < 0) throw new Error(`(${x}, ${z}) is outside the world.`);
  const h = sim.world.heightAt(x, z);
  // Within 2 of the column's top, or (for a given block height) within arm's reach of it.
  const fits = (cx: number, cz: number) =>
    y === undefined
      ? Math.abs(sim.world.heightAt(cx, cz) - h) <= 2
      : Math.abs(sim.world.heightAt(cx, cz) + 1 - y) <= MAX_REACH;
  const within = (d: number, keepClear: boolean) => (cx: number, cz: number) =>
    Math.max(Math.abs(cx - x), Math.abs(cz - z)) === d && fits(cx, cz) &&
    !(keepClear && avoid?.(cx, cz));
  const options = avoid
    ? [within(1, true), within(2, true), within(1, false), within(2, false)]
    : [within(1, false), within(2, false)];
  const ax = Math.floor(agent.x), az = Math.floor(agent.z);
  for (const goal of options) {
    if (goal(ax, az) || (yield* tryWalk(sim, agent, goal, octile(x, z)))) {
      return yield* face(agent, x, z);
    }
  }
  // Nowhere to walk to (shut in, down a shaft): work from where you stand if it's within reach,
  // so a villager can always dig up or build a step out.
  const feet = Math.floor(agent.y + 0.5);
  if (
    y !== undefined && Math.max(Math.abs(ax - x), Math.abs(az - z)) <= 2 &&
    Math.abs(y - feet) <= MAX_REACH
  ) return yield* face(agent, x, z);
  throw new Error(`You can't find a way to (${x}, ${z}).`);
}

/** Walk to a column `goal` accepts if there's a way; false (without moving) if there isn't. */
function* tryWalk(
  sim: Sim,
  agent: Agent,
  goal: (x: number, z: number) => boolean,
  heuristic: (x: number, z: number) => number,
): Generator<void, boolean> {
  if (!route(sim, agent, goal, heuristic)) return false;
  yield* walk(sim, agent, goal, heuristic, "there");
  return true;
}

function* face(agent: Agent, x: number, z: number): Generator<void, void> {
  const target = Math.atan2(x + 0.5 - agent.x, z + 0.5 - agent.z);
  while (Math.abs(angleDiff(agent.yaw, target)) > 0.05) {
    agent.yaw = turn(agent.yaw, target, 0.3);
    yield;
  }
}

export function* work(agent: Agent, anim: number, ticks: number): Generator<void, void> {
  agent.anim = anim;
  for (let i = 0; i < ticks; i++) yield;
  agent.anim = Anim.Idle;
}

/** Why a solid prop stops work on a tile, or nothing. */
export function solidProp(sim: Sim, x: number, z: number): string | undefined {
  const p = sim.props.at(x, z);
  const info = p && sim.props.info(p);
  if (!p || !info?.solid) return undefined;
  const young = sim.props.growth(p, sim.tick) < 1 ? "young " : "";
  return `a ${young}${info.entry.name} is in the way`;
}

export const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
export const turn = (from: number, to: number, rate: number) => from + angleDiff(from, to) * rate;

export function give(agent: Agent, item: string, n: number) {
  agent.inventory[item] = (agent.inventory[item] ?? 0) + n;
}

export function inventoryText(agent: Agent): string {
  const items = Object.entries(agent.inventory).filter(([, n]) => n > 0);
  return `Inventory: ${items.length ? items.map(([k, n]) => `${k} ${n}`).join(", ") : "empty"}.`;
}

/** "06:30" for a time of day 0-1. */
export function clock(t: number): string {
  const m = Math.floor(t * 24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
