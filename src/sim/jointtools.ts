import {
  channelName,
  type DesignContent,
  type DeviceKind,
  deviceKind,
  hasChannel,
  rigOf,
  type Vec3,
} from "./catalog.ts";
import { face, type Handler, MAX_REACH, num, reach, work } from "./jobs.ts";
import type { WorldObject } from "./objects.ts";
import {
  type Assembly,
  GRAVITY,
  type JointDef,
  type JointState,
  poseBoxes,
  quatMatrix,
  SERVO_TORQUE,
} from "./physics.ts";
import { saysWords } from "./rules.ts";
import { channelOf, deviceOn, setDevice, SIGNAL_RANGE } from "./signals.ts";
import { type Agent, Anim, type Job, type Sim, TICK_HZ } from "./sim.ts";
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
      "swing a door, gate or lid on its hinge to its other limit (open, or shut again), slide " +
      "a slider to its other end, flip a lever (it sends on its signal channel), or switch a " +
      "lamp or flame (all of that Object's) on or off. With channel, tune the mechanism " +
      "instead: levers and pressure plates send on their channel, and lamps, flames, motors, " +
      `and hinges or sliders with limits follow it within ${SIGNAL_RANGE} tiles (on: shine, ` +
      'run, open; off: dark, stop, shut). channel "" takes it off any channel. You walk ' +
      "within reach first. look lists the Mechanisms near you. Closed doors are walls until " +
      "someone opens them.",
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
        channel: {
          type: "string",
          description: 'Tune it to this signal channel instead of working it ("north gate"; "" ' +
            "for none).",
        },
      },
      required: ["x", "z"],
    },
  },
];

const nameOf = (sim: Sim, o: WorldObject) => sim.catalog.get(o.design)?.name ?? "Object";
/** "the windmill's sails", or "the garden gate" when the piece is in the name already. */
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const whose = (name: string, piece: string) =>
  saysWords(name, piece) ? `the ${name}` : `the ${name}'s ${piece}`;

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

/**
 * How hard the moving piece's weight pulls against its joint now: torque about a hinge's axis, or
 * force along a slider (tonne · blocks² / s², or tonne · blocks / s²).
 */
function load(o: WorldObject, asm: Assembly, j: JointDef): number {
  const s = asm.shapes[j.b], at = j.b ? o.pieces?.[j.b - 1] ?? o : o;
  const R = quatMatrix(at.rot, new Float64Array(9)), u = j.axis, w = s.mass * GRAVITY;
  const ux = R[0] * u[0] + R[1] * u[1] + R[2] * u[2];
  const uy = R[3] * u[0] + R[4] * u[1] + R[5] * u[2];
  const uz = R[6] * u[0] + R[7] * u[1] + R[8] * u[2];
  if (j.kind === "slider") return Math.abs(uy) * w;
  // (com − pin) × (0, −w, 0), along the axis.
  const c = pieceAt(o, asm, j.b), p = pinAt(o, j);
  return Math.abs(((c[2] - p[2]) * ux - (c[0] - p[0]) * uz) * w);
}

