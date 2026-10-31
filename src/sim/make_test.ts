import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { findPath, levelAt } from "./path.ts";
import { GROWN } from "./props.ts";
import { type CallResult, Sim } from "./sim.ts";
import { callTool } from "./tools.ts";
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
};

/** A villager next to a flat, clear patch of meadow, `w` × `d` columns, south of them. */
function site(w = 6, d = 6) {
  const sim = new Sim(1337);
  sim.village.life = false; // M7-M11 mechanics on their own: a Sandbox, nothing locked
  ok(run(sim, "a", "join", { name: "Fern" }));
  const fern = sim.agents[0];
  const world = sim.world;
  for (let r = 3; r < 60; r++) {
    for (let i = -r; i <= r; i++) {
      const x0 = Math.floor(fern.x) + i, z0 = Math.floor(fern.z) + r;
      const h = world.heightAt(x0, z0);
      let flat = h > 0;
      for (let z = z0 - 2; flat && z <= z0 + d + 1; z++) {
        for (let x = x0 - 2; flat && x <= x0 + w + 1; x++) {
          flat = world.heightAt(x, z) === h && world.get(x, h, z) === Block.Grass &&
            world.waterTop[z * world.sizeX + x] < 0 && !sim.props.at(x, z);
        }
      }
      if (flat) return { sim, fern, x: x0, z: z0, h };
    }
  }
  throw new Error("no flat site");
}

function add(sim: Sim, kind: string, name: string, content: unknown) {
  return ok(run(sim, "a", "catalog_add", { kind, name, description: "test", content }));
}

const post = (x: number, z: number, h: number, mat = "planks") => ({
  part: "box",
  material: mat,
  at: [x, h / 2, z],
  size: [0.2, h, 0.2],
});

// ---------------------------------------------------------------- craft

Deno.test("craft turns one Material into another along made_from, a batch a second", () => {
  const { sim, fern } = site();
  err(run(sim, "a", "craft", { item: "planks" }), "You need log");
  fern.inventory.log = 2;
  const text = ok(run(sim, "a", "craft", { item: "planks", times: 3 }));
  assert(text.startsWith("Crafted 8 planks from 2 log. You ran out of log after 2."), text);
  assertEquals(fern.inventory.planks, 8);
  assertEquals(fern.inventory.log, 0);
  fern.inventory.clay = 1;
  ok(run(sim, "a", "craft", { item: "tiles", from: "clay" }));
  assertEquals(fern.inventory.tiles, 1);
  err(run(sim, "a", "craft", { item: "brick", from: "dirt" }), "made from clay");
  err(run(sim, "a", "craft", { item: "wool" }), "no made_from Relation");
  err(run(sim, "a", "craft", { item: "unobtainium" }), "isn't a Material");
  err(run(sim, "a", "craft", { item: "planks", times: 99 }), "times is 1-16");
});

Deno.test("agents' recipes make their own Materials; nature's keep nature's recipes", () => {
  const { sim, fern } = site();
  err(
    run(sim, "a", "catalog_add", {
      kind: "relation",
      content: { type: "made_from", from: "log", to: "dirt" },
    }),
    "nature's",
  );
  err(
    run(sim, "a", "catalog_add", {
      kind: "relation",
      content: { type: "made_from", from: "planks", to: "oak" },
    }),
    "made_from goes from the Material",
  );
  ok(run(sim, "a", "catalog_fork", { from: "planks", name: "oak boards" }));
  add(sim, "relation", "", { type: "made_from", from: "oak boards", to: "log", count: 2 });
  add(sim, "rule", "sawdust", {
    when: { event: "crafted", what: "boards" },
    do: [{ say: "Sawdust everywhere." }],
  });
  fern.inventory.log = 1;
  ok(run(sim, "a", "craft", { item: "oak_boards" }));
  assertEquals(fern.inventory["oak boards"], 2);
  assertEquals(sim.rules.stat(sim.catalog.byName("sawdust")!.id).fired, 1);
  // A passed replacement: the old recipe now makes the replacement.
  ok(run(sim, "a", "propose", {
    entry: "planks",
    action: "replace",
    replacement: "oak boards",
    reason: "nicer",
  }));
  for (let i = 0; i < 40; i++) sim.step();
  fern.inventory.log = 1;
  const text = ok(run(sim, "a", "craft", { item: "planks", from: "log" }));
  assert(text.startsWith("Crafted 4 oak boards from 1 log"), text);
});

