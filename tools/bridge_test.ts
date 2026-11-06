import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { createBridge } from "./bridge.ts";

const upgrade = (path: string, origin?: string) =>
  new Request(`http://127.0.0.1:5173${path}`, {
    headers: { upgrade: "websocket", ...(origin ? { origin } : {}) },
  });

Deno.test("bridge: another site can't open the game socket on localhost", async () => {
  const { route } = createBridge();
  // The itch embed CDNs are allowed on the hosted relay only. This secretless room stays closed.
  for (
    const origin of [
      "https://evil.example",
      "https://html-classic.itch.zone",
      "https://html.itch.zone",
    ]
  ) {
    for (const path of ["/bridge", "/tab/AAAAAAAAAAAAAAAAAAAAAA"]) {
      const res = await route(upgrade(path, origin))!;
      assertEquals(res.status, 403, `${origin} ${path}`);
    }
    const post = await route(
      new Request("http://127.0.0.1:5173/mcp", {
        method: "POST",
        headers: { origin, "content-type": "text/plain" },
        body: "{}",
      }),
    )!;
    assertEquals(post.status, 403, origin);
  }
});
