import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { AnimalMode } from "./animals.ts";
import { Block, BlockRegistry, BUILTIN_BLOCKS, FIRST_CUSTOM_BLOCK } from "./blocks.ts";
import { Catalog, type DesignContent, type MaterialContent } from "./catalog.ts";
import { plantInfo } from "./props.ts";
import { type CallResult, gameHours, Sim } from "./sim.ts";
import { callTool } from "./tools.ts";

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
/** Add straight to the Catalog, skipping the rate limit. */
const add = (sim: Sim, kind: string, name: string, content: unknown) =>
  sim.catalog.add({ kind, name, content }, "Fern", sim.tick);
const bad = (sim: Sim, kind: string, content: unknown, includes: string) => {
  try {
    add(sim, kind, `bad ${kind} ${nextCall++}`, content);
  } catch (e) {
    assert(String(e).includes(includes), String(e));
    return;
  }
  throw new Error(`expected "${includes}"`);
};

/** A joined villager on a flat 3×3 patch of grass next to them, cleared of plants. */
function farm(seed = 7) {
  const sim = new Sim(seed);
  run(sim, "a", "join", { name: "Fern" });
  const fern = sim.agents[0];
  const x = Math.floor(fern.x) + 2, z = Math.floor(fern.z);
  const y = sim.world.heightAt(x, z);
  for (let dz = 0; dz < 3; dz++) {
    for (let dx = 0; dx < 3; dx++) {
      while (sim.world.heightAt(x + dx, z + dz) > y) {
        sim.setBlock(x + dx, sim.world.heightAt(x + dx, z + dz), z + dz, Block.Air);
      }
      sim.setBlock(x + dx, y, z + dz, Block.Grass);
      sim.props.set(x + dx, z + dz, null);
    }
  }
  return { sim, fern, x, z };
}

// ---------------------------------------------------------------- materials and blocks

Deno.test("built-in blocks, items and looks are nature's Materials", () => {
  const c = Catalog.create();
  for (const name of BUILTIN_BLOCKS.slice(1)) {
    const m = c.byName(name)!;
    assertEquals([m.kind, m.author], ["material", "nature"], name);
  }
  assertEquals((c.byName("water")!.content as MaterialContent).form, "liquid");
  for (const item of ["wheat", "wheat seeds", "oak sapling", "wool", "milk", "egg", "trout"]) {
    assertEquals((c.byName(item)!.content as MaterialContent).form, "item", item);
  }
  for (const d of ["oak", "birch", "pine", "bush", "poppies", "reeds", "rock", "farmer", "sheep"]) {
    assertEquals(c.byName(d)?.kind, "design", d);
  }
  // Every Design names live Materials and Parts.
  for (const e of c.entries.filter((e) => e.kind === "design")) {
    for (const p of (e.content as DesignContent).parts) {
      assert(c.byName(p.material)?.kind === "material", `${e.name}: ${p.material}`);
    }
  }
});

Deno.test("block ids follow the Catalog: built-ins fixed, new block Materials appended", () => {
  const sim = new Sim(7);
  const reg = sim.blocks;
  BUILTIN_BLOCKS.forEach((name, id) => assertEquals(reg.byName(name)?.id, id, name));
  assertEquals(reg.byName("wheat"), undefined, "items aren't blocks");
  assertEquals(reg.get(Block.Brick)!.color, 0xa4523a);
  const v = reg.version;
  add(sim, "material", "basalt", { color: "#333333", pattern: "stone", density: 3, hardness: 7 });
  add(sim, "material", "honey", { form: "item", color: "#e8a020" });
  // Nature's own extra blocks (fieldstone, lantern glass) come first, then villagers' in Catalog
  // order.
  assertEquals(sim.blocks.byName("fieldstone")?.id, FIRST_CUSTOM_BLOCK);
  assertEquals(sim.blocks.byName("lantern glass")?.id, FIRST_CUSTOM_BLOCK + 1);
  assertEquals(sim.blocks.byName("basalt")?.id, FIRST_CUSTOM_BLOCK + 2);
  assertEquals(sim.blocks.byName("honey"), undefined);
  assert(sim.blocks.version > v);
  // A page mirroring the same Catalog gets the same ids.
  const page = new BlockRegistry().sync(Catalog.load(sim.catalog.save()));
  assertEquals(page.byName("basalt")?.id, FIRST_CUSTOM_BLOCK + 2);
  bad(sim, "material", { form: "liquid", color: "#336699" }, "Only nature makes liquids");
  bad(sim, "material", { form: "gas", color: "#336699" }, "form must be");
});

