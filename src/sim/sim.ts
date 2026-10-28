import { type Animal, type Farmer, spawnAnimals, SPECIES, stepAnimals } from "./animals.ts";
import { BlockRegistry } from "./blocks.ts";
import {
  Catalog,
  type CatalogSave,
  type DesignContent,
  type Entry,
  type MaterialContent,
} from "./catalog.ts";
import { type School, schoolFits, spawnSchools, stepSchools } from "./fish.ts";
import { perlin2 } from "./noise.ts";
import { standY } from "./path.ts";
import { type PropDiff, Props } from "./props.ts";
import { Rng } from "./rng.ts";
import { type RuleCtx, type RuleEvent, Rules, type RuleStat } from "./rules.ts";
import { Block, World } from "./world.ts";
import { generateWorld } from "./worldgen.ts";

export const TICK_HZ = 20;
/** One game day per ten real minutes at 1× speed. */
export const TICKS_PER_DAY = TICK_HZ * 600;
/** Ticks in `hours` game hours. */
export const gameHours = (hours: number) => Math.round((hours / 24) * TICKS_PER_DAY);

export const Anim = { Idle: 0, Walk: 1, Till: 2, Plant: 3, Harvest: 4, Build: 5, Fish: 6 } as const;

/** A queued tool call: a generator that advances one step per tick and returns its result text. */
export type Job = Generator<void, string, void>;

/** Pixel art an agent chose to appear as: row-major, -1 transparent, else 0xRRGGBB (sRGB). */
export interface Sprite {
  width: number;
  height: number;
  pixels: number[];
}

export interface Agent {
  id: number;
  name: string;
  color: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  anim: number;
  /** Distance walked, drives the walk cycle. */
  stride: number;
  inventory: Record<string, number>;
  journal: string[];
  /** Custom look; null means the default farmer body. */
  sprite: Sprite | null;
  /** Last tick this villager called a tool; villagers active within a game day vote. */
  lastActive: number;
  /** Ticks of recent Catalog entries this villager added (rate limit). */
  authored: number[];
  /** Things Rules did to this villager, told with the next tool result. Not saved. */
  notes: string[];
  queue: { callId: number; job: Job }[];
}

/** A plant on farmland: drawn as a field of stalks, harvested when ripe. */
export interface Crop {
  /** The Design entry it grows into. */
  design: number;
  planted: number;
  /** Ticks to ripen, fixed when planted. */
  grow: number;
}

export type SimEvent =
  | { type: "say"; agent: number; text: string }
  | { type: "joined"; agent: number }
  | { type: "catch"; agent: number; fish: string }
  /** A Rule's `say` effect; agent is 0 for timer Rules. */
  | { type: "rule"; agent: number; rule: string; text: string }
  /** Catalog news: entries added, proposals opened, votes, outcomes. */
  | { type: "catalog"; agent: number; text: string };

export interface CallResult {
  callId: number;
  text: string;
  isError: boolean;
}

/** Everything needed to restore a world. Generated terrain is rebuilt from the seed. */
export interface SaveData {
  version: 2;
  seed: number;
  tick: number;
  dayOffset: number;
  savedAt: number;
  edits: number[];
  /** [tile key, design, planted, grow] */
  crops: [number, number, number, number][];
  agents: Omit<Agent, "queue" | "anim" | "stride" | "notes">[];
  /** Trees, rocks, flowers etc. that differ from generation. */
  props?: PropDiff;
  /** Missing in old saves: those worlds get freshly spawned herds. */
  animals?: Animal[];
  schools?: School[];
  weatherOverride?: { clouds: number; until: number } | null;
  /** Missing in saves from before the Catalog: those worlds get nature's entries. */
  catalog?: CatalogSave;
  ruleStats?: [number, RuleStat][];
  /** MCP session → agent id, so connected agents survive a page reload. */
  sessions: [string, number][];
}

/**
 * Deterministic world state. Advances only through `step()` and inputs
 * (tool calls, time changes); never reads clocks or Math.random.
 */
