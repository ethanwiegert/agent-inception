import type { DesignContent, MaterialContent } from "./catalog.ts";
import { poseBoxes } from "./physics.ts";
import { plantInfo } from "./props.ts";
import { hash2 } from "./rng.ts";
import type { Agent, Sim } from "./sim.ts";
import { AnimalMode } from "./animals.ts";
import type { WorldObject } from "./objects.ts";
import { Block, solid } from "./world.ts";

/**
 * Wild fire (physics phase 4, fields). Blocks, plants, crops and Objects whose Materials burn
 * catch fire from `ignite`, a Rule, or something burning beside them, burn for a while and are
 * gone. Fire spreads slowly to touching things that burn, never to grass or stone, and it is
 * capped: so many things burn at once in a world, and each fire, from whoever lit it, burns so many
 * things in all before it dies down. Heavy cloud puts fires out like rain; `douse` puts them out
 * by hand. Villagers and animals are never hurt: they step out of the flames, and paths go round.
 */

export const FIRE_LIMITS = {
  /** Things burning at once in a world. */
  burning: 64,
  /** Things one fire burns in all (the first included) before it dies down. */
  perFire: 48,
  /** Ticks between one burning thing's tries to spread, and its chance per thing it touches. */
  spreadTicks: 20,
  spreadChance: 0.3,
  /** Cloud cover at which fires go out as if it rained, and each one's chance a second. */
  rain: 0.85,
  rainChance: 0.25,
} as const;

export type BurnKind = "block" | "plant" | "crop" | "object";

export interface Burning {
  kind: BurnKind;
  /** Block index, tile key, or Object id. */
  ref: number;
  started: number;
  /** Tick it burns out. */
  until: number;
  /** The fire it belongs to. */
  fire: number;
}

/** One fire: lit once, it spreads from thing to thing until its share runs out. */
export interface FireLine {
  id: number;
  /** Who lit it (a villager's name), or null for a Rule or nature. */
  by: string | null;
  /** Things it set alight so far. */
  lit: number;
  /** Lit by a Rule: what it burns doesn't fire Rules (Rules don't chain). */
  quiet: boolean;
}

export interface FireSave {
  burning: Burning[];
  lines: FireLine[];
}

/** Something that could burn: what it is, where, and what it's called. */
export interface Target {
  kind: BurnKind;
  ref: number;
  name: string;
}

/** World box of a burning thing: x0, x1, y0, y1, z0, z1. */
export type Box = [number, number, number, number, number, number];

const key = (kind: BurnKind, ref: number) => `${kind[0]}${ref}`;

export class Fire {
  readonly burning = new Map<string, Burning>();
  readonly lines = new Map<number, FireLine>();
  /** Bumps when something catches, goes out or moves (the page gets the list again). */
  version = 0;
  private nextLine = 1;
  /** Columns marked as on fire, so they can be cleared. */
  private marked: number[] = [];

  constructor(private readonly sim: Sim) {}

  // ---------------------------------------------------------------- what burns

  /** Whether `materials` (with volumes) mostly burn. */
  private mostlyBurns(parts: { material: string; v: number }[]): boolean {
    let burns = 0, all = 0;
    for (const p of parts) {
      const m = this.sim.catalog.byName(p.material)?.content as MaterialContent | undefined;
      all += p.v;
      if (m?.burns) burns += p.v;
    }
    return all > 0 && burns * 2 > all;
  }

  private designBurns(d: DesignContent): boolean {
    return this.mostlyBurns(
      d.parts.map((p) => ({ material: p.material, v: p.size[0] * p.size[1] * p.size[2] })),
    );
  }