// ---------------------------------------------------------------- drops

Deno.test("digging gives what a block drops, or the block itself, by hardness", () => {
  const { sim, fern, x, z } = farm();
  ok(run(sim, "a", "break_block", { x, z }));
  assertEquals(fern.inventory.dirt, 1, "grass drops dirt");
  const y = sim.world.heightAt(x, z);
  sim.setBlock(x, y, z, Block.Sand);
  assert(ok(run(sim, "a", "break_block", { x, z })).includes("got 1 sand"));
  sim.setBlock(x, sim.world.heightAt(x, z), z, Block.Stone);
  const t0 = sim.tick;
  ok(run(sim, "a", "break_block", { x, z }));
  assertEquals(fern.inventory.stone, 1);
  assert(sim.tick - t0 >= 40, "stone is slow to dig");
});

Deno.test("harvests follow drops Relations and replacements", () => {
  const { sim, fern, x, z } = farm();
  ok(run(sim, "a", "till", { x, z, width: 2 }));
  ok(run(sim, "a", "plant", { x, z, width: 2, seed: "wheat" }));
  // Golden wheat replaces wheat by a passed proposal: harvests give it instead.
  add(sim, "material", "golden wheat", { form: "item", color: "#ffd700", burns: true });
  ok(run(sim, "a", "propose", {
    entry: "wheat",
    action: "replace",
    replacement: "golden wheat",
    reason: "shinier",
  }));
  for (let i = 0; i < gameHours(18); i++) sim.step();
  assert(ok(run(sim, "a", "harvest", { x, z, width: 2 })).includes("Harvested 2 tiles"));
  assertEquals(fern.inventory["golden wheat"], 2);
  assertEquals(fern.inventory.wheat, undefined);
  assertEquals(fern.inventory["wheat seeds"], 16 - 2 + 4);
});

Deno.test("fish are Materials; a retired fish no longer bites", () => {
  const sim = new Sim(7);
  const trout = sim.catalog.byName("trout")!;
  assertEquals(trout.kind, "material");
  trout.retired = true;
  assertEquals(sim.produce("trout"), null);
});

// ---------------------------------------------------------------- planting and growth

Deno.test("plant takes a seed, a sapling or the plant's name", () => {
  const { sim, fern, x, z } = farm();
  ok(run(sim, "a", "till", { x, z, width: 3 }));
  assert(ok(run(sim, "a", "plant", { x, z })).startsWith("Planted wheat crop on 1 tile"));
  ok(run(sim, "a", "plant", { x: x + 1, z, seed: "wheat seeds" }));
  ok(run(sim, "a", "plant", { x: x + 2, z, seed: "wheat_seeds" }));
  assertEquals(fern.inventory["wheat seeds"], 13);
  assertEquals(
    sim.crops.get(z * sim.world.sizeX + x)!.design,
    sim.catalog.byName("wheat crop")!.id,
  );
  assert(ok(run(sim, "a", "plant", { x, z: z + 1, seed: "birch" })).startsWith("Planted birch"));
  assert(ok(run(sim, "a", "plant", { x, z: z + 2, seed: "pine sapling" })).includes("pine"));
  err(run(sim, "a", "plant", { x: x + 1, z: z + 1, seed: "oak tree" }), "You can plant:");
  err(run(sim, "a", "plant", { x: x + 1, z: z + 1, seed: "mango" }), "nothing to plant");
  // Wheat needs farmland and trees need dry ground.
  const wheat = ok(run(sim, "a", "plant", { x: x + 1, z: z + 1 }));
  assert(wheat.includes("grows on farmland, not grass"), wheat);
  ok(run(sim, "a", "plant", { x: x + 1, z: z + 1, seed: "oak" }));
  const tree = ok(run(sim, "a", "plant", { x, z, seed: "oak" }));
  assert(tree.includes("oak grows on grass or dirt, not farmland"), tree);
});

