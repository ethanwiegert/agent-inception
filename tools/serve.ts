/** Static file server for `web/` with `dist/` layered on top. */
const roots = ["web", "dist"];
const types: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  map: "application/json",
  json: "application/json",
  wgsl: "text/plain",
  png: "image/png",
  bin: "application/octet-stream",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
};

type Route = (req: Request) => Response | Promise<Response> | undefined;

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
    if (path.endsWith("/")) path += "index.html";
    if (path.includes("..") || path.includes("\0")) {
      return new Response("bad path", { status: 400 });
    }
    for (const root of roots) {
      try {
        const body = await Deno.readFile(root + path);
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
