import { Camera } from "./camera.ts";
import { createDevPanel, type DevState } from "./devpanel.ts";
import { createFrameStats } from "./perf.ts";
import { LOOKS } from "./render/look.ts";
import { Renderer } from "./render/renderer.ts";
import { generateMeadow } from "./sim/worldgen.ts";

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
const state: DevState = {
  look: params.get("look") ?? "lush",
  timeOfDay: Number(params.get("time") ?? 0.38),
  daySpeed: Number(params.get("speed") ?? 0.1),
  seed: Number(params.get("seed") ?? 1337),
};

let world = generateMeadow({ seed: state.seed });
let renderer = new Renderer(device, context, format, world);
const camera = new Camera([world.sizeX, world.sizeZ], (x, z) => world.heightAt(x, z));
camera.attach(canvas);

const panel = createDevPanel(state, (seed) => {
  world = generateMeadow({ seed });
  renderer = new Renderer(device, context, format, world);
});

function resize() {
  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
}
new ResizeObserver(resize).observe(canvas);
resize();

const stats = createFrameStats();
(globalThis as Record<string, unknown>).__perf = {
  summary: () => ({ ...stats.summary(), ...renderer.stats }),
  gpuErrors,
};

let last = performance.now();
let lastPanel = 0;
function frame(now: number) {
  stats.tick(now);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  state.timeOfDay = (state.timeOfDay + dt * state.daySpeed / 60) % 1;

  renderer.render(camera, LOOKS[state.look] ?? LOOKS.lush, state.timeOfDay, now / 1000);

  if (now - lastPanel > 250) {
    lastPanel = now;
    const s = stats.summary();
    const r = renderer.stats;
    panel.update([
      `${(1000 / s.meanMs).toFixed(0)} fps`,
      `gpu ${r.gpuMs ? r.gpuMs.toFixed(2) + " ms" : "n/a"}`,
      `${(r.grassBlades / 1000).toFixed(0)}k blades`,
    ]);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
