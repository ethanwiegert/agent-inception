import type { Vec3 } from "./catalog.ts";
import { type Handler, num, reach, work } from "./jobs.ts";
import type { WorldObject } from "./objects.ts";
import { type Assembly, type JointDef, type JointState, quatMatrix } from "./physics.ts";
import { saysWords } from "./rules.ts";
import { Anim, type Sim, TICK_HZ } from "./sim.ts";
import type { ToolDef } from "./tools.ts";

/**
 * Working joints (physics phase 3): `use` switches a motor on or off, swings a hinge with limits
 * (a door, a gate, a drawbridge) to its other limit, or slides a slider to its other end. What
 * happens on the way is physics: a door stops at whatever is in its way, and a closed one is a
 * wall that paths go around.
 */

const DEG = 180 / Math.PI;
/** How far from a joint's pin, or the piece it moves, a tile may be to use it. */
const NEAR = 2;
/** Seconds `use` waits for a hinge or slider to get where it's going. */
const SWING_SECONDS = 4;
/** Close enough to where it was going: radians for a hinge, blocks for a slider. */
const THERE = { hinge: 3 / DEG, slider: 0.03 };

const int = (description: string) => ({ type: "integer", description });

export const JOINT_TOOL_DEFS: ToolDef[] = [
  {
    name: "use",
    description: "Work a mechanism: switch a motor on or off (all of that Object's motors), " +
      "swing a door, gate or lid on its hinge to its other limit (open, or shut again), or " +
      "slide a slider to its other end. You walk within reach first. look lists the " +
      "Mechanisms near you. A Design gets joints from hinge, axle, slider and motor parts; " +
      "closed doors are walls until someone opens them.",
    inputSchema: {
      type: "object",
      properties: {
        x: int("A tile at or beside the joint, or the piece it moves."),
        z: int("A tile at or beside the joint, or the piece it moves."),
        piece: {
          type: "string",
          description: "Which piece to work, when one Object has several (its name in the " +
            'Design: "door", "left gate").',
        },
      },
      required: ["x", "z"],
    },
  },
];

const nameOf = (sim: Sim, o: WorldObject) => sim.catalog.get(o.design)?.name ?? "Object";

/** Whether `use` does anything with a joint: motors switch, limited hinges and sliders swing. */
const usable = (j: JointDef) => j.kind === "motor" || !!j.limits;

/** Where a joint's pin is in the world (as the piece that carries it has it). */
export function pinAt(o: WorldObject, j: JointDef): Vec3 {
  const at = j.a ? o.pieces?.[j.a - 1] ?? o : o;
  const R = quatMatrix(at.rot, new Float64Array(9)), p = j.anchor;
  return [0, 1, 2].map((k) =>
    at.pos[k] + R[k * 3] * p[0] + R[k * 3 + 1] * p[1] + R[k * 3 + 2] * p[2]
  ) as Vec3;
}

/** Where the piece a joint moves has its center of mass now. */
function pieceAt(o: WorldObject, asm: Assembly, k: number): Vec3 {
  const at = k ? o.pieces?.[k - 1] ?? o : o;
  const R = quatMatrix(at.rot, new Float64Array(9)), c = asm.shapes[k].com;
  return [0, 1, 2].map((i) =>
    at.pos[i] + R[i * 3] * c[0] + R[i * 3 + 1] * c[1] + R[i * 3 + 2] * c[2]
  ) as Vec3;
}

/**
 * How far a joint's moving piece reaches from its pin: across the axis it turns about, or for a
 * slider, all round plus its travel (blocks).
 */
function sweep(asm: Assembly, j: JointDef): number {
  const s = asm.shapes[j.b], a = j.anchor, c = s.com, u = j.axis, slide = j.kind === "slider";
  const across = (x: number, y: number, z: number) => {
    const dx = c[0] + x - a[0], dy = c[1] + y - a[1], dz = c[2] + z - a[2];
    const along = slide ? 0 : dx * u[0] + dy * u[1] + dz * u[2];
    return Math.hypot(dx - along * u[0], dy - along * u[1], dz - along * u[2]);
  };
  let r = 0.3;
  for (let i = 0; i < s.points.length; i += 3) {
    r = Math.max(r, across(s.points[i], s.points[i + 1], s.points[i + 2]));
  }
  for (const p of s.parts) if (p.r) r = Math.max(r, across(p.c[0], p.c[1], p.c[2]) + p.r);
  return r + (slide ? Math.max(-j.limits![0], j.limits![1]) : 0);
}

