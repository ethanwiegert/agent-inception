import { CHUNK, slopeDrop, slopes, solid, World } from "../sim/world.ts";

/**
 * Culled-face voxel mesher with per-vertex ambient occlusion and smooth ground normals.
 *
 * Each vertex is two u32s:
 *   word 0: bits 0-5 local x, 6-12 y, 13-18 local z, 19-21 face, 22-23 AO, 24-31 block id
 *   word 1: normal as snorm8 x, y, z (byte 3 unused)
 * Quads are 4 vertices drawn with a shared index buffer (0 1 2, 0 2 3).
 *
 * Natural ground slopes: a column's top block lowers the corners in its slope mask by one,
 * which bends its top face into a ramp and shrinks the side faces beneath those corners.
 * Ground tops get normals from the surrounding surface so hills shade smoothly; water is
 * left out (it has its own renderer).
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
const PAD = CHUNK + 2;

let scratch = new Uint32Array(1 << 17);
/** Surface height at column centers for the chunk plus a one-column border. */
const centers = new Float32Array(PAD * PAD);
/** Per padded column: how many cells from the bottom up are solid without a gap. */
const solidRun = new Int16Array(PAD * PAD);
/** Per padded column: top solid height and slope mask. */
const tops = new Int16Array(PAD * PAD);
const masks = new Uint8Array(PAD * PAD);

const snorm8 = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 127) & 255;
const packNormal = (x: number, y: number, z: number) =>
  (snorm8(x) | (snorm8(y) << 8) | (snorm8(z) << 16)) >>> 0;
const AXIS_NORMALS = FACES.map(([n]) => packNormal(n[0], n[1], n[2]));

/** Mesh one chunk column. Returns a view into shared scratch memory; copy it before the next call. */
export function meshChunk(world: World, cx: number, cz: number): Uint32Array {
  let n = 0;
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const { blocks, sizeX, sizeY, sizeZ } = world;
  const blockAt = (x: number, y: number, z: number) =>
    x < 0 || y < 0 || z < 0 || x >= sizeX || y >= sizeY || z >= sizeZ
      ? 0
      : blocks[(y * sizeZ + z) * sizeX + x];
  const isSolid = (x: number, y: number, z: number) => solid(blockAt(x, y, z)) ? 1 : 0;
  // A sloping column top doesn't shade the ground it ramps down onto. Only top faces ask, and
  // they never look further than the padded border.
  const occludes = (x: number, y: number, z: number) => {
    const b = blockAt(x, y, z);
    if (!solid(b)) return 0;
    const k = (z - z0 + 1) * PAD + x - x0 + 1;
    return y === tops[k] && slopes(b) && masks[k] ? 0 : 1;
  };
  for (let j = 0; j < PAD; j++) {
    for (let i = 0; i < PAD; i++) {
      const x = x0 + i - 1, z = z0 + j - 1;
      const top = world.heightAt(x, z);
      tops[j * PAD + i] = top;
      const mask = top >= 0 ? world.slopeMask(x, z) : 0;
      masks[j * PAD + i] = mask;
      // The column's walkable surface at its center (World.surfaceY, from the mask in hand).
      centers[j * PAD + i] = top < 0 ? NaN : top + 1 - (mask ? slopeDrop(mask, 0.5, 0.5) : 0);
      let run = 0;
      while (run <= top && solid(blockAt(x, run, z))) run++;
      solidRun[j * PAD + i] = run;
    }
  }
  /** Smooth normal at world corner (X, Z) of height y, from the four column centers around it. */
  const cornerNormal = (X: number, Z: number, y: number) => {
    const i = X - x0, j = Z - z0; // padded index of the column just west/north of the corner
    // Cliffs and the world edge count as level ground so they don't tilt the top.
    const h = (a: number, b: number) => {
      const v = centers[b * PAD + a];
      return Number.isNaN(v) || Math.abs(v - y) > 1.25 ? y : v;
    };
    const h00 = h(i, j), h10 = h(i + 1, j), h01 = h(i, j + 1), h11 = h(i + 1, j + 1);
    const gx = (h10 + h11 - h00 - h01) * 0.5, gz = (h01 + h11 - h00 - h10) * 0.5;
    const len = Math.hypot(gx, 1, gz);
    return packNormal(-gx / len, 1 / len, -gz / len);
  };
  const ao = [0, 0, 0, 0];
  const vy = [0, 0, 0, 0];
  const nw = [0, 0, 0, 0];

  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const x = x0 + lx, z = z0 + lz;
      const c = (lz + 1) * PAD + lx + 1;
      const top = tops[c];
      const mask = masks[c];
      // Below this every block has solid on all six sides (or the world floor): no faces.
      const buried = Math.min(
        solidRun[c] - 1,
        solidRun[c - 1],
        solidRun[c + 1],
        solidRun[c - PAD],
        solidRun[c + PAD],
      );
      for (let y = Math.max(0, buried); y <= top; y++) {
        const block = blockAt(x, y, z);
        if (!solid(block)) continue;
        const isTop = y === top;
        const sloped = mask !== 0 && isTop;
        const smooth = isTop && slopes(block);

        for (let f = 0; f < 6; f++) {
          const [nrm, u, v] = FACES[f];
          const ax = x + nrm[0], ay = y + nrm[1], az = z + nrm[2];
          if (ay < 0 || isSolid(ax, ay, az)) continue;

          // Corner heights, lowered where the slope mask sinks the column's top corners.
          const px = lx + (nrm[0] > 0 ? 1 : 0);
          const py = y + (nrm[1] > 0 ? 1 : 0);
          const pz = lz + (nrm[2] > 0 ? 1 : 0);
          let sunk = 0;
          for (let c = 0; c < 4; c++) {
            const [cu, cv] = CORNERS[c];
            const cy = py + u[1] * cu + v[1] * cv;
            const xo = px + u[0] * cu + v[0] * cv - lx, zo = pz + u[2] * cu + v[2] * cv - lz;
            let drop = 0;
            if (sloped && cy === y + 1) {
              drop = (mask >> (xo + 2 * zo)) & 1;
              sunk += drop;
            }
            vy[c] = cy - drop;
            nw[c] = f === 2 && smooth ? cornerNormal(x + xo, z + zo, vy[c]) : AXIS_NORMALS[f];
          }
          // A side face whose whole top edge sank has no area left.
          if (f !== 2 && sunk === 2) continue;

          const shade = f === 2 ? occludes : isSolid;
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

          if (n + 8 > scratch.length) {
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
            scratch[n++] = nw[c];
          }
        }
      }
    }
  }
  return scratch.subarray(0, n);
}
