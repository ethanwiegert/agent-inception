import {
  AGENT_STRIDE,
  type AgentProfile,
  type FromWorker,
  type TickMessage,
  type ToWorker,
} from "./sim/protocol.ts";
import type { SimEvent, Sprite } from "./sim/sim.ts";
import { World } from "./sim/world.ts";
import { generateMeadow } from "./sim/worldgen.ts";

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
  crops: Float32Array<ArrayBuffer> = new Float32Array(0);
  cropsVersion = 0;
  profiles: AgentProfile[] = [];
  onReady: (world: World, caughtUp: number) => void = () => {};
  onEvent: (event: SimEvent) => void = () => {};

  private worker: Worker;
  private prev: Float32Array<ArrayBuffer> = new Float32Array(0);
  private curr: Float32Array<ArrayBuffer> = new Float32Array(0);
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

  private receive(msg: FromWorker) {
    if (msg.type === "ready") {
      this.seed = msg.seed;
      const world = generateMeadow({ seed: msg.seed });
      applyEdits(world, msg.edits);
      this.world = world;
      this.prev = this.curr = new Float32Array(0);
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
    this.currAt = now;
    this.tick = msg.tick;
    this.day = msg.day;
    this.timeOfDay = msg.timeOfDay;
    this.speed = msg.speed;
    if (msg.profiles) this.profiles = msg.profiles;
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

function applyEdits(world: World, edits: Int32Array) {
  for (let i = 0; i < edits.length; i += 4) {
    world.set(edits[i], edits[i + 1], edits[i + 2], edits[i + 3]);
  }
}
