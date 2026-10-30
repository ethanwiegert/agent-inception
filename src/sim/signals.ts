import {
  type DesignContent,
  type DeviceKind,
  deviceKind,
  hasChannel,
  type JointKind,
  jointKind,
} from "./catalog.ts";
import type { DeviceState, WorldObject } from "./objects.ts";
import { poseBoxes } from "./physics.ts";
import type { Agent, Sim } from "./sim.ts";

/**
 * Signals (physics phase 4, fields) travel on named channels. A lever sends while it's on, a
 * pressure plate while something stands on it, and a Rule's `signal` effect sends once. Every
 * lamp, flame, motor, and hinge or slider with limits on that channel within SIGNAL_RANGE tiles
 * follows: on means shine, run, or open to its far limit; off means dark, stop, or back as built.
 * A receiver is on while any sender on its channel within range is.
 */

export const SIGNAL_RANGE = 16;
/** Receivers one Rule `signal` effect may reach. */
export const SIGNAL_RECEIVERS = 32;
/** Ticks between looks at who stands on the pressure plates. */
const PLATE_TICKS = 4;

/** A device or joint on a channel, where it is now. */
export interface Wire {
  o: WorldObject;
  /** Its part's index in the Design. */
  part: number;
  kind: DeviceKind | JointKind;
  channel: string;
  /** Its joint's index, for joints. */
  joint: number;
  x: number;
  y: number;
  z: number;
}

/** The channel a part of `o` is on now: tuned with `use`, or its Design's. */
export function channelOf(o: WorldObject, d: DesignContent, part: number): string | null {
  return o.channels?.[part] ?? d.parts[part].channel ?? null;
}

/** A device's state: lamps and flames start lit, levers and plates off. */
export function deviceOn(o: WorldObject, part: number, kind: DeviceKind): boolean {
  const st = o.devices?.[part];
  return kind === "lamp" || kind === "flame" ? st?.on !== false : st?.on === true;
}

export function setDevice(o: WorldObject, part: number, st: DeviceState) {
  (o.devices ??= {})[part] = st;
}

const isSender = (k: Wire["kind"]) => k === "lever" || k === "plate";

export class Signals {
  /** Ticks each plate was last pressed by a villager (for who stepped on it). */
  constructor(private readonly sim: Sim) {}

  /** Every part on a channel, or (with `all`) every device whether on a channel or not. */
  wires(all = false): Wire[] {
    const sim = this.sim, out: Wire[] = [];
    for (const o of sim.objects.list) {
      const d = sim.objects.design(o);
      if (!d) continue;
      let boxes: number[][] | null = null;
      let joint = -1;
      d.parts.forEach((p, i) => {
        const jk = jointKind(p.part), dk = deviceKind(p.part);
        if (jk && p.joins) joint++;
        if (!jk && !dk) return;
        const channel = channelOf(o, d, i);
        if (!channel && !(all && (dk || hasChannel(p)))) return;
        boxes ??= poseBoxes(d, o.pos, o.rot, o.pieces);
        const b = boxes[i];
        out.push({
          o,
          part: i,
          kind: (dk ?? jk)!,
          channel: channel ?? "",
          joint: jk ? joint : -1,
          x: (b[0] + b[1]) / 2,
          y: (b[2] + b[3]) / 2,
          z: (b[4] + b[5]) / 2,
        });
      });
    }
    return out;
  }

  /** Whether a sender is sending now. */
  private sending(w: Wire): boolean {
    return deviceOn(w.o, w.part, w.kind as DeviceKind);
  }

  /**
   * A lever or plate changed: its receivers follow every sender on its channel near them. Returns
   * how many there were.
   */
  changed(o: WorldObject, part: number, by: Agent | null): number {
    const sim = this.sim, wires = this.wires();
    const src = wires.find((w) => w.o === o && w.part === part);
    if (!src) return 0;
    const senders = wires.filter((w) => isSender(w.kind) && w.channel === src.channel);
    const to: number[] = [];
    for (const r of wires) {
      if (isSender(r.kind) || r.channel !== src.channel || !this.near(src, r)) continue;
      const on = senders.some((s) => this.near(s, r) && this.sending(s));
      this.apply(r, on);
      to.push(r.x, r.y, r.z);
    }
    const on = this.sending(src);
    sim.events.push({ type: "signal", from: [src.x, src.y, src.z], to, on });
    sim.fire(
      "signal",
      by,
      Math.floor(src.x),
      Math.floor(src.y),
      Math.floor(src.z),
      `${src.channel} ${on ? "on" : "off"}`,
    );
    return to.length / 3;
  }

