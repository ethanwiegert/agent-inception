import type { CatalogSave, Entry, Proposal } from "./catalog.ts";
import type { WorldObject } from "./objects.ts";
import type { PropDiff } from "./props.ts";
import type { CallResult, SimEvent } from "./sim.ts";
import type { WorldData } from "./world.ts";

/** Floats per agent in `TickMessage.agents`: id, x, y, z, yaw, anim, stride, color. */
export const AGENT_STRIDE = 8;
/** Floats per animal in `TickMessage.animals`: id, species, x, y, z, yaw, anim, stride, flags. */
export const ANIMAL_STRIDE = 9;
/** Animal flag: its product (wool, milk, egg) is ready to collect. */
export const ANIMAL_READY = 1;
/** Floats per fish school in `TickMessage.schools`: id, species, x, z, count. */
export const SCHOOL_STRIDE = 5;
/**
 * Floats per crop in `TickMessage.crops`: x, y, z, the tick it was planted (relative to the
 * message's tick), then the stalk color and the ripe color (sRGB 0xRRGGBB, exact in a float), the
 * ticks it takes to ripen (0: always ripe) and the Design it looks like. The page works out growth
 * (on the GPU for blade fields).
 */
export const CROP_STRIDE = 8;

export interface AgentProfile {
  name: string;
  /** The Design they look like; null for the default farmer. */
  body: number | null;
}

/** Catalog changes since the last tick message. The Catalog is append-only, so new entries suffice. */
export interface CatalogDelta {
  entries: Entry[];
  /** [id, retired, replacedBy] for every retired entry; only sent when one changed. */
  status?: [number, boolean, number | null][];
  /** Open and recent proposals. */
  proposals: Proposal[];
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
  /** The world as it stands, edits included, so the page doesn't regenerate it. */
  world: WorldData;
  /** Ticks fast-forwarded to cover time spent away. */
  caughtUp: number;
  /** Nature's generated props (packed quads, see `Props.packGenerated`) and today's difference. */
  props: { generated: Int32Array<ArrayBuffer>; diff: PropDiff };
  objects: WorldObject[];
  catalog: CatalogSave;
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
  schools: Float32Array<ArrayBuffer>;
  /** Per agent, in `agents` order. Sent when agents join or change how they look. */
  profiles?: AgentProfile[];
  edits: Int32Array<ArrayBuffer>;
  /** All prop differences from generation, sent when props change. */
  props?: PropDiff;
  /** Every Object, sent when one is built or taken apart. */
  objects?: WorldObject[];
  catalog?: CatalogDelta;
  /** Sent when crops change, or the Catalog does (a replaced Design recolors its crops). */
  crops?: Float32Array<ArrayBuffer>;
  events: SimEvent[];
  results: CallResult[];
}

/** Results of tools that answered at once (look, say, Catalog reads), sent without waiting a tick. */
export interface ResultsMessage {
  type: "results";
  results: CallResult[];
}

export type FromWorker = ReadyMessage | TickMessage | ResultsMessage;
