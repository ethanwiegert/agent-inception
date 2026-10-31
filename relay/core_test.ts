import {
  deepStrictEqual as assertEquals,
  match as assertMatch,
  ok as assert,
} from "node:assert/strict";
import {
  BAD_SECRET,
  CODE_RE,
  FRAME,
  LOCAL,
  MAX_BODY,
  newSecret,
  originAllowed,
  pairingCode,
  POLICY,
  Reassembler,
  REPLACED,
  Room,
  sendFramed,
  type Socket,
} from "./core.ts";

/** A tab's end of the socket: what the relay sent it, and whether it was closed. */
class FakeTab implements Socket {
  sent: Record<string, unknown>[] = [];
  closedWith: number | null = null;
  private frames = new Reassembler();
  send(text: string) {
    const msg = this.frames.take(text);
    if (msg) this.sent.push(msg);
  }
  close(code?: number) {
    this.closedWith = code ?? 1000;
  }
  last() {
    return this.sent[this.sent.length - 1];
  }
}

const TOOLS = [{ name: "look", description: "Look.", inputSchema: { type: "object" } }];

const post = (body: unknown, session?: string, headers: Record<string, string> = {}) =>
  new Request("http://relay/mcp/x", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(session ? { "mcp-session-id": session } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function init(room: Room): Promise<string> {
  const res = await room.handleMcp(post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  }));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.result.protocolVersion, "2025-06-18");
  return res.headers.get("mcp-session-id")!;
}

const call = (room: Room, session: string, name: string, args: unknown = {}) =>
  room.handleMcp(post({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  }, session)).then((r) => r.json());

/** Answer the tab's latest call with `text` once it arrives. */
async function answer(room: Room, tab: FakeTab, text: string) {
  for (let i = 0; i < 50 && tab.last()?.type !== "call"; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  const c = tab.last();
  assertEquals(c.type, "call");
  await room.message(
    tab,
    JSON.stringify({ type: "result", id: c.id, content: [{ type: "text", text }], isError: false }),
  );
  return c;
}

Deno.test("pairing: a code is 22 url-safe characters from a secret, the same every time", async () => {
  const secret = newSecret();
  const code = await pairingCode(secret);
  assertMatch(code, CODE_RE);
  assertEquals(await pairingCode(secret), code);
  assert(code !== await pairingCode(newSecret()));
});

Deno.test("relay: the local room lists its own tools until a tab says hello, then the tab's", async () => {
  const room = new Room({ code: LOCAL, tools: [{ ...TOOLS[0], name: "old" }] });
  const session = await init(room);
  const list = async () =>
    (await (await room.handleMcp(post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, session)))
      .json()).result.tools.map((t: { name: string }) => t.name);
  assertEquals(await list(), ["old"]);
  const tab = new FakeTab();
  assert(await room.message(tab, JSON.stringify({ type: "hello", tools: TOOLS })));
  assertEquals(tab.last(), { type: "welcome", code: LOCAL });
  assertEquals(await list(), ["look"]);
});

Deno.test("relay: a call goes to the tab and its answer comes back to the agent", async () => {
  const room = new Room({ code: LOCAL, tools: TOOLS });
  const session = await init(room);
  const tab = new FakeTab();
  await room.message(tab, JSON.stringify({ type: "hello", tools: TOOLS }));
  const pending = call(room, session, "look", { radius: 3 });
  const c = await answer(room, tab, "a meadow");
  assertEquals([c.session, c.name, c.args], [session, "look", { radius: 3 }]);
  const res = await pending;
  assertEquals(res.result, { content: [{ type: "text", text: "a meadow" }], isError: false });
});

