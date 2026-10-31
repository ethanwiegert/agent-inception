import type { Wish } from "./board.ts";
import type { CatalogSave, Entry, Proposal } from "./catalog.ts";
import type { WorldObject } from "./objects.ts";
import type { PropDiff } from "./props.ts";
import type { CallResult, SimEvent } from "./sim.ts";
import type { VillageStatus } from "./village.ts";
import type { WorldData } from "./world.ts";

/**
 * Floats per agent in `TickMessage.agents`: id, x, y, z, yaw, anim, stride, color, whether they
 * carry something overhead (1), and ticks left lying down after being knocked over.
 */
export const AGENT_STRIDE = 10;
/** Floats per Object in `TickMessage.bodies`: id, then its origin x, y, z and turn as a quaternion. */
export const BODY_STRIDE = 8;
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
/**
 * Floats per burning thing in `TickMessage.fires`: its world box (x0, x1, y0, y1, z0, z1), what it
 * is (0 block, 1 plant, 2 crop, 3 Object) and a number to vary its flames by.
 */
export const FIRE_STRIDE = 8;
export const FIRE_KINDS = ["block", "plant", "crop", "object"] as const;

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

/** How many worlds one browser keeps. */
export const SLOTS = 3;

/** A world slot as the panel lists it. */
export type SlotInfo =
  | { slot: number; empty: true }
  | {
    slot: number;
    empty?: false;
    name: string;
    seed: number;
    day: number;
    savedAt: number;
    villagers: string[];
  };

/** World slot requests; the worker answers each with a `SlotsReply` carrying the same `req`. */
export type SlotOp =
  | { op: "list" }
  /** Save now (before a reload, say). */
  | { op: "save" }
  | { op: "delete"; slot: number }
  /** The slot's world as a gzipped file. */
  | { op: "export"; slot: number }
  /** A world file (gzipped or plain JSON) into the first free slot. */
  | { op: "import"; data: ArrayBuffer };

export interface SlotsReply {
  type: "slots";
  req: number;
  slots: SlotInfo[];
  /** Set when the op failed. */
  error?: string;
  /** An exported world. */
  file?: { name: string; bytes: Uint8Array<ArrayBuffer> };
  /** Where an imported world went. */
  slot?: number;
}

export type ToWorker =
  /**
   * Open world slot `slot`. With a seed that isn't that slot's world, a new world starts in a free
   * slot instead (the slot it went to comes back in `ready`).
   */
  | { type: "init"; seed?: number; slot: number }
  | ({ type: "slots"; req: number } & SlotOp)
  | { type: "call"; callId: number; session: string; tool: string; args: Record<string, unknown> }
  | { type: "speed"; speed: number }
  | { type: "setTime"; timeOfDay: number }
  /** The spectator's switch: Village Life on, or the world a Sandbox. */
  | { type: "villageLife"; on: boolean }
  /** The spectator holds the sky at this cloud cover (0-1), or null lets it drift. */
  | { type: "weather"; clouds: number | null }
  /** The spectator pins a Wish on the Notice Board, for anyone (null) or one villager by name. */
  | { type: "wish"; text: string; for: string | null }
  | { type: "unpin"; id: number }
  | { type: "save" };

export interface ReadyMessage {
  type: "ready";
  seed: number;
  /** The world slot it lives in, and its name. */
  slot: number;
  name: string;
  /** Something the spectator should hear about loading (slots full, a newer save left alone). */
  notice?: string;
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
  /** The cloud cover a spectator holds the sky at, or null when the weather is natural. */
  heldClouds: number | null;
  agents: Float32Array<ArrayBuffer>;
  animals: Float32Array<ArrayBuffer>;
  schools: Float32Array<ArrayBuffer>;
  /** Per agent, in `agents` order. Sent when agents join or change how they look. */
  profiles?: AgentProfile[];
  edits: Int32Array<ArrayBuffer>;
  /** All prop differences from generation, sent when props change. */
  props?: PropDiff;
  /** Every Object, sent when one is built, taken apart, picked up or put down. */
  objects?: WorldObject[];
  /**
   * Where every Object is now, each of its pieces (BODY_STRIDE each, keyed id × 16 + piece), sent
   * when any moved.
   */
  bodies?: Float32Array<ArrayBuffer>;
  catalog?: CatalogDelta;
  /** Village Life: mode, level, errands and everyone's needs, sent about once a second. */
  village?: VillageStatus;
  /** The Notice Board's Wishes, sent when one is pinned, answered, done or taken down. */
  board?: Wish[];
  /** Sent when crops change, or the Catalog does (a replaced Design recolors its crops). */
  crops?: Float32Array<ArrayBuffer>;
  /** Everything burning (FIRE_STRIDE each), sent when something catches, goes out or moves. */
  fires?: Float32Array<ArrayBuffer>;
  events: SimEvent[];
  results: CallResult[];
}

/** Results of tools that answered at once (look, say, Catalog reads), sent without waiting a tick. */
export interface ResultsMessage {
  type: "results";
  results: CallResult[];
}

export type FromWorker = ReadyMessage | TickMessage | ResultsMessage | SlotsReply;