  /** Why `t` can't catch now, or nothing. */
  refusal(t: Target): string | void {
    const sim = this.sim, w = sim.world;
    if (this.burning.has(key(t.kind, t.ref))) return `the ${t.name} is already burning`;
    switch (t.kind) {
      case "block": {
        const def = sim.blocks.get(w.blocks[t.ref]);
        if (!def?.burns) return `${def?.name ?? "that"} doesn't burn`;
        const [x, y, z] = this.cell(t.ref);
        const air = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(
          ([dx, dy, dz]) =>
            w.inBounds(x + dx, y + dy, z + dz) && w.get(x + dx, y + dy, z + dz) === Block.Air,
        );
        if (!air) return `the ${def.name} is walled in: fire needs air`;
        return;
      }
      case "plant": {
        const p = sim.props.map.get(t.ref);
        const info = p && plantInfo(sim.catalog, p.design);
        if (!info) return "nothing grows there";
        if (w.waterTop[t.ref] >= 0) return `the ${t.name} is wet, on the water`;
        if (!this.designBurns(info.entry.content as DesignContent)) return `${t.name} doesn't burn`;
        return;
      }
      case "crop": {
        const c = sim.crops.get(t.ref);
        const e = c && sim.catalog.get(c.design);
        if (!e) return "nothing grows there";
        if (!this.designBurns(e.content as DesignContent)) return `${t.name} doesn't burn`;
        return;
      }
      case "object": {
        const o = sim.objects.get(t.ref);
        const d = o && sim.objects.design(o);
        if (!o || !d) return "it's gone";
        if (o.held) return `someone is carrying the ${t.name}`;
        if (!this.designBurns(d)) return `the ${t.name} is mostly made of things that don't burn`;
        const b = this.box({ kind: "object", ref: o.id } as Burning);
        const water =
          w.waterTop[Math.floor((b[4] + b[5]) / 2) * w.sizeX + Math.floor((b[0] + b[1]) / 2)];
        if (b && water >= 0 && (b[2] + b[3]) / 2 < water + 1) {
          return `the ${t.name} is in the water`;
        }
      }
    }
  }

  /** The thing that would burn at tile (x, z): an Object, a plant, a crop, or the top block. */
  targetsAt(x: number, z: number, y?: number): Target[] {
    const sim = this.sim, w = sim.world, out: Target[] = [];
    if (x < 0 || z < 0 || x >= w.sizeX || z >= w.sizeZ) return out;
    const tile = z * w.sizeX + x;
    if (y === undefined) {
      for (const o of sim.objects.allAt(x, z)) {
        out.push({ kind: "object", ref: o.id, name: sim.catalog.get(o.design)?.name ?? "Object" });
      }
      const p = sim.props.at(x, z);
      const info = p && plantInfo(sim.catalog, p.design);
      if (info) out.push({ kind: "plant", ref: tile, name: info.entry.name });
      const c = sim.crops.get(tile);
      if (c) out.push({ kind: "crop", ref: tile, name: sim.catalog.get(c.design)?.name ?? "crop" });
    }
    const by = y ?? w.heightAt(x, z);
    if (by >= 0 && solid(w.get(x, by, z))) {
      out.push({ kind: "block", ref: w.index(x, by, z), name: sim.blocks.name(w.get(x, by, z)) });
    }
    return out;
  }

  // ---------------------------------------------------------------- catching and going out

  /** Start a new fire at `t`. Returns why it can't. */
  light(t: Target, by: string | null, quiet: boolean): string | void {
    const why = this.refusal(t);
    if (why) return why;
    if (this.burning.size >= FIRE_LIMITS.burning) {
      return `${FIRE_LIMITS.burning} things are burning already, as many as a world allows at once`;
    }
    const line: FireLine = { id: this.nextLine++, by, lit: 0, quiet };
    this.lines.set(line.id, line);
    this.catchFire(t, line);
  }

  private catchFire(t: Target, line: FireLine) {
    const sim = this.sim, now = sim.tick;
    const b: Burning = {
      kind: t.kind,
      ref: t.ref,
      started: now,
      until: now + this.burnTicks(t),
      fire: line.id,
    };
    this.burning.set(key(t.kind, t.ref), b);
    line.lit++;
    this.version++;
    if (!line.quiet) {
      const [x, y, z] = this.place(b);
      sim.fire("ignited", this.villager(line), x, y, z, t.name);
    }
  }

  /** How long `t` burns, in ticks: harder things longer, big things longer. */
  private burnTicks(t: Target): number {
    const sim = this.sim, s = 20;
    switch (t.kind) {
      case "block": {
        const name = sim.blocks.name(sim.world.blocks[t.ref]);
        const m = sim.catalog.byName(name)?.content as MaterialContent | undefined;
        return s * (6 + 4 * Math.min(5, m?.hardness ?? 1));
      }
      case "plant": {
        const p = sim.props.map.get(t.ref)!;
        return s * (plantInfo(sim.catalog, p.design)?.solid ? 24 : 6);
      }
      case "crop":
        return s * 6;
      default: {
        const o = sim.objects.get(t.ref)!;
        return s * Math.round(8 + 4 * Math.min(3, sim.physics.assembly(o.design)?.mass ?? 1));
      }
    }
  }