Deno.test("an agent-made crop grows on its own schedule and drops what it says", () => {
  const { sim, fern, x, z } = farm();
  add(sim, "material", "radish", { form: "item", color: "#c0304a" });
  add(sim, "material", "radish seeds", { form: "item", color: "#9a7050" });
  add(sim, "design", "radish crop", {
    habitat: { on: ["farmland"] },
    parts: [{ part: "sphere", material: "radish", at: [0.5, 0.1, 0.5], size: [0.2, 0.2, 0.2] }],
  });
  add(sim, "relation", "", {
    type: "grows_into",
    from: "radish seeds",
    to: "radish crop",
    hours: 6,
  });
  add(sim, "relation", "", { type: "drops", from: "radish crop", to: "radish", count: 3 });
  fern.inventory["radish seeds"] = 2;
  ok(run(sim, "a", "till", { x, z }));
  ok(run(sim, "a", "plant", { x, z, seed: "radish" }));
  const crop = sim.crops.get(z * sim.world.sizeX + x)!;
  assertEquals(crop.grow, gameHours(6));
  // A faster fork later doesn't change crops already in the ground.
  add(sim, "relation", "", { type: "made_from", from: "radish", to: "radish seeds" });
  for (let i = 0; i < gameHours(6); i++) sim.step();
  assert(ok(run(sim, "a", "look")).includes("1 ripe"));
  ok(run(sim, "a", "harvest", { x, z }));
  assertEquals(fern.inventory.radish, 3);
  // Survives save and load.
  ok(run(sim, "a", "plant", { x, z, seed: "radish seeds" }));
  const loaded = Sim.load(sim.save(0));
  assertEquals(loaded.crops.get(z * sim.world.sizeX + x), sim.crops.get(z * sim.world.sizeX + x));
});

Deno.test("growth Relations and habitats are checked", () => {
  const sim = new Sim(7);
  bad(sim, "relation", { type: "grows_into", from: "oak", to: "oak sapling" }, "grows_into goes");
  bad(sim, "relation", { type: "grows_into", from: "wool", to: "stone bench" }, "with a habitat");
  bad(sim, "relation", { type: "drops", from: "oak", to: "log", hours: 2 }, "only for grows_into");
  bad(
    sim,
    "relation",
    { type: "grows_into", from: "wool", to: "oak", hours: 9999 },
    "hours must be",
  );
  const leafy = { part: "sphere", material: "leaves", at: [0.5, 1, 0.5], size: [1, 1, 1] };
  bad(sim, "design", { parts: [leafy], habitat: { on: ["wool"] } }, "isn't ground");
  bad(sim, "design", { parts: [leafy], habitat: { on: [] } }, "lists 1-8");
  bad(
    sim,
    "design",
    { parts: [leafy], habitat: { on: ["grass"], zones: ["moon"] } },
    "isn't a zone",
  );
  bad(sim, "design", { parts: [leafy], habitat: { on: ["grass"], soil: 1 } }, "unknown field");
});

// ---------------------------------------------------------------- designs

Deno.test("design parts take cones, tilt, roles, joints and a map mark", () => {
  const sim = new Sim(7);
  const arm = {
    part: "cone",
    material: "skin",
    at: [0.5, 1, 0.5],
    size: [0.1, 0.5, 0.1],
    tilt: 30,
    role: "left_arm",
  };
  const e = add(sim, "design", "statue", {
    parts: [arm],
    joints: { "left arm": [0.5, 1.25, 0.5] },
    mark: "S",
  });
  const d = e.content as DesignContent;
  assertEquals(d.parts[0].role, "left arm");
  assertEquals(d.parts[0].tilt, 30);
  assertEquals(d.mark, "S");
  bad(sim, "design", { parts: [{ ...arm, role: "wing" }] }, "role must be one of");
  bad(sim, "design", { parts: [arm], joints: { head: [0, 0, 0] } }, 'no part has role "head"');
  bad(sim, "design", { parts: [arm], mark: "7" }, "mark is one character");
  bad(sim, "design", { parts: [arm], mark: "ab" }, "mark is one character");
  bad(sim, "design", { parts: [{ ...arm, tilt: 400 }] }, "tilt must be");
  bad(
    sim,
    "design",
    { blocks: { palette: { w: "wool" }, layers: [["w"]] } },
    "isn't a block material",
  );
});

// ---------------------------------------------------------------- the world from the Catalog

Deno.test("worldgen grows only nature's Designs that have a zone", () => {
  const sim = new Sim(7);
  const used = new Set([...sim.props.map.values()].map((p) => sim.catalog.get(p.design)!.name));
  for (const name of used) {
    const h = (sim.catalog.byName(name)!.content as DesignContent).habitat;
    assert(h && h.zones.length, name);
  }
  for (const name of ["poppies", "buttercups", "daisies", "violets", "water lily"]) {
    assert(used.has(name), name);
  }
  assert(!used.has("wheat crop"));
  // Flowers come in patches: neighbours usually share a kind.
  const flowers = new Set(["poppies", "buttercups", "daisies", "violets"]);
  let same = 0, pairs = 0;
  for (const [key, p] of sim.props.map) {
    const n = sim.props.map.get(key + 1);
    const a = sim.catalog.get(p.design)!.name, b = n && sim.catalog.get(n.design)!.name;
    if (!flowers.has(a) || !b || !flowers.has(b)) continue;
    pairs++;
    if (a === b) same++;
  }
  assert(pairs > 50 && same / pairs > 0.7, `${same}/${pairs}`);
});

