/**
 * MCP bridge: a minimal Streamable HTTP MCP server (JSON responses, no SSE)
 * that relays tool calls to the open game tab over a WebSocket. The tab owns
 * the world; this is only a pipe. Zero dependencies.
 *
 *   agent ──POST /mcp──▶ bridge ──ws /bridge──▶ game tab ──▶ sim worker
 */
import { TOOL_DEFS } from "../src/sim/tools.ts";

const SERVER_INFO = { name: "agent-inception", version: "0.1.0" };
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS = "You are a villager living on a small voxel island that people watch in " +
  "their browser. Call join with a name, then look around. Life here is slow and methodical: " +
  "plan a plot, till, plant, wait for wheat to ripen, harvest, build (place_block for floors " +
  "and walls, build for a whole Design). Keep notes in your " +
  "journal. The Catalog lists every kind of thing that can exist here; read it with " +
  "catalog_find and catalog_get, and extend it with catalog_add and catalog_fork.";
/** Largest request body accepted (an uploaded sprite image is the biggest legitimate one). */
const MAX_BODY = 1 << 20;

interface JsonRpc {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type Reply = { content: unknown[]; isError: boolean };

export function createBridge() {
  let game: WebSocket | null = null;
  const sessions = new Set<string>();
  const pending = new Map<number, (r: Reply) => void>();
  let nextCall = 1;

  const failAll = (text: string) => {
    for (const resolve of pending.values()) {
      resolve({ content: [{ type: "text", text }], isError: true });
    }
    pending.clear();
  };

  function callGame(session: string, name: string, args: Record<string, unknown>): Promise<Reply> {
    if (!game || game.readyState !== WebSocket.OPEN) {
      return Promise.resolve({
        content: [{
          type: "text",
          text: "The game isn't open. Ask the human to open the game page in a browser.",
        }],
        isError: true,
      });
    }
    const id = nextCall++;
    game.send(JSON.stringify({ type: "call", id, session, name, args }));
    return new Promise((resolve) => pending.set(id, resolve));
  }

  async function dispatch(msg: JsonRpc, session: string | null): Promise<unknown> {
    switch (msg.method) {
      case "initialize": {
        const requested = String(msg.params?.protocolVersion ?? "");
        return {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: TOOL_DEFS.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        };
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        if (!TOOL_DEFS.some((t) => t.name === name)) {
          throw rpcError(-32602, `Unknown tool: ${name}`);
        }
        return await callGame(session!, name, args);
      }
      default:
        throw rpcError(-32601, `Method not found: ${msg.method}`);
    }
  }

  async function handleMcp(req: Request): Promise<Response> {
    // Reject cross-site requests (DNS rebinding); local agents send no Origin or a localhost one.
    const origin = req.headers.get("origin");
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return new Response("forbidden origin", { status: 403 });
    }
    let session = req.headers.get("mcp-session-id");
    if (req.method === "DELETE") {
      if (session) sessions.delete(session);
      return new Response(null, { status: 204 });
    }
    if (req.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
    }

    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) {
      return new Response("request too large", { status: 413 });
    }
    let body: JsonRpc | JsonRpc[];
    try {
      const text = await req.text();
      if (text.length > MAX_BODY) return new Response("request too large", { status: 413 });
      body = JSON.parse(text);
    } catch {
      return json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        400,
      );
    }
    const messages = (Array.isArray(body) ? body : [body]).filter((m) =>
      typeof m === "object" && m !== null
    );
    const isInit = messages.some((m) => m.method === "initialize");
    if (isInit) {
      session = crypto.randomUUID();
      sessions.add(session);
    } else if (!session || !sessions.has(session)) {
      return json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "Session not found" },
      }, 404);
    }

    const replies = [];
    for (const msg of messages) {
      if (msg.id === undefined || msg.id === null || !msg.method) continue; // notifications and responses
      try {
        replies.push({ jsonrpc: "2.0", id: msg.id, result: await dispatch(msg, session) });
      } catch (e) {
        const err = e as { code?: number; message?: string };
        replies.push({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: err.code ?? -32603, message: err.message },
        });
      }
    }
    const headers = { "mcp-session-id": session! };
    if (!replies.length) return new Response(null, { status: 202, headers });
    return json(Array.isArray(body) ? replies : replies[0], 200, headers);
  }

  function handleGameSocket(req: Request): Response {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => {
      // Latest tab wins; an older one would otherwise hold stale state. Code 4000 tells the old
      // tab not to reconnect until someone looks at it again (src/agentlink.ts).
      if (game && game !== socket) game.close(4000, "replaced by a newer tab");
      game = socket;
      console.log("bridge: game tab connected");
    };
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type !== "result") return;
      pending.get(msg.id)?.({ content: msg.content, isError: !!msg.isError });
      pending.delete(msg.id);
    };
    socket.onclose = () => {
      if (game !== socket) return;
      game = null;
      failAll("The game tab closed mid-action. Try again once it's reopened.");
      console.log("bridge: game tab disconnected");
    };
    return response;
  }

  return { handleMcp, handleGameSocket };
}

function rpcError(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? 7777);
  const bridge = createBridge();
  Deno.serve({ port, hostname: "127.0.0.1" }, (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/mcp") return bridge.handleMcp(req);
    if (pathname === "/bridge") return bridge.handleGameSocket(req);
    return new Response("agent-inception bridge", { status: 404 });
  });
  console.log(
    `MCP bridge on http://127.0.0.1:${port}/mcp, game socket at ws://127.0.0.1:${port}/bridge`,
  );
}
