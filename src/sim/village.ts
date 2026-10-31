import { type DesignContent, type Entry, LEVELS, NATURE } from "./catalog.ts";
import { partCost } from "./objects.ts";
import { plantInfo } from "./props.ts";
import { hash2 } from "./rng.ts";
import type { RuleEvent } from "./rules.ts";
import { type Agent, Anim, type Sim } from "./sim.ts";
import { TICK_HZ, TICKS_PER_DAY } from "./time.ts";
import { costWorth, lockedIn, unlockLevel } from "./worth.ts";

/**
 * Village Life (M12): villagers get hungry and tired (Needs), what they build and grow together
 * raises the village from camp to hamlet to village (each level Unlocks Parts and Materials), and
 * the world posts Errands anyone may take. A spectator can switch the world to Sandbox at any time:
 * needs pause, nothing is locked and no errands are posted. Nothing here ever hurts a villager.
 */

const HOUR = TICKS_PER_DAY / 24;

export const NEEDS = {
  /** Share of a full belly used up per game day awake (and asleep). */
  hunger: 1,
  /** Share of rest used up per game day awake, and on top of that while walking or working. */
  tire: 0.5,
  work: 0.6,
  /** Under this a need slows a villager: walking and working at `slow` pace (both: slow²). */
  low: 0.25,
  slow: 0.7,
  /** Game hours of sleep from exhausted to rested: in a bed, and on the ground. */
  bedHours: 4,
  groundHours: 8,
  /** A villager with no call in this long (ticks) is away: their needs hold still. */
  away: HOUR,
} as const;

/** Points each level starts at: camp, hamlet, village. */
export const LEVEL_POINTS = [0, 40, 120] as const;

export const VILLAGE_LIMITS = {
  /** Open (untaken) errands the board keeps, errands on it at most, and what one villager holds. */
  errands: 3,
  board: 6,
  held: 2,
  /** Ticks an errand stays up untaken, and how long a villager has once they take it. */
  posted: TICKS_PER_DAY * 2,
  taken: TICKS_PER_DAY,
  /** After an errand is done or lapses, the next is posted this much later. */
  gap: HOUR,
  /**
   * Items, blocks and plant-hours that villagers' Rules may conjure (give, set_block, grow) per
   * game day, across the world. Nature's Rules are free.
   */
  bounty: 24,
  /** Points for one harvested crop. */
  harvest: 0.25,
  /** Points for a Design's first build in the world: its cost in worth (a log is 1), at most. */
  firstBuild: 10,
  /** Points when a villager builds another villager's Design for the first time. */
  borrowed: 2,
} as const;

export type ErrandKind = "bring" | "build" | "harvest" | "catch" | "plant" | "sleep" | "light";

export interface Errand {
  id: number;
  kind: ErrandKind;
  /** The Material to bring or the Design to build (by name); "" for the rest. */
  what: string;
  count: number;
  done: number;
  taker: string | null;
  posted: number;
  /** The tick it's taken down if it isn't done. */
  until: number;
  points: number;
}

export interface VillageSave {
  life: boolean;
  points: number;
  level: number;
  /** Designs built in this world at least once (ids), and "design:builder" pairs credited. */
  built: number[];
  borrowed: string[];
  errands: Errand[];
  serial: number;
  nextPost: number;
  bounty: number;
  bountyDay: number;
}

/** What the spectator panel shows. */
export interface VillageStatus {
  life: boolean;
  level: string;
  points: number;
  next: number | null;
  errands: string[];
  /** [agent id, fed, rested] */
  needs: [number, number, number][];
}