/** Whether a villager standing at (x, y, z) is up against the piece a joint moves. */
function touching(sim: Sim, o: WorldObject, j: JointDef, x: number, y: number, z: number) {
  const d: DesignContent | null = sim.objects.design(o);
  if (!d) return false;
  const of = rigOf(d).pieceOf, r = 0.45;
  return poseBoxes(d, o.pos, o.rot, o.pieces).some((b, i) =>
    of[i] === j.b && x > b[0] - r && x < b[1] + r && z > b[4] - r && z < b[5] + r &&
    y < b[3] && y + 1.75 > b[2]
  );
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

interface DeviceFound {
  o: WorldObject;
  part: number;
  kind: DeviceKind;
  at: Vec3;
  d: number;
}

/** Lamps, flames, levers and plates of every Object near tile (x, z), nearest first. */
function devicesNear(sim: Sim, x: number, z: number, within: number): DeviceFound[] {
  const out: DeviceFound[] = [];
  for (const o of sim.objects.list) {
    const d = sim.objects.design(o);
    if (o.held || !d?.parts.some((p) => deviceKind(p.part))) continue;
    const boxes = poseBoxes(d, o.pos, o.rot, o.pieces);
    d.parts.forEach((p, i) => {
      const kind = deviceKind(p.part);
      if (!kind) return;
      const b = boxes[i];
      const at: Vec3 = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
      const dist = Math.hypot(at[0] - x - 0.5, at[2] - z - 0.5);
      if (dist <= within) out.push({ o, part: i, kind, at, d: dist });
    });
  }
  return out.sort((a, b) => a.d - b.d);
}

/** ' (channel "gate")' for a part on a channel. */
function onChannel(o: WorldObject, d: DesignContent | null, part: number): string {
  const c = d && channelOf(o, d, part);
  return c ? ` (channel "${c}")` : "";
}

/** How a device stands now: "lamp lit", "lever off", "plate pressed". */
export function deviceText(o: WorldObject, part: number, kind: DeviceKind): string {
  const on = deviceOn(o, part, kind);
  switch (kind) {
    case "lamp":
      return `lamp ${on ? "lit" : "dark"}`;
    case "flame":
      return `flame ${on ? "burning" : "out"}`;
    case "lever":
      return `lever ${on ? "on" : "off"}`;
    default:
      return `pressure plate ${on ? "pressed" : "up"}`;
  }
}

/** How a joint stands now, in a few words: "gate shut", "sails on a motor, on (45°/s)". */
export function jointText(o: WorldObject, j: JointDef, i: number): string {
  const st = o.joints?.[i] ?? {}, lim = j.limits, slide = j.kind === "slider";
  // A joint gives a little under load; say where it is within its limits.
  const at = lim ? Math.max(lim[0], Math.min(lim[1], st.at ?? 0)) : st.at ?? 0;
  const to = lim ? Math.max(lim[0], Math.min(lim[1], st.target ?? 0)) : 0;
  const short = lim && Math.abs(at - to) > THERE[slide ? "slider" : "hinge"] * 2
    ? ` (stuck short of ${slide ? `${to.toFixed(2)} blocks` : `${Math.round(to * DEG)}°`})`
    : "";
  switch (j.kind) {
    case "motor":
      return `${j.piece} on a motor, ${
        st.on ? `on (${Math.abs(Math.round(j.speed * DEG))}°/s)` : "off"
      }`;
    case "axle":
      return `${j.piece} spins on an axle`;
    case "slider":
      return (Math.abs(at) < THERE.slider * 2
        ? `${j.piece} in (slides ${lim![0]}-${lim![1]})`
        : `${j.piece} slid ${at.toFixed(2)} blocks`) + short;
    default:
      if (!lim) return `${j.piece} swings free on a hinge`;
      return (Math.abs(at) < THERE.hinge * 2
        ? `${j.piece} shut`
        : `${j.piece} open ${Math.round(Math.abs(at * DEG))}°`) + short;
  }
}

/**
 * Mechanisms near a villager for `look`: what each joint and device does now, its channel, and
 * where to use it.
 */
export function mechanismsText(sim: Sim, ax: number, az: number, r: number): string[] {
  const seen = new Map<WorldObject, { joints: Found[]; devices: DeviceFound[]; d: number }>();
  const entry = (o: WorldObject, d: number) => {
    let e = seen.get(o);
    if (!e) seen.set(o, e = { joints: [], devices: [], d });
    e.d = Math.min(e.d, d);
    return e;
  };
  for (const f of jointsNear(sim, Math.floor(ax), Math.floor(az), null, r)) {
    entry(f.o, f.d).joints.push(f);
  }
  for (const f of devicesNear(sim, Math.floor(ax), Math.floor(az), r)) {
    entry(f.o, f.d).devices.push(f);
  }
  const lines: string[] = [];
  const list = [...seen].sort((a, b) => a[1].d - b[1].d);
  for (const [o, { joints, devices }] of list.slice(0, 8)) {
    const d = sim.objects.design(o);
    joints.sort((a, b) => a.i - b.i);
    const spins = joints.filter((f) => f.j.kind === "axle");
    const parts = joints.filter((f) => f.j.kind !== "axle").map((f) =>
      jointText(o, f.j, f.i) + onChannel(o, d, f.j.part)
    );
    devices.sort((a, b) => a.part - b.part);
    for (const f of devices) parts.push(deviceText(o, f.part, f.kind) + onChannel(o, d, f.part));
    if (spins.length) {
      parts.push(
        spins.length === 1
          ? jointText(o, spins[0].j, spins[0].i)
          : `${spins.length} pieces spin on axles`,
      );
    }
    const use = joints.find((f) => usable(f.j));
    const dev = devices.find((f) => f.kind !== "plate");
    const at = use ? use.pin : dev?.at;
    const where = at ? ` — use x=${Math.floor(at[0])} z=${Math.floor(at[2])}` : "";
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

/** Walk within reach of a mechanism at `at` (unless already there) and spend a moment on it. */
function* approach(sim: Sim, agent: Agent, at: Vec3) {
  const tx = Math.floor(at[0]), tz = Math.floor(at[2]);
  const near =
    Math.max(Math.abs(Math.floor(agent.x) - tx), Math.abs(Math.floor(agent.z) - tz)) <= 2 &&
    Math.abs(agent.y - at[1]) <= MAX_REACH;
  if (near) yield* face(agent, tx, tz);
  else yield* reach(sim, agent, tx, tz, Math.floor(at[1]));
  yield* work(agent, Anim.Build, 6);
}

/** Flip a lever, or switch an Object's lamps and flames. */
function workDevice(sim: Sim, agent: Agent, f: DeviceFound): Job {
  const { o, part, kind } = f, name = nameOf(sim, o);
  return (function* () {
    yield* approach(sim, agent, f.at);
    if (!sim.objects.get(o.id)) throw new Error(`The ${name} is gone.`);
    if (o.held) throw new Error(`Someone picked up the ${name}.`);
    const d = sim.objects.design(o)!;
    o.mover = agent.name;
    const used = () =>
      sim.fire(
        "used",
        agent,
        Math.floor(f.at[0]),
        Math.floor(f.at[1]),
        Math.floor(f.at[2]),
        `${name} ${kind}`,
      );
    if (kind === "lever") {
      const on = !deviceOn(o, part, "lever");
      setDevice(o, part, on ? { on, by: agent.name } : { on });
      sim.objects.version++;
      used();
      const channel = channelOf(o, d, part);
      if (!channel) {
        return `You flip ${whose(name, "lever")} ${on ? "on" : "off"}. It's on no channel, so ` +
          `nothing follows it: use x=${Math.floor(f.at[0])} z=${
            Math.floor(f.at[2])
          } channel "name" tunes it.`;
      }
      const n = sim.signals.changed(o, part, agent);
      return `You flip ${whose(name, "lever")} ${on ? "on" : "off"}: channel "${channel}" ` +
        (n
          ? `reaches ${n} thing${n === 1 ? "" : "s"} within ${SIGNAL_RANGE} tiles.`
          : `reaches nothing within ${SIGNAL_RANGE} tiles (tune a lamp, flame, motor or ` +
            "door to it with use channel).");
    }
    // Lamps and flames of one Object switch together, like its motors.
    const on = !deviceOn(o, part, kind);
    let n = 0;
    d.parts.forEach((p, i) => {
      const k = deviceKind(p.part);
      if (k === "lamp" || k === "flame") setDevice(o, i, { on }), n++;
    });
    sim.objects.version++;
    used();
    const what = n > 1 ? "lights" : kind;
    return kind === "flame"
      ? `You ${on ? "light" : "put out"} the ${name}'s ${what === "flame" ? "flame" : what}.`
      : `You switch the ${name}'s ${what} ${on ? "on" : "off"}.`;
  })();
}

/**
 * Put a mechanism on a channel (or none). Motors, and lamps and flames, are tuned together per
 * Object, as they're switched together. A tuned lever that's on sends at once.
 */
function tune(
  sim: Sim,
  agent: Agent,
  f: { o: WorldObject; part: number; kind: DeviceKind | null; at: Vec3; d: number },
  channel: string,
): Job {
  const { o, part } = f, name = nameOf(sim, o);
  return (function* () {
    yield* approach(sim, agent, f.at);
    if (!sim.objects.get(o.id)) throw new Error(`The ${name} is gone.`);
    const d = sim.objects.design(o)!;
    const kind = deviceKind(d.parts[part].part) ?? d.parts[part].part;
    const group = (k: string) =>
      kind === "motor"
        ? k === "motor"
        : kind === "lamp" || kind === "flame"
        ? k === "lamp" || k === "flame"
        : false;
    const parts = d.parts.map((_, i) => i).filter((i) => i === part || group(d.parts[i].part));
    o.channels ??= {};
    for (const i of parts) {
      if (channel === (d.parts[i].channel ?? "")) delete o.channels[i];
      else o.channels[i] = channel;
    }
    if (!Object.keys(o.channels).length) delete o.channels;
    sim.objects.version++;
    const what = parts.length > 1 ? `${kind}s` : kind;
    if (!channel) {
      return `The ${name}'s ${what} ${parts.length > 1 ? "are" : "is"} on no channel now.`;
    }
    if ((kind === "lever" || kind === "plate") && deviceOn(o, part, kind)) {
      const n = sim.signals.changed(o, part, agent);
      return `You tune the ${name}'s ${kind} to channel "${channel}". It's on, so ${n} thing${
        n === 1 ? "" : "s"
      } within ${SIGNAL_RANGE} tiles follow it now.`;
    }
    return kind === "lever" || kind === "plate"
      ? `You tune the ${name}'s ${kind} to channel "${channel}": what's on that channel within ` +
        `${SIGNAL_RANGE} tiles follows it.`
      : `You tune the ${name}'s ${what} to channel "${channel}": ${
        parts.length > 1 ? "they follow" : "it follows"
      } levers and plates on "${channel}" within ${SIGNAL_RANGE} tiles, and Rules' signal effects.`;
  })();
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
    let channel: string | null = null;
    if (args.channel !== undefined && args.channel !== null) {
      if (typeof args.channel !== "string") {
        throw new Error('channel is a name, like "gate" ("" for none).');
      }
      const c = args.channel.trim().toLowerCase();
      channel = c === "" || c === "none" ? "" : channelName(c, "channel");
    }
    const tunable = (f: Found) => {
      const d = sim.objects.design(f.o);
      return !!d && hasChannel(d.parts[f.j.part]);
    };
    const found = jointsNear(sim, x, z, piece, NEAR + 0.5).find((f) =>
      channel === null || tunable(f)
    );
    // Plates are stood on, not used, but they can be tuned.
    const device = piece
      ? undefined
      : devicesNear(sim, x, z, NEAR + 0.5).find((f) => channel !== null || f.kind !== "plate");
    if (device && (!found || (channel === null && !usable(found.j)) || device.d < found.d - 0.25)) {
      return channel === null ? workDevice(sim, agent, device) : tune(sim, agent, device, channel);
    }
    if (!found) {
      const any = jointsNear(sim, x, z, piece, 16)[0];
      const dev = piece ? undefined : devicesNear(sim, x, z, 16).find((f) => f.kind !== "plate");
      const what = piece ? `no piece "${piece}" on a joint` : "nothing to use";
      throw new Error(
        dev && (!any || dev.d < any.d)
          ? `There's ${what} at (${x}, ${z}). The nearest is the ${
            nameOf(sim, dev.o)
          }'s ${dev.kind} at x=${Math.floor(dev.at[0])} z=${Math.floor(dev.at[2])}.`
          : any
          ? `There's ${what} at (${x}, ${z}). The nearest is the ${
            nameOf(sim, any.o)
          }'s ${any.j.piece} at x=${Math.floor(any.pin[0])} z=${Math.floor(any.pin[2])}.`
          : `There's ${what} at (${x}, ${z}). use works Objects whose Design has hinge, slider ` +
            "or motor parts (doors, gates, windmills), levers, lamps or flames.",
      );
    }
    if (channel !== null) {
      if (!tunable(found)) {
        throw new Error(
          `${cap(whose(nameOf(sim, found.o), found.j.piece))} can't follow a channel: only ` +
            "motors, hinges and sliders with limits, lamps, flames, levers and plates can.",
        );
      }
      return tune(
        sim,
        agent,
        { o: found.o, part: found.j.part, kind: null, at: found.pin, d: 0 },
        channel,
      );
    }
    const { o, asm, i, j } = found, name = nameOf(sim, o);
    if (!usable(j)) {
      throw new Error(
        j.kind === "axle"
          ? `${
            cap(whose(name, j.piece))
          } spins freely on its axle; there's nothing to switch. push ` +
            `the ${name} to roll it.`
          : `${cap(whose(name, j.piece))} swings freely on its hinge: it has no limits to swing ` +
            "between. A hinge with limits (a door) can be used.",
      );
    }
    return (function* () {
      // Within reach, work it from where you stand (this side of the door); otherwise walk up,
      // standing clear of where it swings if anywhere within reach is.
      const pin = pinAt(o, j), clear = sweep(asm, j) + 0.35;
      const inSwing = (px: number, pz: number) => Math.hypot(px - pin[0], pz - pin[2]) < clear;
      const tx = Math.floor(pin[0]), tz = Math.floor(pin[2]);
      const near =
        Math.max(Math.abs(Math.floor(agent.x) - tx), Math.abs(Math.floor(agent.z) - tz)) <= 2 &&
        Math.abs(agent.y - pin[1]) <= MAX_REACH;
      if (near) yield* face(agent, tx, tz);
      else {
        yield* reach(
          sim,
          agent,
          tx,
          tz,
          Math.floor(pin[1]),
          (cx, cz) => inSwing(cx + 0.5, cz + 0.5),
        );
      }
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
        // "its sails turn", "its blade turns".
        const one = /s$/.test(j.piece) ? "" : "s";
        return `You switch the ${name}'s motor${n > 1 ? "s" : ""} ${
          on ? "on" : "off"
        }: its ${j.piece} ${on ? `turn${one} at ${s}°/s` : `coast${one} to a stop`}.`;
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
        const who = sim.agents.find((a) => touching(sim, o, j, a.x, a.y, a.z));
        const heavy = load(o, asm, j);
        const why = who === agent
          ? "you're standing in its way (find room clear of its swing, or hang it to swing " +
            "the other way, like limits [-95, 0])"
          : who
          ? `${who.name} is in its way`
          : heavy > SERVO_TORQUE * 0.8
          ? `it's too heavy for its ${j.kind} (its weight pulls with about ${
            Math.round(heavy)
          }; a ${j.kind} drives with up to ${SERVO_TORQUE}): make the ${j.piece} lighter or ` +
            "turn the joint so it doesn't lift it"
          : "something is in the way: the ground, a wall, or another Object";
        return `${cap(whose(name, j.piece))} stuck at ${show(at)} on its way to ${
          show(to)
        }: ${why}. ` +
          "use again sends it back.";
      }
      if (Math.abs(to) < there) {
        return `You ${slider ? "slide" : "shut"} ${whose(name, j.piece)} back as it was built.`;
      }
      return slider
        ? `You slide ${whose(name, j.piece)} ${show(to)} along its rail.`
        : `You open ${whose(name, j.piece)}: it swung ${show(Math.abs(to))} on its hinge.`;
    })();
  },
};
