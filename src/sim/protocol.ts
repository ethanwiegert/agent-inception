import type { CallResult, SimEvent, Sprite } from "./sim.ts";

/** Floats per agent in `TickMessage.agents`: id, x, y, z, yaw, anim, stride, color. */
export const AGENT_STRIDE = 8;
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
}

export interface TickMessage {
  type: "tick";
  tick: number;
  day: number;
  timeOfDay: number;
  speed: number;
  agents: Float32Array<ArrayBuffer>;
  /** Per agent, in `agents` order. Sent when agents join or change how they look. */
  profiles?: AgentProfile[];
  edits: Int32Array<ArrayBuffer>;
  /** Sent when crops change and once a second while they grow. */
  crops?: Float32Array<ArrayBuffer>;
  events: SimEvent[];
  results: CallResult[];
}

export type FromWorker = ReadyMessage | TickMessage;
