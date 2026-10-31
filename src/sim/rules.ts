import {
  type Catalog,
  channelName,
  type DesignContent,
  type Entry,
  type MaterialContent,
  type Vec3,
} from "./catalog.ts";
import { daylight } from "./light.ts";
import { GROWN, habitatRefusal, plantInfo } from "./props.ts";
import { hash2 } from "./rng.ts";
import type { Agent, Sim } from "./sim.ts";
import { Block, solid } from "./world.ts";

/**
 * Rules (ADR 0004): JSON trees of when (a trigger) → if (conditions) → do (effects). Effects act
 * only through the engine operations below. Rules can't trigger other Rules, every tree is capped
 * in size and depth, and the engine spends a fixed step budget on them per tick.
 */

export const RULE_EVENTS = [
  "joined",
  "said",
  "tilled",
  "planted",
  "harvested",
  "placed",
  "broken",
  "caught",
  "crafted",
  "gathered",
  "built",
  "pushed",
  "carried",
  "landed",
  "used",
  "ignited",
  "burned",
  "signal",
] as const;
export type RuleEvent = (typeof RULE_EVENTS)[number];

export type Trigger = { event: RuleEvent; what?: string } | { every: number } | { daily: number };

export type Condition =
  | { chance: number }
  | { time: [number, number] }
  | { clouds_above: number }
  | { clouds_below: number }
  | { has: { item: string; count: number } }
  | { block: { at: Vec3; is: string } }
  | { light_above: number }
  | { light_below: number }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export type Effect =
  | { give: { item: string; count: number } }
  | { take: { item: string; count: number } }
  | { set_block: { at: Vec3; to: string } }
  | { say: string }
  | { weather: { clouds: number; hours: number } }
  | { spread: { what: string; count: number } }
  | { grow: { what: string; hours: number; light_above?: number } }
  | { impulse: Impulse }
  | { switch: { what: string; on: boolean } }
  | { ignite: { at: Vec3 } }
  | { douse: { what?: string } }
  | { signal: { channel: string; on: boolean } };

/** A nudge to bodies: up and sideways speeds (blocks/s), optionally only those named `what`. */
export interface Impulse {
  what?: string;
  up: number;
  speed: number;
  /** A compass direction, or "away" from the event (the default when there is one). */
  toward?: string;
}

/** Compass directions: x grows east, z grows south. */
export const COMPASS: Record<string, [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
  northeast: [Math.SQRT1_2, -Math.SQRT1_2],
  northwest: [-Math.SQRT1_2, -Math.SQRT1_2],
  southeast: [Math.SQRT1_2, Math.SQRT1_2],
  southwest: [-Math.SQRT1_2, Math.SQRT1_2],
};

export interface RuleContent {
  when: Trigger;
  if: Condition | null;
  do: Effect[];
}

export const RULE_LIMITS = {
  /** Condition and effect nodes in one Rule. */
  nodes: 24,
  depth: 5,
  effects: 8,
  /** Effects reach at most this far from the event's block on each axis. */
  reach: 4,
  give: 4,
  take: 16,
  /** Copies one spread effect may place. */
  spread: 4,
  /**
   * A free tile is too crowded to receive a spread when this many of its 8 neighbours already
   * hold that Design.
   */
  crowd: 3,
  weatherHours: 12,
  /** Game hours one grow effect may bring plants forward: near an event, and on a timer. */
  growHours: 24,
  growHoursEverywhere: 1,
  /** Fastest an impulse may set bodies moving (blocks/s): near an event, and on a timer. */
  impulse: 8,
  impulseEverywhere: 3,
  /** Bodies one impulse may move. */
  impulseBodies: 16,
  /** Objects one switch may turn on or off. */
  switchObjects: 16,
  /** Each Rule fires at most this often per game hour. */
  firingsPerHour: 20,
  /** Condition and effect steps the engine spends on Rules per tick, across all Rules. */
  stepsPerTick: 400,
} as const;

const CONDITIONS = [
  "chance",
  "time",
  "clouds_above",
  "clouds_below",
  "has",
  "block",
  "light_above",
  "light_below",
  "all",
  "any",
  "not",
];
const EFFECTS = [
  "give",
  "take",
  "set_block",
  "say",
  "weather",
  "spread",
  "grow",
  "impulse",
  "switch",
  "ignite",
  "douse",
  "signal",
];

// ---------------------------------------------------------------- validation

