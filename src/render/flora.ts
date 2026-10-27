import { identity, mat4, rotateX, rotateY, rotateZ, scale, translate } from "../math.ts";
import { PROP_DEFS, PropKind, type Props } from "../sim/props.ts";
import { hash2, Rng } from "../sim/rng.ts";
import type { World } from "../sim/world.ts";
import type { InstanceBatch, MeshBuilder, MeshLibrary, Rgb } from "./meshes.ts";

/** Water surfaces sit this far below the top of their water block (see water.ts). */
const SURFACE_DROP = 0.12;

const BARK: Rgb = [0.16, 0.09, 0.05];
const BIRCH_BARK: Rgb = [0.78, 0.76, 0.7];
const BIRCH_MARK: Rgb = [0.06, 0.05, 0.05];
const OAK_LEAF: Rgb = [0.08, 0.19, 0.035];
const BIRCH_LEAF: Rgb = [0.2, 0.32, 0.05];
const PINE_LEAF: Rgb = [0.03, 0.13, 0.05];
const BUSH_LEAF: Rgb = [0.08, 0.2, 0.04];
const STEM: Rgb = [0.12, 0.3, 0.05];
const REED: Rgb = [0.3, 0.36, 0.1];
const CATTAIL: Rgb = [0.18, 0.08, 0.03];
const ROCK: Rgb = [0.17, 0.165, 0.155];
const LILY: Rgb = [0.07, 0.25, 0.05];
const PETALS: Rgb[] = [[0.75, 0.06, 0.05], [0.9, 0.7, 0.05], [0.9, 0.88, 0.82], [0.4, 0.15, 0.7]];

const place = mat4();
const at = (x: number, y: number, z: number) => translate(identity(place), x, y, z);

/** Canopy blobs: lumpy spheres with a darker underside, swaying more toward their tops. */
function canopy(
  b: MeshBuilder,
  r: Rng,
  color: Rgb,
  count: number,
  y: number,
  spread: number,
  size: number,
  stretch = 1,
) {
  for (let i = 0; i < count; i++) {
    const a = r.next() * Math.PI * 2, d = i === 0 ? 0 : spread * (0.5 + r.next() * 0.5);
    const s = size * (0.75 + r.next() * 0.4) * (i === 0 ? 1.15 : 1);
    const k = 0.85 + r.next() * 0.3;
    b.sphere(
      at(Math.cos(a) * d, y + (i === 0 ? 0.3 : r.range(-0.3, 0.4)) * size, Math.sin(a) * d),
      [s, s * 0.85 * stretch, s],
      { color: [color[0] * k, color[1] * k, color[2] * k], sway: [0.5, 1], ao: 0.45, jitter: 0.12 },
      { detail: 1, noise: 0.22, seed: Math.floor(r.next() * 1000) },
    );
  }
}

