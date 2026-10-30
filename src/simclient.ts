import {
  AGENT_STRIDE,
  type AgentProfile,
  ANIMAL_STRIDE,
  BODY_STRIDE,
  type FromWorker,
  type TickMessage,
  type ToWorker,
} from "./sim/protocol.ts";
import { BlockRegistry } from "./sim/blocks.ts";
import { Catalog } from "./sim/catalog.ts";
import { Objects } from "./sim/objects.ts";
import { Props } from "./sim/props.ts";
import type { SimEvent } from "./sim/sim.ts";
import { World } from "./sim/world.ts";

export interface AgentView {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  anim: number;
  stride: number;
  color: number;
  /** The Design they look like; null for the default farmer. */
  body: number | null;
  /** Holding something overhead. */
  carrying: boolean;
  /** Ticks left lying down after being knocked over (0: on their feet). */
  down: number;
}

/** Where an Object is drawn this frame: its Design's origin and turn. */
export interface BodyPose {
  pos: [number, number, number];
  rot: [number, number, number, number];
  /** The frame it was last updated in (gone from the world if not this one). */
  frame: number;
}

export interface AnimalView {
  id: number;
  species: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  anim: number;
  stride: number;
  flags: number;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

/**
 * The page's view of the simulation. Mirrors the world (sent whole by the worker
 * once, then patched with streamed edits) and interpolates agents between ticks.
 */
export class SimClient {
  world: World | null = null;
  seed = 0;
  tick = 0;
  day = 1;
  timeOfDay = 0;
  speed = 1;
  clouds = 0.35;
  private registry = new BlockRegistry();
  /** Mirror of the sim's props: regenerated from the seed, patched with the streamed diff. */
  props: Props | null = null;
  /** Mirror of the sim's Objects, rasterized on the page's world too. */
  objects: Objects | null = null;
  /** Mirror of the sim's Catalog. */
  catalog = new Catalog();
  crops: Float32Array<ArrayBuffer> = new Float32Array(0);
  cropsVersion = 0;
  /** The tick `crops` planting times are relative to. */
  cropsTick = 0;
  profiles: AgentProfile[] = [];
  onReady: (world: World, caughtUp: number) => void = () => {};

  /** Block ids for the mirrored Catalog's Materials, the same ids the sim uses. */
  get blocks(): BlockRegistry {
    return this.registry.sync(this.catalog);
  }
  onEvent: (event: SimEvent) => void = () => {};

  private worker: Worker;
  private prev: Float32Array<ArrayBuffer> = new Float32Array(0);
  private curr: Float32Array<ArrayBuffer> = new Float32Array(0);
  private prevAnimals: Float32Array<ArrayBuffer> = new Float32Array(0);
  private currAnimals: Float32Array<ArrayBuffer> = new Float32Array(0);
  private animalViews: AnimalView[] = [];
  private agentViews: AgentView[] = [];
  /** Fish schools, straight from the last tick (they drift too slowly to need interpolation). */
  schools: Float32Array<ArrayBuffer> = new Float32Array(0);
  private currAt = 0;
  private prevBodies: Float32Array<ArrayBuffer> = new Float32Array(0);
  private currBodies: Float32Array<ArrayBuffer> = new Float32Array(0);
  private bodiesAt = 0;
  private prevIndex = new Map<number, number>();
  private bodyViews = new Map<number, BodyPose>();
  private frame = 0;
  private interval = 50;
  private pending = new Map<number, (r: ToolResult) => void>();
  private nextCall = 1;

  constructor(seed?: number) {
    this.worker = new Worker("/worker.js", { type: "module" });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);
    this.send({ type: "init", seed });
  }

  send(msg: ToWorker) {
    this.worker.postMessage(msg);
  }

  call(session: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const callId = this.nextCall++;
    this.send({ type: "call", callId, session, tool, args });
    return new Promise((resolve) => this.pending.set(callId, resolve));
  }

  /** Agents interpolated for render time `now` (ms). The returned views are reused. */
  agents(now: number): AgentView[] {
    const t = Math.min(1, Math.max(0, (now - this.currAt) / this.interval));
    const c = this.curr, n = c.length / AGENT_STRIDE;
    const views = this.agentViews;
    views.length = n;
    for (let j = 0; j < n; j++) {
      const i = j * AGENT_STRIDE;
      const p = this.prev.length > i && this.prev[i] === c[i] ? this.prev : c;
      const dyaw = Math.atan2(Math.sin(c[i + 4] - p[i + 4]), Math.cos(c[i + 4] - p[i + 4]));
      const v = views[j] ??= {
        id: 0,
        name: "",
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        anim: 0,
        stride: 0,
        color: 0,
        body: null,
        carrying: false,
        down: 0,
      };
      v.id = c[i];
      v.name = this.profiles[j]?.name ?? "?";
      v.body = this.profiles[j]?.body ?? null;
      v.x = mix(p, c, i + 1, t), v.y = mix(p, c, i + 2, t), v.z = mix(p, c, i + 3, t);
      v.yaw = p[i + 4] + dyaw * t, v.anim = c[i + 5], v.stride = mix(p, c, i + 6, t);
      v.color = c[i + 7];
      v.carrying = c[i + 8] > 0;
      v.down = mix(p, c, i + 9, t);
    }
    return views;
  }

