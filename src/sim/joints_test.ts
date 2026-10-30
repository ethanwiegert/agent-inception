import { ok as assert } from "node:assert/strict";
import type { RelationContent, Vec3 } from "./catalog.ts";
import { pinAt } from "./jointtools.ts";
import type { WorldObject } from "./objects.ts";
import { type BodyState, lean, type Quat, quatMatrix, yawQuat } from "./physics.ts";
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

/** Add a Design straight to the Catalog (no authoring limits in tests). */
function design(sim: Sim, name: string, parts: unknown[], extra: Record<string, unknown> = {}) {
  return sim.catalog.add(
    { kind: "design", name, description: "test", content: { parts, ...extra } },
    "test",
    sim.tick,
  ).id;
}

/** Put an Object in the world with its Design origin at `pos`, turned `rot`, awake. */
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

const byName = (sim: Sim, name: string) => sim.catalog.byName(name)!.id;

/** How far a joint's pin has pulled apart: as its two pieces have it. */
function pinGap(sim: Sim, o: WorldObject, i: number): number {
  const j = sim.physics.assembly(o.design)!.joints[i];
  const at = (k: number): BodyState => k ? { ...o, ...o.pieces![k - 1] } : o;
  const R = quatMatrix(at(j.b).rot, new Float64Array(9)), p = j.anchor, b = at(j.b);
  const pb = [0, 1, 2].map((k) =>
    b.pos[k] + R[k * 3] * p[0] + R[k * 3 + 1] * p[1] + R[k * 3 + 2] * p[2]
  );
  const pa = pinAt(o, j);
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
}

