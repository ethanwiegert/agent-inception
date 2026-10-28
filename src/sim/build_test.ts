import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { AnimalMode } from "./animals.ts";
import { type CallResult, Sim } from "./sim.ts";
import { callTool } from "./tools.ts";
import { shapeContains } from "./objects.ts";
import { GROWN } from "./props.ts";
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

/** A joined villager beside a flat cleared patch. Patch origin is (x, z). */
function patch(seed = 4, n = 3) {
  const sim = new Sim(seed);
  run(sim, "a", "join", { name: "Fern" });
  const fern = sim.agents[0];
  const x = Math.floor(fern.x) + 1, z = Math.floor(fern.z);
  const y = sim.world.heightAt(x, z);
  for (let dz = 0; dz < n; dz++) {
    for (let dx = 0; dx < n; dx++) {
      const cx = x + dx, cz = z + dz;
      while (sim.world.heightAt(cx, cz) > y) {
        sim.setBlock(cx, sim.world.heightAt(cx, cz), cz, Block.Air);
      }
      let h = sim.world.heightAt(cx, cz);
      while (h >= 0 && h < y) {
        sim.setBlock(cx, h + 1, cz, Block.Dirt);
        h++;
      }
      if (h >= 0) sim.setBlock(cx, y, cz, Block.Grass);
      sim.props.set(cx, cz, null);
    }
  }
  return { sim, fern, x, z, y };
}

Deno.test("part shapes contain their own volume", () => {
  assert(shapeContains("box", 0, 0, 0, 1, 1, 1));
  assert(!shapeContains("box", 0.6, 0, 0, 1, 1, 1));
  assert(shapeContains("sphere", 0.4, 0, 0, 1, 1, 1));
  assert(!shapeContains("sphere", 0.6, 0.6, 0, 1, 1, 1));
  assert(shapeContains("cylinder", 0.4, 0.9, 0, 1, 2, 1));
  assert(!shapeContains("cylinder", 0.6, 0, 0, 1, 2, 1));
  assert(shapeContains("cone", 0, -0.4, 0, 1, 1, 1));
  assert(!shapeContains("cone", 0.4, 0.4, 0, 1, 1, 1));
});

Deno.test("place_block lays any block material at a height, with support", () => {
  const { sim, fern, x, z, y } = patch();
  fern.inventory.dirt = 2;
  fern.inventory.wheat = 1;
  err(run(sim, "a", "place_block", { x, z, block: "wheat" }), "isn't a placeable block");
  err(run(sim, "a", "place_block", { x, z, y: y + 4, block: "dirt" }), "nothing to attach");
  ok(run(sim, "a", "place_block", { x, z, block: "dirt" }));
  assertEquals(sim.world.get(x, y + 1, z), Block.Dirt);
  ok(run(sim, "a", "place_block", { x, z, y: y + 2, block: "dirt" }));
  assertEquals(sim.world.get(x, y + 2, z), Block.Dirt);
  assertEquals(fern.inventory.dirt, 0);

  sim.catalog.add(
    {
      kind: "material",
      name: "basalt",
      content: { color: "#333333", pattern: "stone", density: 3, hardness: 7 },
    },
    "Fern",
    sim.tick,
  );
  fern.inventory.basalt = 1;
  ok(run(sim, "a", "place_block", { x: x + 1, z, block: "basalt" }));
  assertEquals(sim.blocks.name(sim.world.get(x + 1, y + 1, z)), "basalt");

  // A neighbour villager occupies the cell, and a sapling occupies its tile.
  run(sim, "b", "join", { name: "Bob" });
  const bob = sim.agents[1];
  bob.x = x + 2.5, bob.z = z + 0.5, bob.y = y + 1;
  fern.inventory.dirt = 1;
  err(run(sim, "a", "place_block", { x: x + 2, z, y: y + 1, block: "dirt" }), "Bob is standing");
  assert(
    ok(run(sim, "a", "plant", { x: x + 2, z: z + 1, seed: "oak" })).includes("Planted oak on 1"),
  );
  fern.inventory.dirt = 1;
  err(run(sim, "a", "place_block", { x: x + 2, z: z + 1, block: "dirt" }), "oak");
});

Deno.test("break_block digs a chosen height and refuses props", () => {
  const { sim, fern, x, z, y } = patch();
  fern.inventory.dirt = 2;
  ok(run(sim, "a", "place_block", { x, z, block: "dirt" }));
  ok(run(sim, "a", "place_block", { x, z, y: y + 2, block: "dirt" }));
  const dug = ok(run(sim, "a", "break_block", { x, z, y: y + 1 }));
  assert(dug.includes("dirt"), dug);
  assertEquals(sim.world.get(x, y + 1, z), Block.Air);
  assertEquals(sim.world.get(x, y + 2, z), Block.Dirt);

  const flowers = sim.catalog.byName("poppies")!.id;
  sim.props.set(x + 1, z, { design: flowers, planted: GROWN, grow: 0 });
  err(run(sim, "a", "break_block", { x: x + 1, z }), "Use interact");
  err(run(sim, "a", "break_block", { x: x + 1, z, y }), "Use interact");
});

