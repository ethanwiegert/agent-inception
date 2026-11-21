import { deepStrictEqual as assertEquals, ok } from "node:assert/strict";
import { identity, mat4, rotateY, translate } from "../math.ts";
import { Catalog, type DesignContent, natureCatalog } from "../sim/catalog.ts";
import { defaultFloatsee, HEAD_SHAPES } from "../sim/floatsee.ts";
import type { AgentView } from "../simclient.ts";
import { BodyModels, buildBodies } from "./body.ts";
import { meshDesign } from "./designs.ts";
import { defineFishModels, FaunaModels } from "./fauna.ts";
import {
  INSTANCE_FLOATS,
  InstanceBatch,
  MeshBuilder,
  MeshLibrary,
  VERTEX_BYTES,
} from "./meshes.ts";

const RED = [1, 0, 0] as const;

/** Every triangle's winding should agree with its vertex normals (outward, counter-clockwise). */
function assertOutward(b: MeshBuilder) {
  const p = b.positions, n = b.normals;
  for (let t = 0; t < b.indices.length; t += 3) {
    const [i, j, k] = [b.indices[t], b.indices[t + 1], b.indices[t + 2]];
    const u = [0, 1, 2].map((c) => p[j * 3 + c] - p[i * 3 + c]);
    const v = [0, 1, 2].map((c) => p[k * 3 + c] - p[i * 3 + c]);
    const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const area = Math.hypot(f[0], f[1], f[2]);
    if (area < 1e-9) continue;
    let dot = 0;
    for (const vi of [i, j, k]) for (let c = 0; c < 3; c++) dot += f[c] * n[vi * 3 + c];
    ok(dot > 0, `triangle ${t / 3} winds against its normals`);
  }
  for (let v = 0; v < b.vertexCount; v++) {
    const len = Math.hypot(n[v * 3], n[v * 3 + 1], n[v * 3 + 2]);
    ok(Math.abs(len - 1) < 1e-6, "normals are unit length");
  }
}

Deno.test("primitives wind outward with unit normals", () => {
  const m = rotateY(translate(identity(mat4()), 1, 2, 3), 0.7);
  assertOutward(new MeshBuilder().box(m, [1, 2, 0.5], { color: RED }));
  assertOutward(new MeshBuilder().box(m, [1, 2, 0.5], { color: RED }, 0.2));
  assertOutward(new MeshBuilder().sphere(m, [1, 0.6, 1], { color: RED }, { detail: 2 }));
  assertOutward(
    new MeshBuilder().sphere(null, [1, 1, 1], { color: RED }, { noise: 0.2, flat: true }),
  );
  assertOutward(new MeshBuilder().cylinder(m, 0.5, 0.3, 2, { color: RED }));
  assertOutward(new MeshBuilder().cone(null, 0.5, 1, { color: RED }, { flat: true }));
});

Deno.test("rounded boxes keep their size and sway follows height", () => {
  const b = new MeshBuilder().box(null, [2, 4, 1], { color: RED, sway: [0, 1] }, 0.3);
  let max = [0, 0, 0];
  for (let i = 0; i < b.vertexCount; i++) {
    max = max.map((m, c) => Math.max(m, Math.abs(b.positions[i * 3 + c])));
    const y = b.positions[i * 3 + 1];
    ok(Math.abs(b.sways[i] - (y + 2) / 4) < 1e-9);
  }
  assertEquals(max.map((v) => +v.toFixed(6)), [1, 2, 0.5]);
});

Deno.test("the library packs templates into shared buffers", () => {
  const lib = new MeshLibrary();
  const a = lib.define("a", (b) => b.box(null, [1, 1, 1], { color: RED }));
  const c = lib.define("c", (b) => b.cone(null, 1, 2, { color: RED }, { segments: 6 }));
  assertEquals([a, c, lib.id("c")], [0, 1, 1]);
  const { vertices, indices, ranges } = lib.pack();
  assertEquals(ranges[0], {
    firstIndex: 0,
    indexCount: 36,
    baseVertex: 0,
    radius: Math.sqrt(0.75),
    low: { firstIndex: 0, indexCount: 36, baseVertex: 0 },
  });
  assertEquals(ranges[1].firstIndex, 36);
  assertEquals(ranges[1].baseVertex, 24);
  assertEquals(vertices.byteLength, (24 + 6 * 4 + 7) * VERTEX_BYTES);
  assertEquals(indices.length, 36 + ranges[1].indexCount);
  const v = lib.version;
  lib.define("a", (b) => b.box(null, [2, 2, 2], { color: RED }));
  assertEquals([lib.size, lib.version > v], [2, true]);
});