// ---------------------------------------------------------------- objects

Deno.test("build puts a Design's parts up as one Object, paid for by volume", () => {
  const { sim, fern, x, z, h } = site();
  // stone bench: two stone blocks with a plank top (3 × 0.2 × 1 = 0.6 → 1 planks).
  err(run(sim, "a", "build", { design: "stone bench", x, z }), "short of 2 stone, 1 planks");
  fern.inventory.stone = 2;
  fern.inventory.planks = 1;
  const text = ok(run(sim, "a", "build", { design: "stone bench", x, z }));
  assert(
    text.includes("2 of 2 done") && text.includes("stands as one Object (1 planks used)"),
    text,
  );
  assertEquals(sim.objects.list.length, 1);
  assertEquals(fern.inventory.planks, 0);
  const o = sim.objects.list[0];
  assertEquals([o.x, o.y, o.z, o.turn, o.by], [x, h + 1, z, 0, "Fern"]);
  // The seat over the gap is too high to stand on; its ends, on the stone, are a low top.
  const key = (dx: number) => z * sim.world.sizeX + x + dx;
  assertEquals(sim.world.objSolid[key(1)], 1);
  assert(Math.abs(sim.world.objLift[key(0)] - 0.2) < 1e-6);
  assert(ok(run(sim, "a", "build", { design: "stone bench", x, z })).includes("already complete"));
  const look = ok(run(sim, "a", "look", { radius: 12 }));
  assert(/Objects: \S stone bench \(stand on\/in the way\)/.test(look), look);
  // Nothing digs or builds through it.
  assert(ok(run(sim, "a", "break_block", { x, z })).includes("stands on it"));
  fern.inventory.dirt = 1;
  assert(ok(run(sim, "a", "place_block", { x: x + 1, z, block: "dirt" })).includes("in the way"));
});

Deno.test("Objects are walked around when tall and stood on when low", () => {
  const { sim, fern, x, z, h } = site(8, 8);
  // A wall of posts 3 long, 1.5 high across the middle, and a low platform 0.4 high.
  add(sim, "design", "post fence", {
    parts: [post(0.5, 0.5, 1.5), post(1.5, 0.5, 1.5), post(2.5, 0.5, 1.5), {
      part: "box",
      material: "planks",
      at: [1.5, 1.2, 0.5],
      size: [3, 0.15, 0.1],
    }],
  });
  add(sim, "design", "deck", {
    parts: [{ part: "box", material: "planks", at: [1, 0.2, 1], size: [2, 0.4, 2] }],
  });
  fern.inventory.planks = 20;
  ok(run(sim, "a", "build", { design: "post fence", x, z: z + 2 }));
  const w = sim.world;
  for (let i = 0; i < 3; i++) assertEquals(w.objSolid[(z + 2) * w.sizeX + x + i], 1);
  // The way from north to south of the fence goes round it.
  const path = findPath(
    w,
    x + 1,
    z,
    levelAt(w, x + 1, z, h + 1),
    (cx, cz) => cx === x + 1 && cz === z + 4,
    () => 0,
  )!;
  for (let i = 0; i < path.length; i += 2) {
    assert(!(path[i + 1] === z + 2 && path[i] >= x && path[i] <= x + 2), "through the fence");
  }
  // A quarter turn runs the fence north-south instead.
  ok(run(sim, "a", "build", { design: "post fence", x: x + 6, z: z + 1, turn: 90 }));
  const turned = sim.objects.list[1];
  assertEquals(turned.turn, 1);
  for (let i = 0; i < 3; i++) assertEquals(w.objSolid[(z + 1 + i) * w.sizeX + x + 6], 1);
  // The deck is stood on.
  ok(run(sim, "a", "build", { design: "deck", x: x + 2, z: z + 5 }));
  ok(run(sim, "a", "walk_to", { x: x + 3, z: z + 6 }));
  for (let i = 0; i < 20; i++) sim.step();
  assert(Math.abs(fern.y - (h + 1.4)) < 0.05, `standing on the deck at ${fern.y}`);
  // Saved and loaded, the Objects and what they block come back.
  const loaded = Sim.load(sim.save(0));
  assertEquals(loaded.objects.list, sim.objects.list);
  assertEquals(loaded.world.objSolid, w.objSolid);
  assertEquals(loaded.world.objLift, w.objLift);
});