const bad = (sim: Sim, parts: unknown[], includes: string, extra = {}) => {
  let msg = "";
  try {
    sim.catalog.add(
      { kind: "design", name: `bad ${nextCall++}`, description: "", content: { parts, ...extra } },
      "test",
      0,
    );
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(msg.includes(includes), `expected "${includes}", got "${msg}"`);
};

const slab = (piece?: string) => ({
  part: "box",
  material: "planks",
  at: [0.5, 0.5, 0.5],
  size: [1, 1, 0.1],
  ...(piece ? { piece } : {}),
});
const hinge = (joins: unknown, extra = {}) => ({
  part: "hinge",
  material: "planks",
  at: [0, 0.5, 0.5],
  size: [0.05, 1, 0.05],
  joins,
  ...extra,
});

Deno.test("joint parts: pieces hang off the root like a tree, with limits and speeds checked", () => {
  const sim = new Sim(1);
  const ok1 = sim.catalog.add(
    {
      kind: "design",
      name: "flap",
      description: "",
      content: { parts: [slab(), slab("Lid"), hinge(["main", "lid"], { limits: [0, 90] })] },
    },
    "test",
    0,
  );
  const d = ok1.content as { parts: { piece?: string; joins?: string[] }[] };
  assert(d.parts[1].piece === "lid", "piece names are lowercase");
  assert(d.parts[2].joins![1] === "lid");
  bad(sim, [slab(), slab("lid"), { ...hinge(["main", "lid"]), piece: "lid" }], 'drop "piece"');
  bad(sim, [slab(), slab("lid"), hinge(["main"])], "joins names the two pieces");
  bad(sim, [slab(), slab("lid"), hinge(["lid", "lid"])], "two different pieces");
  bad(sim, [slab(), slab("lid"), hinge(["main", "door"])], 'no part is in piece "door"');
  bad(sim, [slab(), slab("lid")], 'Piece "lid" isn\'t joined to "main"');
  bad(sim, [slab(), slab("lid"), hinge(["main", "lid"]), hinge(["lid", "main"])], "without loops");
  bad(sim, [slab(), slab("lid"), hinge(["main", "lid"], { limits: [10, 90] })], "min ≤ 0 ≤ max");
  bad(sim, [slab(), slab("lid"), hinge(["main", "lid"], { limits: [0, 200] })], "limits[1]");
  bad(sim, [slab(), slab("lid"), hinge(["main", "lid"], { speed: 10 })], "only motors");
  bad(
    sim,
    [slab(), slab("w"), { ...hinge(["main", "w"]), part: "axle", limits: [0, 9] }],
    "only hinges",
  );
  bad(sim, [slab(), slab("w"), { ...hinge(["main", "w"]), part: "slider" }], "needs limits");
  bad(sim, [slab(), slab("w"), { ...hinge(["main", "w"]), part: "motor", speed: 0 }], "can't be 0");
  bad(sim, [slab(), slab("w"), { ...hinge(["main", "w"]), part: "motor", speed: 999 }], "speed");
  bad(sim, [{ ...slab(), joins: ["main", "x"] }], "only joint parts");
  bad(sim, [{ ...slab(), piece: "" }], "names a piece");
  const many = Array.from({ length: 9 }, (_, i) => [slab(`p${i}`), hinge(["main", `p${i}`])]);
  bad(sim, [slab(), ...many.flat()], "at most 8 joints");
  bad(sim, [slab(), slab("lid"), hinge(["main", "lid"])], "Plants can't have joints", {
    habitat: { on: ["grass"], zones: [], share: 1 },
  });
  // A motor without a speed turns at 30°/s; an axle needs nothing more.
  const m = sim.catalog.add(
    {
      kind: "design",
      name: "spinner",
      description: "",
      content: { parts: [slab(), slab("w"), { ...hinge(["main", "w"]), part: "motor" }] },
    },
    "test",
    0,
  ).content as { parts: { speed?: number }[] };
  assert(m.parts[2].speed === 30);
  // Nature's worked examples are valid and can be read.
  for (const name of ["garden gate", "hand cart", "windmill", "hinge", "axle", "slider", "motor"]) {
    assert(sim.catalog.byName(name), `${name} is in the Catalog`);
  }
});

Deno.test("a gate is a wall until it's used; then it swings open, the way is clear, and it shuts", () => {
  const { sim, fern, x, z, g } = site();
  const gate = byName(sim, "garden gate");
  // Gate leaf in tile x+1, posts in x and x+2, along the north edge of row z+3.
  const o = spawn(sim, gate, [x, g, z + 3]);
  steps(sim, 30);
  const w = sim.world, key = (z + 3) * w.sizeX + x + 1;
  assert(w.objSolid[key], "the closed gate blocks its tile");
  assert(!o.asleep || o.joints, "it has joint state");
  // Walking from north of the gate to south of it goes around.
  fern.x = x + 1.5, fern.z = z + 1.5;
  const text = ok(run(sim, "a", "use", { x: x + 1, z: z + 3 }));
  assert(text.includes("open") && text.includes("95°"), text);
  steps(sim, 20);
  const at = o.joints![0].at!;
  assert(Math.abs(at * 180 / Math.PI - 95) < 4, `swung to 95°: ${at * 180 / Math.PI}`);
  assert(pinGap(sim, o, 0) < 0.03, `the hinge holds: ${pinGap(sim, o, 0)}`);
  assert(!w.objSolid[key], "the open gate leaves its tile free");
  // Through the gateway and back.
  ok(run(sim, "a", "walk_to", { x: x + 1, z: z + 4 }));
  assert(Math.floor(fern.z) === z + 4 && Math.floor(fern.x) === x + 1, "walked through");
  // Posts and anchored root never move.
  assert(Math.abs(o.pos[0] - x) < 1e-9 && Math.abs(o.pos[2] - z - 3) < 1e-9);
  const shut = ok(run(sim, "a", "use", { x: x + 1, z: z + 3 }));
  assert(shut.includes("shut"), shut);
  steps(sim, 40);
  assert(Math.abs(o.joints![0].at!) < 0.06, "shut again");
  assert(w.objSolid[key], "a wall again");
  steps(sim, 60);
  assert(o.asleep, "a shut gate falls asleep");
  // A walker shoving it doesn't open it: the hinge holds it shut.
  sim.physics.wake(o);
  o.pieces![0].spin = [0, 3, 0];
  steps(sim, 40);
  assert(Math.abs(o.joints![0].at!) < 0.1, `held shut: ${o.joints![0].at}`);
});

Deno.test("use explains what it can't work, and refuses bad arguments", () => {
  const { sim, x, z, g } = site();
  err(run(sim, "a", "use", { x: x + 1, z: z + 1 }), "nothing to use");
  spawn(sim, byName(sim, "hand cart"), [x, g, z + 4]);
  steps(sim, 40);
  err(run(sim, "a", "use", { x: x, z: z + 4 }), "spins freely on its axle");
  err(run(sim, "a", "use", { x: x + 4, z: z + 4, piece: "door" }), 'no piece "door"');
  err(run(sim, "a", "use", { x: "a", z: 1 }), '"x" must be a number');
  err(run(sim, "a", "use", { x: x, z: z, piece: 5 }), "piece is the name");
  err(run(sim, "a", "use", { x: x, z: z, open: true }), 'doesn\'t take "open"');
  err(run(sim, "a", "use", { x: -50, z: 3 }), "outside the world");
  // A free hinge (no limits) is a swing: nothing to drive.
  const swing = design(sim, "swing", [
    { ...slab(), at: [0.5, 2.2, 0.5], size: [1, 0.1, 0.1] },
    { ...slab("seat"), at: [0.5, 1.2, 0.5], size: [0.6, 0.1, 0.4] },
    { ...hinge(["main", "seat"]), at: [0.5, 2.15, 0.5], tilt: 90, turn: 90 },
  ], { anchored: true });
  spawn(sim, swing, [x + 5, g, z + 1]);
  steps(sim, 10);
  err(run(sim, "a", "use", { x: x + 5, z: z + 1 }), "swings freely");
});

Deno.test("a windmill's motor turns its sails while it's on, and they coast to sleep when off", () => {
  const { sim, x, z, g } = site();
  const o = spawn(sim, byName(sim, "windmill"), [x + 2, g, z + 3]);
  steps(sim, 30);
  assert(o.asleep, "built still");
  ok(run(sim, "a", "use", { x: x + 2, z: z + 3 }));
  assert(o.joints![0].on, "on");
  const start = o.joints![0].at!;
  steps(sim, 40); // 2 s at 45°/s
  let turned = o.joints![0].at! - start;
  if (turned < 0) turned += 2 * Math.PI;
  assert(Math.abs(turned * 180 / Math.PI - 90) < 20, `turned ~90°: ${turned * 180 / Math.PI}`);
  assert(pinGap(sim, o, 0) < 0.03, `the motor's pin holds: ${pinGap(sim, o, 0)}`);
  steps(sim, 200);
  assert(!o.asleep, "a running motor keeps it awake");
  assert(Math.abs(o.pos[1] - g) < 1e-9, "the anchored tower stays put");
  // The sails stay in their plane (the axle doesn't wobble).
  const R = quatMatrix(o.pieces![0].rot, new Float64Array(9));
  assert(Math.abs(R[8]) > 0.999, `axis still along z: ${R[8]}`);
  ok(run(sim, "a", "use", { x: x + 2, z: z + 3 }));
  assert(!o.joints![0].on, "off");
  steps(sim, 1200);
  assert(o.asleep, "the sails coast to a stop and sleep");
  const look = ok(run(sim, "a", "look", {}));
  assert(look.includes("Mechanisms") && look.includes("windmill") && look.includes("off"), look);
});

Deno.test("a hand cart rolls on its axles when pushed, wheels and all, carrying a crate", () => {
  const { sim, x, z, g } = site();
  const cart = spawn(sim, byName(sim, "hand cart"), [x + 1, g, z + 3]);
  steps(sim, 60);
  for (let i = 0; i < 4; i++) assert(pinGap(sim, cart, i) < 0.03, `wheel ${i + 1} on`);
  const crate = design(sim, "small crate", [{
    part: "box",
    material: "planks",
    at: [0.25, 0.2, 0.25],
    size: [0.5, 0.4, 0.5],
  }]);
  const c0 = sim.physics.center(cart);
  // On the east half of the bed, so the west tile is the cart's alone.
  const box = spawn(sim, crate, [c0[0] + 0.05, c0[1] + 0.2, c0[2] - 0.25]);
  steps(sim, 60);
  const text = ok(
    run(sim, "a", "push", {
      x: Math.floor(c0[0]) - 1,
      z: Math.floor(c0[2]),
      toward: "east",
      tiles: 3,
    }),
  );
  assert(text.includes("pushed"), text);
  const c1 = sim.physics.center(cart);
  assert(c1[0] - c0[0] > 2.5, `rolled east: ${c1[0] - c0[0]} (${text})`);
  assert(Math.abs(c1[2] - c0[2]) < 0.4, `straight: ${c1[2] - c0[2]}`);
  for (let i = 0; i < 4; i++) {
    assert(pinGap(sim, cart, i) < 0.05, `wheel ${i + 1} still on: ${pinGap(sim, cart, i)}`);
  }
  assert(lean(cart.rot) < 0.15, `still upright: ${lean(cart.rot)}`);
  const b = sim.physics.center(box);
  assert(b[0] - c0[0] > 1.5 && b[1] > c1[1], `the crate rode along: ${b[0] - c0[0]}`);
  steps(sim, 400);
  assert(cart.asleep, "comes to rest and sleeps");
});

Deno.test("a slider slides a drawer out and back; a motor and a hinge in a carried box fold up", () => {
  const { sim, x, z, g } = site();
  const chest = design(sim, "drawer chest", [
    { part: "box", material: "planks", at: [0.5, 0.5, 0.5], size: [0.9, 1, 0.9] },
    {
      part: "box",
      material: "planks",
      at: [0.5, 0.5, 1.1],
      size: [0.7, 0.3, 0.3],
      piece: "drawer",
    },
    {
      part: "slider",
      material: "planks",
      at: [0.5, 0.5, 1.1],
      size: [0.05, 0.4, 0.05],
      tilt: 90,
      joins: ["main", "drawer"],
      limits: [0, 0.6],
    },
  ], { anchored: true });
  const o = spawn(sim, chest, [x + 2, g, z + 2]);
  steps(sim, 30);
  const text = ok(run(sim, "a", "use", { x: x + 2, z: z + 3 }));
  assert(text.includes("0.60 blocks"), text);
  const d = sim.physics.assembly(chest)!;
  const at = o.pieces![0].pos;
  assert(Math.abs(at[2] - o.pos[2] - 0.6) < 0.05, `drawer out along z: ${at[2] - o.pos[2]}`);
  assert(lean(o.pieces![0].rot) < 0.02, "no turning on a slider");
  assert(d.joints[0].kind === "slider");
  ok(run(sim, "a", "use", { x: x + 2, z: z + 3 }));
  assert(Math.abs(o.pieces![0].pos[2] - o.pos[2]) < 0.05, "back in");
  // A light box with a hinged lid: carried, it folds up as built; put down, it opens again.
  const box = design(sim, "lidded box", [
    { part: "box", material: "planks", at: [0.5, 0.2, 0.5], size: [0.6, 0.4, 0.6] },
    { part: "box", material: "planks", at: [0.5, 0.42, 0.5], size: [0.6, 0.04, 0.6], piece: "lid" },
    {
      part: "hinge",
      material: "planks",
      at: [0.5, 0.42, 0.2],
      size: [0.04, 0.5, 0.04],
      tilt: 90,
      turn: 90,
      joins: ["main", "lid"],
      limits: [-100, 0],
    },
  ]);
  const b = spawn(sim, box, [x + 5, g, z + 5]);
  steps(sim, 40);
  ok(run(sim, "a", "use", { x: x + 5, z: z + 5 }));
  assert(Math.abs(b.joints![0].at!) > 1.4, `lid open: ${b.joints![0].at}`);
  ok(run(sim, "a", "carry", { x: x + 5, z: z + 5 }));
  steps(sim, 5);
  assert(Math.abs(b.pieces![0].rot[0] - b.rot[0]) < 1e-9, "the lid folds shut while carried");
  ok(run(sim, "a", "put_down", { x: x + 6, z: z + 1 }));
  steps(sim, 60);
  assert(pinGap(sim, b, 0) < 0.03, `lid still on: ${pinGap(sim, b, 0)}`);
  assert(Math.abs(b.joints![0].at!) > 1.4, "it opens again where it was left");
});

Deno.test("Rules: used fires with the Design and piece, and switch starts and stops motors", () => {
  const { sim, x, z, g } = site();
  const mill = spawn(sim, byName(sim, "windmill"), [x + 2, g, z + 3]);
  spawn(sim, byName(sim, "garden gate"), [x + 4, g, z + 6]);
  steps(sim, 30);
  ok(run(sim, "a", "catalog_add", {
    kind: "rule",
    name: "gate bell",
    description: "A bell rings when the gate opens.",
    content: { when: { event: "used", what: "gate" }, do: [{ say: "Ding!" }] },
  }));
  ok(run(sim, "a", "catalog_add", {
    kind: "rule",
    name: "mill by day",
    description: "Start the windmill every half hour.",
    content: { when: { every: 30 }, do: [{ switch: { what: "windmill", on: true } }] },
  }));
  const text = ok(run(sim, "a", "use", { x: x + 5, z: z + 6 }));
  assert(text.includes("Ding!"), text);
  const half = Math.ceil(sim.ticksPerDay / 48) + 2;
  steps(sim, half);
  assert(mill.joints![0].on, "the timer switched it on");
  const r = (n: string, c: unknown) =>
    run(sim, "a", "catalog_add", {
      kind: "rule",
      name: n,
      description: "",
      content: c,
    });
  err(
    r("bad switch 1", { when: { every: 30 }, do: [{ switch: { what: "windmill" } }] }),
    "on is true",
  );
  err(r("bad switch 2", { when: { every: 30 }, do: [{ switch: { on: true } }] }), "what names");
});

Deno.test("jointed Objects save and load mid-swing and run on the same", () => {
  const { sim, x, z, g } = site();
  const mill = spawn(sim, byName(sim, "windmill"), [x + 2, g, z + 3]);
  const cart = spawn(sim, byName(sim, "hand cart"), [x + 4, g + 1, z + 5]);
  steps(sim, 5);
  mill.joints = [{ on: true }];
  sim.physics.wake(mill);
  cart.vel = [1.5, 0, 0];
  steps(sim, 13);
  const copy = Sim.load(structuredClone(sim.save(0)));
  steps(sim, 40);
  for (let i = 0; i < 40; i++) copy.step();
  const a = sim.objects.list, b = copy.objects.list;
  for (let i = 0; i < a.length; i++) {
    assert(JSON.stringify(a[i].pieces) === JSON.stringify(b[i].pieces), "pieces match");
    assert(JSON.stringify(a[i].pos) === JSON.stringify(b[i].pos), "roots match");
  }
});

Deno.test("dismantling a jointed Object refunds its joints too", () => {
  const { sim, fern, x, z, g } = site();
  fern.inventory.planks = 40;
  const before = fern.inventory.planks;
  const text = ok(run(sim, "a", "build", { design: "hand cart", x: x + 2, z: z + 3 }));
  assert(text.includes("hand cart"), text);
  const spent = before - fern.inventory.planks;
  assert(spent >= 11, `bed, rails, 4 wheels and 4 axles: ${spent}`);
  steps(sim, 40);
  const o = sim.objects.list[0];
  assert(o.pieces?.length === 4 && o.joints?.length === 4, "four wheels on four axles");
  assert(Math.abs(o.pos[1] - g) < 0.1, `on its wheels: ${o.pos[1] - g}`);
  ok(run(sim, "a", "interact", { x: x + 2, z: z + 3 }));
  assert(fern.inventory.planks === before, `full refund: ${fern.inventory.planks} vs ${before}`);
});

Deno.test("a house's door is a wall until it's opened, and then the way in is clear", () => {
  const { sim, fern, x, z } = site();
  fern.inventory.planks = 120;
  design(sim, "hut", [
    {
      part: "box",
      material: "planks",
      at: [1.49, 0.98, 3.06],
      size: [0.9, 1.9, 0.06],
      piece: "door",
    },
    {
      part: "hinge",
      material: "planks",
      at: [1.03, 0.98, 3.06],
      size: [0.05, 1.9, 0.05],
      joins: ["main", "door"],
      limits: [0, 90],
    },
  ], {
    blocks: {
      palette: { p: "planks" },
      layers: [
        ["pppp", "p..p", "p..p", "p.pp"],
        ["pppp", "p..p", "p..p", "p.pp"],
        ["pppp", "pppp", "pppp", "pppp"],
      ],
    },
  });
  let built = "";
  for (let i = 0; i < 5 && !sim.objects.list.length; i++) {
    built = ok(run(sim, "a", "build", { design: "hut", x: x + 2, z: z + 1 }));
  }
  const o = sim.objects.list[0];
  assert(o && o.pieces?.length === 1, `built with its door: ${built}`);
  steps(sim, 40);
  // The doorway is (x+3, z+4); inside is x+3..x+4, z+2..z+3.
  const inside = { x: x + 4, z: z + 3 }, door = { x: x + 3, z: z + 4 };
  fern.x = x + 3.5, fern.z = z + 6.5;
  err(run(sim, "a", "walk_to", inside), "can't find a way");
  const text = ok(run(sim, "a", "use", door));
  assert(text.includes("open"), text);
  steps(sim, 20);
  ok(run(sim, "a", "walk_to", inside));
  assert(Math.floor(fern.x) === inside.x && Math.floor(fern.z) === inside.z, "inside the hut");
  assert(pinGap(sim, o, 0) < 0.03, "the door is still on its hinge");
  // From inside, shut it behind you (standing clear of its swing), and open it again to leave.
  const shut = ok(run(sim, "a", "use", door));
  assert(shut.includes("shut"), shut);
  steps(sim, 20);
  assert(Math.floor(fern.z) === inside.z, `stood clear inside: ${fern.x - x}, ${fern.z - z}`);
  err(run(sim, "a", "walk_to", { x: x + 3, z: z + 6 }), "can't find a way");
  ok(run(sim, "a", "use", door));
  steps(sim, 20);
  ok(run(sim, "a", "walk_to", { x: x + 3, z: z + 6 }));
  // Standing in its swing stops it, and the result says so.
  fern.x = x + 3.5, fern.z = z + 3.5;
  steps(sim, 2);
  const blocked = ok(run(sim, "a", "use", door));
  assert(blocked.includes("in its way") || blocked.includes("shut"), blocked);
});

Deno.test("a world saved before joints existed gains nature's joint Parts and examples on load", () => {
  const sim = new Sim(5);
  const save = sim.save(0);
  const added = ["hinge", "axle", "slider", "motor", "garden gate", "hand cart", "windmill"];
  // An older save: the same entries without the new ones, numbered without gaps.
  const keep = save.catalog!.entries.filter((e) => !added.includes(e.name));
  const ids = new Map(keep.map((e, i) => [e.id, i + 1]));
  save.catalog!.entries = keep.map((e) => {
    const out = { ...e, id: ids.get(e.id)! };
    if (e.kind === "relation") {
      const r = e.content as RelationContent;
      out.content = { ...r, from: ids.get(r.from)!, to: ids.get(r.to)! };
    }
    return out;
  });
  const old = Sim.load(save);
  for (const name of added) assert(old.catalog.byName(name)?.author === "nature", `${name} added`);
  assert(old.catalog.entries.length === keep.length + added.length);
  // And it can be built with at once.
  const gate = old.catalog.byName("garden gate")!.content as { parts: { part: string }[] };
  assert(gate.parts.some((p) => p.part === "hinge"));
});

Deno.test("playtest 0007: a one-room hut's door doesn't trap its builder, and shut is shut both ways", () => {
  const { sim, fern, x, z } = site();
  fern.inventory.planks = 60;
  // Bramble's hut: 3 × 3, walls two high, no roof, the door mid-doorway and hinged at its jamb.
  design(sim, "bramble hut", [
    { part: "box", material: "planks", at: [1.5, 1, 2.5], size: [0.9, 1.9, 0.06], piece: "door" },
    {
      part: "hinge",
      material: "planks",
      at: [1.02, 1, 2.5],
      size: [0.05, 1.9, 0.05],
      joins: ["main", "door"],
      limits: [0, 95],
    },
  ], {
    anchored: true,
    blocks: { palette: { w: "planks" }, layers: [["www", "w.w", "w.w"], ["www", "w.w", "w.w"]] },
  });
  const hx = x + 2, hz = z + 2;
  let built = "";
  for (let i = 0; i < 4 && !sim.objects.list.length; i++) {
    built = ok(run(sim, "a", "build", { design: "bramble hut", x: hx, z: hz }));
  }
  const o = sim.objects.list[0];
  assert(o, built);
  const inHut = (ax: number, az: number) =>
    Math.floor(ax) === hx + 1 && (Math.floor(az) === hz + 1 || Math.floor(az) === hz + 2);
  assert(!inHut(fern.x, fern.z), `outside: ${fern.x - hx}, ${fern.z - hz}: ${built}`);
  steps(sim, 30);
  // Shut: no way in from any side, and the result says why.
  fern.x = hx - 1.5, fern.z = hz + 1.5;
  const r = run(sim, "a", "walk_to", { x: hx + 1, z: hz + 1 });
  err(r, "can't find a way");
  assert(r.text.includes("use x="), `names the shut door: ${r.text}`);
  // Opened from outside, in through the doorway, shut from inside, and no way out.
  ok(run(sim, "a", "use", { x: hx + 1, z: hz + 2 }));
  steps(sim, 20);
  ok(run(sim, "a", "walk_to", { x: hx + 1, z: hz + 1 }));
  const shut = ok(run(sim, "a", "use", { x: hx + 1, z: hz + 2 }));
  steps(sim, 20);
  // In a one-room hut the door swings through where you stand: it stops, and nobody falls over.
  assert(fern.downUntil === undefined, "a door never knocks anyone over");
  if (shut.includes("in its way")) {
    assert(shut.includes("limits [-95, 0]"), shut);
  } else {
    err(run(sim, "a", "walk_to", { x: hx + 1, z: hz + 4 }), "can't find a way");
  }
});

Deno.test("playtest 0007: a door too heavy to lift says so; look keeps angles within limits", () => {
  const { sim, x, z, g } = site();
  // A stone drawbridge on a horizontal hinge: far too heavy for a hinge to raise.
  const bridge = design(sim, "stone drawbridge", [
    { part: "box", material: "planks", at: [0.5, 0.5, 0.1], size: [1, 1, 0.2] },
    { part: "box", material: "stone", at: [0.5, 0.1, 1.6], size: [1, 0.2, 3], piece: "deck" },
    {
      part: "hinge",
      material: "planks",
      at: [0.5, 0.1, 0.1],
      size: [0.05, 1, 0.05],
      tilt: 90,
      turn: 90,
      joins: ["main", "deck"],
      limits: [-90, 0],
    },
  ], { anchored: true });
  spawn(sim, bridge, [x + 2, g, z + 2]);
  steps(sim, 30);
  const text = ok(run(sim, "a", "use", { x: x + 2, z: z + 3 }));
  assert(text.includes("too heavy for its hinge"), text);
  const look = ok(run(sim, "a", "look", {}));
  assert(look.includes("stuck short of -90°"), look);
});
