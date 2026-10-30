import {
  type Catalog,
  type DesignContent,
  type JointKind,
  type MaterialContent,
  rigOf,
  shapeOf,
  type Vec3,
} from "./catalog.ts";
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
 *
 * Joints (physics phase 3): a Design's parts may split into pieces, each its own body, held
 * together by hinge, axle, slider and motor parts. Each joint is a handful of constraint rows
 * solved with the contacts: the pin stays together, the axis stays lined up, limits stop it, and
 * motors and used hinges drive it. Pieces of one Object never collide with each other, and sleep
 * and wake together.
 */

export const GRAVITY = 9.8;
/** Physics steps per 20 Hz tick, and solver passes per step. */
const SUBSTEPS = 2;
const ITERATIONS = 8;
/** Points are spread over part surfaces at about this spacing (blocks). */
const SPACING = 0.7;
const MAX_POINTS = 200;
/** Between bodies; and against the ground, grippy enough that a box stays put on a 45° slope. */
const FRICTION = 0.6;
const GROUND_FRICTION = 1.1;
/** Penetration left alone, and how fast the rest is corrected. */
const SLOP = 0.01;
const BAUMGARTE = 0.3;
/** Joints pull back together a little harder than contacts push apart. */
const JOINT_BAUMGARTE = 0.4;
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
/** Per-second spin lost to the grass while touching the ground: a pushed ball rolls a few tiles. */
const ROLL_DRAG = 1.2;
/** Water surfaces sit this far below the top of their water block (as drawn). */
const SURFACE_DROP = 0.12;
/** Trees and rocks stop bodies like a post this wide (half) and tall. */
const PROP_HALF = 0.3;
const PROP_HEIGHT = 2.5;
/** A body hitting the ground faster than this has landed (Rules hear it). */
export const LAND_SPEED = 2.5;

/** Most a motor turns with (tonne · blocks² / s²): sails, mills and small carts, not boulders. */
export const MOTOR_TORQUE = 12;
/** A used hinge or slider swings to its limit this fast at most (radians, or blocks, per second). */
const SERVO_SPEED = 1.6;
/** How hard it drives there and holds (torque, or force for a slider), so a door stays shut. */
export const SERVO_TORQUE = 12;
/** How quickly a used hinge closes in on where it's going (per second). */
const SERVO_GAIN = 5;
/** Friction in a free hinge or axle, so a swing slows and a wheel coasts to a stop. */
const JOINT_FRICTION = 0.02;
/** A limit starts pushing back this close to it (radians or blocks). */
const LIMIT_MARGIN = 0.05;

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
  /**
   * Its landing doesn't fire Rules until it next sleeps: a Rule nudged it (Rules don't chain), or
   * it's settling where it was just built.
   */
  quiet?: boolean;
  /** A steady push this tick: force (tonne · blocks/s²) and torque about its center. */
  force?: number[];
  /** Ticks it has been still (it sleeps at SLEEP_TICKS), and ticks since it touched anything. */
  still?: number;
  air?: number;
  /** A jointed Object's other pieces (its root piece is the body itself), in its Design's order. */
  pieces?: PieceState[];
  /** Its joints' state, in its Design's order. */
  joints?: JointState[];
}

/** Where one piece of a jointed Object is: its Design origin and turn as the piece carries them. */
export interface PieceState {
  pos: Vec3;
  rot: Quat;
  vel: Vec3;
  spin: Vec3;
}

export interface JointState {
  /** A motor turns while on. */
  on?: boolean;
  /** Where a hinge (radians) or slider (blocks) with limits is driven to and held; 0 as built. */
  target?: number;
  /** Where it is now: radians a hinge has swung, blocks a slider has slid. */
  at?: number;
}

/** A joint as the engine sees it, in Design space. */
export interface JointDef {
  kind: JointKind;
  /** The pieces it joins; the angle is b's turn relative to a. */
  a: number;
  b: number;
  /** The pin, and the axis it turns about or slides along. */
  anchor: Vec3;
  axis: Vec3;
  /** Limits (radians, or blocks for sliders) if it has any. */
  limits: [number, number] | null;
  /** Motors: radians per second while on. */
  speed: number;
  /** The piece it moves (b's name) and its part's index in the Design. */
  piece: string;
  part: number;
}