export class Sim {
  tick = 0;
  /** Shifts the clock so a new world starts in the morning. */
  dayOffset = Math.round(TICKS_PER_DAY * 0.3);
  readonly world: World;
  readonly props: Props;
  animals: Animal[];
  /** Fish schools in rivers and the sea. */
  schools: School[];
  /** Kinds of things that can exist (ADR 0003); the World holds the things that do. */
  catalog = Catalog.create();
  private registry = new BlockRegistry();
  readonly rules: Rules = new Rules(this);
  readonly ticksPerDay = TICKS_PER_DAY;
  readonly agents: Agent[] = [];
  readonly sessions = new Map<string, Agent>();
  readonly crops = new Map<number, Crop>();
  /** Block index → block for every cell that differs from generation. */
  readonly edits = new Map<number, number>();
  /** Outbox drained by the host after each batch of steps. */
  pendingEdits: number[] = [];
  events: SimEvent[] = [];
  results: CallResult[] = [];
  cropsVersion = 0;
  /** An agent-set cloud cover that holds until `until` (a tick), then the weather drifts again. */
  weatherOverride: { clouds: number; until: number } | null = null;
  agentsVersion = 0;
  readonly rng: Rng;

  constructor(readonly seed: number) {
    this.world = generateWorld({ seed });
    this.props = new Props(this.world, seed, this.catalog);
    this.animals = spawnAnimals(this.world, seed);
    this.schools = spawnSchools(this.world, seed);
    this.rng = new Rng(seed ^ 0x5eed);
  }

  /** Block ids for the Catalog's Materials, kept in step with the Catalog. */
  get blocks(): BlockRegistry {
    return this.registry.sync(this.catalog);
  }

  timeOfDay(): number {
    return ((this.tick + this.dayOffset) % TICKS_PER_DAY) / TICKS_PER_DAY;
  }

  day(): number {
    return Math.floor((this.tick + this.dayOffset) / TICKS_PER_DAY) + 1;
  }

  /** Cloud cover 0-1: slow natural drift over the days unless an agent set the weather. */
  clouds(): number {
    if (this.weatherOverride && this.tick < this.weatherOverride.until) {
      return this.weatherOverride.clouds;
    }
    const days = (this.tick + this.dayOffset) / TICKS_PER_DAY;
    return Math.min(1, Math.max(0, 0.35 + perlin2(days * 1.7, 0.5, this.seed + 3) * 0.9));
  }

  setTimeOfDay(t: number) {
    const now = (this.tick + this.dayOffset) % TICKS_PER_DAY;
    let delta = Math.round(t * TICKS_PER_DAY) - now;
    if (delta < 0) delta += TICKS_PER_DAY; // only move forward so days never repeat
    this.dayOffset += delta;
  }

  setBlock(x: number, y: number, z: number, block: number) {
    const w = this.world;
    if (!w.inBounds(x, y, z)) return;
    w.set(x, y, z, block);
    this.edits.set(w.index(x, y, z), block);
    this.pendingEdits.push(x, y, z, block);
    const key = z * w.sizeX + x;
    if (this.crops.has(key) && w.get(x, w.heightAt(x, z), z) !== Block.Farmland) {
      this.crops.delete(key);
      this.cropsVersion++;
    }
    // Whatever stood on the column (flowers, a lily pad) goes with the change.
    if (this.props.at(x, z)) this.props.set(x, z, null);
  }

  cropGrowth(crop: Crop): number {
    return crop.grow ? Math.min(1, (this.tick - crop.planted) / crop.grow) : 1;
  }

  addAgent(name: string): Agent {
    const [x, z] = this.findSpawn();
    const agent: Agent = {
      id: this.agents.length + 1,
      name,
      color: this.agents.length,
      x: x + 0.5,
      y: this.world.surfaceY(x + 0.5, z + 0.5),
      z: z + 0.5,
      yaw: 0,
      anim: Anim.Idle,
      stride: 0,
      inventory: this.starterKit(),
      journal: [],
      sprite: null,
      lastActive: this.tick,
      authored: [],
      notes: [],
      queue: [],
    };
    this.agents.push(agent);
    this.agentsVersion++;
    this.events.push({ type: "joined", agent: agent.id });
    return agent;
  }

  enqueue(agent: Agent, callId: number, job: Job) {
    agent.queue.push({ callId, job });
  }

  /** Villagers who acted within the last game day: the ones a Proposal waits for. */
  activeVillagers(): string[] {
    return this.agents.filter((a) => this.tick - a.lastActive <= TICKS_PER_DAY).map((a) => a.name);
  }

  /** What the world produces for `item`: itself, its replacement, or null if it's retired. */
  produce(item: string): string | null {
    const entry = this.catalog.byName(item);
    if (!entry) return item;
    return this.catalog.current(entry)?.name ?? null;
  }

  /**
   * What breaking, harvesting or collecting `entry` gives, from its `drops` Relations, each
   * following `replaced_by`. A block Material without drops gives itself.
   */
  drops(entry: Entry): [string, number][] {
    const c = this.catalog, links = c.links(entry.id, "drops");
    if (!links.length && entry.kind === "material") {
      const self = c.current(entry)?.name;
      return self ? [[self, 1]] : [];
    }
    const out: [string, number][] = [];
    for (const { entry: e, rel } of links) {
      const name = c.current(e)?.name;
      if (name) out.push([name, rel.count]);
    }
    return out;
  }