Deno.test("Objects need clear, dry ground and the whole cost up front", () => {
  const { sim, fern, x, z } = site();
  add(sim, "design", "statue", { parts: [post(0.5, 0.5, 2, "stone")] });
  err(run(sim, "a", "build", { design: "statue", x, z }), "short of 1 stone");
  fern.inventory.stone = 4;
  sim.props.set(x, z, { design: sim.catalog.byName("oak")!.id, planted: GROWN, grow: 0 });
  err(run(sim, "a", "build", { design: "statue", x, z }), "a oak is in the way");
  ok(run(sim, "a", "till", { x: x + 1, z }));
  ok(run(sim, "a", "plant", { x: x + 1, z }));
  err(run(sim, "a", "build", { design: "statue", x: x + 1, z }), "a crop is growing");
  ok(run(sim, "a", "build", { design: "statue", x: x + 2, z }));
  err(run(sim, "a", "build", { design: "deck", x: x + 2, z }), "Nothing called");
  add(sim, "design", "plinth", { parts: [post(0.5, 0.5, 0.3, "stone")] });
  err(run(sim, "a", "build", { design: "plinth", x: x + 2, z }), "statue at");
  err(run(sim, "a", "build", { design: "statue", x, z, turn: 45 }), "turn is 0, 90");
  // Nothing grows where an Object stands.
  assert(ok(run(sim, "a", "till", { x: x + 2, z })).includes("the statue stands there"));
});

// ---------------------------------------------------------------- interact

Deno.test("interact chops trees, picks flowers, breaks rocks and digs up saplings", () => {
  const { sim, fern, x, z } = site();
  const id = (name: string) => sim.catalog.byName(name)!.id;
  sim.props.set(x + 1, z, { design: id("oak"), planted: GROWN, grow: 0 });
  sim.props.set(x + 3, z, { design: id("poppies"), planted: GROWN, grow: 0 });
  sim.props.set(x + 1, z + 3, { design: id("rock"), planted: GROWN, grow: 0 });
  const chopped = ok(run(sim, "a", "interact", { x: x + 1, z }));
  assert(chopped.startsWith("You chopped down the oak, got 3 log, 1 oak sapling."), chopped);
  assertEquals(sim.props.at(x + 1, z), undefined);
  assert(!sim.world.propSolid[z * sim.world.sizeX + x + 1], "the way is clear");
  const picked = ok(run(sim, "a", "interact", { x: x + 3, z }));
  assert(picked.includes("picked the poppies, got 2 poppy"), picked);
  // A picked flower grows back where it's planted.
  ok(run(sim, "a", "plant", { x: x + 4, z: z + 1, seed: "poppy" }));
  assertEquals(sim.props.at(x + 4, z + 1)?.design, id("poppies"));
  assert(ok(run(sim, "a", "interact", { x: x + 1, z: z + 3 })).includes("broke the rock"));
  assertEquals(fern.inventory.stone, 2);
  // A young sapling comes back up as a sapling.
  ok(run(sim, "a", "plant", { x: x + 5, z: z + 5, seed: "birch sapling" }));
  const dug = ok(run(sim, "a", "interact", { x: x + 5, z: z + 5 }));
  assert(dug.includes("dug up the birch, got 1 birch sapling"), dug);
  err(run(sim, "a", "interact", { x: x + 5, z: z + 5 }), "nothing to gather");
  err(run(sim, "a", "interact", { x, z, width: 6, target: "unicorn" }), "no unicorn");
  err(run(sim, "a", "interact", { x, z, width: 9, depth: 9 }), "At most 16");
});

