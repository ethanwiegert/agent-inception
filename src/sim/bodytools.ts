import { type Handler, num, reach, walk, work } from "./jobs.ts";
import type { WorldObject } from "./objects.ts";
import { octile } from "./path.ts";
import { lean, quatConj, quatMul, yawQuat } from "./physics.ts";
import { COMPASS } from "./rules.ts";
import { type Agent, Anim, type Sim, TICK_HZ } from "./sim.ts";
import type { ToolDef } from "./tools.ts";

/**
 * Moving things by hand (physics phase 2): `push` shoves an Object along by walking behind it,
 * `carry` lifts a light one overhead and `put_down` sets it down anywhere, at any angle. What
 * happens after is physics: a pushed ball rolls on, a pushed post topples, a dropped crate falls.
 */

/** Heaviest Object a villager lifts overhead, in tonnes. */
export const CARRY_MAX = 0.3;
/** How hard a villager pushes (tonne · blocks/s²): a crate slides up to about 1.7 t on grass. */
export const PUSH_FORCE = 10;
/** Too heavy to even try pushing, in tonnes. */
export const PUSH_MAX = 8;
/** Blocks per second a villager walks behind what they push. */
const PUSH_SPEED = 1.2;
const MAX_TILES = 8;

const int = (description: string) => ({ type: "integer", description });
const kg = (t: number) =>
  t >= 1 ? `${(Math.round(t * 10) / 10)} t` : `${Math.round(t * 100) * 10} kg`;

export const BODY_TOOL_DEFS: ToolDef[] = [
  {
    name: "push",
    description: "Shove an Object (anything built from parts that isn't anchored) along the " +
      "ground: you walk behind it and push it the number of tiles you ask. Heavier things go " +
      "slower and one too heavy won't budge; round things roll on after you stop, tall things " +
      "topple. Things fall off edges and float or sink in water by what they're made of.",
    inputSchema: {
      type: "object",
      properties: {
        x: int("A tile the Object is on."),
        z: int("A tile the Object is on."),
        toward: {
          type: "string",
          description: "Which way: north (-z), south (+z), east (+x), west (-x), or between " +
            "(northeast…).",
        },
        tiles: {
          ...int(`How far to push it, 1-${MAX_TILES}. Default 1.`),
          minimum: 1,
          maximum: MAX_TILES,
        },
      },
      required: ["x", "z", "toward"],
    },
  },
  {
    name: "carry",
    description: `Lift an Object up to ${kg(CARRY_MAX)} (look says what things weigh) over ` +
      "your head. You walk a little slower while carrying it; anything stacked on it falls off. " +
      "Then walk_to where it should go and put_down.",
    inputSchema: {
      type: "object",
      properties: { x: int("A tile the Object is on."), z: int("A tile the Object is on.") },
      required: ["x", "z"],
    },
  },
  {
    name: "put_down",
    description: "Set down what you carry on a tile beside you (you walk there first): on the " +
      "ground or on top of whatever is there, turned any number of degrees. It settles, " +
      "topples or rolls from there.",
    inputSchema: {
      type: "object",
      properties: {
        x: int("Tile x to set it on."),
        z: int("Tile z to set it on."),
        turn: {
          type: "number",
          description: "Degrees clockwise seen from above (east toward south), any angle. " +
            "Default: as you hold it.",
        },
      },
      required: ["x", "z"],
    },
  },
];

const nameOf = (sim: Sim, o: WorldObject) => sim.catalog.get(o.design)?.name ?? "Object";

