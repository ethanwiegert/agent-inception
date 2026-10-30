import { ok as assert } from "node:assert/strict";
import type { Vec3 } from "./catalog.ts";
import { FIRE_LIMITS } from "./fire.ts";
import type { WorldObject } from "./objects.ts";
import { yawQuat } from "./physics.ts";
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

/** A villager beside a flat, clear patch of meadow, `w` × `d` columns, south of them. */
function site(w = 8, d = 8, seed = 1337) {
  const sim = new Sim(seed);
  ok(run(sim, "a", "join", { name: "Fern" }));
  const fern = sim.agents[0];
  const world = sim.world;
  for (let r = 3; r < 80; r++) {
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
      if (flat) return { sim, fern, x: x0, z: z0, h, g: h + 1 };
    }
  }
  throw new Error("no flat site");
}

/** Put an Object in the world with its Design origin at `pos`. */
function spawn(sim: Sim, design: number, pos: Vec3): WorldObject {
  const o: WorldObject = {
    id: sim.objects.nextId(),
    design,
    x: Math.floor(pos[0]),
    y: Math.floor(pos[1]),
    z: Math.floor(pos[2]),
    turn: 0,
    by: "test",
    pos: [...pos],
    rot: yawQuat(0),
    vel: [0, 0, 0],
    spin: [0, 0, 0],
    asleep: false,
  };
  sim.objects.add(o);
  return o;
}

const steps = (sim: Sim, n: number) => {
  for (let i = 0; i < n; i++) sim.step();
};
const byName = (sim: Sim, name: string) => sim.catalog.byName(name)!.id;
const burning = (sim: Sim): number => sim.wildfire.burning.size;
const rule = (sim: Sim, name: string, content: unknown) =>
  run(sim, "a", "catalog_add", { kind: "rule", name, description: "", content });

// ---------------------------------------------------------------- light

Deno.test("a lamp lights the night around it; walls stop the light; use switches it off", () => {
  const { sim, fern, x, z, g } = site();
  sim.setTimeOfDay(0.95);
  const post = spawn(sim, byName(sim, "lantern post"), [x + 3, g, z + 3]);
  steps(sim, 5);
  assert(
    sim.lightAt(x + 3, g, z + 4) > 0.3,
    `lit beside the post: ${sim.lightAt(x + 3, g, z + 4)}`,
  );
  assert(sim.lightAt(x + 3, g, z + 14) < 0.05, "dark far away");
  // A wall two blocks high on the far side of the post shades what's behind it.
  for (let dx = -3; dx <= 3; dx++) {
    for (let y = g; y < g + 4; y++) sim.setBlock(x + 3 + dx, y, z + 5, Block.Cobble);
  }
  const behind = sim.lightAt(x + 3, g, z + 6), front = sim.lightAt(x + 3, g, z + 4);
  assert(behind < front * 0.6, `the wall shades: ${behind} behind, ${front} in front`);
  fern.x = x + 1.5, fern.z = z + 3.5, fern.y = g;
  const seen = ok(run(sim, "a", "look"));
  assert(/Light here: [\d.]+ \(lamplight\)/.test(seen), seen.split("\n")[0]);
  assert(seen.includes("lamp lit"), seen);
  ok(run(sim, "a", "use", { x: x + 3, z: z + 3 }));
  assert(post.devices?.[2]?.on === false, "switched off");
  assert(sim.lightAt(x + 3, g, z + 4) < 0.05, "dark once it's off");
  // By day, the light is daylight whatever the lamp does.
  sim.setTimeOfDay(0.5);
  assert(sim.lightAt(x + 3, g, z + 10) > 0.4, "daylight");
});

