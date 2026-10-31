import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { createBridge } from "./bridge.ts";

const upgrade = (path: string, origin?: string) =>
  new Request(`http://127.0.0.1:5173${path}`, {
    headers: { upgrade: "websocket", ...(origin ? { origin } : {}) },
  });

Deno.test("bridge: another site can't open the game socket on localhost", async () => {
  const { route } = createBridge();
  for (const path of ["/bridge", "/tab/AAAAAAAAAAAAAAAAAAAAAA"]) {
    const res = await route(upgrade(path, "https://evil.example"))!;
    assertEquals(res.status, 403);
  }
  // A cross-site POST to the MCP endpoint is refused the same way.
  const post = await route(
    new Request("http://127.0.0.1:5173/mcp", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      body: "{}",
    }),
  )!;
  assertEquals(post.status, 403);
});
