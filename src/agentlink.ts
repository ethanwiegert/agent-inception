/**
 * Connection from the page to the local MCP bridge. The bridge relays tool
 * calls from agents; the page runs them and replies. Reconnects forever.
 */

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

  const open = () => {
    socket = new WebSocket(url);
    socket.onopen = () => onStatus(true);
    socket.onclose = () => {
      onStatus(false);
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
  open();
}
