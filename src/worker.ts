/// <reference lib="webworker" />
/**
 * Simulation worker: owns the authoritative Sim, steps it at a fixed rate,
 * streams state to the page and persists to IndexedDB.
 */
import {
  AGENT_STRIDE,
  type AgentProfile,
  ANIMAL_READY,
  ANIMAL_STRIDE,
  BODY_STRIDE,
  type CatalogDelta,
  CROP_STRIDE,
  FIRE_KINDS,
  FIRE_STRIDE,
  type FromWorker,
  SCHOOL_STRIDE,
  type SlotInfo,
  type SlotOp,
  SLOTS,
  type SlotsReply,
  type ToWorker,
} from "./sim/protocol.ts";
import { FILE_FORMAT, migrateSave, SaveError } from "./sim/save.ts";
import { type SaveData, Sim, TICK_HZ, TICKS_PER_DAY } from "./sim/sim.ts";
import { callTool } from "./sim/tools.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const MAX_CATCH_UP = TICKS_PER_DAY * 3;
const SAVE_EVERY_MS = 5000;

let sim: Sim | null = null;
/** The world slot `sim` saves into, and whether saving is off (a save this version can't read). */
let slot = 0;
let readOnly = false;
let speed = 1;
let lastStep = performance.now();
let budget = 0;
let lastSave = 0;
let sentAgentsVersion = -1;
let sentCropsVersion = -1;
let sentCropsCatalog = -1;
let sentPropsVersion = -1;
let sentObjectsVersion = -1;
let sentPosesVersion = -1;
let sentCatalogVersion = -1;
let sentStatusVersion = -1;
let sentEntries = 0;
let sentFireVersion = -1;
let sentVillage = -1;
let sentBoard = -1;

const post = (msg: FromWorker, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

// Messages that arrive while init is loading the save wait for it.
let ready: Promise<void> = Promise.resolve();

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === "init") ready = handle(msg);
  else ready = ready.then(() => handle(msg));
};

async function handle(msg: ToWorker) {
  switch (msg.type) {
    case "init": {
      const { notice } = await open(msg.slot, msg.seed);
      const s = sim!;
      const away = s.tick ? Math.min(MAX_CATCH_UP, ((Date.now() - savedAt) / 1000) * TICK_HZ) : 0;
      s.tick += Math.floor(away); // crops grow from the clock, so idle time is just elapsed ticks
      start(Math.floor(away), notice);
      if (!readOnly) await persist();
      break;
    }
    case "slots":
      post(await slotOp(msg.req, msg));
      break;
    case "call":
      if (!sim) break;
      callTool(sim, msg.session, msg.tool, msg.args, msg.callId);
      // Instant tools answer now; jobs answer from a later tick. Events (a say, a Rule's reply)
      // and state still travel with the next tick, which lands within 50 ms.
      if (sim.results.length) post({ type: "results", results: sim.results.splice(0) });
      break;
    case "speed":
      speed = Math.max(0, Math.min(120, msg.speed));
      break;
    case "setTime":
      sim?.setTimeOfDay(msg.timeOfDay);
      break;
    case "villageLife":
      sim?.village.setLife(msg.on);
      break;
    case "weather":
      sim?.setWeather(msg.clouds);
      break;
    case "wish":
      if (!sim) break;
      try {
        sim.board.pin(msg.text, msg.for);
      } catch (e) {
        const text = `couldn't pin the Wish: ${e instanceof Error ? e.message : e}`;
        sim.events.push({ type: "board", agent: 0, wish: 0, text });
      }
      break;
    case "forgetSessions":
      sim?.sessions.clear();
      break;
    case "unpin":
      sim?.board.unpin(msg.id);
      break;
    case "save":
      await persist();
      break;
  }
}

function start(caughtUp: number, notice?: string) {
  const s = sim!;
  s.pendingEdits = [];
  sentAgentsVersion = sentCropsVersion = sentCropsCatalog = -1;
  sentPropsVersion = s.props.version;
  sentObjectsVersion = s.objects.version;
  sentPosesVersion = -1;
  sentFireVersion = -1;
  sentVillage = -1;
  sentBoard = -1;
  sentCatalogVersion = s.catalog.version;
  sentStatusVersion = s.catalog.statusVersion;
  sentEntries = s.catalog.entries.length;
  const world = s.world.data();
  const generated = s.props.packGenerated();
  post({
    type: "ready",
    seed: s.seed,
    slot,
    name: s.name,
    notice,
    world,
    caughtUp,
    props: { generated, diff: s.props.diff() },
    objects: structuredClone(s.objects.list),
    catalog: s.catalog.save(),
  }, [world.blocks.buffer, world.top.buffer, world.waterTop.buffer, generated.buffer]);
  lastStep = performance.now();
  budget = 0;
}

