import { step } from "./path.ts";
import { hash2, type Rng } from "./rng.ts";
import { Block, type World } from "./world.ts";

/** How a species lives. Rendering (parts and bones) lives in render/fauna.ts under the same name. */
export interface SpeciesDef {
  name: string;
  /** What `look` shows for it. */
  mark: string;
  habitat: "land" | "water";
  /** Blocks per second at a stroll; fleeing doubles it. */
  speed: number;
  /** How far from its herd an animal strays before heading back. */
  roam: number;
  /** Shied away from by farmers closer than this (0 = tame). */
  shy: number;
  /**
   * Ticks until its product is ready again after collecting (`interact`); what it gives comes
   * from the `drops` Relations of its Design in the Catalog. 0: nothing to collect.
   */
  productEvery: number;
  /** Herds per world and animals per herd. */
  herds: number;
  herdSize: number;
}

const DAY = 20 * 600;

export const SPECIES: SpeciesDef[] = [
  {
    name: "sheep",
    mark: "&",
    habitat: "land",
    speed: 1.1,
    roam: 6,
    shy: 2.5,
    productEvery: DAY,
    herds: 3,
    herdSize: 4,
  },
  {
    name: "cow",
    mark: "M",
    habitat: "land",
    speed: 0.9,
    roam: 7,
    shy: 1.8,
    productEvery: DAY / 2,
    herds: 2,
    herdSize: 3,
  },
  {
    name: "chicken",
    mark: "v",
    habitat: "land",
    speed: 1.3,
    roam: 4,
    shy: 2.2,
    productEvery: DAY / 2,
    herds: 2,
    herdSize: 5,
  },
  {
    name: "duck",
    mark: "Y",
    habitat: "water",
    speed: 0.8,
    roam: 5,
    shy: 3,
    productEvery: 0,
    herds: 3,
    herdSize: 3,
  },
];

export const AnimalAnim = { Idle: 0, Walk: 1, Graze: 2, Sleep: 3 } as const;
/** What an animal is up to (sim side; the page sees `AnimalAnim`). */
export const AnimalMode = { Idle: 0, Walk: 1, Graze: 2, Sleep: 3, Flee: 4, Follow: 5 } as const;
const Mode = AnimalMode;

export interface Animal {
  id: number;
  species: number;
  herd: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  anim: number;
  stride: number;
  mode: number;
  /** Ticks left in the current idle/graze spell. */
  timer: number;
  tx: number;
  tz: number;
  /** Tick its product (wool, milk, egg) is ready to collect. */
  readyAt: number;
}

/**
 * What animals react to: villagers' positions, whether they're moving, and which species they
 * carry food for (bit per species, from `is_food_for` Relations).
 */
export interface Farmer {
  x: number;
  z: number;
  moving: boolean;
  food: number;
}

/** Water surfaces sit a little below the top of their block. */
const SURFACE_DROP = 0.12;

export function animalY(world: World, a: Animal): number {
  const key = Math.floor(a.z) * world.sizeX + Math.floor(a.x);
  if (SPECIES[a.species].habitat === "water" && world.waterTop[key] >= 0) {
    return world.waterTop[key] + 1 - SURFACE_DROP;
  }
  return world.surfaceY(a.x, a.z, a.y);
}

/** Can this animal step from where it is into tile (tx, tz)? */
function canEnter(world: World, a: Animal, tx: number, tz: number): boolean {
  if (tx < 0 || tz < 0 || tx >= world.sizeX || tz >= world.sizeZ) return false;
  const wet = world.waterTop[tz * world.sizeX + tx] >= 0;
  if (SPECIES[a.species].habitat === "water") return wet;
  if (wet) return false;
  const floor = world.floorBelow(Math.floor(a.x), Math.floor(a.z), Math.floor(a.y + 0.5));
  return floor >= 0 && step(world, floor, tx, tz) >= 0;
}

/** Herds placed deterministically from the seed: land herds on open grass, ducks on calm water. */
export function spawnAnimals(world: World, seed: number): Animal[] {
  const animals: Animal[] = [];
  const { sizeX, sizeZ } = world;
  const cx = sizeX / 2, cz = sizeZ / 2;
  let herd = 0;
  SPECIES.forEach((def, species) => {
    for (let h = 0; h < def.herds; h++, herd++) {
      for (let tries = 0; tries < 400; tries++) {
        const x = Math.floor(hash2(herd, tries, seed + 1201) * sizeX);
        const z = Math.floor(hash2(herd, tries, seed + 1202) * sizeZ);
        const d = Math.hypot(x - cx, z - cz);
        if (d < 18 || d > 95 || !suits(world, def, x, z)) continue;
        for (let i = 0; i < def.herdSize; i++) {
          // Members stand on suitable tiles around the herd's spot.
          for (let k = 0; k < 12; k++) {
            const ax = x + Math.floor((hash2(herd * 16 + i, k, seed + 1203) - 0.5) * 6);
            const az = z + Math.floor((hash2(herd * 16 + i, k, seed + 1204) - 0.5) * 6);
            if (!suits(world, def, ax, az)) continue;
            const a: Animal = {
              id: animals.length + 1,
              species,
              herd,
              x: ax + 0.5,
              y: 0,
              z: az + 0.5,
              yaw: hash2(herd, i, seed + 1205) * Math.PI * 2,
              anim: AnimalAnim.Idle,
              stride: 0,
              mode: Mode.Idle,
              timer: Math.floor(hash2(herd, i, seed + 1206) * 100),
              tx: ax + 0.5,
              tz: az + 0.5,
              readyAt: 0,
            };
            a.y = animalY(world, a);
            animals.push(a);
            break;
          }
        }
        break;
      }
    }
  });
  return animals;
}

