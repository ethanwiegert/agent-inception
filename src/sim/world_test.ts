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
  assertEquals([...w.chunkVersion], [1, 1]);
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
