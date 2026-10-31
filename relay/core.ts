/**
 * The relay's core (ADR 0001, 0006): a Room pipes MCP requests (Streamable HTTP with JSON
 * responses, no SSE) from agents to one game tab over a WebSocket, and the tab's answers back. The
 * tab owns the world and says which tools it has; the relay is only a pipe. Runtime-agnostic: the
 * dev bridge (Deno) and the hosted relay (a Cloudflare Durable Object) both run it. Zero
 * dependencies.
 *
 *   agent ──POST /mcp/<code>──▶ Room ──WebSocket──▶ game tab ──▶ sim worker
 */

export const SERVER_INFO = { name: "agent-inception", version: "1.0.0" };
export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const INSTRUCTIONS = "You are a villager living on a small voxel island that people " +
  "watch in their browser. Call join with a name, then look around. Life here is slow and " +
  "methodical: plan a plot, till, plant, wait for wheat to ripen, harvest, build (place_block " +
  "for floors and walls, build for a whole Design). Keep notes in your journal. The Catalog " +
  "lists every kind of thing that can exist here; read it with catalog_find and catalog_get, " +
  "and extend it with catalog_add and catalog_fork.";

/** Largest request body accepted (a big Design or Rule is the biggest legitimate one). */
export const MAX_BODY = 1 << 20;
/** WebSocket frames stay under this many characters; longer messages travel in parts. */
export const FRAME = 256 * 1024;
/** Longest a message may be in parts (a screenshot is a few hundred KB). */
export const MAX_PARTS = 64;
/** A call waits this long for the tab before it fails. */
export const CALL_TIMEOUT_MS = 10 * 60 * 1000;
/** Calls in flight per room. */
export const MAX_PENDING = 64;
/** Close codes: a newer tab took the room; the tab's secret didn't match its code. */
export const REPLACED = 4000;
export const BAD_SECRET = 4001;
/** The dev bridge's own room (`/mcp` and `/bridge`), which needs no secret. */
export const LOCAL = "local";
/** A pairing code: 128 bits of a hash, base64url. */
export const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** What the tab sends: who it is and its tools, then call results. */
export type TabMessage =
  | { type: "hello"; secret?: string; tools: Tool[] }
  | { type: "result"; id: number; content: Content[]; isError: boolean };

/** What the relay sends the tab. */
export type RelayMessage =
  | { type: "welcome"; code: string }
  | { type: "call"; id: number; session: string; name: string; args: Record<string, unknown> };

/** The part of a WebSocket a Room uses. */
export interface Socket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

// ---------------------------------------------------------------- pairing

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A new world secret: 256 random bits. Only the tab that made it ever knows it. */
export function newSecret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The public pairing code for a secret: what goes in the agent's URL. */
export async function pairingCode(secret: string): Promise<string> {
  const data = new TextEncoder().encode("agent-inception pairing " + secret);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return b64url(hash.subarray(0, 16));
}

// ---------------------------------------------------------------- framing

/** Send `msg` as one frame, or in parts when it's long (hosts cap a WebSocket message's size). */
export function sendFramed(socket: Socket, msg: unknown) {
  const text = JSON.stringify(msg);
  if (text.length <= FRAME) return socket.send(text);
  const key = b64url(crypto.getRandomValues(new Uint8Array(9)));
  const n = Math.ceil(text.length / FRAME);
  for (let i = 0; i < n; i++) {
    socket.send(
      JSON.stringify({ type: "part", key, i, n, s: text.slice(i * FRAME, (i + 1) * FRAME) }),
    );
  }
}

/** Puts parted messages back together. A few messages may be under way at once. */
export class Reassembler {
  private parts = new Map<string, string[]>();

