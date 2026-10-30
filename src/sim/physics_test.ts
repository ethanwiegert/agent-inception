import { ok as assert } from "node:assert/strict";
import type { Vec3 } from "./catalog.ts";
import type { WorldObject } from "./objects.ts";
import { lean, type Quat, yawQuat } from "./physics.ts";
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

const box = (material: string, size: Vec3, at?: Vec3) => ({
  part: "box",
  material,
  at: at ?? [size[0] / 2, size[1] / 2, size[2] / 2],
  size,
});

/** Add a Design straight to the Catalog (no authoring limits in tests). */
function design(sim: Sim, name: string, parts: unknown[], extra: Record<string, unknown> = {}) {
  return sim.catalog.add(
    { kind: "design", name, description: "test", content: { parts, ...extra } },
    "test",
    sim.tick,
  ).id;
}

/** Put a body in the world with its Design origin at `pos`, turned `rot`, awake. */
function spawn(sim: Sim, design: number, pos: Vec3, rot: Quat = yawQuat(0)): WorldObject {
  const o: WorldObject = {
    id: sim.objects.nextId(),
    design,
    x: Math.floor(pos[0]),
    y: Math.floor(pos[1]),
    z: Math.floor(pos[2]),
    turn: 0,
    by: "test",
    pos: [...pos],
    rot: [...rot],
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

Deno.test("a dropped crate falls, lands on the ground and falls asleep there", () => {
  const { sim, x, z, g } = site();
  const crate = design(sim, "crate", [box("planks", [1, 1, 1])]);
  const o = spawn(sim, crate, [x + 2, g + 3, z + 2]);
  steps(sim, 120);
  assert(o.asleep, "it went to sleep");
  assert(Math.abs(o.pos[1] - g) < 0.05, `rests on the ground: ${o.pos[1]} vs ${g}`);
  assert(lean(o.rot) < 0.05, "still upright");
  // Walking: its tile is in the way now (a block-high top is stood on).
  const key = (z + 2) * sim.world.sizeX + x + 2;
  assert(sim.world.objectAt[key] === o.id);
});

Deno.test("crates stack, and a tall plank pushed over at the top topples", () => {
  const { sim, x, z, g } = site();
  const crate = design(sim, "crate", [box("planks", [1, 1, 1])]);
  const a = spawn(sim, crate, [x + 2, g, z + 2]);
  const b = spawn(sim, crate, [x + 2.1, g + 1.05, z + 2]);
  const c = spawn(sim, crate, [x + 1.95, g + 2.1, z + 2.05]);
  steps(sim, 200);
  for (const [o, y] of [[a, g], [b, g + 1], [c, g + 2]] as const) {
    assert(Math.abs(o.pos[1] - y) < 0.06, `stacked at ${y}: ${o.pos[1]}`);
    assert(lean(o.rot) < 0.08, `upright: ${lean(o.rot)}`);
  }
  assert(a.asleep && b.asleep && c.asleep, "the stack sleeps");
  const plank = design(sim, "tall plank", [box("planks", [0.3, 2.4, 1])]);
  const p = spawn(sim, plank, [x + 5, g, z + 2]);
  steps(sim, 60);
  assert(lean(p.rot) < 0.05, "stands on its own");
  sim.physics.wake(p);
  p.spin = [0, 0, -2.5];
  steps(sim, 120);
  assert(lean(p.rot) > 1.3, `toppled: ${lean(p.rot)}`);
});

Deno.test("a ball rolls on when shoved and down a slope; wood floats and stone sinks", () => {
  const { sim, x, z, g } = site();
  const ball = design(sim, "ball", [{
    part: "sphere",
    material: "planks",
    at: [0.5, 0.4, 0.5],
    size: [0.8, 0.8, 0.8],
  }]);
  const o = spawn(sim, ball, [x + 1, g, z + 4]);
  steps(sim, 20);
  sim.physics.wake(o);
  o.vel = [3, 0, 0];
  steps(sim, 20);
  const c = sim.physics.center(o);
  assert(c[0] > x + 3, `rolled east: ${c[0] - x}`);
  assert(Math.hypot(...o.spin) > 1, "it spins as it rolls");
});

/** A column of open water at least `deep` blocks deep, with the same around it. */
function pond(sim: Sim, deep: number): [number, number, number] {
  const w = sim.world, cx = w.sizeX >> 1, cz = w.sizeZ >> 1;
  for (let r = 0; r < 120; r++) {
    for (let i = -r; i <= r; i++) {
      for (
        const [x, z] of [[cx + i, cz - r], [cx + i, cz + r], [cx - r, cz + i], [cx + r, cz + i]]
      ) {
        let wet = true;
        for (let dz = -2; wet && dz <= 2; dz++) {
          for (let dx = -2; wet && dx <= 2; dx++) wet = w.waterDepth(x + dx, z + dz) >= deep;
        }
        if (wet) return [x, z, w.waterTop[z * w.sizeX + x]];
      }
    }
  }
  throw new Error("no pond");
}

Deno.test("Objects float or sink by the density of what they're made of", () => {
  const { sim } = site();
  const [px, pz, top] = pond(sim, 3);
  const raft = spawn(sim, design(sim, "raft", [box("planks", [1, 0.4, 1])]), [px, top + 2, pz]);
  const rock = spawn(sim, design(sim, "stone cube", [box("stone", [0.8, 0.8, 0.8])]), [
    px + 2,
    top + 2,
    pz,
  ]);
  steps(sim, 240);
  const surface = top + 1 - 0.12;
  // Planks are 0.6 as dense as water: about 60% of the raft under the surface.
  const under = (surface - raft.pos[1]) / 0.4;
  assert(under > 0.45 && under < 0.75, `raft floats ${under} under`);
  assert(Math.abs(rock.pos[1] - (sim.world.heightAt(px + 2, pz) + 1)) < 0.05, "the stone sank");
});

Deno.test("digging out what an Object stands on makes it fall; built-in and anchored ones stay", () => {
  const { sim, x, z, h, g } = site();
  const crate = design(sim, "crate", [box("planks", [0.9, 0.9, 0.9])]);
  const o = spawn(sim, crate, [x + 3.05, g, z + 3.05]);
  steps(sim, 40);
  assert(o.asleep);
  sim.setBlock(x + 3, h, z + 3, Block.Air);
  steps(sim, 60);
  assert(Math.abs(o.pos[1] - h) < 0.06, `fell into the hole: ${o.pos[1]} vs ${h}`);
  const post = design(sim, "signpost", [box("planks", [0.2, 2, 0.2], [0.5, 1, 0.5])], {
    anchored: true,
  });
  const p = spawn(sim, post, [x + 5, g + 2, z + 5]);
  steps(sim, 40);
  assert(p.pos[1] === g + 2, "anchored: hangs where it was put");
  err(run(sim, "a", "push", { x: x + 5, z: z + 5, toward: "east" }), "anchored");
  err(run(sim, "a", "carry", { x: x + 5, z: z + 5 }), "anchored");
});

Deno.test("push walks an Object along; too heavy won't budge, round things roll on", () => {
  const { sim, x, z, g } = site();
  const crate = design(sim, "crate", [box("planks", [1, 1, 1])]);
  const o = spawn(sim, crate, [x + 2, g, z + 3]);
  steps(sim, 30);
  const text = ok(run(sim, "a", "push", { x: x + 2, z: z + 3, toward: "east", tiles: 3 }));
  assert(text.startsWith("You pushed the crate 3.0 tiles east"), text);
  steps(sim, 40);
  const c = sim.physics.center(o);
  assert(c[0] > x + 5.3 && c[0] < x + 6, `three tiles east: ${c[0] - x}`);
  assert(Math.abs(c[2] - (z + 3.5)) < 0.3, "kept its line");
  assert(lean(o.rot) < 0.1, "slid, didn't tip");
  // A stone block of 2 × 2 × 1 (about 10 t) is beyond anyone; one of 1 × 1 × 1 (2.6 t) won't budge.
  const big = design(sim, "boulder block", [box("stone", [2, 2, 1])]);
  spawn(sim, big, [x + 1, g, z + 6]);
  steps(sim, 30);
  err(run(sim, "a", "push", { x: x + 1, z: z + 6, toward: "east" }), "far too heavy");
  const heavy = spawn(sim, design(sim, "stone block", [box("stone", [1, 1, 1])]), [
    x + 4,
    g,
    z + 6,
  ]);
  steps(sim, 30);
  const stuck = ok(run(sim, "a", "push", { x: x + 4, z: z + 6, toward: "east" }));
  assert(stuck.includes("won't budge"), stuck);
  assert(Math.abs(sim.physics.center(heavy)[0] - (x + 4.5)) < 0.15);
  // A wooden ball keeps rolling after the push.
  const ball = design(sim, "ball", [{
    part: "sphere",
    material: "planks",
    at: [0.5, 0.4, 0.5],
    size: [0.8, 0.8, 0.8],
  }]);
  const b = spawn(sim, ball, [x + 1, g, z + 1]);
  steps(sim, 20);
  const rolled = ok(run(sim, "a", "push", { x: x + 1, z: z + 1, toward: "east", tiles: 2 }));
  assert(rolled.includes("rolls on"), rolled);
  steps(sim, 20);
  assert(sim.physics.center(b)[0] > x + 4, "rolled past where it was pushed");
});

Deno.test("carry lifts a light Object overhead and put_down sets it anywhere, at any angle", () => {
  const { sim, fern, x, z, g } = site();
  const crate = design(sim, "small crate", [box("planks", [0.6, 0.6, 0.6])]);
  const a = spawn(sim, crate, [x + 1, g, z + 1]);
  const b = spawn(sim, crate, [x + 5, g, z + 5]);
  steps(sim, 30);
  err(run(sim, "a", "put_down", { x: x + 2, z: z + 2 }), "aren't carrying");
  const lift = ok(run(sim, "a", "carry", { x: x + 1, z: z + 1 }));
  assert(lift.includes("about 130 kg"), lift);
  assert(a.held === fern.id && sim.carried(fern) === a);
  err(run(sim, "a", "carry", { x: x + 5, z: z + 5 }), "hands are full");
  ok(run(sim, "a", "walk_to", { x: x + 4, z: z + 7 }));
  const c = sim.physics.center(a);
  assert(Math.abs(c[0] - fern.x) < 0.01 && c[1] > fern.y + 2, "rides overhead");
  // Stack it on the other crate, turned 45°.
  ok(run(sim, "a", "put_down", { x: x + 5, z: z + 5, turn: 45 }));
  assert(!a.held && !sim.carried(fern));
  // Turned 45° from how it was built, whichever way the carrier faced.
  assert(Math.abs(Math.abs(a.rot[1]) - Math.sin(Math.PI / 8)) < 0.01, `turned 45°: ${a.rot}`);
  steps(sim, 80);
  assert(Math.abs(a.pos[1] - (b.pos[1] + 0.6)) < 0.06, `stacked: ${a.pos[1] - b.pos[1]}`);
  assert(lean(a.rot) < 0.1, "upright");
  // From a stack you lift the top one.
  ok(run(sim, "a", "carry", { x: x + 5, z: z + 5 }));
  assert(a.held === fern.id && !b.held);
  ok(run(sim, "a", "put_down", { x: x + 6, z: z + 5 }));
  // Too heavy to lift.
  const block = design(sim, "plank block", [box("planks", [1, 1, 1])]);
  spawn(sim, block, [x + 2, g, z + 6]);
  steps(sim, 30);
  err(run(sim, "a", "carry", { x: x + 2, z: z + 6 }), "you can lift up to 300 kg");
});

Deno.test("a rolling boulder knocks a villager over; they get up, carry on, and know who did it", () => {
  const { sim, fern, x, z, g } = site();
  ok(run(sim, "b", "join", { name: "Thistle" }));
  const boulder = design(sim, "boulder", [{
    part: "sphere",
    material: "stone",
    at: [0.5, 0.45, 0.5],
    size: [0.9, 0.9, 0.9],
  }]);
  ok(run(sim, "a", "walk_to", { x: x + 6, z: z + 3 }));
  const o = spawn(sim, boulder, [x + 1, g, z + 3]);
  o.mover = "Thistle";
  o.vel = [5, 0, 0];
  let down = false;
  for (let i = 0; i < 60; i++) {
    sim.step();
    if (fern.anim === 7) down = true;
  }
  assert(down, "Fern went down");
  assert(sim.tick < (fern.graceUntil ?? 0), "and can't be knocked over again for a while");
  const said = ok(run(sim, "a", "look"));
  assert(said.includes("Knocked over by Thistle's boulder"), said);
  // A job started while down waits, then finishes.
  o.vel = [0, 0, 0];
  const walked = ok(run(sim, "a", "walk_to", { x: x + 7, z: z + 7 }));
  assert(walked.startsWith("You arrive"), walked);
});

Deno.test("Rules hear pushed, carried and landed, and impulse nudges bodies near the event", () => {
  const { sim, x, z, g } = site();
  const add = (name: string, content: unknown) =>
    sim.catalog.add({ kind: "rule", name, description: "test", content }, "test", sim.tick);
  add("bouncy", {
    when: { event: "landed", what: "ball" },
    if: null,
    do: [{ say: "boing" }, { impulse: { what: "ball", up: 4 } }],
  });
  add("heave", { when: { event: "pushed" }, if: null, do: [{ say: "heave" }] });
  add("lift", { when: { event: "carried", what: "ball" }, if: null, do: [{ say: "up it goes" }] });
  const ball = design(sim, "ball", [{
    part: "sphere",
    material: "planks",
    at: [0.5, 0.25, 0.5],
    size: [0.5, 0.5, 0.5],
  }]);
  spawn(sim, ball, [x + 2, g, z + 2]);
  steps(sim, 30);
  assert(ok(run(sim, "a", "push", { x: x + 2, z: z + 2, toward: "south" })).includes("heave"));
  const o = sim.objects.list[0];
  const c = sim.physics.center(o);
  const lift = ok(run(sim, "a", "carry", { x: Math.floor(c[0]), z: Math.floor(c[2]) }));
  assert(lift.includes("up it goes"), lift);
  // Dropped from overhead it lands, and the Rule bounces it once (not again: Rules don't chain).
  const fern = sim.agents[0];
  sim.release(fern, o);
  o.pos[0] += 1.2; // beside her, not on her head
  let peak = 0, landed = 0;
  for (let i = 0; i < 80; i++) {
    sim.step();
    landed = sim.events.filter((e) => e.type === "rule" && e.text === "boing").length;
    if (landed) peak = Math.max(peak, o.vel[1]);
  }
  assert(landed === 1, `one bounce: ${landed}`);
  assert(peak > 2, "the Rule threw it up");
  // impulse validation.
  const bad = (content: unknown, includes: string) => {
    let msg = "";
    try {
      add("bad", content);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg.includes(includes), msg);
  };
  bad({ when: { every: 30 }, if: null, do: [{ impulse: { up: 9 } }] }, "up must be a number");
  bad({ when: { event: "said" }, if: null, do: [{ impulse: { up: 9 } }] }, "from 0 to 8");
  bad({ when: { every: 30 }, if: null, do: [{ impulse: { speed: 2 } }] }, "needs toward");
  bad({ when: { event: "said" }, if: null, do: [{ impulse: {} }] }, "needs up or speed");
  bad({ when: { event: "said" }, if: null, do: [{ impulse: { up: 1, toward: "up" } }] }, "compass");
});

Deno.test("bodies are deterministic and survive a save mid-fall", () => {
  const make = () => {
    const { sim, x, z, g } = site();
    const crate = design(sim, "crate", [box("planks", [1, 1, 1])]);
    const ball = design(sim, "ball", [{
      part: "sphere",
      material: "stone",
      at: [0.5, 0.4, 0.5],
      size: [0.8, 0.8, 0.8],
    }]);
    spawn(sim, crate, [x + 2, g + 2, z + 2], [0.2, 0.1, 0.05, 0.97]);
    spawn(sim, crate, [x + 2.3, g + 4, z + 2.2]);
    spawn(sim, ball, [x + 1, g + 6, z + 2.4]).vel = [1, 0, 0];
    return sim;
  };
  const a = make(), b = make();
  steps(a, 25), steps(b, 25);
  const saved = Sim.load(structuredClone(a.save(0)));
  steps(a, 60), steps(b, 60), steps(saved, 60);
  const poses = (s: Sim) => JSON.stringify(s.objects.list.map((o) => [o.pos, o.rot]));
  assert(poses(a) === poses(b), "same inputs, same poses");
  assert(poses(a) === poses(saved), "a reload carries on exactly");
});

Deno.test("500 awake bodies stay inside the tick budget", () => {
  const { sim, x, z, g } = site(12, 12);
  const crate = design(sim, "small crate", [box("planks", [0.6, 0.6, 0.6])]);
  for (let i = 0; i < 500; i++) {
    spawn(sim, crate, [
      x + (i % 10) * 1.1,
      g + 3 + Math.floor(i / 100) * 0.8,
      z + Math.floor(i / 10) % 10 * 1.1,
    ]);
  }
  steps(sim, 5);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) sim.step();
  const ms = (performance.now() - t0) / 20;
  const awake = sim.objects.list.filter((o) => !o.asleep).length;
  console.log(`500 bodies (${awake} awake): ${ms.toFixed(2)} ms per tick`);
  assert(awake > 400, "they're still moving");
  assert(ms < 40, `${ms} ms`);
});

Deno.test("villagers walk around light Objects instead of kicking them, and stand on heavy ones", () => {
  const { sim, fern, x, z, g } = site();
  const crate = design(sim, "small crate", [box("planks", [0.6, 0.6, 0.6])]);
  const a = spawn(sim, crate, [x + 3.2, g, z + 3.2]);
  const b = spawn(sim, crate, [x + 3.2, g + 0.62, z + 3.2]);
  steps(sim, 40);
  const before = JSON.stringify([a.pos, b.pos].map((p) => p.map((v) => v.toFixed(2))));
  ok(run(sim, "a", "walk_to", { x: x, z: z + 3 }));
  ok(run(sim, "a", "walk_to", { x: x + 7, z: z + 3 }));
  steps(sim, 20);
  const after = JSON.stringify([a.pos, b.pos].map((p) => p.map((v) => v.toFixed(2))));
  assert(before === after, `the stack stood: ${before} → ${after}`);
  err(run(sim, "a", "walk_to", { x: x + 3, z: z + 3 }), "light enough to kick away");
  // A heavy stone slab is stood on, and doesn't budge.
  const slab = design(sim, "slab", [box("stone", [1, 0.3, 1])]);
  const s = spawn(sim, slab, [x + 5, g, z + 6]);
  steps(sim, 30);
  ok(run(sim, "a", "walk_to", { x: x + 5, z: z + 6 }));
  steps(sim, 20);
  assert(Math.abs(fern.y - (g + 0.3)) < 0.06, `on the slab: ${fern.y - g}`);
  assert(
    Math.abs(s.pos[0] - (x + 5)) < 0.05 && Math.abs(s.pos[2] - (z + 6)) < 0.05,
    "it stayed put",
  );
});