function suits(world: World, def: SpeciesDef, x: number, z: number): boolean {
  if (x < 1 || z < 1 || x >= world.sizeX - 1 || z >= world.sizeZ - 1) return false;
  const key = z * world.sizeX + x;
  const h = world.heightAt(x, z);
  if (def.habitat === "water") {
    // Rivers and ponds, not the open sea: water no deeper than 3 with land nearby.
    const depth = world.waterTop[key] - h;
    if (world.waterTop[key] < 0 || depth > 3) return false;
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (world.waterTop[(z + dz) * world.sizeX + x + dx] < 0) return true;
      }
    }
    return false;
  }
  return world.waterTop[key] < 0 && !world.propSolid[key] && world.get(x, h, z) === Block.Grass;
}

const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/**
 * One tick of animal life: wander near the herd, graze, sleep at night, shy away from farmers
 * walking close, and trail anyone carrying their food.
 */
export function stepAnimals(
  animals: Animal[],
  world: World,
  rng: Rng,
  farmers: Farmer[],
  night: boolean,
  tickHz: number,
) {
  // Herd centers, so members drift back together.
  const sums = new Map<number, [number, number, number]>();
  for (const a of animals) {
    const s = sums.get(a.herd) ?? [0, 0, 0];
    s[0] += a.x, s[1] += a.z, s[2]++;
    sums.set(a.herd, s);
  }
  for (const a of animals) {
    const def = SPECIES[a.species];
    let near: Farmer | null = null, nearD = Infinity, lure: Farmer | null = null, lureD = Infinity;
    for (const f of farmers) {
      const d = Math.hypot(f.x - a.x, f.z - a.z);
      if (d < nearD) near = f, nearD = d;
      if ((f.food >> a.species) & 1 && d < lureD) lure = f, lureD = d;
    }

    if (near && near.moving && nearD < def.shy && a.mode !== Mode.Follow) {
      // Shy away: pick a spot a few tiles directly away from the farmer.
      const k = 4 / Math.max(nearD, 0.1);
      a.mode = Mode.Flee;
      a.tx = a.x + (a.x - near.x) * k;
      a.tz = a.z + (a.z - near.z) * k;
    } else if (lure && lureD < 7 && !night) {
      a.mode = lureD > 1.6 ? Mode.Follow : Mode.Idle;
      a.tx = lure.x, a.tz = lure.z;
      if (a.mode === Mode.Idle) a.timer = Math.max(a.timer, 10);
    }

    switch (a.mode) {
      case Mode.Sleep:
        a.anim = AnimalAnim.Sleep;
        if (!night) a.mode = Mode.Idle, a.timer = 20;
        break;
      case Mode.Idle:
      case Mode.Graze:
        a.anim = a.mode === Mode.Graze ? AnimalAnim.Graze : AnimalAnim.Idle;
        if (--a.timer > 0) break;
        if (night) {
          a.mode = Mode.Sleep;
          break;
        }
        if (rng.next() < 0.45) {
          a.mode = Mode.Graze;
          a.timer = 60 + Math.floor(rng.next() * 160);
        } else {
          // Wander somewhere near the herd (or yourself, if the herd is far).
          const s = sums.get(a.herd)!;
          const hx = s[0] / s[2], hz = s[1] / s[2];
          const away = Math.hypot(hx - a.x, hz - a.z) > def.roam;
          const ox = away ? hx : a.x, oz = away ? hz : a.z;
          const r = def.roam * 0.6;
          a.tx = ox + (rng.next() * 2 - 1) * r;
          a.tz = oz + (rng.next() * 2 - 1) * r;
          a.mode = Mode.Walk;
        }
        break;
      default: {
        const dx = a.tx - a.x, dz = a.tz - a.z;
        const d = Math.hypot(dx, dz);
        const speed = (def.speed / tickHz) * (a.mode === Mode.Flee ? 2 : 1);
        if (d < 0.15 || (a.mode === Mode.Follow && d < 1.6)) {
          a.mode = Mode.Idle;
          a.timer = 20 + Math.floor(rng.next() * 60);
          break;
        }
        const s = Math.min(speed, d);
        const nx = a.x + (dx / d) * s, nz = a.z + (dz / d) * s;
        const tx = Math.floor(nx), tz = Math.floor(nz);
        if ((tx !== Math.floor(a.x) || tz !== Math.floor(a.z)) && !canEnter(world, a, tx, tz)) {
          a.mode = Mode.Idle;
          a.timer = 10 + Math.floor(rng.next() * 30);
          break;
        }
        a.x = nx, a.z = nz;
        a.stride += s;
        a.yaw += angleDiff(a.yaw, Math.atan2(dx, dz)) * 0.25;
        a.anim = AnimalAnim.Walk;
      }
    }
    a.y += (animalY(world, a) - a.y) * 0.35;
  }
}
