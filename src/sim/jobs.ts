import { findPath, levelAt, octile } from "./path.ts";
import { type Agent, Anim, type Job, type Sim, TICK_HZ } from "./sim.ts";

/** Building blocks for tool handlers: walking, reaching, working and the inventory. */

const WALK_SPEED = 2.2 / TICK_HZ; // blocks per tick: an unhurried stroll

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
  const ax = Math.floor(agent.x), az = Math.floor(agent.z);
  const floor = levelAt(sim.world, ax, az, agent.y);
  const path = findPath(sim.world, ax, az, floor, goal, heuristic);
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

/** How far above or below their feet a farmer can place or dig a block. */
export const MAX_REACH = 3;

/** Stand next to (x, z), facing it. */
export function* reach(
  sim: Sim,
  agent: Agent,
  x: number,
  z: number,
  y?: number,
): Generator<void, void> {
  if (sim.world.heightAt(x, z) < 0) throw new Error(`(${x}, ${z}) is outside the world.`);
  const h = sim.world.heightAt(x, z);
  // Next to the column: within 2 of its top, or (for a given block height) within arm's reach.
  const near = (cx: number, cz: number) =>
    Math.max(Math.abs(cx - x), Math.abs(cz - z)) === 1 &&
    (y === undefined
      ? Math.abs(sim.world.heightAt(cx, cz) - h) <= 2
      : Math.abs(sim.world.heightAt(cx, cz) + 1 - y) <= MAX_REACH);
  if (!near(Math.floor(agent.x), Math.floor(agent.z))) {
    yield* walk(sim, agent, near, octile(x, z), `(${x}, ${z})`);
  }
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