  /**
   * Stalk and ripe-ear colors for a crop's Design, as sRGB integers. A replaced Design (and a
   * replaced drop) changes the color, so a field planted earlier still follows the Catalog.
   */
  private cropLooks: { version: number; byDesign: Map<number, [number, number]> } = {
    version: -1,
    byDesign: new Map(),
  };
  cropColors(designId: number): [number, number] {
    const c = this.catalog;
    if (this.cropLooks.version !== c.version) {
      this.cropLooks = { version: c.version, byDesign: new Map() };
    }
    let look = this.cropLooks.byDesign.get(designId);
    if (look) return look;
    const stored = c.get(designId);
    const e = (stored && c.current(stored)) || stored;
    const color = (name: string | undefined) => {
      const m = name ? c.byName(name)?.content as MaterialContent | undefined : undefined;
      return m?.color ? parseInt(m.color.slice(1), 16) : 0x619441;
    };
    const stalk = color((e?.content as DesignContent | undefined)?.parts[0]?.material);
    const drop = e ? this.drops(e)[0]?.[0] : undefined;
    look = [stalk, drop ? color(drop) : stalk];
    this.cropLooks.byDesign.set(designId, look);
    return look;
  }

  /** A new villager's things: seeds and a sapling of each tree, as the Catalog now names them. */
  private starterKit(): Record<string, number> {
    const kit: Record<string, number> = {};
    const kitList: [string, number][] = [
      ["wheat seeds", 16],
      ["oak sapling", 1],
      ["birch sapling", 1],
      ["pine sapling", 1],
    ];
    for (const [item, n] of kitList) {
      const name = this.produce(item);
      if (name) kit[name] = (kit[name] ?? 0) + n;
    }
    return kit;
  }

  /** Materials that are food for each species (`is_food_for` its Design), per Catalog version. */
  private foods: { version: number; bySpecies: string[][] } = { version: -1, bySpecies: [] };
  foodFor(species: number): string[] {
    const c = this.catalog;
    if (this.foods.version !== c.version) {
      this.foods = {
        version: c.version,
        bySpecies: SPECIES.map((def) => {
          const body = c.byName(def.name);
          if (!body) return [];
          return c.links(body.id, "is_food_for", true)
            .map(({ entry }) => c.current(entry))
            .filter((e): e is Entry => e?.kind === "material")
            .map((e) => e.name);
        }),
      };
    }
    return this.foods.bySpecies[species] ?? [];
  }

  /** Whether `name` is a Material villagers can hold (not a liquid). */
  holdable(name: string): boolean {
    const e = this.catalog.byName(name);
    return e?.kind === "material" && (e.content as MaterialContent).form !== "liquid";
  }

  /** A villager did something Rules can listen for, at block (x, y, z). */
  fire(event: RuleEvent, agent: Agent | null, x: number, y: number, z: number, what: string) {
    const ctx: RuleCtx = { agent, x, y, z, what };
    this.rules.fire(event, ctx);
  }

  /** Close proposals that are due and announce the outcome. */
  settleProposals() {
    for (const p of this.catalog.settle(this.tick, this.activeVillagers())) {
      const e = this.catalog.get(p.entry)!;
      const what = p.action === "retire"
        ? `retire "${e.name}"`
        : `replace "${e.name}" with "${this.catalog.get(p.replacement!)!.name}"`;
      this.events.push({
        type: "catalog",
        agent: 0,
        text: `Proposal #${p.id} to ${what} ${p.status} (${p.outcome}).`,
      });
    }
  }

  /** Report a call's result, with whatever Rules did to the villager meanwhile. */
  finish(agent: Agent | null, callId: number, text: string, isError: boolean) {
    if (agent?.notes.length) text += "\n" + agent.notes.splice(0).join("\n");
    this.results.push({ callId, text, isError });
  }

  step() {
    this.tick++;
    this.rules.beginTick();
    this.stepAnimals();
    stepSchools(this.schools, this.world, this.rng, this.tick, TICK_HZ);
    for (const agent of this.agents) {
      // Bodies follow the ground: slopes while walking, edits while standing still.
      agent.y += (standY(this.world, agent.x, agent.z, agent.y) - agent.y) * 0.35;
      const current = agent.queue[0];
      if (!current) continue;
      try {
        const r = current.job.next();
        if (!r.done) continue;
        this.finish(agent, current.callId, r.value, false);
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        this.finish(agent, current.callId, text, true);
      }
      agent.queue.shift();
      agent.anim = Anim.Idle;
    }
    this.rules.tick(this.tick, (this.tick + this.dayOffset) % TICKS_PER_DAY, TICKS_PER_DAY);
    if (this.tick % TICK_HZ === 0 && this.catalog.open().length) this.settleProposals();
  }

