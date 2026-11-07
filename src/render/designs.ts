import { identity, mat4, rotateX, rotateY, scale, translate } from "../math.ts";
import {
  type Catalog,
  type DesignContent,
  type DesignPart,
  deviceKind,
  type MaterialContent,
  type Role,
  shapeOf,
  type Vec3,
} from "../sim/catalog.ts";
import { hash2 } from "../sim/rng.ts";
import type { MeshBuilder, Rgb, Style } from "./meshes.ts";

/**
 * Designs as meshes: every part becomes a primitive in its Material's look. The Material decides
 * the color, the surface (leaves and fleece are lumpy, stone is lumpy and faceted) and how much it
 * bends in the wind (soft things bend, hard things don't, more toward the top of the Design).
 * Designs stand on their first cell, so (0.5, 0, 0.5) lands on the template origin.
 */

export const ANCHOR: Vec3 = [0.5, 0, 0.5];
const DEG = Math.PI / 180;

const srgbToLinear = (c: number) => Math.pow(c / 255, 2.2);
export function materialRgb(hex: string): Rgb {
  const c = parseInt(hex.slice(1), 16);
  return [srgbToLinear(c >> 16), srgbToLinear((c >> 8) & 255), srgbToLinear(c & 255)];
}

export interface MeshOptions {
  /** Only the parts with this role (undefined: the parts without a role; null: all parts). */
  role?: Role | null;
  /** Only the parts this accepts (instead of `role`), by part and its index. */
  only?: (p: DesignPart, i: number) => boolean;
  /** The point that becomes the template origin; ANCHOR by default. */
  origin?: Vec3;
  /** Bodies hold still in the wind; plants sway. */
  sway?: boolean;
  /** Colors to use instead of a Material's own, by Material name. */
  colors?: Map<string, Rgb>;
}

const m = mat4();

/** Baked surface grain per pattern: amplitude and noise frequency (a small y makes streaks). */
const GRAIN: Record<string, { grain: number; scale: readonly [number, number, number] }> = {
  leaves: { grain: 0.3, scale: [9, 9, 9] },
  log: { grain: 0.34, scale: [6, 0.7, 6] },
  fleece: { grain: 0.3, scale: [12, 12, 12] },
  stone: { grain: 0.24, scale: [10, 10, 10] },
  cobble: { grain: 0.24, scale: [9, 9, 9] },
  dirt: { grain: 0.18, scale: [8, 8, 8] },
  farmland: { grain: 0.18, scale: [8, 8, 8] },
  planks: { grain: 0.16, scale: [5, 1.2, 5] },
  bricks: { grain: 0.14, scale: [8, 8, 8] },
  thatch: { grain: 0.2, scale: [7, 2, 7] },
  tiles: { grain: 0.14, scale: [8, 8, 8] },
  sand: { grain: 0.12, scale: [9, 9, 9] },
  grass: { grain: 0.14, scale: [8, 8, 8] },
  plain: { grain: 0.07, scale: [10, 10, 10] },
};

/** Add `design`'s parts to `b`. Returns how many parts it drew. */
export function meshDesign(
  b: MeshBuilder,
  catalog: Catalog,
  design: DesignContent,
  o: MeshOptions = {},
): number {
  const origin = o.origin ?? ANCHOR;
  let top = 0.01;
  for (const p of design.parts) top = Math.max(top, p.at[1] + p.size[1] / 2);
  let drawn = 0;
  design.parts.forEach((p, i) => {
    if (o.only ? !o.only(p, i) : o.role !== null && p.role !== o.role) return;
    // Flames are drawn as fire (render/particles.ts), not as their Material.
    if (deviceKind(p.part) === "flame") return;
    const mat = catalog.byName(p.material)?.content as MaterialContent | undefined;
    if (!mat) return;
    meshPart(b, p, i, mat, o.colors?.get(p.material), origin, o.sway === false ? 0 : top);
    drawn++;
  });
  return drawn;
}

