import type { Catalog, DesignContent, MaterialContent, Vec3 } from "./catalog.ts";
import { slopeDrop, solid, type World } from "./world.ts";

/**
 * Rigid bodies (physics phase 2). A built Object is one body made of its Design's parts: mass is
 * each part's volume × its Material's density (tonnes; a block is a cubic meter), and the parts
 * together are its shape. Bodies fall, stack, topple, roll, float or sink, rest in any pose and
 * fall asleep when still.
 *
 * Collision is sampled: every part carries points over its surface (corners, edges, faces, rims),
 * and a point inside a solid (a voxel, a slope, a tree, another body's part, a villager) makes a
 * contact pushing it out of the nearest face. True spheres are tested exactly, so balls roll
 * smoothly. Contacts are solved with sequential impulses (friction, a little bounce) a few times
 * per tick. Everything runs on the fixed tick in a fixed order, so it is deterministic.
 */

export const GRAVITY = 9.8;
/** Physics steps per 20 Hz tick, and solver passes per step. */
const SUBSTEPS = 3;
const ITERATIONS = 8;
/** Points are spread over part surfaces at about this spacing (blocks). */
const SPACING = 0.5;
const MAX_POINTS = 200;
const FRICTION = 0.6;
/** Penetration left alone, and how fast the rest is corrected. */
const SLOP = 0.01;
const BAUMGARTE = 0.3;
const MAX_CORRECTION = 2;
const RESTITUTION = 0.2;
/** Slower impacts than this don't bounce at all. */
const BOUNCE_SPEED = 1.5;
const MAX_SPEED = 25;
const MAX_SPIN = 20;
/** A body this still for this many ticks falls asleep. */
const SLEEP_SPEED = 0.07;
const SLEEP_SPIN = 0.12;
const SLEEP_TICKS = 15;
/** An awake body moving faster than this wakes the sleeping bodies it touches. */
const WAKE_SPEED = 0.25;
/** Per-second damping in air, and extra in water per submerged share. */
const AIR_DRAG = 0.02;
const AIR_SPIN_DRAG = 0.2;
const WATER_DRAG = 1.6;
const WATER_SPIN_DRAG = 2;
/** Water surfaces sit this far below the top of their water block (as drawn). */
const SURFACE_DROP = 0.12;
/** Trees and rocks stop bodies like a post this wide (half) and tall. */
const PROP_HALF = 0.3;
const PROP_HEIGHT = 2.5;
/** A body hitting the ground faster than this has landed (Rules hear it). */
export const LAND_SPEED = 2.5;

export const Kind = { Box: 0, Ellipsoid: 1, Cylinder: 2, Cone: 3 } as const;
const KINDS: Record<string, number> = {
  box: Kind.Box,
  sphere: Kind.Ellipsoid,
  cylinder: Kind.Cylinder,
  cone: Kind.Cone,
};

export type Quat = [number, number, number, number];

/** One part in the body frame (origin at the center of mass, axes the Design's). */
export interface PartShape {
  kind: number;
  /** Center (of the part's box, not its mass), body frame. */
  c: Float64Array;
  /** Part axes in the body frame, row-major 3 × 3. */
  R: Float64Array;
  /** Half sizes. */
  h: Float64Array;
  /** Radius when it's a true sphere (all three sizes within 5%), else 0. */
  r: number;
}

export interface Shape {
  /** Tonnes. */
  mass: number;
  invMass: number;
  /** Center of mass in Design space. */
  com: Vec3;
  /** Inverse inertia in the body frame, row-major. */
  invI: Float64Array;
  parts: PartShape[];
  /** Surface points in the body frame, xyz. True spheres have none (they're tested exactly). */
  points: Float64Array;
  /** Which part each point belongs to. */
  pointPart: Int16Array;
  /** Farthest any point or sphere reaches from the center of mass. */
  radius: number;
  /** Built into its blocks, or anchored: it never moves. */
  fixed: boolean;
}

/** A body's state as the world saves it. */
export interface BodyState {
  id: number;
  design: number;
  /** Where the Design's origin corner (0, 0, 0) is now, and how it's turned. */
  pos: Vec3;
  rot: Quat;
  /** Velocity of its center of mass (blocks per second), and its spin (radians per second). */
  vel: Vec3;
  spin: Vec3;
  asleep: boolean;
  /** The villager carrying it overhead (their id), if any. */
  held?: number;
  /** Who set it moving last (pushed, dropped, put down), so a hit can name them. */
  mover?: string;
  /** Moving because a Rule nudged it: its landing doesn't fire Rules (Rules don't chain). */
  byRule?: boolean;
  /** A steady push this tick: force (tonne · blocks/s²) and torque about its center. */
  force?: number[];
  /** Ticks it has been still (it sleeps at SLEEP_TICKS), and ticks since it touched anything. */
  still?: number;
  air?: number;
}

/** Something that moves bodies by walking into them: a villager or an animal (a capsule). */
export interface Mover {
  x: number;
  y: number;
  z: number;
  /** Velocity this tick, blocks per second. */
  vx: number;
  vy: number;
  vz: number;
  radius: number;
  /** Capsule from y + bottom to y + top, radius included. */
  bottom: number;
  top: number;
  /** Most it can shove per second (tonne · blocks/s): villagers barely nudge a boulder. */
  shove: number;
  /** A body it's pushing by hand (the push tool moves it, not its capsule). */
  ignore: number;
}

/** A body that hit a mover hard: how fast it came at them and with how much momentum. */
export interface Hit {
  body: BodyState;
  mover: number;
  speed: number;
  momentum: number;
  /** Horizontal direction of the blow. */
  nx: number;
  nz: number;
}

const DEG = Math.PI / 180;

// ---------------------------------------------------------------- small math

/** Row-major rotation matrix of a unit quaternion. */
export function quatMatrix(q: ArrayLike<number>, out: Float64Array, o = 0): Float64Array {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  out[o] = 1 - 2 * (y * y + z * z);
  out[o + 1] = 2 * (x * y - z * w);
  out[o + 2] = 2 * (x * z + y * w);
  out[o + 3] = 2 * (x * y + z * w);
  out[o + 4] = 1 - 2 * (x * x + z * z);
  out[o + 5] = 2 * (y * z - x * w);
  out[o + 6] = 2 * (x * z - y * w);
  out[o + 7] = 2 * (y * z + x * w);
  out[o + 8] = 1 - 2 * (x * x + y * y);
  return out;
}

/** A turn of `a` radians about y (east toward north, like `rotateY`). */
export function yawQuat(a: number): Quat {
  return [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
}

export function quatMul(a: ArrayLike<number>, b: ArrayLike<number>): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export const quatConj = (q: ArrayLike<number>): Quat => [-q[0], -q[1], -q[2], q[3]];

/** How far a body's up axis leans from upright, 0 (upright) to π (upside down). */
export function lean(q: ArrayLike<number>): number {
  const x = q[0], z = q[2];
  return Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (x * x + z * z))));
}

const mul3 = (a: Float64Array, b: Float64Array, out: Float64Array) => {
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return out;
};

function invert3(m: Float64Array, out: Float64Array): Float64Array {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const k = Math.abs(det) > 1e-18 ? 1 / det : 0;
  out[0] = A * k, out[1] = -(b * i - c * h) * k, out[2] = (b * f - c * e) * k;
  out[3] = B * k, out[4] = (a * i - c * g) * k, out[5] = -(a * f - c * d) * k;
  out[6] = C * k, out[7] = -(a * h - b * g) * k, out[8] = (a * e - b * d) * k;
  return out;
}

/** Part axes for its turn (about y) and tilt (about x first), as the renderer draws it. */
function partAxes(turn: number, tilt: number): Float64Array {
  const ct = Math.cos(tilt * DEG), st = Math.sin(tilt * DEG);
  const cy = Math.cos(turn * DEG), sy = Math.sin(turn * DEG);
  return Float64Array.of(cy, sy * st, sy * ct, 0, ct, -st, -sy, cy * st, cy * ct);
}

// ---------------------------------------------------------------- shapes

/** Volume of a part of `kind` with half sizes h. */
function volume(kind: number, hx: number, hy: number, hz: number): number {
  const box = 8 * hx * hy * hz;
  return kind === Kind.Box
    ? box
    : kind === Kind.Ellipsoid
    ? box * Math.PI / 6
    : kind === Kind.Cylinder
    ? box * Math.PI / 4
    : box * Math.PI / 12;
}

/**
 * The rigid body a Design makes: mass, center of mass, inertia and surface points from its parts.
 * Designs with blocks (buildings) and anchored ones are fixed.
 */
