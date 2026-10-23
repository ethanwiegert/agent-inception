import { hash2 } from "./rng.ts";

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

function grad(ix: number, iz: number, seed: number, dx: number, dz: number): number {
  const a = hash2(ix, iz, seed) * Math.PI * 2;
  return Math.cos(a) * dx + Math.sin(a) * dz;
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
