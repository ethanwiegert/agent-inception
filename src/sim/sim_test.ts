import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { type CallResult, gameHours, Sim } from "./sim.ts";
import { AnimalAnim, SPECIES } from "./animals.ts";
import { FISH, waterHabitat } from "./fish.ts";
import { GROWN } from "./props.ts";
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
  for (let i = 0; i < gameHours(18); i++) sim.step();
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
  assertEquals(fern.inventory["wheat seeds"], 16 + tilled);
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

Deno.test("agents can set, validate, keep and reset a sprite", () => {
  const sim = new Sim(1);
  run(sim, "s", "join", { name: "Pip" });
  const palette = { h: "#e8b23a", f: "#fc0" };
  assert(run(sim, "s", "set_sprite", { rows: ["hh", "fx"], palette }).isError, "unknown key");
  assert(run(sim, "s", "set_sprite", { rows: ["..", ".."], palette }).isError, "all transparent");
  assert(run(sim, "s", "set_sprite", { rows: ["#".repeat(33)], palette: { "#": "#000" } }).isError);

  const ok = run(sim, "s", "set_sprite", { rows: [".h", "fh."], palette });
  assert(!ok.isError, ok.text);
  assertEquals(sim.agents[0].sprite, {
    width: 3,
    height: 2,
    pixels: [-1, 0xe8b23a, -1, 0xffcc00, 0xe8b23a, -1],
  });
  assertEquals(Sim.load(sim.save(0)).agents[0].sprite, sim.agents[0].sprite);

  run(sim, "s", "set_sprite", { reset: true });
  assertEquals(sim.agents[0].sprite, null);
});

Deno.test("props generate per seed: groves, ground cover, a clearing at spawn", () => {
  const a = new Sim(7), b = new Sim(7);
  assertEquals([...a.props.map], [...b.props.map]);
  const counts = new Map<string, number>();
  for (const p of a.props.map.values()) {
    const name = a.catalog.get(p.design)!.name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const name of ["oak", "birch", "pine", "bush", "poppies", "daisies", "reeds", "rock"]) {
    assert((counts.get(name) ?? 0) > 20, `${name}: ${counts.get(name)}`);
  }
  assert((counts.get("lily pads") ?? 0) + (counts.get("water lily") ?? 0) > 20);
  const c = a.world.sizeX / 2;
  for (let z = c - 8; z <= c + 8; z++) {
    for (let x = c - 8; x <= c + 8; x++) assert(!a.world.propSolid[z * a.world.sizeX + x]);
  }
});

Deno.test("trees block walking and building; saplings grow and survive a save", () => {
  const sim = new Sim(3);
  run(sim, "s", "join", { name: "Rowan" });
  const me = sim.agents[0];
  const x = Math.floor(me.x) + 2, z = Math.floor(me.z);
  sim.setBlock(x, sim.world.heightAt(x, z), z, Block.Grass);
  const planted = run(sim, "s", "plant", { x, z, seed: "oak" });
  assert(planted.text.startsWith("Planted oak on 1 tile"), planted.text);
  assertEquals(me.inventory["oak sapling"], 0);
  assert(run(sim, "s", "plant", { x, z, seed: "oak" }).isError, "no saplings left");

  assert(run(sim, "s", "look").text.includes("t"), "a sapling shows on the map");
  assert(run(sim, "s", "till", { x, z }).text.includes("in the way"));
  assert(run(sim, "s", "place_block", { x, z, block: "dirt" }).isError);
  assert(run(sim, "s", "walk_to", { x, z }).isError, "can't stand in a tree");

  const prop = sim.props.at(x, z)!;
  assert(sim.props.growth(prop, prop.planted + gameHours(48) - 1) < 1);
  assertEquals(sim.props.growth(prop, prop.planted + gameHours(48)), 1);
  const loaded = Sim.load(sim.save(0));
  assertEquals(loaded.props.at(x, z), prop);
  assertEquals(loaded.world.propSolid, sim.world.propSolid);

  // Clearing a generated prop is remembered too.
  const [key, flower] = [...sim.props.map].find(([, p]) =>
    p.planted === GROWN && !sim.props.info(p)!.solid
  )!;
  const fx = key % sim.world.sizeX, fz = Math.floor(key / sim.world.sizeX);
  assert(flower);
  sim.setBlock(fx, sim.world.heightAt(fx, fz) + 1, fz, Block.Stone);
  assertEquals(Sim.load(sim.save(0)).props.at(fx, fz), undefined);
});