  private farmers: Farmer[] = [];

  private stepAnimals() {
    const f = this.farmers;
    f.length = this.agents.length;
    this.agents.forEach((a, i) => {
      const o = f[i] ??= { x: 0, z: 0, moving: false, food: 0 };
      o.x = a.x, o.z = a.z, o.moving = a.anim === Anim.Walk;
      o.food = 0;
      SPECIES.forEach((_, s) => {
        if (this.foodFor(s).some((item) => (a.inventory[item] ?? 0) > 0)) o.food |= 1 << s;
      });
    });
    const t = this.timeOfDay();
    stepAnimals(this.animals, this.world, this.rng, f, t < 0.2 || t > 0.86, TICK_HZ);
  }

  /** Spread arrivals around the world center on flat grass. */
  private findSpawn(): [number, number] {
    const w = this.world;
    const cx = w.sizeX >> 1, cz = w.sizeZ >> 1;
    for (let r = 0; r < 64; r++) {
      for (let tries = 0; tries < 16; tries++) {
        const x = cx + Math.round(this.rng.range(-r, r) + this.agents.length * 3);
        const z = cz + Math.round(this.rng.range(-r, r));
        const h = w.heightAt(x, z);
        const flat = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) =>
          w.heightAt(x + dx, z + dz) === h
        );
        const free = !w.propSolid[z * w.sizeX + x];
        if (h >= 0 && flat && free && w.get(x, h, z) === Block.Grass) return [x, z];
      }
    }
    return [cx, cz];
  }

  save(savedAt: number): SaveData {
    return {
      version: 2,
      seed: this.seed,
      tick: this.tick,
      dayOffset: this.dayOffset,
      savedAt,
      edits: [...this.edits].flat(),
      crops: [...this.crops].map(([key, c]) => [key, c.design, c.planted, c.grow]),
      props: this.props.diff(),
      animals: structuredClone(this.animals),
      schools: structuredClone(this.schools),
      weatherOverride: this.weatherOverride,
      catalog: this.catalog.save(),
      ruleStats: structuredClone([...this.rules.stats]),
      sessions: [...this.sessions].map(([session, agent]) => [session, agent.id]),
      agents: this.agents.map(({ queue: _q, anim: _a, stride: _s, notes: _n, ...rest }) =>
        structuredClone(rest)
      ),
    };
  }

  static load(data: SaveData): Sim {
    const sim = new Sim(data.seed);
    sim.tick = data.tick;
    sim.weatherOverride = data.weatherOverride ?? null;
    if (data.catalog) sim.catalog = Catalog.load(data.catalog);
    sim.props.catalog = sim.catalog;
    for (const [id, stat] of data.ruleStats ?? []) sim.rules.stats.set(id, structuredClone(stat));
    sim.dayOffset = data.dayOffset;
    const w = sim.world;
    for (let i = 0; i < data.edits.length; i += 2) {
      const index = data.edits[i], block = data.edits[i + 1];
      const x = index % w.sizeX;
      const z = Math.floor(index / w.sizeX) % w.sizeZ;
      const y = Math.floor(index / (w.sizeX * w.sizeZ));
      sim.setBlock(x, y, z, block);
    }
    if (data.props) sim.props.applyDiff(data.props);
    if (data.animals) sim.animals = structuredClone(data.animals);
    // Saves from before a placement change get fresh schools.
    if (data.schools?.every((f) => schoolFits(sim.world, f))) {
      sim.schools = structuredClone(data.schools);
    }
    for (const [key, design, planted, grow] of data.crops) {
      sim.crops.set(key, { design, planted, grow });
    }
    for (const a of data.agents) {
      const agent = structuredClone(a);
      sim.agents.push({
        ...agent,
        sprite: agent.sprite ?? null,
        lastActive: agent.lastActive ?? 0,
        authored: agent.authored ?? [],
        notes: [],
        anim: Anim.Idle,
        stride: 0,
        queue: [],
      });
    }
    for (const [session, id] of data.sessions ?? []) {
      const agent = sim.agents.find((a) => a.id === id);
      if (agent) sim.sessions.set(session, agent);
    }
    sim.pendingEdits = [];
    sim.events = [];
    return sim;
  }
}
