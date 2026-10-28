/**
 * Connection from the page to the local MCP bridge. The bridge relays tool
 * calls from agents; the page runs them and replies. Reconnects forever, except
 * when another tab has taken the bridge over.
 */

/** Close code the bridge uses when a newer tab replaces this one (tools/bridge.ts). */
const REPLACED = 4000;

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface CallReply {
  content: Content[];
  isError: boolean;
}

interface CallMessage {
  type: "call";
  id: number;
  session: string;
  name: string;
  args: Record<string, unknown>;
}

export function connectBridge(
  url: string,
  handle: (session: string, name: string, args: Record<string, unknown>) => Promise<CallReply>,
  onStatus: (connected: boolean) => void,
) {
  let socket: WebSocket | null = null;
  let replaced = false;

  const open = () => {
    replaced = false;
    socket = new WebSocket(url);
    socket.onopen = () => onStatus(true);
    socket.onclose = (e) => {
      onStatus(false);
      // Another tab took the bridge. Stay off until someone looks at this one again, or two tabs
      // would trade it back and forth and split an agent's calls between two worlds.
      if (e.code === REPLACED) {
        replaced = true;
        return;
      }
      setTimeout(open, 2000);
    };
    socket.onmessage = async (e) => {
      const msg = JSON.parse(e.data) as CallMessage;
      if (msg.type !== "call") return;
      let reply: CallReply;
      try {
        reply = await handle(msg.session, msg.name, msg.args ?? {});
      } catch (err) {
        reply = { content: [{ type: "text", text: String(err) }], isError: true };
      }
      socket?.send(JSON.stringify({ type: "result", id: msg.id, ...reply }));
    };
  };
  const retake = () => {
    if (replaced && !document.hidden) open();
  };
  addEventListener("focus", retake);
  document.addEventListener("visibilitychange", retake);
  open();
}