/** Agent text as one plain line: no control or bidi-override characters, runs of space collapsed. */
export function plainText(s: string): string {
  return s
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Check {
  catalog: Catalog;
  nodes: number;
  /** The trigger has a villager and a place (tool events), not just a time. */
  local: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function single(v: unknown, where: string, allowed: string[]): [string, unknown] {
  if (!isObj(v) || Object.keys(v).length !== 1) {
    throw new Error(`${where} must be an object with one key: one of ${allowed.join(", ")}.`);
  }
  const [k, val] = Object.entries(v)[0];
  if (!allowed.includes(k)) {
    throw new Error(`${where}: unknown "${k}". Use one of ${allowed.join(", ")}.`);
  }
  return [k, val];
}

function num(v: unknown, min: number, max: number, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`${where} must be a number from ${min} to ${max}.`);
  }
  return v;
}

function fields(v: unknown, keys: string[], where: string): Record<string, unknown> {
  if (!isObj(v)) throw new Error(`${where} must be an object with ${keys.join(", ")}.`);
  const extra = Object.keys(v).find((k) => !keys.includes(k));
  if (extra) throw new Error(`${where}: unknown field "${extra}". Fields: ${keys.join(", ")}.`);
  return v;
}

function offset(v: unknown, where: string): Vec3 {
  const R = RULE_LIMITS.reach;
  if (!Array.isArray(v) || v.length !== 3) {
    throw new Error(`${where} is an offset [dx, dy, dz] from the event's block, each -${R}..${R}.`);
  }
  return v.map((n, i) => Math.round(num(n, -R, R, `${where}[${i}]`))) as Vec3;
}

function item(v: unknown, c: Check, where: string): string {
  return heldMaterial(c.catalog, v, where).name;
}

/**
 * A Material a villager can hold: any live block or item Material (not a liquid), by name.
 * Underscores read as spaces, so "wheat_seeds" finds "wheat seeds".
 */
export function heldMaterial(catalog: Catalog, v: unknown, where: string): Entry {
  const raw = String(v ?? "").trim().toLowerCase();
  const e = catalog.byName(raw) ?? catalog.byName(raw.replace(/_/g, " "));
  if (!e || e.kind !== "material" || (e.content as MaterialContent).form === "liquid") {
    throw new Error(
      `${where}: "${v}" isn't something you can hold. Items are Materials, like "wheat", ` +
        '"wheat seeds", "stone" or "trout"; find more with catalog_find kind "material".',
    );
  }
  if (e.retired) throw new Error(`${where}: "${e.name}" is retired.`);
  return e;
}

/** A Design with a habitat: the kind of plant `spread` copies. Underscores read as spaces. */
function plantDesign(catalog: Catalog, v: unknown, where: string): Entry {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${where} names a plant, like "poppies" or "wheat crop".`);
  }
  const raw = v.trim().toLowerCase();
  const e = catalog.byName(raw) ?? catalog.byName(raw.replace(/_/g, " "));
  if (!e || e.kind !== "design" || !(e.content as DesignContent).habitat) {
    throw new Error(
      `${where}: "${v}" isn't a plant: a Design with a habitat, like "poppies" or "wheat crop".`,
    );
  }
  if (e.retired) throw new Error(`${where}: "${e.name}" is retired.`);
  return e;
}

function needsPlace(c: Check, where: string) {
  if (!c.local) {
    throw new Error(
      `${where} needs a villager and a place, so it only works with an event trigger.`,
    );
  }
}

function trigger(v: unknown): Trigger {
  const where = "when";
  if (!isObj(v)) {
    throw new Error('when must be {"event": ...}, {"every": minutes} or {"daily": hour}.');
  }
  if ("event" in v) {
    const o = fields(v, ["event", "what"], where);
    if (!RULE_EVENTS.includes(o.event as RuleEvent)) {
      throw new Error(`when.event must be one of ${RULE_EVENTS.join(", ")}.`);
    }
    if (o.what === undefined) return { event: o.event as RuleEvent };
    if (typeof o.what !== "string" || !o.what.trim() || o.what.length > 40) {
      throw new Error('when.what is a name to match (1-40 characters), e.g. "wheat" or "stone".');
    }
    return { event: o.event as RuleEvent, what: o.what.trim().toLowerCase() };
  }
  const [k, val] = single(v, where, ["event", "every", "daily"]);
  if (k === "every") return { every: Math.round(num(val, 10, 1440, "when.every (game minutes)")) };
  return { daily: num(val, 0, 23.99, "when.daily (hour of day)") };
}

