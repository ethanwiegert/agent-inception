import { Block } from "./blocks.ts";
import { fbm2 } from "./noise.ts";
import { World } from "./world.ts";

export interface WorldGenOptions {
  seed: number;
  sizeX?: number;
  sizeZ?: number;
  sizeY?: number;
}

/** Water level for the sea, rivers and lakes. */
export const SEA_LEVEL = 18;

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

/**
 * An island meadow: rolling hills with some terraced cliffs, river valleys
 * winding down to the sea, sandy beaches and clay/gravel riverbeds.
 */
export function generateWorld({ seed, sizeX = 256, sizeZ = 256, sizeY = 64 }: WorldGenOptions) {
  const world = new World(sizeX, sizeY, sizeZ);
  const raw = new Float32Array(sizeX * sizeZ);
  const heights = new Int16Array(sizeX * sizeZ);
  const river = new Float32Array(sizeX * sizeZ);

  for (let z = 0; z < sizeZ; z++) {
    for (let x = 0; x < sizeX; x++) {
      const rolling = fbm2(x * 0.011, z * 0.011, seed, 3) * 6;
      const swell = fbm2(x * 0.004, z * 0.004, seed + 77, 2) * 5;
      const base = 22 + rolling + swell;
      // In some regions, squash the slope into flat plateaus joined by 2-4 block cliffs.
      const cliffs = smoothstep(0.2, 0.45, fbm2(x * 0.006, z * 0.006, seed + 331, 2));
      let h = lerp(base, terrace(base * 1.3, 4), cliffs);

      // Rivers follow the zero crossings of warped noise; the land sinks into valleys around them.
      const wx = fbm2(x * 0.01, z * 0.01, seed + 900, 2) * 18;
      const wz = fbm2(x * 0.01, z * 0.01, seed + 901, 2) * 18;
      const r = Math.abs(fbm2((x + wx) * 0.006, (z + wz) * 0.006, seed + 500, 2));
      river[z * sizeX + x] = r;
      h = lerp(SEA_LEVEL - 2.4, h, smoothstep(0.012, 0.1, r));

      // The island sinks into the sea toward the edges, along a wobbly coastline.
      const dx = (x / (sizeX - 1)) * 2 - 1, dz = (z / (sizeZ - 1)) * 2 - 1;
      const edge = Math.pow(dx ** 4 + dz ** 4, 0.25) +
        fbm2(x * 0.02, z * 0.02, seed + 77, 2) * 0.08;
      h = lerp(SEA_LEVEL - 7, h, smoothstep(0.98, 0.78, edge));

      raw[z * sizeX + x] = h;
    }
  }

  // Shores shelve gently: near sea level, blend toward a blurred height field so beaches
  // and riverbanks slope instead of stepping in jagged 2-3 block drops.
  const radius = 3;
  for (let z = 0; z < sizeZ; z++) {
    for (let x = 0; x < sizeX; x++) {
      const h = raw[z * sizeX + x];
      const shore = 1 - smoothstep(1.5, 5, Math.abs(h - SEA_LEVEL));
      let v = h;
      if (shore > 0) {
        let sum = 0, n = 0;
        for (let dz = -radius; dz <= radius; dz++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = Math.min(sizeX - 1, Math.max(0, x + dx));
            const nz = Math.min(sizeZ - 1, Math.max(0, z + dz));
            sum += raw[nz * sizeX + nx];
            n++;
          }
        }
        v = lerp(h, sum / n, shore);
      }
      heights[z * sizeX + x] = Math.max(4, Math.min(sizeY - 8, Math.round(v)));
    }
  }

  const near = (x: number, z: number, test: (h: number) => boolean, radius: number) => {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx, nz = z + dz;
        if (nx >= 0 && nz >= 0 && nx < sizeX && nz < sizeZ && test(heights[nz * sizeX + nx])) {
          return true;
        }
      }
    }
    return false;
  };

  for (let z = 0; z < sizeZ; z++) {
    for (let x = 0; x < sizeX; x++) {
      const h = heights[z * sizeX + x];
      const wet = h < SEA_LEVEL;
      const beach = !wet && h <= SEA_LEVEL + 1 && near(x, z, (n) => n < SEA_LEVEL, 2);
      const bed = fbm2(x * 0.08, z * 0.08, seed + 41, 2);
      const surface = wet
        ? river[z * sizeX + x] < 0.02 && bed > 0.35
          ? Block.Clay
          : bed < -0.45
          ? Block.Gravel
          : Block.Sand
        : beach
        ? Block.Sand
        : Block.Grass;
      for (let y = 0; y <= h; y++) {
        const block = y === h
          ? surface
          : y >= h - 3
          ? (surface === Block.Sand ? Block.Sand : Block.Dirt)
          : Block.Stone;
        world.blocks[world.index(x, y, z)] = block;
      }
      for (let y = h + 1; y <= SEA_LEVEL; y++) world.blocks[world.index(x, y, z)] = Block.Water;
      world.top[z * sizeX + x] = h;
      world.waterTop[z * sizeX + x] = wet ? SEA_LEVEL : -1;
    }
  }
  world.chunkVersion.fill(1);
  return world;
}
