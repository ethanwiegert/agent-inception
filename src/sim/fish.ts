import { hash2, type Rng } from "./rng.ts";
import type { World } from "./world.ts";

/**
 * Fish live in schools: a handful of fish of one species drifting about a home spot in the water.
 * The sim tracks schools (where they are, how many fish are left); the page animates the fish.
 */
export interface FishDef {
  name: string;
  /** Rivers and ponds (shallow, near land) or the open sea. */
  habitat: "river" | "sea";
  /** How eagerly it bites, relative. */
  bite: number;
  schools: number;
  size: number;
}

export const FISH: FishDef[] = [
  { name: "minnow", habitat: "river", bite: 1.4, schools: 5, size: 7 },
  { name: "trout", habitat: "river", bite: 0.8, schools: 5, size: 4 },
  { name: "perch", habitat: "river", bite: 1, schools: 4, size: 5 },
  { name: "mackerel", habitat: "sea", bite: 1.2, schools: 6, size: 6 },
  { name: "cod", habitat: "sea", bite: 0.7, schools: 4, size: 3 },
];

/** A caught fish comes back to its school after this many ticks (two game hours). */
export const FISH_REGROW = 20 * 50;

export interface School {
  id: number;
  species: number;
  x: number;
  z: number;
  homeX: number;
  homeZ: number;
  tx: number;
  tz: number;
  count: number;
  /** Tick the next missing fish returns. */
  regrowAt: number;
}

/**
 * Water habitat of a tile: the sea rings the island (same falloff as worldgen); rivers and ponds
 * are the water inland.
 */
export function waterHabitat(world: World, x: number, z: number): "river" | "sea" | null {
  if (x < 0 || z < 0 || x >= world.sizeX || z >= world.sizeZ) return null;
  if (world.waterTop[z * world.sizeX + x] < 0) return null;
  const dx = (x / (world.sizeX - 1)) * 2 - 1, dz = (z / (world.sizeZ - 1)) * 2 - 1;
  return Math.pow(dx ** 4 + dz ** 4, 0.25) > 0.8 ? "sea" : "river";
}

/** Is there dry land within `r` tiles (so a school can be fished from the bank)? */
function landWithin(world: World, x: number, z: number, r: number): boolean {
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= world.sizeX || nz >= world.sizeZ) continue;
      if (world.heightAt(nx, nz) >= 0 && world.waterTop[nz * world.sizeX + nx] < 0) return true;
    }
  }
  return false;
}

/**
 * Schools placed from the seed, all within casting distance of a shore. Each river species puts
 * its first school near the middle of the island, so new farmers have fish within a short walk.
 */
export function spawnSchools(world: World, seed: number): School[] {
  const schools: School[] = [];
  const cx = world.sizeX / 2, cz = world.sizeZ / 2;
  let n = 0;
  FISH.forEach((def, species) => {
    for (let s = 0; s < def.schools; s++, n++) {
      const nearby = def.habitat === "river" && s === 0;
      for (let tries = 0; tries < 2000; tries++) {
        const x = Math.floor(hash2(n, tries, seed + 1501) * world.sizeX);
        const z = Math.floor(hash2(n, tries, seed + 1502) * world.sizeZ);
        if (nearby && Math.hypot(x - cx, z - cz) > 45) continue;
        if (waterHabitat(world, x, z) !== def.habitat || !landWithin(world, x, z, 3)) continue;
        // Keep schools apart so each feels like a spot worth finding.
        if (schools.some((o) => Math.hypot(o.homeX - x, o.homeZ - z) < 10)) continue;
        schools.push({
          id: schools.length + 1,
          species,
          x: x + 0.5,
          z: z + 0.5,
          homeX: x + 0.5,
          homeZ: z + 0.5,
          tx: x + 0.5,
          tz: z + 0.5,
          count: def.size,
          regrowAt: 0,
        });
        break;
      }
    }
  });
  return schools;
}

/** Whether a (saved) school still fits the current placement rules. */
export function schoolFits(world: World, s: School): boolean {
  const def = FISH[s.species];
  const x = Math.floor(s.x), z = Math.floor(s.z);
  return !!def && waterHabitat(world, x, z) === def.habitat && landWithin(world, x, z, 4);
}

/** Schools drift slowly around home, staying in water of their habitat; caught fish return. */
export function stepSchools(
  schools: School[],
  world: World,
  rng: Rng,
  tick: number,
  tickHz: number,
) {
  const speed = 0.45 / tickHz;
  for (const s of schools) {
    const def = FISH[s.species];
    if (s.count < def.size && tick >= s.regrowAt) {
      s.count++;
      s.regrowAt = tick + FISH_REGROW;
    }
    const dx = s.tx - s.x, dz = s.tz - s.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.2) {
      // Pick a new spot near home every so often.
      if (rng.next() < 0.01) {
        s.tx = s.homeX + (rng.next() * 2 - 1) * 5;
        s.tz = s.homeZ + (rng.next() * 2 - 1) * 5;
      }
      continue;
    }
    const nx = s.x + (dx / d) * Math.min(speed, d), nz = s.z + (dz / d) * Math.min(speed, d);
    const tx = Math.floor(nx), tz = Math.floor(nz);
    if (waterHabitat(world, tx, tz) !== def.habitat || !landWithin(world, tx, tz, 4)) {
      s.tx = s.x, s.tz = s.z; // reached the edge of its water; settle and pick again later
      continue;
    }
    s.x = nx, s.z = nz;
  }
}
