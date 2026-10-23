import { fbm2 } from "./noise.ts";
import { Block, World } from "./world.ts";

export interface WorldGenOptions {
  seed: number;
  sizeX?: number;
  sizeZ?: number;
  sizeY?: number;
}

/** A gently rolling meadow: wide low terraces of grass over dirt over stone. */
export function generateMeadow({ seed, sizeX = 256, sizeZ = 256, sizeY = 64 }: WorldGenOptions) {
  const world = new World(sizeX, sizeY, sizeZ);
  for (let z = 0; z < sizeZ; z++) {
    for (let x = 0; x < sizeX; x++) {
      const rolling = fbm2(x * 0.011, z * 0.011, seed, 3) * 6;
      const swell = fbm2(x * 0.004, z * 0.004, seed + 77, 2) * 5;
      const h = Math.max(4, Math.min(sizeY - 8, Math.round(20 + rolling + swell)));
      for (let y = 0; y <= h; y++) {
        const block = y === h ? Block.Grass : y >= h - 3 ? Block.Dirt : Block.Stone;
        world.blocks[world.index(x, y, z)] = block;
      }
      world.top[z * sizeX + x] = h;
    }
  }
  world.chunkVersion.fill(1);
  return world;
}
