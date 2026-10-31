import { deepStrictEqual as assertEquals, match as assertMatch } from "node:assert/strict";
import { createBridge } from "./bridge.ts";
import { createGate, shareBase } from "./share.ts";
import { cloudHook, PROMPT, reachableFromCloud } from "../src/connect.ts";

const CODE = "AAAAAAAAAAAAAAAAAAAAAA";
const rpc = (method: string, params: Record<string, unknown> = {}, id = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

Deno.test("share: the public gate lets world links through and nothing else", async () => {
  // The gate forwards to the bridge exactly as it would over loopback (tests run without net).
  const { route } = createBridge();
  const gate = createGate(
    "http://127.0.0.1:5173",
    (r) => route(r) ?? new Response("the page", { status: 200 }),
  );
  const req = (path: string, init: RequestInit = {}) =>
    gate(new Request(`https://tunnel.example${path}`, init));
  const post = (path: string, body: string, session?: string) =>
    req(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body,
    });
  {
    // The secretless local room, the game socket, the page and OAuth probes stay off the internet.
    for (const path of ["/mcp", "/bridge", `/tab/${CODE}`, "/", "/index.html", "/mcp/short"]) {
      const res = await post(path, rpc("initialize"));
      assertEquals(res.status, 404, path);
      await res.body?.cancel();
    }
    const probe = await req("/.well-known/oauth-protected-resource/mcp/" + CODE);
    assertEquals(probe.status, 404);
    await probe.body?.cancel();
    // A world link goes through to the bridge's paired room, session header and all.
    const init = await post(`/mcp/${CODE}`, rpc("initialize", { protocolVersion: "2025-06-18" }));
    assertEquals(init.status, 200);
    const session = init.headers.get("mcp-session-id")!;
    assertMatch(session, /^[\w-]{8,64}$/);
    assertEquals((await init.json()).result.serverInfo.name, "agent-inception");
    const call = await post(
      `/mcp/${CODE}`,
      rpc("tools/call", { name: "join", arguments: { name: "Grok" } }, 2),
      session,
    );
    assertMatch((await call.json()).result.content[0].text, /No world uses this link/);
    // A browser page elsewhere still can't drive it: the relay checks the forwarded Origin.
    const cross = await req(`/mcp/${CODE}`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: rpc("ping"),
    });
    assertEquals(cross.status, 403);
    await cross.body?.cancel();
    const get = await req(`/mcp/${CODE}`);
    assertEquals(get.status, 405);
    await get.body?.cancel();
  }
});

Deno.test("share: a public base is an https origin and nothing more", () => {
  assertEquals(shareBase("https://abc-def.trycloudflare.com"), "https://abc-def.trycloudflare.com");
  assertEquals(shareBase("https://abc.trycloudflare.com/"), "https://abc.trycloudflare.com");
  for (const bad of ["http://abc.example", "https://a.example/mcp", "https://a.example/?x", "x"]) {
    assertEquals(shareBase(bad), null, bad);
  }
});

Deno.test("share: cloud agents get the hook only for links they can reach", () => {
  assertEquals(reachableFromCloud(`https://abc.trycloudflare.com/mcp/${CODE}`), true);
  for (const url of ["http://localhost:5173/mcp", "https://localhost:8787/mcp/x", "…"]) {
    assertEquals(reachableFromCloud(url), false, url);
  }
  // One line, with the link in it (the README shows it with <YOUR_AGENT_LINK>).
  const hook = cloudHook("https://x.example/mcp/" + CODE);
  assertEquals(hook.includes("\n"), false);
  assertEquals(hook.includes(`https://x.example/mcp/${CODE} `), true);
});

Deno.test("share: the README shows the connect card's hook and prompt word for word", async () => {
  const readme = await Deno.readTextFile(new URL("../README.md", import.meta.url));
  assertEquals(readme.includes(cloudHook("<YOUR_AGENT_LINK>")), true, "hook");
  assertEquals(readme.includes(PROMPT), true, "prompt");
});
