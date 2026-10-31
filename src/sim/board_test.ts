import { deepStrictEqual as assertEquals, ok as assert, throws } from "node:assert/strict";
import { BOARD_LIMITS } from "./board.ts";
import { type CallResult, Sim, TICKS_PER_DAY } from "./sim.ts";
import { callTool, TOOL_DEFS } from "./tools.ts";

let nextCall = 1;
function run(sim: Sim, session: string, tool: string, args: Record<string, unknown> = {}) {
  const callId = nextCall++;
  callTool(sim, session, tool, args, callId);
  for (let i = 0; i < 2000; i++) {
    const r = sim.results.find((r) => r.callId === callId);
    if (r) return r;
    sim.step();
  }
  throw new Error(`${tool} never finished`);
}
const ok = (r: CallResult) => {
  assert(!r.isError, r.text);
  return r.text;
};
const err = (r: CallResult, includes: string) => {
  assert(r.isError, `expected an error, got: ${r.text}`);
  assert(r.text.includes(includes), r.text);
  return r.text;
};

function world() {
  const sim = new Sim(1337);
  ok(run(sim, "a", "join", { name: "Fern" }));
  ok(run(sim, "b", "join", { name: "Moss" }));
  sim.events = [];
  return sim;
}

Deno.test("board: a spectator's Wish reaches every villager, in a note and in look", () => {
  const sim = world();
  const wish = sim.board.pin("  Build a  lighthouse\non the cliff ");
  assertEquals(wish.text, "Build a lighthouse on the cliff");
  assertEquals(wish.for, null);
  assert(sim.events.some((e) => e.type === "board" && e.text.includes("lighthouse")));
  // The note rides on the next result, once.
  assert(ok(run(sim, "a", "look")).includes(`Wish on the Notice Board: #${wish.id}`));
  assert(!ok(run(sim, "a", "journal_read")).includes("pinned a Wish"));
  const look = ok(run(sim, "b", "look"));
  assert(look.includes("Notice Board: 1 Wish from spectators"), look);
  assert(look.includes("never orders"), look);
  const list = ok(run(sim, "b", "board"));
  assert(list.includes("#1 for anyone, just now: “Build a lighthouse on the cliff”"), list);
  assert(list.includes("never an order"), list);
});

Deno.test("board: a Wish for one villager is told to them, and only they mark it done", () => {
  const sim = world();
  const wish = sim.board.pin("Plant sunflowers by the river", "fern");
  assertEquals(wish.for, "Fern");
  assert(sim.agents[0].notes.some((n) => n.includes("for you")));
  assertEquals(sim.agents[1].notes.length, 0);
  // Moss doesn't see it in look (it's not for them), but the board lists it for everyone.
  assert(!ok(run(sim, "b", "look")).includes("Notice Board"));
  assert(ok(run(sim, "b", "board")).includes("#1 for Fern"));
  err(run(sim, "b", "board", { action: "done", id: 1 }), "meant for Fern");
  ok(run(sim, "b", "board", { action: "reply", id: 1, text: "I'll help, Fern!" }));
  assert(ok(run(sim, "a", "look")).includes("(1 for you)"));
  const done = ok(run(sim, "a", "board", { action: "done", id: 1, text: "Six of them." }));
  assert(done.includes("earn nothing"), done);
  assert(sim.board.wishes[0].done?.by === "Fern");
  const list = ok(run(sim, "a", "board"));
  assert(list.includes("done by Fern: “Six of them.”"), list);
  assert(!list.includes("I'll help"), "a done Wish's replies are folded away");
  // Done Wishes drop out of look, and take no more replies.
  assert(!ok(run(sim, "a", "look")).includes("Notice Board"));
  err(run(sim, "b", "board", { action: "reply", id: 1, text: "nice" }), "done already");
  err(run(sim, "a", "board", { action: "done", id: 1 }), "done already");
  assert(sim.events.some((e) => e.type === "board" && e.text.includes("marked #1 done")));
});

Deno.test("board: wishes earn nothing", () => {
  const sim = world();
  sim.board.pin("Say hello");
  const before = sim.village.points;
  ok(run(sim, "a", "board", { action: "done", id: 1 }));
  assertEquals(sim.village.points, before);
  assertEquals(sim.agents[0].inventory, sim.agents[1].inventory);
});

Deno.test("board: the spectator's limits", () => {
  const sim = world();
  throws(() => sim.board.pin(""), /empty/);
  throws(() => sim.board.pin(" \n\t "), /empty/);
  throws(() => sim.board.pin(42), /string/);
  throws(() => sim.board.pin("x".repeat(BOARD_LIMITS.text + 1)), /at most 140/);
  throws(() => sim.board.pin("hi", "Nobody"), /No villager is called Nobody/);
  sim.board.pin("x".repeat(BOARD_LIMITS.text));
  // Markup is kept as plain text (the page renders it as text, never HTML).
  assertEquals(sim.board.pin("<b>bold</b>").text, "<b>bold</b>");
  while (sim.board.open.length < BOARD_LIMITS.open) sim.board.pin("more");
  throws(() => sim.board.pin("one too many"), /holds 12 open Wishes/);
  assert(sim.board.unpin(1));
  assert(!sim.board.unpin(1));
  sim.board.pin("room again");
});

