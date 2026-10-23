export const Block = {
  Air: 0,
  Grass: 1,
  Dirt: 2,
  Stone: 3,
  Farmland: 4,
} as const;
export type BlockId = number;

/** Names agents use for blocks, and the reverse lookup. */
export const BLOCK_NAMES: Record<number, string> = {
  [Block.Air]: "air",
  [Block.Grass]: "grass",
  [Block.Dirt]: "dirt",
  [Block.Stone]: "stone",
  [Block.Farmland]: "farmland",
};

export const CHUNK = 32;

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
    this.touch(x, z);
    // Faces and AO on chunk borders depend on neighbours.
    if (x % CHUNK === 0) this.touch(x - 1, z);
    if (x % CHUNK === CHUNK - 1) this.touch(x + 1, z);
    if (z % CHUNK === 0) this.touch(x, z - 1);
    if (z % CHUNK === CHUNK - 1) this.touch(x, z + 1);
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
