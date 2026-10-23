export const Block = {
  Air: 0,
  Grass: 1,
  Dirt: 2,
  Stone: 3,
  Farmland: 4,
} as const;
export type BlockId = number;

/** Names agents use for blocks. */
export const BLOCK_NAMES: Record<number, string> = {
  [Block.Air]: "air",
  [Block.Grass]: "grass",
  [Block.Dirt]: "dirt",
  [Block.Stone]: "stone",
  [Block.Farmland]: "farmland",
};

export const CHUNK = 32;

/** Natural ground softens into slopes; worked and placed blocks keep square edges. */
export const slopes = (block: BlockId) => block === Block.Grass || block === Block.Dirt;

/**
 * How far (0-1) a top surface sinks at (fx, fz) within a column, given its corner mask.
 * Each column top is two triangles split along the diagonal whose corners agree, so the
 * mesher, the grass shader and walking bodies all see the same surface.
 */
export function slopeDrop(mask: number, fx: number, fz: number): number {
  const d00 = mask & 1, d10 = (mask >> 1) & 1, d01 = (mask >> 2) & 1, d11 = (mask >> 3) & 1;
  if (d00 === d11) {
    return fx >= fz
      ? d00 + (d10 - d00) * fx + (d11 - d10) * fz
      : d00 + (d01 - d00) * fz + (d11 - d01) * fx;
  }
  return fx + fz <= 1
    ? d00 + (d10 - d00) * fx + (d01 - d00) * fz
    : d11 + (d10 - d11) * (1 - fz) + (d01 - d11) * (1 - fx);
}

/**
 * Fixed-size voxel world. Blocks are stored y-major per column-slab so a chunk
 * column is contiguous enough for meshing. Every edit bumps its chunk's version
 * so renderers can remesh lazily without the sim knowing about them.
 */
export class World {
  readonly blocks: Uint8Array;
  /** Height of the topmost solid block per (x, z), or -1 for an empty column. */
  readonly top: Int16Array;
  readonly chunksX: number;
  readonly chunksZ: number;
  readonly chunkVersion: Uint32Array;

  constructor(readonly sizeX: number, readonly sizeY: number, readonly sizeZ: number) {
    this.blocks = new Uint8Array(sizeX * sizeY * sizeZ);
    this.top = new Int16Array(sizeX * sizeZ).fill(-1);
    this.chunksX = Math.ceil(sizeX / CHUNK);
    this.chunksZ = Math.ceil(sizeZ / CHUNK);
    this.chunkVersion = new Uint32Array(this.chunksX * this.chunksZ);
  }

  index(x: number, y: number, z: number): number {
    return (y * this.sizeZ + z) * this.sizeX + x;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sizeX && y < this.sizeY && z < this.sizeZ;
  }

  get(x: number, y: number, z: number): BlockId {
    return this.inBounds(x, y, z) ? this.blocks[this.index(x, y, z)] : Block.Air;
  }

  set(x: number, y: number, z: number, block: BlockId): void {
    if (!this.inBounds(x, y, z)) return;
    this.blocks[this.index(x, y, z)] = block;
    this.updateTop(x, z);
    // Faces, AO and slopes depend on all eight neighbours, which may sit in other chunks.
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = Math.floor((x + dx) / CHUNK), nz = Math.floor((z + dz) / CHUNK);
        if ((dx === 0 && dz === 0) || nx !== cx || nz !== cz) this.touch(x + dx, z + dz);
      }
    }
  }

  /**
   * Which top corners of column (x, z) sink one block to meet lower ground, as a mask:
   * bit 0 (x0,z0), 1 (x1,z0), 2 (x0,z1), 3 (x1,z1). A corner sinks when a column around it
   * is exactly one lower, none is higher, and every column at this height also slopes;
   * that keeps neighbouring surfaces watertight. Bigger drops stay as cliffs.
   */
  slopeMask(x: number, z: number): number {
    const h = this.heightAt(x, z);
    if (h < 1 || !slopes(this.get(x, h, z))) return 0;
    let mask = 0;
    for (let c = 0; c < 4; c++) {
      const sx = c & 1 ? 1 : -1, sz = c & 2 ? 1 : -1;
      let lower = false, blocked = false;
      for (let k = 0; k < 3; k++) {
        const nx = x + (k === 1 ? 0 : sx), nz = z + (k === 0 ? 0 : sz);
        const nh = this.heightAt(nx, nz);
        if (nh > h || (nh === h && !slopes(this.get(nx, nh, nz)))) blocked = true;
        else if (nh === h - 1) lower = true;
      }
      if (lower && !blocked) mask |= 1 << c;
    }
    return mask;
  }

  /** Height of the walkable surface at a fractional position, following slopes. */
  surfaceY(x: number, z: number): number {
    const ix = Math.floor(x), iz = Math.floor(z);
    const h = this.heightAt(ix, iz);
    if (h < 0) return 0;
    const mask = this.slopeMask(ix, iz);
    return h + 1 - (mask ? slopeDrop(mask, x - ix, z - iz) : 0);
  }

  /** Height of the topmost solid block at (x, z), or -1. */
  heightAt(x: number, z: number): number {
    x = Math.floor(x), z = Math.floor(z);
    if (x < 0 || z < 0 || x >= this.sizeX || z >= this.sizeZ) return -1;
    return this.top[z * this.sizeX + x];
  }

  updateTop(x: number, z: number): void {
    let y = this.sizeY - 1;
    while (y >= 0 && this.blocks[this.index(x, y, z)] === Block.Air) y--;
    this.top[z * this.sizeX + x] = y;
  }

  private touch(x: number, z: number): void {
    if (x < 0 || z < 0 || x >= this.sizeX || z >= this.sizeZ) return;
    this.chunkVersion[Math.floor(z / CHUNK) * this.chunksX + Math.floor(x / CHUNK)]++;
  }
}