Deno.test("relay: a link no tab has opened says the game isn't open, whatever the tool", async () => {
  const room = new Room({ code: LOCAL });
  const res = await call(room, await init(room), "look");
  assert(res.result.isError);
  assertMatch(res.result.content[0].text, /isn't open/);
});

Deno.test("relay: a link no tab ever proved says no world uses it", async () => {
  const room = new Room({ code: await pairingCode(newSecret()) });
  const res = await call(room, await init(room), "look");
  assert(res.result.isError);
  assertMatch(res.result.content[0].text, /No world uses this link/);
});

Deno.test("relay: without a tab a call says the game isn't open", async () => {
  const room = new Room({ code: LOCAL, tools: TOOLS });
  const res = await call(room, await init(room), "look");
  assert(res.result.isError);
  assertMatch(res.result.content[0].text, /isn't open/);
});

Deno.test("relay: a paired room takes only the tab holding its secret", async () => {
  const secret = newSecret();
  const room = new Room({ code: await pairingCode(secret) });
  const impostor = new FakeTab();
  assert(!await room.message(impostor, JSON.stringify({ type: "hello", tools: TOOLS })));
  assertEquals(impostor.closedWith, BAD_SECRET);
  const wrong = new FakeTab();
  await room.message(wrong, JSON.stringify({ type: "hello", secret: newSecret(), tools: TOOLS }));
  assertEquals(wrong.closedWith, BAD_SECRET);
  assert(!room.open);

  const tab = new FakeTab();
  assert(await room.message(tab, JSON.stringify({ type: "hello", secret, tools: TOOLS })));
  assert(room.open);
  // A socket that isn't the tab can't answer the tab's calls.
  const session = await init(room);
  const pending = call(room, session, "look");
  const c = await answer(room, tab, "ok");
  await room.message(
    impostor,
    JSON.stringify({ type: "result", id: c.id, content: [{ type: "text", text: "forged" }] }),
  );
  assertEquals((await pending).result.content[0].text, "ok");
});

Deno.test("relay: a socket that isn't the tab gets one whole hello, never parts", async () => {
  const room = new Room({ code: await pairingCode(newSecret()) });
  // Parts from a stranger would sit in memory waiting for the rest: they're refused outright.
  const stranger = new FakeTab();
  const frames: string[] = [];
  sendFramed({ send: (t) => frames.push(t), close() {} }, {
    type: "hello",
    pad: "x".repeat(FRAME),
  });
  assert(frames.length > 1);
  assert(!await room.message(stranger, frames[0]));
  assertEquals(stranger.closedWith, POLICY);
  const chatty = new FakeTab();
  assert(!await room.message(chatty, JSON.stringify({ type: "result", id: 1, content: [] })));
  assertEquals(chatty.closedWith, POLICY);
  assert(!room.open);
});

Deno.test("relay: only agents, local pages and the site's own pages may reach a room", () => {
  assert(originAllowed(null));
  assert(originAllowed("http://localhost:5173"));
  assert(originAllowed("http://127.0.0.1:8787"));
  assert(originAllowed("http://[::1]:5173"));
  assert(originAllowed("https://site.example", ["https://site.example"]));
  assert(!originAllowed("https://evil.example"));
  assert(!originAllowed("http://localhost.evil.example"));
  assert(!originAllowed("null"));
});

Deno.test("relay: a newer tab replaces the old one, and calls waiting on the old one fail", async () => {
  const room = new Room({ code: LOCAL, tools: TOOLS });
  const session = await init(room);
  const old = new FakeTab();
  await room.message(old, JSON.stringify({ type: "hello", tools: TOOLS }));
  const pending = call(room, session, "look");
  for (let i = 0; i < 50 && old.last()?.type !== "call"; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  const fresh = new FakeTab();
  await room.message(fresh, JSON.stringify({ type: "hello", tools: TOOLS }));
  assertEquals(old.closedWith, REPLACED);
  const res = await pending;
  assert(res.result.isError);
  // The old socket's close doesn't take the new tab down with it.
  room.closed(old);
  assert(room.open);
  const next = call(room, session, "look");
  await answer(room, fresh, "new tab");
  assertEquals((await next).result.content[0].text, "new tab");
});

Deno.test("relay: the tab closing mid-call fails the call", async () => {
  const room = new Room({ code: LOCAL, tools: TOOLS });
  const session = await init(room);
  const tab = new FakeTab();
  await room.message(tab, JSON.stringify({ type: "hello", tools: TOOLS }));
  const pending = call(room, session, "look");
  for (let i = 0; i < 50 && tab.last()?.type !== "call"; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  room.closed(tab);
  const res = await pending;
  assert(res.result.isError);
  assertMatch(res.result.content[0].text, /closed mid-action/);
  assertEquals(room.inFlight, 0);
});

Deno.test("relay: long messages travel in parts both ways", async () => {
  const room = new Room({ code: LOCAL, tools: TOOLS });
  const session = await init(room);
  const tab = new FakeTab();
  await room.message(tab, JSON.stringify({ type: "hello", tools: TOOLS }));
  const big = "x".repeat(FRAME * 3 + 17);
  const pending = call(room, session, "look", { note: big });
  for (let i = 0; i < 50 && tab.last()?.type !== "call"; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  const c = tab.last();
  assertEquals((c.args as { note: string }).note.length, big.length);
  // The tab answers in parts too, the way src/agentlink.ts does.
  const frames: string[] = [];
  sendFramed({ send: (t) => frames.push(t), close() {} }, {
    type: "result",
    id: c.id,
    content: [{ type: "image", data: big, mimeType: "image/jpeg" }],
    isError: false,
  });
  assert(frames.length === 4 && frames.every((f) => f.length < FRAME + 200));
  for (const f of frames.reverse()) await room.message(tab, f); // in any order
  const res = await pending;
  assertEquals(res.result.content[0].data.length, big.length);
});

Deno.test("relay: bad parts are dropped, never thrown", () => {
  const r = new Reassembler();
  for (
    const bad of [
      "not json",
      "[1,2]",
      JSON.stringify({ type: "part", key: "k", i: 5, n: 2, s: "a" }),
      JSON.stringify({ type: "part", key: "k", i: 0, n: 100000, s: "a" }),
      JSON.stringify({ type: "part", key: 7, i: 0, n: 2, s: "a" }),
      JSON.stringify({ type: "part", key: "k", i: 0, n: 1, s: "{oops" }),
    ]
  ) assertEquals(r.take(bad), null);
  // Parts of different lengths under one key don't mix.
  assertEquals(r.take(JSON.stringify({ type: "part", key: "j", i: 0, n: 2, s: '{"a"' })), null);
  assertEquals(r.take(JSON.stringify({ type: "part", key: "j", i: 1, n: 3, s: ":1}" })), null);
  assertEquals(r.take(JSON.stringify({ type: "part", key: "j", i: 1, n: 2, s: ":1}" })), { a: 1 });
});

Deno.test("relay: HTTP edges answer the way MCP clients expect", async () => {
  const room = new Room({ code: LOCAL, tools: TOOLS, origins: ["https://site.example"] });
  assertEquals((await room.handleMcp(post({ jsonrpc: "2.0", id: 1, method: "ping" }))).status, 400);
  assertEquals(
    (await room.handleMcp(post({ jsonrpc: "2.0", id: 1, method: "ping" }, "bad id!"))).status,
    400,
  );
  assertEquals((await room.handleMcp(post("{nope", "abcdefgh12"))).status, 400);
  assertEquals(
    (await room.handleMcp(post({}, undefined, { origin: "https://evil.example" }))).status,
    403,
  );
  const session = await init(room);
  const ok = await room.handleMcp(
    post({ jsonrpc: "2.0", id: 1, method: "ping" }, session, { origin: "https://site.example" }),
  );
  assertEquals((await ok.json()).result, {});
  const huge = await room.handleMcp(post("x".repeat(MAX_BODY + 1), session));
  assertEquals(huge.status, 413);
  const note = await room.handleMcp(
    post({ jsonrpc: "2.0", method: "notifications/initialized" }, session),
  );
  assertEquals(note.status, 202);
  assertEquals(
    (await room.handleMcp(new Request("http://relay/mcp", { method: "GET" }))).status,
    405,
  );
  const unknown = await call(room, session, "rm_rf");
  assertMatch(unknown.error.message, /Unknown tool/);
  const array = await call(room, session, "look", [1, 2]);
  assertMatch(array.error.message, /object/);
  const missing = await room.handleMcp(
    post({ jsonrpc: "2.0", id: 9, method: "teleport" }, session),
  );
  assertEquals((await missing.json()).error.code, -32601);
  // A batch answers as a batch.
  const batch = await room.handleMcp(post([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", id: 2, method: "ping" },
  ], session));
  assertEquals((await batch.json()).length, 2);
});

Deno.test("relay: a tab's tool list is cleaned and kept for after a restart", async () => {
  let stored: unknown;
  const room = new Room({ code: LOCAL, saveTools: (t) => (stored = t) });
  const tab = new FakeTab();
  await room.message(
    tab,
    JSON.stringify({
      type: "hello",
      tools: [
        ...TOOLS,
        { name: "bad name!", description: "", inputSchema: {} },
        { name: "nodesc", inputSchema: {} },
        "junk",
        { ...TOOLS[0], name: "extra", secret: "dropped" },
      ],
    }),
  );
  assertEquals((stored as { name: string }[]).map((t) => t.name), ["look", "extra"]);
  assert(!("secret" in (stored as object[])[1]));
  const again = new Room({ code: LOCAL, loadTools: () => Promise.resolve(stored as never) });
  const session = await init(again);
  const res = await again.handleMcp(post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, session));
  assertEquals((await res.json()).result.tools.length, 2);
});
