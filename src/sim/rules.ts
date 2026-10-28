import type { Catalog, Entry, MaterialContent, Vec3 } from "./catalog.ts";
import type { Agent, Sim } from "./sim.ts";
import { Block } from "./world.ts";

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
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export type Effect =
  | { give: { item: string; count: number } }
  | { take: { item: string; count: number } }
  | { set_block: { at: Vec3; to: string } }
  | { say: string }
  | { weather: { clouds: number; hours: number } };

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
  weatherHours: 12,
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
  "all",
  "any",
  "not",
];
const EFFECTS = ["give", "take", "set_block", "say", "weather"];

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

export class Rules {
  stats = new Map<number, RuleStat>();
  /** Steps left this tick. */
  budget: number = RULE_LIMITS.stepsPerTick;
  private indexed = -1;
  private indexedFor: Catalog | null = null;
  private byEvent = new Map<RuleEvent, Entry[]>();
  private timers: Entry[] = [];

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

  private setBlock(x: number, y: number, z: number, to: string): string | void {
    const sim = this.sim, w = sim.world;
    if (!w.inBounds(x, y, z) || y <= 1 || y >= w.sizeY - 2) {
      return `(${x}, ${y}, ${z}) is out of reach`;
    }
    const here = w.get(x, y, z);
    if (here === Block.Water) return "can't change water";
    if (w.propSolid[z * w.sizeX + x]) return "a tree or rock is in the way";
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
}
