import {
  deepStrictEqual as assertEquals,
  notDeepStrictEqual as assertNotEquals,
} from "node:assert/strict";
import { meshChunk } from "../render/mesher.ts";
import { Block, CHUNK, World } from "./world.ts";
import { generateMeadow } from "./worldgen.ts";

Deno.test("worldgen is deterministic per seed", () => {
  const a = generateMeadow({ seed: 42, sizeX: 64, sizeZ: 64 });
  const b = generateMeadow({ seed: 42, sizeX: 64, sizeZ: 64 });
  const c = generateMeadow({ seed: 43, sizeX: 64, sizeZ: 64 });
  assertEquals(a.blocks, b.blocks);
  assertNotEquals(a.blocks, c.blocks);
});

Deno.test("meadow surface is grass with a valid height map", () => {
  const w = generateMeadow({ seed: 7, sizeX: 64, sizeZ: 64 });
  for (let z = 0; z < w.sizeZ; z++) {
    for (let x = 0; x < w.sizeX; x++) {
      const h = w.heightAt(x, z);
      assertEquals(w.get(x, h, z), Block.Grass);
      assertEquals(w.get(x, h + 1, z), Block.Air);
    }
  }
});

Deno.test("edits update the height map and bump neighbouring chunk versions", () => {
  const w = new World(CHUNK * 2, 16, CHUNK);
  w.set(CHUNK - 1, 3, 0, Block.Stone);
  assertEquals(w.heightAt(CHUNK - 1, 0), 3);
  // Both chunks must remesh: the edit sits on their shared border.
  assertEquals([...w.chunkVersion].map((v) => v > 0), [true, true]);
  w.set(CHUNK - 1, 3, 0, Block.Air);
  assertEquals(w.heightAt(CHUNK - 1, 0), -1);
});

Deno.test("a lone block meshes to six quads with full AO", () => {
  const w = new World(CHUNK, 8, CHUNK);
  w.set(4, 2, 4, Block.Dirt);
  const verts = meshChunk(w, 0, 0);
  assertEquals(verts.length, 24);
  for (const v of verts) {
    assertEquals(v >>> 24, Block.Dirt);
    assertEquals((v >>> 22) & 3, 3);
  }
  // A neighbour on top hides the top face of the lower block and the bottom face of the upper.
  w.set(4, 3, 4, Block.Dirt);
  assertEquals(meshChunk(w, 0, 0).length, 40);
});

Deno.test("one-block rises become watertight slopes; cliffs stay square", () => {
  const w = new World(8, 8, 8);
  for (let z = 0; z < 8; z++) {
    for (let x = 0; x < 8; x++) {
      const h = x < 4 ? 2 : x === 4 ? 3 : 5; // step of 1 at x=4, cliff of 2 at x=5
      for (let y = 0; y <= h; y++) w.set(x, y, z, y === h ? Block.Grass : Block.Dirt);
    }
  }
  // The column above the one-block step ramps down on its west side.
  assertEquals(w.slopeMask(4, 3), 0b0101);
  assertEquals(w.surfaceY(4.0, 3.5), 3);
  assertEquals(w.surfaceY(4.5, 3.5), 3.5);
  assertEquals(w.surfaceY(4.999, 3.5) > 3.99, true);
  // Flat ground and the foot of the step don't move; the cliff top keeps square edges.
  assertEquals(w.slopeMask(2, 3), 0);
  assertEquals(w.slopeMask(3, 3), 0);
  assertEquals(w.slopeMask(5, 3), 0);
  // Placed stone never slopes.
  w.set(4, 3, 3, Block.Stone);
  assertEquals(w.slopeMask(4, 3), 0);
});
