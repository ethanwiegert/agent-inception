/** Deterministic hashing and PRNG. The sim never uses Math.random. */

/** 32-bit integer hash (lowbias32). */
export function hash32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** Hash of integer lattice coordinates and a seed, as a float in [0, 1). */
export function hash2(x: number, z: number, seed: number): number {
  return hash32(hash32(hash32(seed) ^ x) ^ Math.imul(z, 0x9e3779b9)) / 4294967296;
}

/** mulberry32: small, fast, good enough for gameplay randomness. */
export class Rng {
  constructor(private state: number) {}

  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}
