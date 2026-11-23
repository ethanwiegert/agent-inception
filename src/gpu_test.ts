import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { acquireGpu, failureMessage, isSoftwareAdapter } from "./gpu.ts";

function fakeAdapter(opts: {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  isFallbackAdapter?: boolean;
  features?: GPUFeatureName[];
  failWithFeatures?: boolean;
  failDevice?: boolean;
} = {}): GPUAdapter {
  const features = new Set<GPUFeatureName>(opts.features ?? []);
  return {
    features: features as unknown as GPUSupportedFeatures,
    limits: {} as GPUSupportedLimits,
    info: {
      vendor: opts.vendor ?? "acme",
      architecture: opts.architecture ?? "gpu1",
      device: opts.device ?? "gpu",
      description: opts.description ?? "Hardware GPU",
      isFallbackAdapter: opts.isFallbackAdapter ?? false,
    } as unknown as GPUAdapterInfo,
    requestDevice(desc?: GPUDeviceDescriptor) {
      if (opts.failDevice) return Promise.reject(new Error("device failed"));
      if (opts.failWithFeatures && desc?.requiredFeatures) {
        return Promise.reject(new Error("feature rejected"));
      }
      return Promise.resolve(
        { features: new Set(desc?.requiredFeatures ?? []) } as unknown as GPUDevice,
      );
    },
  } as unknown as GPUAdapter;
}

const noSleep = () => Promise.resolve();

Deno.test("gpu: falls back from high-performance to default, low-power, and fallback adapter", async () => {
  const calls: (GPURequestAdapterOptions | undefined)[] = [];
  const gpu = {
    requestAdapter(options?: GPURequestAdapterOptions) {
      calls.push(options);
      if (options?.forceFallbackAdapter) {
        return Promise.resolve(fakeAdapter({ vendor: "google", architecture: "swiftshader" }));
      }
      return Promise.resolve(null);
    },
  } as unknown as GPU;

  const res = await acquireGpu({ gpu, sleep: noSleep });
  assert(res.ok);
  assertEquals(res.softwareGpu, true);
  assertEquals(calls, [
    { powerPreference: "high-performance" },
    undefined,
    { powerPreference: "low-power" },
    { forceFallbackAdapter: true },
  ]);
});

Deno.test("gpu: retries requestDevice without optional features if driver rejects them", async () => {
  const adapter = fakeAdapter({
    features: ["timestamp-query", "indirect-first-instance"],
    failWithFeatures: true,
  });
  const gpu = {
    requestAdapter: () => Promise.resolve(adapter),
  } as unknown as GPU;

  const res = await acquireGpu({ gpu, sleep: noSleep });
  assert(res.ok);
  assertEquals(res.softwareGpu, false);
});

Deno.test("gpu: moves to the next candidate if an adapter fails requestDevice", async () => {
  const gpu = {
    requestAdapter(options?: GPURequestAdapterOptions) {
      if (options?.powerPreference === "high-performance") {
        return Promise.resolve(fakeAdapter({ failDevice: true }));
      }
      if (options?.powerPreference === "low-power") {
        return Promise.resolve(fakeAdapter({ vendor: "intel", description: "Iris Xe" }));
      }
      return Promise.resolve(null);
    },
  } as unknown as GPU;

  const res = await acquireGpu({ gpu, sleep: noSleep });
  assert(res.ok);
  assertEquals(res.softwareGpu, false);
  assertEquals(res.adapter.info.vendor, "intel");
});

Deno.test("gpu: retries once after a pause when the GPU process is restarting", async () => {
  let sleeps = 0;
  const gpu = {
    requestAdapter(options?: GPURequestAdapterOptions) {
      if (sleeps === 0) return Promise.resolve(null);
      if (options?.powerPreference === "high-performance") {
        return Promise.resolve(fakeAdapter({ vendor: "amd" }));
      }
      return Promise.resolve(null);
    },
  } as unknown as GPU;

  const res = await acquireGpu({
    gpu,
    sleep: () => {
      sleeps++;
      return Promise.resolve();
    },
  });
  assert(res.ok);
  assertEquals(sleeps, 1);
  assertEquals(res.softwareGpu, false);
});

Deno.test("gpu: live-site error message omits CLI flags while dev host keeps them", async () => {
  const gpu = { requestAdapter: () => Promise.resolve(null) } as unknown as GPU;
  const prod = await acquireGpu({ gpu, devHost: false, sleep: noSleep });
  assert(!prod.ok);
  assertEquals(prod.reason, "no-adapter");
  assert(!prod.message.includes("deno task host"));
  assert(!prod.message.includes("--enable-unsafe-webgpu"));

  const dev = await acquireGpu({ gpu, devHost: true, sleep: noSleep });
  assert(!dev.ok);
  assert(dev.message.includes("deno task host"));
  assert(failureMessage("unsupported", false).includes("WebGPU"));
});

Deno.test("gpu: detects software adapters by flag, vendor, or forced fallback", () => {
  assertEquals(isSoftwareAdapter(fakeAdapter({ vendor: "nvidia" }), false), false);
  assertEquals(isSoftwareAdapter(fakeAdapter({ vendor: "nvidia" }), true), true);
  assertEquals(isSoftwareAdapter(fakeAdapter({ isFallbackAdapter: true }), false), true);
  assertEquals(
    isSoftwareAdapter(fakeAdapter({ description: "Microsoft Basic Render Driver" }), false),
    true,
  );
  assertEquals(isSoftwareAdapter(fakeAdapter({ architecture: "llvmpipe" }), false), true);
});