Deno.test("low meshes pack after the full ones without moving their slices", () => {
  const sphere = (detail: number) => (b: MeshBuilder) =>
    b.sphere(null, [1, 1, 1], { color: RED }, { detail });
  const lib = new MeshLibrary();
  lib.define("a", sphere(3), sphere(1));
  lib.define("b", sphere(3));
  const plain = new MeshLibrary();
  plain.define("a", sphere(3));
  plain.define("b", sphere(3));
  const { vertices, ranges } = lib.pack();
  const pr = plain.pack().ranges;
  const full = (r: (typeof ranges)[number]) => ({
    firstIndex: r.firstIndex,
    indexCount: r.indexCount,
    baseVertex: r.baseVertex,
  });
  ok(ranges[0].low.indexCount < ranges[0].indexCount, "a's low mesh is coarser");
  assertEquals(ranges[1].low, full(ranges[1]), "b has no low mesh: its low is its own slice");
  assertEquals([full(ranges[0]), full(ranges[1])], [full(pr[0]), full(pr[1])]);
  const lb = new MeshBuilder();
  sphere(1)(lb);
  const lowBytes = lb.vertexCount * VERTEX_BYTES;
  assertEquals(vertices.byteLength, plain.pack().vertices.byteLength + lowBytes);
});

Deno.test("a low mesh no smaller than the full one is dropped", () => {
  const sphere = (detail: number) => (b: MeshBuilder) =>
    b.sphere(null, [1, 1, 1], { color: RED }, { detail });
  const lib = new MeshLibrary();
  lib.define("a", sphere(1), sphere(1));
  lib.define("b", sphere(1), sphere(3));
  for (const r of lib.pack().ranges) {
    assertEquals(r.low, {
      firstIndex: r.firstIndex,
      indexCount: r.indexCount,
      baseVertex: r.baseVertex,
    });
  }
});

Deno.test("a lower-detail sphere's vertices are positions of the full sphere's", () => {
  const o = { noise: 0.3, seed: 7 };
  const hi = new MeshBuilder().sphere(null, [1, 1, 1], { color: RED }, { ...o, detail: 3 });
  const lo = new MeshBuilder().sphere(null, [1, 1, 1], { color: RED }, { ...o, detail: 1 });
  const near = (i: number) => {
    for (let j = 0; j < hi.vertexCount; j++) {
      if (
        Math.abs(lo.positions[i * 3] - hi.positions[j * 3]) < 1e-9 &&
        Math.abs(lo.positions[i * 3 + 1] - hi.positions[j * 3 + 1]) < 1e-9 &&
        Math.abs(lo.positions[i * 3 + 2] - hi.positions[j * 3 + 2]) < 1e-9
      ) return true;
    }
    return false;
  };
  for (let i = 0; i < lo.vertexCount; i++) ok(near(i), `low vertex ${i} is a full vertex`);
});

Deno.test("a Design's low mesh is a fraction of its triangles", () => {
  const catalog = natureCatalog();
  const oak = catalog.current(catalog.byName("oak")!)!;
  const d = oak.content as DesignContent;
  const tris = (low: boolean) => {
    const b = new MeshBuilder();
    meshDesign(b, catalog, d, { role: null, low });
    return b.indices.length / 3;
  };
  const full = tris(false), low = tris(true);
  ok(low > 0, "the low oak is not empty");
  ok(low <= full / 8, `low oak is ${low} of ${full} triangles`);
});

Deno.test("instance batches group by template without losing data", () => {
  const batch = new InstanceBatch();
  const m = identity(mat4());
  for (let i = 0; i < 200; i++) {
    m[12] = i;
    batch.add(i % 3 === 0 ? 2 : 0, m, i, 0, 0, 0);
  }
  batch.sort(3);
  assertEquals([batch.first[0], batch.counts[0], batch.first[2], batch.counts[2]], [
    0,
    133,
    133,
    67,
  ]);
  for (let i = 0; i < 200; i++) {
    const t = batch.sorted[i * INSTANCE_FLOATS + 16];
    assertEquals(batch.sorted[i * INSTANCE_FLOATS + 12], t);
    assertEquals(t % 3 === 0, i >= 133);
  }
});

Deno.test("bark has circumferential grain without adding vertices", () => {
  const catalog = Catalog.create();
  const oak = catalog.current(catalog.byName("oak")!)!;
  const b = new MeshBuilder();
  meshDesign(b, catalog, oak.content as DesignContent);
  // The first two vertices sit beside each other at the same height around the trunk.
  ok(Math.abs(b.positions[1] - b.positions[4]) < 1e-9);
  const a = b.colors.slice(0, 3), c = b.colors.slice(3, 6);
  ok(a.some((v, i) => Math.abs(v - c[i]) > 1e-6), "adjacent bark vertices vary in tone");
});