  /** Put out what burns at `k`; it stays as it is now. */
  out(k: string) {
    if (this.burning.delete(k)) this.version++;
  }

  /** Burnt through: the thing is gone. */
  private burnOut(k: string, b: Burning) {
    const sim = this.sim, w = sim.world;
    this.burning.delete(k);
    this.version++;
    const line = this.lines.get(b.fire);
    const [x, y, z] = this.place(b);
    const name = this.nameOf(b);
    switch (b.kind) {
      case "block":
        sim.setBlock(x, y, z, Block.Air);
        break;
      case "plant":
        sim.props.set(b.ref % w.sizeX, Math.floor(b.ref / w.sizeX), null);
        break;
      case "crop":
        sim.crops.delete(b.ref);
        sim.cropsVersion++;
        break;
      default: {
        const o = sim.objects.get(b.ref);
        if (o) sim.removeObject(o);
      }
    }
    if (line && !line.quiet) sim.fire("burned", this.villager(line), x, y, z, name);
  }

  private villager(line: FireLine): Agent | null {
    return line.by ? this.sim.agents.find((a) => a.name === line.by) ?? null : null;
  }

  // ---------------------------------------------------------------- each tick

  step() {
    const sim = this.sim, tick = sim.tick;
    if (!this.burning.size) {
      if (this.marked.length) this.markColumns();
      if (this.lines.size) this.lines.clear();
      return;
    }
    const rain = sim.clouds() >= FIRE_LIMITS.rain;
    let moved = false;
    for (const [k, b] of [...this.burning]) {
      if (!this.burning.has(k)) continue;
      if (!this.exists(b)) {
        this.out(k);
        continue;
      }
      if (tick >= b.until) {
        this.burnOut(k, b);
        continue;
      }
      // Each burning thing checks about once a second, each on its own beat.
      if ((tick + b.started) % FIRE_LIMITS.spreadTicks) continue;
      if (rain && hash2(tick, b.ref, 71) < FIRE_LIMITS.rainChance) {
        this.out(k);
        continue;
      }
      if (b.kind === "object") {
        const o = sim.objects.get(b.ref)!;
        if (!o.asleep) moved = true;
        if (this.refusal({ kind: "object", ref: o.id, name: "" })?.includes("water")) {
          this.out(k);
          continue;
        }
      }
      if (!rain) this.spread(b);
    }
    if (moved) this.version++;
    // Columns on fire are kept out of paths; villagers step out of them, animals bolt.
    if (tick % 10 === 0) {
      this.markColumns();
      this.flee();
      // A fire with nothing left burning is over.
      for (const id of this.lines.keys()) {
        let live = false;
        for (const b of this.burning.values()) if (b.fire === id) live = true;
        if (!live) this.lines.delete(id);
      }
    }
  }

  /** Whether what's burning is still there. */
  private exists(b: Burning): boolean {
    const sim = this.sim;
    switch (b.kind) {
      case "block":
        return !!sim.blocks.get(sim.world.blocks[b.ref])?.burns;
      case "plant":
        return sim.props.map.has(b.ref);
      case "crop":
        return sim.crops.has(b.ref);
      default: {
        const o = sim.objects.get(b.ref);
        return !!o && !o.held;
      }
    }
  }

