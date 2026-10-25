import {
  deepStrictEqual as assertEquals,
  notDeepStrictEqual as assertNotEquals,
} from "node:assert/strict";
import { meshChunk } from "../render/mesher.ts";
import { Block, CHUNK, solid, World } from "./world.ts";
import { generateWorld, SEA_LEVEL } from "./worldgen.ts";

Deno.test("worldgen is deterministic per seed", () => {
  const a = generateWorld({ seed: 42, sizeX: 64, sizeZ: 64 });
  const b = generateWorld({ seed: 42, sizeX: 64, sizeZ: 64 });
  const c = generateWorld({ seed: 43, sizeX: 64, sizeZ: 64 });
  assertEquals(a.blocks, b.blocks);
  assertNotEquals(a.blocks, c.blocks);
});

Deno.test("the island has land, sea and a consistent height and water map", () => {
  const w = generateWorld({ seed: 7 });
  let land = 0, sea = 0;
  for (let z = 0; z < w.sizeZ; z++) {
    for (let x = 0; x < w.sizeX; x++) {
      const i = z * w.sizeX + x, h = w.heightAt(x, z);
      assertEquals(solid(w.get(x, h, z)), true);
      if (w.waterTop[i] >= 0) {
        sea++;
        assertEquals(w.get(x, h + 1, z), Block.Water);
        assertEquals(w.waterTop[i], SEA_LEVEL);
        assertEquals(w.get(x, h, z) === Block.Grass, false);
      } else {
        land++;
        assertEquals(w.get(x, h + 1, z), Block.Air);
      }
    }
  }
  // Mostly land in the middle, sea around it.
  assertEquals(land > w.sizeX * w.sizeZ * 0.4 && sea > w.sizeX * w.sizeZ * 0.2, true);
  assertEquals(w.waterTop[0] >= 0 && w.waterTop[128 * w.sizeX + 128] < 0, true);
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
  assertEquals(verts.length, 6 * 4 * 2); // two words per vertex
  for (let i = 0; i < verts.length; i += 2) {
    assertEquals(verts[i] >>> 24, Block.Dirt);
    assertEquals((verts[i] >>> 22) & 3, 3);
  }
  // A neighbour on top hides the top face of the lower block and the bottom face of the upper.
  w.set(4, 3, 4, Block.Dirt);
  assertEquals(meshChunk(w, 0, 0).length, 10 * 4 * 2);
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
