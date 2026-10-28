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
  type CatalogDelta,
  CROP_STRIDE,
  type FromWorker,
  SCHOOL_STRIDE,
  type ToWorker,
} from "./sim/protocol.ts";
import { type SaveData, Sim, TICK_HZ, TICKS_PER_DAY } from "./sim/sim.ts";
import { callTool } from "./sim/tools.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const MAX_CATCH_UP = TICKS_PER_DAY * 3;
const SAVE_EVERY_MS = 5000;

let sim: Sim | null = null;
let speed = 1;
let lastStep = performance.now();
let budget = 0;
let lastSave = 0;
let sentAgentsVersion = -1;
let sentCropsVersion = -1;
let sentPropsVersion = -1;
let sentCatalogVersion = -1;
let sentStatusVersion = -1;
let sentEntries = 0;
let cropsSentAt = 0;

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
      const saved = await load();
      // Saves from before the current format start the same island afresh (until M14).
      if (saved && saved.version !== 2) {
        sim = new Sim(saved.seed);
        start(0);
      } else if (saved && (msg.seed === undefined || msg.seed === saved.seed)) {
        sim = Sim.load(saved);
        const away = Math.min(MAX_CATCH_UP, ((Date.now() - saved.savedAt) / 1000) * TICK_HZ);
        sim.tick += Math.floor(away); // crops grow from the clock, so idle time is just elapsed ticks
        start(Math.floor(away));
      } else {
        sim = new Sim(msg.seed ?? 1337);
        start(0);
      }
      break;
    }
    case "reset":
      sim = new Sim(msg.seed);
      start(0);
      await persist();
      break;
    case "call":
      if (sim) callTool(sim, msg.session, msg.tool, msg.args, msg.callId);
      break;
    case "speed":
      speed = Math.max(0, Math.min(120, msg.speed));
      break;
    case "setTime":
      sim?.setTimeOfDay(msg.timeOfDay);
      break;
    case "save":
      await persist();
      break;
  }
}

function start(caughtUp: number) {
  const s = sim!;
  const edits: number[] = [];
  const w = s.world;
  for (const [index, block] of s.edits) {
    edits.push(
      index % w.sizeX,
      Math.floor(index / (w.sizeX * w.sizeZ)),
      Math.floor(index / w.sizeX) % w.sizeZ,
      block,
    );
  }
  s.pendingEdits = [];
  sentAgentsVersion = sentCropsVersion = -1;
  sentPropsVersion = s.props.version;
  sentCatalogVersion = s.catalog.version;
  sentStatusVersion = s.catalog.statusVersion;
  sentEntries = s.catalog.entries.length;
  post({
    type: "ready",
    seed: s.seed,
    edits: Int32Array.from(edits),
    caughtUp,
    props: s.props.diff(),
    catalog: s.catalog.save(),
  });
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
  send(now);
  if (now - lastSave > SAVE_EVERY_MS) {
    lastSave = now;
    persist();
  }
}, 1000 / TICK_HZ);

function send(now: number) {
  const s = sim!;
  const agents = new Float32Array(s.agents.length * AGENT_STRIDE);
  s.agents.forEach((a, i) => {
    agents.set([a.id, a.x, a.y, a.z, a.yaw, a.anim, a.stride, a.color], i * AGENT_STRIDE);
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
  if (s.cropsVersion !== sentCropsVersion || now - cropsSentAt > 1000) {
    sentCropsVersion = s.cropsVersion;
    cropsSentAt = now;
    crops = new Float32Array(s.crops.size * CROP_STRIDE);
    let i = 0;
    for (const [key, crop] of s.crops) {
      const x = key % s.world.sizeX, z = Math.floor(key / s.world.sizeX);
      const [stalk, ripe] = s.cropColors(crop.design);
      crops.set([x, s.world.heightAt(x, z) + 1, z, s.cropGrowth(crop), stalk, ripe], i);
      i += CROP_STRIDE;
    }
  }

  let profiles: AgentProfile[] | undefined;
  if (s.agentsVersion !== sentAgentsVersion) {
    sentAgentsVersion = s.agentsVersion;
    profiles = s.agents.map((a) => ({ name: a.name, sprite: a.sprite }));
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

  const edits = Int32Array.from(s.pendingEdits);
  s.pendingEdits = [];
  post({
    type: "tick",
    tick: s.tick,
    day: s.day(),
    timeOfDay: s.timeOfDay(),
    speed,
    clouds: s.clouds(),
    props: s.props.version !== sentPropsVersion
      ? (sentPropsVersion = s.props.version, s.props.diff())
      : undefined,
    agents,
    animals,
    schools,
    profiles,
    catalog,
    edits,
    crops,
    events: s.events.splice(0),
    results: s.results.splice(0),
  }, [
    agents.buffer,
    animals.buffer,
    schools.buffer,
    edits.buffer,
    ...(crops ? [crops.buffer] : []),
  ]);
}

// ---------------------------------------------------------------- persistence

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("agent-inception", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("saves");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function load(): Promise<SaveData | undefined> {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const req = d.transaction("saves").objectStore("saves").get("world");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

async function persist() {
  if (!sim) return;
  const data = sim.save(Date.now());
  const d = await db();
  d.transaction("saves", "readwrite").objectStore("saves").put(data, "world");
}
