import { Block, CHUNK, World } from "../sim/world.ts";

/**
 * One rgba16uint texel per column, shared by every GPU-generated layer (grass,
 * water, terrain blending):
 *   r: top solid height   g: top block   a: water level + 1 (0 = dry)
 *   b: bits 0-3 slope mask, bits 4-11 which neighbours are grassy
 *      (W, E, N, S, NW, NE, SW, SE) so material edges can blend smoothly.
 * Only the columns around edited chunks are recomputed.
 */
export class SurfaceTexture {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  private texels: Uint16Array;
  private versions: Uint32Array;

  constructor(private device: GPUDevice, private world: World) {
    this.texture = device.createTexture({
      size: [world.sizeX, world.sizeZ],
      format: "rgba16uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.view = this.texture.createView();
    this.texels = new Uint16Array(world.sizeX * world.sizeZ * 4);
    this.versions = new Uint32Array(world.chunkVersion.length);
  }

  update() {
    const { world } = this;
    for (let i = 0; i < this.versions.length; i++) {
      if (this.versions[i] === world.chunkVersion[i]) continue;
      this.versions[i] = world.chunkVersion[i];
      // Slope masks and grass edges depend on neighbours, so refresh a one-column border too.
      const cx = (i % world.chunksX) * CHUNK, cz = Math.floor(i / world.chunksX) * CHUNK;
      const x0 = Math.max(0, cx - 1), z0 = Math.max(0, cz - 1);
      const x1 = Math.min(world.sizeX, cx + CHUNK + 1), z1 = Math.min(world.sizeZ, cz + CHUNK + 1);
      for (let z = z0; z < z1; z++) {
        for (let x = x0; x < x1; x++) {
          const c = z * world.sizeX + x, h = world.top[c], t = c * 4;
          this.texels[t] = Math.max(h, 0);
          this.texels[t + 1] = h >= 0 ? world.get(x, h, z) : 0;
          let edges = 0;
          for (let k = 0; k < 8; k++) {
            if (grassy(world, x + NEIGHBOURS[k * 2], z + NEIGHBOURS[k * 2 + 1])) edges |= 1 << k;
          }
          this.texels[t + 2] = world.slopeMask(x, z) | (edges << 4);
          this.texels[t + 3] = world.waterTop[c] + 1;
        }
      }
      this.device.queue.writeTexture(
        { texture: this.texture, origin: [x0, z0] },
        this.texels,
        { offset: (z0 * world.sizeX + x0) * 8, bytesPerRow: world.sizeX * 8 },
        [x1 - x0, z1 - z0],
      );
    }
  }
}

const NEIGHBOURS = [-1, 0, 1, 0, 0, -1, 0, 1, -1, -1, 1, -1, -1, 1, 1, 1];

function grassy(world: World, x: number, z: number): boolean {
  const h = world.heightAt(x, z);
  return h >= 0 && world.get(x, h, z) === Block.Grass && world.waterDepth(x, z) === 0;
}

/**
 * How grassy the ground is at (fx, fz) inside a column, blending bilinearly toward the
 * neighbours of the quadrant it's in. Add noise and threshold at 0.5 for organic edges.
 */
export const grassWeightWgsl = /* wgsl */ `
fn grassBit(edges: u32, bit: u32) -> f32 {
  return f32((edges >> bit) & 1u);
}

fn grassWeight(s: vec4u, fx: f32, fz: f32) -> f32 {
  let own = f32(s.g == 1u && s.a <= s.r + 1u);
  let edges = s.b >> 4u;
  let east = fx >= 0.5;
  let south = fz >= 0.5;
  let gx = grassBit(edges, select(0u, 1u, east));
  let gz = grassBit(edges, select(2u, 3u, south));
  let gd = grassBit(edges, select(select(4u, 5u, east), select(6u, 7u, east), south));
  let tx = abs(fx - 0.5);
  let tz = abs(fz - 0.5);
  return mix(mix(own, gx, tx), mix(gz, gd, tx), tz);
}

/** Organic grass/other boundary: noise wobbles the 0.5 threshold. */
fn isGrassy(s: vec4u, xz: vec2f) -> bool {
  let w = grassWeight(s, fract(xz.x), fract(xz.y));
  let wobble = (valueNoise(xz * 1.9) - 0.5) * 0.5 + (valueNoise(xz * 7.0) - 0.5) * 0.2;
  return w + wobble > 0.5;
}
`;

/** WGSL mirror of `slopeDrop` in sim/world.ts: how far a column top sinks at (fx, fz). */
export const slopeDropWgsl = /* wgsl */ `
fn slopeDrop(mask: u32, fx: f32, fz: f32) -> f32 {
  let d00 = f32(mask & 1u);
  let d10 = f32((mask >> 1u) & 1u);
  let d01 = f32((mask >> 2u) & 1u);
  let d11 = f32((mask >> 3u) & 1u);
  if (d00 == d11) {
    if (fx >= fz) { return d00 + (d10 - d00) * fx + (d11 - d10) * fz; }
    return d00 + (d01 - d00) * fz + (d11 - d01) * fx;
  }
  if (fx + fz <= 1.0) { return d00 + (d10 - d00) * fx + (d01 - d00) * fz; }
  return d11 + (d10 - d11) * (1.0 - fz) + (d01 - d11) * (1.0 - fx);
}
`;
