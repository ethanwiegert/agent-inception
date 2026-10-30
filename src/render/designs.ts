import { identity, mat4, rotateX, rotateY, scale, translate } from "../math.ts";
import {
  type Catalog,
  type DesignContent,
  type DesignPart,
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
  const k = mat.pattern === "leaves" ? 0.85 + hash2(index, 7, 31) * 0.3 : 1;
  const base = override ?? materialRgb(mat.color);
  const bend = top ? Math.max(0, Math.min(1, 1 - mat.hardness / 4)) : 0;
  const lo = Math.max(0, (p.at[1] - sy / 2) / top), hi = Math.min(1, (p.at[1] + sy / 2) / top);
  const style: Style = {
    color: [base[0] * k, base[1] * k, base[2] * k],
    sway: [lo * bend, hi * bend],
    ao: lumpy ? 0.45 : rocky ? 0.3 : 0.25,
    jitter: mat.pattern === "leaves" ? 0.12 : lumpy ? 0.06 : rocky ? 0.1 : 0,
  };

  identity(m);
  translate(m, p.at[0] - origin[0], p.at[1] - origin[1], p.at[2] - origin[2]);
  rotateY(m, p.turn * DEG);
  rotateX(m, p.tilt * DEG);
  const thin = Math.min(sx, sz);
  const shape = shapeOf(p.part);
  switch (shape) {
    case "box":
      b.box(m, p.size, style, Math.min(0.1, 0.3 * Math.min(sx, sy, sz)));
      break;
    case "sphere":
      b.sphere(m, [sx / 2, sy / 2, sz / 2], style, {
        detail: 1,
        noise: mat.pattern === "leaves" ? 0.22 : mat.pattern === "fleece" ? 0.15 : rocky ? 0.3 : 0,
        seed: index * 13 + 5,
        flat: rocky,
      });
      break;
    case "cylinder":
    case "cone": {
      // Unit primitives grown from y = 0, stretched to the part's size around its center.
      translate(m, 0, -sy / 2, 0);
      scale(m, sx, sy, sz);
      const segments = thin < 0.06 ? 3 : thin < 0.2 ? 6 : thin < 0.6 ? 9 : 14;
      const opts = { segments, caps: thin >= 0.06 };
      if (shape === "cone") b.cone(m, 0.5, 1, style, opts);
      else b.cylinder(m, 0.5, 0.5, 1, style, opts);
      break;
    }
  }
}
