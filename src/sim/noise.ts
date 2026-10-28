import { hash2 } from "./rng.ts";

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Gradients memoized per lattice point. Neighbouring samples share corners, so nearly every lookup
 * hits; a miss recomputes exactly the same doubles, so the noise is bit-identical either way.
 */
const CACHE_BITS = 12;
const cacheX = new Int32Array(1 << CACHE_BITS);
const cacheZ = new Int32Array(1 << CACHE_BITS);
const cacheSeed = new Int32Array(1 << CACHE_BITS);
const cacheUsed = new Uint8Array(1 << CACHE_BITS);
const cacheGx = new Float64Array(1 << CACHE_BITS);
const cacheGz = new Float64Array(1 << CACHE_BITS);

function grad(ix: number, iz: number, seed: number, dx: number, dz: number): number {
  const slot = (Math.imul(ix, 0x9e3779b1) ^ Math.imul(iz, 0x85ebca77) ^
    Math.imul(seed, 0xc2b2ae35)) >>> (32 - CACHE_BITS);
  if (
    !cacheUsed[slot] || cacheX[slot] !== ix || cacheZ[slot] !== iz || cacheSeed[slot] !== seed
  ) {
    const a = hash2(ix, iz, seed) * Math.PI * 2;
    cacheGx[slot] = Math.cos(a);
    cacheGz[slot] = Math.sin(a);
    cacheX[slot] = ix, cacheZ[slot] = iz, cacheSeed[slot] = seed, cacheUsed[slot] = 1;
  }
  return cacheGx[slot] * dx + cacheGz[slot] * dz;
}

/** Seeded 2D gradient noise in roughly [-0.7, 0.7]. */
export function perlin2(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fade(fx), v = fade(fz);
  const n00 = grad(ix, iz, seed, fx, fz);
  const n10 = grad(ix + 1, iz, seed, fx - 1, fz);
  const n01 = grad(ix, iz + 1, seed, fx, fz - 1);
  const n11 = grad(ix + 1, iz + 1, seed, fx - 1, fz - 1);
  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);
  return a + v * (b - a);
}

/** Fractal sum of `octaves` layers of perlin2, normalized to roughly [-1, 1]. */
export function fbm2(x: number, z: number, seed: number, octaves = 4): number {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += perlin2(x * freq, z * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return (sum / norm) * 1.4;
}
