/**
 * Minimal Chromium driver over the DevTools protocol (no Playwright/Puppeteer).
 * Uses a real window: headless Chromium on Linux only gets SwiftShader, not the GPU.
 */
export const webgpuFlags = ["--enable-unsafe-webgpu", "--enable-features=Vulkan"];

export interface Browser {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  close(): Promise<void>;
}

export async function launch(url: string, { width = 1280, height = 720 } = {}): Promise<Browser> {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = await Deno.makeTempDir({ prefix: "agent-inception-chromium-" });
  const proc = new Deno.Command("chromium", {
    args: [
      ...webgpuFlags,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      `--window-size=${width},${height}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--app=${url}`,
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

  return {
    send,
    async evaluate<T>(expression: string) {
      const r = await send<{ result: { value: T }; exceptionDetails?: { text: string } }>(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
      );
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    },
    async close() {
      ws.close();
      proc.kill();
      await proc.status;
      await Deno.remove(profile, { recursive: true }).catch(() => {});
    },
  };
}
