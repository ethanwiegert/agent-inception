import { type CallReply, connectBridge } from "./agentlink.ts";
import { Camera } from "./camera.ts";
import { createDevPanel } from "./devpanel.ts";
import { Overlay, project, TAG_HEIGHT } from "./overlay.ts";
import { createFrameStats } from "./perf.ts";
import { LOOKS } from "./render/look.ts";
import { type Capture, Renderer, type RenderTarget } from "./render/renderer.ts";
import type { Sprite } from "./sim/sim.ts";
import { SPRITE_MAX, TOOL_DEFS } from "./sim/tools.ts";
import { SimClient } from "./simclient.ts";

const canvas = document.getElementById("view") as HTMLCanvasElement;

function fatal(message: string): never {
  const el = document.getElementById("fatal")!;
  el.textContent = message;
  el.style.display = "grid";
  throw new Error(message);
}

if (!navigator.gpu) fatal("agent-inception needs WebGPU. Try a recent Chrome or Edge.");
const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
if (!adapter) fatal("No WebGPU adapter available.");
const features: GPUFeatureName[] = adapter.features.has("timestamp-query")
  ? ["timestamp-query"]
  : [];
const device = await adapter.requestDevice({ requiredFeatures: features });
device.lost.then((info) => fatal(`GPU device lost: ${info.message}`));
const gpuErrors: string[] = [];
device.addEventListener("uncapturederror", (e) => {
  const message = (e as GPUUncapturedErrorEvent).error.message;
  gpuErrors.push(message);
  console.error(message);
});

const params = new URLSearchParams(location.search);
// Headless harnesses (software WebGPU without a swapchain) never touch the canvas: frames render
// offscreen, and `__game.capture()` reads them back.
const headless = params.has("headless");
const context = headless ? null : canvas.getContext("webgpu") as GPUCanvasContext;
const format = navigator.gpu.getPreferredCanvasFormat();
context?.configure({ device, format, alphaMode: "opaque" });

let look = params.get("look") ?? "natural";
let bridgeConnected = false;

// ---------------------------------------------------------------- simulation

const client = new SimClient(params.has("seed") ? Number(params.get("seed")) : undefined);
if (params.has("speed")) client.send({ type: "speed", speed: Number(params.get("speed")) });
if (params.has("time")) client.send({ type: "setTime", timeOfDay: Number(params.get("time")) });
addEventListener("visibilitychange", () => document.hidden && client.send({ type: "save" }));

// Clicking a name (over a head or in the panel) follows that agent; clicking again lets go.
const toggleFollow = (id: number | null) => {
  if (!camera) return;
  if (id === null || camera.follow === id) camera.follow = null;
  else camera.focus(id);
};
const overlay = new Overlay(toggleFollow);
let renderer: Renderer | null = null;
let camera: Camera | null = null;

client.onReady = (world, caughtUp) => {
  renderer = new Renderer(device, world);
  renderer.debug = new Set((params.get("debug") ?? "").split(",").filter(Boolean));
  if (!camera) {
    camera = new Camera([world.sizeX, world.sizeZ], (x, z) => client.world!.heightAt(x, z));
    camera.attach(canvas);
  }
  if (caughtUp > 20 * 60) {
    overlay.log("world", `caught up ${Math.round(caughtUp / 20 / 60)} min while you were away`);
  }
};

client.onEvent = (event) => {
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
  }
};

const agentName = (id: number) => client.profiles[id - 1]?.name ?? `#${id}`;

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
  if (name === "set_sprite" && typeof args.image_base64 === "string") {
    try {
      args = { _pixels: await decodeSprite(args.image_base64) };
    } catch {
      return { content: [{ type: "text", text: "Couldn't decode that image." }], isError: true };
    }
  }
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

