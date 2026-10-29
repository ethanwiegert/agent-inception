import { Block, type BlockId, slopes, solid } from "./blocks.ts";

export { Block, type BlockId, slopes, solid };

export const CHUNK = 32;

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

/** A world's voxels and column heights, as the worker hands them to the page's mirror. */
export interface WorldData {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  blocks: Uint8Array<ArrayBuffer>;
  top: Int16Array<ArrayBuffer>;
  waterTop: Int16Array<ArrayBuffer>;
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
  /** Height of the topmost water block above the ground per (x, z), or -1. */
  readonly waterTop: Int16Array;
  /** 1 where a solid prop (tree, rock) stands on the column; set by `Props`. */
  readonly propSolid: Uint8Array;
  readonly chunksX: number;
  readonly chunksZ: number;
  readonly chunkVersion: Uint32Array;

  constructor(
    readonly sizeX: number,
    readonly sizeY: number,
    readonly sizeZ: number,
    data?: WorldData,
  ) {
    this.blocks = data?.blocks ?? new Uint8Array(sizeX * sizeY * sizeZ);
    this.top = data?.top ?? new Int16Array(sizeX * sizeZ).fill(-1);
    this.waterTop = data?.waterTop ?? new Int16Array(sizeX * sizeZ).fill(-1);
    this.propSolid = new Uint8Array(sizeX * sizeZ);
    this.chunksX = Math.ceil(sizeX / CHUNK);
    this.chunksZ = Math.ceil(sizeZ / CHUNK);
    this.chunkVersion = new Uint32Array(this.chunksX * this.chunksZ);
  }

  /** A world around `data`'s arrays (taken, not copied), every chunk due for meshing. */
  static fromData(data: WorldData): World {
    const w = new World(data.sizeX, data.sizeY, data.sizeZ, data);
    w.chunkVersion.fill(1);
    return w;
  }

  /** A copy of the voxels and heights, safe to transfer. */
  data(): WorldData {
    const { sizeX, sizeY, sizeZ } = this;
    return {
      sizeX,
      sizeY,
      sizeZ,
      blocks: this.blocks.slice(),
      top: this.top.slice(),
      waterTop: this.waterTop.slice(),
    };
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

  /**
   * Height of the walkable surface at a fractional position, following slopes.
   * With `feet`, finds the floor a body standing at that height is on (so it stays
   * under roofs and on bridges); without, the column's top surface.
   */
  surfaceY(x: number, z: number, feet?: number): number {
    const ix = Math.floor(x), iz = Math.floor(z);
    const h = this.heightAt(ix, iz);
    if (h < 0) return 0;
    // A body buried in solid ground (e.g. an old save on new terrain) climbs to the top.
    const below = feet === undefined ? h : this.floorBelow(ix, iz, Math.floor(feet + 0.5));
    const floor = below < 0 ? h : below;
    if (floor !== h) return floor + 1;
    const mask = this.slopeMask(ix, iz);
    return h + 1 - (mask ? slopeDrop(mask, x - ix, z - iz) : 0);
  }

  /**
   * The highest solid block at or below `maxY` with two non-solid cells above it
   * (room to stand), or -1.
   */
  floorBelow(x: number, z: number, maxY: number): number {
    if (x < 0 || z < 0 || x >= this.sizeX || z >= this.sizeZ) return -1;
    for (let y = Math.min(maxY, this.top[z * this.sizeX + x]); y >= 0; y--) {
      if (
        solid(this.blocks[this.index(x, y, z)]) &&
        !solid(this.get(x, y + 1, z)) && !solid(this.get(x, y + 2, z))
      ) return y;
    }
    return -1;
  }

  /** Water standing above the floor at `floor`, in blocks (0 if dry). */
  waterDepth(x: number, z: number, floor = this.heightAt(x, z)): number {
    if (x < 0 || z < 0 || x >= this.sizeX || z >= this.sizeZ) return 0;
    const w = this.waterTop[z * this.sizeX + x];
    return w > floor ? w - floor : 0;
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
    let water = -1;
    if (y >= 0 && this.blocks[this.index(x, y, z)] === Block.Water) {
      water = y;
      while (y >= 0 && !solid(this.blocks[this.index(x, y, z)])) y--;
    }
    this.top[z * this.sizeX + x] = y;
    this.waterTop[z * this.sizeX + x] = water;
  }

  private touch(x: number, z: number): void {
    if (x < 0 || z < 0 || x >= this.sizeX || z >= this.sizeZ) return;
    this.chunkVersion[Math.floor(z / CHUNK) * this.chunksX + Math.floor(x / CHUNK)]++;
  }
}