Deno.test("glowing blocks light a room unless they're buried; light conditions in Rules", () => {
  const { sim, fern, x, z, g } = site();
  sim.setTimeOfDay(0.95);
  const glass = sim.blocks.byName("lantern glass")!.id;
  sim.setBlock(x + 2, g, z + 2, glass);
  assert(sim.lightAt(x + 2, g, z + 4) > 0.2, "a glowing block lights its neighbours");
  // Bury it.
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) {
    sim.setBlock(x + 2 + dx, g + dy, z + 2 + dz, Block.Stone);
  }
  assert(sim.lightAt(x + 2, g, z + 4) < 0.05, "buried, it lights nothing");
  ok(rule(sim, "night owl", {
    when: { event: "said", what: "hoot" },
    if: { light_below: 0.1 },
    do: [{ say: "Too dark to see!" }],
  }));
  fern.x = x + 6.5, fern.z = z + 6.5, fern.y = g;
  assert(ok(run(sim, "a", "say", { text: "hoot" })).includes("Too dark to see!"), "dark: it fires");
  sim.setTimeOfDay(0.5);
  assert(!ok(run(sim, "a", "say", { text: "hoot" })).includes("Too dark"), "daylight: it doesn't");
  // light conditions need a place.
  err(
    rule(sim, "bad light", { when: { every: 30 }, if: { light_above: 0.5 }, do: [{ say: "x" }] }),
    "needs a villager and a place",
  );
  err(
    rule(sim, "bad light 2", {
      when: { event: "said" },
      if: { light_above: 2 },
      do: [{ say: "x" }],
    }),
    "from 0 to 1",
  );
});

Deno.test("lamplit fields: at night only wheat in the light grows faster", () => {
  const { sim, fern, x, z, g } = site();
  sim.setTimeOfDay(0.9);
  fern.inventory["wheat seeds"] = 16;
  ok(run(sim, "a", "till", { x, z, width: 8, depth: 1 }));
  ok(run(sim, "a", "plant", { x, z, width: 8, depth: 1 }));
  spawn(sim, byName(sim, "lantern post"), [x, g, z + 1]);
  steps(sim, 2);
  const crop = (dx: number) => sim.crops.get(z * sim.world.sizeX + x + dx)!;
  const before = [crop(0).planted, crop(7).planted];
  // The nature Rule fires every half hour of game time.
  steps(sim, Math.ceil(sim.ticksPerDay / 48) + 2);
  assert(crop(0).planted < before[0], "the lamplit crop grew");
  assert(crop(7).planted === before[1], "the dark one didn't");
});

// ---------------------------------------------------------------- fire

Deno.test("fire spreads through planks, burns them away, and never touches grass or stone", () => {
  const { sim, fern, x, z, g } = site();
  for (let dx = 0; dx < 4; dx++) sim.setBlock(x + 2 + dx, g, z + 2, Block.Planks);
  sim.setBlock(x + 6, g, z + 2, Block.Cobble);
  fern.x = x + 0.5, fern.z = z + 0.5, fern.y = g;
  err(run(sim, "a", "ignite", { x: x + 6, z: z + 2 }), "doesn't burn");
  err(run(sim, "a", "ignite", { x: x + 1, z: z + 6 }), "doesn't burn");
  const text = ok(run(sim, "a", "ignite", { x: x + 2, z: z + 2 }));
  assert(text.includes("alight"), text);
  assert(burning(sim) === 1);
  const seen = ok(run(sim, "a", "look"));
  assert(seen.includes("Fire!") && seen.includes("planks at"), seen);
  steps(sim, 20 * 60);
  for (let dx = 0; dx < 4; dx++) {
    assert(sim.world.get(x + 2 + dx, g, z + 2) === Block.Air, `plank ${dx} burnt away`);
  }
  assert(sim.world.get(x + 6, g, z + 2) === Block.Cobble, "cobble stays");
  assert(sim.world.get(x + 2, g - 1, z + 2) === Block.Grass, "grass under it stays");
  assert(burning(sim) === 0, "and the fire is out");
  assert(!sim.world.fire.some((v) => v), "no column is left marked");
});