/** Decode an uploaded image into sprite pixels, fitted to SPRITE_MAX with crisp (nearest) scaling. */
async function decodeSprite(base64: string): Promise<Sprite> {
  const bytes = Uint8Array.from(atob(base64.replace(/^data:[^,]*,/, "")), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const fit = Math.min(1, SPRITE_MAX / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * fit));
  const height = Math.max(1, Math.round(bitmap.height * fit));
  const ctx = new OffscreenCanvas(width, height).getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const pixels: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    pixels.push(data[i + 3] < 128 ? -1 : (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  }
  return { width, height, pixels };
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
  await new Promise((r) => setTimeout(r, 900)); // let a visible view glide over
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
): Promise<string> {
  if (!camera || !renderer) throw new Error("Still loading.");
  const cam = camera;
  const viewProj = new Float32Array(16);
  let agents: { name: string; x: number; y: number; z: number }[] = [];
  const shot = await renderer.capture(width, height, (target) => {
    const saved = cam.pose();
    if (pose) cam.snap(pose);
    // Agent views are reused frame to frame; keep this frame's positions for the name tags.
    agents = draw(performance.now(), target, true).map(({ name, x, y, z }) => ({ name, x, y, z }));
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
  const ctx = c.getContext("2d")!;
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

const wsScheme = location.protocol === "https:" ? "wss" : "ws";
connectBridge(
  params.get("bridge") ?? `${wsScheme}://${location.host}/bridge`,
  handleTool,
  (connected) => (bridgeConnected = connected),
);

// ---------------------------------------------------------------- spectator UI

const panel = createDevPanel({
  look: (id) => (look = id),
  time: (t) => client.send({ type: "setTime", timeOfDay: t }),
  speed: (speed) => client.send({ type: "speed", speed }),
  seed: (seed) => client.send({ type: "reset", seed }),
  follow: toggleFollow,
});

function resize() {
  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
}
new ResizeObserver(resize).observe(canvas);
resize();

const stats = createFrameStats();
Object.assign(globalThis, {
  __perf: { summary: () => ({ ...stats.summary(), ...renderer?.stats }), gpuErrors },
  // Lets tests and the harness drive agents without the bridge.
  __game: {
    client,
    call: handleTool,
    camera: () => camera,
    /** Switch the look preset, as the spectator panel does. */
    setLook: (id: string) => (look = id),
    /** A PNG data URL of the current view (or `pose`), rendered offscreen. */
    capture: async (width = canvas.width, height = canvas.height, pose: Pose | null = null) =>
      "data:image/png;base64," + await captureView(pose, width, height, "image/png"),
  },
});

const frameTarget = (): RenderTarget => ({
  view: context!.getCurrentTexture().createView(),
  width: canvas.width,
  height: canvas.height,
  format,
});

let lastPanel = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  stats.tick(now);
  // Headless pages (software WebGPU, seconds per frame) draw only when a capture asks.
  if (renderer && camera && context) draw(now, frameTarget());
}
requestAnimationFrame(frame);

/** Render the scene into `out`; captures skip the DOM overlay and panel. Returns the agents drawn. */
function draw(now: number, out: RenderTarget, capture = false) {
  if (!renderer || !camera) return [];
  const agents = client.agents(now);
  const followed = agents.find((a) => a.id === camera!.follow);
  if (followed) camera.track(followed.x, followed.z);

  renderer.render(
    camera,
    LOOKS[look] ?? LOOKS.natural,
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
      tick: client.tick,
      day: client.day,
      weather: { clouds: client.clouds },
    },
    out,
    capture,
  );
  if (capture) return agents;
  overlay.update(
    agents,
    camera.viewProj,
    canvas.clientWidth,
    canvas.clientHeight,
    now,
    camera.follow,
  );

  if (now - lastPanel > 250) {
    lastPanel = now;
    const s = stats.summary();
    const r = renderer.stats;
    panel.update({
      look,
      timeOfDay: client.timeOfDay,
      day: client.day,
      speed: client.speed,
      seed: client.seed,
      bridge: bridgeConnected,
      agents: agents.map((a) => ({ id: a.id, name: a.name })),
      following: camera.follow,
      catalog: client.catalog,
      stats: [
        `${(1000 / s.meanMs).toFixed(0)} fps`,
        `gpu ${r.gpuMs ? r.gpuMs.toFixed(2) + " ms" : "n/a"}`,
        `${(r.grassBlades / 1000).toFixed(0)}k blades`,
      ],
    });
  }
  return agents;
}