/** The movable Object on tile (x, z) (the top one of a stack), or why there's none. */
function movable(sim: Sim, x: number, z: number): WorldObject {
  if (sim.world.heightAt(x, z) < 0) throw new Error(`(${x}, ${z}) is outside the world.`);
  const here = sim.objects.allAt(x, z);
  for (const o of sim.objects.list) {
    if (here.includes(o) || o.held) continue;
    const c = sim.physics.center(o);
    if (Math.floor(c[0]) === x && Math.floor(c[2]) === z) here.push(o);
  }
  if (!here.length) {
    const near = sim.objects.list
      .filter((o) => !o.held)
      .map((o) => ({ o, c: sim.physics.center(o) }))
      .sort((a, b) => Math.hypot(a.c[0] - x, a.c[2] - z) - Math.hypot(b.c[0] - x, b.c[2] - z))[0];
    const hint = near && Math.hypot(near.c[0] - x, near.c[2] - z) < 12
      ? ` The nearest Object is the ${nameOf(sim, near.o)} at x=${Math.floor(near.c[0])} z=${
        Math.floor(near.c[2])
      }.`
      : " Build one from a Design with parts (build), or look for Objects on the map.";
    throw new Error(`There's no Object at (${x}, ${z}).${hint}`);
  }
  for (const o of here) {
    const s = sim.physics.shape(o.design);
    if (s && !s.fixed) return o;
  }
  const o = here[0], d = sim.objects.design(o);
  throw new Error(
    d?.blocks
      ? `The ${nameOf(sim, o)} is built into its blocks; it doesn't move.`
      : `The ${nameOf(sim, o)} is anchored (its Design says so); it doesn't move.`,
  );
}

const heldBy = (sim: Sim, o: WorldObject) => sim.agents.find((a) => a.id === o.held)?.name;