function condition(v: unknown, c: Check, depth: number, where: string): Condition {
  if (++c.nodes > RULE_LIMITS.nodes) {
    throw new Error(`A rule has at most ${RULE_LIMITS.nodes} conditions and effects.`);
  }
  if (depth > RULE_LIMITS.depth) {
    throw new Error(`Conditions nest at most ${RULE_LIMITS.depth} deep.`);
  }
  const [k, val] = single(v, where, CONDITIONS);
  const at = `${where}.${k}`;
  switch (k) {
    case "chance":
      return { chance: num(val, 0.001, 1, at) };
    case "time": {
      if (!Array.isArray(val) || val.length !== 2) {
        throw new Error(`${at} is [from hour, to hour].`);
      }
      return { time: [num(val[0], 0, 24, `${at}[0]`), num(val[1], 0, 24, `${at}[1]`)] };
    }
    case "clouds_above":
      return { clouds_above: num(val, 0, 1, at) };
    case "clouds_below":
      return { clouds_below: num(val, 0, 1, at) };
    case "has": {
      needsPlace(c, at);
      const o = fields(val, ["item", "count"], at);
      return {
        has: {
          item: item(o.item, c, at),
          count: Math.round(num(o.count ?? 1, 1, 999, `${at}.count`)),
        },
      };
    }
    case "block": {
      needsPlace(c, at);
      const o = fields(val, ["at", "is"], at);
      const is = String(o.is ?? "").trim().toLowerCase();
      const known = is === "air" || c.catalog.byName(is)?.kind === "material";
      if (!known) throw new Error(`${at}.is must be "air" or a material, like "stone".`);
      return { block: { at: offset(o.at, `${at}.at`), is } };
    }
    case "light_above":
    case "light_below": {
      needsPlace(c, at);
      const v = num(val, 0, 1, at);
      return k === "light_above" ? { light_above: v } : { light_below: v };
    }
    case "all":
    case "any": {
      if (!Array.isArray(val) || !val.length || val.length > 8) {
        throw new Error(`${at} is a list of 1-8 conditions.`);
      }
      const list = val.map((x, i) => condition(x, c, depth + 1, `${at}[${i}]`));
      return k === "all" ? { all: list } : { any: list };
    }
    default:
      return { not: condition(val, c, depth + 1, at) };
  }
}

function effect(v: unknown, c: Check, where: string): Effect {
  if (++c.nodes > RULE_LIMITS.nodes) {
    throw new Error(`A rule has at most ${RULE_LIMITS.nodes} conditions and effects.`);
  }
  const [k, val] = single(v, where, EFFECTS);
  const at = `${where}.${k}`;
  switch (k) {
    case "give":
    case "take": {
      needsPlace(c, at);
      const o = fields(val, ["item", "count"], at);
      const max = k === "give" ? RULE_LIMITS.give : RULE_LIMITS.take;
      const it = {
        item: item(o.item, c, at),
        count: Math.round(num(o.count ?? 1, 1, max, `${at}.count`)),
      };
      return k === "give" ? { give: it } : { take: it };
    }
    case "set_block": {
      needsPlace(c, at);
      const o = fields(val, ["at", "to"], at);
      const to = String(o.to ?? "").trim().toLowerCase();
      if (to === "air") return { set_block: { at: offset(o.at, `${at}.at`), to } };
      const m = c.catalog.byName(to);
      if (m?.kind !== "material" || (m.content as MaterialContent).form !== "block") {
        throw new Error(`${at}.to must be "air" or a block material, like "cobble".`);
      }
      if (m.retired) throw new Error(`${at}.to: "${m.name}" is retired.`);
      return { set_block: { at: offset(o.at, `${at}.at`), to: m.name } };
    }
    case "say": {
      if (typeof val !== "string" || !val.trim() || val.length > 140) {
        throw new Error(`${at} is 1-140 characters of text.`);
      }
      return { say: plainText(val) };
    }
    case "spread": {
      const o = fields(val, ["what", "count"], at);
      return {
        spread: {
          what: plantDesign(c.catalog, o.what, `${at}.what`).name,
          count: Math.round(num(o.count ?? 1, 1, RULE_LIMITS.spread, `${at}.count`)),
        },
      };
    }
    case "grow": {
      const o = fields(val, ["what", "hours", "light_above"], at);
      const grow: { what: string; hours: number; light_above?: number } = {
        what: plantDesign(c.catalog, o.what, `${at}.what`).name,
        // On a timer it reaches every plant in the world, so it moves them gently.
        hours: num(
          o.hours ?? 1,
          0.1,
          c.local ? RULE_LIMITS.growHours : RULE_LIMITS.growHoursEverywhere,
          `${at}.hours`,
        ),
      };
      if (o.light_above !== undefined) {
        grow.light_above = num(o.light_above, 0, 1, `${at}.light_above`);
      }
      return { grow };
    }
    case "ignite": {
      needsPlace(c, at);
      const o = fields(val, ["at"], at);
      return { ignite: { at: offset(o.at ?? [0, 0, 0], `${at}.at`) } };
    }
    case "douse": {
      const o = fields(val ?? {}, ["what"], at);
      if (o.what === undefined) return { douse: {} };
      if (typeof o.what !== "string" || !o.what.trim() || o.what.length > 40) {
        throw new Error(`${at}.what is a name to match (1-40 characters), e.g. "oak".`);
      }
      return { douse: { what: o.what.trim().toLowerCase() } };
    }
    case "signal": {
      const o = fields(val, ["channel", "on"], at);
      if (typeof o.on !== "boolean") throw new Error(`${at}.on is true (on) or false (off).`);
      return { signal: { channel: channelName(o.channel, `${at}.channel`), on: o.on } };
    }
    case "impulse": {
      const o = fields(val, ["what", "up", "speed", "toward"], at);
      const max = c.local ? RULE_LIMITS.impulse : RULE_LIMITS.impulseEverywhere;
      const out: Impulse = {
        up: num(o.up ?? 0, 0, max, `${at}.up`),
        speed: num(o.speed ?? 0, 0, max, `${at}.speed`),
      };
      if (!out.up && !out.speed) throw new Error(`${at} needs up or speed above 0.`);
      if (o.what !== undefined) {
        if (typeof o.what !== "string" || !o.what.trim() || o.what.length > 40) {
          throw new Error(`${at}.what is a name to match (1-40 characters), e.g. "ball".`);
        }
        out.what = o.what.trim().toLowerCase();
      }
      if (o.toward !== undefined) {
        const t = String(o.toward).toLowerCase();
        if (t !== "away" && !(t in COMPASS)) {
          throw new Error(`${at}.toward is "away" or a compass direction like "east".`);
        }
        if (t === "away" && !c.local) {
          throw new Error(`${at}.toward "away" needs an event trigger.`);
        }
        out.toward = t;
      }
      if (out.speed && !out.toward && !c.local) {
        throw new Error(`${at} on a timer needs toward (a compass direction) for its speed.`);
      }
      return { impulse: out };
    }
    case "switch": {
      const o = fields(val, ["what", "on"], at);
      if (typeof o.what !== "string" || !o.what.trim() || o.what.length > 40) {
        throw new Error(`${at}.what names the Objects whose motors it switches, e.g. "windmill".`);
      }
      if (typeof o.on !== "boolean") throw new Error(`${at}.on is true (start) or false (stop).`);
      return { switch: { what: o.what.trim().toLowerCase(), on: o.on } };
    }
    default: {
      const o = fields(val, ["clouds", "hours"], at);
      return {
        weather: {
          clouds: num(o.clouds, 0, 1, `${at}.clouds`),
          hours: num(o.hours ?? 2, 0.5, RULE_LIMITS.weatherHours, `${at}.hours`),
        },
      };
    }
  }
}

