/**
 * WebGPU adapter & device acquisition with progressive fallbacks and software-adapter detection.
 *
 * A bare `requestAdapter({ powerPreference: "high-performance" })` fails on several real setups:
 * laptops where only the integrated GPU is active, browsers/drivers that reject `powerPreference`,
 * GPU processes that are mid-restart, and machines that only expose a fallback software adapter
 * (which WebGPU never returns unless `forceFallbackAdapter: true` is requested).
 */

import { t } from "./i18n.ts";

export const OPTIONAL_FEATURES: readonly GPUFeatureName[] = [
  "timestamp-query",
  "indirect-first-instance",
];

export interface AcquiredGpu {
  ok: true;
  adapter: GPUAdapter;
  device: GPUDevice;
  softwareGpu: boolean;
}

export interface GpuFailure {
  ok: false;
  reason: "unsupported" | "no-adapter" | "no-device";
  message: string;
}

export type GpuResult = AcquiredGpu | GpuFailure;

type AdapterLike = GPUAdapter & { isFallbackAdapter?: boolean };
type AdapterInfoLike = GPUAdapterInfo & { isFallbackAdapter?: boolean };

const SOFTWARE_RE = /swiftshader|llvmpipe|lavapipe|softpipe|warp|basic render|software|cpu/i;

/** Whether `adapter` is a CPU/software fallback (SwiftShader, llvmpipe, WARP, etc.). */
export function isSoftwareAdapter(adapter: GPUAdapter, forcedFallback = false): boolean {
  if (forcedFallback) return true;
  if ((adapter as AdapterLike).isFallbackAdapter) return true;
  try {
    const info = adapter.info as AdapterInfoLike | undefined;
    if (!info) return false;
    if (info.isFallbackAdapter) return true;
    return SOFTWARE_RE.test(
      `${info.vendor ?? ""} ${info.architecture ?? ""} ${info.device ?? ""} ${
        info.description ?? ""
      }`,
    );
  } catch {
    return false;
  }
}

export interface AcquireOptions {
  /** True on localhost/127.0.0.1: error copy may mention local dev commands. */
  devHost?: boolean;
  /** Prefer the software fallback first (e.g. after repeated hardware device loss). */
  preferFallback?: boolean;
  /** Custom delay function (overridden in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Custom GPU handle (defaults to `navigator.gpu`). */
  gpu?: GPU | undefined;
}

interface Candidate {
  options?: GPURequestAdapterOptions;
  fallback: boolean;
}

const DEFAULT_CANDIDATES: readonly Candidate[] = [
  { options: { powerPreference: "high-performance" }, fallback: false },
  { options: undefined, fallback: false },
  { options: { powerPreference: "low-power" }, fallback: false },
  { options: { forceFallbackAdapter: true }, fallback: true },
];

const FALLBACK_ONLY_CANDIDATES: readonly Candidate[] = [
  { options: { forceFallbackAdapter: true }, fallback: true },
  { options: { powerPreference: "low-power" }, fallback: false },
  { options: undefined, fallback: false },
];

/** User-facing failure copy: practical advice for live-site visitors, plus CLI hints in dev. */
export function failureMessage(reason: GpuFailure["reason"], devHost: boolean): string {
  if (reason === "unsupported") return t("gpu.unsupported");
  const base = reason === "no-device" ? t("gpu.noDevice") : t("gpu.noAdapter");
  return devHost ? base + t("gpu.devHint") : base;
}

async function openDevice(adapter: GPUAdapter): Promise<GPUDevice | null> {
  const features = OPTIONAL_FEATURES.filter((f) => adapter.features?.has(f));
  if (features.length) {
    try {
      return await adapter.requestDevice({ requiredFeatures: features });
    } catch {
      // Optional features (e.g. timestamp-query on some drivers) failed; retry without them.
    }
  }
  try {
    return await adapter.requestDevice();
  } catch {
    return null;
  }
}

/**
 * Acquire a working WebGPU adapter and device, falling back across power preferences and software
 * fallback adapters. Retries once after a brief pause in case the browser GPU process is restarting.
 */
export async function acquireGpu(opts: AcquireOptions = {}): Promise<GpuResult> {
  const gpu = "gpu" in opts ? opts.gpu : navigator.gpu;
  const devHost = opts.devHost ?? false;
  if (!gpu) {
    return { ok: false, reason: "unsupported", message: failureMessage("unsupported", devHost) };
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const candidates = opts.preferFallback ? FALLBACK_ONLY_CANDIDATES : DEFAULT_CANDIDATES;
  let sawAdapter = false;

  // Two passes: if the browser GPU process just crashed or reset, a short pause lets it respawn.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(250);
    for (const c of candidates) {
      let adapter: GPUAdapter | null = null;
      try {
        adapter = await gpu.requestAdapter(c.options);
      } catch {
        adapter = null;
      }
      if (!adapter) continue;
      sawAdapter = true;
      const device = await openDevice(adapter);
      if (device) {
        return {
          ok: true,
          adapter,
          device,
          softwareGpu: isSoftwareAdapter(adapter, c.fallback),
        };
      }
    }
  }

  const reason = sawAdapter ? "no-device" : "no-adapter";
  return { ok: false, reason, message: failureMessage(reason, devHost) };
}
