import { ok as assert } from "node:assert/strict";
import { MAX_CELLS } from "./buildtools.ts";
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

/** A villager next to a flat, clear patch of meadow, `w` × `d` columns, east of them. */
function site(w = 4, d = 4) {
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
      // The patch plus a ring around it: level, grass, and nothing standing on it.
      for (let z = z0 - 1; flat && z <= z0 + d; z++) {
        for (let x = x0 - 1; flat && x <= x0 + w; x++) {
          flat = world.heightAt(x, z) === h && world.get(x, h, z) === Block.Grass &&
            world.waterTop[z * world.sizeX + x] < 0 && !sim.props.at(x, z);
        }
      }
      if (flat) return { sim, fern, x: x0, z: z0, h };
    }
  }
  throw new Error("no flat site");
}

Deno.test("place_block lays any held block Material over an area, stacked into a wall", () => {
  const { sim, fern, x, z, h } = site();
  fern.inventory.planks = 10;
  const text = ok(run(sim, "a", "place_block", { x, z, width: 4, block: "Planks", layers: 2 }));
  assert(text.startsWith("Placed 8 planks over x="), text);
  for (let i = 0; i < 4; i++) {
    assert(sim.world.get(x + i, h + 1, z) === Block.Planks);
    assert(sim.world.get(x + i, h + 2, z) === Block.Planks);
  }
  assert(fern.inventory.planks === 2);
  // Running out stops cleanly and says so.
  const short = ok(run(sim, "a", "place_block", { x, z: z + 1, width: 4, block: "planks" }));
  assert(short.startsWith("Placed 2 planks") && short.includes("Ran out of planks"), short);
});

Deno.test("place_block refuses what isn't a held block, cells villagers stand in, and big jobs", () => {
  const { sim, fern, x, z } = site();
  err(run(sim, "a", "place_block", { x, z, block: "stone" }), "You have no stone");
  err(run(sim, "a", "place_block", { x, z, block: "wheat seeds" }), "is an item, not a block");
  err(run(sim, "a", "place_block", { x, z, block: "water" }), "isn't a block Material");
  fern.inventory.stone = 99;
  err(
    run(sim, "a", "place_block", { x, z, width: 4, depth: 4, layers: 4, block: "stone" }),
    `at most ${MAX_CELLS} per call`,
  );
  // Your own spot: you step aside and lay it. Someone else's: refused.
  const fx = Math.floor(fern.x), fz = Math.floor(fern.z);
  assert(ok(run(sim, "a", "place_block", { x: fx, z: fz, block: "stone" })).startsWith("Placed 1"));
  assert(Math.floor(fern.x) !== fx || Math.floor(fern.z) !== fz, "Fern stepped aside");
  ok(run(sim, "b", "join", { name: "Wren" }));
  const wren = sim.agents[1];
  const wx = Math.floor(wren.x), wz = Math.floor(wren.z);
  const onWren = ok(run(sim, "a", "place_block", { x: wx, z: wz, block: "stone" }));
  assert(onWren.includes("Wren is standing there"), onWren);
});

/** Call build until it's done or stops making progress, as an agent would. */
function buildAll(sim: Sim, args: Record<string, unknown>): string {
  let text = "";
  for (let i = 0; i < 4; i++) {
    text = ok(run(sim, "a", "build", args));
    if (!text.includes("To carry on")) break;
  }
  return text;
}

Deno.test("place_block at a height needs something to attach to: bridges grow from a wall", () => {
  const { sim, fern, x, z, h } = site();
  fern.inventory.stone = 10;
  ok(run(sim, "a", "place_block", { x, z, block: "stone", layers: 2 }));
  // Floating in mid air: refused. Against the wall's top block: fine.
  const far = ok(run(sim, "a", "place_block", { x: x + 3, z, y: h + 2, block: "stone" }));
  assert(far.includes("nothing to attach it to"), far);
  ok(run(sim, "a", "place_block", { x: x + 1, z, y: h + 2, block: "stone" }));
  assert(sim.world.get(x + 1, h + 2, z) === Block.Stone);
  assert(sim.world.get(x + 1, h + 1, z) === Block.Air, "a bridge, not a pillar");
});

Deno.test("break_block digs areas and layers, and cuts doorways with y", () => {
  const { sim, fern, x, z, h } = site();
  const text = ok(run(sim, "a", "break_block", { x, z, width: 3, layers: 2 }));
  assert(text.startsWith("Dug 3 grass, 3 dirt over x="), text);
  assert(text.includes("got 6 dirt"), text);
  assert(fern.inventory.dirt === 6);
  for (let i = 0; i < 3; i++) assert(sim.world.heightAt(x + i, z) === h - 2);
  // A wall three high, then a two-high doorway through its bottom.
  ok(run(sim, "a", "place_block", { x, z: z + 2, block: "dirt", layers: 3 }));
  ok(run(sim, "a", "break_block", { x, z: z + 2, y: h + 1, layers: 2 }));
  assert(sim.world.get(x, h + 1, z + 2) === Block.Air && sim.world.get(x, h + 2, z + 2) === 0);
  assert(sim.world.get(x, h + 3, z + 2) === Block.Dirt, "the lintel stays");
  err(run(sim, "a", "break_block", { x, z, width: 16, layers: 4 }), "at most");
});