Deno.test("board: an adversary's arguments are refused with a reason", () => {
  const sim = world();
  sim.board.pin("Build a tower");
  err(run(sim, "a", "board", { action: "reply" }), "id is the Wish's number");
  err(run(sim, "a", "board", { action: "reply", id: "one", text: "hi" }), "id is the Wish's");
  err(run(sim, "a", "board", { action: "reply", id: 1.5, text: "hi" }), "id is the Wish's");
  err(run(sim, "a", "board", { action: "reply", id: [1], text: "hi" }), "id is the Wish's");
  err(run(sim, "a", "board", { action: "reply", id: true, text: "hi" }), "id is the Wish's");
  err(run(sim, "a", "board", { action: "reply", id: null, text: "hi" }), "id is the Wish's");
  err(run(sim, "a", "board", { action: "reply", id: 99, text: "hi" }), "no Wish #99");
  err(run(sim, "a", "board", { action: "reply", id: 1 }), "Your reply is missing");
  err(run(sim, "a", "board", { action: "reply", id: 1, text: "   " }), "empty");
  err(run(sim, "a", "board", { action: "reply", id: 1, text: "y".repeat(141) }), "at most 140");
  err(run(sim, "a", "board", { action: "done", id: 1, text: 7 }), "string");
  err(run(sim, "a", "board", { action: "pin", text: "a wish of my own" }), "list, reply or done");
  err(run(sim, "a", "board", { action: "list", id: 1 }), "list takes no id");
  err(run(sim, "a", "board", { wish: 1 }), `doesn't take "wish"`);
  // Agents can't pin: Wishes come from spectators only.
  assertEquals(sim.board.wishes.length, 1);
  // Replies: two per villager, eight per Wish.
  ok(run(sim, "a", "board", { action: "reply", id: 1, text: "On it" }));
  ok(run(sim, "a", "board", { action: "reply", id: 1, text: "Halfway" }));
  err(run(sim, "a", "board", { action: "reply", id: 1, text: "Again" }), "the most one villager");
  for (let i = 0; i < 6; i++) {
    ok(run(sim, `c${i}`, "join", { name: `Helper${i}` }));
    ok(run(sim, `c${i}`, "board", { action: "reply", id: 1, text: `me too ${i}` }));
  }
  err(run(sim, "b", "board", { action: "reply", id: 1, text: "late" }), "as many as it holds");
  // Control characters never reach the board.
  sim.board.pin("tab\there\u0007bell \u202eflip\u2066");
  assertEquals(sim.board.wishes.at(-1)!.text, "tab here bell flip");
});

Deno.test("board: Wishes come down after three days open, a day once done; saves keep them", () => {
  const sim = world();
  sim.board.pin("First");
  sim.board.pin("Second", "Moss");
  ok(run(sim, "b", "board", { action: "done", id: 2 }));
  const loaded = Sim.load(sim.save(0));
  assertEquals(loaded.board.wishes, sim.board.wishes);
  assertEquals(loaded.board.serial, 2);
  const start = sim.tick;
  while (sim.tick < start + TICKS_PER_DAY + 40) sim.step();
  assertEquals(sim.board.wishes.map((w) => w.id), [1]);
  while (sim.tick < start + BOARD_LIMITS.posted + 40) sim.step();
  assertEquals(sim.board.wishes.length, 0);
  // Numbers keep counting, so an old reply can't land on a new Wish.
  assertEquals(sim.board.pin("Third").id, 3);
});

Deno.test("board: the tool is listed with a schema the bridge can serve", () => {
  const def = TOOL_DEFS.find((t) => t.name === "board")!;
  assert(def.description.includes("never an order"));
  assertEquals(Object.keys(def.inputSchema.properties), ["action", "id", "text"]);
});

Deno.test("weather: a spectator holds the sky over Rules, and lets it drift again", () => {
  const sim = world();
  sim.setWeather(0.9);
  assertEquals(sim.clouds(), 0.9);
  sim.weatherOverride = { clouds: 0, until: sim.tick + 1000 };
  assertEquals(sim.clouds(), 0.9);
  sim.setWeather(5);
  assertEquals(sim.clouds(), 1);
  sim.setWeather(Number.NaN);
  assertEquals(sim.spectatorClouds, null);
  sim.setWeather(0.1);
  assertEquals(Sim.load(sim.save(0)).spectatorClouds, 0.1);
  sim.setWeather(null);
  assertEquals(sim.clouds(), 0); // the Rule's override shows through again
  assert(sim.events.some((e) => e.type === "village" && e.text.includes("drifts on its own")));
});

Deno.test("board: the same Wishes and replies give the same world", () => {
  const play = () => {
    const sim = world();
    sim.board.pin("Dance at noon");
    run(sim, "a", "board", { action: "reply", id: 1, text: "Gladly" });
    for (let i = 0; i < 200; i++) sim.step();
    return JSON.stringify(sim.save(0));
  };
  assertEquals(play(), play());
});
