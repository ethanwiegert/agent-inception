import {
  type Animal,
  AnimalMode,
  type Farmer,
  spawnAnimals,
  SPECIES,
  stepAnimals,
} from "./animals.ts";
import { BlockRegistry } from "./blocks.ts";
import {
  Catalog,
  type CatalogSave,
  type DesignContent,
  type Entry,
  type MaterialContent,
} from "./catalog.ts";
import { Fire, type FireSave } from "./fire.ts";
import { type School, schoolFits, spawnSchools, stepSchools } from "./fish.ts";
import { daylight, LightField, lightSources } from "./light.ts";
import { perlin2 } from "./noise.ts";
import { Objects, type WorldObject } from "./objects.ts";
import { levelAt, standY, step as stepTo } from "./path.ts";
import { foldPieces, type Mover, Physics, quatMul, yawQuat as yawQuatOf } from "./physics.ts";
import { type PropDiff, Props } from "./props.ts";
import { Rng } from "./rng.ts";
import { type RuleCtx, type RuleEvent, Rules, type RuleStat } from "./rules.ts";
import { Signals } from "./signals.ts";
import { TICK_HZ, TICKS_PER_DAY } from "./time.ts";
import { Village, type VillageSave } from "./village.ts";
import { Board, type BoardSave } from "./board.ts";
import { Block, World } from "./world.ts";
import { generateWorld } from "./worldgen.ts";

export { gameHours, TICK_HZ, TICKS_PER_DAY } from "./time.ts";

export const Anim = {
  Idle: 0,
  Walk: 1,
  Till: 2,
  Plant: 3,
  Harvest: 4,
  Build: 5,
  Fish: 6,
  /** Knocked over by something heavy, getting back up. */
  Fall: 7,
  /** Asleep, lying down. */
  Sleep: 8,
  Eat: 9,
} as const;

/** A blow this fast (blocks/s) with this much momentum (tonne · blocks/s) knocks a villager over. */
export const KNOCK_SPEED = 1.5;
export const KNOCK_MOMENTUM = 0.12;
/** Ticks a knocked-over villager stays down, and after that can't be knocked over again. */
export const DOWN_TICKS = 40;
export const GRACE_TICKS = 200;
/** Objects at least this heavy (tonnes) stay put when stood on; lighter ones are walked around. */
export const STEADY_MASS = 0.6;

