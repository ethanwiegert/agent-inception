/**
 * MCP bridge for development: the relay's rooms (relay/core.ts) on a Deno server. `/mcp` and
 * `/bridge` are the local room the dev page and `.mcp.json` use; `/mcp/<code>` and `/tab/<code>`
 * are paired rooms exactly as the hosted relay serves them, so `?relay=1` tries that flow locally.
 *
 *   agent ──POST /mcp──▶ bridge ──ws /bridge──▶ game tab ──▶ sim worker
 */
import { CODE_RE, LOCAL, originAllowed, Room, type Socket } from "../relay/core.ts";
import { TOOL_DEFS } from "../src/sim/tools.ts";

/** The tools a local room lists before a tab connects (a tab sends its own when it does). */
const LOCAL_TOOLS = TOOL_DEFS.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

export function createBridge() {
  const rooms = new Map<string, Room>();
  const room = (code: string) => {
    let r = rooms.get(code);
    if (!r) {
      rooms.set(
        code,
        r = new Room({
          code,
          tools: code === LOCAL ? LOCAL_TOOLS : undefined,
          closedText: code === LOCAL
            ? undefined
            : "No game tab is open for this link. Ask the human to open the game in the browser that made it. If they made a new link, this one is retired.",
        }),
      );
    }
    return r;
  };

  /** Route a request to a room, or undefined when it isn't the bridge's. */
  function route(req: Request): Response | Promise<Response> | undefined {
    const { pathname } = new URL(req.url);
    if (pathname === "/mcp") return room(LOCAL).handleMcp(req);
    if (pathname === "/bridge") return socket(req, room(LOCAL));
    const m = pathname.match(/^\/(mcp|tab)\/([^/]+)$/);
    if (!m) return undefined;
    if (!CODE_RE.test(m[2])) return new Response("no such world", { status: 404 });
    return m[1] === "mcp" ? room(m[2]).handleMcp(req) : socket(req, room(m[2]));
  }

  function socket(req: Request, r: Room): Response {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket", { status: 426 });
    }
    // Browsers let any page open a WebSocket to localhost: only the game's own pages may be the tab.
    if (!originAllowed(req.headers.get("origin"))) {
      return new Response("forbidden origin", { status: 403 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    const s: Socket = socket;
    socket.onmessage = async (e) => {
      if (typeof e.data !== "string") return;
      if (await r.message(s, e.data)) console.log(`bridge: game tab connected (${r.options.code})`);
    };
    socket.onclose = () => {
      const was = r.open;
      r.closed(s);
      if (was && !r.open) console.log(`bridge: game tab disconnected (${r.options.code})`);
    };
    return response;
  }

  return { route, room };
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? 7777);
  const bridge = createBridge();
  Deno.serve(
    { port, hostname: "127.0.0.1" },
    (req) => bridge.route(req) ?? new Response("agent-inception bridge", { status: 404 }),
  );
  console.log(
    `MCP bridge on http://127.0.0.1:${port}/mcp, game socket at ws://127.0.0.1:${port}/bridge`,
  );
}
