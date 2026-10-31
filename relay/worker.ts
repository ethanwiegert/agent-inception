/**
 * The hosted site and relay as one Cloudflare Worker (ADR 0006). Static files are Workers assets
 * (`dist/`, built by `deno task build`); `/mcp/<code>` and `/tab/<code>` go to the Durable Object
 * named by the pairing code, which runs a relay Room (relay/core.ts). The tab's socket hibernates
 * while the world is quiet, so idle worlds cost nothing. Deploy with `npx wrangler deploy`.
 */
import { CODE_RE, originAllowed, POLICY, Room, type Socket, type Tool } from "./core.ts";

// The few Cloudflare runtime types this file uses (no npm types package: zero dependencies).
interface DurableObjectState {
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): WebSocket[];
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}
interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: { fetch(req: Request): Promise<Response> };
}
type Attached = WebSocket & {
  serializeAttachment(v: unknown): void;
  deserializeAttachment(): unknown;
};
declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };

/** Sockets a room keeps open before they've said hello. */
const MAX_WAITING = 4;

const CLOSED_TEXT = "No game tab is open for this link. Ask the human to open the game in the " +
  "browser that made it (a background tab is fine). If they made a new link, this one is retired.";

export default {
  fetch(req: Request, env: Env): Promise<Response> | Response {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/(mcp|tab)\/([^/]+)$/);
    if (!m) return env.ASSETS.fetch(req);
    if (!CODE_RE.test(m[2])) return new Response("no such world", { status: 404 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[2])).fetch(req);
  },
};

/** What each socket carries through hibernation: the room's code, and whether it's the tab. */
interface Tag {
  code: string;
  tab: boolean;
}

/** One world's relay room. Holds no world state: the tab's socket and its tool list. */
export class RoomObject {
  private room: Room | null = null;

  constructor(private state: DurableObjectState) {}

  private get(code: string, origin: string | null): Room {
    if (this.room) return this.room;
    const storage = this.state.storage;
    const room = new Room({
      code,
      origins: origin ? [origin] : [],
      closedText: CLOSED_TEXT,
      saveTools: (tools) => storage.put("tools", tools),
      loadTools: () => storage.get<Tool[]>("tools"),
    });
    // Woken from hibernation: the verified tab is still connected, only this memory was lost.
    const tab = this.state.getWebSockets().find((ws) => tag(ws)?.tab);
    if (tab) room.restore(tab as Socket);
    return this.room = room;
  }

  fetch(req: Request): Promise<Response> | Response {
    const url = new URL(req.url);
    const [, kind, code] = url.pathname.split("/");
    const room = this.get(code, url.origin);
    // A room woken by a socket message first didn't know the site's origin yet.
    room.options.origins = [url.origin];
    if (kind === "mcp") return room.handleMcp(req);
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket", { status: 426 });
    }
    if (!originAllowed(req.headers.get("origin"), [url.origin])) {
      return new Response("forbidden origin", { status: 403 });
    }
    // Sockets that haven't proved they're the tab can't pile up: past a few, the newest stays.
    const waiting = this.state.getWebSockets().filter((ws) => !tag(ws)?.tab);
    for (const ws of waiting.slice(0, Math.max(0, waiting.length - MAX_WAITING + 1))) {
      try {
        ws.close(POLICY, "too many sockets waiting");
      } catch { /* already closed */ }
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    (pair[1] as Attached).serializeAttachment({ code, tab: false } satisfies Tag);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const t = tag(ws);
    if (typeof data !== "string" || !t) return;
    // After hibernation a message can arrive before any request: the socket knows its room.
    const room = this.get(t.code, null);
    if (await room.message(ws as Socket, data)) {
      for (const other of this.state.getWebSockets()) {
        const o = tag(other);
        if (o) (other as Attached).serializeAttachment({ ...o, tab: other === ws });
      }
    }
  }

  webSocketClose(ws: WebSocket) {
    this.room?.closed(ws as Socket);
  }

  webSocketError(ws: WebSocket) {
    this.room?.closed(ws as Socket);
  }
}

function tag(ws: WebSocket): Tag | null {
  const t = (ws as Attached).deserializeAttachment() as Tag | null;
  return t && typeof t.code === "string" ? t : null;
}