/** The pivot a role turns about: its joint, or the top middle of its parts (the base for heads). */
export function jointOf(design: DesignContent, role: Role): Vec3 {
  const j = design.joints?.[role];
  if (j) return j;
  const parts = design.parts.filter((p) => p.role === role);
  if (!parts.length) return ANCHOR;
  let x = 0, z = 0, lo = Infinity, hi = -Infinity;
  for (const p of parts) {
    x += p.at[0], z += p.at[2];
    lo = Math.min(lo, p.at[1] - p.size[1] / 2), hi = Math.max(hi, p.at[1] + p.size[1] / 2);
  }
  return [x / parts.length, role === "head" ? lo : hi, z / parts.length];
}

function meshPart(
  b: MeshBuilder,
  p: DesignPart,
  index: number,
  mat: MaterialContent,
  override: Rgb | undefined,
  origin: Vec3,
  /** Design height for the wind gradient, or 0 to hold still. */
  top: number,
) {
  const [sx, sy, sz] = p.size;
  const lumpy = mat.pattern === "leaves" || mat.pattern === "fleece";
  const rocky = mat.pattern === "stone" || mat.pattern === "cobble";
  // Clumps of leaves vary a little in shade from part to part.
  const k = mat.pattern === "leaves" ? 0.78 + hash2(index, 7, 31) * 0.44 : 1;
  const base = override ?? materialRgb(mat.color);
  const bend = top ? Math.max(0, Math.min(1, 1 - mat.hardness / 4)) : 0;
  const lo = Math.max(0, (p.at[1] - sy / 2) / top), hi = Math.min(1, (p.at[1] + sy / 2) / top);
  const gr = GRAIN[mat.pattern] ?? GRAIN.plain;
  const style: Style = {
    color: [base[0] * k, base[1] * k, base[2] * k],
    sway: [lo * bend, hi * bend],
    ao: lumpy ? 0.38 : rocky ? 0.3 : 0.25,
    jitter: mat.pattern === "leaves"
      ? 0.12
      : mat.pattern === "log"
      ? 0.08
      : lumpy
      ? 0.06
      : rocky
      ? 0.08
      : 0,
    grain: gr.grain,
    grainScale: gr.scale,
    // A lamp shines while its Object's lights are on; a glowing Material always does.
    glow: deviceKind(p.part) === "lamp" ? -Math.max(0.8, mat.glows ?? 0) : mat.glows ?? 0,
  };

  identity(m);
  translate(m, p.at[0] - origin[0], p.at[1] - origin[1], p.at[2] - origin[2]);
  rotateY(m, p.turn * DEG);
  rotateX(m, p.tilt * DEG);
  const thin = Math.min(sx, sz);
  const shape = shapeOf(p.part);
  // Small parts stay low-poly (they're pixels on screen); anything bigger gets a smooth sphere.
  const big = Math.max(sx, sy, sz);
  const detail = big < 0.08 ? 0 : big < 0.2 ? 1 : big < 0.7 ? 2 : 3;
  switch (shape) {
    case "box":
      b.box(m, p.size, style, Math.min(0.16, 0.4 * Math.min(sx, sy, sz)));
      break;
    case "sphere":
      b.sphere(m, [sx / 2, sy / 2, sz / 2], style, {
        detail,
        noise: mat.pattern === "leaves" ? 0.3 : mat.pattern === "fleece" ? 0.15 : rocky ? 0.3 : 0,
        seed: index * 13 + 5,
        flat: rocky,
      });
      break;
    case "cylinder":
    case "cone": {
      // Unit primitives grown from y = 0, stretched to the part's size around its center.
      translate(m, 0, -sy / 2, 0);
      scale(m, sx, sy, sz);
      const segments = thin < 0.05 ? 4 : thin < 0.15 ? 8 : thin < 0.4 ? 12 : thin < 0.8 ? 16 : 20;
      const opts = { segments, caps: thin >= 0.06 };
      if (shape === "cone") b.cone(m, 0.5, 1, style, opts);
      else b.cylinder(m, 0.5, 0.5, 1, style, opts);
      break;
    }
  }
}