Deno.test("interact takes an Object apart for its Materials, whoever built it", () => {
  const { sim, fern, x, z } = site();
  fern.inventory.planks = 4;
  add(sim, "design", "deck", {
    parts: [{ part: "box", material: "planks", at: [1, 0.2, 1], size: [2, 0.4, 2] }],
  });
  ok(run(sim, "a", "build", { design: "deck", x, z }));
  assertEquals(fern.inventory.planks, 2);
  ok(run(sim, "b", "join", { name: "Moss" }));
  const text = ok(run(sim, "b", "interact", { x: x + 1, z: z + 1 }));
  assert(text.startsWith("You took apart the deck, got 2 planks."), text);
  assertEquals(sim.objects.list.length, 0);
  assertEquals(sim.world.objLift[z * sim.world.sizeX + x], 0);
});

Deno.test("interact shears sheep when their wool is ready, approaching slowly", () => {
  const { sim, fern, x, z } = site();
  const sheep = sim.animals.find((a) => a.species === 0)!;
  sheep.x = x + 3.5, sheep.z = z + 2.5, sheep.y = sim.world.surfaceY(sheep.x, sheep.z);
  sheep.tx = sheep.x, sheep.tz = sheep.z;
  const text = ok(run(sim, "a", "interact", { x: x + 2, z: z + 1, width: 3, depth: 3 }));
  assert(text.includes("sheared a sheep, got 1 wool"), text);
  assertEquals(fern.inventory.wool, 1);
  assert(sheep.readyAt > sim.tick, "its wool grows back");
  const again = ok(run(sim, "a", "interact", {
    x: Math.floor(sheep.x) - 1,
    z: Math.floor(sheep.z) - 1,
    width: 3,
    depth: 3,
    target: "sheep",
  }));
  assert(again.includes("has no wool yet"), again);
});

Deno.test("playtest 0004: targets match what things give, and refusals say what is there", () => {
  const { sim, fern, x, z } = site();
  const id = (name: string) => sim.catalog.byName(name)!.id;
  sim.props.set(x + 1, z, { design: id("bush"), planted: GROWN, grow: 0 });
  sim.props.set(x + 3, z, { design: id("birch"), planted: GROWN, grow: 0 });
  assert(
    ok(run(sim, "a", "interact", { x, z, width: 3, target: "berries" })).includes("3 berries"),
  );
  err(run(sim, "a", "interact", { x: x + 3, z, target: "oak" }), "There's birch.");
  err(
    run(sim, "a", "interact", { x: x + 4, z: z + 4, target: "sheep" }),
    "The nearest sheep is at",
  );
  // A tall Object's tile can't be stood on, and walk_to says so.
  add(sim, "design", "statue", { parts: [post(0.5, 0.5, 2, "stone")] });
  fern.inventory.stone = 1;
  ok(run(sim, "a", "build", { design: "statue", x: x + 5, z: z + 5 }));
  err(run(sim, "a", "walk_to", { x: x + 5, z: z + 5 }), "the statue stands there, in the way");
  // Object marks never reuse a plant's, wherever the plant is.
  const look = ok(run(sim, "a", "look", { radius: 12 }));
  const mark = /Objects: (\S) statue/.exec(look)?.[1];
  assert(mark && !"T A b * | o % W".split(" ").includes(mark), look);
  // A recipe says which way it runs.
  ok(run(sim, "a", "catalog_fork", { from: "planks", name: "pine boards" }));
  const added = ok(run(sim, "a", "catalog_add", {
    kind: "relation",
    content: { type: "made_from", from: "pine boards", to: "log", count: 3 },
  }));
  assert(added.includes('craft "pine boards" makes 3 from each log'), added);
});