Deno.test("animals follow whoever carries their food", () => {
  const sim = new Sim(11);
  sim.setTimeOfDay(0.4);
  run(sim, "s", "join", { name: "Hazel" });
  const hazel = sim.agents[0];
  hazel.inventory = { trout: 3 };
  const sheep = sim.animals.find((a) => a.species === 0)!;
  /** Stand 4 tiles off for 10 seconds: does the sheep come after her? */
  const follows = () => {
    hazel.x = sheep.x + 4, hazel.z = sheep.z;
    let following = false;
    for (let i = 0; i < 200; i++) sim.step(), following ||= sheep.mode === AnimalMode.Follow;
    return following;
  };
  assertEquals(sim.foodFor(0), ["wheat"]);
  assert(!follows(), "trout isn't sheep food");
  add(sim, "relation", "", { type: "is_food_for", from: "trout", to: "sheep" });
  assertEquals(sim.foodFor(0), ["wheat", "trout"]);
  assert(follows(), "now it is");
});

Deno.test("a plant named with a leading digit is not marked as a villager", () => {
  const sim = new Sim(1);
  const e = add(sim, "design", "2 clover", {
    habitat: { on: ["grass"] },
    parts: [{ part: "sphere", material: "wool", at: [0.5, 0.1, 0.5], size: [0.2, 0.2, 0.2] }],
  });
  assertEquals(plantInfo(sim.catalog, e.id)!.mark, "c");
});

Deno.test("replacing a wheat design recolors the crop; a non-plant replacement stops planting", () => {
  const { sim, x, z } = farm();
  ok(run(sim, "a", "till", { x, z }));
  ok(run(sim, "a", "plant", { x, z }));
  const id = sim.crops.get(z * sim.world.sizeX + x)!.design;
  const [stalk0, ripe0] = sim.cropColors(id);
  add(sim, "material", "ink stalk", { form: "item", color: "#102030" });
  add(sim, "material", "black grain", { form: "item", color: "#010203" });
  add(sim, "design", "black wheat", {
    habitat: { on: ["farmland"] },
    parts: [{
      part: "cylinder",
      material: "ink stalk",
      at: [0.5, 0.4, 0.5],
      size: [0.04, 0.8, 0.04],
    }],
  });
  add(sim, "relation", "", { type: "drops", from: "black wheat", to: "black grain" });
  ok(run(sim, "a", "propose", {
    entry: "wheat crop",
    action: "replace",
    replacement: "black wheat",
    reason: "a darker field",
  }));
  const [stalk1, ripe1] = sim.cropColors(id);
  assertEquals(stalk1, 0x102030);
  assertEquals(ripe1, 0x010203);
  assert(stalk0 !== stalk1 && ripe0 !== ripe1);
  // A body has no habitat. Seeds then fail with that reason, not "retired".
  add(sim, "design", "wheat scarecrow", {
    parts: [{ part: "box", material: "straw", at: [0.5, 0.5, 0.5], size: [0.2, 1, 0.2] }],
  });
  ok(run(sim, "a", "propose", {
    entry: "black wheat",
    action: "replace",
    replacement: "wheat scarecrow",
    reason: "try a body in the field",
  }));
  err(run(sim, "a", "plant", { x: x + 1, z }), "isn't a plant (no habitat)");
});

Deno.test("look names the plants in view from their Designs", () => {
  const sim = new Sim(7);
  run(sim, "a", "join", { name: "Fern" });
  const fern = sim.agents[0];
  // Walk to the nearest tree and look around.
  const [key] = [...sim.props.map].find(([, p]) => sim.catalog.get(p.design)!.name === "oak")!;
  fern.x = (key % sim.world.sizeX) + 2.5, fern.z = Math.floor(key / sim.world.sizeX) + 0.5;
  const text = ok(run(sim, "a", "look", { radius: 8 }));
  assert(/Plants: .*T [a-z/]*oak/.test(text), text);
});
