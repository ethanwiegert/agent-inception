import { Pattern } from "../sim/blocks.ts";
import { hash2, Rng } from "../sim/rng.ts";

export const MaterialPattern = { ...Pattern, woven: Pattern.fleece + 1 } as const;

// One seamless height/paint tile per Catalog pattern. Bake once, then sample with hardware mips.
const SIZE = 128;
const TAU = Math.PI * 2;
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

/** Periodic value noise, with independent repeat counts along and across the grain. */
function grain(u: number, v: number, nx: number, ny: number) {
  const x = u * nx, y = v * ny;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const at = (dx: number, dy: number) => hash2((ix + dx) % nx, (iy + dy) % ny, 591);
  const tx = fx * fx * (3 - 2 * fx), ty = fy * fy * (3 - 2 * fy);
  return lerp(lerp(at(0, 0), at(1, 0), tx), lerp(at(0, 1), at(1, 1), tx), ty);
}

/** Overlapping tapered strokes. A grass crown fans out from one root; broad leaves have a
 * raised midrib and one face in shade. Wrap every brush mark across tile edges. */
function botanical(tile: Uint8Array, grass: boolean) {
  const rng = new Rng(grass ? 771 : 38);
  for (let i = 0; i < (grass ? 210 : 340); i++) {
    const x = rng.range(0, SIZE), y = rng.range(0, SIZE);
    const fan = rng.range(-1.3, 1.3);
    for (let blade = 0; blade < (grass ? 3 : 1); blade++) {
      const angle = fan + (blade - 1) * 0.48;
      const length = grass ? rng.range(5, 12) : rng.range(6, 16);
      const width = grass ? rng.range(0.65, 1.35) : length * rng.range(0.15, 0.28);
      const tone = rng.range(85, 180), sn = Math.sin(angle), cs = Math.cos(angle);
      const radius = Math.ceil(length + width + 1);
      for (let iy = Math.floor(y) - radius; iy <= y + radius; iy++) {
        for (let ix = Math.floor(x) - radius; ix <= x + radius; ix++) {
          const dx = ix + 0.5 - x, dy = iy + 0.5 - y;
          const t = (dx * sn + dy * cs) / length;
          if (t <= 0 || t >= 1) continue;
          const across = dx * cs - dy * sn - t * t * width * 0.65;
          const edge = width * (grass ? 1 - t : 4 * t * (1 - t)) - Math.abs(across);
          if (edge <= -0.5) continue;
          const h = tone + t * 36 + (across > 0 ? 18 : -12) + 22 * clamp(1 - Math.abs(across));
          const index = (iy & (SIZE - 1)) * SIZE + (ix & (SIZE - 1));
          tile[index] = lerp(tile[index], h, clamp(edge + 0.5));
        }
      }
    }
  }
}

function paint(pattern: number) {
  const tile = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE, v = y / SIZE;
      const wash = grain(u, v, 6, 6), chips = grain(u, v, 29, 29);
      let h: number;
      switch (pattern) {
        case Pattern.grass:
        case Pattern.leaves:
          h = 0.27 + 0.3 * wash + 0.1 * chips;
          break;
        case Pattern.log:
        case Pattern.planks:
        case Pattern.thatch: {
          const along = pattern === Pattern.planks ? v : u;
          const warp = wash * (pattern === Pattern.thatch ? 0.2 : 1.1);
          const fibers = Math.cos(TAU * (along * 18 + warp));
          h = 0.34 + 0.29 * wash + 0.22 * fibers - 0.16 * Math.max(0, fibers) ** 6 + 0.12 * chips;
          break;
        }
        case MaterialPattern.woven: {
          // At each crossing one yarn rides over the other. Keep the painted cloth matte.
          const warp = Math.cos(TAU * u * 34), weft = Math.cos(TAU * v * 34);
          const over = (Math.floor(u * 34 + 0.5) + Math.floor(v * 34 + 0.5)) % 2 === 0;
          h = 0.46 + 0.1 * wash + 0.09 * (over ? warp : weft) + 0.04 * Math.max(warp, weft);
          break;
        }
        case Pattern.fleece: {
          const curl = grain(u + wash * 0.07, v + chips * 0.012, 19, 19);
          h = 0.33 + 0.31 * wash + 0.26 * Math.sin(curl * TAU);
          break;
        }
        case Pattern.stone:
        case Pattern.cobble:
        case Pattern.bricks: {
          const seam = clamp(1 - Math.abs(wash + chips * 0.16 - 0.57) * 25);
          h = 0.32 + 0.3 * wash + 0.18 * chips - 0.22 * seam;
          break;
        }
        case Pattern.sand:
        case Pattern.dirt:
        case Pattern.farmland:
          h = 0.34 + 0.22 * wash + 0.2 * chips - 0.18 * clamp((chips - 0.65) * 5);
          break;
        default:
          // A restrained painted finish on ceramic, glazed tiles and unpatterned parts.
          h = 0.4 + 0.12 * wash + 0.08 * chips;
      }
      tile[y * SIZE + x] = 255 * clamp(h);
    }
  }
  if (pattern === Pattern.grass || pattern === Pattern.leaves) {
    botanical(tile, pattern === Pattern.grass);
  }
  return tile;
}

export function createMaterialTexture(device: GPUDevice) {
  const layers = Object.values(MaterialPattern);
  const texture = device.createTexture({
    label: "material grain",
    size: [SIZE, SIZE, layers.length],
    mipLevelCount: 1 + Math.log2(SIZE),
    format: "r8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  for (const layer of layers) {
    let pixels = paint(layer);
    for (let size = SIZE, mipLevel = 0; size >= 1; size >>= 1, mipLevel++) {
      device.queue.writeTexture({ texture, mipLevel, origin: [0, 0, layer] }, pixels, {
        bytesPerRow: size,
      }, [size, size]);
      if (size === 1) break;
      const next = new Uint8Array(size * size / 4);
      for (let i = 0; i < next.length; i++) {
        const p = Math.floor(i / (size / 2)) * size * 2 + (i % (size / 2)) * 2;
        next[i] = (pixels[p] + pixels[p + 1] + pixels[p + size] + pixels[p + size + 1] + 2) >> 2;
      }
      pixels = next;
    }
  }
  return texture;
}

export const materialWgsl = /* wgsl */ `
@group(0) @binding(7) var grainTiles: texture_2d_array<f32>;
@group(0) @binding(8) var grainSampler: sampler;

// Surface gradient in world space. Handle foreshortened triangles and either screen orientation.
fn reliefNormal(n: vec3f, world: vec3f, height: f32) -> vec3f {
  let dx = dpdx(world);
  let dy = dpdy(world);
  let tx = cross(dy, n);
  let ty = cross(n, dx);
  let det = dot(dx, tx);
  let g = (tx * dpdx(height) + ty * dpdy(height)) * sign(det) / max(abs(det), 1e-7);
  return normalize(n - g / max(1.0, length(g) * 1.6));
}
`;