interface Found {
  o: WorldObject;
  asm: Assembly;
  /** The joint's index in its Design. */
  i: number;
  j: JointDef;
  pin: Vec3;
  d: number;
}

/** The joints of every Object near tile (x, z) (optionally of one piece), nearest first. */
function jointsNear(sim: Sim, x: number, z: number, piece: string | null, within: number) {
  const out: Found[] = [];
  for (const o of sim.objects.list) {
    if (o.held) continue;
    const asm = sim.physics.assembly(o.design);
    if (!asm?.joints.length) continue;
    asm.joints.forEach((j, i) => {
      if (piece && j.piece !== piece && !saysWords(j.piece, piece)) return;
      const pin = pinAt(o, j), c = pieceAt(o, asm, j.b);
      const d = Math.min(
        Math.hypot(pin[0] - x - 0.5, pin[2] - z - 0.5),
        Math.hypot(c[0] - x - 0.5, c[2] - z - 0.5),
      );
      if (d <= within) out.push({ o, asm, i, j, pin, d });
    });
  }
  return out.sort((a, b) => +usable(b.j) - +usable(a.j) || a.d - b.d);
}

/** How a joint stands now, in a few words: "gate shut", "sails on a motor, turning". */
export function jointText(o: WorldObject, j: JointDef, i: number): string {
  const st = o.joints?.[i] ?? {}, at = st.at ?? 0;
  switch (j.kind) {
    case "motor":
      return `${j.piece} on a motor, ${
        st.on ? `on (${Math.abs(Math.round(j.speed * DEG))}°/s)` : "off"
      }`;
    case "axle":
      return `${j.piece} spins on an axle`;
    case "slider":
      return Math.abs(at) < THERE.slider * 2
        ? `${j.piece} in (slides ${j.limits![0]}-${j.limits![1]})`
        : `${j.piece} slid ${at.toFixed(2)} blocks`;
    default:
      if (!j.limits) return `${j.piece} swings free on a hinge`;
      return Math.abs(at) < THERE.hinge * 2
        ? `${j.piece} shut`
        : `${j.piece} open ${Math.round(Math.abs(at * DEG))}°`;
  }
}

/** Mechanisms near a villager for `look`: what each joint does now and where to use it. */
export function mechanismsText(sim: Sim, ax: number, az: number, r: number): string[] {
  const seen = new Map<WorldObject, Found[]>();
  for (const f of jointsNear(sim, Math.floor(ax), Math.floor(az), null, r)) {
    seen.set(f.o, [...(seen.get(f.o) ?? []), f]);
  }
  const lines: string[] = [];
  const list = [...seen].sort((a, b) => a[1][0].d - b[1][0].d);
  for (const [o, joints] of list.slice(0, 8)) {
    joints.sort((a, b) => a.i - b.i);
    const spins = joints.filter((f) => f.j.kind === "axle");
    const parts = joints.filter((f) => f.j.kind !== "axle").map((f) => jointText(o, f.j, f.i));
    if (spins.length) {
      parts.push(
        spins.length === 1
          ? jointText(o, spins[0].j, spins[0].i)
          : `${spins.length} pieces spin on axles`,
      );
    }
    const use = joints.find((f) => usable(f.j));
    const where = use ? ` — use x=${Math.floor(use.pin[0])} z=${Math.floor(use.pin[2])}` : "";
    const c = sim.physics.center(o);
    lines.push(
      `  ${nameOf(sim, o)} at x=${Math.floor(c[0])} z=${Math.floor(c[2])}: ${
        parts.join(", ")
      }${where}`,
    );
  }
  if (list.length > 8) lines.push(`  …and ${list.length - 8} more`);
  return lines;
}

