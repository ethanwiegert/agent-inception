import { Block, CHUNK, slopes, World } from "../sim/world.ts";

/**
 * Culled-face voxel mesher with per-vertex ambient occlusion.
 *
 * Each vertex is one u32:
 *   bits 0-5 local x, 6-12 y, 13-18 local z, 19-21 face, 22-23 AO, 24-31 block id.
 * Quads are 4 vertices drawn with a shared index buffer (0 1 2, 0 2 3).
 *
 * Natural ground slopes: a column's top block lowers the corners in its slope mask by one,
 * which bends its top face into a ramp and shrinks the side faces beneath those corners.
 */

// Per face: normal, u axis, v axis with cross(u, v) = normal, so corners
// (0,0) (1,0) (1,1) (0,1) wind counter-clockwise seen from outside.
const FACES: ReadonlyArray<readonly [number[], number[], number[]]> = [
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
];
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

let scratch = new Uint32Array(1 << 16);

/** Mesh one chunk column. Returns a view into shared scratch memory; copy it before the next call. */
export function meshChunk(world: World, cx: number, cz: number): Uint32Array {
  let n = 0;
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const solid = (x: number, y: number, z: number) => world.get(x, y, z) !== Block.Air ? 1 : 0;
  // A sloping column top doesn't shade the ground it ramps down onto.
  const occludes = (x: number, y: number, z: number) => {
    const b = world.get(x, y, z);
    if (b === Block.Air) return 0;
    return y === world.heightAt(x, z) && slopes(b) && world.slopeMask(x, z) ? 0 : 1;
  };
  const ao = [0, 0, 0, 0];
  const vy = [0, 0, 0, 0];

  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const x = x0 + lx, z = z0 + lz;
      const top = world.heightAt(x, z);
      const mask = world.slopeMask(x, z);
      for (let y = 0; y <= top; y++) {
        const block = world.get(x, y, z);
        if (block === Block.Air) continue;
        const sloped = mask !== 0 && y === top;

        for (let f = 0; f < 6; f++) {
          const [nrm, u, v] = FACES[f];
          const ax = x + nrm[0], ay = y + nrm[1], az = z + nrm[2];
          if (ay < 0 || solid(ax, ay, az)) continue;

          // Corner heights, lowered where the slope mask sinks the column's top corners.
          const px = lx + (nrm[0] > 0 ? 1 : 0);
          const py = y + (nrm[1] > 0 ? 1 : 0);
          const pz = lz + (nrm[2] > 0 ? 1 : 0);
          let sunk = 0;
          for (let c = 0; c < 4; c++) {
            const [cu, cv] = CORNERS[c];
            const cy = py + u[1] * cu + v[1] * cv;
            let drop = 0;
            if (sloped && cy === y + 1) {
              const xo = px + u[0] * cu + v[0] * cv - lx, zo = pz + u[2] * cu + v[2] * cv - lz;
              drop = (mask >> (xo + 2 * zo)) & 1;
              sunk += drop;
            }
            vy[c] = cy - drop;
          }
          // A side face whose whole top edge sank has no area left.
          if (f !== 2 && sunk === 2) continue;

          const shade = f === 2 ? occludes : solid;
          for (let c = 0; c < 4; c++) {
            const su = CORNERS[c][0] * 2 - 1, sv = CORNERS[c][1] * 2 - 1;
            const s1 = shade(ax + u[0] * su, ay + u[1] * su, az + u[2] * su);
            const s2 = shade(ax + v[0] * sv, ay + v[1] * sv, az + v[2] * sv);
            const sc = shade(
              ax + u[0] * su + v[0] * sv,
              ay + u[1] * su + v[1] * sv,
              az + u[2] * su + v[2] * sv,
            );
            ao[c] = s1 && s2 ? 0 : 3 - (s1 + s2 + sc);
          }

          if (n + 4 > scratch.length) {
            const grown = new Uint32Array(scratch.length * 2);
            grown.set(scratch);
            scratch = grown;
          }
          // Sloped tops split along the diagonal whose corners agree (matching slopeDrop);
          // everything else flips the diagonal so AO interpolates without a crease.
          // Top-face corners 0 and 2 are (x0,z0) and (x1,z1).
          const start = sloped && f === 2
            ? (mask & 1) === ((mask >> 3) & 1) ? 0 : 1
            : ao[0] + ao[2] < ao[1] + ao[3]
            ? 1
            : 0;
          for (let i = 0; i < 4; i++) {
            const c = (start + i) & 3;
            const [cu, cv] = CORNERS[c];
            const vx = px + u[0] * cu + v[0] * cv;
            const vz = pz + u[2] * cu + v[2] * cv;
            scratch[n++] = (vx | (vy[c] << 6) | (vz << 13) | (f << 19) | (ao[c] << 22) |
              (block << 24)) >>> 0;
          }
        }
      }
    }
  }
  return scratch.subarray(0, n);
}