Deno.test("herds spawn per seed, wander, sleep at night and follow wheat", () => {
  const sim = new Sim(11);
  const counts = SPECIES.map((_, s) => sim.animals.filter((a) => a.species === s).length);
  assert(counts.every((n) => n > 0), String(counts));
  assertEquals(new Sim(11).animals, sim.animals);
  for (const a of sim.animals) {
    const key = Math.floor(a.z) * sim.world.sizeX + Math.floor(a.x);
    const wet = sim.world.waterTop[key] >= 0;
    assertEquals(wet, SPECIES[a.species].habitat === "water", SPECIES[a.species].name);
  }

  const start = sim.animals.map((a) => [a.x, a.z]);
  sim.setTimeOfDay(0.4);
  for (let i = 0; i < 600; i++) sim.step();
  const moved = sim.animals.filter((a, i) => Math.hypot(a.x - start[i][0], a.z - start[i][1]) > 1);
  assert(moved.length > sim.animals.length / 3, `${moved.length} moved`);
  for (const a of sim.animals) {
    const key = Math.floor(a.z) * sim.world.sizeX + Math.floor(a.x);
    assertEquals(sim.world.waterTop[key] >= 0, SPECIES[a.species].habitat === "water");
    assert(!sim.world.propSolid[key], "never inside a tree");
  }

  sim.setTimeOfDay(0.95);
  for (let i = 0; i < 400; i++) sim.step();
  assert(sim.animals.filter((a) => a.anim === AnimalAnim.Sleep).length > sim.animals.length / 2);

  // A farmer with wheat standing near a sheep draws it in.
  sim.setTimeOfDay(0.4);
  run(sim, "s", "join", { name: "Hazel" });
  const hazel = sim.agents[0];
  hazel.inventory.wheat = 3;
  const sheep = sim.animals.find((a) => a.species === 0)!;
  hazel.x = sheep.x + 4, hazel.z = sheep.z;
  const before = Math.hypot(hazel.x - sheep.x, hazel.z - sheep.z);
  for (let i = 0; i < 200; i++) sim.step();
  assert(Math.hypot(hazel.x - sheep.x, hazel.z - sheep.z) < before - 1);

  assertEquals(Sim.load(sim.save(0)).animals, sim.animals);
  assert(run(sim, "s", "look").text.includes("Animals nearby"));
});

Deno.test("fish schools keep to their water, and casting near one catches fish", () => {
  const sim = new Sim(11);
  assertEquals(new Sim(11).schools, sim.schools);
  assert(FISH.every((_, s) => sim.schools.some((f) => f.species === s)), "every species spawns");
  for (let i = 0; i < 2000; i++) sim.step();
  for (const f of sim.schools) {
    assertEquals(
      waterHabitat(sim.world, Math.floor(f.x), Math.floor(f.z)),
      FISH[f.species].habitat,
    );
  }

  // Stand on the bank next to a river school at dawn and cast a few times.
  run(sim, "s", "join", { name: "Wren" });
  const wren = sim.agents[0];
  const w = sim.world;
  let spot: { f: typeof sim.schools[0]; x: number; z: number } | null = null;
  for (const f of sim.schools.filter((f) => FISH[f.species].habitat === "river")) {
    for (let dz = -3; dz <= 3 && !spot; dz++) {
      for (let dx = -3; dx <= 3 && !spot; dx++) {
        const x = Math.floor(f.x) + dx, z = Math.floor(f.z) + dz;
        if (
          w.heightAt(x, z) >= 0 && w.waterTop[z * w.sizeX + x] < 0 && !w.propSolid[z * w.sizeX + x]
        ) {
          spot = { f, x, z };
        }
      }
    }
    if (spot) break;
  }
  assert(spot, "a river school with a bank");
  wren.x = spot.x + 0.5, wren.z = spot.z + 0.5, wren.y = w.surfaceY(wren.x, wren.z);
  sim.setTimeOfDay(0.25);
  const before = spot.f.count;
  const r = run(sim, "s", "fish", { x: Math.floor(spot.f.x), z: Math.floor(spot.f.z), casts: 5 });
  assert(!r.isError && r.text.includes("caught"), r.text);
  const name = FISH[spot.f.species].name;
  assert((wren.inventory[name] ?? 0) > 0, JSON.stringify(wren.inventory));
  assertEquals(spot.f.count, before - wren.inventory[name]);
  assert(run(sim, "s", "look").text.includes("Fish in view") || spot.f.count === 0);
  assert(run(sim, "s", "fish", { x: spot.x, z: spot.z }).isError, "not water");
});
