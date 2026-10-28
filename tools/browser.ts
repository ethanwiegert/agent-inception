/**
 * Minimal Chromium driver over the DevTools protocol (no Playwright/Puppeteer).
 * Uses a real window: headless Chromium on Linux only gets SwiftShader, not the GPU.
 * Without a display (CI, cloud VMs) it falls back to headless SwiftShader: the page runs with
 * `headless` (no swapchain, which software WebGPU can't back) and frames are read back through
 * `__game.capture()`. Software timings say nothing about GPU cost; compare them only to each other.
 */
export const webgpuFlags = ["--enable-unsafe-webgpu", "--enable-features=Vulkan"];
const softwareFlags = [
  "--headless=new",
  "--enable-unsafe-webgpu",
  "--use-webgpu-adapter=swiftshader",
  "--enable-unsafe-swiftshader",
  "--no-sandbox",
];

/** No display to open a window on: use headless software WebGPU. `AI_HEADLESS=1` forces it. */
export const headless = Deno.env.get("AI_HEADLESS") === "1" ||
  (Deno.build.os === "linux" && !Deno.env.get("DISPLAY") && !Deno.env.get("WAYLAND_DISPLAY"));

/** `CHROMIUM`, else `chromium` on the PATH, else a Playwright-installed build. */
async function chromiumPath(): Promise<string> {
  const env = Deno.env.get("CHROMIUM");
  if (env) return env;
  try {
    await new Deno.Command("chromium", { args: ["--version"], stdout: "null" }).output();
    return "chromium";
  } catch { /* not on the PATH */ }
  for (const root of ["/opt/pw-browsers", `${Deno.env.get("HOME")}/.cache/ms-playwright`]) {
    try {
      for await (const d of Deno.readDir(root)) {
        if (!/^chromium-\d+$/.test(d.name)) continue;
        for (const sub of ["chrome-linux64", "chrome-linux"]) {
          const path = `${root}/${d.name}/${sub}/chrome`;
          if (await Deno.stat(path).then(() => true, () => false)) return path;
        }
      }
    } catch { /* no such root */ }
  }
  return "chromium";
}

export interface Browser {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** PNG of what the game shows: the window, or an offscreen capture when headless. */
  screenshot(): Promise<Uint8Array>;
  /** Wait until the game has drawn `frames` frames (software rendering can take seconds each). */
  waitForFrames(frames: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function launch(url: string, { width = 1280, height = 720 } = {}): Promise<Browser> {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = await Deno.makeTempDir({ prefix: "agent-inception-chromium-" });
  if (headless) url += (url.includes("?") ? "&" : "?") + "headless";
  const proc = new Deno.Command(await chromiumPath(), {
    args: [
      ...(headless ? softwareFlags : webgpuFlags),
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      `--window-size=${width},${height}`,
      "--no-first-run",
      "--no-default-browser-check",
      headless ? url : `--app=${url}`,
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();

  let target: { type: string; webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t: { type: string }) => t.type === "page");
    } catch { /* not up yet */ }
    if (!target) await new Promise((r) => setTimeout(r, 100));
  }
  if (!target) throw new Error("Chromium did not expose a page target");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  };

  const send = <T>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async <T>(expression: string) => {
    const r = await send<{
      result: { value: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  };
  const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  return {
    send,
    evaluate,
    async screenshot() {
      if (headless) {
        const url = await evaluate<string>(`__game.capture()`);
        return decode(url.slice(url.indexOf(",") + 1));
      }
      const { data } = await send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      return decode(data);
    },
    async waitForFrames(frames: number, timeoutMs = 60_000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const n = await evaluate<number>(
          `globalThis.__game?.camera() ? __perf.summary().frames : 0`,
        ).catch(() => 0);
        const fatal = await evaluate<string>(`document.getElementById("fatal")?.textContent ?? ""`)
          .catch(() => "");
        if (n >= frames || fatal) return;
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    async close() {
      ws.close();
      proc.kill();
      await proc.status;
      await Deno.remove(profile, { recursive: true }).catch(() => {});
    },
  };
}
