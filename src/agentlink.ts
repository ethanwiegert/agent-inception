/**
 * Connection from the page to the relay (hosted) or the local dev bridge. Agents' tool calls come
 * in, the page runs them and replies. On connecting the tab says hello with its tools and, for a
 * paired room, the secret behind the room's code (relay/core.ts). Reconnects forever, except when
 * another tab has taken the room over.
 */
import {
  BAD_SECRET,
  type Content,
  pairingCode,
  Reassembler,
  REPLACED,
  sendFramed,
  type Tool,
} from "../relay/core.ts";

export type { Content };

export interface CallReply {
  content: Content[];
  isError: boolean;
}

export type LinkState = "connecting" | "connected" | "offline" | "replaced" | "refused";

export interface Link {
  /** The URL an agent's MCP client points at. */
  readonly agentUrl: string;
  readonly state: LinkState;
  /** Whether this is a paired (hosted) room, whose link can be renewed. */
  readonly paired: boolean;
  /** Pair with a new secret (the old agent URL stops working). Returns the new agent URL. */
  renew(secret: string): Promise<string>;
}

export interface LinkOptions {
  /** ws(s):// base for the socket: the page's own host unless `?bridge=` says otherwise. */
  socketBase: string;
  /** http(s):// base for agents' URLs. */
  httpBase: string;
  /** A paired room's secret, or null for the dev bridge's local room. */
  secret: string | null;
  tools: Tool[];
  handle: (session: string, name: string, args: Record<string, unknown>) => Promise<CallReply>;
  onState: (state: LinkState) => void;
}

/** Full override of the socket URL (`?bridge=`), local room semantics. */
export async function connectLink(o: LinkOptions & { socketUrl?: string }): Promise<Link> {
  let secret = o.secret;
  let code = secret ? await pairingCode(secret) : null;
  let socket: WebSocket | null = null;
  let state: LinkState = "connecting";
  let retry: ReturnType<typeof setTimeout> | undefined;
  const set = (s: LinkState) => {
    state = s;
    o.onState(s);
  };
  const socketUrl = () =>
    o.socketUrl ?? (code ? `${o.socketBase}/tab/${code}` : `${o.socketBase}/bridge`);
  const agentUrl = () => code ? `${o.httpBase}/mcp/${code}` : `${o.httpBase}/mcp`;

  const open = () => {
    clearTimeout(retry);
    const frames = new Reassembler();
    const ws = socket = new WebSocket(socketUrl());
    set("connecting");
    ws.onopen = () =>
      sendFramed(ws, { type: "hello", secret: secret ?? undefined, tools: o.tools });
    ws.onclose = (e) => {
      if (socket !== ws) return;
      // Another tab took the room. Stay off until someone looks at this one again, or two tabs
      // would trade it back and forth and split an agent's calls between two worlds.
      if (e.code === REPLACED) return set("replaced");
      if (e.code === BAD_SECRET) return set("refused");
      set("offline");
      retry = setTimeout(open, 2000);
    };
    ws.onmessage = async (e) => {
      if (typeof e.data !== "string") return;
      const msg = frames.take(e.data);
      if (!msg) return;
      if (msg.type === "welcome") return set("connected");
      if (msg.type !== "call") return;
      let reply: CallReply;
      try {
        reply = await o.handle(
          String(msg.session),
          String(msg.name),
          (msg.args ?? {}) as Record<string, unknown>,
        );
      } catch (err) {
        reply = { content: [{ type: "text", text: String(err) }], isError: true };
      }
      if (ws.readyState === WebSocket.OPEN) {
        sendFramed(ws, { type: "result", id: msg.id, ...reply });
      }
    };
  };
  const retake = () => {
    if (state === "replaced" && !document.hidden) open();
  };
  addEventListener("focus", retake);
  document.addEventListener("visibilitychange", retake);
  open();

  return {
    get agentUrl() {
      return agentUrl();
    },
    get state() {
      return state;
    },
    paired: secret !== null,
    async renew(next: string) {
      secret = next;
      code = await pairingCode(next);
      const old = socket;
      socket = null;
      old?.close();
      open();
      return agentUrl();
    },
  };
}
