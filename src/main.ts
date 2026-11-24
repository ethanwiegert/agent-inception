import { type CallReply, connectLink, type Link, type LinkState } from "./agentlink.ts";
import { SoundScape } from "./audio.ts";
import { Camera } from "./camera.ts";
import { attachReverseCaptcha } from "./captcha.ts";
import { createConnectCard } from "./connect.ts";
import { createDevPanel } from "./devpanel.ts";
import { acquireGpu } from "./gpu.ts";
import { Overlay, project, TAG_HEIGHT } from "./overlay.ts";
import { createFrameStats } from "./perf.ts";
import { pref, setPref } from "./prefs.ts";
import { newSecret, relayFor } from "../relay/core.ts";
import { LOOKS } from "./render/look.ts";
import { type Capture, type Quality, Renderer, type RenderTarget } from "./render/renderer.ts";
import { FIRE_STRIDE, SLOTS, type SlotsReply } from "./sim/protocol.ts";
import { mcpTools, TOOL_DEFS } from "./sim/tools.ts";
import { SimClient } from "./simclient.ts";
import { createSupportLinks } from "./support.ts";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const params = new URLSearchParams(location.search);
// Use the primary input so touchscreen laptops keep the desktop defaults.
const mobile = matchMedia("(pointer: coarse) and (hover: none)").matches;
/** On the dev server the page uses the bridge's local room unless `?relay=1` asks for a paired one. */
const devHost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
// Headless harnesses (software WebGPU without a swapchain) never touch the canvas: frames render
// offscreen, and `__game.capture()` reads them back.
const headless = params.has("headless");
// The GitHub and Support links go up first, so even a browser without WebGPU gets them.
if (!headless) createSupportLinks();

/** Say why the game can't run, over the page's own "what this is" (index.html's `#about`). */
function showFatal(message: string) {
  const el = document.getElementById("fatal")!;
  el.textContent = message;
  const retry = document.getElementById("fatal-retry") as HTMLButtonElement | null;
  if (retry) {
    retry.hidden = false;
    retry.onclick = () => location.reload();
  }
  document.getElementById("about")!.hidden = false;
}

function fatal(message: string): never {
  showFatal(message);
  throw new Error(message);
}

const initialGpu = await acquireGpu({ devHost });
if (!initialGpu.ok) fatal(initialGpu.message);
let device = initialGpu.device;
let softwareGpu = initialGpu.softwareGpu;
const gpuErrors: string[] = [];
const context = headless ? null : canvas.getContext("webgpu") as GPUCanvasContext | null;
if (!headless && !context) {
  fatal("Could not initialize a WebGPU canvas context in this browser.");
}
const format = navigator.gpu.getPreferredCanvasFormat();
let gpuRecovering = false;
let gpuRecoveries = 0;