Deno.test("douse puts fires out; heavy cloud does too; tame flames never spread", () => {
  const { sim, fern, x, z, g } = site();
  for (let dx = 0; dx < 6; dx++) sim.setBlock(x + 1 + dx, g, z + 3, Block.Planks);
  fern.x = x + 0.5, fern.z = z + 0.5, fern.y = g;
  ok(run(sim, "a", "ignite", { x: x + 1, z: z + 3 }));
  steps(sim, 60);
  const text = ok(run(sim, "a", "douse", { x, z: z + 3, width: 8 }));
  assert(text.includes("put out"), text);
  assert(burning(sim) === 0, `all out: ${burning(sim)}`);
  assert(sim.world.get(x + 6, g, z + 3) === Block.Planks, "the far planks were saved");
  err(run(sim, "a", "douse", { x, z }), "Nothing is burning");
  // Rain: a Rule can bring heavy cloud.
  ok(run(sim, "a", "ignite", { x: x + 6, z: z + 3 }));
  sim.weatherOverride = { clouds: 1, until: sim.tick + 20 * 120 };
  steps(sim, 20 * 30);
  assert(burning(sim) === 0, "heavy cloud put it out");
  sim.weatherOverride = null;
  // A torch beside a plank wall burns forever and lights nothing else.
  spawn(sim, byName(sim, "torch"), [x + 3, g, z + 4]);
  steps(sim, 20 * 60);
  assert(burning(sim) === 0, "tame flames don't spread");
  sim.setTimeOfDay(0.95);
  assert(sim.lightAt(x + 3, g, z + 5) > 0.2, "but they shine");
});

Deno.test("one fire burns only so much, and a world only so much at once", () => {
  const { sim, fern, x, z, g } = site(12, 12);
  // A solid plank floor 12 × 12: plenty to burn.
  for (let dz = 0; dz < 12; dz++) {
    for (let dx = 0; dx < 12; dx++) sim.setBlock(x + dx, g - 1, z + dz, Block.Planks);
  }
  fern.x = x - 1.5, fern.z = z - 1.5, fern.y = g;
  ok(run(sim, "a", "ignite", { x: x + 6, z: z + 6 }));
  let most = 0;
  for (let t = 0; t < 20 * 240; t++) {
    sim.step();
    most = Math.max(most, burning(sim));
  }
  let burnt = 0;
  for (let dz = 0; dz < 12; dz++) {
    for (let dx = 0; dx < 12; dx++) if (sim.world.get(x + dx, g - 1, z + dz) === Block.Air) burnt++;
  }
  assert(burnt <= FIRE_LIMITS.perFire, `one fire burnt ${burnt}`);
  assert(burnt > 6, `it did spread: ${burnt}`);
  assert(most <= FIRE_LIMITS.burning);
});

Deno.test("villagers step out of fire and walk round it; animals bolt", () => {
  const { sim, fern, x, z, g } = site();
  // A plank strip across the way, lit, with Fern standing on it.
  for (let dz = 0; dz < 8; dz++) sim.setBlock(x + 4, g - 1, z + dz, Block.Planks);
  fern.x = x + 4.5, fern.z = z + 3.5, fern.y = g;
  sim.wildfire.light(
    { kind: "block", ref: sim.world.index(x + 4, g - 1, z + 3), name: "planks" },
    null,
    false,
  );
  steps(sim, 12);
  assert(Math.floor(fern.x) !== x + 4, `stepped out: ${fern.x}`);
  assert(fern.notes.some((n) => n.includes("stepped out")));
});

Deno.test("Rules: ignited and burned fire for a villager's fire; a Rule's fire doesn't chain", () => {
  const { sim, fern, x, z, g } = site();
  for (let dx = 0; dx < 2; dx++) sim.setBlock(x + 2 + dx, g, z + 2, Block.Planks);
  ok(rule(sim, "fire bell", {
    when: { event: "ignited", what: "planks" },
    do: [{ say: "Fire!" }],
  }));
  ok(rule(sim, "ashes", { when: { event: "burned" }, do: [{ say: "Gone." }] }));
  fern.x = x + 0.5, fern.z = z + 0.5, fern.y = g;
  const text = ok(run(sim, "a", "ignite", { x: x + 2, z: z + 2 }));
  assert(text.includes("Fire!"), text);
  steps(sim, 20 * 60);
  assert(sim.rules.stat(sim.catalog.byName("ashes")!.id).fired >= 1, "burned fired");
  // A Rule that lights fires: what it burns fires no Rules.
  for (let dx = 0; dx < 2; dx++) sim.setBlock(x + 2 + dx, g, z + 5, Block.Planks);
  ok(rule(sim, "spark", {
    when: { event: "said", what: "spark" },
    do: [{ ignite: { at: [0, 0, 0] } }],
  }));
  const before = sim.rules.stat(sim.catalog.byName("ashes")!.id).fired;
  fern.x = x + 2.5, fern.z = z + 4.5, fern.y = g;
  // The event's block is under Fern's feet: put a plank there to catch.
  sim.setBlock(x + 2, g - 1, z + 4, Block.Planks);
  ok(run(sim, "a", "say", { text: "spark" }));
  assert(burning(sim) >= 1, "the Rule lit it");
  steps(sim, 20 * 60);
  assert(sim.rules.stat(sim.catalog.byName("ashes")!.id).fired === before, "no chain");
  ok(rule(sim, "rain dance", { when: { event: "said", what: "rain" }, do: [{ douse: {} }] }));
  err(
    rule(sim, "bad ignite", { when: { every: 30 }, do: [{ ignite: { at: [0, 0, 0] } }] }),
    "needs a villager",
  );
  err(
    rule(sim, "bad douse", { when: { every: 30 }, do: [{ douse: { what: 3 } }] }),
    "name to match",
  );
});

