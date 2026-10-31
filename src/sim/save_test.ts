import { deepStrictEqual as assertEquals, ok as assert, throws } from "node:assert/strict";
import { migrateSave, SAVE_VERSION, SaveError, worldName } from "./save.ts";
import { Sim, TICKS_PER_DAY } from "./sim.ts";
import { callTool, HOLD_TICKS } from "./tools.ts";

/** A save as version 2 wrote it: no name. */
function v2(sim: Sim) {
  const { name: _n, ...rest } = sim.save(0);
  return { ...rest, version: 2 } as Record<string, unknown>;
}

Deno.test("saves: a version 2 save gains its world's name and loads the same world", () => {
  const sim = new Sim(7);
  callTool(sim, "s1", "join", { name: "Fern" }, 1);
  for (let i = 0; i < 40; i++) sim.step();
  const old = v2(sim);
  const migrated = migrateSave(structuredClone(old));
  assertEquals(migrated.version, SAVE_VERSION);
  assertEquals(migrated.name, worldName(7));
  const loaded = Sim.load(migrated);
  assertEquals(loaded.name, worldName(7));
  assertEquals(loaded.save(0), sim.save(0));
});

Deno.test("saves: the current version passes through untouched, and names survive a reload", () => {
  const sim = new Sim(3);
  sim.name = "Ethan's Isle";
  const save = sim.save(5);
  assertEquals(migrateSave(structuredClone(save)), save);
  assertEquals(Sim.load(migrateSave(save)).name, "Ethan's Isle");
});

Deno.test("saves: a newer save is refused, never guessed at", () => {
  const save = { ...new Sim(1).save(0), version: SAVE_VERSION + 1 };
  const e = (() => {
    try {
      migrateSave(save);
    } catch (e) {
      return e;
    }
  })() as SaveError;
  assert(e instanceof SaveError && e.kind === "newer");
  assert(/newer/.test(e.message));
});

Deno.test("saves: broken files fail with a reason before loading", () => {
  const good = new Sim(2).save(0);
  const cases: [unknown, RegExp][] = [
    [null, /isn't a saved world/],
    [[1, 2], /isn't a saved world/],
    [{ seed: 1 }, /version/],
    [{ ...good, version: 1 }, /before saves/],
    [{ ...good, seed: "7" }, /seed/],
    [{ ...good, tick: -5 }, /tick/],
    [{ ...good, edits: [1, 2, 3] }, /blocks/],
    [{ ...good, crops: [["a"]] }, /crops/],
    [{ ...good, agents: [{ id: 1, name: "X", x: NaN, y: 0, z: 0 }] }, /place/],
    [{ ...good, agents: [{ id: 1, name: "X", x: 1, y: 0, z: 0, inventory: {} }] }, /journal/],
  ];
  for (const [raw, why] of cases) {
    throws(() => migrateSave(raw), (e: Error) => e instanceof SaveError && why.test(e.message));
  }
});

Deno.test("saves: the same seed always gives the same name, and names vary", () => {
  assertEquals(worldName(7), worldName(7));
  const names = new Set(Array.from({ length: 50 }, (_, i) => worldName(i)));
  assert(names.size > 20);
  assert([...names].every((n) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(n)));
});

// ---------------------------------------------------------------- held while active

function results(sim: Sim) {
  return sim.results.splice(0);
}

Deno.test("join: another session can't take a villager its agent is playing", () => {
  const sim = new Sim(7);
  callTool(sim, "wren", "join", { name: "Wren" }, 1);
  callTool(sim, "rook", "join", { name: "WREN" }, 2);
  const [, refused] = results(sim);
  assert(refused.isError);
  assert(/another agent is playing them/.test(refused.text), refused.text);
  assertEquals(sim.agents.length, 1);
  assertEquals(sim.sessions.get("rook"), undefined);
  // The holder rejoining is fine.
  callTool(sim, "wren", "join", { name: "Wren" }, 3);
  assert(!results(sim)[0].isError);
});

Deno.test("join: a villager is free again a game day after its agent's last call", () => {
  const sim = new Sim(7);
  callTool(sim, "old", "join", { name: "Fern" }, 1);
  results(sim);
  sim.tick += HOLD_TICKS - 20;
  callTool(sim, "new", "join", { name: "Fern" }, 2);
  assert(
    /free in 3 game minutes \(about 1 real minute at normal speed\)\./.test(results(sim)[0].text),
  );
  sim.tick += 20;
  callTool(sim, "new", "join", { name: "Fern" }, 3);
  const [back] = results(sim);
  assert(!back.isError && /Welcome back, Fern/.test(back.text), back.text);
  // The old session let go: it must join again, and Fern is now held by the new one.
  assertEquals(sim.sessions.get("old"), undefined);
  callTool(sim, "old", "look", {}, 4);
  assert(/join/.test(results(sim)[0].text));
  callTool(sim, "old", "join", { name: "Fern" }, 5);
  assert(results(sim)[0].isError);
  assertEquals(HOLD_TICKS, TICKS_PER_DAY);
});

Deno.test("join: a running job holds a villager however long it has been", () => {
  const sim = new Sim(7);
  callTool(sim, "a", "join", { name: "Moss" }, 1);
  const moss = sim.sessions.get("a")!;
  callTool(sim, "a", "walk_to", { x: Math.floor(moss.x) + 6, z: Math.floor(moss.z) }, 2);
  results(sim);
  assert(moss.queue.length);
  sim.tick += HOLD_TICKS * 2;
  callTool(sim, "b", "join", { name: "Moss" }, 3);
  const [r] = results(sim);
  assert(r.isError && /busy right now/.test(r.text), r.text);
});

Deno.test("join: switching to a new name lets go of the old villager at once", () => {
  const sim = new Sim(7);
  callTool(sim, "a", "join", { name: "Ash" }, 1);
  callTool(sim, "a", "join", { name: "Birch" }, 2);
  callTool(sim, "b", "join", { name: "Ash" }, 3);
  const r = results(sim);
  assert(!r[2].isError, r[2].text);
  assertEquals(sim.sessions.get("b")?.name, "Ash");
  assertEquals(sim.sessions.get("a")?.name, "Birch");
});

Deno.test("join: holds survive a save and reload", () => {
  const sim = new Sim(7);
  callTool(sim, "a", "join", { name: "Ash" }, 1);
  const loaded = Sim.load(migrateSave(structuredClone(sim.save(0))));
  callTool(loaded, "b", "join", { name: "Ash" }, 2);
  assert(loaded.results.splice(0)[0].isError);
});
