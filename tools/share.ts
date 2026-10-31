/**
 * A public HTTPS link to a world on this machine, for cloud agents (Meta's Muse, OpenAI's Dots,
 * Grok Bot…) that can only reach remote MCP servers on the internet, never localhost.
 *
 *   deno task share                    quick Cloudflare tunnel; open the page it prints
 *   deno task share --headless         the same, with the world kept running in headless Chromium
 *   deno task share https://my.tunnel  your own tunnel (ngrok, Tailscale Funnel…) to :5174
 *
 * Only paired world links go through: a gate on 127.0.0.1:5174 forwards `/mcp/<code>` to the dev
 * server's bridge and answers everything else 404, so the secretless local room (`/mcp`), the
 * game socket and the page itself stay on this machine. The page, opened with `?share=<base>`,
 * pairs its world slot and shows `<base>/mcp/<code>` on its connect card.
 *
 *   cloud agent ──https──▶ tunnel ──▶ gate :5174 ──/mcp/<code>──▶ bridge :5173 ──ws──▶ game tab
 *
 * The tunnel is a dev tool run with npx (a pinned `cloudflared` wrapper that fetches Cloudflare's
 * binary), never a dependency; an installed `cloudflared` is used first.
 */
import { CODE_RE } from "../relay/core.ts";
import { ensureGame, GAME_PORT } from "./serve.ts";

export const GATE_PORT = 5174;
const CLOUDFLARED_NPM = "cloudflared@0.7.3";
const QUICK_TUNNEL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
/** Request headers an MCP client sends that the relay reads; nothing else crosses the gate. */
const PASS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "origin"];

/**
 * The gate: forwards only a world link's MCP requests to `target` (the game server). Hosted
 * clients' OAuth discovery probes (`/.well-known/…`) get a plain 404, which reads as "no auth".
 */
export function createGate(
  target: string,
  send: (req: Request) => Promise<Response> | Response = fetch,
) {
  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    const m = pathname.match(/^\/mcp\/([^/]+)$/);
    if (!m || !CODE_RE.test(m[1])) {
      return new Response("agent-inception: only world links are shared here", { status: 404 });
    }
    const headers = new Headers();
    for (const h of PASS) {
      const v = req.headers.get(h);
      if (v !== null) headers.set(h, v);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const res = await send(
      new Request(`${target}/mcp/${m[1]}`, {
        method: req.method,
        headers,
        body: hasBody ? await req.arrayBuffer() : undefined,
      }),
    );
    const out = new Headers();
    for (const h of ["content-type", "mcp-session-id", "allow"]) {
      const v = res.headers.get(h);
      if (v !== null) out.set(h, v);
    }
    return new Response(res.body, { status: res.status, headers: out });
  };
}

/** A public base URL: https, an origin and nothing more. */
export function shareBase(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.pathname === "/" && !u.search && !u.hash ? u.origin : null;
  } catch {
    return null;
  }
}

/** Start a Cloudflare quick tunnel to the gate; resolves to its public base URL. */
async function quickTunnel(): Promise<string> {
  const target = `http://127.0.0.1:${GATE_PORT}`;
  const args = ["tunnel", "--no-autoupdate", "--url", target];
  let cmd: Deno.Command;
  try {
    await new Deno.Command("cloudflared", { args: ["--version"], stdout: "null", stderr: "null" })
      .output();
    cmd = new Deno.Command("cloudflared", { args, stdout: "null", stderr: "piped" });
  } catch {
    console.log(`share: starting a Cloudflare quick tunnel with npx ${CLOUDFLARED_NPM}`);
    cmd = new Deno.Command("npx", {
      args: ["-y", CLOUDFLARED_NPM, ...args],
      stdout: "null",
      stderr: "piped",
    });
  }
  const child = cmd.spawn();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    Deno.addSignalListener(signal, () => {
      try {
        child.kill();
      } catch { /* gone */ }
      Deno.exit(0);
    });
  }
  const lines = child.stderr.pipeThrough(new TextDecoderStream()).getReader();
  let seen = "";
  const timeout = setTimeout(() => {
    console.error(`share: no tunnel after 60 s. cloudflared said:\n${seen.slice(-2000)}`);
    Deno.exit(1);
  }, 60_000);
  while (true) {
    const { value, done } = await lines.read();
    if (done) {
      console.error(`share: the tunnel stopped. cloudflared said:\n${seen.slice(-2000)}`);
      Deno.exit(1);
    }
    seen += value;
    const url = seen.match(QUICK_TUNNEL_RE)?.[0];
    if (url) {
      clearTimeout(timeout);
      // Keep draining its log so the pipe never fills and stalls the tunnel.
      (async () => {
        while (!(await lines.read()).done) { /* drain */ }
      })();
      return url;
    }
  }
}

if (import.meta.main) {
  const headless = Deno.args.includes("--headless");
  const own = Deno.args.find((a) => !a.startsWith("--"));
  const given = own ? shareBase(own) : null;
  if (own && !given) {
    console.error("share: your own tunnel's URL is an https origin, like https://my.example.app");
    Deno.exit(1);
  }
  const game = await ensureGame("share");
  Deno.serve(
    { port: GATE_PORT, hostname: "127.0.0.1", onListen() {} },
    createGate(`http://127.0.0.1:${GAME_PORT}`),
  );
  const base = given ?? await quickTunnel();
  const page = `${game}?share=${encodeURIComponent(base)}`;
  console.log(`share: ${base} reaches this machine; only world links go through it.`);
  if (headless) {
    console.log("share: keeping the world running headless (deno task host)");
    const host = new Deno.Command("deno", { args: ["run", "-A", "tools/host.ts", page] }).spawn();
    Deno.exit((await host.status).code);
  }
  console.log(
    `\nOpen this page and keep it open (a background tab is fine):\n\n  ${page}\n\n` +
      "Its connect card (panel → connect an agent) shows the world's public agent link, " +
      "ready for Muse, Dots, Grok Bot or any MCP client.",
  );
}
