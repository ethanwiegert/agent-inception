import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { Catalog, type Entry, NATURE } from "./catalog.ts";
import { AUTHOR_LIMITS } from "./catalogtools.ts";
import { RULE_LIMITS } from "./rules.ts";
import { type CallResult, Sim, TICKS_PER_DAY } from "./sim.ts";
import { callTool } from "./tools.ts";
import { Block } from "./world.ts";

let nextCall = 1;
function run(sim: Sim, session: string, tool: string, args: Record<string, unknown> = {}) {
  const callId = nextCall++;
  callTool(sim, session, tool, args, callId);
  for (let i = 0; i < 20_000; i++) {
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
};

function world() {
  const sim = new Sim(7);
  run(sim, "a", "join", { name: "Fern" });
  return { sim, fern: sim.agents[0] };
}

/** Add straight to the Catalog, skipping the per-villager rate limit. */
function addRule(sim: Sim, name: string, content: unknown): Entry {
  return sim.catalog.add({ kind: "rule", name, content }, "Fern", sim.tick);
}

// ---------------------------------------------------------------- store

Deno.test("a new world's Catalog holds nature's entries", () => {
  const c = Catalog.create();
  const stone = c.byName("stone")!;
  assertEquals(stone.kind, "material");
  assertEquals(stone.author, NATURE);
  assert(c.byName("box")?.kind === "part");
  assert(c.byName("lucky harvest")?.kind === "rule");
  const planks = c.byName("planks")!;
  assert(c.relationsOf(planks.id).some((r) => r.name === "planks made_from log"));
});

Deno.test("catalog_find filters by kind, text, author, property and relation", () => {
  const { sim } = world();
  assert(ok(run(sim, "a", "catalog_find")).includes("The Catalog holds"));
  const burns = ok(run(sim, "a", "catalog_find", { kind: "material", property: "burns" }));
  assert(burns.includes('"log"') && burns.includes('"thatch"') && !burns.includes('"stone"'));
  const heavy = ok(run(sim, "a", "catalog_find", { property: "density>2" }));
  assert(heavy.includes('"stone"') && !heavy.includes('"dirt"'), heavy);
  const clay = ok(run(sim, "a", "catalog_find", { related_to: "clay" }));
  assert(clay.includes('"brick"') && clay.includes('"tiles"'), clay);
  assert(ok(run(sim, "a", "catalog_find", { text: "roof" })).includes('"thatch"'));
  assert(ok(run(sim, "a", "catalog_find", { author: "nobody" })).startsWith("No entries"));
  err(run(sim, "a", "catalog_find", { kind: "spell" }), "kind must be");
  err(run(sim, "a", "catalog_find", { property: "density >> 2" }), "property looks like");
  err(run(sim, "a", "catalog_find", { property: "density>abc" }), "compares numbers");
  err(run(sim, "a", "catalog_find", { property: "1=1" }), "property looks like");
});

Deno.test("catalog_get shows content, relations and rule stats", () => {
  const { sim } = world();
  const text = ok(run(sim, "a", "catalog_get", { entry: "clay" }));
  assert(text.includes('"brick" made_from "clay"'), text);
  const byId = ok(run(sim, "a", "catalog_get", { entry: String(sim.catalog.byName("clay")!.id) }));
  assertEquals(byId, text);
  assert(ok(run(sim, "a", "catalog_get", { entry: "lucky harvest" })).includes("Fired 0 times"));
  err(run(sim, "a", "catalog_get", { entry: "unobtainium" }), "Nothing called");
  err(run(sim, "a", "catalog_get", { entry: 99999 }), "no entry #99999");
});

Deno.test("catalog_add validates every kind", () => {
  const { sim } = world();
  const material = {
    color: "#6b8e4e",
    pattern: "stone",
    density: 2.4,
    hardness: 5,
    burns: false,
    glows: 0,
  };
  const added = ok(
    run(sim, "a", "catalog_add", { kind: "material", name: "mossy stone", content: material }),
  );
  assert(added.includes('material "mossy stone"'), added);
  const entry = sim.catalog.byName("mossy stone")!;
  assertEquals(entry.author, "Fern");
  assertEquals(entry.forkedFrom, null);

  err(
    run(sim, "a", "catalog_add", { kind: "material", name: "Mossy Stone", content: material }),
    "taken",
  );
  err(
    run(sim, "a", "catalog_add", { kind: "material", name: "<b>x</b>", content: material }),
    "A name is",
  );
  err(
    run(sim, "a", "catalog_add", { kind: "material", name: "x".repeat(41), content: material }),
    "A name is",
  );
  err(
    run(sim, "a", "catalog_add", {
      kind: "material",
      name: "red",
      content: { ...material, color: "red" },
    }),
    "color must",
  );
  err(
    run(sim, "a", "catalog_add", {
      kind: "material",
      name: "hard",
      content: { ...material, hardness: 11 },
    }),
    "hardness must",
  );
  err(
    run(sim, "a", "catalog_add", {
      kind: "material",
      name: "odd",
      content: { ...material, magic: 1 },
    }),
    'unknown field "magic"',
  );
  err(
    run(sim, "a", "catalog_add", { kind: "material", name: "12", content: material }),
    "plain numbers",
  );
  ok(run(sim, "a", "catalog_add", {
    kind: "material",
    name: "odd text",
    description: "two\nlines‮<b>bold</b>",
    content: material,
  }));
  assertEquals(sim.catalog.byName("odd text")!.description, "two lines <b>bold</b>");
  err(
    run(sim, "a", "catalog_add", { kind: "part", name: "gear", content: { shape: "box" } }),
    "Only the engine",
  );
  err(
    run(sim, "a", "catalog_add", {
      kind: "relation",
      content: { type: "made_from", from: "planks", to: "log" },
    }),
    "already",
  );
  err(
    run(sim, "a", "catalog_add", {
      kind: "relation",
      content: { type: "Made From!", from: "planks", to: "log" },
    }),
    "type is",
  );
  err(run(sim, "a", "catalog_add", { kind: "design", name: "hut", content: {} }), "needs blocks");
});

Deno.test("designs check their grid, palette, parts and size caps", () => {
  const { sim } = world();
  const c = sim.catalog;
  const add = (content: unknown) => () =>
    c.add({ kind: "design", name: "d" + nextCall++, content }, "Fern", 0);
  add({ blocks: { palette: { p: "planks" }, layers: [["pp", "pp"], ["p.", ".p"]] } })();
  add({ parts: [{ part: "cylinder", material: "log", at: [0, 1, 0], size: [0.3, 2, 0.3] }] })();
  const bad = (content: unknown, msg: string) => {
    try {
      add(content)();
    } catch (e) {
      assert((e as Error).message.includes(msg), (e as Error).message);
      return;
    }
    throw new Error(`accepted a bad design: ${msg}`);
  };
  bad({ blocks: { palette: { p: "unobtainium" }, layers: [["p"]] } }, "Nothing called");
  bad({ blocks: { palette: { p: "box" }, layers: [["p"]] } }, "is a part, not a material");
  bad({ blocks: { palette: { p: "planks" }, layers: [["q"]] } }, "isn't in the palette");
  bad({ blocks: { palette: { p: "planks" }, layers: [["p".repeat(17)]] } }, "at most 16");
  bad({ blocks: { palette: { p: "planks" }, layers: Array(17).fill(["p"]) } }, "1-16 layers");
  bad(
    { parts: Array(33).fill({ part: "box", material: "stone", at: [0, 0, 0], size: [1, 1, 1] }) },
    "at most 32",
  );
  bad({ parts: [{ part: "box", material: "stone", at: [0, 0, 0], size: [0, 1, 1] }] }, "size[0]");
  bad({ blocks: { palette: { p: "planks" }, layers: [["..."]] } }, "no filled cells");
});

Deno.test("forks merge changes and record where they came from", () => {
  const { sim } = world();
  const text = ok(
    run(sim, "a", "catalog_fork", {
      from: "stone",
      name: "granite",
      changes: { color: "#9a8070", hardness: 7 },
    }),
  );
  assert(text.includes("granite"), text);
  const granite = sim.catalog.byName("granite")!, stone = sim.catalog.byName("stone")!;
  assertEquals(granite.forkedFrom, stone.id);
  assertEquals((granite.content as { hardness: number }).hardness, 7);
  assertEquals((stone.content as { hardness: number }).hardness, 6);
  assert(ok(run(sim, "a", "catalog_get", { entry: "stone" })).includes("Forks: #"));
  err(run(sim, "a", "catalog_fork", { from: "box", name: "big box" }), "can't be forked");
  err(
    run(sim, "a", "catalog_fork", { from: "stone", name: "stone2", changes: { density: -1 } }),
    "density",
  );
});

Deno.test("authoring is rate-limited per villager per game hour", () => {
  const { sim } = world();
  for (let i = 0; i < AUTHOR_LIMITS.hour; i++) {
    ok(run(sim, "a", "catalog_add", {
      kind: "relation",
      content: {
        type: "looks_like",
        from: "stone",
        to: ["dirt", "sand", "clay", "gravel", "log", "planks"][i],
      },
    }));
  }
  err(
    run(sim, "a", "catalog_add", {
      kind: "relation",
      content: { type: "looks_like", from: "stone", to: "brick" },
    }),
    "this game hour",
  );
  // A second villager has their own allowance.
  run(sim, "b", "join", { name: "Moss" });
  ok(
    run(sim, "b", "catalog_add", {
      kind: "relation",
      content: { type: "looks_like", from: "stone", to: "brick" },
    }),
  );
  for (let i = 0; i < TICKS_PER_DAY / 24; i++) sim.step();
  ok(
    run(sim, "a", "catalog_add", {
      kind: "relation",
      content: { type: "looks_like", from: "stone", to: "tiles" },
    }),
  );
});

// ---------------------------------------------------------------- rules

Deno.test("rules validate their tree against the vocabulary and caps", () => {
  const { sim } = world();
  const bad = (content: unknown, msg: string) => {
    const r = run(sim, "a", "catalog_add", { kind: "rule", name: "r" + nextCall, content });
    err(r, msg);
  };
  const give = [{ give: { item: "wheat", count: 1 } }];
  bad({ when: { event: "danced" }, do: give }, "when.event must be");
  bad({ when: { event: "said" }, do: [] }, "do is a list");
  bad({ when: { event: "said" }, do: [{ explode: true }] }, 'unknown "explode"');
  bad({ when: { event: "said" }, do: [{ give: { item: "diamond" } }] }, "isn't an item");
  bad({ when: { event: "said" }, do: [{ give: { item: "wheat", count: 99 } }] }, "count must be");
  bad({ when: { every: 1 }, do: [{ say: "hi" }] }, "when.every");
  bad({ when: { every: 60 }, do: give }, "only works with an event trigger");
  bad({ when: { event: "said" }, do: [{ set_block: { at: [0, 9, 0], to: "stone" } }] }, "at[1]");
  bad(
    { when: { event: "said" }, do: [{ set_block: { at: [0, 1, 0], to: "water" } }] },
    ".to must be",
  );
  bad({ when: { event: "said" }, if: { chance: 0.5, time: [1, 2] }, do: give }, "one key");
  let deep: unknown = { chance: 0.5 };
  for (let i = 0; i < RULE_LIMITS.depth; i++) deep = { not: deep };
  bad({ when: { event: "said" }, if: deep, do: give }, "nest at most");
  const wide = { all: Array(8).fill({ any: Array(8).fill({ chance: 0.5 }) }) };
  bad({ when: { event: "said" }, if: wide, do: give }, "at most 24");
  bad({ when: { event: "said" }, do: give, extra: 1 }, 'unknown field "extra"');
  bad({ when: { event: "said" }, do: Array(9).fill({ say: "x" }) }, "1-8 effects");
});

Deno.test("an event rule fires on a villager's action and tells them", () => {
  const { sim, fern } = world();
  ok(run(sim, "a", "catalog_add", {
    kind: "rule",
    name: "magic words",
    content: {
      when: { event: "said", what: "please" },
      do: [{ give: { item: "stone", count: 2 } }],
    },
  }));
  ok(run(sim, "a", "say", { text: "hello" }));
  assertEquals(fern.inventory.stone ?? 0, 0);
  const said = ok(run(sim, "a", "say", { text: "Stone, PLEASE" }));
  assertEquals(fern.inventory.stone, 2);
  assert(said.includes('"magic words" gave you 2 stone'), said);
  assert(ok(run(sim, "a", "catalog_get", { entry: "magic words" })).includes("Fired 1 times"));
});

Deno.test("rules fire at most so often per game hour", () => {
  const { sim, fern } = world();
  addRule(sim, "echo", { when: { event: "said" }, do: [{ give: { item: "dirt", count: 1 } }] });
  for (let i = 0; i < RULE_LIMITS.firingsPerHour + 5; i++) run(sim, "a", "say", { text: "hi" });
  assertEquals(fern.inventory.dirt, RULE_LIMITS.firingsPerHour);
  const stat = sim.rules.stat(sim.catalog.byName("echo")!.id);
  assertEquals(stat.dropped, 5);
});

Deno.test("the per-tick step budget bounds all rules together", () => {
  const { sim, fern } = world();
  for (let i = 0; i < 300; i++) {
    addRule(sim, "spam " + i, {
      when: { event: "said" },
      if: { all: [{ chance: 1 }, { chance: 1 }] },
      do: [{ give: { item: "dirt", count: 1 } }],
    });
  }
  sim.rules.beginTick();
  run(sim, "a", "say", { text: "go" });
  // Each firing costs a step to start, three to test and one per effect.
  const fired = fern.inventory.dirt ?? 0;
  assert(fired > 0 && fired <= RULE_LIMITS.stepsPerTick / 5 + 1, String(fired));
  const dropped = [...sim.rules.stats.values()].reduce((n, s) => n + s.dropped, 0);
  assert(dropped >= 300 - fired - 1, String(dropped));
});

Deno.test("conditions see the villager, the place, the time and the weather", () => {
  const { sim, fern } = world();
  addRule(sim, "toll", {
    when: { event: "said", what: "toll" },
    if: {
      all: [{ has: { item: "wheat_seeds", count: 10 } }, { block: { at: [0, 0, 0], is: "grass" } }],
    },
    do: [{ take: { item: "wheat_seeds", count: 10 } }, { give: { item: "cobble", count: 1 } }],
  });
  run(sim, "a", "say", { text: "toll" });
  assertEquals(fern.inventory.wheat_seeds, 6);
  assertEquals(fern.inventory.cobble, 1);
  run(sim, "a", "say", { text: "toll" }); // too few seeds now
  assertEquals(fern.inventory.cobble, 1);

  addRule(sim, "night only", {
    when: { event: "said", what: "moon" },
    if: { time: [20, 4] },
    do: [{ give: { item: "pine_sapling", count: 1 } }],
  });
  sim.setTimeOfDay(0.5);
  run(sim, "a", "say", { text: "moon" });
  assertEquals(fern.inventory.pine_sapling, 1);
  sim.setTimeOfDay(23 / 24);
  run(sim, "a", "say", { text: "moon" });
  assertEquals(fern.inventory.pine_sapling, 2);
});

Deno.test("set_block acts near the event and refuses unsafe cells", () => {
  const { sim, fern } = world();
  const x = Math.floor(fern.x), z = Math.floor(fern.z), h = sim.world.heightAt(x, z);
  addRule(sim, "cairn", {
    when: { event: "said", what: "cairn" },
    do: [{ set_block: { at: [2, 1, 0], to: "cobble" } }, {
      set_block: { at: [0, 1, 0], to: "stone" },
    }],
  });
  run(sim, "a", "say", { text: "cairn" });
  assertEquals(sim.world.get(x + 2, h + 1, z), Block.Cobble);
  // Fern stands on (x, z): the second block would bury her, so it's skipped.
  assertEquals(sim.world.get(x, h + 1, z), Block.Air);
  assert(
    sim.rules.stat(sim.catalog.byName("cairn")!.id).skipped.includes("Fern is standing there"),
  );
});

Deno.test("timer rules run on the clock and can change the weather", () => {
  const sim = new Sim(3);
  addRule(sim, "rain dance", {
    when: { every: 60 },
    do: [{ weather: { clouds: 0.95, hours: 2 } }],
  });
  for (let i = 0; i < TICKS_PER_DAY / 24 + 1; i++) sim.step();
  assertEquals(sim.weatherOverride?.clouds, 0.95);
  addRule(sim, "noon bell", { when: { daily: 12 }, do: [{ say: "Dong." }] });
  sim.events = [];
  for (let i = 0; i < TICKS_PER_DAY; i++) sim.step();
  assertEquals(sim.events.filter((e) => e.type === "rule" && e.text === "Dong.").length, 1);
});

Deno.test("nature's lucky harvest rule fires on harvests", () => {
  const { sim } = world();
  const id = sim.catalog.byName("lucky harvest")!.id;
  for (let i = 0; i < 200; i++) sim.fire("harvested", sim.agents[0], 0, 0, 0, "wheat");
  const fired = sim.rules.stat(id).fired;
  assert(fired > 5 && fired < 40, String(fired));
});

// ---------------------------------------------------------------- proposals

Deno.test("solo proposals pass at once; retired rules stop firing", () => {
  const { sim, fern } = world();
  addRule(sim, "gift", { when: { event: "said" }, do: [{ give: { item: "sand", count: 1 } }] });
  run(sim, "a", "say", { text: "hi" });
  assertEquals(fern.inventory.sand, 1);
  const text = ok(
    run(sim, "a", "propose", { entry: "gift", action: "retire", reason: "too generous" }),
  );
  assert(text.includes("passed at once"), text);
  assert(sim.catalog.byName("gift")!.retired);
  run(sim, "a", "say", { text: "hi" });
  assertEquals(fern.inventory.sand, 1);
  // Retired entries hide from search unless asked, and can't be used in new content.
  assert(!ok(run(sim, "a", "catalog_find", { text: "gift" })).includes('rule "gift"'));
  assert(
    ok(run(sim, "a", "catalog_find", { text: "gift", include_retired: true })).includes(
      "[retired]",
    ),
  );
});

Deno.test("proposals wait for the other active villagers, then count votes", () => {
  const { sim } = world();
  run(sim, "b", "join", { name: "Moss" });
  const open = ok(
    run(sim, "a", "propose", { entry: "dawn chorus", action: "retire", reason: "noisy" }),
  );
  assert(open.includes("is open until"), open);
  err(
    run(sim, "b", "propose", { entry: "dawn chorus", action: "retire", reason: "again" }),
    "already open",
  );
  const list = ok(run(sim, "b", "proposals"));
  assert(list.includes("Fern yes: “noisy”"), list);
  const voted = ok(run(sim, "b", "vote", { proposal: 1, yes: false, reason: "I like birds" }));
  assert(sim.events.some((e) => e.type === "catalog" && e.text.includes("“I like birds”")));
  assert(voted.includes("failed (1 yes, 1 no)"), voted);
  assert(!sim.catalog.byName("dawn chorus")!.retired);
  err(run(sim, "b", "vote", { proposal: 1, yes: true }), "already failed");
  err(run(sim, "b", "vote", { proposal: 9, yes: true }), "no proposal #9");
});

Deno.test("a silent villager can't block a proposal past its day (lazy consensus)", () => {
  const { sim } = world();
  run(sim, "b", "join", { name: "Moss" });
  ok(
    run(sim, "a", "propose", {
      entry: "stone",
      action: "replace",
      replacement: "cobble",
      reason: "rougher",
    }),
  );
  assert(!sim.catalog.byName("stone")!.retired);
  for (let i = 0; i < TICKS_PER_DAY; i++) sim.step();
  const stone = sim.catalog.byName("stone")!;
  assert(stone.retired);
  assertEquals(stone.replacedBy, sim.catalog.byName("cobble")!.id);
  assertEquals(sim.produce("stone"), "cobble");
  assert(sim.events.some((e) => e.type === "catalog" && e.text.includes("passed")));
});

Deno.test("replacements are checked; inactive villagers don't hold up votes", () => {
  const { sim } = world();
  run(sim, "b", "join", { name: "Moss" });
  err(
    run(sim, "a", "propose", {
      entry: "stone",
      action: "replace",
      replacement: "box",
      reason: "x",
    }),
    "only be replaced",
  );
  err(
    run(sim, "a", "propose", {
      entry: "stone",
      action: "replace",
      replacement: "stone",
      reason: "x",
    }),
    "itself",
  );
  err(run(sim, "a", "propose", { entry: "stone", action: "replace", reason: "x" }), "Say which");
  err(
    run(sim, "a", "propose", { entry: "stone", action: "retire", reason: "  " }),
    "Give a reason",
  );
  err(run(sim, "a", "propose", { entry: "stone", action: "melt", reason: "x" }), "action must be");
  // A day later only Fern has been active, so her proposal passes immediately.
  for (let i = 0; i < TICKS_PER_DAY + 10; i++) sim.step();
  run(sim, "a", "look");
  const text = ok(
    run(sim, "a", "propose", { entry: "gravel", action: "retire", reason: "unused" }),
  );
  assert(text.includes("passed at once"), text);
});

Deno.test("a villager holds at most three open proposals", () => {
  const { sim } = world();
  run(sim, "b", "join", { name: "Moss" });
  for (const entry of ["sand", "gravel", "clay"]) {
    ok(run(sim, "a", "propose", { entry, action: "retire", reason: "tidy" }));
  }
  err(run(sim, "a", "propose", { entry: "brick", action: "retire", reason: "tidy" }), "3 open");
});

// ---------------------------------------------------------------- persistence

Deno.test("the Catalog, proposals and rule stats survive save and load", () => {
  const { sim } = world();
  run(sim, "b", "join", { name: "Moss" });
  ok(run(sim, "a", "catalog_fork", { from: "stone", name: "granite", changes: { hardness: 7 } }));
  addRule(sim, "echo", { when: { event: "said" }, do: [{ give: { item: "dirt", count: 1 } }] });
  run(sim, "a", "say", { text: "hi" });
  ok(run(sim, "a", "propose", { entry: "granite", action: "retire", reason: "test" }));
  const loaded = Sim.load(sim.save(0));
  assertEquals(loaded.save(0), sim.save(0));
  assertEquals(loaded.catalog.byName("granite")!.forkedFrom, sim.catalog.byName("stone")!.id);
  // The rules index follows the loaded Catalog.
  run(loaded, "a", "say", { text: "hi" });
  assertEquals(loaded.agents[0].inventory.dirt, 2);
});

Deno.test("join and look mention the Catalog", () => {
  const sim = new Sim(7);
  assert(ok(run(sim, "a", "join", { name: "Fern" })).includes("Catalog"));
  assert(ok(run(sim, "a", "look")).includes("Catalog:"));
});

// ---------------------------------------------------------------- playtest 0001 fixes

Deno.test("said rules match whole words, not parts of words", () => {
  const { sim, fern } = world();
  addRule(sim, "rain song", {
    when: { event: "said", what: "rain" },
    do: [{ give: { item: "dirt" } }],
  });
  run(sim, "a", "say", { text: "My brain hurts, and the terrain is steep." });
  assertEquals(fern.inventory.dirt ?? 0, 0);
  run(sim, "a", "say", { text: "Oh, RAIN!" });
  assertEquals(fern.inventory.dirt, 1);
});

Deno.test("a rule's own speech doesn't trigger rules", () => {
  const { sim } = world();
  addRule(sim, "echo", { when: { event: "said", what: "ping" }, do: [{ say: "ping" }] });
  run(sim, "a", "say", { text: "ping" });
  assertEquals(sim.rules.stat(sim.catalog.byName("echo")!.id).fired, 1);
});

Deno.test("engine relations connect things; free labels connect anything", () => {
  const { sim } = world();
  err(
    run(sim, "a", "catalog_add", {
      kind: "relation",
      content: { type: "made_from", from: "lucky harvest", to: "stone" },
    }),
    "connects things",
  );
  ok(run(sim, "a", "catalog_add", {
    kind: "relation",
    content: { type: "inspired_by", from: "lucky harvest", to: "farmland" },
  }));
});

Deno.test("catalog_find refuses malformed property values", () => {
  const { sim } = world();
  err(run(sim, "a", "catalog_find", { property: "burns=true=true" }), "property looks like");
  err(run(sim, "a", "catalog_find", { kind: "material", property: "burns=yes" }), "true or false");
  const t = ok(run(sim, "a", "catalog_find", { kind: "material", property: "burns=true" }));
  assert(t.includes('"log"') && !t.includes('"stone"'), t);
});

Deno.test("look marks other villagers with digits, not letters", () => {
  const { sim } = world();
  run(sim, "b", "join", { name: "Wren" });
  const text = ok(run(sim, "a", "look", { radius: 12 }));
  assert(text.includes("1 Wren at"), text);
  const w = sim.agents[1], f = sim.agents[0];
  const row = text.split("\n").find((l) =>
    l.startsWith(String(Math.floor(w.z)).padStart(4) + " ")
  )!;
  assertEquals(row[5 + Math.floor(w.x) - (Math.floor(f.x) - 12)], "1");
});