Deno.test("Objects that burn are gone; carried, wet and stone ones don't catch; fire saves", () => {
  const { sim, fern, x, z, g } = site();
  const cart = spawn(sim, byName(sim, "hand cart"), [x + 3, g, z + 3]);
  steps(sim, 40);
  fern.x = x + 0.5, fern.z = z + 0.5, fern.y = g;
  ok(run(sim, "a", "ignite", { x: x + 4, z: z + 3 }));
  assert([...sim.wildfire.burning.values()].some((b) => b.kind === "object"), "the cart burns");
  // Save mid-fire and carry on in the loaded world.
  const loaded = Sim.load(sim.save(0));
  assert(burning(loaded) === burning(sim), "fire saved");
  steps(loaded, 20 * 40);
  assert(!loaded.objects.get(cart.id), "burnt away in the loaded world");
  steps(sim, 20 * 40);
  assert(!sim.objects.get(cart.id), "and in this one");
  err(run(sim, "a", "ignite", { x: x + 6, z: z + 6 }), "doesn't burn");
});

// ---------------------------------------------------------------- signals

Deno.test("a lever on a channel opens a gate tuned to it, within range only", () => {
  const { sim, fern, x, z, g } = site(10, 10);
  const gate = spawn(sim, byName(sim, "garden gate"), [x + 2, g, z + 5]);
  const far = spawn(sim, byName(sim, "garden gate"), [x + 2, g, z + 5 + 30]);
  const lever = spawn(sim, byName(sim, "signal lever"), [x + 6, g, z + 2]);
  steps(sim, 30);
  fern.x = x + 3.5, fern.z = z + 3.5, fern.y = g;
  // The gate isn't on a channel yet: tune it, and the far one too.
  const tuned = ok(run(sim, "a", "use", { x: x + 3, z: z + 5, channel: "Gate" }));
  assert(tuned.includes('channel "gate"'), tuned);
  far.channels = { 3: "gate" };
  const flip = ok(run(sim, "a", "use", { x: x + 6, z: z + 2 }));
  assert(flip.includes("reaches 1 thing"), flip);
  steps(sim, 40);
  assert(Math.abs(gate.joints![0].at! * 180 / Math.PI - 95) < 5, `opened: ${gate.joints![0].at}`);
  assert(!far.joints?.[0]?.target, "the far gate is out of range");
  assert(sim.events.length >= 0);
  ok(run(sim, "a", "use", { x: x + 6, z: z + 2 }));
  steps(sim, 60);
  assert(Math.abs(gate.joints![0].at!) < 0.06, "shut again when the lever's off");
  assert(lever.devices?.[1]?.on === false);
  const seen = ok(run(sim, "a", "look"));
  assert(seen.includes('lever off (channel "gate")'), seen);
  assert(seen.includes('gate shut (channel "gate")'), seen);
  // Untune.
  ok(run(sim, "a", "use", { x: x + 3, z: z + 5, channel: "" }));
  assert(!gate.channels, "back to no channel");
});