/** Every piece's shape and the joints between them. */
export interface Assembly {
  shapes: Shape[];
  joints: JointDef[];
  pieces: string[];
  /** Tonnes, all pieces together. */
  mass: number;
  /** Some piece can move (an unanchored root, or anything on a joint). */
  movable: boolean;
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
export function compileShape(catalog: Catalog, d: DesignContent, piece = -1): Shape {
  const parts: { kind: number; at: Vec3; h: Vec3; R: Float64Array; m: number; cm: Vec3 }[] = [];
  let mass = 0;
  const com: Vec3 = [0, 0, 0];
  const pieceOf = rigOf(d).pieceOf;
  for (let i = 0; i < d.parts.length; i++) {
    const p = d.parts[i];
    if (piece >= 0 && pieceOf[i] !== piece) continue;
    const kind = KINDS[shapeOf(p.part)] ?? Kind.Box;
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
    fixed: piece <= 0 && (!!d.blocks || !!d.anchored),
  };
}

/** A Design's pieces as bodies and its joints between them. */
export function compileAssembly(catalog: Catalog, d: DesignContent): Assembly {
  const rig = rigOf(d);
  const shapes = rig.pieces.map((_, k) => compileShape(catalog, d, k));
  const joints = rig.joints.map((j): JointDef => {
    const p = d.parts[j.part], R = partAxes(p.turn, p.tilt);
    const rad = j.kind === "hinge" ? DEG : 1;
    return {
      kind: j.kind,
      a: j.a,
      b: j.b,
      anchor: [...p.at],
      axis: [R[1], R[4], R[7]],
      limits: p.limits ? [p.limits[0] * rad, p.limits[1] * rad] : null,
      speed: (p.speed ?? 0) * DEG,
      piece: rig.pieces[j.b],
      part: j.part,
    };
  });
  const mass = rig.pieces.length > 1
    ? shapes.reduce((m, s) => m + (s.parts.length ? s.mass : 0), 0)
    : shapes[0].mass;
  return {
    shapes,
    joints,
    pieces: rig.pieces,
    mass,
    movable: shapes.some((s) => !s.fixed),
  };
}

/** Give a jointed Object its pieces' and joints' state if it lacks them: all as built. */
export function ensurePieces(o: BodyState, asm: Assembly) {
  const n = asm.shapes.length - 1;
  if ((o.pieces?.length ?? 0) !== n) {
    o.pieces = Array.from({ length: n }, (_, i) => o.pieces?.[i] ?? asBuilt(o));
    if (!n) delete o.pieces;
  }
  if ((o.joints?.length ?? 0) !== asm.joints.length) {
    o.joints = asm.joints.map((_, i) => o.joints?.[i] ?? {});
    if (!asm.joints.length) delete o.joints;
  }
}

/** A piece where the root has it as built. */
const asBuilt = (o: BodyState): PieceState => ({
  pos: [...o.pos],
  rot: [...o.rot],
  vel: [...o.vel],
  spin: [...o.spin],
});

/** Put every piece back where the root has it as built (carried things fold up as made). */
export function foldPieces(o: BodyState) {
  for (const p of o.pieces ?? []) {
    p.pos = [...o.pos], p.rot = [...o.rot], p.vel = [...o.vel], p.spin = [...o.spin];
  }
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
  // Boxes keep their edge midpoints: a crate turned 45° on another touches it only there.
  const segs = (h: number) =>
    Math.min(8, Math.max(kind === Kind.Box ? 2 : 1, Math.ceil((2 * h) / SPACING)));
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

/**
 * The world boxes ([x0, x1, y0, y1, z0, z1, piece]) of a Design's parts with its origin at pos,
 * turned rot, each part where its piece has it.
 */
export function poseBoxes(
  d: DesignContent,
  pos: Vec3,
  rot: Quat,
  pieces?: PieceState[],
): number[][] {
  const Rs = [quatMatrix(rot, new Float64Array(9))], M = new Float64Array(9);
  const poses = [pos];
  for (const p of pieces ?? []) Rs.push(quatMatrix(p.rot, new Float64Array(9))), poses.push(p.pos);
  const pieceOf = rigOf(d).pieceOf;
  return d.parts.map((p, i) => {
    const k = Math.min(pieceOf[i], Rs.length - 1), R = Rs[k], pos = poses[k];
    mul3(R, partAxes(p.turn, p.tilt), M);
    const hx = p.size[0] / 2, hy = p.size[1] / 2, hz = p.size[2] / 2;
    const c = [0, 1, 2].map((k) =>
      pos[k] + R[k * 3] * p.at[0] + R[k * 3 + 1] * p.at[1] + R[k * 3 + 2] * p.at[2]
    );
    const e = [0, 1, 2].map((k) =>
      Math.abs(M[k * 3]) * hx + Math.abs(M[k * 3 + 1]) * hy + Math.abs(M[k * 3 + 2]) * hz
    );
    return [c[0] - e[0], c[0] + e[0], c[1] - e[1], c[1] + e[1], c[2] - e[2], c[2] + e[2], k];
  });
}

// ---------------------------------------------------------------- runtime

/** Where a body's pose lives: the Object itself for its root piece, else one of its pieces. */
type PoseState = Pick<BodyState, "pos" | "rot" | "vel" | "spin">;

/** A body (one piece of an Object) as the solver sees it this tick. */
class Rt {
  shape!: Shape;
  /** The Object's pieces' bodies, shared by all of them; the root first. */
  group: Rt[] = [];
  /** Where its pose is kept. */
  s: PoseState;
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
  /** Its place in the solver's arrays this step. */
  index = 0;
  /** The last step its group was settled in. */
  stamp = 0;
  constructor(public o: BodyState, readonly piece: number) {
    this.s = o;
  }
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
  static readonly F = 65;
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
/**
 * Joint rows, struct-of-arrays: each is one direction a joint holds or drives, between bodies a
 * and b (index -1: static). Relative velocity is JL·(va − vb) + JA·wa + JB·wb.
 */
class Rows {
  n = 0;
  cap = 0;
  f = new Float64Array(0);
  ia = new Int32Array(0);
  ib = new Int32Array(0);
  static readonly F = 20;
  ensure(n: number) {
    if (n <= this.cap) return;
    this.cap = Math.max(n, this.cap * 2, 64);
    const f = new Float64Array(this.cap * Rows.F);
    f.set(this.f);
    this.f = f;
    const a = new Int32Array(this.cap), b = new Int32Array(this.cap);
    a.set(this.ia), b.set(this.ib);
    this.ia = a, this.ib = b;
  }
}
// Field offsets in Rows.f: linear, a's angular, b's angular, their I⁻¹ images, effective mass,
// target velocity, impulse bounds and the impulse so far.
const JL = 0, JA = 3, JB = 6, MA = 9, MB = 12, JM = 15, JBIAS = 16, JLO = 17, JHI = 18, JACC = 19;

// Field offsets in Contacts.f: the point, normal, depth, a mover's velocity, then per direction
// (normal, tangent, tangent) a row of d, rA × d, I⁻¹(rA × d), rB × d, I⁻¹(rB × d), mass, impulse.
const PX = 0,
  NX = 3,
  DEPTH = 6,
  KV = 7,
  BIAS = 10,
  CAP = 11,
  APPROACH = 12,
  DIR = 13,
  ROW = 17,
  MU = 64;

const dist2 = (f: Float64Array, a: number, b: number) =>
  (f[a] - f[b]) ** 2 + (f[a + 1] - f[b + 1]) ** 2 + (f[a + 2] - f[b + 2]) ** 2;

/** Candidate contacts for one pair before they're reduced to a few per direction. */
const cand = { n: 0, f: new Float64Array(7 * 512) };

const NO_JOINTS: JointState[] = [];
/** A joint's pull back toward lined up: Baumgarte, capped. */
const fix = (k: number, e: number) => Math.max(-MAX_CORRECTION, Math.min(MAX_CORRECTION, -k * e));
/** A limit's row target: past it, push back; short of it, come no closer than reaching it. */
const stop = (gap: number, h: number) => gap < 0 ? -gap * JOINT_BAUMGARTE / h : -gap / h;

export class Physics {
  private rts = new Map<number, Rt>();
  private assemblies = new Map<number, Assembly>();
  private shapesVersion = -1;
  private contacts = new Contacts();
  private rows = new Rows();
  private awake: Rt[] = [];
  private all: Rt[] = [];
  /** Objects with joints in play this tick, by their root body. */
  private jointed: Rt[] = [];
  private stampNow = 0;
  readonly hits: Hit[] = [];
  /** Bodies that landed hard this tick, and how fast. */
  readonly landings: { body: BodyState; speed: number }[] = [];
  /** Bodies whose pose changed this tick (their tiles need re-marking). */
  readonly moved: BodyState[] = [];
  private movers: Mover[] = [];
  private moverHit = new Float64Array(0);

  constructor(readonly world: World, public catalog: Catalog) {}

  /** A Design's pieces and joints (cached per Catalog version). */
  assembly(design: number): Assembly | null {
    if (this.shapesVersion !== this.catalog.version) {
      this.assemblies.clear(), this.shapesVersion = this.catalog.version;
    }
    let a = this.assemblies.get(design);
    if (a) return a;
    const e = this.catalog.get(design);
    if (e?.kind !== "design") return null;
    a = compileAssembly(this.catalog, e.content as DesignContent);
    this.assemblies.set(design, a);
    return a;
  }

  /** The shape of a Design's root piece (the whole thing, unless it has joints). */
  shape(design: number): Shape | null {
    return this.assembly(design)?.shapes[0] ?? null;
  }

  /** Tonnes, all pieces together. */
  mass(design: number): number {
    return this.assembly(design)?.mass ?? 0;
  }

  /** Where a body's center of mass is (its root piece's). */
  center(o: BodyState): Vec3 {
    const s = this.shape(o.design);
    const R = quatMatrix(o.rot, tmp);
    const c = s?.com ?? [0, 0, 0];
    return [0, 1, 2].map((k) =>
      o.pos[k] + R[k * 3] * c[0] + R[k * 3 + 1] * c[1] + R[k * 3 + 2] * c[2]
    ) as Vec3;
  }

  /** Lowest point of a body turned `rot` as built, relative to its root's center of mass. */
  lowest(design: number, rot: ArrayLike<number>): number {
    const a = this.assembly(design);
    if (!a) return 0;
    const R = quatMatrix(rot, tmp2), c0 = a.shapes[0].com;
    let low = 0;
    for (const s of a.shapes) {
      const ox = s.com[0] - c0[0], oy = s.com[1] - c0[1], oz = s.com[2] - c0[2];
      const pts = s.points;
      for (let i = 0; i < pts.length; i += 3) {
        const x = ox + pts[i], y = oy + pts[i + 1], z = oz + pts[i + 2];
        low = Math.min(low, R[3] * x + R[4] * y + R[5] * z);
      }
      for (const p of s.parts) {
        if (!p.r) continue;
        const x = ox + p.c[0], y = oy + p.c[1], z = oz + p.c[2];
        low = Math.min(low, R[3] * x + R[4] * y + R[5] * z - p.r);
      }
    }
    return low;
  }

  /** Wake an Object: every piece that can move. */
  wake(o: BodyState) {
    const a = this.assembly(o.design);
    if (!a?.movable || o.held) return;
    if (o.asleep) o.asleep = false;
    o.still = 0;
    for (let k = 0; k < a.shapes.length; k++) {
      const rt = this.rts.get(o.id * 16 + k);
      if (rt) rt.posed = false;
    }
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
    const a = this.assembly(o.design);
    if (!a) return 0.5;
    const c = this.center(o);
    let best = 0;
    a.shapes.forEach((s, k) => {
      const at = k ? o.pieces?.[k - 1] ?? o : o;
      const R = quatMatrix(at.rot, tmp), m = s.com;
      // The piece's center of mass, from the root's.
      const ox = at.pos[0] + R[0] * m[0] + R[1] * m[1] + R[2] * m[2] - c[0];
      const oz = at.pos[2] + R[6] * m[0] + R[7] * m[1] + R[8] * m[2] - c[2];
      const along = (x: number, y: number, z: number) =>
        (ox + R[0] * x + R[1] * y + R[2] * z) * dx + (oz + R[6] * x + R[7] * y + R[8] * z) * dz;
      const pts = s.points;
      for (let i = 0; i < pts.length; i += 3) {
        best = Math.max(best, along(pts[i], pts[i + 1], pts[i + 2]));
      }
      for (const p of s.parts) if (p.r) best = Math.max(best, along(p.c[0], p.c[1], p.c[2]) + p.r);
    });
    return best;
  }

  /** Wake every body within `r` of a point (a block changed, something was lifted). */
  wakeNear(list: BodyState[], x: number, y: number, z: number, r: number) {
    for (const o of list) {
      if (!o.asleep) continue;
      const a = this.assembly(o.design);
      if (!a?.movable) continue;
      for (let k = 0; k < a.shapes.length; k++) {
        const at = k ? o.pieces?.[k - 1] ?? o : o;
        const s = a.shapes[k], R = quatMatrix(at.rot, tmp), m = s.com;
        const cx = at.pos[0] + R[0] * m[0] + R[1] * m[1] + R[2] * m[2];
        const cy = at.pos[1] + R[3] * m[0] + R[4] * m[1] + R[5] * m[2];
        const cz = at.pos[2] + R[6] * m[0] + R[7] * m[1] + R[8] * m[2];
        if (Math.hypot(cx - x, cy - y, cz - z) <= s.radius + r) {
          this.wake(o);
          break;
        }
      }
    }
  }

  /** Bodies that are gone (taken apart) drop their runtime state. */
  forget(id: number) {
    for (let k = 0; k < 16; k++) this.rts.delete(id * 16 + k);
  }

  /** One sim tick: every awake body, `SUBSTEPS` times. */
  step(list: BodyState[], movers: Mover[], dt: number) {
    this.hits.length = 0;
    this.landings.length = 0;
    this.moved.length = 0;
    this.movers = movers;
    if (this.moverHit.length < movers.length) this.moverHit = new Float64Array(movers.length);
    this.moverHit.fill(0);
    const awake = this.awake, all = this.all, jointed = this.jointed;
    awake.length = 0, all.length = 0, jointed.length = 0;
    for (const o of list) {
      if (o.held) continue; // carried overhead: out of the world until put down
      const asm = this.assembly(o.design);
      if (!asm) continue;
      if (asm.shapes.length > 1 || asm.joints.length) ensurePieces(o, asm);
      let group: Rt[] | null = null;
      for (let k = 0; k < asm.shapes.length; k++) {
        const rt = this.sync(o, k, asm.shapes[k]);
        if (k === 0) group = rt.group;
        else if (rt.group !== group) rt.group = group!;
        group![k] = rt;
        all.push(rt);
        if (rt.dynamic) awake.push(rt);
      }
      group!.length = asm.shapes.length;
      if (asm.joints.length) {
        for (const rt of group!) {
          if (rt.dynamic) {
            jointed.push(group![0]);
            break;
          }
        }
      }
    }
    this.wakeByMovers();
    if (!awake.length) return;
    for (const rt of awake) rt.impact = 0;
    all.sort((a, b) => a.p[0] - a.shape.radius - (b.p[0] - b.shape.radius));
    const h = dt / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) this.substep(h);
    const stamp = ++this.stampNow;
    for (const rt of awake) this.writeBack(rt);
    for (const rt of awake) {
      if (rt.group[0].stamp === stamp) continue;
      rt.group[0].stamp = stamp;
      this.settle(rt.group, dt);
    }
    for (const o of list) delete o.force;
  }

  /** A villager or animal walking into a sleeping body wakes it, so they can shove it. */
  private wakeByMovers() {
    const movers = this.movers, all = this.all;
    for (let m = 0; m < movers.length; m++) {
      const mv = movers[m];
      if (Math.abs(mv.vx) + Math.abs(mv.vz) < 0.2) continue;
      for (const rt of all) {
        if (rt.dynamic || rt.shape.fixed) continue;
        const r = rt.shape.radius, reach = r + mv.radius, p = rt.p;
        if ((mv.x - p[0]) ** 2 + (mv.z - p[2]) ** 2 >= reach * reach) continue;
        if (p[1] - r >= mv.y + mv.top || p[1] + r <= mv.y) continue;
        this.wake(rt.o);
        let joined = false;
        for (const g of rt.group) {
          if (g.dynamic || g.shape.fixed) continue;
          g.dynamic = true, g.invMass = g.shape.invMass;
          this.awake.push(g);
          joined = true;
        }
        const root = rt.group[0];
        if (joined && rt.group.length > 1 && !this.jointed.includes(root)) this.jointed.push(root);
      }
    }
  }

  /** The runtime body for piece `k` of `o`, its pose loaded from the saved state. */
  private sync(o: BodyState, k: number, shape: Shape): Rt {
    const key = o.id * 16 + k;
    let rt = this.rts.get(key);
    if (!rt || rt.o !== o) this.rts.set(key, rt = new Rt(o, k));
    rt.s = k ? o.pieces![k - 1] : o;
    if (rt.shape !== shape) {
      rt.shape = shape, rt.posed = false;
      rt.pts = new Float64Array(shape.points.length);
      rt.partC = new Float64Array(shape.parts.length * 3);
      rt.partR = new Float64Array(shape.parts.length * 9);
    }
    rt.dynamic = !shape.fixed && !o.asleep && !o.held;
    rt.invMass = rt.dynamic ? shape.invMass : 0;
    if (rt.dynamic || !rt.posed) {
      const st = rt.s;
      rt.q.set(st.rot);
      quatMatrix(rt.q, rt.R);
      const c = shape.com, R = rt.R;
      for (let i = 0; i < 3; i++) {
        rt.p[i] = st.pos[i] + R[i * 3] * c[0] + R[i * 3 + 1] * c[1] + R[i * 3 + 2] * c[2];
      }
      rt.v.set(st.vel), rt.w.set(st.spin);
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
    for (let j = 0; j < s.parts.length; j++) {
      const c = s.parts[j].c;
      for (let k = 0; k < 3; k++) {
        rt.partC[j * 3 + k] = p[k] + R[k * 3] * c[0] + R[k * 3 + 1] * c[1] + R[k * 3 + 2] * c[2];
      }
      mul3(R, s.parts[j].R, tmp);
      rt.partR.set(tmp, j * 9);
    }
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
    for (const rt of this.awake) {
      this.collideWorld(rt);
      this.collideMovers(rt);
    }
    // Pairs: sorted along x (nearly sorted from last step, so insertion sort is quick), each body
    // against the ones whose reach overlaps along x, at least one of them awake.
    const all = this.all;
    for (let i = 1; i < all.length; i++) {
      const rt = all[i], lo = rt.p[0] - rt.shape.radius;
      let j = i - 1;
      while (j >= 0 && all[j].p[0] - all[j].shape.radius > lo) all[j + 1] = all[j], j--;
      all[j + 1] = rt;
    }
    for (let i = 0; i < all.length; i++) {
      const a = all[i], ra = a.shape.radius, hi = a.p[0] + ra;
      for (let j = i + 1; j < all.length; j++) {
        const b = all[j];
        if (b.p[0] - b.shape.radius > hi) break;
        if (!a.dynamic && !b.dynamic) continue;
        if (a.o === b.o) continue; // pieces of one Object pass through each other
        const r = ra + b.shape.radius;
        const dx = a.p[0] - b.p[0], dy = a.p[1] - b.p[1], dz = a.p[2] - b.p[2];
        if (dx * dx + dy * dy + dz * dz > r * r) continue;
        this.collidePair(a, b);
      }
    }
    this.prepare(h);
    for (let it = 0; it < ITERATIONS; it++) this.solve();
    this.unload();
    this.report();
    for (const rt of this.awake) this.integrate(rt, h);
  }

  /** Gravity, buoyancy and drag. */
  private forces(rt: Rt, h: number) {
    const v = rt.v, w = rt.w, s = rt.shape, world = this.world;
    v[1] -= GRAVITY * h;
    const f = rt.piece ? undefined : rt.o.force;
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
    const grounded = (rt.o.air ?? 0) === 0 ? ROLL_DRAG : 0;
    const ang = Math.max(0, 1 - (AIR_SPIN_DRAG + WATER_SPIN_DRAG * share + grounded) * h);
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
    const n = cand.n, f = cand.f, bucket = this.bucket;
    if (!n) return;
    if (bucket.length < n) this.bucket = new Int8Array(cand.f.length / 7);
    const bk = this.bucket;
    let used = 0;
    for (let i = 0; i < n; i++) {
      const nx = f[i * 7 + 3], ny = f[i * 7 + 4], nz = f[i * 7 + 5];
      bk[i] = ny > 0.7
        ? 0
        : ny < -0.7
        ? 1
        : Math.abs(nx) > Math.abs(nz)
        ? (nx > 0 ? 2 : 3)
        : nz > 0
        ? 4
        : 5;
      used |= 1 << bk[i];
    }
    for (let q = 0; q < 6; q++) {
      if (!(used & (1 << q))) continue;
      let count = 0, deep = -1;
      for (let i = 0; i < n; i++) {
        if (bk[i] !== q) continue;
        count++;
        if (deep < 0 || f[i * 7 + 6] > f[deep * 7 + 6]) deep = i;
      }
      if (count <= 4) {
        for (let i = 0; i < n; i++) if (bk[i] === q) this.emit(a, b, i, mover, kvx, kvy, kvz, cap);
        continue;
      }
      const pick = this.pick;
      pick[0] = deep, pick[1] = pick[2] = pick[3] = -1;
      for (let slot = 1; slot < 4; slot++) {
        let best = -1, bestScore = -1;
        for (let i = 0; i < n; i++) {
          if (bk[i] !== q || i === pick[0] || i === pick[1] || i === pick[2]) continue;
          const o = i * 7, p0 = pick[0] * 7;
          let score: number;
          if (slot === 1) score = dist2(f, o, p0);
          else if (slot === 2) {
            // Distance from the line through the first two.
            const p1 = pick[1] * 7;
            const ax = f[p1] - f[p0], ay = f[p1 + 1] - f[p0 + 1], az = f[p1 + 2] - f[p0 + 2];
            const bx = f[o] - f[p0], by = f[o + 1] - f[p0 + 1], bz = f[o + 2] - f[p0 + 2];
            const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
            score = cx * cx + cy * cy + cz * cz;
          } else {
            score = Math.min(dist2(f, o, p0), dist2(f, o, pick[1] * 7), dist2(f, o, pick[2] * 7));
          }
          if (score > bestScore) bestScore = score, best = i;
        }
        if (best < 0) break;
        pick[slot] = best;
      }
      for (let i = 0; i < 4; i++) {
        if (pick[i] >= 0) this.emit(a, b, pick[i], mover, kvx, kvy, kvz, cap);
      }
    }
    cand.n = 0;
  }

  private bucket = new Int8Array(512);
  private pick = new Int32Array(4);

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
    f[o + MU] = mover >= 0 ? FRICTION / 2 : b ? FRICTION : GROUND_FRICTION;
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
    if (!dx && !dy && !dz && grid) {
      // The center sank into a voxel: out through its nearest open face, never deeper.
      const ix = Math.floor(x0), iy = Math.floor(y0), iz = Math.floor(z0);
      this.cubeExit(cx, cy, cz, ix, iy, iz);
      const n = this.hn;
      this.candidate(cx - n[0] * r, cy - n[1] * r, cz - n[2] * r, n[0], n[1], n[2], n[3] + r);
      return;
    }
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
    // Clear of the ground, trees and water's edge all around: nothing to test.
    const w = this.world, r = rt.shape.radius, p = rt.p;
    const x0 = Math.floor(p[0] - r), x1 = Math.floor(p[0] + r);
    const z0 = Math.floor(p[2] - r), z1 = Math.floor(p[2] + r);
    let top = -1;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (x < 0 || z < 0 || x >= w.sizeX || z >= w.sizeZ) continue;
        const k = z * w.sizeX + x;
        top = Math.max(top, w.top[k] + (w.propSolid[k] ? PROP_HEIGHT : 0));
      }
    }
    if (p[1] - r > top + 1.01) return;
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
      const pts = rt.pts;
      for (let i = 0; i < pts.length; i += 3) {
        this.capsule(mv, ya, yb, pts[i], pts[i + 1], pts[i + 2], 0);
      }
      const parts = rt.shape.parts;
      for (let j = 0; j < parts.length; j++) {
        if (!parts[j].r) continue;
        this.capsule(
          mv,
          ya,
          yb,
          rt.partC[j * 3],
          rt.partC[j * 3 + 1],
          rt.partC[j * 3 + 2],
          parts[j].r,
        );
      }
      this.flush(rt, null, m, mv.vx, mv.vy, mv.vz, mv.shove);
    }
  }

  /** A point (or sphere of radius r) inside a mover's capsule, its axis from ya to yb. */
  private capsule(
    mv: Mover,
    ya: number,
    yb: number,
    px: number,
    py: number,
    pz: number,
    r: number,
  ) {
    const cy = Math.min(yb, Math.max(ya, py));
    const ex = px - mv.x, ey = py - cy, ez = pz - mv.z;
    const d = Math.hypot(ex, ey, ez), reach = mv.radius + r;
    if (d >= reach) return;
    const nx = d > 1e-6 ? ex / d : 1, ny = d > 1e-6 ? ey / d : 0, nz = d > 1e-6 ? ez / d : 0;
    this.candidate(px - nx * r, py - ny * r, pz - nz * r, nx, ny, nz, reach - d);
  }

  /**
   * Two bodies: each one's points against the other's parts, spheres exactly, reduced together
   * so the moving body comes first and the pair gets a few contacts per direction.
   */
  private collidePair(a: Rt, b: Rt) {
    if (!a.dynamic) [a, b] = [b, a];
    this.beginPair();
    this.pointsInto(a, b);
    const mine = cand.n;
    this.pointsInto(b, a);
    // b's points pushed b out of a: the same contacts push a the other way.
    const f = cand.f;
    for (let i = mine; i < cand.n; i++) {
      const o = i * 7;
      f[o + 3] = -f[o + 3], f[o + 4] = -f[o + 4], f[o + 5] = -f[o + 5];
    }
    this.flush(a, b, -1);
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

  /** Velocities (v, ω) of the awake bodies, inverse masses and world inverse inertias, flat. */
  private sv = new Float64Array(0);
  private dirs = new Float64Array(9);
  private sm = new Float64Array(0);
  private si = new Float64Array(0);
  private ia = new Int32Array(0);
  private ib = new Int32Array(0);

  /**
   * Per contact and direction (normal, two tangents): the jacobian rows (rA × d, rB × d) and the
   * angular responses I⁻¹(r × d), so solving is a few dot products on flat arrays.
   */
  private prepare(h: number) {
    const c = this.contacts, f = c.f, awake = this.awake, n = awake.length;
    if (this.sm.length < n) {
      this.sv = new Float64Array(n * 6),
        this.sm = new Float64Array(n),
        this.si = new Float64Array(n * 9);
    }
    for (let i = 0; i < n; i++) {
      const rt = awake[i];
      rt.index = i;
      this.sv.set(rt.v, i * 6), this.sv.set(rt.w, i * 6 + 3);
      this.sm[i] = rt.invMass;
      this.si.set(rt.invIw, i * 9);
    }
    if (this.ia.length < c.n) this.ia = new Int32Array(c.cap), this.ib = new Int32Array(c.cap);
    for (let k = 0; k < c.n; k++) {
      const o = k * Contacts.F, a = c.a[k], b = c.b[k];
      this.ia[k] = a.index;
      this.ib[k] = b?.dynamic ? b.index : -1;
      const nx = f[o + NX], ny = f[o + NX + 1], nz = f[o + NX + 2];
      const rax = f[o + PX] - a.p[0], ray = f[o + PX + 1] - a.p[1], raz = f[o + PX + 2] - a.p[2];
      const rbx = b ? f[o + PX] - b.p[0] : 0, rby = b ? f[o + PX + 1] - b.p[1] : 0;
      const rbz = b ? f[o + PX + 2] - b.p[2] : 0;
      // Tangents.
      let t1x: number, t1y: number, t1z: number;
      if (Math.abs(nx) < 0.57) t1x = 0, t1y = nz, t1z = -ny;
      else t1x = -nz, t1y = 0, t1z = nx;
      const l = Math.hypot(t1x, t1y, t1z);
      t1x /= l, t1y /= l, t1z /= l;
      const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;
      const dirs = this.dirs;
      dirs[0] = nx, dirs[1] = ny, dirs[2] = nz, dirs[3] = t1x, dirs[4] = t1y, dirs[5] = t1z;
      dirs[6] = t2x, dirs[7] = t2y, dirs[8] = t2z;
      const bd = this.ib[k] >= 0;
      for (let d = 0; d < 3; d++) {
        const dx = dirs[d * 3], dy = dirs[d * 3 + 1], dz = dirs[d * 3 + 2], q = o + DIR + d * ROW;
        f[q] = dx, f[q + 1] = dy, f[q + 2] = dz;
        const ax = ray * dz - raz * dy, ay = raz * dx - rax * dz, az = rax * dy - ray * dx;
        const bx = rby * dz - rbz * dy, by = rbz * dx - rbx * dz, bz = rbx * dy - rby * dx;
        f[q + 3] = ax, f[q + 4] = ay, f[q + 5] = az;
        f[q + 9] = bx, f[q + 10] = by, f[q + 11] = bz;
        const A = a.invIw;
        const iax = A[0] * ax + A[1] * ay + A[2] * az, iay = A[3] * ax + A[4] * ay + A[5] * az;
        const iaz = A[6] * ax + A[7] * ay + A[8] * az;
        f[q + 6] = iax, f[q + 7] = iay, f[q + 8] = iaz;
        let k2 = a.invMass + ax * iax + ay * iay + az * iaz;
        if (bd) {
          const B = b!.invIw;
          const ibx = B[0] * bx + B[1] * by + B[2] * bz, iby = B[3] * bx + B[4] * by + B[5] * bz;
          const ibz = B[6] * bx + B[7] * by + B[8] * bz;
          f[q + 12] = ibx, f[q + 13] = iby, f[q + 14] = ibz;
          k2 += b!.invMass + bx * ibx + by * iby + bz * ibz;
        } else f[q + 12] = f[q + 13] = f[q + 14] = 0;
        f[q + 15] = k2 > 0 ? 1 / k2 : 0;
        f[q + 16] = 0; // accumulated impulse
      }
      const vn = this.rel(this.sv, k, o + DIR);
      // How fast the body itself comes at it (a villager walking into a crate isn't hit by it).
      f[o + APPROACH] = -(vn + f[o + KV] * nx + f[o + KV + 1] * ny + f[o + KV + 2] * nz);
      // Push apart what overlaps, and bounce a little off hard impacts.
      let bias = Math.min(MAX_CORRECTION, (BAUMGARTE / h) * Math.max(0, f[o + DEPTH] - SLOP));
      if (vn < -BOUNCE_SPEED) bias = Math.max(bias, -RESTITUTION * vn);
      f[o + BIAS] = bias;
      // A mover shoves with limited strength per step.
      if (c.mover[k] >= 0) f[o + CAP] = this.movers[c.mover[k]].shove * h;
      // Fast enough into something resting: wake it, and note the impact for landings.
      if (b && !b.dynamic && b.o.asleep && (-vn > WAKE_SPEED || this.speed(a) > WAKE_SPEED)) {
        this.wake(b.o);
      }
      if (c.mover[k] < 0) a.impact = Math.max(a.impact, -vn);
    }
    this.prepareJoints(h);
  }

  // ---------------------------------------------------------------- joints

  private prepareJoints(h: number) {
    this.rows.n = 0;
    for (const root of this.jointed) {
      const o = root.o, asm = this.assembly(o.design)!, group = root.group;
      for (let i = 0; i < asm.joints.length; i++) {
        const j = asm.joints[i], A = group[j.a], B = group[j.b];
        if (!A || !B || (!A.dynamic && !B.dynamic)) continue;
        this.joint(A, B, j, o.joints![i], h);
      }
    }
  }

  /** The rows that hold one joint together and drive it this step. */
  private joint(A: Rt, B: Rt, j: JointDef, st: JointState, h: number) {
    const RA = A.R, RB = B.R, ca = A.shape.com, cb = B.shape.com, an = j.anchor, g = this.jg;
    // Lever arms from each center of mass to the pin, as each piece has it.
    const ax = an[0] - ca[0], ay = an[1] - ca[1], az = an[2] - ca[2];
    const rax = g[0] = RA[0] * ax + RA[1] * ay + RA[2] * az;
    const ray = g[1] = RA[3] * ax + RA[4] * ay + RA[5] * az;
    const raz = g[2] = RA[6] * ax + RA[7] * ay + RA[8] * az;
    const bx = an[0] - cb[0], by = an[1] - cb[1], bz = an[2] - cb[2];
    const rbx = g[3] = RB[0] * bx + RB[1] * by + RB[2] * bz;
    const rby = g[4] = RB[3] * bx + RB[4] * by + RB[5] * bz;
    const rbz = g[5] = RB[6] * bx + RB[7] * by + RB[8] * bz;
    // How far the pin has pulled apart (a's minus b's).
    const ex = g[6] = A.p[0] + rax - B.p[0] - rbx;
    const ey = g[7] = A.p[1] + ray - B.p[1] - rby;
    const ez = g[8] = A.p[2] + raz - B.p[2] - rbz;
    // The axis as a has it.
    const d = j.axis;
    const ux = g[9] = RA[0] * d[0] + RA[1] * d[1] + RA[2] * d[2];
    const uy = g[10] = RA[3] * d[0] + RA[4] * d[1] + RA[5] * d[2];
    const uz = g[11] = RA[6] * d[0] + RA[7] * d[1] + RA[8] * d[2];
    // b's turn relative to a: qb · qa⁻¹ (both are as built at first).
    const qa = A.q, qb = B.q;
    const pw = qb[3], px = qb[0], py = qb[1], pz = qb[2];
    const sx = -qa[0], sy = -qa[1], sz = -qa[2], sw = qa[3];
    let qx = pw * sx + px * sw + py * sz - pz * sy;
    let qy = pw * sy - px * sz + py * sw + pz * sx;
    let qz = pw * sz + px * sy - py * sx + pz * sw;
    let qw = pw * sw - px * sx - py * sy - pz * sz;
    if (qw < 0) qx = -qx, qy = -qy, qz = -qz, qw = -qw;
    // Two directions across the axis.
    let t1x: number, t1y: number, t1z: number;
    if (Math.abs(ux) < 0.57) t1x = 0, t1y = uz, t1z = -uy;
    else t1x = -uz, t1y = 0, t1z = ux;
    const l = Math.hypot(t1x, t1y, t1z);
    t1x /= l, t1y /= l, t1z /= l;
    const t2x = uy * t1z - uz * t1y, t2y = uz * t1x - ux * t1z, t2z = ux * t1y - uy * t1x;
    const k = JOINT_BAUMGARTE / h, inf = Infinity, slide = j.kind === "slider";
    let at: number;
    if (slide) {
      this.pointRow(A, B, k, t1x, t1y, t1z), this.pointRow(A, B, k, t2x, t2y, t2z);
      // No turning at all: b's turn relative to a goes back to none.
      this.turnRow(A, B, 1, 0, 0, -fix(k, 2 * qx), -inf, inf);
      this.turnRow(A, B, 0, 1, 0, -fix(k, 2 * qy), -inf, inf);
      this.turnRow(A, B, 0, 0, 1, -fix(k, 2 * qz), -inf, inf);
      at = -(ux * ex + uy * ey + uz * ez);
    } else {
      this.pointRow(A, B, k, 1, 0, 0), this.pointRow(A, B, k, 0, 1, 0);
      this.pointRow(A, B, k, 0, 0, 1);
      // Keep b's axis on a's: b turns toward a about b × a.
      const ubx = RB[0] * d[0] + RB[1] * d[1] + RB[2] * d[2];
      const uby = RB[3] * d[0] + RB[4] * d[1] + RB[5] * d[2];
      const ubz = RB[6] * d[0] + RB[7] * d[1] + RB[8] * d[2];
      const cx = uby * uz - ubz * uy, cy = ubz * ux - ubx * uz, cz = ubx * uy - uby * ux;
      this.turnRow(A, B, t1x, t1y, t1z, fix(k, t1x * cx + t1y * cy + t1z * cz), -inf, inf);
      this.turnRow(A, B, t2x, t2y, t2z, fix(k, t2x * cx + t2y * cy + t2z * cz), -inf, inf);
      at = 2 * Math.atan2(qx * ux + qy * uy + qz * uz, qw);
      if (at > Math.PI) at -= 2 * Math.PI;
    }
    st.at = at;
    const lim = j.limits;
    if (lim) {
      // Stops: past one, push back; near one, come no closer than reaching it this step.
      if (at < lim[0] + LIMIT_MARGIN) this.alongRow(A, B, slide, 1, stop(at - lim[0], h), 0, inf);
      if (at > lim[1] - LIMIT_MARGIN) this.alongRow(A, B, slide, -1, stop(lim[1] - at, h), 0, inf);
      const to = Math.max(lim[0], Math.min(lim[1], st.target ?? 0));
      const v = Math.max(-SERVO_SPEED, Math.min(SERVO_SPEED, SERVO_GAIN * (to - at)));
      this.alongRow(A, B, slide, 1, v, -SERVO_TORQUE * h, SERVO_TORQUE * h);
    } else if (j.kind === "motor" && st.on) {
      this.alongRow(A, B, false, 1, j.speed, -MOTOR_TORQUE * h, MOTOR_TORQUE * h);
    } else if (!slide) this.alongRow(A, B, false, 1, 0, -JOINT_FRICTION * h, JOINT_FRICTION * h);
  }

  /** The joint being prepared: lever arms, how far its pin pulled apart, and its axis. */
  private jg = new Float64Array(12);

  /** Keep the pin together along (dx, dy, dz). */
  private pointRow(A: Rt, B: Rt, k: number, dx: number, dy: number, dz: number) {
    const g = this.jg, rax = g[0], ray = g[1], raz = g[2], rbx = g[3], rby = g[4], rbz = g[5];
    this.row(
      A,
      B,
      dx,
      dy,
      dz,
      ray * dz - raz * dy,
      raz * dx - rax * dz,
      rax * dy - ray * dx,
      -(rby * dz - rbz * dy),
      -(rbz * dx - rbx * dz),
      -(rbx * dy - rby * dx),
      fix(k, g[6] * dx + g[7] * dy + g[8] * dz),
      -Infinity,
      Infinity,
    );
  }

  /** Relative spin (a's less b's) along (dx, dy, dz), driven to `bias`. */
  private turnRow(
    A: Rt,
    B: Rt,
    dx: number,
    dy: number,
    dz: number,
    bias: number,
    lo: number,
    hi: number,
  ) {
    this.row(A, B, 0, 0, 0, dx, dy, dz, -dx, -dy, -dz, bias, lo, hi);
  }

  /** Along the axis: how fast it moves the way its angle (or slide) grows, times `sign`. */
  private alongRow(
    A: Rt,
    B: Rt,
    slide: boolean,
    sign: number,
    bias: number,
    lo: number,
    hi: number,
  ) {
    const g = this.jg, ux = g[9] * sign, uy = g[10] * sign, uz = g[11] * sign;
    if (!slide) return this.row(A, B, 0, 0, 0, -ux, -uy, -uz, ux, uy, uz, bias, lo, hi);
    const rax = g[0], ray = g[1], raz = g[2], rbx = g[3], rby = g[4], rbz = g[5];
    this.row(
      A,
      B,
      -ux,
      -uy,
      -uz,
      -(ray * uz - raz * uy),
      -(raz * ux - rax * uz),
      -(rax * uy - ray * ux),
      rby * uz - rbz * uy,
      rbz * ux - rbx * uz,
      rbx * uy - rby * ux,
      bias,
      lo,
      hi,
    );
  }

  /** One joint row between a and b: Jacobian, target velocity and impulse bounds. */
  private row(
    A: Rt,
    B: Rt,
    lx: number,
    ly: number,
    lz: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    bias: number,
    lo: number,
    hi: number,
  ) {
    const r = this.rows;
    r.ensure(r.n + 1);
    const k = r.n++, o = k * Rows.F, f = r.f;
    r.ia[k] = A.dynamic ? A.index : -1;
    r.ib[k] = B.dynamic ? B.index : -1;
    f[o + JL] = lx, f[o + JL + 1] = ly, f[o + JL + 2] = lz;
    f[o + JA] = ax, f[o + JA + 1] = ay, f[o + JA + 2] = az;
    f[o + JB] = bx, f[o + JB + 1] = by, f[o + JB + 2] = bz;
    let m = (lx * lx + ly * ly + lz * lz) *
      ((A.dynamic ? A.invMass : 0) + (B.dynamic ? B.invMass : 0));
    if (A.dynamic) {
      const I = A.invIw;
      const ix = I[0] * ax + I[1] * ay + I[2] * az, iy = I[3] * ax + I[4] * ay + I[5] * az;
      const iz = I[6] * ax + I[7] * ay + I[8] * az;
      f[o + MA] = ix, f[o + MA + 1] = iy, f[o + MA + 2] = iz;
      m += ax * ix + ay * iy + az * iz;
    } else f[o + MA] = f[o + MA + 1] = f[o + MA + 2] = 0;
    if (B.dynamic) {
      const I = B.invIw;
      const ix = I[0] * bx + I[1] * by + I[2] * bz, iy = I[3] * bx + I[4] * by + I[5] * bz;
      const iz = I[6] * bx + I[7] * by + I[8] * bz;
      f[o + MB] = ix, f[o + MB + 1] = iy, f[o + MB + 2] = iz;
      m += bx * ix + by * iy + bz * iz;
    } else f[o + MB] = f[o + MB + 1] = f[o + MB + 2] = 0;
    f[o + JM] = m > 1e-12 ? 1 / m : 0;
    f[o + JBIAS] = bias, f[o + JLO] = lo, f[o + JHI] = hi, f[o + JACC] = 0;
  }

  private solveJoints() {
    const r = this.rows, f = r.f, v = this.sv, sm = this.sm;
    for (let k = 0; k < r.n; k++) {
      const o = k * Rows.F, a = r.ia[k], b = r.ib[k];
      let vel = 0;
      if (a >= 0) {
        const q = a * 6;
        vel += f[o + JL] * v[q] + f[o + JL + 1] * v[q + 1] + f[o + JL + 2] * v[q + 2] +
          f[o + JA] * v[q + 3] + f[o + JA + 1] * v[q + 4] + f[o + JA + 2] * v[q + 5];
      }
      if (b >= 0) {
        const q = b * 6;
        vel += -(f[o + JL] * v[q] + f[o + JL + 1] * v[q + 1] + f[o + JL + 2] * v[q + 2]) +
          f[o + JB] * v[q + 3] + f[o + JB + 1] * v[q + 4] + f[o + JB + 2] * v[q + 5];
      }
      const old = f[o + JACC];
      const now = Math.min(
        f[o + JHI],
        Math.max(f[o + JLO], old + f[o + JM] * (f[o + JBIAS] - vel)),
      );
      f[o + JACC] = now;
      const dj = now - old;
      if (!dj) continue;
      if (a >= 0) {
        const q = a * 6, m = sm[a] * dj;
        v[q] += f[o + JL] * m, v[q + 1] += f[o + JL + 1] * m, v[q + 2] += f[o + JL + 2] * m;
        v[q + 3] += f[o + MA] * dj, v[q + 4] += f[o + MA + 1] * dj, v[q + 5] += f[o + MA + 2] * dj;
      }
      if (b >= 0) {
        const q = b * 6, m = sm[b] * dj;
        v[q] -= f[o + JL] * m, v[q + 1] -= f[o + JL + 1] * m, v[q + 2] -= f[o + JL + 2] * m;
        v[q + 3] += f[o + MB] * dj, v[q + 4] += f[o + MB + 1] * dj, v[q + 5] += f[o + MB + 2] * dj;
      }
    }
  }

  private speed(rt: Rt): number {
    return Math.hypot(rt.v[0], rt.v[1], rt.v[2]);
  }

  /** Relative velocity along row `q` of contact `k` (a over b, less a mover's own motion). */
  private rel(v: Float64Array, k: number, q: number): number {
    const f = this.contacts.f, a = this.ia[k] * 6, b = this.ib[k];
    let r = f[q] * v[a] + f[q + 1] * v[a + 1] + f[q + 2] * v[a + 2] +
      f[q + 3] * v[a + 3] + f[q + 4] * v[a + 4] + f[q + 5] * v[a + 5];
    if (b >= 0) {
      const o = b * 6;
      r -= f[q] * v[o] + f[q + 1] * v[o + 1] + f[q + 2] * v[o + 2] +
        f[q + 9] * v[o + 3] + f[q + 10] * v[o + 4] + f[q + 11] * v[o + 5];
    }
    const o = k * Contacts.F + KV;
    return r - (f[q] * f[o] + f[q + 1] * f[o + 1] + f[q + 2] * f[o + 2]);
  }

  /** Apply impulse `j` along row `q` of contact `k`. */
  private push(v: Float64Array, k: number, q: number, j: number) {
    const f = this.contacts.f, a = this.ia[k], b = this.ib[k];
    let m = this.sm[a] * j, o = a * 6;
    v[o] += f[q] * m, v[o + 1] += f[q + 1] * m, v[o + 2] += f[q + 2] * m;
    v[o + 3] += f[q + 6] * j, v[o + 4] += f[q + 7] * j, v[o + 5] += f[q + 8] * j;
    if (b < 0) return;
    m = this.sm[b] * j, o = b * 6;
    v[o] -= f[q] * m, v[o + 1] -= f[q + 1] * m, v[o + 2] -= f[q + 2] * m;
    v[o + 3] -= f[q + 12] * j, v[o + 4] -= f[q + 13] * j, v[o + 5] -= f[q + 14] * j;
  }

  private solve() {
    if (this.rows.n) this.solveJoints();
    const c = this.contacts, f = c.f, v = this.sv;
    for (let k = 0; k < c.n; k++) {
      const o = k * Contacts.F, qn = o + DIR;
      const vn = this.rel(v, k, qn);
      const old = f[qn + 16];
      const total = Math.min(f[o + CAP], Math.max(0, old + f[qn + 15] * (f[o + BIAS] - vn)));
      f[qn + 16] = total;
      if (total !== old) this.push(v, k, qn, total - old);
      const limit = f[o + MU] * total;
      for (let d = 1; d < 3; d++) {
        const q = qn + d * ROW;
        const was = f[q + 16];
        const now = Math.max(-limit, Math.min(limit, was - f[q + 15] * this.rel(v, k, q)));
        f[q + 16] = now;
        if (now !== was) this.push(v, k, q, now - was);
      }
    }
  }

  /** Velocities back from the solver to the bodies. */
  private unload() {
    const v = this.sv;
    for (const rt of this.awake) {
      const o = rt.index * 6;
      rt.v[0] = v[o], rt.v[1] = v[o + 1], rt.v[2] = v[o + 2];
      rt.w[0] = v[o + 3], rt.w[1] = v[o + 4], rt.w[2] = v[o + 5];
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
      if (momentum <= this.moverHit[m]) continue;
      this.moverHit[m] = momentum;
      const nx = -f[o + NX], nz = -f[o + NX + 2], l = Math.hypot(nx, nz) || 1;
      let hit = this.hits.find((h) => h.mover === m);
      if (!hit) this.hits.push(hit = { body: a.o, mover: m, speed, momentum, nx: 0, nz: 0 });
      hit.body = a.o, hit.speed = speed, hit.momentum = momentum, hit.nx = nx / l, hit.nz = nz / l;
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

  /** A body's pose back into the state the world saves. */
  private writeBack(rt: Rt) {
    const st = rt.s, v = rt.v, w = rt.w, R = rt.R, c = rt.shape.com;
    for (let k = 0; k < 3; k++) {
      st.pos[k] = rt.p[k] - (R[k * 3] * c[0] + R[k * 3 + 1] * c[1] + R[k * 3 + 2] * c[2]);
      st.vel[k] = v[k], st.spin[k] = w[k];
    }
    for (let i = 0; i < 4; i++) st.rot[i] = rt.q[i];
  }

  /** After a tick: note landings, and let an Object sleep once all its pieces are still. */
  private settle(group: Rt[], dt: number) {
    const o = group[0].o;
    this.moved.push(o);
    let impact = 0, still = true;
    for (const rt of group) {
      if (!rt.dynamic) continue;
      impact = Math.max(impact, rt.impact);
      const v = rt.v, w = rt.w;
      if (
        Math.hypot(v[0], v[1], v[2]) >= SLEEP_SPEED || Math.hypot(w[0], w[1], w[2]) >= SLEEP_SPIN
      ) {
        still = false;
      }
    }
    // A running motor keeps it awake.
    for (const j of o.joints ?? NO_JOINTS) if (j.on) still = false;
    const air = o.air ?? 0;
    if (impact > LAND_SPEED && air > 2) this.landings.push({ body: o, speed: impact });
    o.air = impact > 0 ? 0 : air + 1;
    o.still = still ? (o.still ?? 0) + 1 : 0;
    if (o.still >= SLEEP_TICKS * Math.max(1, Math.round(0.05 / dt))) {
      o.asleep = true;
      for (const rt of group) {
        if (!rt.dynamic) continue;
        rt.s.vel.fill(0), rt.s.spin.fill(0);
        rt.v.fill(0), rt.w.fill(0);
      }
      delete o.mover, delete o.quiet, delete o.still, delete o.air;
    }
  }
}