export const JOINT_HANDLERS: Record<string, Handler> = {
  use(sim, agent, args) {
    const x = num(args.x, "x"), z = num(args.z, "z");
    let piece: string | null = null;
    if (args.piece !== undefined && args.piece !== null) {
      if (typeof args.piece !== "string" || !args.piece.trim() || args.piece.length > 24) {
        throw new Error('piece is the name of a piece in the Design, like "door".');
      }
      piece = args.piece.trim().toLowerCase().replace(/\s+/g, " ");
    }
    if (sim.world.heightAt(x, z) < 0) throw new Error(`(${x}, ${z}) is outside the world.`);
    if (sim.carried(agent)) throw new Error("Your hands are full: put_down what you carry first.");
    const found = jointsNear(sim, x, z, piece, NEAR + 0.5)[0];
    if (!found) {
      const any = jointsNear(sim, x, z, piece, 16)[0];
      const what = piece ? `no piece "${piece}" on a joint` : "nothing to use";
      throw new Error(
        any
          ? `There's ${what} at (${x}, ${z}). The nearest is the ${
            nameOf(sim, any.o)
          }'s ${any.j.piece} at x=${Math.floor(any.pin[0])} z=${Math.floor(any.pin[2])}.`
          : `There's ${what} at (${x}, ${z}). use works Objects whose Design has hinge, slider ` +
            "or motor parts: doors, gates, windmills.",
      );
    }
    const { o, asm, i, j } = found, name = nameOf(sim, o);
    if (!usable(j)) {
      throw new Error(
        j.kind === "axle"
          ? `The ${name}'s ${j.piece} spins freely on its axle; there's nothing to switch. push ` +
            `the ${name} to roll it.`
          : `The ${name}'s ${j.piece} swings freely on its hinge: it has no limits to swing ` +
            "between. A hinge with limits (a door) can be used.",
      );
    }
    return (function* () {
      // Stand clear of where it swings, if anywhere within reach is.
      const pin = pinAt(o, j), clear = sweep(asm, j) + 0.35;
      const inSwing = (px: number, pz: number) => Math.hypot(px - pin[0], pz - pin[2]) < clear;
      yield* reach(
        sim,
        agent,
        Math.floor(pin[0]),
        Math.floor(pin[2]),
        Math.floor(pin[1]),
        (cx, cz) => inSwing(cx + 0.5, cz + 0.5),
      );
      yield* work(agent, Anim.Build, 6);
      if (!sim.objects.get(o.id)) throw new Error(`The ${name} is gone.`);
      if (o.held) throw new Error(`Someone picked up the ${name}.`);
      const st = (o.joints ??= asm.joints.map((): JointState => ({})))[i];
      const fire = () => {
        const p = pinAt(o, j);
        sim.fire(
          "used",
          agent,
          Math.floor(p[0]),
          Math.floor(p[1]),
          Math.floor(p[2]),
          `${name} ${j.piece}`,
        );
      };
      o.mover = agent.name;
      if (j.kind === "motor") {
        const on = !st.on;
        let n = 0;
        asm.joints.forEach((m, k) => {
          if (m.kind === "motor") o.joints![k].on = on, n++;
        });
        sim.physics.wake(o);
        fire();
        const s = Math.abs(Math.round(j.speed * DEG));
        return `You switch the ${name}'s motor${n > 1 ? "s" : ""} ${
          on ? "on" : "off"
        }: its ${j.piece} ${on ? `turn at ${s}°/s` : "coast to a stop"}.`;
      }
      const [lo, hi] = j.limits!, was = st.target ?? 0;
      const to = Math.abs(was - hi) < Math.abs(was - lo) ? lo : hi;
      st.target = to;
      sim.physics.wake(o);
      const there = THERE[j.kind === "slider" ? "slider" : "hinge"];
      for (let t = 0; t < SWING_SECONDS * TICK_HZ; t++) {
        if (t > 1 && Math.abs((st.at ?? 0) - to) < there) break;
        yield;
      }
      fire();
      const at = st.at ?? 0, slider = j.kind === "slider";
      const show = (v: number) => slider ? `${v.toFixed(2)} blocks` : `${Math.round(v * DEG)}°`;
      if (Math.abs(at - to) >= there) {
        const who = sim.agents.find((a) => inSwing(a.x, a.z));
        const why = who === agent
          ? "you're standing in its way"
          : who
          ? `${who.name} is in its way`
          : `something is in the way, or it's too heavy for its ${j.kind}`;
        return `The ${name}'s ${j.piece} stuck at ${show(at)} on its way to ${show(to)}: ${why}. ` +
          "use again sends it back.";
      }
      if (Math.abs(to) < there) {
        return `You ${slider ? "slide" : "shut"} the ${name}'s ${j.piece} back as it was built.`;
      }
      return slider
        ? `You slide the ${name}'s ${j.piece} ${show(to)} along its rail.`
        : `You open the ${name}'s ${j.piece}: it swung ${show(Math.abs(to))} on its hinge.`;
    })();
  },
};
