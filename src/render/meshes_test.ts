import { deepStrictEqual as assertEquals, ok } from "node:assert/strict";
import { identity, mat4, rotateY, translate } from "../math.ts";
import { Catalog, type DesignContent } from "../sim/catalog.ts";
import { ANIMAL_READY } from "../sim/protocol.ts";
import { meshDesign } from "./designs.ts";
import { buildAnimals, FaunaModels, SHORN } from "./fauna.ts";
import { buildObjects, FloraModels } from "./flora.ts";
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
  });
  assertEquals(ranges[1].firstIndex, 36);
  assertEquals(ranges[1].baseVertex, 24);
  assertEquals(vertices.byteLength, (24 + 6 * 4 + 7) * VERTEX_BYTES);
  assertEquals(indices.length, 36 + ranges[1].indexCount);
  const v = lib.version;
  lib.define("a", (b) => b.box(null, [2, 2, 2], { color: RED }));
  assertEquals([lib.size, lib.version > v], [2, true]);
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

Deno.test("sheared wool draws at 0.78 until it grows back", () => {
  const catalog = Catalog.create();
  const fauna = new FaunaModels(new MeshLibrary());
  const wool = fauna.pieces(catalog, 0).find((p) => p.role === "product");
  ok(wool, "sheep has a product part");
  const shorn = new InstanceBatch();
  const full = new InstanceBatch();
  const body = { id: 1, species: 0, x: 3, y: 1, z: 4, yaw: 0, anim: 0, stride: 0, flags: 0 };
  buildAnimals([body], 0, shorn, fauna, catalog);
  buildAnimals([{ ...body, flags: ANIMAL_READY }], 0, full, fauna, catalog);
  const scale = (batch: InstanceBatch) => {
    batch.sort(64);
    const o = batch.first[wool!.id] * INSTANCE_FLOATS;
    return Math.hypot(batch.sorted[o], batch.sorted[o + 1], batch.sorted[o + 2]);
  };
  assertEquals(Math.round(scale(shorn) * 100) / 100, SHORN);
  assertEquals(Math.round(scale(full) * 100) / 100, 1);
});

Deno.test("a built design's parts are drawn on its tile", () => {
  const catalog = Catalog.create();
  const bench = catalog.byName("stone bench")!;
  const mesh = new MeshBuilder();
  meshDesign(mesh, catalog, bench.content as DesignContent, { role: null });
  let top = -Infinity;
  for (let i = 1; i < mesh.positions.length; i += 3) top = Math.max(top, mesh.positions[i]);
  ok(top > 1, "the plank top is in the mesh");

  const models = new FloraModels(new MeshLibrary());
  const batch = new InstanceBatch();
  buildObjects([{ design: bench.id, x: 10, y: 4, z: 20 }], catalog, batch, models);
  assertEquals(batch.count, 1);
  batch.sort(8);
  const id = models.template(catalog, bench.id);
  const o = batch.first[id] * INSTANCE_FLOATS;
  assertEquals([batch.sorted[o + 12], batch.sorted[o + 13], batch.sorted[o + 14]], [10.5, 4, 20.5]);
});