Deno.test("playtest 0004: no sky Objects, no recipe loops, no 64-fold recipes", () => {
  const { sim, fern, x, z, h } = site();
  add(sim, "design", "pebble", {
    parts: [{ part: "sphere", material: "stone", at: [0.5, 0.1, 0.5], size: [0.2, 0.2, 0.2] }],
  });
  fern.inventory.stone = 2;
  err(run(sim, "a", "build", { design: "pebble", x, z, y: 9999 }), "leave out y");
  err(run(sim, "a", "build", { design: "stone bench", x, z, y: 9999 }), "out of range");
  err(run(sim, "a", "build", { design: "stone bench", x, z, y: -5 }), "out of range");
  ok(run(sim, "a", "build", { design: "pebble", x, z }));
  assertEquals(sim.objects.list[0].y, h + 1);
  // Recipes: at most 4 from each ingredient, and no loops.
  ok(run(sim, "a", "catalog_fork", { from: "planks", name: "zing" }));
  ok(run(sim, "a", "catalog_fork", { from: "planks", name: "zang" }));
  const recipe = (from: string, to: string, count = 1) =>
    run(sim, "a", "catalog_add", {
      kind: "relation",
      content: { type: "made_from", from, to, count },
    });
  err(recipe("zing", "planks", 64), "at most 4");
  ok(recipe("zing", "planks", 2));
  ok(recipe("zang", "zing", 2));
  err(recipe("zing", "zang"), "loop");
  ok(recipe("zing", "log"));
  // Two recipes, both ingredients held: it says which it used and how to choose.
  fern.inventory.planks = 1;
  fern.inventory.log = 1;
  const text = ok(run(sim, "a", "craft", { item: "zing" }));
  assert(text.includes("from 1 planks") && text.includes("also made from log"), text);
});

Deno.test("playtest 0004: parts on a tall block grid go up from beside it", () => {
  const { sim, fern, x, z, h } = site();
  add(sim, "design", "pillar lamp", {
    blocks: { palette: { s: "stone" }, layers: [["s"], ["s"], ["s"]] },
    parts: [{ part: "sphere", material: "stone", at: [0.5, 3.3, 0.5], size: [0.6, 0.6, 0.6] }],
  });
  fern.inventory.stone = 4;
  const text = ok(run(sim, "a", "build", { design: "pillar lamp", x, z }));
  assert(text.includes("3 of 3 done") && text.includes("stands as one Object"), text);
  assertEquals(sim.objects.list[0].y, h + 1);
});

Deno.test("playtest 0004: a resumed build finds its work under a Rule's blocks", () => {
  const { sim, fern, x, z, h } = site(8, 8);
  add(sim, "rule", "cobbler", {
    when: { event: "placed", what: "dirt" },
    do: [{ set_block: { at: [0, 1, 0], to: "cobble" } }],
  });
  add(sim, "design", "dirt pad", {
    blocks: { palette: { d: "dirt" }, layers: [["dddd", "dddd"]] },
  });
  fern.inventory.dirt = 8;
  ok(run(sim, "a", "build", { design: "dirt pad", x, z }));
  // Cobble sits on every dirt block; asked again, it still finds the pad at its own height.
  const again = ok(run(sim, "a", "build", { design: "dirt pad", x, z }));
  assert(again.includes(`already complete at x=${x} y=${h + 1}`), again);
});

// ---------------------------------------------------------------- terraform

