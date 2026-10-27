import { type Animal, type Farmer, spawnAnimals, stepAnimals } from "./animals.ts";
import { type BlockDef, BlockRegistry } from "./blocks.ts";
import { perlin2 } from "./noise.ts";
import { type PropDiff, Props } from "./props.ts";
import { Rng } from "./rng.ts";
import { Block, World } from "./world.ts";
import { generateWorld } from "./worldgen.ts";

export const TICK_HZ = 20;
/** One game day per ten real minutes at 1× speed. */
export const TICKS_PER_DAY = TICK_HZ * 600;
export const WHEAT_GROW_TICKS = Math.round(TICKS_PER_DAY * 0.75);

export const Anim = { Idle: 0, Walk: 1, Till: 2, Plant: 3, Harvest: 4, Build: 5 } as const;

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
  queue: { callId: number; job: Job }[];
}

export interface Crop {
  kind: "wheat";
  planted: number;
}

export type SimEvent =
  | { type: "say"; agent: number; text: string }
  | { type: "joined"; agent: number };

export interface CallResult {
  callId: number;
  text: string;
  isError: boolean;
}

/** Everything needed to restore a world. Generated terrain is rebuilt from the seed. */
export interface SaveData {
  version: 1;
  seed: number;
  tick: number;
  dayOffset: number;
  savedAt: number;
  edits: number[];
  crops: [number, number][];
  agents: Omit<Agent, "queue" | "anim" | "stride">[];
  blocks?: BlockDef[];
  /** Trees, rocks, flowers etc. that differ from generation. */
  props?: PropDiff;
  /** Missing in old saves: those worlds get freshly spawned herds. */
  animals?: Animal[];
  weatherOverride?: { clouds: number; until: number } | null;
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
  readonly blocks = new BlockRegistry();
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
    this.props = new Props(this.world, seed);
    this.animals = spawnAnimals(this.world, seed);
    this.rng = new Rng(seed ^ 0x5eed);
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
    return Math.min(1, (this.tick - crop.planted) / WHEAT_GROW_TICKS);
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
      inventory: { wheat_seeds: 16, oak_sapling: 1, birch_sapling: 1, pine_sapling: 1 },
      journal: [],
      sprite: null,
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

  step() {
    this.tick++;
    this.stepAnimals();
    for (const agent of this.agents) {
      // Bodies follow the ground: slopes while walking, edits while standing still.
      agent.y += (this.world.surfaceY(agent.x, agent.z, agent.y) - agent.y) * 0.35;
      const current = agent.queue[0];
      if (!current) continue;
      try {
        const r = current.job.next();
        if (!r.done) continue;
        this.results.push({ callId: current.callId, text: r.value, isError: false });
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        this.results.push({ callId: current.callId, text, isError: true });
      }
      agent.queue.shift();
      agent.anim = Anim.Idle;
    }
  }

  private farmers: Farmer[] = [];

  private stepAnimals() {
    const f = this.farmers;
    f.length = this.agents.length;
    this.agents.forEach((a, i) => {
      const o = f[i] ??= { x: 0, z: 0, moving: false, wheat: false };
      o.x = a.x, o.z = a.z, o.moving = a.anim === Anim.Walk, o.wheat = (a.inventory.wheat ?? 0) > 0;
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
      version: 1,
      seed: this.seed,
      tick: this.tick,
      dayOffset: this.dayOffset,
      savedAt,
      edits: [...this.edits].flat(),
      crops: [...this.crops].map(([key, crop]) => [key, crop.planted]),
      blocks: this.blocks.customs(),
      props: this.props.diff(),
      animals: structuredClone(this.animals),
      weatherOverride: this.weatherOverride,
      sessions: [...this.sessions].map(([session, agent]) => [session, agent.id]),
      agents: this.agents.map(({ queue: _q, anim: _a, stride: _s, ...rest }) =>
        structuredClone(rest)
      ),
    };
  }

  static load(data: SaveData): Sim {
    const sim = new Sim(data.seed);
    sim.tick = data.tick;
    sim.blocks.load(data.blocks ?? []);
    sim.weatherOverride = data.weatherOverride ?? null;
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
    for (const [key, planted] of data.crops) sim.crops.set(key, { kind: "wheat", planted });
    for (const a of data.agents) {
      const agent = structuredClone(a);
      sim.agents.push({
        ...agent,
        sprite: agent.sprite ?? null,
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