/** Materials errands ask villagers to bring: [name, how many, points]. Locked ones wait. */
const BRING: [string, number, number][] = [
  ["wheat", 4, 4],
  ["log", 3, 4],
  ["planks", 8, 4],
  ["stone", 4, 4],
  ["cobble", 4, 5],
  ["berries", 6, 4],
  ["wool", 2, 6],
  ["egg", 2, 5],
  ["milk", 2, 5],
  ["clay", 4, 4],
  ["bread", 2, 6],
  ["brick", 4, 5],
];
/** Nature's Designs an errand may ask for (villagers' own Designs are asked for too). */
const BUILD = [
  "stone bench",
  "garden gate",
  "hand cart",
  "windmill",
  "torch",
  "campfire",
  "lantern post",
  "signal lever",
  "pressure plate",
  "bed",
  "oven",
];

export class Village {
  /** Village Life on; off is a Sandbox. */
  life = true;
  points = 0;
  level = 0;
  built = new Set<number>();
  borrowed = new Set<string>();
  errands: Errand[] = [];
  serial = 0;
  nextPost = 0;
  bounty: number = VILLAGE_LIMITS.bounty;
  bountyDay = 0;
  /** Bumps whenever something the panel shows changed (needs are sent anyway, once a second). */
  version = 0;

  constructor(private readonly sim: Sim) {}

  get levelName(): string {
    return LEVELS[this.level];
  }

  /** Points the next level starts at, or null at the top. */
  get nextAt(): number | null {
    return LEVEL_POINTS[this.level + 1] ?? null;
  }

  /** "a camp, 12 of 40 points to a hamlet". */
  levelText(): string {
    const next = this.nextAt;
    const pts = Math.floor(this.points * 100) / 100;
    return `a ${this.levelName}` +
      (next === null
        ? `, ${pts} points, as big as it grows`
        : `, ${pts} of ${next} points to a ${LEVELS[this.level + 1]}`);
  }

  /** Switch Village Life on, or the world to Sandbox. Everyone hears of it with their next call. */
  setLife(on: boolean) {
    if (this.life === on) return;
    this.life = on;
    this.version++;
    const text = on
      ? "Village Life is on again: needs count, the village level's Unlocks apply and errands " +
        "are posted."
      : "The world is a Sandbox now: needs pause, everything is unlocked and no errands are " +
        "posted.";
    for (const a of this.sim.agents) a.notes.push(`A spectator switched the world: ${text}`);
    this.sim.events.push({ type: "village", agent: 0, text });
    for (const a of this.sim.agents) a.pace = 1;
    if (on) this.nextPost = Math.min(this.nextPost, this.sim.tick);
  }

  /** What in `e` (a Design, Material or Part) the village hasn't unlocked yet; none in Sandbox. */
  locked(e: Entry): string[] {
    return this.life ? lockedIn(this.sim.catalog, e, this.level) : [];
  }

  /** Why `e` can't be built, crafted or placed yet, or nothing: what's locked, and when it opens. */
  lockedText(e: Entry): string | void {
    const names = this.locked(e);
    if (!names.length) return;
    const c = this.sim.catalog;
    const at = (n: string) => `a ${LEVELS[unlockLevel(c, c.byName(n)!)]}`;
    const head = names.length === 1 && names[0] === e.name
      ? `${e.name} unlocks once the village has grown into ${at(e.name)}`
      : `"${e.name}" needs ${names.map((n) => `${n} (unlocks at ${at(n)})`).join(", ")}`;
    return `${head}. The village is ${this.levelText()}; it grows with errands, harvests and ` +
      "the first build of each Design. (In a spectator's Sandbox everything is unlocked.)";
  }

  /** What's left of today's bounty for villagers' Rules. */
  bountyLeft(): number {
    this.refreshBounty();
    return this.bounty;
  }

  /** Spend `n` of the day's bounty for villagers' Rules; false when it's used up. */
  spend(n: number): boolean {
    this.refreshBounty();
    if (this.bounty <= 0) return false;
    this.bounty = Math.max(0, this.bounty - n);
    return true;
  }

  private refreshBounty() {
    const day = Math.floor(this.sim.tick / TICKS_PER_DAY);
    if (day !== this.bountyDay) this.bountyDay = day, this.bounty = VILLAGE_LIMITS.bounty;
  }