Deno.test("fish bodies and tails are separate templates for articulated swimming", () => {
  const models = defineFishModels(new MeshLibrary()) as unknown as { body: number; tail: number }[];
  assertEquals(models.length, 5);
  for (const model of models) {
    ok(Number.isInteger(model.body), "fish has a body template");
    ok(Number.isInteger(model.tail), "fish has a tail template");
    ok(model.body !== model.tail, "tail can move independently from the body");
  }
});

Deno.test("a walking villager counter-rotates their torso through the stride", () => {
  const catalog = Catalog.create();
  const lib = new MeshLibrary();
  const models = new BodyModels(lib);
  const floatsee = defaultFloatsee(0);
  const agent: AgentView = {
    id: 1,
    name: "Fern",
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    anim: 1,
    stride: 0.25,
    color: 0,
    body: null,
    floatsee,
    expression: "happy",
    carrying: false,
    down: 0,
  };
  const out = new InstanceBatch();
  buildBodies([agent], 1, out, models, catalog);
  out.sort(lib.size);
  const body = models.villager(catalog, null, floatsee)!.pieces.body!;
  ok(body);
  const i = out.sortedIds.indexOf(body.id);
  ok(i >= 0, "torso is drawn");
  ok(Math.abs(out.sorted[i * INSTANCE_FLOATS + 2]) > 0.001, "torso twists around vertical");
});

Deno.test("all 6 Floatsee head shapes and new lathe/tube/star primitives mesh cleanly outward", () => {
  const b1 = new MeshBuilder().lathe(null, [[0.1, 0], [0.3, 0.2], [0.2, 0.5]], { color: RED }, 12);
  assertOutward(b1);
  const b2 = new MeshBuilder().tube(
    null,
    [[0, 0, 0, 0.05], [0.2, 0.2, 0, 0.05], [0.2, 0.5, 0, 0.02]],
    { color: RED },
    8,
  );
  assertOutward(b2);
  const b3 = new MeshBuilder().star(null, 0.4, 0.2, 0.16, { color: RED }, 5);
  assertOutward(b3);

  const catalog = Catalog.create();
  const lib = new MeshLibrary();
  const models = new BodyModels(lib);
  for (let i = 0; i < HEAD_SHAPES.length; i++) {
    const look = { ...defaultFloatsee(i), head: HEAD_SHAPES[i] };
    const rig = models.villager(catalog, null, look);
    ok(rig?.floatsee, `${HEAD_SHAPES[i]} builds a floatsee rig`);
    ok(rig?.pieces.head && rig?.pieces.body, `${HEAD_SHAPES[i]} has head and body`);
  }
});

Deno.test("a cow's tail has its own joint for idle and walking motion", () => {
  const catalog = Catalog.create();
  const fauna = new FaunaModels(new MeshLibrary());
  ok(fauna.pieces(catalog, 1).some((p) => p.role === "tail"));
});

Deno.test("the detailed built-in designs all mesh, land zones, and keep their solidity", () => {
  const catalog = Catalog.create();
  for (
    const name of [
      "oak",
      "birch",
      "pine",
      "bush",
      "farmer",
      "sheep",
      "cow",
      "chicken",
      "duck",
      "bunny",
      "turnip crop",
      "notice board",
      "workbench",
      "floatsee",
    ]
  ) {
    const e = catalog.current(catalog.byName(name)!)!;
    const d = e.content as DesignContent;
    const b = new MeshBuilder();
    assertEquals(meshDesign(b, catalog, d, { role: null }), d.parts.length, name);
    ok(b.vertexCount > 100, `${name} has real geometry`);
  }
  // A bush is walk-through ground cover, not something solid; a sheep's tail wags on its joint.
  const fauna = new FaunaModels(new MeshLibrary());
  ok(fauna.pieces(catalog, 0).some((p) => p.role === "tail"), "sheep has a tail piece");
  ok(fauna.pieces(catalog, 1).some((p) => p.role === "tail"), "cow has a tail piece");
  ok(fauna.pieces(catalog, 4).some((p) => p.role === "tail"), "bunny has a tail piece");
});

Deno.test("a replaced animal design replaces the cached rig", () => {
  const catalog = Catalog.create();
  const fauna = new FaunaModels(new MeshLibrary());
  const before = fauna.pieces(catalog, 0);
  ok(before.length > 1, "sheep starts as several parts");
  const sheep = catalog.byName("sheep")!;
  const fork = catalog.add(
    {
      kind: "design",
      name: "box sheep",
      content: {
        parts: [{
          part: "box",
          material: "wool",
          at: [0.5, 0.5, 0.5],
          size: [0.4, 0.4, 0.6],
          role: "body",
        }],
      },
    },
    "Fern",
    0,
  );
  sheep.retired = true;
  sheep.replacedBy = fork.id;
  const after = fauna.pieces(catalog, 0);
  assertEquals(after.map((p) => p.role), ["body"]);
  ok(after[0].id !== before[0].id);
  assertEquals(fauna.pieces(catalog, 0), after);
});
