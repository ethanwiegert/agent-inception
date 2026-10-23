import { fbm2 } from "./noise.ts";
import { Block, World } from "./world.ts";

export interface WorldGenOptions {
  seed: number;
  sizeX?: number;
  sizeZ?: number;
  sizeY?: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
/** Flat shelves of `step` height with short steep risers between them. */
const terrace = (h: number, step: number) => {
  const k = Math.floor(h / step);
  return (k + smoothstep(0.75, 1, h / step - k)) * step;
};

/** A gently rolling meadow: wide low terraces of grass over dirt over stone. */
export function generateMeadow({ seed, sizeX = 256, sizeZ = 256, sizeY = 64 }: WorldGenOptions) {
  const world = new World(sizeX, sizeY, sizeZ);
  for (let z = 0; z < sizeZ; z++) {
    for (let x = 0; x < sizeX; x++) {
      const rolling = fbm2(x * 0.011, z * 0.011, seed, 3) * 6;
      const swell = fbm2(x * 0.004, z * 0.004, seed + 77, 2) * 5;
      const raw = 20 + rolling + swell;
      // In some regions, squash the slope into flat plateaus joined by 2-4 block cliffs.
      const cliffs = smoothstep(0.2, 0.45, fbm2(x * 0.006, z * 0.006, seed + 331, 2));
      const h = Math.max(
        4,
        Math.min(sizeY - 8, Math.round(lerp(raw, terrace(raw * 1.3, 4), cliffs))),
      );
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