function configureCanvas() {
  if (!context) return;
  try {
    context.configure({ device, format, alphaMode: "opaque" });
  } catch (e) {
    fatal(`Could not configure WebGPU canvas: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function watchDevice(dev: GPUDevice) {
  dev.addEventListener("uncapturederror", (e) => {
    const message = (e as GPUUncapturedErrorEvent).error.message;
    gpuErrors.push(message);
    console.error(message);
  });
  dev.lost.then((info) => {
    if (dev !== device || info.reason === "destroyed") return;
    void recoverDevice(info.message);
  });
}

async function recoverDevice(reason: string) {
  if (gpuRecovering) return;
  gpuRecovering = true;
  gpuRecoveries++;
  renderer?.destroy();
  renderer = null;
  if (gpuRecoveries > 2) {
    showFatal(`GPU device lost: ${reason || "graphics device reset repeatedly."}`);
    return;
  }
  // Step down load so a GPU timeout / TDR does not immediately trigger again.
  if (!qualityFixed) quality = "low";
  if (fixedScale === null) renderScale = Math.min(renderScale, 0.7);
  resize();
  const next = await acquireGpu({ devHost, preferFallback: gpuRecoveries > 1 });
  if (!next.ok) {
    showFatal(`GPU device lost (${reason || "reset"}), and recovery failed: ${next.message}`);
    return;
  }
  device = next.device;
  softwareGpu = next.softwareGpu;
  liveFrames = mobile ? createFrameQueue(device.queue) : null;
  resetFrameTiming();
  resize();
  watchDevice(device);
  configureCanvas();
  if (client.world) renderer = createRenderer(client.world);
  overlay.log("world", "graphics device reset — recovered");
  gpuRecovering = false;
}

watchDevice(device);
configureCanvas();

const LOOK = LOOKS.miniature;
let linkState: LinkState = "connecting";
let link: Link | null = null;

// ---------------------------------------------------------------- simulation

// The world slot to open: `?slot=` (1-3), else the one last watched in this browser. A `?seed=`
// that isn't that slot's world starts a new world in a free slot (the worker picks it).
const slotParam = Number(params.get("slot")) - 1;
const startSlot = Number.isInteger(slotParam) && slotParam >= 0 && slotParam < SLOTS
  ? slotParam
  : Math.max(0, Math.min(SLOTS - 1, Number(pref("slot") ?? 0) || 0));
const client = new SimClient(
  params.has("seed") ? Number(params.get("seed")) : undefined,
  startSlot,
);
if (params.has("speed")) client.send({ type: "speed", speed: Number(params.get("speed")) });
if (params.has("time")) client.send({ type: "setTime", timeOfDay: Number(params.get("time")) });
if (params.has("sandbox")) {
  client.send({ type: "villageLife", on: params.get("sandbox") === "0" });
}
addEventListener("visibilitychange", () => document.hidden && client.send({ type: "save" }));

// Clicking a name (over a head or in the panel) follows that agent; clicking again lets go.
const toggleFollow = (id: number | null) => {
  if (!camera) return;
  if (id === null || camera.follow === id) camera.follow = null;
  else camera.focus(id);
};
const overlay = new Overlay(toggleFollow);
const sound = new SoundScape();
attachReverseCaptcha(canvas);
let renderer: Renderer | null = null;
let camera: Camera | null = null;

const fixedGrass = params.has("grass") ? Number(params.get("grass")) || 1 : null;
/** Grass density per quality tier (or software adapter floor) unless `?grass=` overrides it. */
function grassFor(q: Quality): number {
  if (fixedGrass !== null) return fixedGrass;
  if (softwareGpu) return q === "low" ? 0.25 : 0.3;
  return q === "low" ? 0.4 : q === "medium" ? 0.65 : 1;
}

function createRenderer(world: NonNullable<SimClient["world"]>): Renderer {
  const r = new Renderer(device, world, { lightweight: mobile || softwareGpu });
  r.debug = new Set((params.get("debug") ?? "").split(",").filter(Boolean));
  r.quality = quality;
  r.grassDensity = grassFor(quality);
  return r;
}

/** Milliseconds from navigation until the world was ready to draw (the first-frame budget). */
let readyMs = 0;
client.onReady = (world, caughtUp, notice) => {
  setPref("slot", String(client.slot));
  // The seed has done its job (a new world, in its own slot): reloading shouldn't ask again.
  if (params.has("seed") || params.has("slot")) {
    const url = new URL(location.href);
    url.searchParams.delete("seed");
    url.searchParams.delete("slot");
    history.replaceState(null, "", url);
  }
  if (notice) {
    overlay.log("world", notice, true);
    panel.notice(notice);
  }
  void refreshWorlds();
  if (!link) void startLink();
  // A new world replaces the renderer; free the old one's GPU resources.
  renderer?.destroy();
  renderer = createRenderer(world);
  readyMs ||= performance.now();
  if (!camera) {
    camera = new Camera([world.sizeX, world.sizeZ], (x, z) => client.world!.heightAt(x, z));
    camera.attach(canvas);
  }
  if (caughtUp > 20 * 60) {
    overlay.log("world", `caught up ${Math.round(caughtUp / 20 / 60)} min while you were away`);
  }
};

client.onEvent = (event) => {
  sound.event(event, agentAt);
  if (event.type === "say") {
    overlay.say(event.agent, event.text, performance.now());
    overlay.log(agentName(event.agent), `says “${event.text}”`);
  } else if (event.type === "catch") {
    overlay.say(event.agent, `Caught a ${event.fish}!`, performance.now());
  } else if (event.type === "joined") {
    overlay.log(agentName(event.agent), "arrived in the meadow");
  } else if (event.type === "rule") {
    if (event.agent) overlay.say(event.agent, event.text, performance.now());
    overlay.log(`✦ ${event.rule}`, event.text);
  } else if (event.type === "catalog") {
    overlay.log(event.agent ? agentName(event.agent) : "catalog", event.text);
  } else if (event.type === "physics") {
    overlay.log(agentName(event.agent), event.text);
  } else if (event.type === "village") {
    overlay.log(event.agent ? agentName(event.agent) : "village", event.text);
  } else if (event.type === "board") {
    overlay.log(event.agent ? agentName(event.agent) : "✎ notice board", event.text);
    // A reply is said aloud too, so spectators see it over the villager's head.
    if (event.agent && event.text.startsWith("replied")) {
      overlay.say(event.agent, event.text.replace(/^replied to #\d+: /, ""), performance.now());
    }
  } else if (event.type === "signal") {
    renderer?.particles.spark(event.from, event.to, event.on, performance.now() / 1000);
  }
};

const agentName = (id: number) => client.profiles[id - 1]?.name ?? `#${id}`;
const agentAt = (id: number): [number, number, number] | undefined => {
  const a = client.agents(performance.now()).find((a) => a.id === id);
  return a && [a.x, a.y + 1, a.z];
};

// ---------------------------------------------------------------- agents

const QUIET_TOOLS = new Set([
  "look",
  "journal_read",
  "_whoami",
  "wait",
  "join",
  "catalog_find",
  "catalog_get",
  "proposals",
  "board",
  // Said aloud: the sim's say event logs it once, in quotes.
  "say",
]);
/** Catalog authoring is announced by the sim itself, with names instead of raw JSON. */
const ANNOUNCED_TOOLS = new Set(["catalog_add", "catalog_fork", "propose", "vote"]);

async function handleTool(
  session: string,
  name: string,
  args: Record<string, unknown>,
): Promise<CallReply> {
  if (!TOOL_DEFS.some((t) => t.name === name)) {
    return { content: [{ type: "text", text: `Unknown tool "${name}".` }], isError: true };
  }
  if (name === "screenshot") return await screenshot(session);
  const id = name === "join" ? null : await whoIs(session);
  const label = id === null ? String(args.name ?? "someone") : agentName(id);
  if (!QUIET_TOOLS.has(name) && !ANNOUNCED_TOOLS.has(name)) {
    overlay.log(label, `${name} ${clip(JSON.stringify(args), 120)}`);
  }
  const r = await client.call(session, name, args);
  if (name === "join" && !r.isError) {
    // Joining may bind the session to another villager: learn which, ready for its next call.
    sessionAgents.delete(session);
    void whoIs(session);
  }
  if (ANNOUNCED_TOOLS.has(name) && r.isError) {
    overlay.log(label, `${name}: ${clip(r.text, 160)}`, true);
  }
  if (!QUIET_TOOLS.has(name) && !ANNOUNCED_TOOLS.has(name) && name !== "say") {
    overlay.log(label, firstSentence(r.text), r.isError);
  }
  return { content: [{ type: "text", text: r.text }], isError: r.isError };
}

/** Which villager each session drives: asked of the sim once, so calls don't wait for it. */
const sessionAgents = new Map<string, number>();
async function whoIs(session: string): Promise<number | null> {
  const known = sessionAgents.get(session);
  if (known !== undefined) return known;
  const who = await client.call(session, "_whoami", {});
  if (who.isError) return null;
  sessionAgents.set(session, Number(who.text));
  return Number(who.text);
}

const firstSentence = (text: string) => text.split(/(?<=\.)\s/)[0];
const clip = (text: string, n: number) => text.length > n ? text.slice(0, n - 1) + "…" : text;

const SHOT_WIDTH = 1024, SHOT_HEIGHT = 640;

/** Center the view on the caller, let the camera settle, then render a frame offscreen. */
async function screenshot(session: string): Promise<CallReply> {
  const id = await whoIs(session);
  if (id === null) {
    return {
      content: [{ type: "text", text: 'Call "join" with your name first.' }],
      isError: true,
    };
  }
  if (!camera || !renderer) {
    return { content: [{ type: "text", text: "Still loading." }], isError: true };
  }
  camera.follow = id;
  // Let a visible view glide over; a headless tab has no one watching it glide.
  if (!headless && !document.hidden) await new Promise((r) => setTimeout(r, 900));
  // Frame a ~20 block neighbourhood for the agent at a fixed size, whatever the spectator's window
  // (offscreen, so it works while the tab is hidden too), then hand the spectator their view back.
  const me = client.agents(performance.now()).find((a) => a.id === id);
  const data = await captureView({ x: me?.x, z: me?.z, distance: 26 }, SHOT_WIDTH, SHOT_HEIGHT);
  return {
    content: [
      { type: "image", data, mimeType: "image/jpeg" },
      { type: "text", text: "You're in the middle of the frame, under your name tag." },
    ],
    isError: false,
  };
}

type Pose = Parameters<Camera["snap"]>[0];

/**
 * Render `pose` offscreen at `width` × `height` with villager name tags, as base64. The
 * spectator's camera is back where it was before the next frame.
 */
async function captureView(
  pose: Pose | null,
  width: number,
  height: number,
  type: "image/jpeg" | "image/png" = "image/jpeg",
  /** Render time in ms (wind, waves, drifting clouds); now by default. Fix it to compare shots. */
  at = performance.now(),
): Promise<string> {
  // One capture at a time: a crowd of agents asking at once queues instead of rendering (and
  // holding offscreen targets) side by side, which matters most on a software adapter.
  const turn = captureTurn.then(() => capturePose(pose, width, height, type, at));
  captureTurn = turn.then(() => {}, () => {});
  return await turn;
}
let captureTurn = Promise.resolve();

async function capturePose(
  pose: Pose | null,
  width: number,
  height: number,
  type: "image/jpeg" | "image/png",
  at: number,
): Promise<string> {
  if (!camera || !renderer) throw new Error("Still loading.");
  const cam = camera;
  const viewProj = new Float32Array(16);
  let agents: { name: string; x: number; y: number; z: number }[] = [];
  const shot = await renderer.capture(width, height, (target) => {
    const saved = cam.pose();
    if (pose) cam.snap(pose);
    // Agent views are reused frame to frame; keep this frame's positions for the name tags.
    agents = draw(at, target, true).map(({ name, x, y, z }) => ({ name, x, y, z }));
    viewProj.set(cam.viewProj);
    cam.snap(saved);
  });
  return await encodeShot(shot, agents, viewProj, type);
}

async function encodeShot(
  shot: Capture,
  agents: { name: string; x: number; y: number; z: number }[],
  viewProj: Float32Array,
  type: string,
): Promise<string> {
  const c = new OffscreenCanvas(shot.width, shot.height);
  // A CPU canvas: it is only written once and encoded, and a GPU-backed one loses putImageData
  // on some adapters (Chromium on Vulkan), which left hardware screenshots blank.
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.putImageData(new ImageData(shot.data, shot.width, shot.height), 0, 0);
  ctx.font = "600 14px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const at: [number, number] = [0, 0];
  for (const a of agents) {
    if (!project(viewProj, a.x, a.y + TAG_HEIGHT, a.z, shot.width, shot.height, at)) continue;
    const w = ctx.measureText(a.name).width + 14;
    ctx.fillStyle = "rgba(10,14,18,0.6)";
    ctx.beginPath();
    ctx.roundRect(at[0] - w / 2, at[1] - 20, w, 20, 10);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(a.name, at[0], at[1] - 3);
  }
  const bytes = new Uint8Array(
    await (await c.convertToBlob({ type, quality: 0.85 })).arrayBuffer(),
  );
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// ---------------------------------------------------------------- the link to agents

/**
 * `?bridge=` points the tab at another socket, which then drives this world: honoured only on the
 * dev server, so a crafted link to a hosted site can't hand someone's world to a stranger.
 */
const bridgeUrl = devHost ? params.get("bridge") ?? undefined : undefined;
/**
 * `?share=` (dev server only): the public https base `deno task share` tunnels to this machine.
 * The world pairs, and its agent link uses that base so cloud agents (Muse, Dots, Grok Bot) can
 * reach it; the tab itself still talks to the local bridge.
 */
const shareBase = devHost && !bridgeUrl ? httpsOrigin(params.get("share")) : null;
const paired = !bridgeUrl && (!devHost || params.get("relay") === "1" || !!shareBase);

/** An https origin, or null for anything else (a path, another scheme, garbage). */
function httpsOrigin(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.pathname === "/" && !u.search && !u.hash ? u.origin : null;
  } catch {
    return null;
  }
}
let ephemeral = false;

/** This world slot's secret, made the first time the slot is linked and kept in this browser. */
function linkSecret(slot: number, fresh = false): string {
  const key = `link.${slot}`;
  let secret = fresh ? null : pref(key);
  if (!secret) {
    secret = newSecret();
    ephemeral = !setPref(key, secret);
  }
  return secret;
}

const relay = relayFor(location.origin);

async function startLink() {
  link = await connectLink({
    socketBase: relay.socket,
    httpBase: shareBase ?? relay.http,
    socketUrl: bridgeUrl,
    secret: paired ? linkSecret(client.slot) : null,
    tools: mcpTools(),
    handle: handleTool,
    onState: (state) => {
      linkState = state;
      connectCard.update();
    },
  });
  // First visit: say what this is and how to bring an agent in.
  if (!pref("welcomed") && !params.has("headless")) {
    connectCard.show();
    setPref("welcomed", "1");
  }
}

const connectCard = createConnectCard(
  () => ({
    agentUrl: link?.agentUrl ?? "…",
    state: linkState,
    paired,
    ephemeral,
    worldName: client.name,
  }),
  async () => {
    // Agents on the old link are cut off, so they hold no villagers: anyone may join as anyone.
    client.send({ type: "forgetSessions" });
    sessionAgents.clear();
    await link?.renew(linkSecret(client.slot, true));
  },
);

// ---------------------------------------------------------------- world slots

async function refreshWorlds(reply?: SlotsReply) {
  const r = reply ?? await client.slots({ op: "list" });
  panel.worlds(r.slots, client.slot);
  if (r.error) panel.notice(r.error);
  return r;
}

/** Save, then reload into world slot `slot` (with a new seed when starting a world). */
async function openWorld(slot: number, seed?: number) {
  await client.slots({ op: "save" });
  setPref("slot", String(slot));
  const url = new URL(location.href);
  url.searchParams.delete("seed");
  url.searchParams.delete("slot");
  if (seed !== undefined) url.searchParams.set("seed", String(seed));
  location.href = url.href;
}

const worldHandlers = {
  open: (slot: number) => void openWorld(slot),
  async create() {
    const { slots } = await client.slots({ op: "list" });
    const free = slots.find((s) => s.empty);
    if (!free) return panel.notice(`All ${SLOTS} world slots are full. Delete one first.`);
    await openWorld(free.slot, (Math.random() * 1e6) | 0);
  },
  async remove(slot: number) {
    const r = await client.slots({ op: "list" });
    const s = r.slots[slot];
    if (!s || s.empty) return;
    if (!confirm(`Delete “${s.name}” (seed ${s.seed}, day ${s.day})? This can't be undone.`)) {
      return;
    }
    setPref(`link.${slot}`, null);
    await refreshWorlds(await client.slots({ op: "delete", slot }));
  },
  async exportWorld(slot: number) {
    const r = await client.slots({ op: "export", slot });
    if (!r.file) return refreshWorlds(r);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([r.file.bytes], { type: "application/gzip" }));
    a.download = r.file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  },
  async importWorld(file: File) {
    const r = await client.slots({ op: "import", data: await file.arrayBuffer() });
    if (r.slot === undefined) return refreshWorlds(r);
    setPref(`link.${r.slot}`, null); // an imported world gets its own new link
    await openWorld(r.slot);
  },
};

// ---------------------------------------------------------------- spectator UI

const panel = createDevPanel({
  quality: (q) => {
    qualityFixed = q !== "auto";
    if (q !== "auto") setQuality(q);
  },
  time: (t) => client.send({ type: "setTime", timeOfDay: t }),
  speed: (speed) => client.send({ type: "speed", speed }),
  worlds: worldHandlers,
  connect: () => connectCard.show(),
  freeVillagers: () => {
    client.send({ type: "forgetSessions" });
    sessionAgents.clear();
    overlay.log("world", "the spectator freed every villager: agents join again by name");
  },
  follow: toggleFollow,
  villageLife: (on) => client.send({ type: "villageLife", on }),
  wish: (text, forName) => client.send({ type: "wish", text, for: forName }),
  unpin: (id) => client.send({ type: "unpin", id }),
  hideReply: (wish, index, hidden) => client.send({ type: "hideReply", wish, index, hidden }),
  sound: (muted) => sound.setMuted(muted),
});

/**
 * Render resolution as a share of the viewport's pixel budget. `?scale=` fixes it; otherwise
 * a device that can't hold ~50 fps renders fewer pixels and earns them back when it has room.
 */
const fixedScale = params.has("scale")
  ? Math.min(1, Math.max(0.25, Number(params.get("scale")) || 1))
  : null;
/** Feature tier from `?quality=` (`low|medium|high`), or null when the governor may move it. */
const fixedQuality = params.get("quality");
const QUALITIES: Quality[] = ["low", "medium", "high"];
/** Phones and software adapters start with the cheaper forward rendering path. */
let quality: Quality = fixedQuality === "low" || fixedQuality === "medium" ||
    fixedQuality === "high"
  ? fixedQuality
  : softwareGpu || mobile
  ? "low"
  : "high";
/** Locked out of the governor: a `?quality=` URL tier, or a tier picked in the panel. */
let qualityFixed = fixedQuality === "low" || fixedQuality === "medium" ||
  fixedQuality === "high";
const SCALE_MIN = 0.5, SCALE_STEP = 0.1, SLOW_MS = 20, SEVERE_MS = 45, WINDOW_MS = 2000;
/**
 * Initial render scale: software adapters start at the floor; very high-DPI screens (4K/Retina)
 * start capped near ~1440p and earn back full native resolution if the GPU has headroom.
 */
function initialScale(): number {
  if (fixedScale !== null) return fixedScale;
  if (softwareGpu) return SCALE_MIN;
  if (mobile) return 0.7;
  const maxDpr = Math.min(devicePixelRatio || 1, 2);
  const pixels = Math.max(1, canvas.clientWidth * maxDpr) *
    Math.max(1, canvas.clientHeight * maxDpr);
  const target = 2_600_000;
  if (pixels <= target) return 1;
  return Math.max(SCALE_MIN, Math.round(Math.sqrt(target / pixels) * 10) / 10);
}
let renderScale = initialScale();
let windowStart = 0, windowFrames = 0, windowSlow = 0, windowMs = 0;
let slowWindows = 0, fastWindows = 0;
let untimedUpgradeWindows = 6;

function resetAdaptiveWindow(now: number) {
  windowStart = now;
  windowFrames = windowSlow = windowMs = 0;
}

/** Change the feature tier, on the URL value, the panel, or the adaptive governor. */
function setQuality(q: Quality) {
  if (q === quality || !QUALITIES.includes(q)) return;
  quality = q;
  if (renderer) {
    renderer.quality = q;
    renderer.grassDensity = grassFor(q);
  }
}

/** Count this frame; every two seconds, step the quality tier or render scale if the frame rate
 * asks for it: a slow GPU sheds features (high → medium → low) before it gives up resolution,
 * and earns the features back only once it's back at full resolution. */
function adaptScale(now: number, interval: number) {
  if (!renderer) return;
  // Mobile intervals include time spent waiting for the GPU queue to make room.
  if (interval <= 0 || (!mobile && interval > 2000)) {
    resetAdaptiveWindow(now);
    return;
  }
  if (!windowStart) windowStart = now;
  windowFrames++;
  windowMs += interval;
  if (interval > SLOW_MS) windowSlow++;
  if (now - windowStart < WINDOW_MS) return;
  const meanMs = windowMs / Math.max(1, windowFrames);
  const slow = windowSlow > windowFrames / 2 || meanMs > SLOW_MS;
  const severe = meanMs > SEVERE_MS;
  const gpu = renderer.stats.gpuMs ?? 0;
  // Some mobile browsers lack timestamp queries. Require a longer run of smooth delivery there.
  const roomy = !softwareGpu && windowSlow < windowFrames / 20 &&
    (gpu > 0 ? gpu < 7 : mobile && meanMs < 18);
  slowWindows = slow ? slowWindows + (severe ? 2 : 1) : 0;
  fastWindows = roomy ? fastWindows + 1 : 0;
  resetAdaptiveWindow(now);
  const was = renderScale;
  if (slowWindows >= 2) {
    const previousQuality = quality;
    const tier = QUALITIES.indexOf(quality);
    if (!qualityFixed && tier > 0) {
      setQuality(QUALITIES[tier - 1]);
    } else if (fixedScale === null && renderScale > SCALE_MIN) {
      renderScale = Math.max(SCALE_MIN, Math.round((renderScale - SCALE_STEP) * 10) / 10);
    }
    // Frame cadence alone can't distinguish spare GPU time from a GPU just keeping up.
    // Back off if a higher load proved too slow, so untimed devices don't keep oscillating.
    if (mobile && gpu === 0 && (quality !== previousQuality || renderScale !== was)) {
      untimedUpgradeWindows = Math.min(60, untimedUpgradeWindows * 2);
    }
    slowWindows = 0;
  } else if (fastWindows >= (gpu > 0 ? 3 : untimedUpgradeWindows)) {
    if (fixedScale === null && renderScale < 1) {
      renderScale = Math.min(1, Math.round((renderScale + SCALE_STEP) * 10) / 10);
    } else if (!qualityFixed && quality !== "high") {
      setQuality(QUALITIES[QUALITIES.indexOf(quality) + 1]);
    }
    fastWindows = 0;
  }
  if (renderScale !== was) resize();
}

let cssWidth = 0, cssHeight = 0;
function resize() {
  cssWidth = canvas.clientWidth;
  cssHeight = canvas.clientHeight;
  const maxDpr = softwareGpu ? 1 : mobile ? 1.5 : 2;
  let dpr = Math.min(devicePixelRatio || 1, maxDpr);
  // Keep the automatic pixel budget bounded even on large tablets. Explicit scales still apply
  // to the usual DPR cap, just as they do on desktop.
  if (mobile && fixedScale === null) {
    dpr = Math.min(dpr, Math.sqrt(900_000 / Math.max(1, cssWidth * cssHeight)));
  }
  const width = Math.max(1, Math.floor(cssWidth * dpr * renderScale));
  const height = Math.max(1, Math.floor(cssHeight * dpr * renderScale));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}
new ResizeObserver(resize).observe(canvas);
resize();

const stats = createFrameStats();
Object.assign(globalThis, {
  __perf: {
    summary: () => ({
      ...stats.summary(),
      ...renderer?.stats,
      readyMs,
      renderScale,
      quality,
      softwareGpu,
      mobile,
    }),
    gpuErrors,
  },
  // Lets tests and the harness drive agents without the bridge.
  __game: {
    client,
    /** The page's sound: `setMuted`, `play(id)`, `started`. */
    sound,
    call: handleTool,
    camera: () => camera,
    /** The URL agents' MCP clients point at for this world (the dev bridge's, or a paired link). */
    agentUrl: () => link?.agentUrl ?? null,
    /** Hard-set painterly miniature theme (kept as no-op for harness compatibility). */
    setLook: (_id: string) => {},
    /** Switch the feature tier (`low|medium|high`), as the spectator panel does. */
    setQuality: (id: string) => setQuality(id as Quality),
    /** A PNG data URL of the current view (or `pose`, at render time `at`), rendered offscreen. */
    capture: async (
      width = canvas.width,
      height = canvas.height,
      pose: Pose | null = null,
      at?: number,
    ) => "data:image/png;base64," + await captureView(pose, width, height, "image/png", at),
  },
});

const frameTarget = (): RenderTarget | null => {
  if (!context || gpuRecovering) return null;
  try {
    return {
      view: context.getCurrentTexture().createView(),
      width: canvas.width,
      height: canvas.height,
      format,
    };
  } catch {
    return null;
  }
};

let lastPanel = 0;
let lastFrame = 0;
let liveFrames = mobile ? createFrameQueue(device.queue) : null;

/** Track this device's submissions independently of any device it replaces. */
function createFrameQueue(queue: GPUQueue) {
  let pending = 0;
  const finished = () => pending--;
  return {
    get full() {
      return pending >= 2;
    },
    track() {
      pending++;
      void queue.onSubmittedWorkDone().then(finished, finished);
    },
  };
}

function resetFrameTiming() {
  resetAdaptiveWindow(0);
  lastFrame = slowWindows = fastWindows = 0;
  stats.pause();
}
document.addEventListener("visibilitychange", resetFrameTiming);

function frame(now: number) {
  requestAnimationFrame(frame);
  if (document.hidden || !renderer || !camera) return;
  // Skip stale mobile camera poses before building the scene. Headless pages only draw on
  // capture requests. In both cases the spectator panel still follows the world.
  if (!context || gpuRecovering || liveFrames?.full) {
    if (headless) stats.tick(now);
    if (now - lastPanel > 250) updatePanel(now, client.agents(now));
    return;
  }
  adaptScale(now, lastFrame ? now - lastFrame : 0);
  const target = frameTarget();
  if (!target) return;
  lastFrame = now;
  stats.tick(now);
  draw(now, target);
  liveFrames?.track();
}
requestAnimationFrame(frame);

/** Render the scene into `out`; captures skip the DOM overlay and panel. Returns the agents drawn. */
function draw(now: number, out: RenderTarget, capture = false) {
  if (!renderer || !camera) return [];
  const agents = client.agents(now);
  const followed = agents.find((a) => a.id === camera!.follow);
  if (followed) camera.track(followed.x, followed.z);
  client.updateLight();
  if (!capture) {
    sound.update(
      now,
      camera,
      agents,
      client.timeOfDay,
      client.clouds,
      nearestFire(),
      client.day,
      client.hasClock ? `${client.slot}:${client.seed}` : "",
    );
  }

  renderer.render(
    camera,
    LOOK,
    client.timeOfDay,
    now / 1000,
    {
      agents,
      animals: client.animals(now),
      schools: client.schools,
      crops: client.crops,
      cropsVersion: client.cropsVersion,
      cropsTick: client.cropsTick,
      blocks: client.blocks,
      catalog: client.catalog,
      props: client.props,
      objects: client.objects,
      bodies: client.bodies(now),
      tick: client.tick,
      day: client.day,
      weather: { clouds: client.clouds },
      light: client.light,
      fires: client.fires,
    },
    out,
    capture,
  );
  if (capture) return agents;
  overlay.update(
    agents,
    camera.viewProj,
    cssWidth,
    cssHeight,
    now,
    camera.follow,
  );

  updatePanel(now, agents);
  return agents;
}

/** Refresh the spectator panel, a few times a second. */
function updatePanel(now: number, agents: { id: number; name: string }[]) {
  if (!renderer || !camera) return;
  if (now - lastPanel > 250) {
    lastPanel = now;
    const s = stats.summary();
    const r = renderer.stats;
    panel.update({
      timeOfDay: client.timeOfDay,
      day: client.day,
      speed: client.speed,
      seed: client.seed,
      link: linkState,
      worldName: client.name,
      agents: agents.map((a) => ({ id: a.id, name: a.name })),
      following: camera.follow,
      catalog: client.catalog,
      village: client.village,
      clouds: client.clouds,
      board: client.board,
      boardVersion: client.boardVersion,
      muted: sound.muted,
      quality,
      qualityAuto: !qualityFixed,
      stats: [
        `${(1000 / s.meanMs).toFixed(0)} fps`,
        `gpu ${r.gpuMs ? r.gpuMs.toFixed(2) + " ms" : "n/a"}`,
        `${(r.grassBlades / 1000).toFixed(0)}k blades`,
        ...(renderScale < 1 ? [`${Math.round(renderScale * 100)}% res`] : []),
        ...(quality !== "high" ? [quality] : []),
      ],
    });
  }
}

/** The burning thing nearest the camera's focus, for the crackle, or null if none is close. */
const firePoint: [number, number, number] = [0, 0, 0];
function nearestFire(): [number, number, number] | null {
  const f = client.fires, t = camera!.target;
  let best = 900;
  let found = false;
  for (let i = 0; i < f.length; i += FIRE_STRIDE) {
    const x = (f[i] + f[i + 1]) / 2, z = (f[i + 4] + f[i + 5]) / 2;
    const d = (x - t[0]) ** 2 + (z - t[2]) ** 2;
    if (d < best) {
      best = d, found = true, firePoint[0] = x, firePoint[1] = f[i + 2], firePoint[2] = z;
    }
  }
  return found ? firePoint : null;
}