Deno.test("a pressure plate is on while someone stands on it", () => {
  const { sim, fern, x, z, g } = site(10, 10);
  assert(fern.name === "Fern");
  const gate = spawn(sim, byName(sim, "garden gate"), [x + 2, g, z + 6]);
  gate.channels = { 3: "gate" };
  const plate = spawn(sim, byName(sim, "pressure plate"), [x + 3, g, z + 3]);
  steps(sim, 30);
  ok(run(sim, "a", "walk_to", { x: x + 3, z: z + 3 }));
  steps(sim, 30);
  assert(plate.devices?.[0]?.on, "pressed");
  assert(gate.joints![0].target! > 1, "the gate is sent open");
  ok(run(sim, "a", "walk_to", { x: x + 6, z: z + 1 }));
  steps(sim, 60);
  assert(!plate.devices?.[0]?.on, "released");
  assert(Math.abs(gate.joints![0].target ?? 0) < 1e-6, "and the gate shuts");
});

Deno.test("Rules send signals (nature lights its lanterns at dusk); the signal trigger hears levers", () => {
  const { sim, fern, x, z, g } = site();
  const post = spawn(sim, byName(sim, "lantern post"), [x + 2, g, z + 2]);
  steps(sim, 5);
  sim.setTimeOfDay(0.27); // after 6:30, nature put the lanterns out
  steps(sim, Math.ceil(sim.ticksPerDay * 0.02));
  assert(post.devices?.[2]?.on === false, "out by day");
  sim.setTimeOfDay(19.2 / 24 - 0.01);
  steps(sim, Math.ceil(sim.ticksPerDay * 0.02));
  assert(post.devices?.[2]?.on !== false, "lit at dusk");
  ok(
    rule(sim, "doorbell", {
      when: { event: "signal", what: "gate on" },
      do: [{ say: "Ding dong" }],
    }),
  );
  spawn(sim, byName(sim, "signal lever"), [x + 5, g, z + 5]);
  fern.x = x + 4.5, fern.z = z + 4.5, fern.y = g;
  const text = ok(run(sim, "a", "use", { x: x + 5, z: z + 5 }));
  assert(text.includes("Ding dong"), text);
  const off = ok(run(sim, "a", "use", { x: x + 5, z: z + 5 }));
  assert(!off.includes("Ding dong"), "only on");
  err(
    rule(sim, "bad signal", { when: { every: 30 }, do: [{ signal: { channel: "x!", on: true } }] }),
    "channel",
  );
  err(
    rule(sim, "bad signal 2", { when: { every: 30 }, do: [{ signal: { channel: "x" } }] }),
    "on is true",
  );
});

Deno.test("channels and devices are checked in Designs", () => {
  const sim = new Sim(1);
  const bad = (parts: unknown[], includes: string, extra = {}) => {
    let msg = "";
    try {
      sim.catalog.add(
        {
          kind: "design",
          name: `bad ${nextCall++}`,
          description: "",
          content: { parts, ...extra },
        },
        "test",
        0,
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg.includes(includes), `expected "${includes}", got "${msg}"`);
  };
  const box = { part: "box", material: "planks", at: [0.5, 0.5, 0.5], size: [1, 1, 1] };
  bad([{ ...box, channel: "gate" }], "only lamps, flames");
  bad([{ ...box, part: "lever", channel: "no!" }], "names a signal channel");
  bad([{ ...box, part: "lamp", channel: "x".repeat(30) }], "names a signal channel");
  bad([{ ...box, part: "lamp", joins: ["main", "x"] }], "only joint parts");
  bad([{ ...box, part: "flame" }], "Plants can't have lamps", {
    habitat: { on: ["grass"], zones: [], share: 1 },
  });
  bad(
    [{ ...box, part: "hinge", joins: ["main", "b"], channel: "x" }, { ...box, piece: "b" }],
    "only lamps",
  );
  const fine = sim.catalog.add(
    {
      kind: "design",
      name: "wired lamp",
      description: "",
      content: {
        parts: [{ ...box, part: "lamp", material: "lantern glass", channel: "Street Lamps" }],
      },
    },
    "test",
    0,
  );
  assert((fine.content as { parts: { channel: string }[] }).parts[0].channel === "street lamps");
});