Deno.test("craft follows made_from counts, including takes", () => {
  const { sim, fern } = patch();
  fern.inventory.log = 4;
  fern.inventory.wheat = 4;
  fern.inventory.clay = 1;
  assert(ok(run(sim, "a", "craft", { what: "planks" })).includes("Crafted 4 planks from 1 log"));
  assertEquals(fern.inventory.planks, 4);
  assertEquals(fern.inventory.log, 3);
  assert(
    ok(run(sim, "a", "craft", { what: "planks", count: 3 })).includes(
      "Crafted 12 planks from 3 log",
    ),
  );
  assertEquals(fern.inventory.planks, 16);
  assertEquals(fern.inventory.log, 0);
  assert(ok(run(sim, "a", "craft", { what: "thatch" })).includes("Crafted 1 thatch from 4 wheat"));
  assertEquals(fern.inventory.thatch, 1);
  assertEquals(fern.inventory.wheat, 0);
  ok(run(sim, "a", "craft", { what: "brick" }));
  assertEquals(fern.inventory.brick, 1);
  err(run(sim, "a", "craft", { what: "tiles" }), "You need 1 clay");
  err(run(sim, "a", "craft", { what: "log" }), "It makes: planks");
  const text = ok(run(sim, "a", "catalog_get", { entry: "thatch" }));
  assert(text.includes("takes 4"), text);
  try {
    sim.catalog.add(
      {
        kind: "relation",
        content: { type: "drops", from: "stone", to: "dirt", takes: 2 },
      },
      "Fern",
      sim.tick,
    );
    throw new Error("expected takes to be refused");
  } catch (e) {
    assert(String(e).includes("takes is only for made_from"), String(e));
  }
});

Deno.test("interact chops, digs, picks and collects", () => {
  const { sim, fern, x, z } = patch();
  ok(run(sim, "a", "plant", { x, z, seed: "oak" }));
  assertEquals(fern.inventory["oak sapling"], 0);
  assert(ok(run(sim, "a", "interact", { x, z })).includes("dig up the young oak"));
  assertEquals(fern.inventory["oak sapling"], 1);
  assertEquals(fern.inventory.log ?? 0, 0);
  assertEquals(sim.props.at(x, z), undefined);

  ok(run(sim, "a", "plant", { x, z, seed: "oak" }));
  const growing = sim.props.at(x, z)!;
  growing.planted = sim.tick - growing.grow;
  const chopped = ok(run(sim, "a", "interact", { x, z }));
  assert(chopped.includes("chop the oak"), chopped);
  assert(chopped.includes("3 log"), chopped);
  assertEquals(fern.inventory.log, 3);
  assertEquals(fern.inventory["oak sapling"], 1);
  assertEquals(sim.props.at(x, z), undefined);
  assertEquals(sim.world.propSolid[z * sim.world.sizeX + x], 0);

  const rock = sim.catalog.byName("rock")!.id;
  sim.props.set(x, z, { design: rock, planted: GROWN, grow: 0 });
  assert(ok(run(sim, "a", "interact", { x, z })).includes("2 stone"));
  const flowers = sim.catalog.byName("poppies")!.id;
  sim.props.set(x, z + 1, { design: flowers, planted: GROWN, grow: 0 });
  assert(ok(run(sim, "a", "interact", { x, z: z + 1 })).includes("1 red petals"));

  const sheep = sim.animals.find((a) => a.species === 0)!;
  fern.x = x - 0.5, fern.z = z + 0.5;
  sheep.x = x + 0.5, sheep.z = z + 0.5, sheep.timer = 5000, sheep.mode = AnimalMode.Idle;
  sheep.readyAt = 0;
  assert(ok(run(sim, "a", "interact", { x, z })).includes("1 wool"));
  err(run(sim, "a", "interact", { x, z }), "isn't ready");
  const cow = sim.animals.find((a) => a.species === 1)!;
  fern.x = x + 0.5, fern.z = z + 0.5;
  cow.x = x + 1.5, cow.z = z + 0.5, cow.timer = 5000, cow.mode = AnimalMode.Idle, cow.readyAt = 0;
  assert(ok(run(sim, "a", "interact", { x: x + 1, z })).includes("1 milk"));
  const hen = sim.animals.find((a) => a.species === 2)!;
  fern.x = x + 1.5, fern.z = z + 0.5;
  hen.x = x + 0.5, hen.z = z + 1.5, hen.timer = 5000, hen.mode = AnimalMode.Idle, hen.readyAt = 0;
  assert(ok(run(sim, "a", "interact", { x, z: z + 1 })).includes("1 egg"));
});

