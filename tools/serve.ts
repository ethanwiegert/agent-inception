/** Static file server for `web/` with `dist/` layered on top. */
import { SITE_PAGES, withOrigin } from "../relay/site.ts";

const roots = ["web", "dist"];
const types: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript",
  map: "application/json",
  json: "application/json",
  wgsl: "text/plain",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  bin: "application/octet-stream",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
};

type Route = (req: Request) => Response | Promise<Response> | undefined;

/** The dev server's port, where the game and its MCP bridge live. */
export const GAME_PORT = 5173;

/** Whether `url` answers 2xx within two seconds. */
export async function up(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The game page's URL: `deno task dev` if it's up, else a fresh build served here on :5173 with
 * the MCP bridge (for `host` and `share`, which `who` names in the log).
 */
export async function ensureGame(who: string): Promise<string> {
  const page = `http://localhost:${GAME_PORT}/`;
  if (await up(page)) return page;
  console.log(
    `${who}: no dev server on :${GAME_PORT}, building and serving dist/ with the MCP bridge`,
  );
  const build = await new Deno.Command("deno", { args: ["task", "-q", "build"] }).output();
  if (!build.success) {
    console.error(new TextDecoder().decode(build.stderr));
    Deno.exit(1);
  }
  const { createBridge } = await import("./bridge.ts");
  serve(GAME_PORT, createBridge().route);
  return page;
}

/** Serve static files; `route` gets first pick of each request. */
export function serve(port: number, route?: Route): Deno.HttpServer<Deno.NetAddr> {
  return Deno.serve({ port, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const routed = route?.(req);
    if (routed) return routed;
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url).pathname);
    } catch {
      return new Response("bad path", { status: 400 });
    }
    // Pages that name the site's own address get this server's, as the Worker does in production.
    const site = SITE_PAGES.includes(path);
    if (path.endsWith("/")) path += "index.html";
    if (path.includes("..") || path.includes("\0")) {
      return new Response("bad path", { status: 400 });
    }
    for (const root of roots) {
      try {
        const file = await Deno.readFile(root + path);
        const body = site
          ? withOrigin(new TextDecoder().decode(file), new URL(req.url).origin)
          : file;
        const ext = path.slice(path.lastIndexOf(".") + 1);
        return new Response(body, {
          headers: {
            "content-type": types[ext] ?? "application/octet-stream",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      } catch { /* try next root */ }
    }
    return new Response("not found", { status: 404 });
  });
}