export function validateRule(o: Record<string, unknown>, catalog: Catalog): RuleContent {
  const extra = Object.keys(o).find((k) => !["when", "if", "do"].includes(k));
  if (extra) throw new Error(`rule: unknown field "${extra}". A rule is {"when", "if", "do"}.`);
  const when = trigger(o.when);
  const c: Check = { catalog, nodes: 0, local: "event" in when };
  const cond = o.if === undefined || o.if === null ? null : condition(o.if, c, 1, "if");
  if (!Array.isArray(o.do) || !o.do.length || o.do.length > RULE_LIMITS.effects) {
    throw new Error(`do is a list of 1-${RULE_LIMITS.effects} effects.`);
  }
  return { when, if: cond, do: o.do.map((e, i) => effect(e, c, `do[${i}]`)) };
}

// ---------------------------------------------------------------- runtime

/** Where and to whom a Rule fires. Tool events have both; timers have neither. */
export interface RuleCtx {
  agent: Agent | null;
  x: number;
  y: number;
  z: number;
  /** What the event was about: a block, crop, fish, villager name or the words said. */
  what: string;
}

export interface RuleStat {
  fired: number;
  /** Start tick of the current game hour window and firings in it. */
  window: number;
  inWindow: number;
  /** Firings dropped by the rate cap or the step budget. */
  dropped: number;
  /** The last effect that couldn't happen, and why. */
  skipped: string;
}

const NO_PLACE: RuleCtx = { agent: null, x: 0, y: 0, z: 0, what: "" };

/**
 * Whether `text` contains `words` as whole words: "rain" matches "Oh rain!" but not "brain", and
 * "wheat" matches "wheat crop".
 */
export function saysWords(text: string, words: string): boolean {
  const norm = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  return norm(text).includes(norm(words));
}

