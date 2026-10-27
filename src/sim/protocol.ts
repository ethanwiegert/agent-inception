import type { BlockDef } from "./blocks.ts";
import type { PropDiff } from "./props.ts";
import type { CallResult, SimEvent, Sprite } from "./sim.ts";

/** Floats per agent in `TickMessage.agents`: id, x, y, z, yaw, anim, stride, color. */
export const AGENT_STRIDE = 8;
/** Floats per animal in `TickMessage.animals`: id, species, x, y, z, yaw, anim, stride, flags. */
export const ANIMAL_STRIDE = 9;
/** Animal flag: its product (wool, milk, egg) is ready to collect. */
export const ANIMAL_READY = 1;
/** Floats per crop in `TickMessage.crops`: x, y, z, growth. */
export const CROP_STRIDE = 4;

export interface AgentProfile {
  name: string;
  sprite: Sprite | null;
}

export type ToWorker =
  | { type: "init"; seed?: number }
  | { type: "call"; callId: number; session: string; tool: string; args: Record<string, unknown> }
  | { type: "speed"; speed: number }
  | { type: "setTime"; timeOfDay: number }
  | { type: "reset"; seed: number }
  | { type: "save" };

export interface ReadyMessage {
  type: "ready";
  seed: number;
  /** Flat x, y, z, block for every cell that differs from the generated world. */
  edits: Int32Array<ArrayBuffer>;
  /** Ticks fast-forwarded to cover time spent away. */
  caughtUp: number;
  /** Agent-defined blocks. */
  blocks: BlockDef[];
  /** Props that differ from generation (the page regenerates the rest from the seed). */
  props: PropDiff;
}

export interface TickMessage {
  type: "tick";
  tick: number;
  day: number;
  timeOfDay: number;
  speed: number;
  clouds: number;
  agents: Float32Array<ArrayBuffer>;
  animals: Float32Array<ArrayBuffer>;
  /** Agent-defined blocks, sent when the registry changes. */
  blocks?: BlockDef[];
  /** Per agent, in `agents` order. Sent when agents join or change how they look. */
  profiles?: AgentProfile[];
  edits: Int32Array<ArrayBuffer>;
  /** All prop differences from generation, sent when props change. */
  props?: PropDiff;
  /** Sent when crops change and once a second while they grow. */
  crops?: Float32Array<ArrayBuffer>;
  events: SimEvent[];
  results: CallResult[];
}

export type FromWorker = ReadyMessage | TickMessage;