Deno.test("terraform lowers and raises land, keeping the grass on top and the dirt", () => {
  const { sim, fern, x, z, h } = site(8, 8);
  const w = sim.world;
  const low = ok(
    run(sim, "a", "terraform", { action: "lower", x, z, width: 3, depth: 3, amount: 2 }),
  );
  assert(low.startsWith("Moved 18 blocks of earth") && low.includes("got 18 dirt"), low);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      assertEquals(w.heightAt(x + i, z + j), h - 2);
      assertEquals(w.get(x + i, h - 2, z + j), Block.Grass);
    }
  }
  // The digger ends on the rim, free to walk away.
  ok(run(sim, "a", "walk_to", { x: x + 6, z: z + 6 }));
  err(run(sim, "a", "terraform", { action: "raise", x, z, width: 8, depth: 8 }), "takes 64 dirt");
  const high = ok(
    run(sim, "a", "terraform", { action: "raise", x, z, width: 3, depth: 3, amount: 2 }),
  );
  assert(high.startsWith("Moved 18 blocks") && high.includes("used 18 dirt"), high);
  assertEquals(w.heightAt(x + 1, z + 1), h);
  assertEquals(w.get(x + 1, h, z + 1), Block.Grass);
  assertEquals(w.get(x + 1, h - 1, z + 1), Block.Dirt);
  assertEquals(fern.inventory.dirt, 0);
  err(run(sim, "a", "terraform", { action: "dig", x, z }), 'action is "raise"');
  err(run(sim, "a", "terraform", { action: "lower", x, z, width: 9 }), "width and depth are 1-8");
  err(
    run(sim, "a", "terraform", { action: "lower", x, z, width: 8, depth: 8, amount: 2 }),
    "at most 64",
  );
});

Deno.test("terraform flatten digs high ground, fills low ground, and carries on over calls", () => {
  const { sim, fern, x, z, h } = site(8, 8);
  const w = sim.world;
  fern.inventory.dirt = 8;
  ok(run(sim, "a", "place_block", { x, z, width: 2, block: "dirt", layers: 3 })); // a bump
  ok(run(sim, "a", "terraform", { action: "lower", x: x + 4, z, width: 2 })); // a dip
  const sapling = sim.catalog.byName("oak")!.id;
  sim.props.set(x + 7, z + 7, { design: sapling, planted: GROWN, grow: 0 });
  // Flatten 8 × 8 one higher than the meadow: 6 dug, then 62 filled; more than one call.
  fern.inventory.dirt = 70;
  const first = ok(
    run(sim, "a", "terraform", { action: "flatten", x, z, width: 8, depth: 8, height: h + 1 }),
  );
  assert(first.includes("to go: call terraform flatten again"), first);
  const second = ok(
    run(sim, "a", "terraform", { action: "flatten", x, z, width: 8, depth: 8, height: h + 1 }),
  );
  assert(second.includes("a oak is in the way"), second);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) if (i + j < 14) assertEquals(w.heightAt(x + i, z + j), h + 1);
  }
  assertEquals(w.heightAt(x + 7, z + 7), h, "the tree's ground is left alone");
});

// ---------------------------------------------------------------- crops