/** A queued tool call: a generator that advances one step per tick and returns its result text. */
export type Job = Generator<void, string, void>;

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
  /** The Design this villager looks like; null means the default farmer, in their own tints. */
  body: number | null;
  /** Last tick this villager called a tool; villagers active within a game day vote. */
  lastActive: number;
  /** Ticks of recent Catalog entries this villager added (rate limit). */
  authored: number[];
  /** Approaching animals slowly (to shear, milk or collect), so they don't shy away. Not saved. */
  gentle?: boolean;
  /** Things Rules did to this villager, told with the next tool result. Not saved. */
  notes: string[];
  /** Knocked over until this tick (their job waits), and safe from it again until graceUntil. */
  downUntil?: number;
  graceUntil?: number;
  /** What they were doing when knocked over, and which way they're sliding. */
  resume?: number;
  knock?: [number, number];
  /** The Object they're pushing (it doesn't knock them over). Not saved. */
  pushing?: number;
  /** Needs (Village Life), 0-1: a full belly, and rest. */
  fed: number;
  rested: number;
  /** Walking and working pace, 1 unless a need is low. Not saved. */
  pace?: number;
  /** Asleep: the bed Object they lie on, or 0 on the ground. Not saved. */
  sleeping?: number;
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
  | { type: "catalog"; agent: number; text: string }
  /** Something physical happened to a villager: knocked over, dropped what they carried. */
  | { type: "physics"; agent: number; text: string }
  /** Village Life news: the village grew, an errand was done, the spectator switched modes. */
  | { type: "village"; agent: number; text: string }
  /** The Notice Board: a spectator pinned a Wish (agent 0), a villager replied or marked one done. */
  | { type: "board"; agent: number; wish: number; text: string }
  /** A signal ran from a sender (or a Rule's event) to receivers (flat x, y, z). */
  | { type: "signal"; from: [number, number, number]; to: number[]; on: boolean };

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
  agents: Omit<Agent, "queue" | "anim" | "stride" | "notes" | "pace" | "sleeping">[];
  /** Trees, rocks, flowers etc. that differ from generation. */
  props?: PropDiff;
  /** Objects villagers built from Designs' parts. */
  objects?: WorldObject[];
  /** Missing in old saves: those worlds get freshly spawned herds. */
  animals?: Animal[];
  schools?: School[];
  weatherOverride?: { clouds: number; until: number } | null;
  /** Missing in saves from before the Catalog: those worlds get nature's entries. */
  catalog?: CatalogSave;
  ruleStats?: [number, RuleStat][];
  /** What's burning, and the fires it belongs to. */
  fire?: FireSave;
  /** Village Life: on or Sandbox, points, level, errands. Missing before M12. */
  village?: VillageSave;
  /** The Notice Board's Wishes. Missing before M13. */
  board?: BoardSave;
  /** Cloud cover a spectator holds the weather at, or null for natural. Missing before M13. */
  spectatorClouds?: number | null;
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
  /** Designs built from Parts: benches, fences, statues (static until physics phase 2). */
  readonly objects: Objects;
  /** Rigid bodies: every movable Object falls, stacks, rolls and floats here. */
  readonly physics: Physics;
  /** Bumps whenever an Object moved (the page gets every pose again). */
  posesVersion = 0;
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
  /** Light from lamps, flames, fire and glowing blocks (daylight is worked out on its own). */
  readonly light: LightField;
  /** Block indices of glowing blocks (only villagers' blocks glow, so they're all edits). */
  readonly glowing = new Set<number>();
  /** Wild fire: what burns now. */
  readonly wildfire: Fire = new Fire(this);
  readonly signals: Signals = new Signals(this);
  readonly village: Village = new Village(this);
  readonly board: Board = new Board(this);
  /** Cloud cover a spectator holds the weather at (it wins over Rules), or null: natural. */
  spectatorClouds: number | null = null;

  constructor(readonly seed: number) {
    this.world = generateWorld({ seed });
    this.props = new Props(this.world, seed, this.catalog);
    this.objects = new Objects(this.world, this.catalog);
    this.physics = new Physics(this.world, this.catalog);
    this.objects.steady = (o) => {
      const a = this.physics.assembly(o.design);
      return !a || a.shapes[0].fixed || a.mass >= STEADY_MASS;
    };
    this.animals = spawnAnimals(this.world, seed);
    this.schools = spawnSchools(this.world, seed);
    this.rng = new Rng(seed ^ 0x5eed);
    this.light = new LightField(this.world);
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

  /**
   * Cloud cover 0-1: slow natural drift over the days unless a spectator holds the weather, or an
   * agent's Rule set it for a while.
   */
  clouds(): number {
    if (this.spectatorClouds !== null) return this.spectatorClouds;
    if (this.weatherOverride && this.tick < this.weatherOverride.until) {
      return this.weatherOverride.clouds;
    }
    const days = (this.tick + this.dayOffset) / TICKS_PER_DAY;
    return Math.min(1, Math.max(0, 0.35 + perlin2(days * 1.7, 0.5, this.seed + 3) * 0.9));
  }

  /** A spectator holds the sky at `clouds` (0-1), or lets the weather drift again (null). */
  setWeather(clouds: number | null) {
    const held = clouds === null || !Number.isFinite(clouds)
      ? null
      : Math.min(1, Math.max(0, clouds));
    if (held === this.spectatorClouds) return;
    this.spectatorClouds = held;
    this.events.push({
      type: "village",
      agent: 0,
      text: held === null
        ? "the weather drifts on its own again"
        : `a spectator set the sky to ${held < 0.2 ? "clear" : held < 0.7 ? "cloudy" : "overcast"}`,
    });
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
    const index = w.index(x, y, z);
    this.edits.set(index, block);
    if (this.blocks.get(block)?.glows) this.glowing.add(index);
    else this.glowing.delete(index);
    this.light.blockChanged(x, y, z);
    this.pendingEdits.push(x, y, z, block);
    const key = z * w.sizeX + x;
    if (this.crops.has(key) && w.get(x, w.heightAt(x, z), z) !== Block.Farmland) {
      this.crops.delete(key);
      this.cropsVersion++;
    }
    // Whatever stood on the column (flowers, a lily pad) goes with the change.
    if (this.props.at(x, z)) this.props.set(x, z, null);
    // An Object over the column stands on the new ground, and anything nearby may now fall.
    if (w.objectAt[key]) this.objects.refresh(x, z);
    this.physics.wakeNear(this.objects.list, x + 0.5, y + 0.5, z + 0.5, 1.5);
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
      body: null,
      lastActive: this.tick,
      authored: [],
      notes: [],
      queue: [],
      fed: 1,
      rested: 1,
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
    this.village.onEvent(event, agent, what);
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
      // Bodies follow the ground: slopes while walking, edits while standing still. A sleeper
      // lies where their bed holds them.
      if (agent.sleeping === undefined) {
        agent.y += (standY(this.world, agent.x, agent.z, agent.y) - agent.y) * 0.35;
      }
      if (this.down(agent)) continue;
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
    this.stepBodies();
    this.wildfire.step();
    this.signals.step();
    this.village.step();
    this.board.step();
    this.rules.tick(this.tick, (this.tick + this.dayOffset) % TICKS_PER_DAY, TICKS_PER_DAY);
    if (this.tick % TICK_HZ === 0 && this.catalog.open().length) this.settleProposals();
  }

  private farmers: Farmer[] = [];
  private movers: Mover[] = [];
  /** Where each villager and animal stood last tick, for their velocity. */
  private lastAt = new Float64Array(0);

  /** Whether `agent` is knocked over this tick (sliding, then getting up); their job waits. */
  private down(agent: Agent): boolean {
    if (agent.downUntil === undefined) return false;
    if (this.tick >= agent.downUntil) {
      agent.anim = agent.resume ?? Anim.Idle;
      delete agent.downUntil, delete agent.resume, delete agent.knock;
      return false;
    }
    agent.anim = Anim.Fall;
    const left = agent.downUntil - this.tick;
    if (agent.knock && left > DOWN_TICKS - 10) {
      // Knocked back half a block over the first half second, if there's ground to slide onto.
      const nx = agent.x + agent.knock[0] * 0.05, nz = agent.z + agent.knock[1] * 0.05;
      const w = this.world, tx = Math.floor(nx), tz = Math.floor(nz);
      const same = tx === Math.floor(agent.x) && tz === Math.floor(agent.z);
      const level = levelAt(w, Math.floor(agent.x), Math.floor(agent.z), agent.y);
      if (same || (level >= 0 && stepTo(w, level, tx, tz) >= 0)) agent.x = nx, agent.z = nz;
    }
    return true;
  }

  /**
   * How lit cell (x, y, z) is, 0-1: daylight (dimmed under a roof and by clouds) or the light of
   * lamps, flames, fire and glowing blocks, whichever is brighter.
   */
  lightAt(x: number, y: number, z: number): number {
    this.updateLight();
    const day = daylight(this.world, this.timeOfDay(), this.clouds(), x, y, z);
    return Math.max(day, this.light.at(x, y, z));
  }

  /** Bring the light field up to date with every source in the world. */
  updateLight() {
    const fire = this.wildfire;
    this.light.update(lightSources({
      catalog: this.catalog,
      objects: this.objects.list,
      world: this.world,
      blocks: this.blocks,
      glowing: this.glowing,
      fires: [...fire.burning].map(([key, b]) => {
        const [x0, x1, y0, y1, z0, z1] = fire.box(b);
        return { key, x: (x0 + x1) / 2, y: y0 + (y1 - y0) * 0.6, z: (z0 + z1) / 2 };
      }),
    }));
  }

  /** Take an Object out of the world for good (burnt, or taken apart). */
  removeObject(o: WorldObject) {
    if (o.held) {
      const by = this.agents.find((a) => a.id === o.held);
      if (by) this.release(by, o);
    }
    this.objects.remove(o);
    this.physics.forget(o.id);
  }

  /** The Object `agent` carries overhead, if any. */
  carried(agent: Agent): WorldObject | undefined {
    return this.objects.list.find((o) => o.held === agent.id);
  }

  /** Hold a carried Object over its villager's head, turning with them. */
  private holdUp(agent: Agent, o: WorldObject) {
    const rot = yawQuatOf(agent.yaw);
    o.rot = quatMul(rot, o.heldTurn ?? [0, 0, 0, 1]);
    const c = this.physics.center({ ...o, pos: [0, 0, 0] });
    const low = this.physics.lowest(o.design, o.rot);
    // Its lowest point just over the head (and hat), centered over the villager.
    o.pos = [agent.x - c[0], agent.y + 2.2 - low - c[1], agent.z - c[2]];
    o.vel = [0, 0, 0], o.spin = [0, 0, 0];
    foldPieces(o);
  }

  /** Let go of a carried Object where it is, moving as the villager was. */
  release(agent: Agent, o: WorldObject, why?: string) {
    delete o.held, delete o.heldTurn;
    o.asleep = false;
    o.mover = agent.name;
    this.physics.wake(o);
    this.objects.raster(o);
    this.objects.version++;
    if (why) {
      const name = this.catalog.get(o.design)?.name ?? "Object";
      this.events.push({ type: "physics", agent: agent.id, text: `dropped the ${name} (${why})` });
    }
  }

  /** Bodies: carried ones ride overhead, the rest fall, collide and settle; then their effects. */
  private stepBodies() {
    const objects = this.objects, list = objects.list;
    if (!list.length) return;
    const agents = this.agents, animals = this.animals, n = agents.length + animals.length;
    if (this.lastAt.length !== n * 3) {
      this.lastAt = new Float64Array(n * 3);
      agents.forEach((a, i) => this.lastAt.set([a.x, a.y, a.z], i * 3));
      animals.forEach((a, i) => this.lastAt.set([a.x, a.y, a.z], (agents.length + i) * 3));
    }
    const movers = this.movers;
    movers.length = n;
    const put = (
      i: number,
      x: number,
      y: number,
      z: number,
      r: number,
      top: number,
      shove: number,
    ) => {
      const m = movers[i] ??= {
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        radius: 0,
        bottom: 0,
        top: 0,
        shove: 0,
        ignore: 0,
      };
      const l = this.lastAt;
      m.vx = (x - l[i * 3]) * TICK_HZ, m.vy = (y - l[i * 3 + 1]) * TICK_HZ;
      m.vz = (z - l[i * 3 + 2]) * TICK_HZ;
      m.x = x, m.y = y, m.z = z, m.radius = r, m.bottom = 0.15, m.top = top, m.shove = shove;
      l[i * 3] = x, l[i * 3 + 1] = y, l[i * 3 + 2] = z;
    };
    agents.forEach((a, i) => {
      put(i, a.x, a.y, a.z, 0.3, a.anim === Anim.Fall ? 0.7 : 1.75, 4);
      movers[i].ignore = a.pushing ?? 0;
    });
    animals.forEach((a, i) => {
      put(agents.length + i, a.x, a.y, a.z, 0.35, 1, 4);
      movers[agents.length + i].ignore = 0;
    });
    for (const a of agents) {
      const o = this.carried(a);
      if (o) this.holdUp(a, o), this.posesVersion++;
    }
    const physics = this.physics;
    physics.step(list, movers, 1 / TICK_HZ);
    if (physics.moved.length) this.posesVersion++;
    for (const o of physics.moved) {
      // Moving bodies re-mark their tiles now and then (spread over ticks), resting ones at once.
      if (o.asleep || (this.tick + o.id) % 8 === 0) objects.raster(o as WorldObject);
    }
    for (const hit of physics.hits) this.hit(hit.body as WorldObject, hit);
    for (const { body } of physics.landings) {
      const o = body as WorldObject;
      if (o.quiet) continue; // Rules don't trigger Rules
      const c = physics.center(o);
      const by = agents.find((a) => a.name === o.mover) ?? null;
      const name = this.catalog.get(o.design)?.name ?? "Object";
      this.fire("landed", by, Math.floor(c[0]), Math.floor(c[1]), Math.floor(c[2]), name);
    }
  }

  /** A body hit a villager or an animal: hard enough, and they're knocked over or bolt. */
  private hit(
    o: WorldObject,
    h: { piece: number; mover: number; speed: number; momentum: number; nx: number; nz: number },
  ) {
    const name = this.catalog.get(o.design)?.name ?? "Object";
    // A door or a drawer moving on its hinge or rail bumps people; it never bowls them over.
    if (
      h.piece && this.physics.assembly(o.design)?.joints.some((j) => j.b === h.piece && j.limits)
    ) {
      return;
    }
    if (h.mover >= this.agents.length) {
      const a = this.animals[h.mover - this.agents.length];
      if (a && h.momentum >= KNOCK_MOMENTUM / 2 && h.speed >= KNOCK_SPEED / 2) {
        a.mode = AnimalMode.Flee;
        a.tx = a.x + h.nx * 5, a.tz = a.z + h.nz * 5;
      }
      return;
    }
    const agent = this.agents[h.mover];
    if (!agent || h.speed < KNOCK_SPEED || h.momentum < KNOCK_MOMENTUM) return;
    // Your own push, or what you dropped, never bowls you over; nor does anything twice in a row.
    if (agent.pushing === o.id || o.mover === agent.name || o.held) return;
    if (agent.downUntil !== undefined || this.tick < (agent.graceUntil ?? 0)) return;
    agent.resume = agent.anim;
    agent.downUntil = this.tick + DOWN_TICKS;
    agent.graceUntil = this.tick + DOWN_TICKS + GRACE_TICKS;
    agent.knock = [h.nx, h.nz];
    agent.anim = Anim.Fall;
    const held = this.carried(agent);
    if (held) this.release(agent, held);
    const by = o.mover ? `${o.mover}'s ${name}` : `a ${name}`;
    agent.notes.push(
      `Knocked over by ${by}! You were back on your feet after a moment${
        held ? ", but dropped what you carried" : ""
      }.`,
    );
    this.events.push({ type: "physics", agent: agent.id, text: `was knocked over by ${by}` });
  }

  private stepAnimals() {
    const f = this.farmers;
    f.length = this.agents.length;
    this.agents.forEach((a, i) => {
      const o = f[i] ??= { x: 0, z: 0, moving: false, food: 0 };
      o.x = a.x, o.z = a.z, o.moving = a.anim === Anim.Walk && !a.gentle;
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
        const free = !w.blocked(x, z) && !w.objectAt[z * w.sizeX + x];
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
      objects: structuredClone(this.objects.list),
      animals: structuredClone(this.animals),
      schools: structuredClone(this.schools),
      weatherOverride: this.weatherOverride,
      catalog: this.catalog.save(),
      ruleStats: structuredClone([...this.rules.stats]),
      fire: this.wildfire.save(),
      village: this.village.save(),
      board: this.board.save(),
      spectatorClouds: this.spectatorClouds,
      sessions: [...this.sessions].map(([session, agent]) => [session, agent.id]),
      agents: this.agents.map((
        { queue: _q, anim: _a, stride: _s, notes: _n, pace: _p, sleeping: _z, ...rest },
      ) => structuredClone(rest)),
    };
  }

  static load(data: SaveData): Sim {
    const sim = new Sim(data.seed);
    sim.tick = data.tick;
    sim.weatherOverride = data.weatherOverride ?? null;
    if (data.catalog) {
      sim.catalog = Catalog.load(data.catalog);
      sim.catalog.addMissingNature(data.tick);
    }
    sim.props.catalog = sim.catalog;
    sim.objects.catalog = sim.catalog;
    sim.physics.catalog = sim.catalog;
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
    if (data.objects) sim.objects.reset(data.objects);
    sim.wildfire.load(data.fire);
    sim.village.load(data.village);
    sim.board.load(data.board);
    sim.spectatorClouds = data.spectatorClouds ?? null;
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
        body: agent.body ?? null,
        lastActive: agent.lastActive ?? 0,
        authored: agent.authored ?? [],
        fed: agent.fed ?? 1,
        rested: agent.rested ?? 1,
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
