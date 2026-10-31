import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { type DesignContent, LIMITS } from "./catalog.ts";
import { Objects, type WorldObject } from "./objects.ts";
import { type CallResult, Sim, TICKS_PER_DAY } from "./sim.ts";
import { callTool } from "./tools.ts";
import { type Errand, NEEDS, VILLAGE_LIMITS } from "./village.ts";
import { food, worth } from "./worth.ts";
import { Block } from "./world.ts";

let nextCall = 1;
function run(sim: Sim, session: string, tool: string, args: Record<string, unknown> = {}) {
  const callId = nextCall++;
  callTool(sim, session, tool, args, callId);
  for (let i = 0; i < 40_000; i++) {
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
const steps = (sim: Sim, n: number) => {
  for (let i = 0; i < n; i++) sim.step();
};
/** Add an entry as Fern (the authoring rate limit is tested elsewhere). */
function add(sim: Sim, kind: string, name: string, content: unknown) {
  sim.agents[0].authored = [];
  return run(sim, "a", "catalog_add", { kind, name, description: "", content });
}

/** A villager beside a flat, clear patch of meadow south of them. */
function site(seed = 1337) {
  const sim = new Sim(seed);
  ok(run(sim, "a", "join", { name: "Fern" }));
  const fern = sim.agents[0];
  const w = sim.world;
  for (let r = 3; r < 80; r++) {
    for (let i = -r; i <= r; i++) {
      const x0 = Math.floor(fern.x) + i, z0 = Math.floor(fern.z) + r;
      const h = w.heightAt(x0, z0);
      let flat = h > 0;
      for (let z = z0 - 2; flat && z <= z0 + 9; z++) {
        for (let x = x0 - 2; flat && x <= x0 + 9; x++) {
          flat = w.heightAt(x, z) === h && w.get(x, h, z) === Block.Grass &&
            w.waterTop[z * w.sizeX + x] < 0 && !sim.props.at(x, z);
        }
      }
      if (flat) return { sim, fern, x: x0, z: z0, h };
    }
  }
  throw new Error("no flat site");
}

/** Stand `Fern` on (x, z). */
function stand(sim: Sim, x: number, z: number) {
  const a = sim.agents[0];
  a.x = x + 0.5, a.z = z + 0.5, a.y = sim.world.heightAt(x, z) + 1;
}

/** Put a nature Design's Object down on (x, z) as if built there. */
function put(sim: Sim, name: string, x: number, z: number): WorldObject {
  const e = sim.catalog.byName(name)!;
  const y = sim.world.heightAt(x, z) + 1;
  const o: WorldObject = {
    id: sim.objects.nextId(),
    design: e.id,
    x,
    y,
    z,
    turn: 0,
    by: "test",
    ...Objects.buildPose(e.content as DesignContent, x, y, z, 0),
    vel: [0, 0, 0],
    spin: [0, 0, 0],
    asleep: false,
  };
  sim.objects.add(o);
  return o;
}

/** An errand put on the board by hand, for tests that need a particular one. */
function errand(sim: Sim, e: Partial<Errand>): Errand {
  const full: Errand = {
    id: 900 + sim.village.errands.length,
    kind: "harvest",
    what: "",
    count: 1,
    done: 0,
    taker: null,
    posted: sim.tick,
    until: sim.tick + TICKS_PER_DAY,
    points: 5,
    ...e,
  };
  sim.village.errands = [full];
  return full;
}

// ---------------------------------------------------------------- needs

Deno.test("hunger and tiredness run down over a game day while a villager is around", () => {
  const { sim, fern } = site();
  assertEquals([fern.fed, fern.rested], [1, 1]);
  // Busy all day: a long walk back and forth keeps the queue full.
  for (let i = 0; i < TICKS_PER_DAY / 2; i += 20) {
    fern.lastActive = sim.tick;
    steps(sim, 20);
  }
  assert(Math.abs(fern.fed - (1 - NEEDS.hunger / 2)) < 0.01, String(fern.fed));
  assert(fern.rested < 1 - NEEDS.tire / 2 + 0.01 && fern.rested > 0.6, String(fern.rested));
  // Away (no call for an hour): needs hold still.
  const fed = fern.fed;
  steps(sim, NEEDS.away + 40);
  const held = fern.fed;
  steps(sim, TICKS_PER_DAY / 4);
  assertEquals(fern.fed, held);
  assert(fed - held < 0.05);
});

Deno.test("Sandbox pauses needs and slowness; switching tells every villager", () => {
  const { sim, fern } = site();
  fern.fed = 0.1;
  steps(sim, 20);
  assertEquals(fern.pace, NEEDS.slow);
  sim.village.setLife(false);
  const fed = fern.fed;
  steps(sim, 400);
  assertEquals(fern.fed, fed);
  assertEquals(fern.pace, 1);
  const look = ok(run(sim, "a", "look"));
  assert(look.includes("Sandbox"), look);
  assert(look.includes("A spectator switched the world"), look);
  sim.village.setLife(true);
  const again = ok(run(sim, "a", "look"));
  assert(again.includes("Village Life is on again") && again.includes("Needs: fed 10%"), again);
});

Deno.test("a hungry, tired villager walks and works slower, never stops", () => {
  const { sim, fern, x, z } = site();
  stand(sim, x, z);
  const timed = (tool: string, args: Record<string, unknown>) => {
    const t = sim.tick;
    ok(run(sim, "a", tool, args));
    return sim.tick - t;
  };
  const brisk = timed("walk_to", { x: x + 8, z });
  fern.fed = 0.05, fern.rested = 0.05;
  steps(sim, 20);
  assertEquals(fern.pace, NEEDS.slow * NEEDS.slow);
  const slow = timed("walk_to", { x, z });
  assert(slow > brisk * 1.8 && slow < brisk * 2.3, `${brisk} → ${slow}`);
  const tilling = timed("till", { x: x + 1, z: z + 1 });
  assert(tilling >= 24 / (NEEDS.slow * NEEDS.slow), String(tilling));
  // Crossing under a quarter was news.
  fern.fed = 0.3;
  const r = ok(run(sim, "a", "wait", { seconds: 60 }));
  assert(r.includes("getting hungry") || fern.fed > NEEDS.low, r);
});

Deno.test("eat fills hunger by a food's value, picks the best food, refuses what isn't food", () => {
  const { sim, fern } = site();
  err(run(sim, "a", "eat"), "You're full");
  fern.fed = 0.5;
  err(run(sim, "a", "eat"), "carry nothing to eat");
  fern.inventory.wheat = 3, fern.inventory.bread = 2, fern.inventory.stone = 1;
  err(run(sim, "a", "eat", { item: "stone" }), "stone isn't food");
  err(run(sim, "a", "eat", { item: "milk" }), "You have no milk");
  err(run(sim, "a", "eat", { count: 20 }), "count is 1-8");
  const r = ok(run(sim, "a", "eat"));
  assert(r.includes("You ate 1 bread: fed 50% → 85%"), r);
  // With room for a little, the small food rather than wasting a loaf.
  const r2 = ok(run(sim, "a", "eat", { count: 8 }));
  assert(r2.includes("wheat") && r2.includes("You're full"), r2);
  assertEquals(fern.inventory.bread, 1);
  assert(fern.fed >= 0.99);
});

Deno.test("Rules hear what a villager ate and how they slept", () => {
  const { sim, fern } = site();
  fern.fed = 0.2, fern.inventory.bread = 1;
  const r = ok(run(sim, "a", "eat", { item: "bread" }));
  assert(r.includes("Warm bread"), r); // nature's "warm bread" Rule
});

Deno.test("sleep waits for night; on the ground it rests at half a bed's pace", () => {
  const { sim, fern } = site();
  sim.setTimeOfDay(0.5);
  fern.rested = 0.2;
  err(run(sim, "a", "sleep"), "villagers sleep at night");
  sim.setTimeOfDay(21 / 24);
  const r = ok(run(sim, "a", "sleep"));
  assert(r.includes("on the ground") && r.includes("2h 0m"), r);
  // Two game hours of an eight-hour rest.
  assert(Math.abs(fern.rested - (0.2 + 2 / NEEDS.groundHours)) < 0.01, String(fern.rested));
  assert(r.includes("twice as fast"), r);
  fern.rested = 1;
  err(run(sim, "a", "sleep"), "wide awake");
});

Deno.test("sleep walks to a free bed, lies on it, and morning wakes everyone", () => {
  const { sim, fern, x, z } = site();
  stand(sim, x, z);
  const bed = put(sim, "bed", x + 3, z + 2);
  sim.setTimeOfDay(5 / 24);
  fern.rested = 0.1;
  callTool(sim, "a", "sleep", {}, 77);
  let lay = false;
  for (let i = 0; i < 3000 && !sim.results.some((r) => r.callId === 77); i++) {
    sim.step();
    if (fern.sleeping === bed.id) {
      lay = true;
      // On the mattress, along the bed.
      assert(fern.y > sim.world.heightAt(x + 3, z + 2) + 1.5, String(fern.y));
      assert(Math.floor(fern.x) === x + 3, String(fern.x));
    }
  }
  assert(lay, "never lay down in the bed");
  const r = sim.results.find((r) => r.callId === 77)!;
  assert(!r.isError && r.text.includes("in the bed") && r.text.includes("morning came"), r.text);
  // An hour of a four-hour rest, then up at six.
  assert(Math.abs(fern.rested - (0.1 + 1 / NEEDS.bedHours)) < 0.02, String(fern.rested));
  assertEquals(fern.sleeping, undefined);
  assert(fern.y < sim.world.heightAt(x + 3, z + 2) + 1.5, "stood up beside the bed");
});

// ---------------------------------------------------------------- worth and food

Deno.test("worth passes along recipes and never splits finer than 1/16 of a log", () => {
  const { sim } = site();
  const c = sim.catalog;
  assertEquals(worth(c, c.byName("log")!), 1);
  assertEquals(worth(c, c.byName("planks")!), 0.25);
  const mat = { form: "block", color: "#aa8844", pattern: "planks" };
  ok(add(sim, "material", "zing", mat));
  ok(add(sim, "material", "zang", mat));
  ok(add(sim, "relation", "", { type: "made_from", from: "zing", to: "planks", count: 4 }));
  assertEquals(worth(c, c.byName("zing")!), LIMITS.worthFloor);
  err(
    add(sim, "relation", "", { type: "made_from", from: "zang", to: "zing", count: 4 }),
    "makes at most 1 zang",
  );
  ok(add(sim, "relation", "", { type: "made_from", from: "zang", to: "zing", count: 1 }));
  // A chain built while its root was raw can't be cheapened later: that would multiply it.
  ok(add(sim, "material", "raw", mat));
  ok(add(sim, "material", "fine", mat));
  ok(add(sim, "relation", "", { type: "made_from", from: "fine", to: "raw", count: 4 }));
  err(
    add(sim, "relation", "", { type: "made_from", from: "raw", to: "planks", count: 4 }),
    "each fine (made from it) would be worth 1/64",
  );
  ok(add(sim, "relation", "", { type: "made_from", from: "raw", to: "log", count: 4 }));
});

Deno.test("an agent's food feeds no more than its ingredients; cooking at a bench adds half", () => {
  const { sim } = site();
  const c = sim.catalog;
  const jam = { form: "item", color: "#882244", pattern: "plain", food: 1 };
  ok(add(sim, "material", "jam", jam));
  assertEquals(food(c, c.byName("jam")!), 0, "made of nothing, it feeds nobody");
  ok(add(sim, "relation", "", { type: "made_from", from: "jam", to: "berries" }));
  assertEquals(food(c, c.byName("jam")!), 0.1);
  ok(add(sim, "material", "stew", { ...jam, food: 0.5 }));
  ok(add(sim, "relation", "", { type: "made_from", from: "stew", to: "cod", count: 1 }));
  ok(add(sim, "relation", "", { type: "needs", from: "stew", to: "oven" }));
  assert(Math.abs(food(c, c.byName("stew")!) - 0.45) < 1e-9);
  err(add(sim, "relation", "", { type: "needs", from: "bread", to: "bed" }), "nature's");
  err(add(sim, "relation", "", { type: "needs", from: "stew", to: "oak" }), "workbench");
  err(add(sim, "material", "x", { ...jam, food: 2 }), "food must be a number from 0 to 1");
});

Deno.test("bread is baked beside an oven: craft walks over to one", () => {
  const { sim, fern, x, z } = site();
  sim.village.credit(40); // a hamlet: the oven's flame is unlocked
  fern.inventory.wheat = 3;
  err(run(sim, "a", "craft", { item: "bread" }), 'made at a "oven"');
  put(sim, "oven", x + 6, z + 6);
  stand(sim, x, z);
  const r = ok(run(sim, "a", "craft", { item: "bread", times: 2 }));
  assert(r.includes("Crafted 2 bread from 2 wheat at the oven"), r);
  assert(Math.hypot(fern.x - (x + 6.5), fern.z - (z + 6.5)) < 3.5, "walked to the oven");
});

// ---------------------------------------------------------------- the village

Deno.test("a camp can't build, craft or place what a hamlet or village unlocks", () => {
  const { sim, fern, x, z } = site();
  fern.inventory.planks = 40,
    fern.inventory.stone = 2,
    fern.inventory.clay = 4,
    fern.inventory["lantern glass"] = 2;
  err(run(sim, "a", "build", { design: "hand cart", x, z }), "needs axle (unlocks at a hamlet)");
  err(run(sim, "a", "build", { design: "windmill", x, z }), "motor (unlocks at a village)");
  err(
    run(sim, "a", "craft", { item: "brick" }),
    "brick unlocks once the village has grown into a hamlet",
  );
  err(run(sim, "a", "place_block", { block: "lantern glass", x, z }), "a village");
  ok(run(sim, "a", "build", { design: "stone bench", x, z }));
  // An agent's glowing Material is a light: it waits for lamps.
  ok(add(sim, "material", "glowstone", { form: "block", color: "#ffee88", glows: 0.5 }));
  ok(add(sim, "relation", "", { type: "made_from", from: "glowstone", to: "dirt" }));
  fern.inventory.dirt = 1;
  err(run(sim, "a", "craft", { item: "glowstone" }), "a hamlet");
  // Sandbox unlocks everything.
  sim.village.setLife(false);
  ok(run(sim, "a", "craft", { item: "brick" }));
});

Deno.test("points grow the village and each level unlocks its Elements, told to everyone", () => {
  const { sim, fern, x, z } = site();
  assertEquals(sim.village.levelName, "camp");
  fern.inventory.stone = 4, fern.inventory.planks = 4;
  const r = ok(run(sim, "a", "build", { design: "stone bench", x, z }));
  assert(r.includes('First "stone bench" in the village'), r);
  const pts = sim.village.points;
  assert(pts >= 1, String(pts));
  ok(run(sim, "a", "build", { design: "stone bench", x: x + 3, z }));
  assertEquals(sim.village.points, pts, "a second bench earns nothing");
  sim.village.credit(40 - pts);
  assertEquals(sim.village.levelName, "hamlet");
  const look = ok(run(sim, "a", "look"));
  assert(look.includes("grown into a hamlet! Unlocked: brick, tiles, hinge, axle, slider"), look);
  assert(look.includes("lamp, flame"), look);
  fern.inventory.clay = 1;
  ok(run(sim, "a", "craft", { item: "brick" }));
  sim.village.credit(80);
  assertEquals(sim.village.levelName, "village");
  sim.village.credit(500);
  assert(sim.village.levelText().includes("as big as it grows"));
});

Deno.test("building another villager's Design credits the village and tells its author", () => {
  const { sim, fern, x, z } = site();
  ok(run(sim, "b", "join", { name: "Wren" }));
  const hut = {
    blocks: { palette: { p: "planks" }, layers: [["pp"]] },
    parts: [],
  };
  ok(
    run(sim, "b", "catalog_add", {
      kind: "design",
      name: "wren seat",
      description: "",
      content: hut,
    }),
  );
  fern.inventory.planks = 4;
  const before = sim.village.points;
  const r = ok(run(sim, "a", "build", { design: "wren seat", x, z }));
  assert(r.includes('You built Wren\'s "wren seat"'), r);
  // Two planks of blocks: half a log for the first build, and the bonus for sharing.
  assertEquals(sim.village.points, before + VILLAGE_LIMITS.borrowed + 0.5);
  const wren = ok(run(sim, "b", "look"));
  assert(wren.includes('Fern built your "wren seat"'), wren);
});

// ---------------------------------------------------------------- errands

Deno.test("the world posts three errands, the same for the same seed", () => {
  const a = site(7).sim, b = site(7).sim;
  steps(a, 100), steps(b, 100);
  assertEquals(a.village.errands.length, VILLAGE_LIMITS.errands);
  assertEquals(a.village.errands, b.village.errands);
  const board = ok(run(a, "a", "errands"));
  assert(board.includes("#1 ") && board.includes("a loaf of bread (open"), board);
  a.village.setLife(false);
  err(run(a, "a", "errands"), "Sandbox");
});

Deno.test("a bring errand takes what it asks for and pays points and bread", () => {
  const { sim, fern } = site();
  const e = errand(sim, { kind: "bring", what: "wheat", count: 4, points: 4 });
  err(run(sim, "a", "errands", { action: "give", id: e.id }), "take it first");
  err(run(sim, "a", "errands", { action: "take", id: 5 }), "no errand #5");
  ok(run(sim, "a", "errands", { action: "take", id: e.id }));
  err(run(sim, "a", "errands", { action: "take", id: e.id }), "already yours");
  fern.inventory.wheat = 3;
  err(run(sim, "a", "errands", { action: "give", id: e.id }), "You carry 3 wheat");
  fern.inventory.wheat = 5;
  const r = ok(run(sim, "a", "errands", { action: "give", id: e.id }));
  assert(r.includes("done") && r.includes("+4 points") && r.includes("bread"), r);
  assertEquals(fern.inventory.wheat, 1);
  assertEquals(fern.inventory.bread, 1);
  assertEquals(sim.village.points, 4);
  assertEquals(sim.village.errands.length, 0);
});

Deno.test("errands count what their taker does, two at a time, and lapse", () => {
  const { sim, fern, x, z } = site();
  ok(run(sim, "b", "join", { name: "Wren" }));
  const e = errand(sim, { kind: "plant", count: 2 });
  sim.village.errands.push({ ...e, id: 950, kind: "catch" }, { ...e, id: 951, kind: "sleep" });
  ok(run(sim, "a", "errands", { action: "take", id: e.id }));
  ok(run(sim, "a", "errands", { action: "take", id: 950 }));
  err(run(sim, "a", "errands", { action: "take", id: 951 }), "You hold 2 errands");
  err(run(sim, "b", "errands", { action: "take", id: e.id }), "Fern took errand");
  // Wren planting doesn't count for Fern; Fern's saplings do.
  stand(sim, x, z);
  ok(run(sim, "a", "plant", { x: x + 2, z: z + 2, seed: "oak sapling" }));
  assertEquals(e.done, 1);
  ok(run(sim, "a", "plant", { x: x + 4, z: z + 2, seed: "birch sapling" }));
  assertEquals(sim.village.errands.find((x) => x.id === e.id), undefined, "done");
  ok(run(sim, "a", "errands", { action: "drop", id: 950 }));
  ok(run(sim, "b", "errands", { action: "take", id: 951 }));
  steps(sim, VILLAGE_LIMITS.taken + 40);
  const wren = ok(run(sim, "b", "look"));
  assert(wren.includes("ran out of time"), wren);
  assert(fern.inventory.bread === 1);
});

Deno.test("a harvest errand and a build errand", () => {
  const { sim, fern, x, z } = site();
  const e = errand(sim, { kind: "harvest", count: 2 });
  ok(run(sim, "a", "errands", { action: "take", id: e.id }));
  stand(sim, x, z);
  ok(run(sim, "a", "till", { x, z: z + 1, width: 2 }));
  ok(run(sim, "a", "plant", { x, z: z + 1, width: 2 }));
  steps(sim, Math.round(TICKS_PER_DAY * 18 / 24) + 20);
  ok(run(sim, "a", "harvest", { x, z: z + 1, width: 2 }));
  assert(fern.inventory.bread === 1, "harvest errand paid");
  const b = errand(sim, { kind: "build", what: "stone bench" });
  ok(run(sim, "a", "errands", { action: "take", id: b.id }));
  fern.inventory.stone = 4, fern.inventory.planks = 4;
  const r = ok(run(sim, "a", "build", { design: "stone bench", x: x + 4, z: z + 4 }));
  assert(r.includes(`Errand #${b.id} done`), r);
});

// ---------------------------------------------------------------- Rules

Deno.test("villagers' Rules conjure from a shared daily bounty; nature's are free", () => {
  const { sim, fern } = site();
  ok(add(sim, "rule", "fountain", {
    when: { event: "said", what: "more" },
    do: [{ give: { item: "log", count: 4 } }],
  }));
  for (let i = 0; i < 10; i++) run(sim, "a", "say", { text: "more" });
  assertEquals(fern.inventory.log, VILLAGE_LIMITS.bounty);
  const stat = sim.rules.stat(sim.catalog.byName("fountain")!.id);
  assert(stat.skipped.includes("bounty"), stat.skipped);
  // A new day, a new bounty.
  steps(sim, TICKS_PER_DAY);
  run(sim, "a", "say", { text: "more" });
  assertEquals(fern.inventory.log, VILLAGE_LIMITS.bounty + 4);
  // Sandbox: no bounty at all.
  sim.village.setLife(false);
  for (let i = 0; i < 10; i++) run(sim, "a", "say", { text: "more" });
  assertEquals(fern.inventory.log, VILLAGE_LIMITS.bounty + 44);
});

// ---------------------------------------------------------------- save

Deno.test("needs, the village and its errands survive a save", () => {
  const { sim, fern } = site();
  steps(sim, 100);
  fern.fed = 0.42, fern.rested = 0.3;
  sim.village.credit(12);
  ok(run(sim, "a", "errands", { action: "take", id: sim.village.errands[0].id }));
  sim.village.setLife(false);
  const back = Sim.load(structuredClone(sim.save(0)));
  assertEquals([back.agents[0].fed, back.agents[0].rested], [0.42, 0.3]);
  assertEquals(back.village.life, false);
  assertEquals(back.village.points, 12);
  assertEquals(back.village.errands, sim.village.errands);
  // Saves from before Village Life: everyone starts fed and rested, nature's foods feed.
  const old = structuredClone(sim.save(0)) as unknown as Record<string, unknown>;
  delete old.village;
  for (const a of old.agents as Record<string, unknown>[]) delete a.fed, delete a.rested;
  const wheat = (old.catalog as { entries: { name: string; content: Record<string, unknown> }[] })
    .entries.find((e) => e.name === "wheat")!;
  delete wheat.content.food;
  const loaded = Sim.load(old as never);
  assertEquals(loaded.agents[0].fed, 1);
  assertEquals(loaded.village.life, true);
  assertEquals(food(loaded.catalog, loaded.catalog.byName("wheat")!), 0.1);
});

Deno.test("join and look tell an agent about Village Life", () => {
  const sim = new Sim(1337);
  const j = ok(run(sim, "a", "join", { name: "Fern" }));
  assert(j.includes("Village Life is on") && j.includes("errands"), j);
  const look = ok(run(sim, "a", "look"));
  assert(look.includes("Needs: fed 100%, rested 100%. Village: a camp, 0 of 40"), look);
  sim.village.setLife(false);
  const j2 = ok(run(sim, "b", "join", { name: "Wren" }));
  assert(j2.includes("This world is a Sandbox"), j2);
});

// ---------------------------------------------------------------- playtest 0009

Deno.test("playtest 0009: craft says what's locked before what's missing", () => {
  const { sim } = site();
  err(run(sim, "a", "craft", { item: "brick" }), "brick unlocks once the village has grown");
  err(run(sim, "a", "craft", { item: "bread" }), "a hamlet");
});

Deno.test("playtest 0009: Materials named with underscores craft and place by that name", () => {
  const { sim, fern, x, z } = site();
  stand(sim, x, z);
  ok(add(sim, "material", "hazel_clay_tile", { form: "block", color: "#aa6644" }));
  ok(add(sim, "relation", "", { type: "made_from", from: "hazel_clay_tile", to: "planks" }));
  fern.inventory.planks = 2;
  const r = ok(run(sim, "a", "craft", { item: "hazel_clay_tile" }));
  assert(r.includes("Crafted 1 hazel_clay_tile"), r);
  ok(run(sim, "a", "place_block", { block: "hazel_clay_tile", x: x + 1, z }));
  fern.inventory.wool = 1;
  err(run(sim, "a", "place_block", { block: "wool", x: x + 2, z }), "an item, not a block");
});

Deno.test("playtest 0009: a bare string or list as arguments is refused plainly", () => {
  const { sim } = site();
  err(run(sim, "a", "eat", "wheat" as never), "arguments are an object");
  err(run(sim, "a", "eat", ["wheat"] as never), "arguments are an object");
});

Deno.test("playtest 0009: a finished bring errand says so once", () => {
  const { sim, fern } = site();
  const e = errand(sim, { kind: "bring", what: "log", count: 3 });
  ok(run(sim, "a", "errands", { action: "take", id: e.id }));
  fern.inventory.log = 3;
  const r = ok(run(sim, "a", "errands", { action: "give", id: e.id }));
  assertEquals(r.split(`Errand #${e.id} done`).length, 2, r);
  assert(r.startsWith("You hand over 3 log."), r);
});

Deno.test("playtest 0009: a cheap Design's first build earns its worth, not a whole point", () => {
  const { sim, fern, x, z } = site();
  stand(sim, x, z);
  const crate = {
    parts: [{ part: "box", material: "planks", at: [0.5, 0.3, 0.5], size: [0.6, 0.6, 0.6] }],
  };
  ok(add(sim, "design", "tiny crate", crate));
  fern.inventory.planks = 1;
  ok(run(sim, "a", "build", { design: "tiny crate", x: x + 2, z: z + 2 }));
  assertEquals(sim.village.points, 0.25);
});

Deno.test("playtest 0009: a Rule that finds the bounty spent tells whoever set it off", () => {
  const { sim } = site();
  ok(add(sim, "rule", "gimme", {
    when: { event: "said", what: "gimme" },
    do: [{ give: { item: "log", count: 4 } }],
  }));
  for (let i = 0; i < 6; i++) ok(run(sim, "a", "say", { text: "gimme" }));
  const r = ok(run(sim, "a", "say", { text: "gimme" }));
  assert(r.includes('"gimme" gave nothing') && r.includes("bounty"), r);
  const look = ok(run(sim, "a", "look"));
  assert(look.includes("0 of 24 things left to give today"), look);
});

Deno.test("playtest 0009: look points to the nearest sheep when none is in view", () => {
  const { sim, fern } = site();
  const sheep = sim.animals.find((a) => a.species === 0)!;
  fern.x = sheep.x + 20, fern.z = sheep.z;
  for (const a of sim.animals) if (a !== sheep && a.species === 0) a.x += 200;
  const look = ok(run(sim, "a", "look", { radius: 6 }));
  assert(look.includes("a sheep (wool) at"), look);
});

Deno.test("playtest 0009: the board keeps three errands open while others are taken", () => {
  const { sim } = site();
  ok(run(sim, "b", "join", { name: "Wren" }));
  steps(sim, 100);
  ok(run(sim, "a", "errands", { action: "take", id: sim.village.errands[0].id }));
  ok(run(sim, "b", "errands", { action: "take", id: sim.village.errands[1].id }));
  steps(sim, 100);
  assertEquals(sim.village.errands.filter((e) => !e.taker).length, VILLAGE_LIMITS.errands);
  assertEquals(sim.village.errands.length, 5);
  const look = ok(run(sim, "a", "look"));
  assert(!look.includes("give))"), look);
});