export function compileShape(catalog: Catalog, d: DesignContent): Shape {
  const parts: { kind: number; at: Vec3; h: Vec3; R: Float64Array; m: number; cm: Vec3 }[] = [];
  let mass = 0;
  const com: Vec3 = [0, 0, 0];
  for (const p of d.parts) {
    const kind = KINDS[p.part] ?? Kind.Box;
    const h: Vec3 = [p.size[0] / 2, p.size[1] / 2, p.size[2] / 2];
    const mat = catalog.byName(p.material)?.content as MaterialContent | undefined;
    const m = Math.max(1e-4, volume(kind, h[0], h[1], h[2]) * (mat?.density ?? 1));
    const R = partAxes(p.turn, p.tilt);
    // A cone's mass sits a quarter of the way up from its base.
    const off = kind === Kind.Cone ? -h[1] / 2 : 0;
    const cm: Vec3 = [p.at[0] + R[1] * off, p.at[1] + R[4] * off, p.at[2] + R[7] * off];
    parts.push({ kind, at: p.at, h, R, m, cm });
    mass += m;
    for (let k = 0; k < 3; k++) com[k] += cm[k] * m;
  }
  if (!parts.length) mass = 1;
  for (let k = 0; k < 3; k++) com[k] = parts.length ? com[k] / mass : 0.5;
  const I = new Float64Array(9), D = new Float64Array(9), t = new Float64Array(9);
  const RT = new Float64Array(9);
  const shapes: PartShape[] = [];
  const pts: number[] = [];
  const keep: boolean[] = [];
  const owner: number[] = [];
  let radius = 0.05;
  for (const p of parts) {
    const [hx, hy, hz] = p.h, m = p.m;
    D.fill(0);
    if (p.kind === Kind.Box) {
      D[0] = m / 3 * (hy * hy + hz * hz), D[4] = m / 3 * (hx * hx + hz * hz);
      D[8] = m / 3 * (hx * hx + hy * hy);
    } else if (p.kind === Kind.Ellipsoid) {
      D[0] = m / 5 * (hy * hy + hz * hz), D[4] = m / 5 * (hx * hx + hz * hz);
      D[8] = m / 5 * (hx * hx + hy * hy);
    } else if (p.kind === Kind.Cylinder) {
      D[0] = m / 4 * hz * hz + m / 3 * hy * hy, D[4] = m / 4 * (hx * hx + hz * hz);
      D[8] = m / 4 * hx * hx + m / 3 * hy * hy;
    } else {
      D[0] = m * (0.15 * hz * hz + 0.15 * hy * hy), D[4] = m * 0.15 * (hx * hx + hz * hz);
      D[8] = m * (0.15 * hx * hx + 0.15 * hy * hy);
    }
    // R D Rᵀ, then shifted to the body's center of mass.
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) RT[i * 3 + j] = p.R[j * 3 + i];
    mul3(mul3(p.R, D, t), RT, D);
    const dx = p.cm[0] - com[0], dy = p.cm[1] - com[1], dz = p.cm[2] - com[2];
    const d2 = dx * dx + dy * dy + dz * dz, dv = [dx, dy, dz];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        I[i * 3 + j] += D[i * 3 + j] + m * ((i === j ? d2 : 0) - dv[i] * dv[j]);
      }
    }
    const c = Float64Array.of(p.at[0] - com[0], p.at[1] - com[1], p.at[2] - com[2]);
    const round = p.kind === Kind.Ellipsoid && Math.max(hx, hy, hz) < Math.min(hx, hy, hz) * 1.05;
    const r = round ? (hx + hy + hz) / 3 : 0;
    shapes.push({ kind: p.kind, c, R: p.R, h: Float64Array.of(hx, hy, hz), r });
    if (r) {
      radius = Math.max(radius, Math.hypot(c[0], c[1], c[2]) + r);
      continue;
    }
    for (const [lx, ly, lz, extreme] of surfacePoints(p.kind, hx, hy, hz)) {
      const R = p.R;
      const x = c[0] + R[0] * lx + R[1] * ly + R[2] * lz;
      const y = c[1] + R[3] * lx + R[4] * ly + R[5] * lz;
      const z = c[2] + R[6] * lx + R[7] * ly + R[8] * lz;
      pts.push(x, y, z);
      keep.push(extreme);
      owner.push(shapes.length - 1);
      radius = Math.max(radius, Math.hypot(x, y, z));
    }
  }
  const [points, pointPart] = thin(pts, keep, owner);
  return {
    mass,
    invMass: 1 / mass,
    com,
    invI: invert3(I, new Float64Array(9)),
    parts: shapes,
    points,
    pointPart,
    radius,
    fixed: !!d.blocks || !!d.anchored,
  };
}

/** At most MAX_POINTS: every corner and rim point, and an even share of the rest. */
function thin(pts: number[], keep: boolean[], owner: number[]): [Float64Array, Int16Array] {
  const n = keep.length;
  if (n <= MAX_POINTS) return [Float64Array.from(pts), Int16Array.from(owner)];
  const must = keep.filter(Boolean).length;
  const step = Math.max(1, Math.ceil((n - must) / Math.max(1, MAX_POINTS - must)));
  const out: number[] = [], parts: number[] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i] && k++ % step !== 0) continue;
    out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
    parts.push(owner[i]);
  }
  return [Float64Array.from(out), Int16Array.from(parts)];
}

/** Points over a part's surface in its own frame; the 4th value marks corners and rims. */
function surfacePoints(kind: number, hx: number, hy: number, hz: number): [
  number,
  number,
  number,
  boolean,
][] {
  const out: [number, number, number, boolean][] = [];
  const segs = (h: number) => Math.min(8, Math.max(1, Math.ceil((2 * h) / SPACING)));
  if (kind === Kind.Box) {
    const nx = segs(hx), ny = segs(hy), nz = segs(hz);
    for (let i = 0; i <= nx; i++) {
      for (let j = 0; j <= ny; j++) {
        for (let k = 0; k <= nz; k++) {
          const edges = +(i === 0 || i === nx) + +(j === 0 || j === ny) + +(k === 0 || k === nz);
          if (!edges) continue; // inside
          out.push([
            -hx + 2 * hx * i / nx,
            -hy + 2 * hy * j / ny,
            -hz + 2 * hz * k / nz,
            edges === 3,
          ]);
        }
      }
    }
    return out;
  }
  if (kind === Kind.Ellipsoid) {
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (let k = -1; k <= 1; k++) {
          if (!i && !j && !k) continue;
          const l = Math.hypot(i, j, k);
          out.push([hx * i / l, hy * j / l, hz * k / l, true]);
        }
      }
    }
    return out;
  }
  const around = Math.min(hx, hz) < 0.05 ? 6 : 16;
  const ring = (y: number, s: number, rim: boolean) => {
    for (let a = 0; a < around; a++) {
      const t = (a / around) * Math.PI * 2;
      out.push([Math.cos(t) * hx * s, y, Math.sin(t) * hz * s, rim]);
    }
  };
  if (kind === Kind.Cylinder) {
    const rows = segs(hy);
    for (let j = 0; j <= rows; j++) ring(-hy + 2 * hy * j / rows, 1, j === 0 || j === rows);
    out.push([0, -hy, 0, false], [0, hy, 0, false]);
    return out;
  }
  ring(-hy, 1, true);
  ring(0, 0.5, false);
  out.push([0, hy, 0, true], [0, -hy, 0, false]);
  return out;
}

/** The world boxes ([x0, x1, y0, y1, z0, z1]) of a Design's parts with its origin at pos, turned rot. */
export function poseBoxes(d: DesignContent, pos: Vec3, rot: Quat): number[][] {
  const R = quatMatrix(rot, new Float64Array(9)), M = new Float64Array(9);
  return d.parts.map((p) => {
    mul3(R, partAxes(p.turn, p.tilt), M);
    const hx = p.size[0] / 2, hy = p.size[1] / 2, hz = p.size[2] / 2;
    const c = [0, 1, 2].map((k) =>
      pos[k] + R[k * 3] * p.at[0] + R[k * 3 + 1] * p.at[1] + R[k * 3 + 2] * p.at[2]
    );
    const e = [0, 1, 2].map((k) =>
      Math.abs(M[k * 3]) * hx + Math.abs(M[k * 3 + 1]) * hy + Math.abs(M[k * 3 + 2]) * hz
    );
    return [c[0] - e[0], c[0] + e[0], c[1] - e[1], c[1] + e[1], c[2] - e[2], c[2] + e[2]];
  });
}

// ---------------------------------------------------------------- runtime