  /** Once a tick: needs, pace, errands, and the level. */
  step() {
    const sim = this.sim;
    if (sim.tick % TICK_HZ) return;
    for (const a of sim.agents) this.needs(a, TICK_HZ);
    if (!this.life) return;
    for (const e of [...this.errands]) {
      if (sim.tick >= e.until) this.lapse(e);
      else if (e.kind === "light" && e.taker) this.checkLight(e);
    }
    const open = this.errands.filter((e) => !e.taker).length;
    if (
      open < VILLAGE_LIMITS.errands && this.errands.length < VILLAGE_LIMITS.board &&
      sim.tick >= this.nextPost
    ) {
      if (this.post()) this.nextPost = sim.tick + TICK_HZ;
      else this.nextPost = sim.tick + VILLAGE_LIMITS.gap;
    }
  }

  /** Needs run down over `ticks` while a villager is around; under `low` they slow down. */
  private needs(a: Agent, ticks: number) {
    const sim = this.sim;
    if (!this.life) {
      a.pace = 1;
      return;
    }
    const around = a.queue.length > 0 || sim.tick - a.lastActive < NEEDS.away;
    if (around) {
      const days = ticks / TICKS_PER_DAY;
      const was = [a.fed, a.rested];
      const busy = a.anim !== Anim.Idle && a.anim !== Anim.Sleep && a.anim !== Anim.Eat;
      a.fed = Math.max(0, a.fed - NEEDS.hunger * days);
      if (a.sleeping === undefined) {
        a.rested = Math.max(0, a.rested - (NEEDS.tire + (busy ? NEEDS.work : 0)) * days);
      }
      this.warn(a, was[0], a.fed, "hungry", "eat something you carry (eat)");
      this.warn(a, was[1], a.rested, "tired", "sleep at night, best in a bed (sleep)");
    }
    a.pace = (a.fed < NEEDS.low ? NEEDS.slow : 1) * (a.rested < NEEDS.low ? NEEDS.slow : 1);
  }

  private warn(a: Agent, was: number, now: number, how: string, fix: string) {
    for (const mark of [NEEDS.low, 0.1, 0]) {
      if (was > mark && now <= mark) {
        a.notes.push(
          now <= 0
            ? `You're as ${how} as can be: everything takes longer until you ${fix}.`
            : `You're getting ${how} (${pct(now)}): ${fix}.` +
              (mark === NEEDS.low ? " Until then you walk and work slower." : ""),
        );
      }
    }
  }

  /** Something happened that Rules hear of: points, and errands' progress. */
  onEvent(event: RuleEvent, agent: Agent | null, what: string) {
    if (!this.life || !agent) return;
    const c = this.sim.catalog;
    if (event === "harvested") this.credit(VILLAGE_LIMITS.harvest);
    if (event === "built") {
      const named = c.byName(what), d = named && c.current(named);
      if (d?.kind === "design") this.builtDesign(agent, d);
    }
    for (const e of this.errands) {
      if (e.taker !== agent.name) continue;
      let n = 0;
      if (e.kind === "harvest" && event === "harvested") n = 1;
      else if (e.kind === "catch" && event === "caught") n = 1;
      else if (e.kind === "sleep" && event === "slept" && what === "bed") n = 1;
      else if (e.kind === "plant" && event === "planted") {
        const d = c.byName(what);
        if (d && plantInfo(c, d.id)?.solid) n = 1;
      } else if (e.kind === "build" && event === "built") {
        const want = c.byName(e.what), got = c.byName(what);
        if (want && got && (c.current(want) ?? want).id === (c.current(got) ?? got).id) n = 1;
      }
      if (n) this.progress(agent, e, n);
    }
  }

