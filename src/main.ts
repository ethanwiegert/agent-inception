import { type CallReply, connectBridge } from "./agentlink.ts";
import { Camera } from "./camera.ts";
import { createDevPanel } from "./devpanel.ts";
import { Overlay } from "./overlay.ts";
import { createFrameStats } from "./perf.ts";
import { LOOKS } from "./render/look.ts";
import { Renderer } from "./render/renderer.ts";
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

const context = canvas.getContext("webgpu") as GPUCanvasContext;
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format, alphaMode: "opaque" });

const params = new URLSearchParams(location.search);
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
  renderer = new Renderer(device, context, format, world);
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
  const who = await client.call(session, "_whoami", {});
  const label = who.isError ? String(args.name ?? "someone") : agentName(Number(who.text));
  if (!QUIET_TOOLS.has(name) && !ANNOUNCED_TOOLS.has(name)) {
    overlay.log(label, `${name} ${clip(JSON.stringify(args), 120)}`);
  }
  const r = await client.call(session, name, args);
  if (ANNOUNCED_TOOLS.has(name) && r.isError) {
    overlay.log(label, `${name}: ${clip(r.text, 160)}`, true);
  }
  if (!QUIET_TOOLS.has(name) && !ANNOUNCED_TOOLS.has(name) && name !== "say") {
    overlay.log(label, firstSentence(r.text), r.isError);
  }
  return { content: [{ type: "text", text: r.text }], isError: r.isError };
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

/** Center the view on the caller, let the camera settle, then grab a frame. */
async function screenshot(session: string): Promise<CallReply> {
  const who = await client.call(session, "_whoami", {});
  if (who.isError) return { content: [{ type: "text", text: who.text }], isError: true };
  const id = Number(who.text);
  if (!camera || !renderer) {
    return { content: [{ type: "text", text: "Still loading." }], isError: true };
  }
  camera.follow = id;
  await new Promise((r) => setTimeout(r, 900)); // let a visible view glide over
  // Then snap and render directly: animation frames don't run while the tab is hidden.
  const me = client.agents(performance.now()).find((a) => a.id === id);
  // Frame a ~20 block neighbourhood for the agent, then hand the spectator their view back.
  const saved = camera.pose();
  camera.snap({ x: me?.x, z: me?.z, distance: 26 });
  draw(performance.now());
  const dataUrl = captureFrame();
  camera.snap(saved);
  return {
    content: [
      { type: "image", data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: "image/jpeg" },
      { type: "text", text: "You're in the middle of the frame, under your name tag." },
    ],
    isError: false,
  };
}

const shotCanvas = document.createElement("canvas");
function captureFrame(): string {
  // Must run in the same task as draw(), before the WebGPU canvas is presented.
  const w = Math.min(1024, canvas.width);
  shotCanvas.width = w;
  shotCanvas.height = Math.round((canvas.height / canvas.width) * w);
  shotCanvas.getContext("2d")!.drawImage(canvas, 0, 0, shotCanvas.width, shotCanvas.height);
  return shotCanvas.toDataURL("image/jpeg", 0.85);
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
  __game: { client, call: handleTool, camera: () => camera },
});

let lastPanel = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  stats.tick(now);
  draw(now);
}
requestAnimationFrame(frame);

function draw(now: number) {
  if (!renderer || !camera) return;
  const agents = client.agents(now);
  const followed = agents.find((a) => a.id === camera!.follow);
  if (followed) camera.track(followed.x, followed.z);

  renderer.render(camera, LOOKS[look] ?? LOOKS.natural, client.timeOfDay, now / 1000, {
    agents,
    animals: client.animals(now),
    schools: client.schools,
    crops: client.crops,
    cropsVersion: client.cropsVersion,
    blocks: client.blocks,
    catalog: client.catalog,
    props: client.props,
    tick: client.tick,
    day: client.day,
    weather: { clouds: client.clouds },
  });
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
}