  /** Objects' poses interpolated for render time `now` (ms), by id. The map is reused. */
  bodies(now: number): Map<number, BodyPose> {
    const t = Math.min(1, Math.max(0, (now - this.bodiesAt) / this.interval));
    const c = this.currBodies, p = this.prevBodies, out = this.bodyViews;
    const prevAt = this.prevIndex;
    prevAt.clear();
    for (let i = 0; i < p.length; i += BODY_STRIDE) prevAt.set(p[i], i);
    const frame = ++this.frame;
    for (let i = 0; i < c.length; i += BODY_STRIDE) {
      const id = c[i], j = prevAt.get(id) ?? i, src = prevAt.has(id) ? p : c;
      let v = out.get(id);
      if (!v) out.set(id, v = { pos: [0, 0, 0], rot: [0, 0, 0, 1], frame });
      v.frame = frame;
      for (let k = 0; k < 3; k++) v.pos[k] = src[j + 1 + k] + (c[i + 1 + k] - src[j + 1 + k]) * t;
      // nlerp, the short way round.
      let dot = 0;
      for (let k = 0; k < 4; k++) dot += src[j + 4 + k] * c[i + 4 + k];
      const sgn = dot < 0 ? -1 : 1;
      let l = 0;
      for (let k = 0; k < 4; k++) {
        v.rot[k] = src[j + 4 + k] * sgn + (c[i + 4 + k] - src[j + 4 + k] * sgn) * t;
        l += v.rot[k] * v.rot[k];
      }
      l = Math.sqrt(l) || 1;
      for (let k = 0; k < 4; k++) v.rot[k] /= l;
    }
    for (const [id, v] of out) if (v.frame !== frame) out.delete(id);
    return out;
  }

  /** Animals interpolated for render time `now` (ms). The returned views are reused. */
  animals(now: number): AnimalView[] {
    const t = Math.min(1, Math.max(0, (now - this.currAt) / this.interval));
    const c = this.currAnimals, n = c.length / ANIMAL_STRIDE;
    const views = this.animalViews;
    views.length = n;
    for (let j = 0; j < n; j++) {
      const i = j * ANIMAL_STRIDE;
      const p = this.prevAnimals.length > i && this.prevAnimals[i] === c[i] ? this.prevAnimals : c;
      const dyaw = Math.atan2(Math.sin(c[i + 5] - p[i + 5]), Math.cos(c[i + 5] - p[i + 5]));
      const v = views[j] ??= {
        id: 0,
        species: 0,
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        anim: 0,
        stride: 0,
        flags: 0,
      };
      v.id = c[i], v.species = c[i + 1];
      v.x = mix(p, c, i + 2, t), v.y = mix(p, c, i + 3, t), v.z = mix(p, c, i + 4, t);
      v.yaw = p[i + 5] + dyaw * t, v.anim = c[i + 6], v.stride = mix(p, c, i + 7, t);
      v.flags = c[i + 8];
    }
    return views;
  }

  private receive(msg: FromWorker) {
    if (msg.type === "ready") {
      this.seed = msg.seed;
      this.catalog = Catalog.load(msg.catalog);
      // The worker's world and props as they stand: nothing to regenerate on the main thread.
      const world = World.fromData(msg.world);
      this.props = new Props(world, msg.props.generated, this.catalog);
      this.props.applyDiff(msg.props.diff);
      this.objects = new Objects(world, this.catalog);
      this.objects.reset(msg.objects);
      this.world = world;
      this.prev = this.curr = new Float32Array(0);
      this.prevAnimals = this.currAnimals = new Float32Array(0);
      this.prevBodies = this.currBodies = new Float32Array(0);
      this.crops = new Float32Array(0);
      this.cropsVersion++;
      this.onReady(world, msg.caughtUp);
      return;
    }
    if (msg.type === "results") return this.resolve(msg.results);
    this.tickMessage(msg);
  }

  private resolve(results: { callId: number; text: string; isError: boolean }[]) {
    for (const r of results) {
      this.pending.get(r.callId)?.({ text: r.text, isError: r.isError });
      this.pending.delete(r.callId);
    }
  }

  private tickMessage(msg: TickMessage) {
    const now = performance.now();
    if (this.currAt) this.interval = Math.min(200, Math.max(16, now - this.currAt));
    this.prev = this.curr;
    this.curr = msg.agents;
    this.prevAnimals = this.currAnimals;
    this.currAnimals = msg.animals;
    this.schools = msg.schools;
    this.currAt = now;
    this.tick = msg.tick;
    this.day = msg.day;
    this.timeOfDay = msg.timeOfDay;
    this.speed = msg.speed;
    this.clouds = msg.clouds;
    if (msg.profiles) this.profiles = msg.profiles;
    if (msg.catalog) {
      const d = msg.catalog;
      this.catalog.mirror(d.entries, d.status ?? [], d.proposals);
    }
    if (msg.props && this.props) this.props.reset(msg.props);
    if (msg.crops) {
      this.crops = msg.crops;
      this.cropsTick = msg.tick;
      this.cropsVersion++;
    }
    if (this.world) applyEdits(this.world, msg.edits);
    if (msg.objects && this.objects) this.objects.reset(msg.objects);
    if (msg.bodies) {
      this.prevBodies = this.currBodies.length ? this.currBodies : msg.bodies;
      this.currBodies = msg.bodies;
      this.bodiesAt = now;
    } else if (this.currBodies !== this.prevBodies) {
      // Nothing moved this tick: hold the last pose.
      this.prevBodies = this.currBodies;
    }
    for (const event of msg.events) this.onEvent(event);
    this.resolve(msg.results);
  }
}

const mix = (p: Float32Array, c: Float32Array, i: number, t: number) => p[i] + (c[i] - p[i]) * t;

function applyEdits(world: World, edits: Int32Array) {
  for (let i = 0; i < edits.length; i += 4) {
    world.set(edits[i], edits[i + 1], edits[i + 2], edits[i + 3]);
  }
}