/** A body as the solver sees it this tick. */
class Rt {
  shape!: Shape;
  design = -1;
  version = -1;
  invMass = 0;
  p = new Float64Array(3);
  q = new Float64Array(4);
  v = new Float64Array(3);
  w = new Float64Array(3);
  R = new Float64Array(9);
  invIw = new Float64Array(9);
  /** World points, part centers and part axes for the current pose. */
  pts = new Float64Array(0);
  partC = new Float64Array(0);
  partR = new Float64Array(0);
  /** Pose the world arrays were last computed for (sleeping bodies keep theirs). */
  posed = false;
  dynamic = false;
  /** Fastest approach to the ground or a resting body this tick, for landings. */
  impact = 0;
  constructor(public o: BodyState) {}
}

const tmp = new Float64Array(9), tmp2 = new Float64Array(9);

/** Contacts, struct-of-arrays, grown as needed and reused every step. */
class Contacts {
  n = 0;
  cap = 0;
  a: Rt[] = [];
  b: (Rt | null)[] = [];
  mover = new Int32Array(0);
  f = new Float64Array(0);
  static readonly F = 32;
  ensure(n: number) {
    if (n <= this.cap) return;
    this.cap = Math.max(n, this.cap * 2, 256);
    const f = new Float64Array(this.cap * Contacts.F);
    f.set(this.f);
    this.f = f;
    const m = new Int32Array(this.cap);
    m.set(this.mover);
    this.mover = m;
  }
}
// Field offsets in Contacts.f.
const PX = 0,
  NX = 3,
  DEPTH = 6,
  KV = 7,
  RA = 10,
  RB = 13,
  T1 = 16,
  T2 = 19,
  MN = 22,
  MT1 = 23,
  MT2 = 24,
  BIAS = 25,
  LN = 26,
  LT1 = 27,
  LT2 = 28,
  CAP = 29,
  APPROACH = 30;

/** Candidate contacts for one pair before they're reduced to a few per direction. */
const cand = { n: 0, f: new Float64Array(7 * 512) };

export class Physics {
  private rts = new Map<number, Rt>();
  private shapes = new Map<number, Shape>();
  private shapesVersion = -1;
  private contacts = new Contacts();
  private awake: Rt[] = [];
  private all: Rt[] = [];
  readonly hits: Hit[] = [];
  /** Bodies that landed hard this tick, and how fast. */
  readonly landings: { body: BodyState; speed: number }[] = [];
  /** Bodies whose pose changed this tick (their tiles need re-marking). */
  readonly moved: BodyState[] = [];
  private movers: Mover[] = [];
  private moverHit = new Float64Array(0);

  constructor(readonly world: World, public catalog: Catalog) {}

  /** The shape a Design makes (cached per Catalog version). */
  shape(design: number): Shape | null {
    if (this.shapesVersion !== this.catalog.version) {
      this.shapes.clear(), this.shapesVersion = this.catalog.version;
    }
    let s = this.shapes.get(design);
    if (s) return s;
    const e = this.catalog.get(design);
    if (e?.kind !== "design") return null;
    s = compileShape(this.catalog, e.content as DesignContent);
    this.shapes.set(design, s);
    return s;
  }

  /** Where a body's center of mass is. */
  center(o: BodyState): Vec3 {
    const s = this.shape(o.design);
    const R = quatMatrix(o.rot, tmp);
    const c = s?.com ?? [0, 0, 0];
    return [0, 1, 2].map((k) =>
      o.pos[k] + R[k * 3] * c[0] + R[k * 3 + 1] * c[1] + R[k * 3 + 2] * c[2]
    ) as Vec3;
  }

  /** Lowest point of a body turned `rot`, relative to its center of mass. */
  lowest(design: number, rot: ArrayLike<number>): number {
    const s = this.shape(design);
    if (!s) return 0;
    const R = quatMatrix(rot, tmp2);
    let low = 0;
    const pts = s.points;
    for (let i = 0; i < pts.length; i += 3) {
      low = Math.min(low, R[3] * pts[i] + R[4] * pts[i + 1] + R[5] * pts[i + 2]);
    }
    for (const p of s.parts) {
      if (!p.r) continue;
      low = Math.min(low, R[3] * p.c[0] + R[4] * p.c[1] + R[5] * p.c[2] - p.r);
    }
    return low;
  }

  wake(o: BodyState) {
    const s = this.shape(o.design);
    if (!s || s.fixed || o.held) return;
    if (o.asleep) o.asleep = false;
    const rt = this.rts.get(o.id);
    o.still = 0;
    if (rt) rt.posed = false;
  }