/** The eight tiles around a plant, orthogonal first. */
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export class Rules {
  stats = new Map<number, RuleStat>();
  /** Steps left this tick. */
  budget: number = RULE_LIMITS.stepsPerTick;
  private indexed = -1;
  private indexedFor: Catalog | null = null;
  private byEvent = new Map<RuleEvent, Entry[]>();
  private timers: Entry[] = [];
  /** Tile keys of the Design a spread is copying, reused across firings. */
  private spreadKeys: number[] = [];
  /** Shuffled index into NEIGHBOURS, reused so a firing doesn't allocate. */
  private neighbourOrder = [0, 1, 2, 3, 4, 5, 6, 7];

  constructor(private readonly sim: Sim) {}

  beginTick() {
    this.budget = RULE_LIMITS.stepsPerTick;
  }

  /** A villager did something: run the Rules that listen for it. */
  fire(event: RuleEvent, ctx: RuleCtx) {
    this.index();
    const what = ctx.what.toLowerCase();
    for (const e of this.byEvent.get(event) ?? []) {
      if (e.retired) continue;
      const w = (e.content as RuleContent).when as { what?: string };
      if (w.what && !saysWords(what, w.what)) continue;
      this.run(e, ctx);
    }
  }

  /** Timer Rules: every N game minutes, or daily at an hour. */
  tick(tick: number, dayTick: number, ticksPerDay: number) {
    this.index();
    for (const e of this.timers) {
      if (e.retired) continue;
      const when = (e.content as RuleContent).when as { every?: number; daily?: number };
      const due = when.every !== undefined
        ? tick % Math.max(1, Math.round((when.every * ticksPerDay) / 1440)) === 0
        : dayTick === Math.round((when.daily! / 24) * ticksPerDay) % ticksPerDay;
      if (due) this.run(e, NO_PLACE);
    }
  }

  stat(id: number): RuleStat {
    let s = this.stats.get(id);
    if (!s) this.stats.set(id, s = { fired: 0, window: 0, inWindow: 0, dropped: 0, skipped: "" });
    return s;
  }

  private index() {
    const c = this.sim.catalog;
    if (this.indexed === c.version && this.indexedFor === c) return;
    this.indexed = c.version;
    this.indexedFor = c;
    this.byEvent.clear();
    this.timers = [];
    for (const e of c.entries) {
      if (e.kind !== "rule" || e.retired) continue;
      const when = (e.content as RuleContent).when;
      if ("event" in when) {
        const list = this.byEvent.get(when.event) ?? [];
        list.push(e);
        this.byEvent.set(when.event, list);
      } else this.timers.push(e);
    }
  }

  private run(e: Entry, ctx: RuleCtx) {
    const sim = this.sim, rule = e.content as RuleContent, s = this.stat(e.id);
    const hour = Math.round(sim.ticksPerDay / 24);
    if (sim.tick - s.window >= hour) s.window = sim.tick, s.inWindow = 0;
    if (s.inWindow >= RULE_LIMITS.firingsPerHour || this.budget <= 0) {
      s.dropped++;
      return;
    }
    this.budget--;
    if (rule.if && !this.test(rule.if, ctx)) return;
    s.fired++, s.inWindow++;
    for (const fx of rule.do) {
      if (this.budget-- <= 0) {
        s.skipped = "out of steps this tick";
        break;
      }
      const why = this.apply(fx, ctx, e);
      if (why) s.skipped = why;
    }
  }

  private test(c: Condition, ctx: RuleCtx): boolean {
    this.budget--;
    const sim = this.sim;
    if ("chance" in c) return sim.rng.next() < c.chance;
    if ("time" in c) {
      const h = sim.timeOfDay() * 24, [a, b] = c.time;
      return a <= b ? h >= a && h < b : h >= a || h < b;
    }
    if ("clouds_above" in c) return sim.clouds() > c.clouds_above;
    if ("clouds_below" in c) return sim.clouds() < c.clouds_below;
    if ("has" in c) return (ctx.agent?.inventory[c.has.item] ?? 0) >= c.has.count;
    if ("block" in c) {
      const [dx, dy, dz] = c.block.at;
      return sim.blocks.name(sim.world.get(ctx.x + dx, ctx.y + dy, ctx.z + dz)) === c.block.is;
    }
    if ("light_above" in c || "light_below" in c) {
      // At the event's cell, or the open cell over it when the event was a block (a tilled one).
      const y = solid(sim.world.get(ctx.x, ctx.y, ctx.z)) ? ctx.y + 1 : ctx.y;
      const l = sim.lightAt(ctx.x, y, ctx.z);
      return "light_above" in c ? l > c.light_above : l < c.light_below;
    }
    if ("all" in c) return c.all.every((x) => this.test(x, ctx));
    if ("any" in c) return c.any.some((x) => this.test(x, ctx));
    return !this.test(c.not, ctx);
  }

  /** Do one effect; returns why it couldn't happen, or nothing. */
  private apply(fx: Effect, ctx: RuleCtx, rule: Entry): string | void {
    const sim = this.sim, agent = ctx.agent, tag = `✦ "${rule.name}"`;
    if ("say" in fx) {
      sim.events.push({ type: "rule", agent: agent?.id ?? 0, rule: rule.name, text: fx.say });
      agent?.notes.push(`${tag}: ${fx.say}`);
      return;
    }
    if ("weather" in fx) {
      const until = sim.tick + Math.round((fx.weather.hours / 24) * sim.ticksPerDay);
      sim.weatherOverride = { clouds: fx.weather.clouds, until };
      return;
    }
    if ("spread" in fx) return this.spread(fx.spread.what, fx.spread.count);
    if ("grow" in fx) {
      return this.grow(
        fx.grow.what,
        fx.grow.hours,
        ctx === NO_PLACE ? null : ctx,
        fx.grow.light_above,
      );
    }
    if ("impulse" in fx) return this.impulse(fx.impulse, ctx === NO_PLACE ? null : ctx);
    if ("switch" in fx) return this.switch(fx.switch, ctx === NO_PLACE ? null : ctx);
    if ("douse" in fx) return this.douse(fx.douse.what, ctx === NO_PLACE ? null : ctx);
    if ("signal" in fx) {
      const near = ctx === NO_PLACE ? null : [ctx.x, ctx.y, ctx.z] as [number, number, number];
      const n = sim.signals.send(fx.signal.channel, fx.signal.on, near);
      if (!n) return `nothing on channel "${fx.signal.channel}" ${near ? "nearby" : "anywhere"}`;
      return;
    }
    if ("ignite" in fx) {
      const [dx, dy, dz] = fx.ignite.at;
      return this.ignite(ctx.x + dx, ctx.y + dy, ctx.z + dz, agent);
    }
    if (!agent) return "no villager to act on";
    if ("give" in fx) {
      const name = sim.produce(fx.give.item);
      if (!name) return `${fx.give.item} is retired`;
      agent.inventory[name] = (agent.inventory[name] ?? 0) + fx.give.count;
      agent.notes.push(`${tag} gave you ${fx.give.count} ${name}.`);
      return;
    }
    if ("take" in fx) {
      const { item, count } = fx.take;
      if ((agent.inventory[item] ?? 0) < count) return `${agent.name} had too little ${item}`;
      agent.inventory[item] -= count;
      agent.notes.push(`${tag} took ${count} ${item}.`);
      return;
    }
    const [dx, dy, dz] = fx.set_block.at;
    const x = ctx.x + dx, y = ctx.y + dy, z = ctx.z + dz;
    return this.setBlock(x, y, z, fx.set_block.to);
  }

  /**
   * Nudge the movable Objects near the event (±4, or every one on a timer, at most 16): up, and
   * sideways away from the event or toward a compass direction. They know a Rule moved them, so
   * their landing doesn't fire Rules again.
   */
  private impulse(fx: Impulse, near: RuleCtx | null): string | void {
    const sim = this.sim, reach = RULE_LIMITS.reach + 0.5;
    let n = 0;
    for (const o of sim.objects.list) {
      if (n >= RULE_LIMITS.impulseBodies) break;
      if (o.held) continue;
      const shape = sim.physics.shape(o.design);
      if (!shape || shape.fixed) continue;
      if (fx.what && !saysWords(sim.catalog.get(o.design)?.name ?? "", fx.what)) continue;
      const c = sim.physics.center(o);
      let dx = 0, dz = 0;
      if (near) {
        const ex = c[0] - (near.x + 0.5), ey = c[1] - (near.y + 0.5), ez = c[2] - (near.z + 0.5);
        if (Math.abs(ex) > reach || Math.abs(ey) > reach || Math.abs(ez) > reach) continue;
        const l = Math.hypot(ex, ez);
        if (l > 0.05) dx = ex / l, dz = ez / l;
      }
      if (fx.toward && fx.toward !== "away") [dx, dz] = COMPASS[fx.toward];
      sim.physics.wake(o);
      o.vel = [o.vel[0] + dx * fx.speed, o.vel[1] + fx.up, o.vel[2] + dz * fx.speed];
      o.quiet = true;
      n++;
    }
    if (!n) return `no ${fx.what ?? "movable Object"} ${near ? "nearby" : "anywhere"}`;
  }

  /**
   * Switch the motors of the Objects named `what` near the event (±4, or every one on a timer, at
   * most 16) on or off.
   */
  private switch(fx: { what: string; on: boolean }, near: RuleCtx | null): string | void {
    const sim = this.sim, reach = RULE_LIMITS.reach + 0.5;
    let n = 0;
    for (const o of sim.objects.list) {
      if (n >= RULE_LIMITS.switchObjects) break;
      const joints = sim.physics.assembly(o.design)?.joints ?? [];
      if (!joints.some((j) => j.kind === "motor")) continue;
      if (!saysWords(sim.catalog.get(o.design)?.name ?? "", fx.what)) continue;
      if (near) {
        const c = sim.physics.center(o);
        const ex = c[0] - (near.x + 0.5), ey = c[1] - (near.y + 0.5), ez = c[2] - (near.z + 0.5);
        if (Math.abs(ex) > reach || Math.abs(ey) > reach || Math.abs(ez) > reach) continue;
      }
      o.joints ??= joints.map(() => ({}));
      joints.forEach((j, k) => {
        if (j.kind === "motor") o.joints![k].on = fx.on;
      });
      sim.physics.wake(o);
      n++;
    }
    if (!n) return `no ${fx.what} with a motor ${near ? "nearby" : "anywhere"}`;
  }

  private setBlock(x: number, y: number, z: number, to: string): string | void {
    const sim = this.sim, w = sim.world;
    if (!w.inBounds(x, y, z) || y <= 1 || y >= w.sizeY - 2) {
      return `(${x}, ${y}, ${z}) is out of reach`;
    }
    const here = w.get(x, y, z);
    if (here === Block.Water) return "can't change water";
    if (w.propSolid[z * w.sizeX + x]) return "a tree or rock is in the way";
    if (w.objectAt[z * w.sizeX + x] && y >= w.heightAt(x, z)) return "an Object is in the way";
    const name = to === "air" ? "air" : sim.produce(to);
    if (!name) return `${to} is retired`;
    const block = name === "air" ? Block.Air : sim.blocks.byName(name)?.id;
    if (block === undefined) return `${name} can't be a block yet`;
    if (here === block) return;
    if (block !== Block.Air) {
      const body = sim.agents.find((a) =>
        Math.floor(a.x) === x && Math.floor(a.z) === z && y >= Math.floor(a.y) && y <= a.y + 1.8
      );
      if (body) return `${body.name} is standing there`;
    }
    sim.setBlock(x, y, z, block);
  }

  /**
   * Copy `count` fully grown plants of `what` onto free neighbouring tiles. `what` follows
   * `replaced_by`, and so does each existing prop, so a replaced Design spreads as its replacement.
   * Returns why nothing could be placed.
   */
  private spread(what: string, count: number): string | void {
    const sim = this.sim;
    const named = sim.catalog.byName(what);
    const design = named && sim.catalog.current(named);
    if (!design || design.kind !== "design") return `${what} is retired`;
    const info = plantInfo(sim.catalog, design.id);
    if (!info?.habitat) return `${what} isn't a plant`;
    const keys = this.spreadKeys;
    keys.length = 0;
    for (const [key, p] of sim.props.map) {
      const src = sim.catalog.get(p.design);
      const live = src && sim.catalog.current(src);
      if (live?.id === design.id) keys.push(key);
    }
    if (!keys.length) return `no ${design.name} to spread from`;
    let placed = 0, why = "";
    for (let n = 0; n < count; n++) {
      // Hashed from the tick, not the shared rng, so a spreading meadow doesn't
      // change where animals walk or whether another rule's chance comes up.
      const key = keys[Math.floor(hash2(sim.tick, n, sim.seed + design.id) * keys.length)];
      const placedKey = this.spreadFrom(key, design.id, info);
      if (typeof placedKey === "number") keys.push(placedKey), placed++;
      else why = placedKey;
    }
    if (!placed) return why;
  }

  /** Set alight whatever burns at cell (x, y, z), or on its tile. Its fire doesn't fire Rules. */
  private ignite(x: number, y: number, z: number, agent: Agent | null): string | void {
    const sim = this.sim, fire = sim.wildfire;
    const targets = [...fire.targetsAt(x, z, y), ...fire.targetsAt(x, z)];
    let why = "nothing there burns";
    for (const t of targets) {
      const no = fire.light(t, agent?.name ?? null, true);
      if (!no) return;
      if (!no.includes("doesn't burn")) why = no;
    }
    return why;
  }

  /** Put out the fires near the event (±4), or every one on a timer; only `what`, if named. */
  private douse(what: string | undefined, near: RuleCtx | null): string | void {
    const sim = this.sim, fire = sim.wildfire, r = RULE_LIMITS.reach + 0.5;
    let n = 0;
    for (const [k, b] of [...fire.burning]) {
      if (what && !saysWords(fire.nameOf(b), what)) continue;
      if (near) {
        const [x0, x1, y0, y1, z0, z1] = fire.box(b);
        const cx = (x0 + x1) / 2 - near.x - 0.5, cy = (y0 + y1) / 2 - near.y - 0.5;
        const cz = (z0 + z1) / 2 - near.z - 0.5;
        if (Math.abs(cx) > r + (x1 - x0) / 2 || Math.abs(cy) > r + (y1 - y0) / 2) continue;
        if (Math.abs(cz) > r + (z1 - z0) / 2) continue;
      }
      fire.out(k);
      n++;
    }
    if (!n) return `no ${what ?? "fire"} burning ${near ? "nearby" : "anywhere"}`;
  }

  /**
   * Bring growing crops and young plants of `what` (following replaced_by) forward by `hours`:
   * near the event, or everywhere for a timer; only where light is above `lit`, if given.
   * Returns why nothing grew.
   */
  private grow(what: string, hours: number, near: RuleCtx | null, lit?: number): string | void {
    const sim = this.sim, c = sim.catalog, size = sim.world.sizeX, w = sim.world;
    if (lit !== undefined) sim.updateLight();
    const t = sim.timeOfDay(), clouds = sim.clouds();
    const bright = (key: number) => {
      if (lit === undefined) return true;
      const x = key % size, z = Math.floor(key / size), y = w.heightAt(x, z) + 1;
      return Math.max(daylight(w, t, clouds, x, y, z), sim.light.at(x, y, z)) > lit;
    };
    const named = c.byName(what);
    const design = named && c.current(named);
    if (!design) return `${what} is retired`;
    const ticks = Math.round((hours / 24) * sim.ticksPerDay);
    const r = RULE_LIMITS.reach;
    const close = (key: number) =>
      !near ||
      (Math.abs((key % size) - near.x) <= r && Math.abs(Math.floor(key / size) - near.z) <= r);
    const live = (id: number) => {
      const e = c.get(id);
      return e && c.current(e)?.id === design.id;
    };
    let n = 0;
    for (const [key, crop] of sim.crops) {
      if (!close(key) || !live(crop.design) || sim.cropGrowth(crop) >= 1 || !bright(key)) continue;
      crop.planted -= ticks;
      n++;
    }
    if (n) sim.cropsVersion++;
    for (const [key, p] of sim.props.map) {
      if (!close(key) || !live(p.design) || sim.props.growth(p, sim.tick) >= 1) continue;
      if (!bright(key)) continue;
      sim.props.set(key % size, Math.floor(key / size), { ...p, planted: p.planted - ticks });
      n++;
    }
    if (!n) {
      return `no growing ${design.name} ${near ? "nearby" : "anywhere"}${
        lit !== undefined ? " in the light" : ""
      }`;
    }
  }

  /** Place one copy beside the plant at `key`. A new tile key, or why this source couldn't. */
  private spreadFrom(
    key: number,
    designId: number,
    info: NonNullable<ReturnType<typeof plantInfo>>,
  ): number | string {
    const sim = this.sim, w = sim.world, size = w.sizeX;
    const sx = key % size, sz = Math.floor(key / size);
    const order = this.neighbourOrder;
    for (let i = 0; i < order.length; i++) order[i] = i;
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(hash2(sx + designId, sz, sim.tick * 8 + i) * (i + 1));
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
    let crowded = false, standing = "";
    for (const i of order) {
      const [dx, dz] = NEIGHBOURS[i];
      const x = sx + dx, z = sz + dz;
      const y = w.heightAt(x, z);
      if (y < 0) continue;
      if (sim.props.at(x, z) || sim.crops.has(z * size + x) || w.objectAt[z * size + x]) continue;
      const ground = sim.blocks.name(w.get(x, y, z));
      if (habitatRefusal(w, info, x, z, ground)) continue;
      if (info.solid) {
        const body = sim.agents.find((a) => Math.floor(a.x) === x && Math.floor(a.z) === z);
        if (body) {
          standing = body.name;
          continue;
        }
      }
      if (this.crowded(x, z, designId)) {
        crowded = true;
        continue;
      }
      sim.props.set(x, z, { design: designId, planted: GROWN, grow: 0 });
      return z * size + x;
    }
    const name = info.entry.name;
    if (crowded) return `${name} is too crowded to spread`;
    if (standing) return `${standing} is standing there`;
    return `${name} had no free neighbour`;
  }

  /** True when `crowd` or more neighbours already hold this Design (following replacements). */
  private crowded(x: number, z: number, designId: number): boolean {
    const sim = this.sim;
    let n = 0;
    for (const [dx, dz] of NEIGHBOURS) {
      const p = sim.props.at(x + dx, z + dz);
      if (!p) continue;
      const src = sim.catalog.get(p.design);
      const live = src && sim.catalog.current(src);
      if (live?.id === designId && ++n >= RULE_LIMITS.crowd) return true;
    }
    return false;
  }
}