setInterval(() => {
  const now = performance.now();
  budget += ((now - lastStep) / 1000) * TICK_HZ * speed;
  lastStep = now;
  if (!sim) return;
  // Bound work per interval; at high speeds we just fall behind gracefully.
  const steps = Math.min(Math.floor(budget), 4000);
  budget -= steps;
  if (budget > 4000) budget = 0;
  for (let i = 0; i < steps; i++) sim.step();
  send();
  if (now - lastSave > SAVE_EVERY_MS) {
    lastSave = now;
    persist();
  }
}, 1000 / TICK_HZ);

function send() {
  const s = sim!;
  const agents = new Float32Array(s.agents.length * AGENT_STRIDE);
  s.agents.forEach((a, i) => {
    const carry = s.carried(a) ? 1 : 0, down = Math.max(0, (a.downUntil ?? 0) - s.tick);
    agents.set(
      [a.id, a.x, a.y, a.z, a.yaw, a.anim, a.stride, a.color, carry, down],
      i * AGENT_STRIDE,
    );
  });

  const animals = new Float32Array(s.animals.length * ANIMAL_STRIDE);
  s.animals.forEach((a, i) => {
    const flags = s.tick >= a.readyAt ? ANIMAL_READY : 0;
    animals.set(
      [a.id, a.species, a.x, a.y, a.z, a.yaw, a.anim, a.stride, flags],
      i * ANIMAL_STRIDE,
    );
  });

  const schools = new Float32Array(s.schools.length * SCHOOL_STRIDE);
  s.schools.forEach((f, i) => schools.set([f.id, f.species, f.x, f.z, f.count], i * SCHOOL_STRIDE));

  let crops: Float32Array<ArrayBuffer> | undefined;
  if (s.cropsVersion !== sentCropsVersion || s.catalog.version !== sentCropsCatalog) {
    sentCropsVersion = s.cropsVersion;
    sentCropsCatalog = s.catalog.version;
    crops = new Float32Array(s.crops.size * CROP_STRIDE);
    let i = 0;
    for (const [key, crop] of s.crops) {
      const x = key % s.world.sizeX, z = Math.floor(key / s.world.sizeX);
      const [stalk, ripe] = s.cropColors(crop.design);
      // Relative to now, so float32 stays exact however old the world gets.
      const planted = crop.planted - s.tick;
      // The Design it looks like now (a replaced crop takes its replacement's look).
      const stored = s.catalog.get(crop.design);
      const look = (stored && s.catalog.current(stored))?.id ?? crop.design;
      crops.set([x, s.world.heightAt(x, z) + 1, z, planted, stalk, ripe, crop.grow, look], i);
      i += CROP_STRIDE;
    }
  }

  let profiles: AgentProfile[] | undefined;
  if (s.agentsVersion !== sentAgentsVersion) {
    sentAgentsVersion = s.agentsVersion;
    profiles = s.agents.map((a) => ({ name: a.name, body: a.body }));
  }

  let catalog: CatalogDelta | undefined;
  if (s.catalog.version !== sentCatalogVersion) {
    const c = s.catalog;
    sentCatalogVersion = c.version;
    catalog = { entries: c.entries.slice(sentEntries), proposals: c.proposals.slice(-50) };
    sentEntries = c.entries.length;
    if (c.statusVersion !== sentStatusVersion) {
      sentStatusVersion = c.statusVersion;
      catalog.status = c.statuses();
    }
  }

  let bodies: Float32Array<ArrayBuffer> | undefined;
  if (s.posesVersion !== sentPosesVersion || s.objects.version !== sentObjectsVersion) {
    sentPosesVersion = s.posesVersion;
    // Every piece of a jointed Object is its own body: keyed id × 16 + piece.
    const n = s.objects.list.reduce((n, o) => n + 1 + (o.pieces?.length ?? 0), 0);
    bodies = new Float32Array(n * BODY_STRIDE);
    let i = 0;
    for (const o of s.objects.list) {
      bodies.set([o.id * 16, ...o.pos, ...o.rot], i++ * BODY_STRIDE);
      o.pieces?.forEach((p, k) =>
        bodies!.set([o.id * 16 + k + 1, ...p.pos, ...p.rot], i++ * BODY_STRIDE)
      );
    }
  }

  let fires: Float32Array<ArrayBuffer> | undefined;
  if (s.wildfire.version !== sentFireVersion) {
    sentFireVersion = s.wildfire.version;
    const fire = s.wildfire;
    fires = new Float32Array(fire.burning.size * FIRE_STRIDE);
    let i = 0;
    for (const b of fire.burning.values()) {
      fires.set([...fire.box(b), FIRE_KINDS.indexOf(b.kind), b.ref % 997], i);
      i += FIRE_STRIDE;
    }
  }

  // Needs change slowly: once a second, or at once when the board or the mode changed.
  const villageKey = s.village.version * 1e6 + Math.floor(s.tick / TICK_HZ);
  const village = villageKey !== sentVillage
    ? (sentVillage = villageKey, s.village.status())
    : undefined;

  const edits = Int32Array.from(s.pendingEdits);
  s.pendingEdits = [];
  post({
    type: "tick",
    tick: s.tick,
    day: s.day(),
    timeOfDay: s.timeOfDay(),
    speed,
    clouds: s.clouds(),
    heldClouds: s.spectatorClouds,
    board: s.board.version !== sentBoard
      ? (sentBoard = s.board.version, structuredClone(s.board.wishes))
      : undefined,
    props: s.props.version !== sentPropsVersion
      ? (sentPropsVersion = s.props.version, s.props.diff())
      : undefined,
    objects: s.objects.version !== sentObjectsVersion
      ? (sentObjectsVersion = s.objects.version, structuredClone(s.objects.list))
      : undefined,
    agents,
    animals,
    schools,
    profiles,
    catalog,
    village,
    edits,
    crops,
    bodies,
    fires,
    events: s.events.splice(0),
    results: s.results.splice(0),
  }, [
    agents.buffer,
    animals.buffer,
    schools.buffer,
    edits.buffer,
    ...(crops ? [crops.buffer] : []),
    ...(bodies ? [bodies.buffer] : []),
    ...(fires ? [fires.buffer] : []),
  ]);
}