Deno.test("build spends inventory, stops at 48 cells, and skips a villager", () => {
  const { sim, fern, x, z, y } = patch();
  fern.inventory.stone = 2;
  fern.inventory.planks = 1;
  const bench = ok(run(sim, "a", "build", { x, z, design: "stone bench" }));
  assert(bench.includes("It's up"), bench);
  assertEquals(sim.world.get(x, y + 1, z), Block.Stone);
  assertEquals(sim.world.get(x + 2, y + 1, z), Block.Stone);
  assertEquals(sim.world.get(x + 1, y + 1, z), Block.Air);
  assertEquals(fern.inventory.stone, 0);
  assertEquals(fern.inventory.planks, 0);
  assertEquals(sim.objects.list.length, 1);
  // The plank top is softer than 3, so the bench does not grow a collision column.
  assertEquals(sim.world.objectSolid, null);
  const look = ok(run(sim, "a", "look", { radius: 4 }));
  assert(look.includes("stone bench"), look);
  assert(look.includes("Objects:"), look);

  const sx = x + 4, sz = z;
  const sy = sim.world.heightAt(sx, sz);
  for (let dz = 0; dz < 3; dz++) {
    for (let dx = 0; dx < 3; dx++) {
      const cx = sx + dx, cz = sz + dz;
      while (sim.world.heightAt(cx, cz) > sy) {
        sim.setBlock(cx, sim.world.heightAt(cx, cz), cz, Block.Air);
      }
      let h = sim.world.heightAt(cx, cz);
      while (h >= 0 && h < sy) {
        sim.setBlock(cx, h + 1, cz, Block.Dirt);
        h++;
      }
      if (h >= 0) sim.setBlock(cx, sy, cz, Block.Grass);
      sim.props.set(cx, cz, null);
    }
  }
  sim.catalog.add(
    {
      kind: "design",
      name: "stone stack",
      content: {
        blocks: {
          palette: { s: "stone" },
          layers: Array.from({ length: 6 }, () => ["sss", "sss", "sss"]),
        },
      },
    },
    "Fern",
    sim.tick,
  );
  fern.inventory.stone = 54;
  const first = ok(run(sim, "a", "build", { x: sx, z: sz, design: "stone stack" }));
  assert(first.includes("Built 48"), first);
  assert(first.includes("6 cells left"), first);
  const second = ok(run(sim, "a", "build", { x: sx, z: sz, design: "stone stack" }));
  assert(second.includes("It's up"), second);
  assertEquals(fern.inventory.stone, 0);

  run(sim, "b", "join", { name: "Bob" });
  const bob = sim.agents[1];
  bob.x = x + 0.5, bob.z = z + 2.5, bob.y = y + 1;
  fern.inventory.dirt = 1;
  sim.catalog.add(
    {
      kind: "design",
      name: "dirt block",
      content: { blocks: { palette: { d: "dirt" }, layers: [["d"]] } },
    },
    "Fern",
    sim.tick,
  );
  const skipped = ok(run(sim, "a", "build", { x, z: z + 2, design: "dirt block" }));
  assert(skipped.includes("Bob is standing"), skipped);
  assertEquals(sim.world.get(x, y, z + 2), Block.Grass);
  assertEquals(sim.world.get(x, y + 1, z + 2), Block.Air);
});

Deno.test("only solid designs block walking, and that survives a save", () => {
  const { sim, fern, x, z, y } = patch();
  sim.catalog.add(
    {
      kind: "design",
      name: "pillar",
      content: {
        parts: [{ part: "box", material: "stone", at: [0.5, 1.25, 0.5], size: [0.6, 2.5, 0.6] }],
      },
    },
    "Fern",
    sim.tick,
  );
  sim.catalog.add(
    {
      kind: "design",
      name: "wool post",
      content: {
        parts: [{ part: "box", material: "wool", at: [0.5, 1.25, 0.5], size: [0.6, 2.5, 0.6] }],
      },
    },
    "Fern",
    sim.tick,
  );
  sim.catalog.add(
    {
      kind: "design",
      name: "slab",
      content: {
        parts: [{ part: "box", material: "stone", at: [0.5, 0.25, 0.5], size: [0.8, 0.5, 0.8] }],
      },
    },
    "Fern",
    sim.tick,
  );
  fern.inventory.stone = 2;
  fern.inventory.wool = 1;
  ok(run(sim, "a", "build", { x, z, design: "pillar" }));
  assert(sim.world.occupies(x, y + 1, z), "the pillar fills the cell a body stands in");
  assert(!sim.world.occupies(x + 1, y + 1, z), "a narrow pillar does not fill the next tile");
  err(run(sim, "a", "walk_to", { x, z }), "can't find a way");

  ok(run(sim, "a", "build", { x: x + 1, z, design: "wool post" }));
  ok(run(sim, "a", "walk_to", { x: x + 1, z }));

  ok(run(sim, "a", "build", { x: x + 2, z, design: "slab" }));
  assertEquals(sim.world.floorBelow(x + 2, z, y + 2), y + 1);
  ok(run(sim, "a", "walk_to", { x: x + 2, z }));

  const loaded = Sim.load(sim.save(0));
  assertEquals(
    loaded.objects.list.map((o) => [o.design, o.x, o.y, o.z]),
    sim.objects.list.map((o) => [o.design, o.x, o.y, o.z]),
  );
  assert(loaded.world.occupies(x, y + 1, z));
  assertEquals(loaded.world.floorBelow(x + 2, z, y + 2), y + 1);
});