const builders: Record<number, (b: MeshBuilder, variant: number) => void> = {
  [PropKind.Oak](b, v) {
    const r = new Rng(11 + v * 7);
    const h = 1.9 + v * 0.35;
    b.cylinder(null, 0.2, 0.13, h + 0.6, { color: BARK, sway: [0, 0.15] }, { segments: 7 });
    // A couple of boughs reaching into the canopy.
    for (let i = 0; i < 2; i++) {
      const m = rotateZ(rotateY(at(0, h * 0.7, 0), i * 2.4 + v), 0.8);
      b.cylinder(m, 0.08, 0.05, 0.9, { color: BARK, sway: [0.15, 0.4] }, { segments: 5 });
    }
    canopy(b, r, OAK_LEAF, 4 + v, h + 0.8, 0.85, 0.95);
  },
  [PropKind.Birch](b, v) {
    const r = new Rng(31 + v * 5);
    const h = 2.8 + v * 0.4;
    b.cylinder(null, 0.12, 0.08, h + 0.5, { color: BIRCH_BARK, sway: [0, 0.2] }, { segments: 7 });
    for (let i = 0; i < 5; i++) {
      const y = 0.3 + i * h / 5 + r.next() * 0.2;
      b.cylinder(at(0, y, 0), 0.125, 0.122, 0.05, { color: BIRCH_MARK }, { segments: 7 });
    }
    canopy(b, r, BIRCH_LEAF, 3 + v, h + 0.4, 0.5, 0.7, 1.5);
  },
  [PropKind.Pine](b, v) {
    const h = 0.9 + v * 0.2;
    b.cylinder(null, 0.17, 0.1, h + 0.5, { color: BARK, sway: [0, 0.1] }, { segments: 6 });
    const tiers = 4 + (v > 1 ? 1 : 0);
    for (let i = 0; i < tiers; i++) {
      const t = i / tiers;
      const radius = 1.25 * (1 - t * 0.75), height = 1.5 * (1 - t * 0.35);
      const k = 0.85 + (i % 2) * 0.2;
      b.cone(
        at(0, h + i * 0.85, 0),
        radius,
        height,
        {
          color: [PINE_LEAF[0] * k, PINE_LEAF[1] * k, PINE_LEAF[2] * k],
          sway: [0.2 + t * 0.6, 0.5 + t * 0.5],
          ao: 0.5,
        },
        { segments: 9 },
      );
    }
  },
  [PropKind.Bush](b, v) {
    const r = new Rng(51 + v * 3);
    for (let i = 0; i < 2 + v; i++) {
      const a = r.next() * Math.PI * 2, d = i ? 0.25 : 0;
      const s = 0.38 + r.next() * 0.15;
      b.sphere(at(Math.cos(a) * d, s * 0.6, Math.sin(a) * d), [s, s * 0.8, s], {
        color: BUSH_LEAF,
        sway: [0.1, 0.5],
        ao: 0.5,
        jitter: 0.12,
      }, { detail: 1, noise: 0.25, seed: i + v * 10 });
    }
  },
  [PropKind.Flowers](b, v) {
    const r = new Rng(71 + v);
    for (let i = 0; i < 6; i++) {
      const x = r.range(-0.35, 0.35), z = r.range(-0.35, 0.35), h = r.range(0.22, 0.42);
      const tilt = rotateX(rotateY(at(x, 0, z), r.next() * 6), r.range(-0.2, 0.2));
      b.cylinder(tilt, 0.012, 0.01, h, { color: STEM, sway: [0, 1] }, { segments: 3, caps: false });
      const head = translate(tilt, 0, h, 0);
      const petal = PETALS[v % PETALS.length];
      b.box(head, [0.09, 0.04, 0.09], { color: petal, sway: 1 });
    }
  },
  [PropKind.Reeds](b, v) {
    const r = new Rng(91 + v);
    for (let i = 0; i < 8; i++) {
      const x = r.range(-0.3, 0.3), z = r.range(-0.3, 0.3), h = r.range(0.7, 1.3);
      const m = rotateZ(rotateY(at(x, 0, z), r.next() * 6), r.range(-0.12, 0.12));
      b.cone(m, 0.035, h, { color: REED, sway: [0, 1], ao: 0.4 }, { segments: 3, caps: false });
      if (i % 3 === v) {
        b.cylinder(translate(m, 0, h * 0.6, 0), 0.04, 0.04, 0.16, { color: CATTAIL, sway: 0.7 }, {
          segments: 4,
        });
      }
    }
  },
  [PropKind.Rock](b, v) {
    const s = 0.35 + v * 0.15;
    b.sphere(at(0, s * 0.25, 0), [s, s * 0.6, s * 0.85], { color: ROCK, ao: 0.3, jitter: 0.1 }, {
      detail: 1,
      noise: 0.3,
      seed: 5 + v,
      flat: true,
    });
  },
  [PropKind.LilyPad](b, v) {
    const r = new Rng(111 + v);
    for (let i = 0; i < 3; i++) {
      const pad = rotateY(at(r.range(-0.3, 0.3), 0, r.range(-0.3, 0.3)), r.next() * 6);
      b.cylinder(pad, 0.2, 0.2, 0.02, { color: LILY, sway: 0.15 }, { segments: 7 });
      if (v === 1 && i === 0) {
        b.sphere(translate(pad, 0, 0.05, 0), [0.07, 0.05, 0.07], { color: [0.9, 0.5, 0.6] }, {
          detail: 0,
          flat: true,
        });
      }
    }
  },
};

/** Template ids for props, indexed [kind][variant]. */
export type FloraModels = number[][];

export function defineFloraModels(lib: MeshLibrary): FloraModels {
  return PROP_DEFS.map((def, kind) => {
    const ids: number[] = [];
    for (let v = 0; v < def.variants; v++) {
      ids.push(lib.define(`${def.name}.${v}`, (b) => builders[kind]?.(b, v)));
    }
    return ids;
  });
}

const m = mat4();

/** Small ground cover that casts no shadow and is only drawn near the camera. */
export const isSmall = (kind: number) =>
  kind === PropKind.Flowers || kind === PropKind.Reeds || kind === PropKind.LilyPad;

/**
 * Fill the batches with every prop (big ones in `out`, ground cover in `small`): jittered within
 * its tile, turned and sized per tile, grown.
 */
export function buildProps(
  props: Props,
  world: World,
  tick: number,
  out: InstanceBatch,
  small: InstanceBatch,
  ids: FloraModels,
) {
  out.clear();
  small.clear();
  const w = world.sizeX;
  for (const [key, p] of props.map) {
    const tid = ids[p.kind]?.[p.variant];
    if (tid === undefined) continue;
    const tx = key % w, tz = Math.floor(key / w);
    const jx = hash2(tx, tz, 1) - 0.5, jz = hash2(tx, tz, 2) - 0.5;
    const big = PROP_DEFS[p.kind].solid;
    const x = tx + 0.5 + jx * (big ? 0.3 : 0.5), z = tz + 0.5 + jz * (big ? 0.3 : 0.5);
    const water = world.waterTop[key];
    const y = p.kind === PropKind.LilyPad && water >= 0
      ? water + 1 - SURFACE_DROP
      : world.surfaceY(x, z) - (big ? 0.15 : 0.02);
    const size = (0.85 + hash2(tx, tz, 3) * 0.3) * (0.15 + 0.85 * props.growth(p, tick));
    identity(m);
    translate(m, x, y, z);
    rotateY(m, hash2(tx, tz, 4) * Math.PI * 2);
    scale(m, size, size, size);
    (isSmall(p.kind) ? small : out).add(tid, m, 1, 1, 1, p.kind === PropKind.Rock ? 0 : 1);
  }
}

/** Whether any prop is still growing (so the batch needs refreshing now and then). */
export function anyGrowing(props: Props, tick: number): boolean {
  for (const p of props.map.values()) if (props.growth(p, tick) < 1) return true;
  return false;
}