export const BODY_HANDLERS: Record<string, Handler> = {
  push(sim, agent, args) {
    const x = num(args.x, "x"), z = num(args.z, "z");
    const toward = String(args.toward ?? "").trim().toLowerCase().replace(/[\s_-]/g, "");
    const dir = COMPASS[toward];
    if (!dir) throw new Error("toward is a direction: north, south, east, west, northeast…");
    const tiles = Math.min(MAX_TILES, Math.max(1, num(args.tiles ?? 1, "tiles")));
    if (sim.carried(agent)) throw new Error("Your hands are full: put_down what you carry first.");
    const o = movable(sim, x, z);
    const name = nameOf(sim, o), shape = sim.physics.shape(o.design)!;
    if (shape.mass > PUSH_MAX) {
      throw new Error(
        `The ${name} weighs about ${kg(shape.mass)}, far too heavy to push (a villager shoves up ` +
          "to about 1.5 t, more if it rolls).",
      );
    }
    const [dx, dz] = dir;
    return (function* () {
      // Get behind it, on the side away from where it should go.
      const c0 = sim.physics.center(o);
      const back = sim.physics.reach(o, -dx, -dz);
      const bx = c0[0] - dx * (back + 0.6), bz = c0[2] - dz * (back + 0.6);
      const behind = (cx: number, cz: number) => {
        const ex = cx + 0.5 - c0[0], ez = cz + 0.5 - c0[2];
        return ex * dx + ez * dz < -back * 0.5 && Math.hypot(cx + 0.5 - bx, cz + 0.5 - bz) < 1.3;
      };
      const ax = Math.floor(agent.x), az = Math.floor(agent.z);
      if (!behind(ax, az)) {
        try {
          yield* walk(sim, agent, behind, octile(Math.floor(bx), Math.floor(bz)), "behind it");
        } catch {
          throw new Error(
            `You can't get behind the ${name} to push it ${toward}: the ground there is too steep ` +
              "or something is in the way.",
          );
        }
      }
      // Lean in and walk it along.
      agent.pushing = o.id;
      o.mover = agent.name;
      const start = sim.physics.center(o);
      const leaned = lean(o.rot);
      let best = 0, stall = 0, why = "";
      const limit = Math.ceil((tiles / PUSH_SPEED + 4) * TICK_HZ);
      agent.anim = Anim.Walk;
      try {
        for (let t = 0; t < limit; t++) {
          if (!sim.objects.get(o.id) || o.held) {
            why = "someone else took it";
            break;
          }
          const c = sim.physics.center(o);
          const moved = (c[0] - start[0]) * dx + (c[2] - start[2]) * dz;
          if (moved >= tiles - 0.05) break;
          if (moved > best + 0.02) best = moved, stall = 0;
          else if (++stall > TICK_HZ * 1.5) {
            why = best < 0.1
              ? shape.mass > 1
                ? "it won't budge, it's too heavy"
                : "it won't budge, something holds it"
              : "it stuck fast";
            break;
          }
          // Keep at its back, at walking pace, where the ground allows.
          const ext = sim.physics.reach(o, -dx, -dz);
          const tx = c[0] - dx * (ext + 0.32), tz = c[2] - dz * (ext + 0.32);
          const ex = tx - agent.x, ez = tz - agent.z, d = Math.hypot(ex, ez);
          const stepLen = Math.min(d, (PUSH_SPEED * 1.4) / TICK_HZ);
          if (d > 1e-3) {
            const nx = agent.x + (ex / d) * stepLen, nz = agent.z + (ez / d) * stepLen;
            if (standable(sim, agent, nx, nz)) {
              agent.x = nx, agent.z = nz, agent.stride += stepLen;
            }
          }
          if (Math.hypot(agent.x - tx, agent.z - tz) > 1.2) {
            why = "you couldn't keep up with it";
            break;
          }
          agent.yaw = Math.atan2(dx, dz);
          // Push toward walking pace, as hard as a villager can.
          const along = o.vel[0] * dx + o.vel[2] * dz;
          const f = Math.min(PUSH_FORCE, Math.max(0, shape.mass * (PUSH_SPEED - along) * TICK_HZ));
          if (f > 0) {
            // At its middle, or chest height if that's lower: tall, narrow things topple.
            const py = Math.min(agent.y + 1.1, c[1]);
            sim.physics.applyForce(o, c[0] - dx * ext, py, c[2] - dz * ext, dx * f, 0, dz * f);
          }
          yield;
        }
      } finally {
        delete agent.pushing;
        agent.anim = Anim.Idle;
      }
      const c = sim.physics.center(o);
      const moved = Math.max(0, (c[0] - start[0]) * dx + (c[2] - start[2]) * dz);
      sim.fire("pushed", agent, Math.floor(c[0]), Math.floor(c[1]), Math.floor(c[2]), name);
      let text = moved < 0.1
        ? `The ${name} didn't move`
        : `You pushed the ${name} ${moved.toFixed(1)} tiles ${toward}`;
      if (why) text += ` (${why})`;
      const after: string[] = [];
      if (Math.hypot(o.vel[0], o.vel[2]) > 0.6) after.push("it rolls on");
      else if (lean(o.rot) > leaned + 0.6) after.push("it toppled over");
      if (after.length) text += `; ${after.join(", ")}`;
      return `${text}. It's at x=${Math.floor(c[0])} z=${Math.floor(c[2])} and weighs about ${
        kg(shape.mass)
      }.`;
    })();
  },

  carry(sim, agent, args) {
    const x = num(args.x, "x"), z = num(args.z, "z");
    const have = sim.carried(agent);
    if (have) {
      throw new Error(`Your hands are full with the ${nameOf(sim, have)}: put_down it first.`);
    }
    const o = movable(sim, x, z);
    const name = nameOf(sim, o), shape = sim.physics.shape(o.design)!;
    if (shape.mass > CARRY_MAX) {
      throw new Error(
        `The ${name} weighs about ${kg(shape.mass)}; you can lift up to ${kg(CARRY_MAX)}. ` +
          "push moves heavier things.",
      );
    }
    return (function* () {
      yield* reach(sim, agent, x, z);
      yield* work(agent, Anim.Build, 10);
      const c = sim.physics.center(o);
      if (!sim.objects.get(o.id)) throw new Error(`The ${name} is gone.`);
      if (o.held) throw new Error(`${heldBy(sim, o) ?? "Someone"} picked up the ${name} first.`);
      if (Math.hypot(c[0] - agent.x, c[2] - agent.z) > 3.5 || Math.abs(c[1] - agent.y) > 3.5) {
        throw new Error(
          `The ${name} moved out of reach (it's at x=${Math.floor(c[0])} z=${Math.floor(c[2])}).`,
        );
      }
      // Whatever rested on it is left in the air: it falls.
      sim.physics.wakeNear(sim.objects.list, c[0], c[1], c[2], 1);
      o.held = agent.id;
      o.heldTurn = quatMul(quatConj(yawQuat(agent.yaw)), o.rot);
      o.mover = agent.name;
      o.asleep = false;
      sim.objects.raster(o);
      sim.objects.version++;
      sim.fire("carried", agent, Math.floor(c[0]), Math.floor(c[1]), Math.floor(c[2]), name);
      return `You lift the ${name} (about ${kg(shape.mass)}) over your head. walk_to where it ` +
        "should go, then put_down.";
    })();
  },

  put_down(sim, agent, args) {
    const x = num(args.x, "x"), z = num(args.z, "z");
    const o = sim.carried(agent);
    if (!o) throw new Error("You aren't carrying anything (carry lifts an Object).");
    let turn: number | undefined;
    if (args.turn !== undefined && args.turn !== null) {
      turn = Number(args.turn);
      if (!Number.isFinite(turn)) throw new Error("turn is a number of degrees.");
    }
    const w = sim.world, name = nameOf(sim, o);
    if (w.heightAt(x, z) < 0) throw new Error(`(${x}, ${z}) is outside the world.`);
    if (w.propSolid[z * w.sizeX + x]) throw new Error(`A tree or rock stands at (${x}, ${z}).`);
    const other = sim.agents.find((a) =>
      a !== agent && Math.floor(a.x) === x && Math.floor(a.z) === z
    );
    if (other) throw new Error(`${other.name} is standing at (${x}, ${z}).`);
    return (function* () {
      yield* reach(sim, agent, x, z);
      if (sim.carried(agent) !== o) throw new Error(`You dropped the ${name} on the way.`);
      yield* work(agent, Anim.Build, 10);
      if (sim.carried(agent) !== o) throw new Error(`You dropped the ${name} on the way.`);
      const rot = turn === undefined
        ? o.rot
        : quatMul(yawQuat(-turn * Math.PI / 180), o.heldTurn ?? [0, 0, 0, 1]);
      // Over the tile, its lowest point just above the ground or what's stacked there.
      const low = sim.physics.lowest(o.design, rot);
      const c = sim.physics.center({ ...o, pos: [0, 0, 0], rot });
      const span = Math.max(0.5, sim.physics.reach({ ...o, rot }, 1, 0));
      let top = -Infinity;
      for (let tz = Math.floor(z + 0.5 - span); tz <= Math.floor(z + 0.5 + span); tz++) {
        for (let tx = Math.floor(x + 0.5 - span); tx <= Math.floor(x + 0.5 + span); tx++) {
          top = Math.max(top, w.heightAt(tx, tz) + 1, sim.objects.topAt(tx, tz, o.id));
        }
      }
      if (top - agent.y > 3) {
        throw new Error(`(${x}, ${z}) is too high to reach (${Math.round(top - agent.y)} up).`);
      }
      o.rot = rot;
      o.pos = [x + 0.5 - c[0], top + 0.03 - low - c[1], z + 0.5 - c[2]];
      sim.release(agent, o);
      sim.posesVersion++;
      return `You set the ${name} down at x=${x} z=${z}.`;
    })();
  },
};

/** Whether `agent` can stand at (x, z) from where they are: the same tile, or one step away. */
function standable(sim: Sim, agent: Agent, x: number, z: number): boolean {
  const ax = Math.floor(agent.x), az = Math.floor(agent.z), tx = Math.floor(x), tz = Math.floor(z);
  if (ax === tx && az === tz) return true;
  const w = sim.world;
  const from = w.floorBelow(ax, az, Math.floor(agent.y + 0.5));
  if (from < 0 || w.blocked(tx, tz)) return false;
  const to = w.floorBelow(tx, tz, from + 1);
  return to >= 0 && from - to <= 2 && w.waterDepth(tx, tz, to) <= 1;
}