  /** Try to set alight the things touching `b`. */
  private spread(b: Burning) {
    const sim = this.sim, w = sim.world, line = this.lines.get(b.fire);
    if (!line || line.lit >= FIRE_LIMITS.perFire) return;
    const [x0, x1, y0, y1, z0, z1] = this.box(b);
    const near: Target[] = [];
    const tx0 = Math.floor(x0) - 1,
      tx1 = Math.ceil(x1),
      tz0 = Math.floor(z0) - 1,
      tz1 = Math.ceil(z1);
    const ty0 = Math.max(0, Math.floor(y0) - 1), ty1 = Math.min(w.sizeY - 1, Math.ceil(y1));
    for (let z = tz0; z <= tz1; z++) {
      for (let x = tx0; x <= tx1; x++) {
        if (x < 0 || z < 0 || x >= w.sizeX || z >= w.sizeZ) continue;
        for (let y = ty0; y <= ty1; y++) {
          const id = w.blocks[w.index(x, y, z)];
          if (sim.blocks.get(id)?.burns) {
            near.push({ kind: "block", ref: w.index(x, y, z), name: sim.blocks.name(id) });
          }
        }
        const tile = z * w.sizeX + x, ground = w.heightAt(x, z) + 1;
        const p = sim.props.map.get(tile);
        if (p) {
          const top = ground + this.plantHeight(p.design);
          if (top >= y0 - 1 && ground <= y1 + 1) {
            near.push({
              kind: "plant",
              ref: tile,
              name: plantInfo(sim.catalog, p.design)?.entry.name ?? "",
            });
          }
        }
        const c = sim.crops.get(tile);
        if (c && ground + 1 >= y0 - 1 && ground <= y1 + 1) {
          near.push({ kind: "crop", ref: tile, name: sim.catalog.get(c.design)?.name ?? "crop" });
        }
      }
    }
    for (const o of sim.objects.list) {
      if (b.kind === "object" && o.id === b.ref) continue;
      const [ox0, ox1, oy0, oy1, oz0, oz1] = this.objectBox(o);
      if (
        ox1 < x0 - 1 || ox0 > x1 + 1 || oy1 < y0 - 1 || oy0 > y1 + 1 || oz1 < z0 - 1 || oz0 > z1 + 1
      ) {
        continue;
      }
      near.push({ kind: "object", ref: o.id, name: sim.catalog.get(o.design)?.name ?? "Object" });
    }
    const cloud = 1 - sim.clouds();
    // Start the round at a different neighbour each time, so fire spreads every way alike.
    const first = Math.floor(hash2(sim.tick, b.ref, 5) * near.length);
    let caught = 0;
    for (let j = 0; j < near.length && caught < 2; j++) {
      const i = (first + j) % near.length, t = near[i];
      if (this.burning.size >= FIRE_LIMITS.burning || line.lit >= FIRE_LIMITS.perFire) return;
      if (this.burning.has(key(t.kind, t.ref))) continue;
      const chance = FIRE_LIMITS.spreadChance * cloud;
      if (hash2(sim.tick + i * 7919, t.ref, b.ref + 13) >= chance) continue;
      if (this.refusal(t)) continue;
      this.catchFire(t, line);
      caught++;
    }
  }

  private plantHeight(design: number): number {
    const e = this.sim.catalog.get(design);
    let top = 0.3;
    for (const p of (e?.content as DesignContent | undefined)?.parts ?? []) {
      top = Math.max(top, p.at[1] + p.size[1] / 2);
    }
    return top;
  }

  private objectBox(o: WorldObject): Box {
    const d = this.sim.objects.design(o);
    const out: Box = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
    if (!d) return [o.pos[0], o.pos[0] + 1, o.pos[1], o.pos[1] + 1, o.pos[2], o.pos[2] + 1];
    for (const b of poseBoxes(d, o.pos, o.rot, o.pieces)) {
      out[0] = Math.min(out[0], b[0]), out[1] = Math.max(out[1], b[1]);
      out[2] = Math.min(out[2], b[2]), out[3] = Math.max(out[3], b[3]);
      out[4] = Math.min(out[4], b[4]), out[5] = Math.max(out[5], b[5]);
    }
    return out;
  }

  // ---------------------------------------------------------------- where

  private cell(index: number): [number, number, number] {
    const w = this.sim.world;
    return [
      index % w.sizeX,
      Math.floor(index / (w.sizeX * w.sizeZ)),
      Math.floor(index / w.sizeX) % w.sizeZ,
    ];
  }

  /** The world box a burning thing fills. */
  box(b: Burning): Box {
    const sim = this.sim, w = sim.world;
    switch (b.kind) {
      case "block": {
        const [x, y, z] = this.cell(b.ref);
        return [x, x + 1, y, y + 1, z, z + 1];
      }
      case "plant":
      case "crop": {
        const x = b.ref % w.sizeX, z = Math.floor(b.ref / w.sizeX), g = w.heightAt(x, z) + 1;
        const p = sim.props.map.get(b.ref), c = sim.crops.get(b.ref);
        const h = p
          ? this.plantHeight(p.design) * (0.15 + 0.85 * sim.props.growth(p, sim.tick))
          : c
          ? 0.8
          : 0.5;
        return [x, x + 1, g, g + h, z, z + 1];
      }
      default: {
        const o = sim.objects.get(b.ref);
        return o ? this.objectBox(o) : [0, 0, 0, 0, 0, 0];
      }
    }
  }