Deno.test("digging a deep pit leaves the digger on the rim, not trapped at the bottom", () => {
  const { sim, fern, x, z, h } = site(6, 6);
  // Two deep: a drop a villager will step down, but a climb they can't make back up.
  const text = ok(run(sim, "a", "break_block", { x, z, width: 4, depth: 4, layers: 2 }));
  assert(text.startsWith("Dug 16 grass, 16 dirt"), text);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) assert(sim.world.heightAt(x + i, z + j) === h - 2);
  }
  const fx = Math.floor(fern.x), fz = Math.floor(fern.z);
  const inside = fx >= x && fx < x + 4 && fz >= z && fz < z + 4;
  assert(!inside, `Fern ended in the pit at (${fx}, ${fz})`);
  // And can still walk off somewhere else.
  ok(run(sim, "a", "walk_to", { x: x - 3, z: z - 3 }));
});

Deno.test("build lays a Design's blocks over calls, picks up where it stopped, and says what's missing", () => {
  const { sim, fern, x, z, h } = site(6, 6);
  // A 5×5 hut: a stone floor, two rings of plank walls with a doorway, a stone roof.
  const ring = ["ppppp", "p...p", "p...p", "p...p", "pp.pp"];
  ok(run(sim, "a", "catalog_add", {
    kind: "design",
    name: "little hut",
    description: "Stone floor and roof, plank walls, a door to the south.",
    content: {
      blocks: {
        palette: { s: "stone", p: "planks" },
        layers: [Array(5).fill("sssss"), ring, ring, Array(5).fill("sssss")],
      },
      parts: [],
    },
  }));
  err(run(sim, "a", "build", { design: "little hut", x, z }), "short of 50 stone, 30 planks");
  ok(run(sim, "a", "walk_to", { x: x - 1, z: z - 1 })); // a build call has about 45 s of work
  fern.inventory.stone = 50;
  fern.inventory.planks = 10;
  // Everything is checked up front: no half-built hut for want of planks.
  err(run(sim, "a", "build", { design: "little hut", x, z }), "short of 20 planks");
  assert(sim.world.get(x, h + 1, z) !== Block.Stone, "nothing laid");
  fern.inventory.planks = 30;
  const first = ok(run(sim, "a", "build", { design: "little hut", x, z }));
  // At most 48 blocks or ~50 s a call, bottom layer first.
  assert(first.includes(`blocks of "little hut" at x=${x} y=${h + 1} z=${z}`), first);
  assert(first.includes("To carry on"), first);
  assert(sim.world.get(x, h + 1, z) === Block.Stone);
  assert(sim.world.get(x + 2, h + 4, z + 2) === Block.Air, "no roof before the walls");
  // Called again without y, it finds its own floor rather than the new, higher ground.
  const second = buildAll(sim, { design: "little hut", x, z });
  assert(second.includes(`at x=${x} y=${h + 1} z=${z}`), second);
  assert(second.includes("80 of 80 done"), second);
  assert(sim.world.get(x + 2, h + 2, z + 4) === Block.Air, "the doorway is open");
  assert(sim.world.get(x + 2, h + 4, z + 2) === Block.Stone, "the roof is on");
  // The builder closed the roof from outside and can walk away, not stranded up top.
  ok(run(sim, "a", "walk_to", { x: x - 3, z: z - 3 }));
  assert(ok(run(sim, "a", "build", { design: "little hut", x, z })).includes("already complete"));
  err(run(sim, "a", "build", { design: "little hut", x: 500, z: 500 }), "outside the world");
  err(run(sim, "a", "build", { design: "farmer", x, z }), "short of 2 denim");
  err(run(sim, "a", "build", { design: "stone", x, z }), "not a Design");
});

Deno.test("build never shuts the builder inside their own hut or strands them on its roof", () => {
  const { sim, fern, x, z } = site(6, 6);
  ok(run(sim, "a", "catalog_add", {
    kind: "design",
    name: "sod hut",
    description: "Dirt walls two high with a doorway, a dirt roof.",
    content: {
      blocks: {
        palette: { d: "dirt" },
        layers: [
          ["dddd", "d..d", "d..d", "d.dd"],
          ["dddd", "d..d", "d..d", "dddd"],
          ["dddd", "dddd", "dddd", "dddd"],
        ],
      },
      parts: [],
    },
  }));
  fern.inventory.dirt = 39;
  ok(run(sim, "a", "walk_to", { x: x - 1, z: z - 1 }));
  const built = buildAll(sim, { design: "sod hut", x, z });
  assert(built.includes("39 of 39 done"), built);
  ok(run(sim, "a", "walk_to", { x: x - 3, z: z - 3 }));
});

Deno.test("look names built blocks with marks nothing else uses", () => {
  const { sim, fern, x, z } = site();
  fern.inventory.planks = 2;
  fern.inventory.brick = 2;
  ok(run(sim, "a", "place_block", { x, z, block: "planks", width: 2 }));
  ok(run(sim, "a", "place_block", { x, z: z + 1, block: "brick", width: 2 }));
  const text = ok(run(sim, "a", "look", { radius: 12 }));
  const legend = /Blocks: (.*)/.exec(text)?.[1] ?? "";
  assert(legend.includes("P planks") && legend.includes("B brick"), text);
  assert(!text.includes("?"), "no unknown marks");
});
