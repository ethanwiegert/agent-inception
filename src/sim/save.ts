/**
 * Save format versions and migrations (M14). Every save says its version; a save from an older
 * version is brought forward one step at a time, and a save from a newer version than this code
 * knows is refused rather than guessed at (and never overwritten). Exported world files are the
 * same data, so they migrate the same way.
 */
import { hash32 } from "./rng.ts";
import type { SaveData } from "./sim.ts";

/** The version `Sim.save` writes. Bump it with a migration below whenever the format changes. */
export const SAVE_VERSION = 3;
/** The oldest save that can still be brought forward. Older ones start their island afresh. */
export const OLDEST_SAVE = 2;
/** What an exported world file says it is. */
export const FILE_FORMAT = "agent-inception world";

export class SaveError extends Error {
  constructor(readonly kind: "newer" | "older" | "broken", message: string) {
    super(message);
  }
}

type Raw = Record<string, unknown>;

/** Migrations, keyed by the version they upgrade from. Each returns the next version's data. */
const MIGRATIONS: Record<number, (save: Raw) => Raw> = {
  // 2 → 3 (M14): worlds have a name, shown in world slots and on exported files.
  2: (save) => ({ ...save, version: 3, name: worldName(Number(save.seed)) }),
};

/** Bring a save (from IndexedDB or a world file) up to SAVE_VERSION, or say why it can't be. */
export function migrateSave(raw: unknown): SaveData {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SaveError("broken", "That isn't a saved world.");
  }
  let save = raw as Raw;
  const version = save.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new SaveError("broken", "That save doesn't say its version.");
  }
  if (version > SAVE_VERSION) {
    throw new SaveError(
      "newer",
      `That world was saved by a newer agent-inception (save version ${version}; this one reads ` +
        `up to ${SAVE_VERSION}). Reload the page to get the latest version.`,
    );
  }
  if (version < OLDEST_SAVE) {
    throw new SaveError("older", `Save version ${version} is from before saves were kept.`);
  }
  for (let v = version; v < SAVE_VERSION; v++) save = MIGRATIONS[v](save);
  check(save);
  return save as unknown as SaveData;
}

/** The fields everything else relies on, checked so a broken file fails here, not mid-load. */
function check(s: Raw) {
  const fail = (what: string) => {
    throw new SaveError("broken", `That save is damaged (${what}).`);
  };
  const int = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
  if (!int(s.seed)) fail("seed");
  if (!int(s.tick) || (s.tick as number) < 0) fail("tick");
  if (!int(s.dayOffset)) fail("clock");
  if (typeof s.name !== "string") fail("name");
  if (!Array.isArray(s.edits) || s.edits.length % 2 || !s.edits.every(int)) fail("blocks");
  if (!Array.isArray(s.crops) || !s.crops.every((c) => Array.isArray(c) && c.every(int))) {
    fail("crops");
  }
  if (!Array.isArray(s.agents) || s.agents.length > 1000) fail("villagers");
  for (const a of s.agents as Raw[]) {
    if (typeof a !== "object" || a === null || !int(a.id) || typeof a.name !== "string") {
      fail("a villager");
    }
    for (const k of ["x", "y", "z"]) if (!Number.isFinite(a[k])) fail(`${a.name}'s place`);
    if (typeof a.inventory !== "object" || a.inventory === null) fail(`${a.name}'s inventory`);
    if (!Array.isArray(a.journal)) fail(`${a.name}'s journal`);
  }
  if (s.sessions !== undefined && !Array.isArray(s.sessions)) fail("sessions");
}

const FIRST = [
  "Mossy",
  "Windy",
  "Sunny",
  "Quiet",
  "Clover",
  "Amber",
  "Misty",
  "Golden",
  "Bramble",
  "Willow",
  "Heather",
  "Tumble",
  "Pebble",
  "Honey",
  "Fern",
  "Maple",
];
const LAST = [
  "Hollow",
  "Isle",
  "Meadow",
  "Reach",
  "Cove",
  "Downs",
  "Glen",
  "Haven",
  "Brook",
  "Knoll",
];

/** A world's name from its seed: the same island always has the same name. */
export function worldName(seed: number): string {
  const h = hash32(seed ^ 0x6e616d65);
  return `${FIRST[h % FIRST.length]} ${LAST[(h >>> 8) % LAST.length]}`;
}