  /**
   * Push body `o` with impulse (jx, jy, jz) (tonne · blocks/s) at world point (px, py, pz): it
   * speeds up and, off its center, spins. Wakes it.
   */
  applyImpulse(
    o: BodyState,
    px: number,
    py: number,
    pz: number,
    jx: number,
    jy: number,
    jz: number,
  ) {
    const s = this.shape(o.design);
    if (!s || s.fixed || o.held) return;
    this.wake(o);
    const c = this.center(o);
    const R = quatMatrix(o.rot, tmp), I = tmp2;
    // R I⁻¹ Rᵀ
    const A = new Float64Array(9);
    mul3(R, s.invI, A);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        I[i * 3 + j] = A[i * 3] * R[j * 3] + A[i * 3 + 1] * R[j * 3 + 1] +
          A[i * 3 + 2] * R[j * 3 + 2];
      }
    }
    const rx = px - c[0], ry = py - c[1], rz = pz - c[2];
    const tx = ry * jz - rz * jy, ty = rz * jx - rx * jz, tz = rx * jy - ry * jx;
    o.vel = [o.vel[0] + jx * s.invMass, o.vel[1] + jy * s.invMass, o.vel[2] + jz * s.invMass];
    o.spin = [
      o.spin[0] + I[0] * tx + I[1] * ty + I[2] * tz,
      o.spin[1] + I[3] * tx + I[4] * ty + I[5] * tz,
      o.spin[2] + I[6] * tx + I[7] * ty + I[8] * tz,
    ];
  }

  /**
   * Push body `o` steadily this tick with force (fx, fy, fz) at world point (px, py, pz), spread
   * over the tick's steps so friction can hold against it (a crate too heavy doesn't creep).
   */
  applyForce(o: BodyState, px: number, py: number, pz: number, fx: number, fy: number, fz: number) {
    const s = this.shape(o.design);
    if (!s || s.fixed || o.held) return;
    this.wake(o);
    const c = this.center(o);
    const rx = px - c[0], ry = py - c[1], rz = pz - c[2];
    const f = o.force ??= [0, 0, 0, 0, 0, 0];
    f[0] += fx, f[1] += fy, f[2] += fz;
    f[3] += ry * fz - rz * fy, f[4] += rz * fx - rx * fz, f[5] += rx * fy - ry * fx;
  }

  /** How far a body reaches from its center of mass along horizontal direction (dx, dz). */
  reach(o: BodyState, dx: number, dz: number): number {
    const s = this.shape(o.design);
    if (!s) return 0.5;
    const R = quatMatrix(o.rot, tmp);
    let best = 0;
    const pts = s.points;
    const along = (x: number, y: number, z: number) =>
      (R[0] * x + R[1] * y + R[2] * z) * dx + (R[6] * x + R[7] * y + R[8] * z) * dz;
    for (let i = 0; i < pts.length; i += 3) {
      best = Math.max(best, along(pts[i], pts[i + 1], pts[i + 2]));
    }
    for (const p of s.parts) if (p.r) best = Math.max(best, along(p.c[0], p.c[1], p.c[2]) + p.r);
    return best;
  }

  /** Wake every body within `r` of a point (a block changed, something was lifted). */
  wakeNear(list: BodyState[], x: number, y: number, z: number, r: number) {
    for (const o of list) {
      if (!o.asleep) continue;
      const s = this.shape(o.design);
      if (!s) continue;
      const c = this.center(o);
      if (Math.hypot(c[0] - x, c[1] - y, c[2] - z) <= s.radius + r) this.wake(o);
    }
  }

  /** Bodies that are gone (taken apart) drop their runtime state. */
  forget(id: number) {
    this.rts.delete(id);
  }

  /** One sim tick: every awake body, `SUBSTEPS` times. */
  step(list: BodyState[], movers: Mover[], dt: number) {
    this.hits.length = 0;
    this.landings.length = 0;
    this.moved.length = 0;
    this.movers = movers;
    if (this.moverHit.length < movers.length) this.moverHit = new Float64Array(movers.length * 2);
    const awake = this.awake, all = this.all;
    awake.length = 0, all.length = 0;
    for (const o of list) {
      const rt = this.sync(o);
      if (!rt) continue;
      if (o.held) continue; // carried overhead: out of the world until put down
      all.push(rt);
      if (rt.dynamic) awake.push(rt);
    }
    if (!awake.length) return;
    for (const rt of awake) rt.impact = 0;
    const h = dt / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) this.substep(h);
    for (const rt of awake) this.settle(rt, dt);
    for (const o of list) delete o.force;
  }

  /** The runtime body for `o`, its pose loaded from the saved state. */
  private sync(o: BodyState): Rt | null {
    const shape = this.shape(o.design);
    if (!shape) return null;
    let rt = this.rts.get(o.id);
    if (!rt || rt.o !== o) this.rts.set(o.id, rt = new Rt(o));
    if (rt.shape !== shape) {
      rt.shape = shape, rt.posed = false;
      rt.pts = new Float64Array(shape.points.length);
      rt.partC = new Float64Array(shape.parts.length * 3);
      rt.partR = new Float64Array(shape.parts.length * 9);
    }
    rt.dynamic = !shape.fixed && !o.asleep && !o.held;
    rt.invMass = rt.dynamic ? shape.invMass : 0;
    if (rt.dynamic || !rt.posed) {
      rt.q.set(o.rot);
      quatMatrix(rt.q, rt.R);
      const c = shape.com, R = rt.R;
      for (let k = 0; k < 3; k++) {
        rt.p[k] = o.pos[k] + R[k * 3] * c[0] + R[k * 3 + 1] * c[1] + R[k * 3 + 2] * c[2];
      }
      rt.v.set(o.vel), rt.w.set(o.spin);
      if (!rt.dynamic) rt.v.fill(0), rt.w.fill(0);
      this.pose(rt);
    }
    return rt;
  }

  /** World points, part centers and axes, and world inverse inertia for the current pose. */
  private pose(rt: Rt) {
    const s = rt.shape, R = rt.R, p = rt.p;
    quatMatrix(rt.q, R);
    const pts = s.points, out = rt.pts;
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i], y = pts[i + 1], z = pts[i + 2];
      out[i] = p[0] + R[0] * x + R[1] * y + R[2] * z;
      out[i + 1] = p[1] + R[3] * x + R[4] * y + R[5] * z;
      out[i + 2] = p[2] + R[6] * x + R[7] * y + R[8] * z;
    }
    s.parts.forEach((part, j) => {
      const c = part.c;
      for (let k = 0; k < 3; k++) {
        rt.partC[j * 3 + k] = p[k] + R[k * 3] * c[0] + R[k * 3 + 1] * c[1] + R[k * 3 + 2] * c[2];
      }
      mul3(R, part.R, tmp);
      rt.partR.set(tmp, j * 9);
    });
    // R I⁻¹ Rᵀ
    mul3(R, s.invI, tmp);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        rt.invIw[i * 3 + j] = tmp[i * 3] * R[j * 3] + tmp[i * 3 + 1] * R[j * 3 + 1] +
          tmp[i * 3 + 2] * R[j * 3 + 2];
      }
    }
    rt.posed = true;
  }

  private substep(h: number) {
    for (const rt of this.awake) this.forces(rt, h);
    const c = this.contacts;
    c.n = 0;
    this.moverHit.fill(0);
    for (const rt of this.awake) {
      this.collideWorld(rt);
      this.collideMovers(rt);
    }
    // Pairs: each awake body against every body after it, or any non-awake body.
    const all = this.all;
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      for (let j = i + 1; j < all.length; j++) {
        const b = all[j];
        if (!a.dynamic && !b.dynamic) continue;
        const r = a.shape.radius + b.shape.radius;
        const dx = a.p[0] - b.p[0], dy = a.p[1] - b.p[1], dz = a.p[2] - b.p[2];
        if (dx * dx + dy * dy + dz * dz > r * r) continue;
        this.collidePair(a, b);
      }
    }
    this.prepare(h);
    for (let it = 0; it < ITERATIONS; it++) this.solve();
    this.report();
    for (const rt of this.awake) this.integrate(rt, h);
  }

  /** Gravity, buoyancy and drag. */
  private forces(rt: Rt, h: number) {
    const v = rt.v, w = rt.w, s = rt.shape, world = this.world;
    v[1] -= GRAVITY * h;
    const f = rt.o.force;
    if (f) {
      const I = rt.invIw, m = rt.invMass * h;
      v[0] += f[0] * m, v[1] += f[1] * m, v[2] += f[2] * m;
      w[0] += (I[0] * f[3] + I[1] * f[4] + I[2] * f[5]) * h;
      w[1] += (I[3] * f[3] + I[4] * f[4] + I[5] * f[5]) * h;
      w[2] += (I[6] * f[3] + I[7] * f[4] + I[8] * f[5]) * h;
    }
    let wet = 0, total = 0;
    for (let j = 0; j < s.parts.length; j++) {
      const part = s.parts[j];
      const cx = rt.partC[j * 3], cy = rt.partC[j * 3 + 1], cz = rt.partC[j * 3 + 2];
      const ix = Math.floor(cx), iz = Math.floor(cz);
      if (ix < 0 || iz < 0 || ix >= world.sizeX || iz >= world.sizeZ) continue;
      const water = world.waterTop[iz * world.sizeX + ix];
      const vol = volume(part.kind, part.h[0], part.h[1], part.h[2]);
      total += vol;
      if (water < 0) continue;
      // How deep the part sits in the water, by its vertical extent.
      const M = rt.partR, o = j * 9, hh = part.h;
      const ext = Math.abs(M[o + 3]) * hh[0] + Math.abs(M[o + 4]) * hh[1] +
        Math.abs(M[o + 5]) * hh[2];
      const surface = water + 1 - SURFACE_DROP;
      const f = Math.max(0, Math.min(1, (surface - (cy - ext)) / Math.max(0.02, 2 * ext)));
      if (!f) continue;
      wet += vol * f;
      // Water's density is 1: the lift is the weight of the water pushed aside, at the part.
      const lift = vol * f * GRAVITY * h;
      v[1] += lift * rt.invMass;
      const rx = cx - rt.p[0], rz = cz - rt.p[2];
      // r × (0, lift, 0)
      const tx = -rz * lift, tz = rx * lift;
      const I = rt.invIw;
      w[0] += I[0] * tx + I[2] * tz, w[1] += I[3] * tx + I[5] * tz, w[2] += I[6] * tx + I[8] * tz;
    }
    const share = total ? wet / total : 0;
    const lin = Math.max(0, 1 - (AIR_DRAG + WATER_DRAG * share) * h);
    const ang = Math.max(0, 1 - (AIR_SPIN_DRAG + WATER_SPIN_DRAG * share) * h);
    for (let k = 0; k < 3; k++) v[k] *= lin, w[k] *= ang;
  }

  // ---------------------------------------------------------------- contacts

  private beginPair() {
    cand.n = 0;
  }

  private candidate(
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    d: number,
  ) {
    if (cand.n * 7 >= cand.f.length) return;
    const f = cand.f, o = cand.n++ * 7;
    f[o] = px, f[o + 1] = py, f[o + 2] = pz, f[o + 3] = nx, f[o + 4] = ny, f[o + 5] = nz;
    f[o + 6] = d;
  }

  /**
   * Keep at most four candidates per direction (down, up, and the four sides), spread out: the
   * deepest, the farthest from it, the farthest from that line, and the one farthest from all.
   */
  private flush(a: Rt, b: Rt | null, mover: number, kvx = 0, kvy = 0, kvz = 0, cap = Infinity) {
    const n = cand.n, f = cand.f;
    if (!n) return;
    const bucketOf = (i: number) => {
      const nx = f[i * 7 + 3], ny = f[i * 7 + 4], nz = f[i * 7 + 5];
      return ny > 0.7
        ? 0
        : ny < -0.7
        ? 1
        : Math.abs(nx) > Math.abs(nz)
        ? (nx > 0 ? 2 : 3)
        : nz > 0
        ? 4
        : 5;
    };
    for (let bucket = 0; bucket < 6; bucket++) {
      let count = 0, deep = -1;
      for (let i = 0; i < n; i++) {
        if (bucketOf(i) !== bucket) continue;
        count++;
        if (deep < 0 || f[i * 7 + 6] > f[deep * 7 + 6]) deep = i;
      }
      if (!count) continue;
      if (count <= 4) {
        for (let i = 0; i < n; i++) {
          if (bucketOf(i) === bucket) this.emit(a, b, i, mover, kvx, kvy, kvz, cap);
        }
        continue;
      }
      const pick = [deep, -1, -1, -1];
      const dist = (i: number, j: number) =>
        Math.hypot(f[i * 7] - f[j * 7], f[i * 7 + 1] - f[j * 7 + 1], f[i * 7 + 2] - f[j * 7 + 2]);
      for (let slot = 1; slot < 4; slot++) {
        let best = -1, bestScore = -1;
        for (let i = 0; i < n; i++) {
          if (bucketOf(i) !== bucket || pick.includes(i)) continue;
          let score: number;
          if (slot === 1) score = dist(i, pick[0]);
          else if (slot === 2) {
            // Distance from the line through the first two.
            const ax = f[pick[1] * 7] - f[pick[0] * 7],
              ay = f[pick[1] * 7 + 1] - f[pick[0] * 7 + 1],
              az = f[pick[1] * 7 + 2] - f[pick[0] * 7 + 2];
            const bx = f[i * 7] - f[pick[0] * 7],
              by = f[i * 7 + 1] - f[pick[0] * 7 + 1],
              bz = f[i * 7 + 2] - f[pick[0] * 7 + 2];
            score = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
          } else score = Math.min(dist(i, pick[0]), dist(i, pick[1]), dist(i, pick[2]));
          if (score > bestScore) bestScore = score, best = i;
        }
        if (best < 0) break;
        pick[slot] = best;
      }
      for (const i of pick) if (i >= 0) this.emit(a, b, i, mover, kvx, kvy, kvz, cap);
    }
    cand.n = 0;
  }

  private emit(
    a: Rt,
    b: Rt | null,
    i: number,
    mover: number,
    kvx: number,
    kvy: number,
    kvz: number,
    cap: number,
  ) {
    const c = this.contacts;
    c.ensure(c.n + 1);
    const k = c.n++, o = k * Contacts.F, f = c.f, src = cand.f, s = i * 7;
    c.a[k] = a, c.b[k] = b, c.mover[k] = mover;
    f[o + PX] = src[s], f[o + PX + 1] = src[s + 1], f[o + PX + 2] = src[s + 2];
    f[o + NX] = src[s + 3], f[o + NX + 1] = src[s + 4], f[o + NX + 2] = src[s + 5];
    f[o + DEPTH] = src[s + 6];
    f[o + KV] = kvx, f[o + KV + 1] = kvy, f[o + KV + 2] = kvz;
    f[o + CAP] = cap;
  }

  /** Whether voxel (x, y, z) is solid; below the world is bedrock, beyond its edges is open. */
  private solidAt(x: number, y: number, z: number): boolean {
    const w = this.world;
    if (x < 0 || z < 0 || x >= w.sizeX || z >= w.sizeZ || y >= w.sizeY) return false;
    if (y < 0) return true;
    return solid(w.blocks[(y * w.sizeZ + z) * w.sizeX + x]);
  }

  /** Scratch out-params for point tests: normal and depth. */
  private hn = new Float64Array(4);

  /** A world point inside the ground (a voxel, a slope) or a tree: the way out and how deep. */
  private pointInWorld(px: number, py: number, pz: number): boolean {
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    const w = this.world, out = this.hn;
    if (!this.solidAt(ix, iy, iz)) return this.pointInProp(px, py, pz, ix, iz);
    if (iy >= 0 && iy === w.heightAt(ix, iz)) {
      const mask = w.slopeMask(ix, iz);
      if (mask) {
        const fx = px - ix, fz = pz - iz;
        const s = iy + 1 - slopeDrop(mask, fx, fz);
        if (py >= s) return false;
        this.slopeNormal(mask, fx, fz);
        out[3] = (s - py) * out[1];
        return true;
      }
    }
    return this.cubeExit(px, py, pz, ix, iy, iz);
  }

  /** Normal of the sloped surface at (fx, fz) within its column, into this.hn. */
  private slopeNormal(mask: number, fx: number, fz: number) {
    const e = 0.02;
    const x = Math.min(1 - e, Math.max(e, fx)), z = Math.min(1 - e, Math.max(e, fz));
    const gx = (slopeDrop(mask, x + e, z) - slopeDrop(mask, x - e, z)) / (2 * e);
    const gz = (slopeDrop(mask, x, z + e) - slopeDrop(mask, x, z - e)) / (2 * e);
    const l = Math.hypot(gx, 1, gz);
    this.hn[0] = gx / l, this.hn[1] = 1 / l, this.hn[2] = gz / l;
  }

  /** Out of a solid cube through the nearest face that isn't against another solid. */
  private cubeExit(
    px: number,
    py: number,
    pz: number,
    ix: number,
    iy: number,
    iz: number,
  ): boolean {
    const out = this.hn;
    let best = Infinity;
    const face = (d: number, nx: number, ny: number, nz: number) => {
      if (d < best) best = d, out[0] = nx, out[1] = ny, out[2] = nz;
    };
    if (!this.solidAt(ix, iy + 1, iz)) face(iy + 1 - py, 0, 1, 0);
    if (!this.solidAt(ix, iy - 1, iz)) face(py - iy, 0, -1, 0);
    if (!this.solidAt(ix + 1, iy, iz)) face(ix + 1 - px, 1, 0, 0);
    if (!this.solidAt(ix - 1, iy, iz)) face(px - ix, -1, 0, 0);
    if (!this.solidAt(ix, iy, iz + 1)) face(iz + 1 - pz, 0, 0, 1);
    if (!this.solidAt(ix, iy, iz - 1)) face(pz - iz, 0, 0, -1);
    if (best === Infinity) {
      // Buried: out the top of the column.
      const top = this.world.heightAt(ix, iz);
      face(Math.min(1, top + 1 - py), 0, 1, 0);
    }
    out[3] = best;
    return true;
  }

  /** A point inside the post a tree or rock stands as. */
  private pointInProp(px: number, py: number, pz: number, ix: number, iz: number): boolean {
    const w = this.world;
    if (ix < 0 || iz < 0 || ix >= w.sizeX || iz >= w.sizeZ) return false;
    const key = iz * w.sizeX + ix;
    if (!w.propSolid[key]) return false;
    const ground = w.top[key] + 1;
    if (py < ground || py > ground + PROP_HEIGHT) return false;
    const lx = px - ix - 0.5, lz = pz - iz - 0.5;
    const dx = PROP_HALF - Math.abs(lx), dz = PROP_HALF - Math.abs(lz);
    if (dx <= 0 || dz <= 0) return false;
    const out = this.hn;
    const dy = ground + PROP_HEIGHT - py;
    if (dy < dx && dy < dz) out[0] = 0, out[1] = 1, out[2] = 0, out[3] = dy;
    else if (dx < dz) out[0] = Math.sign(lx) || 1, out[1] = 0, out[2] = 0, out[3] = dx;
    else out[0] = 0, out[1] = 0, out[2] = Math.sign(lz) || 1, out[3] = dz;
    return true;
  }

  /** A sphere against the voxels, slopes and tree posts around it. */
  private sphereInWorld(cx: number, cy: number, cz: number, r: number) {
    const w = this.world;
    const x0 = Math.floor(cx - r), x1 = Math.floor(cx + r);
    const y0 = Math.floor(cy - r), y1 = Math.floor(cy + r);
    const z0 = Math.floor(cz - r), z1 = Math.floor(cz + r);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const top = w.heightAt(x, z);
        if (x >= 0 && z >= 0 && x < w.sizeX && z < w.sizeZ && w.propSolid[z * w.sizeX + x]) {
          const g = top + 1;
          this.sphereBox(
            cx,
            cy,
            cz,
            r,
            x + 0.5 - PROP_HALF,
            x + 0.5 + PROP_HALF,
            g,
            g + PROP_HEIGHT,
            z + 0.5 - PROP_HALF,
            z + 0.5 + PROP_HALF,
            false,
          );
        }
        for (let y = y0; y <= y1; y++) {
          if (!this.solidAt(x, y, z)) continue;
          if (y === top && y >= 0) {
            const mask = w.slopeMask(x, z);
            if (mask && cx >= x && cx < x + 1 && cz >= z && cz < z + 1) {
              const fx = cx - x, fz = cz - z;
              const s = y + 1 - slopeDrop(mask, fx, fz);
              this.slopeNormal(mask, fx, fz);
              const n = this.hn, dist = (cy - s) * n[1];
              if (dist < r) {
                this.candidate(
                  cx - n[0] * r,
                  cy - n[1] * r,
                  cz - n[2] * r,
                  n[0],
                  n[1],
                  n[2],
                  r - dist,
                );
              }
              continue;
            }
            if (mask) {
              // Beside a sloped column: its top is lower toward the dropped corners.
              const qx = Math.min(x + 1, Math.max(x, cx)), qz = Math.min(z + 1, Math.max(z, cz));
              this.sphereBox(
                cx,
                cy,
                cz,
                r,
                x,
                x + 1,
                y,
                y + 1 - slopeDrop(mask, qx - x, qz - z),
                z,
                z + 1,
                true,
              );
              continue;
            }
          }
          this.sphereBox(cx, cy, cz, r, x, x + 1, y, y + 1, z, z + 1, true);
        }
      }
    }
  }

  /**
   * A sphere against a box. For voxels (`grid`), the push through a face that another solid voxel
   * covers is dropped, so a ball rolls across a floor of blocks without catching on their seams.
   */
  private sphereBox(
    cx: number,
    cy: number,
    cz: number,
    r: number,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    grid: boolean,
  ) {
    const qx = Math.min(x1, Math.max(x0, cx)), qy = Math.min(y1, Math.max(y0, cy));
    const qz = Math.min(z1, Math.max(z0, cz));
    let dx = cx - qx, dy = cy - qy, dz = cz - qz;
    if (!dx && !dy && !dz) {
      // The center is inside: out through the nearest face.
      const faces = [cx - x0, x1 - cx, cy - y0, y1 - cy, cz - z0, z1 - cz];
      let k = 0;
      for (let i = 1; i < 6; i++) if (faces[i] < faces[k]) k = i;
      const n = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]][k];
      this.candidate(cx - n[0] * r, cy - n[1] * r, cz - n[2] * r, n[0], n[1], n[2], faces[k] + r);
      return;
    }
    if (grid) {
      const ix = Math.floor(x0), iy = Math.floor(y0), iz = Math.floor(z0);
      if (dx && this.solidAt(ix + (dx > 0 ? 1 : -1), iy, iz)) dx = 0;
      if (dy && this.solidAt(ix, iy + (dy > 0 ? 1 : -1), iz)) dy = 0;
      if (dz && this.solidAt(ix, iy, iz + (dz > 0 ? 1 : -1))) dz = 0;
      if (!dx && !dy && !dz) return;
    }
    const d = Math.hypot(dx, dy, dz);
    if (d >= r) return;
    const nx = dx / d, ny = dy / d, nz = dz / d;
    this.candidate(cx - nx * r, cy - ny * r, cz - nz * r, nx, ny, nz, r - d);
  }

  private collideWorld(rt: Rt) {
    this.beginPair();
    const pts = rt.pts;
    for (let i = 0; i < pts.length; i += 3) {
      const px = pts[i], py = pts[i + 1], pz = pts[i + 2];
      if (this.pointInWorld(px, py, pz)) {
        const n = this.hn;
        this.candidate(px, py, pz, n[0], n[1], n[2], n[3]);
      }
    }
    const parts = rt.shape.parts;
    for (let j = 0; j < parts.length; j++) {
      if (!parts[j].r) continue;
      this.sphereInWorld(rt.partC[j * 3], rt.partC[j * 3 + 1], rt.partC[j * 3 + 2], parts[j].r);
    }
    this.flush(rt, null, -1);
  }

  /** Villagers and animals are moving capsules: they shove light bodies and stop at heavy ones. */
  private collideMovers(rt: Rt) {
    const movers = this.movers;
    for (let m = 0; m < movers.length; m++) {
      const mv = movers[m];
      if (mv.ignore === rt.o.id) continue;
      const ya = mv.y + mv.bottom + mv.radius, yb = mv.y + mv.top - mv.radius;
      const dx = rt.p[0] - mv.x, dz = rt.p[2] - mv.z;
      const reach = rt.shape.radius + mv.radius;
      if (dx * dx + dz * dz > reach * reach) continue;
      if (
        rt.p[1] + rt.shape.radius < ya - mv.radius || rt.p[1] - rt.shape.radius > yb + mv.radius
      ) {
        continue;
      }
      this.beginPair();
      const capsule = (px: number, py: number, pz: number, r: number) => {
        const cy = Math.min(yb, Math.max(ya, py));
        const ex = px - mv.x, ey = py - cy, ez = pz - mv.z;
        const d = Math.hypot(ex, ey, ez), reach = mv.radius + r;
        if (d >= reach) return;
        const nx = d > 1e-6 ? ex / d : 1, ny = d > 1e-6 ? ey / d : 0, nz = d > 1e-6 ? ez / d : 0;
        this.candidate(px - nx * r, py - ny * r, pz - nz * r, nx, ny, nz, reach - d);
      };
      const pts = rt.pts;
      for (let i = 0; i < pts.length; i += 3) capsule(pts[i], pts[i + 1], pts[i + 2], 0);
      const parts = rt.shape.parts;
      for (let j = 0; j < parts.length; j++) {
        if (parts[j].r) {
          capsule(rt.partC[j * 3], rt.partC[j * 3 + 1], rt.partC[j * 3 + 2], parts[j].r);
        }
      }
      this.flush(rt, null, m, mv.vx, mv.vy, mv.vz, mv.shove);
    }
  }

  /** Two bodies: each one's points against the other's parts, spheres exactly. */
  private collidePair(a: Rt, b: Rt) {
    this.beginPair();
    this.pointsInto(a, b);
    this.flushPair(a, b);
    this.beginPair();
    this.pointsInto(b, a);
    this.flushPair(b, a);
  }

  private flushPair(a: Rt, b: Rt) {
    if (!cand.n) return;
    if (a.dynamic) this.flush(a, b.dynamic ? b : b, -1);
    else {
      // Only `b` moves: flip the contacts so the moving body is always first.
      const f = cand.f;
      for (let i = 0; i < cand.n; i++) {
        const o = i * 7;
        f[o + 3] = -f[o + 3], f[o + 4] = -f[o + 4], f[o + 5] = -f[o + 5];
      }
      this.flush(b, a, -1);
    }
  }

  /** `a`'s points and spheres inside `b`'s parts: contacts pushing `a` out along b's faces. */
  private pointsInto(a: Rt, b: Rt) {
    const bp = b.shape.parts, ap = a.shape.parts, reach = b.shape.radius;
    const pts = a.pts, owner = a.shape.pointPart;
    const nb = bp.length;
    if (this.satDone.length < ap.length * nb) {
      this.satDone = new Uint8Array(ap.length * nb);
      this.satAxis = new Float64Array(ap.length * nb * 4);
    }
    this.satDone.fill(0, 0, ap.length * nb);
    for (let i = 0; i < pts.length; i += 3) {
      const px = pts[i], py = pts[i + 1], pz = pts[i + 2];
      const dx = px - b.p[0], dy = py - b.p[1], dz = pz - b.p[2];
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      const pi = owner[i / 3];
      for (let j = 0; j < nb; j++) {
        if (ap[pi].kind === Kind.Box && bp[j].kind === Kind.Box) {
          // Box on box: every point pushes out along the pair's separating axis.
          if (!this.insideBox(b, j, px, py, pz)) continue;
          const k = (pi * nb + j) * 4, ax = this.satAxis;
          if (!this.satDone[pi * nb + j]) this.sat(a, pi, b, j, k), this.satDone[pi * nb + j] = 1;
          const nx = ax[k], ny = ax[k + 1], nz = ax[k + 2];
          const c = j * 3;
          const d = ax[k + 3] -
            ((px - b.partC[c]) * nx + (py - b.partC[c + 1]) * ny + (pz - b.partC[c + 2]) * nz);
          if (d > 0) this.candidate(px, py, pz, nx, ny, nz, d);
          continue;
        }
        if (this.pointInPart(b, j, px, py, pz, 0)) {
          const n = this.hn;
          this.candidate(px, py, pz, n[0], n[1], n[2], n[3]);
        }
      }
    }
    for (let i = 0; i < ap.length; i++) {
      const r = ap[i].r;
      if (!r) continue;
      const cx = a.partC[i * 3], cy = a.partC[i * 3 + 1], cz = a.partC[i * 3 + 2];
      const dx = cx - b.p[0], dy = cy - b.p[1], dz = cz - b.p[2];
      if (Math.hypot(dx, dy, dz) > reach + r) continue;
      for (let j = 0; j < nb; j++) {
        if (this.pointInPart(b, j, cx, cy, cz, r)) {
          const n = this.hn;
          this.candidate(cx - n[0] * r, cy - n[1] * r, cz - n[2] * r, n[0], n[1], n[2], n[3]);
        }
      }
    }
  }

  private satDone = new Uint8Array(0);
  private satAxis = new Float64Array(0);

  private insideBox(b: Rt, j: number, px: number, py: number, pz: number): boolean {
    const M = b.partR, o = j * 9, h = b.shape.parts[j].h;
    const ex = px - b.partC[j * 3], ey = py - b.partC[j * 3 + 1], ez = pz - b.partC[j * 3 + 2];
    return Math.abs(M[o] * ex + M[o + 3] * ey + M[o + 6] * ez) < h[0] &&
      Math.abs(M[o + 1] * ex + M[o + 4] * ey + M[o + 7] * ez) < h[1] &&
      Math.abs(M[o + 2] * ex + M[o + 5] * ey + M[o + 8] * ez) < h[2];
  }

  /**
   * The face axis (of either box) along which box part `i` of `a` and part `j` of `b` overlap
   * least, pointing from b toward a, and how far b reaches along it from its center: into
   * this.satAxis at `k`.
   */
  private sat(a: Rt, i: number, b: Rt, j: number, k: number) {
    const MA = a.partR, oa = i * 9, MB = b.partR, ob = j * 9;
    const ha = a.shape.parts[i].h, hb = b.shape.parts[j].h;
    const cx = a.partC[i * 3] - b.partC[j * 3], cy = a.partC[i * 3 + 1] - b.partC[j * 3 + 1];
    const cz = a.partC[i * 3 + 2] - b.partC[j * 3 + 2];
    let best = Infinity;
    const out = this.satAxis;
    for (let n = 0; n < 6; n++) {
      const M = n < 3 ? MA : MB, o = n < 3 ? oa : ob, col = n % 3;
      const lx = M[o + col], ly = M[o + 3 + col], lz = M[o + 6 + col];
      let ra = 0, rb = 0;
      for (let q = 0; q < 3; q++) {
        ra += ha[q] * Math.abs(lx * MA[oa + q] + ly * MA[oa + 3 + q] + lz * MA[oa + 6 + q]);
        rb += hb[q] * Math.abs(lx * MB[ob + q] + ly * MB[ob + 3 + q] + lz * MB[ob + 6 + q]);
      }
      const dist = cx * lx + cy * ly + cz * lz;
      const overlap = ra + rb - Math.abs(dist);
      // Ties go to the steadier choice: b's own faces, then the most upright.
      if (overlap < best - 1e-6) {
        best = overlap;
        const sgn = dist >= 0 ? 1 : -1;
        out[k] = lx * sgn, out[k + 1] = ly * sgn, out[k + 2] = lz * sgn, out[k + 3] = rb;
      }
    }
  }

  /**
   * Whether world point (px, py, pz), as a sphere of radius `r` (0 for a point), is inside part
   * `j` of body `b`; the way out (world normal) and depth go to this.hn.
   */
  private pointInPart(b: Rt, j: number, px: number, py: number, pz: number, r: number): boolean {
    const part = b.shape.parts[j], M = b.partR, o = j * 9;
    const ex = px - b.partC[j * 3], ey = py - b.partC[j * 3 + 1], ez = pz - b.partC[j * 3 + 2];
    // Into the part's frame: Mᵀ e.
    const lx = M[o] * ex + M[o + 3] * ey + M[o + 6] * ez;
    const ly = M[o + 1] * ex + M[o + 4] * ey + M[o + 7] * ez;
    const lz = M[o + 2] * ex + M[o + 5] * ey + M[o + 8] * ez;
    const hx = part.h[0], hy = part.h[1], hz = part.h[2];
    let nx = 0, ny = 0, nz = 0, depth = 0;
    if (part.r) {
      // A true sphere.
      const d = Math.hypot(lx, ly, lz), reach = part.r + r;
      if (d >= reach) return false;
      if (d > 1e-6) nx = lx / d, ny = ly / d, nz = lz / d;
      else ny = 1;
      depth = reach - d;
    } else if (part.kind === Kind.Box) {
      if (r) {
        // Sphere against box: the closest point on the box.
        const qx = Math.max(-hx, Math.min(hx, lx)), qy = Math.max(-hy, Math.min(hy, ly));
        const qz = Math.max(-hz, Math.min(hz, lz));
        const dx = lx - qx, dy = ly - qy, dz = lz - qz, d = Math.hypot(dx, dy, dz);
        if (d >= r) return false;
        if (d > 1e-6) nx = dx / d, ny = dy / d, nz = dz / d, depth = r - d;
        else return this.boxFace(hx, hy, hz, lx, ly, lz, r, M, o);
      } else {
        if (Math.abs(lx) >= hx || Math.abs(ly) >= hy || Math.abs(lz) >= hz) return false;
        return this.boxFace(hx, hy, hz, lx, ly, lz, 0, M, o);
      }
    } else if (part.kind === Kind.Ellipsoid) {
      const ax = hx + r, ay = hy + r, az = hz + r;
      const u = Math.hypot(lx / ax, ly / ay, lz / az);
      if (u >= 1) return false;
      const gx = lx / (ax * ax),
        gy = ly / (ay * ay),
        gz = lz / (az * az),
        g = Math.hypot(gx, gy, gz);
      if (g > 1e-9) nx = gx / g, ny = gy / g, nz = gz / g;
      else ny = 1;
      depth = (1 - u) * Math.min(ax, ay, az);
    } else {
      const cone = part.kind === Kind.Cone;
      const ay = hy + r;
      if (Math.abs(ly) >= ay) return false;
      // How wide it is at this height: a cylinder all the way, a cone narrowing to its apex.
      const s = cone ? Math.max(0, (hy - ly) / (2 * hy)) : 1;
      const ax = hx * s + r, az = hz * s + r;
      const rr = Math.hypot(lx / Math.max(1e-6, ax), lz / Math.max(1e-6, az));
      if (rr >= 1) return false;
      const side = (1 - rr) * Math.min(ax, az), cap = ay - Math.abs(ly);
      if (cap < side) {
        ny = ly >= 0 ? 1 : -1, depth = cap;
      } else {
        const l = Math.hypot(lx, lz);
        const ux = l > 1e-6 ? lx / l : 1, uz = l > 1e-6 ? lz / l : 0;
        if (cone) {
          // A cone's side leans in: its normal points out and up.
          const k = Math.hypot(2 * hy, Math.min(hx, hz));
          nx = ux * 2 * hy / k, nz = uz * 2 * hy / k, ny = Math.min(hx, hz) / k;
        } else nx = ux, nz = uz;
        depth = side;
      }
    }
    const out = this.hn;
    out[0] = M[o] * nx + M[o + 1] * ny + M[o + 2] * nz;
    out[1] = M[o + 3] * nx + M[o + 4] * ny + M[o + 5] * nz;
    out[2] = M[o + 6] * nx + M[o + 7] * ny + M[o + 8] * nz;
    out[3] = depth;
    return true;
  }

  /** Out of a box through its nearest face (the point at local l, inflated by r). */
  private boxFace(
    hx: number,
    hy: number,
    hz: number,
    lx: number,
    ly: number,
    lz: number,
    r: number,
    M: Float64Array,
    o: number,
  ): boolean {
    const dx = hx - Math.abs(lx), dy = hy - Math.abs(ly), dz = hz - Math.abs(lz);
    let nx = 0, ny = 0, nz = 0, depth: number;
    if (dy <= dx && dy <= dz) ny = ly >= 0 ? 1 : -1, depth = dy;
    else if (dx <= dz) nx = lx >= 0 ? 1 : -1, depth = dx;
    else nz = lz >= 0 ? 1 : -1, depth = dz;
    const out = this.hn;
    out[0] = M[o] * nx + M[o + 1] * ny + M[o + 2] * nz;
    out[1] = M[o + 3] * nx + M[o + 4] * ny + M[o + 5] * nz;
    out[2] = M[o + 6] * nx + M[o + 7] * ny + M[o + 8] * nz;
    out[3] = depth + r;
    return true;
  }

  // ---------------------------------------------------------------- solver

  private prepare(h: number) {
    const c = this.contacts, f = c.f;
    for (let k = 0; k < c.n; k++) {
      const o = k * Contacts.F, a = c.a[k], b = c.b[k];
      const nx = f[o + NX], ny = f[o + NX + 1], nz = f[o + NX + 2];
      for (let i = 0; i < 3; i++) {
        f[o + RA + i] = f[o + PX + i] - a.p[i];
        f[o + RB + i] = b ? f[o + PX + i] - b.p[i] : 0;
      }
      // Tangents.
      let t1x: number, t1y: number, t1z: number;
      if (Math.abs(nx) < 0.57) t1x = 0, t1y = nz, t1z = -ny;
      else t1x = -nz, t1y = 0, t1z = nx;
      const l = Math.hypot(t1x, t1y, t1z);
      t1x /= l, t1y /= l, t1z /= l;
      f[o + T1] = t1x, f[o + T1 + 1] = t1y, f[o + T1 + 2] = t1z;
      f[o + T2] = ny * t1z - nz * t1y, f[o + T2 + 1] = nz * t1x - nx * t1z;
      f[o + T2 + 2] = nx * t1y - ny * t1x;
      f[o + MN] = this.mass(a, b, o, NX);
      f[o + MT1] = this.mass(a, b, o, T1);
      f[o + MT2] = this.mass(a, b, o, T2);
      const vn = this.relVel(a, b, o, NX);
      f[o + APPROACH] = -vn;
      let bias = Math.min(MAX_CORRECTION, (BAUMGARTE / h) * Math.max(0, f[o + DEPTH] - SLOP));
      if (vn < -BOUNCE_SPEED) bias = Math.max(bias, -RESTITUTION * vn);
      f[o + BIAS] = bias;
      f[o + LN] = 0, f[o + LT1] = 0, f[o + LT2] = 0;
      // A mover shoves with limited strength per step.
      if (c.mover[k] >= 0) f[o + CAP] = this.movers[c.mover[k]].shove * h;
      // Fast enough into something resting: wake it, and note the impact for landings.
      if (b && !b.dynamic && b.o.asleep && (-vn > WAKE_SPEED || this.speed(a) > WAKE_SPEED)) {
        this.wake(b.o);
      }
      if (c.mover[k] < 0) a.impact = Math.max(a.impact, -vn);
    }
  }

  private speed(rt: Rt): number {
    return Math.hypot(rt.v[0], rt.v[1], rt.v[2]);
  }

  /** Effective mass along direction at offset `d` of contact `o`. */
  private mass(a: Rt, b: Rt | null, o: number, d: number): number {
    const f = this.contacts.f;
    let k = a.invMass + this.angular(a.invIw, f, o + RA, o + d);
    if (b?.dynamic) k += b.invMass + this.angular(b.invIw, f, o + RB, o + d);
    return k > 0 ? 1 / k : 0;
  }

  /** n · ((I⁻¹ (r × n)) × r) */
  private angular(I: Float64Array, f: Float64Array, ri: number, ni: number): number {
    const rx = f[ri], ry = f[ri + 1], rz = f[ri + 2], nx = f[ni], ny = f[ni + 1], nz = f[ni + 2];
    const cx = ry * nz - rz * ny, cy = rz * nx - rx * nz, cz = rx * ny - ry * nx;
    const ix = I[0] * cx + I[1] * cy + I[2] * cz;
    const iy = I[3] * cx + I[4] * cy + I[5] * cz;
    const iz = I[6] * cx + I[7] * cy + I[8] * cz;
    return nx * (iy * rz - iz * ry) + ny * (iz * rx - ix * rz) + nz * (ix * ry - iy * rx);
  }

  /** Relative velocity of a over b at the contact, along direction at offset d. */
  private relVel(a: Rt, b: Rt | null, o: number, d: number): number {
    const f = this.contacts.f;
    const ax = f[o + RA], ay = f[o + RA + 1], az = f[o + RA + 2];
    let vx = a.v[0] + a.w[1] * az - a.w[2] * ay;
    let vy = a.v[1] + a.w[2] * ax - a.w[0] * az;
    let vz = a.v[2] + a.w[0] * ay - a.w[1] * ax;
    if (b?.dynamic) {
      const bx = f[o + RB], by = f[o + RB + 1], bz = f[o + RB + 2];
      vx -= b.v[0] + b.w[1] * bz - b.w[2] * by;
      vy -= b.v[1] + b.w[2] * bx - b.w[0] * bz;
      vz -= b.v[2] + b.w[0] * by - b.w[1] * bx;
    }
    vx -= f[o + KV], vy -= f[o + KV + 1], vz -= f[o + KV + 2];
    return vx * f[o + d] + vy * f[o + d + 1] + vz * f[o + d + 2];
  }

  private apply(a: Rt, b: Rt | null, o: number, d: number, j: number) {
    const f = this.contacts.f;
    const px = f[o + d] * j, py = f[o + d + 1] * j, pz = f[o + d + 2] * j;
    this.impulse(a, f[o + RA], f[o + RA + 1], f[o + RA + 2], px, py, pz);
    if (b?.dynamic) this.impulse(b, f[o + RB], f[o + RB + 1], f[o + RB + 2], -px, -py, -pz);
  }

  private impulse(rt: Rt, rx: number, ry: number, rz: number, px: number, py: number, pz: number) {
    const m = rt.invMass, I = rt.invIw;
    rt.v[0] += px * m, rt.v[1] += py * m, rt.v[2] += pz * m;
    const tx = ry * pz - rz * py, ty = rz * px - rx * pz, tz = rx * py - ry * px;
    rt.w[0] += I[0] * tx + I[1] * ty + I[2] * tz;
    rt.w[1] += I[3] * tx + I[4] * ty + I[5] * tz;
    rt.w[2] += I[6] * tx + I[7] * ty + I[8] * tz;
  }

  private solve() {
    const c = this.contacts, f = c.f;
    for (let k = 0; k < c.n; k++) {
      const o = k * Contacts.F, a = c.a[k], b = c.b[k];
      const vn = this.relVel(a, b, o, NX);
      let dl = f[o + MN] * (f[o + BIAS] - vn);
      const old = f[o + LN];
      const total = Math.min(f[o + CAP], Math.max(0, old + dl));
      dl = total - old;
      f[o + LN] = total;
      if (dl) this.apply(a, b, o, NX, dl);
      const limit = FRICTION * total * (c.mover[k] >= 0 ? 0.5 : 1);
      for (const [T, L, MT] of [[T1, LT1, MT1], [T2, LT2, MT2]]) {
        const vt = this.relVel(a, b, o, T);
        let dt = -f[o + MT] * vt;
        const was = f[o + L];
        const now = Math.max(-limit, Math.min(limit, was + dt));
        dt = now - was;
        f[o + L] = now;
        if (dt) this.apply(a, b, o, T, dt);
      }
    }
  }

  /** Hard blows to movers, strongest per mover per tick. */
  private report() {
    const c = this.contacts, f = c.f;
    for (let k = 0; k < c.n; k++) {
      const m = c.mover[k];
      if (m < 0) continue;
      const o = k * Contacts.F, a = c.a[k];
      const speed = f[o + APPROACH];
      if (speed <= 0) continue;
      const momentum = speed * a.shape.mass;
      if (momentum <= this.moverHit[m * 2]) continue;
      this.moverHit[m * 2] = momentum;
      const nx = -f[o + NX], nz = -f[o + NX + 2], l = Math.hypot(nx, nz) || 1;
      const hit = this.hits.find((h) => h.mover === m);
      const next = { body: a.o, mover: m, speed, momentum, nx: nx / l, nz: nz / l };
      if (hit) Object.assign(hit, next);
      else this.hits.push(next);
    }
  }

  private integrate(rt: Rt, h: number) {
    const v = rt.v, w = rt.w, p = rt.p, q = rt.q;
    const sp = Math.hypot(v[0], v[1], v[2]);
    if (sp > MAX_SPEED) { for (let k = 0; k < 3; k++) v[k] *= MAX_SPEED / sp; }
    const sw = Math.hypot(w[0], w[1], w[2]);
    if (sw > MAX_SPIN) { for (let k = 0; k < 3; k++) w[k] *= MAX_SPIN / sw; }
    p[0] += v[0] * h, p[1] += v[1] * h, p[2] += v[2] * h;
    // q += ½ (ω, 0) q h
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3], k = 0.5 * h;
    q[0] += k * (w[0] * qw + w[1] * qz - w[2] * qy);
    q[1] += k * (w[1] * qw + w[2] * qx - w[0] * qz);
    q[2] += k * (w[2] * qw + w[0] * qy - w[1] * qx);
    q[3] += k * (-w[0] * qx - w[1] * qy - w[2] * qz);
    const l = Math.hypot(q[0], q[1], q[2], q[3]);
    for (let i = 0; i < 4; i++) q[i] /= l;
    // Keep it in the world: below bedrock or past the edges it stops.
    const W = this.world;
    p[0] = Math.max(0.5, Math.min(W.sizeX - 0.5, p[0]));
    p[2] = Math.max(0.5, Math.min(W.sizeZ - 0.5, p[2]));
    if (p[1] < 0) p[1] = 0, v[1] = Math.max(0, v[1]);
    this.pose(rt);
  }

  /** After a tick: write the state back, note landings, and let still bodies sleep. */
  private settle(rt: Rt, dt: number) {
    const o = rt.o, v = rt.v, w = rt.w, s = rt.shape, R = rt.R, c = s.com;
    for (let k = 0; k < 3; k++) {
      o.pos[k] = rt.p[k] - (R[k * 3] * c[0] + R[k * 3 + 1] * c[1] + R[k * 3 + 2] * c[2]);
      o.vel[k] = v[k], o.spin[k] = w[k];
    }
    for (let i = 0; i < 4; i++) o.rot[i] = rt.q[i];
    this.moved.push(o);
    const air = o.air ?? 0;
    if (rt.impact > LAND_SPEED && air > 2) this.landings.push({ body: o, speed: rt.impact });
    o.air = rt.impact > 0 ? 0 : air + 1;
    const still = Math.hypot(v[0], v[1], v[2]) < SLEEP_SPEED &&
      Math.hypot(w[0], w[1], w[2]) < SLEEP_SPIN;
    o.still = still ? (o.still ?? 0) + 1 : 0;
    if (o.still >= SLEEP_TICKS * Math.max(1, Math.round(0.05 / dt))) {
      o.asleep = true;
      o.vel.fill(0), o.spin.fill(0);
      delete o.mover, delete o.byRule, delete o.still, delete o.air;
      rt.v.fill(0), rt.w.fill(0);
    }
  }
}