  /** A block where it burns, for Rules and `look`: its cell, or the tile's ground. */
  place(b: Burning): [number, number, number] {
    const [x0, x1, y0, , z0, z1] = this.box(b);
    if (b.kind === "block") return this.cell(b.ref);
    return [
      Math.floor((x0 + x1) / 2),
      Math.floor(y0 + 0.01) - (b.kind === "object" ? 0 : 1),
      Math.floor((z0 + z1) / 2),
    ];
  }

  nameOf(b: Burning): string {
    const sim = this.sim;
    switch (b.kind) {
      case "block":
        return sim.blocks.name(sim.world.blocks[b.ref]);
      case "plant": {
        const p = sim.props.map.get(b.ref);
        return (p && plantInfo(sim.catalog, p.design)?.entry.name) ?? "plant";
      }
      case "crop": {
        const c = sim.crops.get(b.ref);
        return (c && sim.catalog.get(c.design)?.name) ?? "crop";
      }
      default: {
        const o = sim.objects.get(b.ref);
        return (o && sim.catalog.get(o.design)?.name) ?? "Object";
      }
    }
  }

  /** Mark the columns under every burning thing, so paths keep out of them. */
  private markColumns() {
    const w = this.sim.world;
    for (const k of this.marked) w.fire[k] = 0;
    this.marked.length = 0;
    for (const b of this.burning.values()) {
      const [x0, x1, , , z0, z1] = this.box(b);
      for (let z = Math.floor(z0 + 0.1); z < Math.ceil(z1 - 0.1); z++) {
        for (let x = Math.floor(x0 + 0.1); x < Math.ceil(x1 - 0.1); x++) {
          if (x < 0 || z < 0 || x >= w.sizeX || z >= w.sizeZ) continue;
          const k = z * w.sizeX + x;
          if (!w.fire[k]) w.fire[k] = 1, this.marked.push(k);
        }
      }
    }
  }

  /** Villagers step out of the flames; animals near them bolt. */
  private flee() {
    const sim = this.sim, w = sim.world;
    for (const a of sim.agents) {
      const tx = Math.floor(a.x), tz = Math.floor(a.z);
      if (!w.fire[tz * w.sizeX + tx] || a.downUntil !== undefined) continue;
      if (sim.carried(a)) continue;
      const to = this.safeTile(tx, tz, a.y);
      if (!to) continue;
      a.x = to[0] + 0.5, a.z = to[1] + 0.5;
      a.notes.push(`You stepped out of the fire at (${tx}, ${tz}).`);
    }
    for (const an of sim.animals) {
      for (const b of this.burning.values()) {
        const [x0, x1, , , z0, z1] = this.box(b);
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        const d = Math.hypot(an.x - cx, an.z - cz);
        if (d > 4) continue;
        an.mode = AnimalMode.Flee;
        const l = d || 1;
        an.tx = an.x + ((an.x - cx) / l) * 6, an.tz = an.z + ((an.z - cz) / l) * 6;
        break;
      }
    }
  }

  /** The nearest tile beside (x, z) that isn't burning and has room to stand, if any. */
  private safeTile(x: number, z: number, feet: number): [number, number] | null {
    const w = this.sim.world;
    for (let r = 1; r <= 3; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= w.sizeX || nz >= w.sizeZ) continue;
          if (w.fire[nz * w.sizeX + nx] || w.blocked(nx, nz)) continue;
          const floor = w.floorBelow(nx, nz, Math.floor(feet + 1.5));
          if (floor >= 0 && Math.abs(floor + 1 - feet) <= 2) return [nx, nz];
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- save

  save(): FireSave {
    return {
      burning: [...this.burning.values()].map((b) => ({ ...b })),
      lines: [...this.lines.values()].map((l) => ({ ...l })),
    };
  }

  load(s: FireSave | undefined) {
    this.burning.clear();
    this.lines.clear();
    for (const l of s?.lines ?? []) {
      this.lines.set(l.id, { ...l }), this.nextLine = Math.max(this.nextLine, l.id + 1);
    }
    for (const b of s?.burning ?? []) this.burning.set(key(b.kind, b.ref), { ...b });
    this.version++;
  }
}
