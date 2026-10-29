import {
  deepStrictEqual as assertEquals,
  notDeepStrictEqual as assertNotEquals,
  ok as assert,
} from "node:assert/strict";
import { meshChunk } from "../render/mesher.ts";
import { findPath, levelAt, standY, step } from "./path.ts";
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

Deno.test("a pocket dug deep inside solid ground still meshes its inner walls", () => {
  // A solid slab; the mesher skips the buried blocks under its top, so a hollow must count.
  const w = new World(CHUNK, 12, CHUNK);
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) for (let y = 0; y < 10; y++) w.set(x, y, z, Block.Stone);
  }
  const quads = (verts: Uint32Array) => verts.length / 8;
  const solidSlab = quads(meshChunk(w, 0, 0));
  w.set(8, 4, 8, Block.Air);
  // Six faces look into the pocket from the blocks around it.
  assertEquals(quads(meshChunk(w, 0, 0)), solidSlab + 6);
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

Deno.test("a body buried in solid ground stands on the top surface", () => {
  const w = new World(4, 8, 4);
  for (let y = 0; y < 5; y++) w.set(1, y, 1, Block.Stone);
  assertEquals(w.surfaceY(1.5, 1.5, 0), 5);
});

Deno.test("bodies swim across water up to three deep, and float while they do", () => {
  // Banks at height 4 on both sides of a channel whose bed is at 1 with water up to 4.
  const w = new World(5, 10, 1);
  for (let x = 0; x < 5; x++) {
    const bank = x === 0 || x === 4;
    for (let y = 0; y <= (bank ? 4 : 1); y++) w.set(x, y, 0, Block.Dirt);
    if (!bank) { for (let y = 2; y <= 4; y++) w.set(x, y, 0, Block.Water); }
  }
  assertEquals(step(w, 4, 1, 0), 4, "into the water at the surface level");
  assertEquals(step(w, 4, 4, 0), 4, "and out onto the far bank");
  const path = findPath(w, 0, 0, 4, (x) => x === 4, (x) => 4 - x);
  assertEquals(path, [1, 0, 2, 0, 3, 0, 4, 0]);
  assertEquals(levelAt(w, 2, 0, 3.6), 4);
  assert(standY(w, 2.5, 0.5, 3.6) > 2.5, "treading water, not walking the bed");
  w.set(2, 0, 0, Block.Water), w.set(2, 1, 0, Block.Water);
  assertEquals(step(w, 4, 2, 0), -1, "too deep to swim");
});