  /**
   * A Rule sends `on` down `channel`: to receivers within range of (x, y, z), or everywhere.
   * Returns how many followed.
   */
  send(channel: string, on: boolean, at: [number, number, number] | null): number {
    const sim = this.sim, to: number[] = [];
    let n = 0;
    for (const r of this.wires()) {
      if (n >= SIGNAL_RECEIVERS) break;
      if (isSender(r.kind) || r.channel !== channel) continue;
      if (at && !this.near({ x: at[0] + 0.5, y: at[1] + 0.5, z: at[2] + 0.5 }, r)) continue;
      this.apply(r, on);
      to.push(r.x, r.y, r.z);
      n++;
    }
    if (at && n) {
      sim.events.push({ type: "signal", from: [at[0] + 0.5, at[1] + 0.5, at[2] + 0.5], to, on });
    }
    return n;
  }

  private near(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z)) <= SIGNAL_RANGE;
  }

  /** Make a receiver follow `on`. */
  private apply(r: Wire, on: boolean) {
    const sim = this.sim, o = r.o;
    if (r.kind === "lamp" || r.kind === "flame") {
      if (deviceOn(o, r.part, r.kind) === on) return;
      setDevice(o, r.part, { on });
      sim.objects.version++;
      return;
    }
    const asm = sim.physics.assembly(o.design);
    const j = asm?.joints[r.joint];
    if (!asm || !j) return;
    o.joints ??= asm.joints.map(() => ({}));
    const st = o.joints[r.joint] ??= {};
    if (j.kind === "motor") st.on = on;
    else if (j.limits) {
      const [lo, hi] = j.limits;
      st.target = on ? (Math.abs(hi) >= Math.abs(lo) ? hi : lo) : 0;
    }
    sim.physics.wake(o);
  }

  /** Plates: on while a villager, an animal or another Object rests on them. */
  step() {
    const sim = this.sim;
    if (sim.tick % PLATE_TICKS) return;
    for (const o of sim.objects.list) {
      const d = sim.objects.design(o);
      if (!d || o.held || !d.parts.some((p) => p.part === "plate")) continue;
      const boxes = poseBoxes(d, o.pos, o.rot, o.pieces);
      d.parts.forEach((p, i) => {
        if (p.part !== "plate") return;
        const b = boxes[i];
        const on = (x: number, y: number, z: number) =>
          x > b[0] - 0.1 && x < b[1] + 0.1 && z > b[4] - 0.1 && z < b[5] + 0.1 &&
          Math.abs(y - b[3]) < 0.6;
        const who = sim.agents.find((a) => on(a.x, a.y, a.z));
        const pressed = !!who || sim.animals.some((a) => on(a.x, a.y, a.z)) ||
          this.weighed(o, b);
        if (pressed === deviceOn(o, i, "plate")) return;
        setDevice(o, i, pressed ? { on: true, ...(who ? { by: who.name } : {}) } : { on: false });
        sim.objects.version++;
        this.changed(o, i, who ?? null);
      });
    }
  }

  /** Whether another Object rests on plate box `b`. */
  private weighed(self: WorldObject, b: number[]): boolean {
    const sim = this.sim;
    for (const o of sim.objects.list) {
      if (o === self || o.held) continue;
      const d = sim.objects.design(o);
      if (!d) continue;
      for (const q of poseBoxes(d, o.pos, o.rot, o.pieces)) {
        if (q[1] < b[0] || q[0] > b[1] || q[5] < b[4] || q[4] > b[5]) continue;
        if (q[2] <= b[3] + 0.15 && q[3] >= b[3] - 0.02) return true;
      }
    }
    return false;
  }
}