// ---------------------------------------------------------------- persistence

const SEED = 1337;
let savedAt = 0;

/**
 * Open world slot `want`, or with a seed that isn't its world, a new world in a free slot. A save
 * this version can't read is left alone: the world runs without saving and the notice says why.
 */
async function open(want: number, seed?: number): Promise<{ notice?: string }> {
  slot = Number.isInteger(want) && want >= 0 && want < SLOTS ? want : 0;
  readOnly = false;
  savedAt = Date.now();
  const raw = await read(slot);
  if (seed !== undefined && raw && raw.seed !== seed) {
    const free = await freeSlot();
    if (free === null) {
      const r = load(raw);
      return {
        notice: `All ${SLOTS} world slots are full, so seed ${seed} didn't start a new world. ` +
          "Delete one under worlds, then try again." + (r.notice ? " " + r.notice : ""),
      };
    }
    slot = free;
    sim = new Sim(seed);
    return {};
  }
  if (!raw) {
    sim = new Sim(seed ?? SEED);
    return {};
  }
  return load(raw);
}

function load(raw: Record<string, unknown>): { notice?: string } {
  try {
    const data = migrateSave(raw);
    sim = Sim.load(data);
    savedAt = data.savedAt;
    return {};
  } catch (e) {
    sim = new Sim(Number.isSafeInteger(raw.seed) ? raw.seed as number : SEED);
    // A save from before versions were kept starts its island afresh, as it always has.
    if (e instanceof SaveError && e.kind === "older") {
      return {
        notice: "This world was saved before saves were kept, so its island starts afresh.",
      };
    }
    // Never overwrite anything else that couldn't be read: a newer version may still open it.
    readOnly = true;
    const why = e instanceof SaveError ? e.message : `It couldn't be loaded (${e}).`;
    return { notice: `World slot ${slot + 1} wasn't opened: ${why} This island won't be saved.` };
  }
}

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Version 2 (M14): world slots, and a small summary of each for the panel.
    const req = indexedDB.open("agent-inception", 2);
    req.onupgradeneeded = (e) => {
      const d = req.result, tx = req.transaction!;
      if (e.oldVersion < 1) d.createObjectStore("saves");
      d.createObjectStore("meta");
      // The one world from before slots becomes slot 1.
      const saves = tx.objectStore("saves");
      const get = saves.get("world");
      get.onsuccess = () => {
        if (!get.result) return;
        saves.put(get.result, key(0));
        saves.delete("world");
      };
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const key = (n: number) => `slot${n}`;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function read(n: number): Promise<Record<string, unknown> | undefined> {
  try {
    const d = await db();
    return await request(d.transaction("saves").objectStore("saves").get(key(n)));
  } catch {
    return undefined;
  }
}

async function freeSlot(): Promise<number | null> {
  const d = await db();
  const keys = await request(d.transaction("saves").objectStore("saves").getAllKeys());
  for (let n = 0; n < SLOTS; n++) if (!keys.includes(key(n))) return n;
  return null;
}

async function write(n: number, data: SaveData) {
  const d = await db();
  const tx = d.transaction(["saves", "meta"], "readwrite");
  tx.objectStore("saves").put(data, key(n));
  tx.objectStore("meta").put(summary(n, data), key(n));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function summary(n: number, data: SaveData): SlotInfo {
  return {
    slot: n,
    name: data.name,
    seed: data.seed,
    day: Math.floor((data.tick + data.dayOffset) / TICKS_PER_DAY) + 1,
    savedAt: data.savedAt,
    villagers: data.agents.map((a) => a.name),
  };
}

async function persist() {
  if (!sim || readOnly) return;
  await write(slot, sim.save(Date.now()));
}

async function list(): Promise<SlotInfo[]> {
  const d = await db();
  const tx = d.transaction(["saves", "meta"]);
  const keys = await request(tx.objectStore("saves").getAllKeys());
  const out: SlotInfo[] = [];
  for (let n = 0; n < SLOTS; n++) {
    if (!keys.includes(key(n))) {
      out.push({ slot: n, empty: true });
      continue;
    }
    let meta = await request(d.transaction("meta").objectStore("meta").get(key(n))) as
      | SlotInfo
      | undefined;
    if (!meta) {
      // A slot saved before summaries existed (or one this version can't read).
      const raw = await read(n);
      meta = {
        slot: n,
        name: typeof raw?.name === "string" ? raw.name : "an older world",
        seed: Number(raw?.seed ?? 0),
        day: 0,
        savedAt: Number(raw?.savedAt ?? 0),
        villagers: [],
      };
    }
    out.push(meta);
  }
  return out;
}

/** Largest world file accepted, unpacked. A big world is a few MB. */
const MAX_FILE = 64 << 20;

async function slotOp(req: number, op: SlotOp): Promise<SlotsReply> {
  const reply = async (extra: Partial<SlotsReply> = {}): Promise<SlotsReply> => ({
    type: "slots",
    req,
    slots: await list(),
    ...extra,
  });
  try {
    switch (op.op) {
      case "list":
        return await reply();
      case "save":
        await persist();
        return await reply();
      case "delete": {
        if (op.slot === slot) return await reply({ error: "That's the world you're watching." });
        const d = await db();
        const tx = d.transaction(["saves", "meta"], "readwrite");
        tx.objectStore("saves").delete(key(op.slot));
        tx.objectStore("meta").delete(key(op.slot));
        await new Promise((resolve) => (tx.oncomplete = resolve));
        return await reply();
      }
      case "export": {
        if (op.slot === slot) await persist();
        const raw = op.slot === slot && sim ? sim.save(Date.now()) : await read(op.slot);
        if (!raw) return await reply({ error: "That slot is empty." });
        const text = JSON.stringify({ format: FILE_FORMAT, ...raw });
        const bytes = await pipe(new TextEncoder().encode(text), new CompressionStream("gzip"));
        const name = String(raw.name ?? "world").replace(/[^\w -]+/g, "").trim() || "world";
        const day = Math.floor((Number(raw.tick) + Number(raw.dayOffset)) / TICKS_PER_DAY) + 1;
        return await reply({ file: { name: `${name} day ${day}.world.gz`, bytes } });
      }
      case "import": {
        const free = await freeSlot();
        if (free === null) {
          return await reply({ error: `All ${SLOTS} slots are full. Delete one first.` });
        }
        let bytes = new Uint8Array(op.data);
        if (bytes.length > MAX_FILE) return await reply({ error: "That file is too big." });
        // gzip starts 1f 8b; plain JSON is taken as it is.
        if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
          try {
            bytes = await pipe(bytes, new DecompressionStream("gzip"), MAX_FILE);
          } catch (e) {
            const big = e instanceof Error && /too big/.test(e.message);
            return await reply({
              error: big ? e.message : "That file isn't a world (it couldn't be unpacked).",
            });
          }
        }
        let raw: unknown;
        try {
          raw = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          return await reply({ error: "That file isn't a world (not JSON)." });
        }
        if ((raw as Record<string, unknown>)?.format !== FILE_FORMAT) {
          return await reply({ error: "That file isn't an agent-inception world." });
        }
        const { format: _f, ...save } = raw as Record<string, unknown>;
        const data = migrateSave(save);
        Sim.load(structuredClone(data)); // throws now, not when the slot is opened
        // Time away isn't caught up for a file: it opens where it was saved.
        await write(free, { ...data, savedAt: Date.now() });
        return await reply({ slot: free });
      }
    }
  } catch (e) {
    return await reply({ error: e instanceof Error ? e.message : String(e) });
  }
}

/** Run bytes through a (de)compression stream, stopping past `limit` bytes. */
async function pipe(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  limit = Infinity,
): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await out.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await out.cancel();
      throw new Error("That file is too big unpacked.");
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) all.set(p, at), at += p.length;
  return all;
}
