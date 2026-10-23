import { createFrameStats } from "./perf.ts";

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
const device = await adapter.requestDevice();
device.lost.then((info) => fatal(`GPU device lost: ${info.message}`));

const context = canvas.getContext("webgpu") as GPUCanvasContext;
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format, alphaMode: "opaque" });

// Placeholder sky: a fullscreen triangle with a day/night gradient. Replaced in M1.
const shader = device.createShaderModule({
  code: /* wgsl */ `
    struct Frame { time: f32 };
    @group(0) @binding(0) var<uniform> frame: Frame;

    struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

    @vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
      let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
      return Out(vec4f(p * 2.0 - 1.0, 0.0, 1.0), p);
    }

    @fragment fn fs(in: Out) -> @location(0) vec4f {
      let day = 0.5 + 0.5 * sin(frame.time * 0.2);
      let horizon = mix(vec3f(0.10, 0.12, 0.25), vec3f(0.95, 0.80, 0.60), day);
      let zenith = mix(vec3f(0.01, 0.02, 0.06), vec3f(0.35, 0.60, 0.95), day);
      return vec4f(mix(horizon, zenith, in.uv.y), 1.0);
    }
  `,
});

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: shader, entryPoint: "vs" },
  fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
});

const frameData = new Float32Array(4);
const frameBuffer = device.createBuffer({
  size: frameData.byteLength,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [{ binding: 0, resource: { buffer: frameBuffer } }],
});

function resize() {
  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
}
new ResizeObserver(resize).observe(canvas);
resize();

const stats = createFrameStats();
(globalThis as Record<string, unknown>).__perf = stats;

function frame(now: number) {
  stats.tick(now);
  frameData[0] = now / 1000;
  device.queue.writeBuffer(frameBuffer, 0, frameData);

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