  /** A frame in; a whole message out, or null while parts are missing or the frame is bad. */
  take(text: string): Record<string, unknown> | null {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isObject(msg)) return null;
    if (msg.type !== "part") return msg;
    const { key, i, n, s } = msg;
    if (
      typeof key !== "string" || key.length > 32 || typeof s !== "string" || s.length > FRAME ||
      !Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_PARTS ||
      !Number.isInteger(i) || (i as number) < 0 || (i as number) >= (n as number)
    ) return null;
    let list = this.parts.get(key);
    if (!list) {
      if (this.parts.size >= 8) this.parts.delete(this.parts.keys().next().value!);
      this.parts.set(key, list = new Array(n as number));
    }
    if (list.length !== n) return null;
    list[i as number] = s;
    for (let k = 0; k < list.length; k++) if (list[k] === undefined) return null;
    this.parts.delete(key);
    return this.take(list.join(""));
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A tab's tool list, kept to what MCP's `tools/list` needs. Anything malformed is dropped. */
export function cleanTools(raw: unknown): Tool[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).filter((t): t is Tool =>
    isObject(t) && typeof t.name === "string" && /^[A-Za-z_][\w-]{0,63}$/.test(t.name) &&
    typeof t.description === "string" && isObject(t.inputSchema)
  ).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

// ---------------------------------------------------------------- the room

export interface RoomOptions {
  /** The pairing code this room answers to, or LOCAL for the dev bridge's room. */
  code: string;
  /** Tools to list before any tab has said hello (the dev bridge passes its own). */
  tools?: Tool[];
  /** Keep and restore the tab's tool list across restarts (Durable Object storage). */
  saveTools?: (tools: Tool[]) => unknown;
  loadTools?: () => Promise<Tool[] | undefined>;
  /** Browser origins allowed to call besides none (agents) and localhost: the site's own. */
  origins?: string[];
  /** What a call says when no tab is connected. */
  closedText?: string;
}

interface JsonRpc {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type Reply = { content: Content[]; isError: boolean };

export class Room {
  private tab: Socket | null = null;
  private tools: Tool[] | undefined;
  private pending = new Map<
    number,
    { resolve: (r: Reply) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private nextCall = 1;
  private frames = new Reassembler();

  constructor(readonly options: RoomOptions) {
    this.tools = options.tools;
  }

  /** Whether a tab is connected and has proved it owns this room. */
  get open(): boolean {
    return this.tab !== null;
  }

  /** Calls waiting on the tab. */
  get inFlight(): number {
    return this.pending.size;
  }

  /** Take back a tab that was verified before the host lost its memory (hibernation). */
  restore(socket: Socket) {
    this.tab = socket;
  }

  /**
   * A frame from a socket. Until its hello checks out a socket isn't the tab; resolves to true
   * when this frame made it the tab (hosts that hibernate mark the socket then).
   */
  async message(socket: Socket, text: string): Promise<boolean> {
    if (text.length > FRAME * 2) return false;
    const msg = this.frames.take(text);
    if (!msg) return false;
    if (msg.type === "hello") return await this.hello(socket, msg);
    if (socket !== this.tab || msg.type !== "result" || typeof msg.id !== "number") return false;
    const call = this.pending.get(msg.id);
    if (!call) return false;
    this.pending.delete(msg.id);
    clearTimeout(call.timer);
    const content = Array.isArray(msg.content) ? msg.content as Content[] : [];
    call.resolve({ content, isError: !!msg.isError });
    return false;
  }

  /** A socket went away. If it was the tab, every call waiting on it fails. */
  closed(socket: Socket) {
    if (socket !== this.tab) return;
    this.tab = null;
    this.failAll("The game tab closed mid-action. Try again once it's reopened.");
  }

  private async hello(socket: Socket, msg: Record<string, unknown>): Promise<boolean> {
    const { code } = this.options;
    if (code !== LOCAL) {
      const secret = typeof msg.secret === "string" && msg.secret.length <= 128 ? msg.secret : "";
      if (!secret || await pairingCode(secret) !== code) {
        socket.close(BAD_SECRET, "this tab doesn't hold the secret for that link");
        return false;
      }
    }
    // Latest tab wins; an older one would otherwise hold stale state. REPLACED tells the old tab
    // not to reconnect until someone looks at it again (src/agentlink.ts).
    if (this.tab && this.tab !== socket) {
      const old = this.tab;
      this.tab = null;
      this.failAll("Another tab took over this world mid-action. Try again.");
      try {
        old.close(REPLACED, "replaced by a newer tab");
      } catch { /* already closed */ }
    }
    this.tab = socket;
    const tools = cleanTools(msg.tools);
    if (tools.length) {
      this.tools = tools;
      await this.options.saveTools?.(tools);
    }
    sendFramed(socket, { type: "welcome", code } satisfies RelayMessage);
    return true;
  }

  private failAll(text: string) {
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve({ content: [{ type: "text", text }], isError: true });
    }
    this.pending.clear();
  }

