import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { type CallResult, Sim, WHEAT_GROW_TICKS } from "./sim.ts";
import { callTool } from "./tools.ts";
import { Block } from "./world.ts";

let nextCall = 1;
/** Issue a call and step until it resolves. */
function run(
  sim: Sim,
  session: string,
  tool: string,
  args: Record<string, unknown> = {},
): CallResult {
  const callId = nextCall++;
  callTool(sim, session, tool, args, callId);
  for (let i = 0; i < 20_000; i++) {
    const r = sim.results.find((r) => r.callId === callId);
    if (r) return r;
    sim.step();
  }
  throw new Error(`${tool} never finished`);
}

function farmDay(seed: number) {
  const sim = new Sim(seed);
  run(sim, "s1", "join", { name: "Fern" });
  const fern = sim.agents[0];
  const x = Math.floor(fern.x) + 2, z = Math.floor(fern.z) - 1;
  const till = run(sim, "s1", "till", { x, z, width: 3, depth: 2 });
  const plant = run(sim, "s1", "plant", { x, z, width: 3, depth: 2 });
  for (let i = 0; i < WHEAT_GROW_TICKS; i++) sim.step();
  const harvest = run(sim, "s1", "harvest", { x, z, width: 3, depth: 2 });
  return { sim, fern, till, plant, harvest, x, z };
}

Deno.test("an agent can till, plant and harvest a plot", () => {
  const { sim, fern, till, plant, harvest, x, z } = farmDay(1337);
  assert(!till.isError && !plant.isError && !harvest.isError);
  // Generated terrain may skip a tile or two (cliffs), but most of the plot should work.
  const tilled = Number(/Tilled (\d+)/.exec(till.text)![1]);
  assert(tilled >= 4, till.text);
  assert(harvest.text.startsWith(`Harvested ${tilled} `), harvest.text);
  assertEquals(fern.inventory.wheat, tilled);
  assertEquals(fern.inventory.wheat_seeds, 16 + tilled);
  assertEquals(sim.world.get(x, sim.world.heightAt(x, z), z), Block.Farmland);
});

Deno.test("the sim is deterministic", () => {
  const a = farmDay(99).sim, b = farmDay(99).sim;
  assertEquals(a.save(0), b.save(0));
});

Deno.test("save and load round-trips the world", () => {
  const { sim } = farmDay(5);
  const loaded = Sim.load(sim.save(0));
  assertEquals(loaded.world.blocks, sim.world.blocks);
  assertEquals(loaded.save(0), sim.save(0));
});

Deno.test("tools need a joined agent and validate input", () => {
  const sim = new Sim(1);
  assert(run(sim, "s", "look").isError);
  run(sim, "s", "join", { name: "Moss" });
  assert(run(sim, "s", "look").text.includes("Moss — Day 1"));
  assert(run(sim, "s", "till", { x: 0, z: 0, width: 10, depth: 10 }).isError);
  assert(run(sim, "s", "place_block", { x: 0, z: 0, block: "stone" }).isError);
  assert(run(sim, "s", "walk_to", { x: -5, z: 0 }).isError);
});

Deno.test("rejoining by name reattaches the same body", () => {
  const sim = new Sim(1);
  run(sim, "s1", "join", { name: "Moss" });
  run(sim, "s1", "journal_write", { text: "plant by the cliff" });
  run(sim, "s2", "join", { name: "moss" });
  assertEquals(sim.agents.length, 1);
  assert(run(sim, "s2", "journal_read").text.includes("plant by the cliff"));
});
