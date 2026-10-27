import {
  AGENT_STRIDE,
  type AgentProfile,
  ANIMAL_STRIDE,
  type FromWorker,
  type TickMessage,
  type ToWorker,
} from "./sim/protocol.ts";
import { BlockRegistry } from "./sim/blocks.ts";
import { Props } from "./sim/props.ts";
import type { SimEvent, Sprite } from "./sim/sim.ts";
import { World } from "./sim/world.ts";
import { generateWorld } from "./sim/worldgen.ts";

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
  sprite: Sprite | null;
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
 * The page's view of the simulation. Mirrors the world (regenerated from the
 * seed, then patched with streamed edits) and interpolates agents between ticks.
 */
export class SimClient {
  world: World | null = null;
  seed = 0;
  tick = 0;
  day = 1;
  timeOfDay = 0;
  speed = 1;
  clouds = 0.35;
  /** Mirror of the sim's block registry (built-ins plus agent-defined blocks). */
  blocks = new BlockRegistry();
  /** Mirror of the sim's props: regenerated from the seed, patched with the streamed diff. */
  props: Props | null = null;
  crops: Float32Array<ArrayBuffer> = new Float32Array(0);
  cropsVersion = 0;
  profiles: AgentProfile[] = [];
  onReady: (world: World, caughtUp: number) => void = () => {};
  onEvent: (event: SimEvent) => void = () => {};

  private worker: Worker;
  private prev: Float32Array<ArrayBuffer> = new Float32Array(0);
  private curr: Float32Array<ArrayBuffer> = new Float32Array(0);
  private prevAnimals: Float32Array<ArrayBuffer> = new Float32Array(0);
  private currAnimals: Float32Array<ArrayBuffer> = new Float32Array(0);
  private animalViews: AnimalView[] = [];
  /** Fish schools, straight from the last tick (they drift too slowly to need interpolation). */
  schools: Float32Array<ArrayBuffer> = new Float32Array(0);
  private currAt = 0;
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

  /** Agents interpolated for render time `now` (ms). */
  agents(now: number): AgentView[] {
    const t = Math.min(1, Math.max(0, (now - this.currAt) / this.interval));
    const out: AgentView[] = [];
    for (let i = 0; i < this.curr.length; i += AGENT_STRIDE) {
      const c = this.curr, p = this.prev.length > i && this.prev[i] === c[i] ? this.prev : c;
      const lerp = (k: number) => p[i + k] + (c[i + k] - p[i + k]) * t;
      const dyaw = Math.atan2(Math.sin(c[i + 4] - p[i + 4]), Math.cos(c[i + 4] - p[i + 4]));
      out.push({
        id: c[i],
        name: this.profiles[i / AGENT_STRIDE]?.name ?? "?",
        sprite: this.profiles[i / AGENT_STRIDE]?.sprite ?? null,
        x: lerp(1),
        y: lerp(2),
        z: lerp(3),
        yaw: p[i + 4] + dyaw * t,
        anim: c[i + 5],
        stride: lerp(6),
        color: c[i + 7],
      });
    }
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
      this.blocks = new BlockRegistry();
      this.blocks.load(msg.blocks);
      const world = generateWorld({ seed: msg.seed });
      this.props = new Props(world, msg.seed); // from the pristine terrain, like the sim
      this.props.applyDiff(msg.props);
      applyEdits(world, msg.edits);
      this.world = world;
      this.prev = this.curr = new Float32Array(0);
      this.prevAnimals = this.currAnimals = new Float32Array(0);
      this.crops = new Float32Array(0);
      this.cropsVersion++;
      this.onReady(world, msg.caughtUp);
      return;
    }
    this.tickMessage(msg);
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
    if (msg.blocks) this.blocks.load(msg.blocks);
    if (msg.profiles) this.profiles = msg.profiles;
    if (msg.props && this.props) this.props.reset(msg.props);
    if (msg.crops) {
      this.crops = msg.crops;
      this.cropsVersion++;
    }
    if (this.world) applyEdits(this.world, msg.edits);
    for (const event of msg.events) this.onEvent(event);
    for (const r of msg.results) {
      this.pending.get(r.callId)?.({ text: r.text, isError: r.isError });
      this.pending.delete(r.callId);
    }
  }
}

const mix = (p: Float32Array, c: Float32Array, i: number, t: number) => p[i] + (c[i] - p[i]) * t;

function applyEdits(world: World, edits: Int32Array) {
  for (let i = 0; i < edits.length; i += 4) {
    world.set(edits[i], edits[i + 1], edits[i + 2], edits[i + 3]);
  }
}