Deno.test("agents' crops: a Design, grows_into, drops, and Rules that grow them", () => {
  const { sim, fern, x, z } = site();
  const crop = (look?: string) => ({
    habitat: { on: ["farmland"] },
    parts: [{
      part: "sphere",
      material: "red petals",
      at: [0.5, 0.15, 0.5],
      size: [0.3, 0.3, 0.3],
    }],
    ...(look ? { look } : {}),
  });
  err(
    run(sim, "a", "catalog_add", { kind: "design", name: "odd", content: crop("fancy") }),
    'look is "blades"',
  );
  assert(
    sim.catalog.byName("wheat crop")!.content &&
      (sim.catalog.byName("wheat crop")!.content as { look?: string }).look === "blades",
  );
  ok(
    run(sim, "a", "catalog_add", {
      kind: "material",
      name: "radish seed",
      content: { form: "item", color: "#aa3344" },
    }),
  );
  ok(
    run(sim, "a", "catalog_add", {
      kind: "material",
      name: "radish",
      content: { form: "item", color: "#cc2244" },
    }),
  );
  ok(run(sim, "a", "catalog_add", { kind: "design", name: "radish crop", content: crop() }));
  ok(
    run(sim, "a", "catalog_add", {
      kind: "relation",
      content: { type: "grows_into", from: "radish seed", to: "radish crop", hours: 12 },
    }),
  );
  ok(
    run(sim, "a", "catalog_add", {
      kind: "relation",
      content: { type: "drops", from: "radish crop", to: "radish", count: 2 },
    }),
  );
  const rel = ok(run(sim, "a", "catalog_get", { entry: "radish seed grows_into radish crop" }));
  assert(rel.includes('"radish seed" grows_into "radish crop" in 12 game hours'), rel);
  fern.authored.length = 0; // past this hour's authoring limit
  const rule = (name: string, content: unknown) =>
    run(sim, "a", "catalog_add", { kind: "rule", name, content });
  err(
    rule("bad", { when: { event: "said" }, do: [{ grow: { what: "stone", hours: 1 } }] }),
    "isn't a plant",
  );
  err(
    rule("bad", { when: { event: "said" }, do: [{ grow: { what: "radish crop", hours: 30 } }] }),
    "hours must be",
  );
  ok(
    rule("rain dance", {
      when: { event: "said", what: "rain" },
      do: [{ grow: { what: "radish crop", hours: 6 } }],
    }),
  );
  fern.inventory["radish seed"] = 2;
  ok(run(sim, "a", "till", { x, z, width: 2 }));
  ok(run(sim, "a", "plant", { x, z, width: 2, seed: "radish seed" }));
  const planted = sim.crops.get(z * sim.world.sizeX + x)!;
  const before = sim.cropGrowth(planted);
  ok(run(sim, "a", "say", { text: "come on, rain!" }));
  assert(
    sim.cropGrowth(planted) - before > 0.49,
    `grew from ${before} to ${sim.cropGrowth(planted)}`,
  );
  ok(run(sim, "a", "say", { text: "rain again" }));
  assertEquals(sim.cropGrowth(planted), 1);
  const got = ok(run(sim, "a", "harvest", { x, z, width: 2 }));
  assert(got.startsWith("Harvested 2 tiles") && fern.inventory.radish === 4, got);
});

Deno.test("playtest 0005: no walking into a pit you can't leave, and a way out of one", () => {
  const { sim, fern, x, z, h } = site(8, 8);
  const w = sim.world;
  // A 3-deep, 1-wide pit: hopping in would strand you, so walk_to refuses.
  for (let y = h; y > h - 3; y--) sim.setBlock(x + 3, y, z + 3, 0);
  err(run(sim, "a", "walk_to", { x: x + 3, z: z + 3 }), "You can't find a way");
  // Dropped in anyway (an old save, a Rule), you can build your way out from where you stand.
  fern.x = x + 3.5, fern.z = z + 3.5, fern.y = h - 2;
  for (let i = 0; i < 10; i++) sim.step();
  err(run(sim, "a", "walk_to", { x, z }), "climb 1 block and drop 2");
  fern.inventory.dirt = 3;
  for (let k = 0; k < 3; k++) {
    const feet = Math.floor(fern.y + 0.5);
    ok(run(sim, "a", "place_block", { x: x + 3, z: z + 3, y: feet, block: "dirt" }));
    for (let i = 0; i < 20; i++) sim.step();
  }
  assertEquals(w.heightAt(x + 3, z + 3), h);
  ok(run(sim, "a", "walk_to", { x, z }));
});

Deno.test("playtest 0005: tidy refusals for terraform and grow", () => {
  const { sim } = site();
  err(
    run(sim, "a", "terraform", { action: "raise", x: 10, z: 10, width: 0 }),
    "width and depth are 1-8",
  );
  const rule = (when: unknown, grow: unknown) =>
    run(sim, "a", "catalog_add", { kind: "rule", name: "g", content: { when, do: [{ grow }] } });
  err(rule({ every: 10 }, { what: "wheat crop", hours: 24 }), "from 0.1 to 1");
  err(rule({ event: "said" }, { hours: 2 }), "names a plant");
  ok(rule({ event: "said" }, { what: "wheat crop", hours: 24 }));
});
