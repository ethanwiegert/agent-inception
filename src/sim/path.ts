import type { World } from "./world.ts";

/** Bodies can climb one block and drop two. */
export const MAX_STEP_UP = 1;
export const MAX_STEP_DOWN = 2;

export function canStep(world: World, fx: number, fz: number, tx: number, tz: number): boolean {
  const from = world.heightAt(fx, fz), to = world.heightAt(tx, tz);
  if (from < 0 || to < 0) return false;
  return to - from <= MAX_STEP_UP && from - to <= MAX_STEP_DOWN;
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// Search scratch, reused across calls. `stamp` marks which entries belong to the current search.
let stamp = new Uint32Array(0);
let gScore = new Float32Array(0);
let cameFrom = new Int32Array(0);
let closed = new Uint32Array(0);
let generation = 0;

/**
 * A* over terrain columns with octile moves. Diagonals need both adjacent
 * cardinal steps to be walkable so bodies never clip cliff corners.
 * Returns the cells to visit as flat [x, z, x, z, ...] excluding the start,
 * or null if unreachable within `maxNodes` expansions.
 */
export function findPath(
  world: World,
  sx: number,
  sz: number,
  goal: (x: number, z: number) => boolean,
  heuristic: (x: number, z: number) => number,
  maxNodes = 8000,
): number[] | null {
  const w = world.sizeX, n = world.sizeX * world.sizeZ;
  if (stamp.length !== n) {
    stamp = new Uint32Array(n);
    gScore = new Float32Array(n);
    cameFrom = new Int32Array(n);
    closed = new Uint32Array(n);
    generation = 0;
  }
  generation++;
  const start = sz * w + sx;
  const heap = new MinHeap();
  stamp[start] = generation;
  gScore[start] = 0;
  cameFrom[start] = -1;
  heap.push(start, heuristic(sx, sz));

  let expanded = 0;
  while (heap.size > 0 && expanded++ < maxNodes) {
    const cur = heap.pop();
    if (closed[cur] === generation) continue;
    closed[cur] = generation;
    const cx = cur % w, cz = (cur / w) | 0;
    if (goal(cx, cz)) {
      const path: number[] = [];
      for (let c = cur; c !== start; c = cameFrom[c]) path.push(c % w, (c / w) | 0);
      // Reverse pairs in place.
      for (let i = 0, j = path.length - 2; i < j; i += 2, j -= 2) {
        [path[i], path[i + 1], path[j], path[j + 1]] = [path[j], path[j + 1], path[i], path[i + 1]];
      }
      return path;
    }
    for (const [dx, dz] of DIRS) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= w || nz >= world.sizeZ) continue;
      if (!canStep(world, cx, cz, nx, nz)) continue;
      if (dx && dz && (!canStep(world, cx, cz, nx, cz) || !canStep(world, cx, cz, cx, nz))) {
        continue;
      }
      const next = nz * w + nx;
      if (closed[next] === generation) continue;
      const g = gScore[cur] + (dx && dz ? Math.SQRT2 : 1);
      if (stamp[next] === generation && g >= gScore[next]) continue;
      stamp[next] = generation;
      gScore[next] = g;
      cameFrom[next] = cur;
      heap.push(next, g + heuristic(nx, nz));
    }
  }
  return null;
}

export const octile = (tx: number, tz: number) => (x: number, z: number) => {
  const dx = Math.abs(x - tx), dz = Math.abs(z - tz);
  return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
};

class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.items.length;
  }
  push(item: number, key: number) {
    const { items, keys } = this;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      items[i] = items[p], keys[i] = keys[p];
      i = p;
    }
    items[i] = item, keys[i] = key;
  }
  pop(): number {
    const { items, keys } = this;
    const top = items[0];
    const item = items.pop()!, key = keys.pop()!;
    if (items.length > 0) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i, mk = key;
        if (l < items.length && keys[l] < mk) m = l, mk = keys[l];
        if (r < items.length && keys[r] < mk) m = r, mk = keys[r];
        if (m === i) break;
        items[i] = items[m], keys[i] = keys[m];
        i = m;
      }
      items[i] = item, keys[i] = key;
    }
    return top;
  }
}
