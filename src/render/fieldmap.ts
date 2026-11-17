import { hash2 } from "../sim/rng.ts";
import type { Props } from "../sim/props.ts";
import type { World } from "../sim/world.ts";
import type { SurfaceTexture } from "./surface.ts";

/** How far the shore-distance channel reaches either side of the waterline, in blocks. */
const SHORE_REACH = 8;
/** Slowest the map may rebuild: a quarter second of sim ticks between builds. */
const REBUILD_TICKS = 5;

/**
 * A world-sized map of things the forward passes need to know about a column's
 * surroundings, rebuilt a few times a second on the CPU (never per frame):
 *   r: sky occlusion — how much open sky a patch of ground sees, darkened under
 *      every tree and bush crown and at the foot of cliffs and walls;
 *   g: shore distance — signed distance to the nearest water/land boundary,
 *      0.5 at the waterline, ±`SHORE_REACH` blocks mapped to 0-1.
 * Bound as frame group binding 5 so terrain, the grass compute, crops and water
 * all read it; feed the ambient term and the meadow's lush/dry drift from r,
 * the wet band and shore foam from g.
 */
export class FieldMap {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
  /** Bumps on every rebuild. */
  version = 0;
  private data: Uint8Array;
  private occ: Float32Array;
  private scratch: Float32Array;
  private seenSurface = -1;
  private seenProps = -1;
  private builtTick = -REBUILD_TICKS;
  /** True while any prop's crown is still growing — growth tracks the tick, not the
   * props version, so the map keeps refreshing until every tree is full size. */
  private growing = false;