  private builtDesign(agent: Agent, d: Entry) {
    const c = this.sim.catalog, L = VILLAGE_LIMITS;
    if (!this.built.has(d.id)) {
      this.built.add(d.id);
      const content = d.content as DesignContent;
      const cost = partCost(content);
      for (const layer of content.blocks?.layers ?? []) {
        for (const row of layer) {
          for (const ch of row) {
            const m = content.blocks!.palette[ch];
            if (m) cost.set(m, (cost.get(m) ?? 0) + 1);
          }
        }
      }
      const pts = Math.min(L.firstBuild, costWorth(c, cost));
      this.credit(pts);
      agent.notes.push(
        `First "${d.name}" in the village: +${
          round(pts)
        } points. The village is ${this.levelText()}.`,
      );
    }
    const key = `${d.id}:${agent.name}`;
    if (d.author !== NATURE && d.author !== agent.name && !this.borrowed.has(key)) {
      this.borrowed.add(key);
      this.credit(L.borrowed);
      agent.notes.push(`You built ${d.author}'s "${d.name}": +${L.borrowed} points for sharing.`);
      this.sim.agents.find((a) => a.name === d.author)?.notes.push(
        `${agent.name} built your "${d.name}" Design.`,
      );
    }
  }

  /** Add points; the village grows a level when it has enough, and says what it unlocked. */
  credit(points: number) {
    if (!this.life || points <= 0) return;
    this.points += points;
    this.version++;
    while (this.nextAt !== null && this.points >= this.nextAt - 1e-9) {
      this.level++;
      const c = this.sim.catalog, name = this.levelName;
      const opened = c.entries.filter((e) =>
        (e.kind === "part" || e.kind === "material") && e.author === NATURE && !e.retired &&
        unlockLevel(c, e) === this.level
      ).map((e) => e.name);
      const text = `The village has grown into a ${name}!` +
        (opened.length ? ` Unlocked: ${opened.join(", ")}.` : "");
      for (const a of this.sim.agents) a.notes.push(text);
      this.sim.events.push({ type: "village", agent: 0, text });
    }
  }

  // ---------------------------------------------------------------- errands