  private async toolList(): Promise<Tool[]> {
    this.tools ??= await this.options.loadTools?.();
    return this.tools ?? [];
  }

  private callTab(session: string, name: string, args: Record<string, unknown>): Promise<Reply> {
    const fail = (text: string) =>
      Promise.resolve({ content: [{ type: "text", text }], isError: true } as Reply);
    if (!this.tab) {
      return fail(
        this.options.closedText ??
          "The game isn't open. Ask the human to open the game page in a browser.",
      );
    }
    if (this.pending.size >= MAX_PENDING) {
      return fail("Too many calls at once in this world. Wait for some to finish.");
    }
    const id = this.nextCall++;
    const tab = this.tab;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          content: [{ type: "text", text: "The game didn't answer in time." }],
          isError: true,
        });
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      try {
        sendFramed(tab, { type: "call", id, session, name, args } satisfies RelayMessage);
      } catch {
        this.closed(tab);
      }
    });
  }

  private async dispatch(msg: JsonRpc, session: string): Promise<unknown> {
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
        return { tools: await this.toolList() };
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const args = msg.params?.arguments ?? {};
        // A room no tab has opened yet knows no tools: say the game isn't open, not "unknown".
        const tools = await this.toolList();
        if (!tools.length && this.options.code !== LOCAL) {
          // No tab has ever proved this code: a mistyped or made-up link, not a closed tab.
          return {
            content: [{
              type: "text",
              text: "No world uses this link. Check it was copied whole from the game's " +
                "connect card.",
            }],
            isError: true,
          };
        }
        if (tools.length && !tools.some((t) => t.name === name)) {
          throw rpcError(-32602, `Unknown tool: ${name}`);
        }
        if (!isObject(args)) {
          throw rpcError(-32602, "Tool arguments are an object of named values.");
        }
        return await this.callTab(session, name, args);
      }
      default:
        throw rpcError(-32601, `Method not found: ${msg.method}`);
    }
  }

  /** One MCP HTTP request (POST, or DELETE to end a session). */
  async handleMcp(req: Request): Promise<Response> {
    // Reject cross-site browser requests (DNS rebinding). Agents send no Origin or a local one.
    const origin = req.headers.get("origin");
    if (
      origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) &&
      !this.options.origins?.includes(origin)
    ) {
      return new Response("forbidden origin", { status: 403 });
    }
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    if (req.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
    }
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) {
      return new Response("request too large", { status: 413 });
    }
    let body: unknown;
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
    const batch = Array.isArray(body);
    const messages = (batch ? body as unknown[] : [body]).filter(isObject).slice(
      0,
      32,
    ) as unknown as JsonRpc[];
    // Sessions are stateless ids: the relay can restart or hibernate without losing an agent. The
    // tab keys villagers by them (held while active), and the link itself is the key to the world.
    let session = req.headers.get("mcp-session-id");
    if (messages.some((m) => m.method === "initialize")) session = crypto.randomUUID();
    else if (!session || !SESSION_RE.test(session)) {
      return json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Bad Request: no valid mcp-session-id; initialize first" },
      }, 400);
    }

    const replies = [];
    for (const msg of messages) {
      if (msg.id === undefined || msg.id === null || !msg.method) continue; // notifications, responses
      try {
        replies.push({ jsonrpc: "2.0", id: msg.id, result: await this.dispatch(msg, session) });
      } catch (e) {
        const err = e as { code?: number; message?: string };
        replies.push({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: err.code ?? -32603, message: err.message },
        });
      }
    }
    const headers = { "mcp-session-id": session };
    if (!replies.length) return new Response(null, { status: 202, headers });
    return json(batch ? replies : replies[0], 200, headers);
  }
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