  constructor(private device: GPUDevice, private world: World) {
    this.texture = device.createTexture({
      size: [world.sizeX, world.sizeZ],
      format: "rg8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.view = this.texture.createView();
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const n = world.sizeX * world.sizeZ;
    this.data = new Uint8Array(n * 2);
    this.occ = new Float32Array(n);
    this.scratch = new Float32Array(n);
  }

  /**
   * Rebuild when the surface columns or the props moved, at most a few times a
   * second (`REBUILD_TICKS` apart), then upload the whole texture.
   */
  update(surface: SurfaceTexture, props: Props | null, tick: number) {
    if (
      !this.growing &&
      surface.version === this.seenSurface &&
      (props?.version ?? -1) === this.seenProps
    ) return;
    if (tick - this.builtTick < REBUILD_TICKS && this.builtTick >= 0) return;
    this.seenSurface = surface.version;
    this.seenProps = props?.version ?? -1;
    this.builtTick = tick;
    this.build(surface.texels, props, tick);
    this.device.queue.writeTexture(
      { texture: this.texture },
      this.data,
      { bytesPerRow: this.world.sizeX * 2 },
      [this.world.sizeX, this.world.sizeZ],
    );
    this.version++;
  }

  private build(texels: Uint16Array, props: Props | null, tick: number) {
    const { sizeX: w, sizeZ: h } = this.world;
    const occ = this.occ;

    // Sky occlusion: the horizon each column sees. A cliff or wall a few blocks
    // over eats sky in its direction; the mean over 8 directions is the share
    // of the dome that's open.
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const c = z * w + x, top = texels[c * 4];
        let lost = 0;
        for (let k = 0; k < 8; k++) {
          const dx = DIRS[k * 2], dz = DIRS[k * 2 + 1];
          let horizon = 0;
          for (const d of [1, 2, 4]) {
            const nx = x + dx * d, nz = z + dz * d;
            if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
            horizon = Math.max(horizon, (texels[(nz * w + nx) * 4] - top) / d);
          }
          lost += Math.min(1, horizon * 0.42);
        }
        occ[c] = 1 - lost / 8;
      }
    }

    // Crown shade: a soft disc under every tree and bush, sized by its growth.
    let stillGrowing = false;
    if (props) {
      for (const [key, p] of props.map) {
        const info = props.info(p);
        if (!info || info.floats) continue;
        const big = info.solid;
        if (!big && info.small) continue;
        const tx = key % w, tz = Math.floor(key / w);
        const size = 0.85 + hash2(tx, tz, 3) * 0.3;
        const g01 = props.growth(p, tick);
        if (g01 < 1) stillGrowing = true;
        const growth = 0.15 + 0.85 * g01;
        const radius = (big ? 1.2 + 1.8 : 0.7 + 0.8) * size * growth;
        const weight = big ? 0.5 : 0.3;
        const cx = tx + 0.5 + (hash2(tx, tz, 1) - 0.5) * (big ? 0.3 : 0.5);
        const cz = tz + 0.5 + (hash2(tx, tz, 2) - 0.5) * (big ? 0.3 : 0.5);
        const r = Math.ceil(radius);
        const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
        const z0 = Math.max(0, Math.floor(cz - r)), z1 = Math.min(h - 1, Math.ceil(cz + r));
        for (let z = z0; z <= z1; z++) {
          for (let x = x0; x <= x1; x++) {
            const d2 = (x + 0.5 - cx) ** 2 + (z + 0.5 - cz) ** 2;
            if (d2 >= radius * radius) continue;
            occ[z * w + x] *= 1 - weight * (1 - d2 / (radius * radius));
          }
        }
      }
    }
    this.growing = stillGrowing;

    // One separable blur (radius 2) so the shade pools instead of stepping.
    const blur = this.scratch;
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        let s = 0, m = 0;
        for (let k = -2; k <= 2; k++) {
          const nx = x + k;
          if (nx < 0 || nx >= w) continue;
          s += occ[z * w + nx];
          m++;
        }
        blur[z * w + x] = s / m;
      }
    }
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        let s = 0, m = 0;
        for (let k = -2; k <= 2; k++) {
          const nz = z + k;
          if (nz < 0 || nz >= h) continue;
          s += blur[nz * w + x];
          m++;
        }
        occ[z * w + x] = s / m;
      }
    }

    // Shore distance: chamfer from every water/land boundary cell, signed
    // (land positive, water negative), mapped ±SHORE_REACH into 0-1.
    const dist = blur;
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const c = z * w + x;
        const water = texels[c * 4 + 3] > 0;
        let boundary = false;
        for (let k = 0; k < 4; k++) {
          const nx = x + DIRS[k * 2], nz = z + DIRS[k * 2 + 1];
          if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
          if ((texels[(nz * w + nx) * 4 + 3] > 0) !== water) boundary = true;
        }
        dist[c] = boundary ? 0 : 1e9;
      }
    }
    chamfer(dist, w, h, true);
    chamfer(dist, w, h, false);
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const c = z * w + x;
        const signed = texels[c * 4 + 3] > 0 ? -dist[c] : dist[c];
        const g = Math.min(1, Math.max(0, 0.5 + signed / (SHORE_REACH * 2)));
        this.data[c * 2] = Math.round(occ[c] * 255);
        this.data[c * 2 + 1] = Math.round(g * 255);
      }
    }
  }

  destroy() {
    this.texture.destroy();
  }
}

const DIRS = [-1, 0, 1, 0, 0, -1, 0, 1, -1, -1, 1, -1, -1, 1, 1, 1];

/** Two-raster chamfer pass (forward or backward), 1 / √2 weights. */
function chamfer(dist: Float32Array, w: number, h: number, forward: boolean) {
  const z0 = forward ? 0 : h - 1, z1 = forward ? h : -1, dz = forward ? 1 : -1;
  const x0 = forward ? 0 : w - 1, x1 = forward ? w : -1, dx = forward ? 1 : -1;
  for (let z = z0; z !== z1; z += dz) {
    for (let x = x0; x !== x1; x += dx) {
      const c = z * w + x;
      let d = dist[c];
      for (let k = 0; k < 8; k++) {
        const nx = x + DIRS[k * 2], nz = z + DIRS[k * 2 + 1];
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const step = k < 4 ? 1 : 1.4142;
        d = Math.min(d, dist[nz * w + nx] + step);
      }
      dist[c] = d;
    }
  }
}