  /** Post a new errand, picked from the seed, the level and the Catalog. False if none fit. */
  private post(): boolean {
    const sim = this.sim, c = sim.catalog;
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = ++this.serial;
      const r = (k: number) => hash2(id, k, sim.seed ^ 0x2e11a);
      const kinds: [ErrandKind, number][] = [
        ["bring", 3],
        ["build", 2],
        ["harvest", 1],
        ["catch", 1],
        ["plant", 1],
        ["sleep", 1],
      ];
      const lamp = c.byName("lamp");
      if (lamp && unlockLevel(c, lamp) <= this.level) kinds.push(["light", 1]);
      const total = kinds.reduce((s, [, w]) => s + w, 0);
      let pick = r(0) * total, kind: ErrandKind = "bring";
      for (const [k, w] of kinds) {
        if ((pick -= w) < 0) {
          kind = k;
          break;
        }
      }
      const e: Errand = {
        id,
        kind,
        what: "",
        count: 1,
        done: 0,
        taker: null,
        posted: sim.tick,
        until: sim.tick + VILLAGE_LIMITS.posted,
        points: 4,
      };
      const open = (x: Entry | undefined) =>
        x && c.current(x)?.id === x.id && unlockLevel(c, x) <= this.level ? x : undefined;
      if (kind === "bring") {
        const pool = BRING.filter(([name]) => open(c.byName(name)));
        if (!pool.length) continue;
        const [name, n, pts] = pool[Math.floor(r(1) * pool.length)];
        e.what = name, e.count = n, e.points = pts;
      } else if (kind === "build") {
        const ours = c.entries.filter((x) => {
          const d = x.content as DesignContent;
          return x.kind === "design" && x.author !== NATURE && !d.habitat &&
            !d.parts.some((p) => p.role) && !!open(x);
        });
        const nature = BUILD.map((n) => open(c.byName(n))).filter((x): x is Entry => !!x);
        const pool = ours.length && r(2) < 0.4 ? ours : nature;
        if (!pool.length) continue;
        const d = pool[Math.floor(r(1) * pool.length)];
        const content = d.content as DesignContent;
        const cells = (content.blocks?.layers ?? []).flat().join("").replace(/[. ]/g, "").length;
        e.what = d.name;
        e.points = 5 + Math.min(5, Math.round(costWorth(c, partCost(content)) + cells / 8));
      } else if (kind === "harvest") e.count = 4 + Math.floor(r(1) * 3) * 2, e.points = 5;
      else if (kind === "catch") e.count = 1 + Math.floor(r(1) * 3), e.points = 5;
      else if (kind === "plant") e.count = 2, e.points = 4;
      else if (kind === "light") e.points = 6;
      if (this.errands.some((x) => x.kind === e.kind && x.what === e.what)) continue;
      this.errands.push(e);
      this.version++;
      return true;
    }
    return false;
  }

  /** "Bring 4 wheat", "Build a "bed"", "Harvest 6 ripe crops"…, with how to do it unless `short`. */
  text(e: Errand, short = false): string {
    const c = this.sim.catalog;
    const s = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    switch (e.kind) {
      case "bring":
        return `Bring ${e.count} ${e.what} for the village store${short ? "" : " (errands give)"}`;
      case "build": {
        const d = c.byName(e.what);
        const whose = d && d.author !== NATURE ? ` (${d.author}'s Design)` : "";
        return `Build a "${e.what}"${whose}`;
      }
      case "harvest":
        return `Harvest ${s(e.count, "ripe crop", "ripe crops")}`;
      case "catch":
        return `Catch ${s(e.count, "fish", "fish")}`;
      case "plant":
        return `Plant ${s(e.count, "tree", "trees")} (saplings)`;
      case "sleep":
        return `Sleep a night in a bed${short ? "" : " (an hour or more)"}`;
      case "light":
        return "Stand in lamplight at night" +
          (short ? "" : " (light above 0.4 between 20:00 and 05:00)");
    }
  }

  /** One errand as a line of the board. */
  line(e: Errand, viewer: Agent | null): string {
    const sim = this.sim;
    const left = Math.max(0, e.until - sim.tick) / TICKS_PER_DAY * 24;
    const time = left >= 1 ? `${Math.round(left)}h` : `${Math.max(1, Math.round(left * 60))}m`;
    const who = e.taker === null
      ? "open"
      : e.taker === viewer?.name
      ? "yours"
      : `taken by ${e.taker}`;
    const progress = e.count > 1 && e.taker ? `, ${e.done}/${e.count}` : "";
    return `#${e.id} ${this.text(e)}: ${e.points} points and a loaf of bread (${who}${progress}, ` +
      `${time} game time left)`;
  }

  take(agent: Agent, e: Errand): string {
    if (e.taker === agent.name) throw new Error(`Errand #${e.id} is already yours.`);
    if (e.taker) throw new Error(`${e.taker} took errand #${e.id}. Pick an open one.`);
    const mine = this.errands.filter((x) => x.taker === agent.name);
    if (mine.length >= VILLAGE_LIMITS.held) {
      throw new Error(
        `You hold ${mine.length} errands already (#${mine.map((x) => x.id).join(", #")}): finish ` +
          "or drop one first.",
      );
    }
    e.taker = agent.name;
    e.until = this.sim.tick + VILLAGE_LIMITS.taken;
    this.version++;
    const how = e.kind === "bring"
      ? `When you carry ${e.count} ${e.what}, call errands with action "give" and id ${e.id}.`
      : e.kind === "light"
      ? "It's done the moment you stand in lamplight at night (lamps, torches, campfires)."
      : "What you do from now on counts toward it.";
    return `Errand #${e.id} is yours: ${this.text(e)}. ${how} You have a game day.`;
  }

  drop(agent: Agent, e: Errand): string {
    if (e.taker !== agent.name) throw new Error(`Errand #${e.id} isn't yours.`);
    e.taker = null, e.done = 0;
    e.until = Math.max(e.until, this.sim.tick + HOUR * 6);
    this.version++;
    return `You put errand #${e.id} back on the board for someone else.`;
  }

  give(agent: Agent, e: Errand): string {
    if (e.taker !== agent.name) {
      throw new Error(`Errand #${e.id} isn't yours: take it first (errands action "take").`);
    }
    if (e.kind !== "bring") {
      throw new Error(`Errand #${e.id} isn't a delivery; it counts what you do (${this.text(e)}).`);
    }
    const have = agent.inventory[e.what] ?? 0;
    if (have < e.count) {
      throw new Error(`You carry ${have} ${e.what}; errand #${e.id} wants ${e.count}.`);
    }
    agent.inventory[e.what] -= e.count;
    this.progress(agent, e, e.count); // its news comes with this result, as a note
    return `You hand over ${e.count} ${e.what}.`;
  }

  /** Count `n` toward an errand; done, it pays out. Returns the news. */
  private progress(agent: Agent, e: Errand, n: number): string | void {
    e.done = Math.min(e.count, e.done + n);
    this.version++;
    if (e.done < e.count) return;
    this.errands.splice(this.errands.indexOf(e), 1);
    this.nextPost = Math.max(this.nextPost, this.sim.tick + VILLAGE_LIMITS.gap);
    const bread = this.sim.produce("bread");
    if (bread) agent.inventory[bread] = (agent.inventory[bread] ?? 0) + 1;
    this.credit(e.points);
    const news = `Errand #${e.id} done (${this.text(e, true)}): ` +
      `+${e.points} points${bread ? ` and a loaf of ${bread}` : ""}. The village is ` +
      `${this.levelText()}.`;
    agent.notes.push(news);
    this.sim.events.push({
      type: "village",
      agent: agent.id,
      text: `finished an errand: ${this.text(e, true)}`,
    });
    return news;
  }

  private lapse(e: Errand) {
    this.errands.splice(this.errands.indexOf(e), 1);
    this.nextPost = Math.max(this.nextPost, this.sim.tick + VILLAGE_LIMITS.gap);
    this.version++;
    const taker = e.taker ? this.sim.agents.find((a) => a.name === e.taker) : undefined;
    taker?.notes.push(`Errand #${e.id} (${this.text(e)}) ran out of time; it's off the board.`);
  }

  private checkLight(e: Errand) {
    const sim = this.sim, a = sim.agents.find((x) => x.name === e.taker);
    if (!a) return;
    const h = sim.timeOfDay() * 24;
    if (h < 20 && h >= 5) return;
    const x = Math.floor(a.x), y = Math.floor(a.y + 0.05), z = Math.floor(a.z);
    sim.updateLight();
    if (sim.light.at(x, y, z) > 0.4) this.progress(a, e, 1);
  }

  // ---------------------------------------------------------------- page and save

  status(): VillageStatus {
    return {
      life: this.life,
      level: this.levelName,
      points: Math.floor(this.points * 10) / 10,
      next: this.nextAt,
      errands: this.errands.map((e) =>
        `#${e.id} ${this.text(e, true)}${e.taker ? ` · ${e.taker}` : ""}`
      ),
      needs: this.sim.agents.map((a) => [a.id, a.fed, a.rested]),
    };
  }

  save(): VillageSave {
    return structuredClone({
      life: this.life,
      points: this.points,
      level: this.level,
      built: [...this.built],
      borrowed: [...this.borrowed],
      errands: this.errands,
      serial: this.serial,
      nextPost: this.nextPost,
      bounty: this.bounty,
      bountyDay: this.bountyDay,
    });
  }

  load(s: VillageSave | undefined) {
    if (!s) return;
    const d = structuredClone(s);
    this.life = d.life, this.points = d.points, this.level = d.level;
    this.built = new Set(d.built), this.borrowed = new Set(d.borrowed);
    this.errands = d.errands, this.serial = d.serial, this.nextPost = d.nextPost;
    this.bounty = d.bounty, this.bountyDay = d.bountyDay;
  }
}

export const pct = (v: number) => `${Math.round(v * 100)}%`;
const round = (v: number) => Math.round(v * 10) / 10;
