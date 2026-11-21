import { identity, mat4, rotateX, rotateY, rotateZ, scale, translate } from "../math.ts";
import type { Catalog, DesignContent, DesignPart, Role, Vec3 } from "../sim/catalog.ts";
import type { FloatseeAppearance, HeadShape } from "../sim/floatsee.ts";
import { Anim, DOWN_TICKS } from "../sim/sim.ts";
import type { AgentView } from "../simclient.ts";
import { DECAL_CYL, DECAL_FLAT, DECAL_SPHERE, type FloatseeDecals } from "./decals.ts";
import { ANCHOR, jointOf, materialRgb, meshDesign } from "./designs.ts";
import type { InstanceBatch, MeshBuilder, MeshLibrary, Rgb } from "./meshes.ts";

const WOOD: Rgb = [0.3, 0.16, 0.06];
const FRAME_WOOD: Rgb = [0.38, 0.21, 0.09];
const FRAME_GOLD: Rgb = [0.68, 0.48, 0.19];
const IRON: Rgb = [0.35, 0.36, 0.38];
const WHITE: Rgb = [1, 1, 1];

const root = mat4(), part = mat4(), torso = mat4(), limb = mat4(), head = mat4(), place = mat4();
const decalMat = mat4();

/** A villager look ready to pose: a template and a pivot (relative to the feet) per role. */
interface Rig {
  pieces: Partial<Record<Role, { id: number; at: Vec3 }>>;
  /** True for customizable Floatsee rigs (floating head hover + decals). */
  floatsee?: boolean;
}

/** Where the glowing facial expression decal sits in local head space per Floatsee head shape. */
interface FacePlacement {
  shape: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
}

const FACE_PLACEMENT: Record<HeadShape, FacePlacement> = {
  sphere: { shape: DECAL_SPHERE, x: 0, y: 0.31, z: 0.322, w: 0.72, h: 0.72 },
  cube: { shape: DECAL_FLAT, x: 0, y: 0.28, z: 0.278, w: 0.43, h: 0.39 },
  star: { shape: DECAL_FLAT, x: 0, y: 0.31, z: 0.188, w: 0.34, h: 0.32 },
  teacup: { shape: DECAL_CYL, x: 0, y: 0.27, z: 0.276, w: 0.66, h: 0.38 },
  cloud: { shape: DECAL_SPHERE, x: 0, y: 0.29, z: 0.288, w: 0.7, h: 0.64 },
  horned: { shape: DECAL_FLAT, x: 0, y: 0.26, z: 0.258, w: 0.41, h: 0.37 },
};

const POSED: Role[] = ["left leg", "right leg", "body", "left arm", "right arm", "head", "eyes"];

const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Sculpt one of the 6 Floatsee floating head shapes (origin at bottom of the head). */
function buildFloatseeHead(
  b: MeshBuilder,
  shape: HeadShape,
  primary: Rgb,
  accent: Rgb,
  glow: Rgb,
) {
  const m = mat4();
  const at = (x: number, y: number, z: number) => translate(identity(m), x, y, z);
  // Subtle ceramic glaze finish with faint painterly clay grain and gentle twilight luminescence.
  const headStyle = {
    color: primary,
    rough: 0.3,
    grain: 0.08,
    grainScale: [7, 7, 7] as const,
    ao: 0.18,
    glow: 0.08,
  };
  const hornStyle = {
    color: mixRgb(primary, accent, 0.35),
    rough: 0.28,
    grain: 0.06,
    grainScale: [8, 8, 8] as const,
    ao: 0.2,
  };
  const innerStyle = {
    color: mixRgb(primary, [0.06, 0.08, 0.1], 0.42),
    rough: 0.45,
    ao: 0.3,
  };
  const softGlow = mixRgb(primary, glow, 0.22);

  switch (shape) {
    case "sphere":
      b.sphere(at(0, 0.31, 0), [0.31, 0.31, 0.31], {
        ...headStyle,
        color: softGlow,
        glow: 0.14,
      }, { detail: 3 });
      break;

    case "cube":
      b.box(at(0, 0.28, 0), [0.56, 0.54, 0.54], headStyle, 0.14);
      break;

    case "star":
      b.star(at(0, 0.32, 0), 0.42, 0.23, 0.18, {
        ...headStyle,
        color: softGlow,
        glow: 0.11,
      }, 5);
      break;

    case "teacup": {
      // Lathed hollow ceramic mug with rounded base, rolled lip, and concave interior.
      b.lathe(
        null,
        [
          [0.001, 0.01],
          [0.16, 0.015],
          [0.22, 0.05],
          [0.255, 0.13],
          [0.268, 0.28],
          [0.272, 0.46],
          [0.265, 0.51],
          [0.242, 0.525],
          [0.218, 0.505],
          [0.212, 0.36],
          [0.185, 0.18],
          [0.001, 0.15],
        ],
        headStyle,
        24,
      );
      // Darker inner glaze disc to emphasize the hollow teacup cavity.
      b.cylinder(at(0, 0.155, 0), 0.18, 0.18, 0.015, innerStyle, { segments: 18 });
      // Curved C-shaped ceramic mug handle on the right (+x) side.
      b.tube(
        null,
        [
          [0.245, 0.41, 0, 0.042],
          [0.34, 0.42, 0, 0.046],
          [0.395, 0.35, 0, 0.048],
          [0.395, 0.25, 0, 0.048],
          [0.34, 0.18, 0, 0.045],
          [0.235, 0.19, 0, 0.04],
        ],
        headStyle,
        10,
      );
      break;
    }

    case "cloud": {
      // Plush overlapping cluster of smooth billows matching mockups 03 & 04.
      const puffs: [number, number, number, number][] = [
        [0, 0.29, 0.03, 0.25],
        [-0.22, 0.21, 0.0, 0.175],
        [0.22, 0.21, 0.0, 0.175],
        [-0.14, 0.39, -0.02, 0.17],
        [0.14, 0.39, -0.02, 0.17],
        [0, 0.45, -0.01, 0.185],
        [0, 0.26, -0.1, 0.21],
      ];
      for (const [x, y, z, r] of puffs) {
        b.sphere(at(x, y, z), [r, r * 0.96, r * 0.98], headStyle, { detail: 2 });
      }
      break;
    }

    case "horned": {
      b.box(at(0, 0.26, 0), [0.52, 0.5, 0.5], headStyle, 0.12);
      // Two sleek curved horns sweeping out and upward from the top corners.
      for (const side of [-1, 1]) {
        b.tube(
          null,
          [
            [side * 0.17, 0.46, -0.02, 0.088],
            [side * 0.29, 0.51, -0.01, 0.075],
            [side * 0.36, 0.6, 0.0, 0.06],
            [side * 0.37, 0.71, 0.01, 0.042],
            [side * 0.32, 0.8, 0.02, 0.022],
            [side * 0.27, 0.84, 0.02, 0.008],
          ],
          hornStyle,
          10,
        );
      }
      break;
    }
  }
}

/** Sculpt a miniature carved wooden picture frame on the front or back of the bell cloak. */
function buildPictureFrame(
  b: MeshBuilder,
  z: number,
  tiltX: number,
  w: number,
  h: number,
  accent: Rgb,
  facing: 1 | -1,
) {
  const m = mat4();
  const base = () => rotateX(translate(identity(m), 0, 0.36, z), tiltX);
  const border = 0.032;
  const depth = 0.036;
  const wood = { color: FRAME_WOOD, rough: 0.72, grain: 0.14, grainScale: [12, 6, 12] as const };
  const trim = { color: mixRgb(FRAME_GOLD, accent, 0.2), rough: 0.45 };
  const back = { color: [0.22, 0.15, 0.1] as Rgb, rough: 0.85 };

  // Backing plate + 4 rounded carved wooden frame bars + subtle top ornament.
  b.box(base(), [w, h, depth * 0.5], back, 0.006);
  b.box(
    translate(base(), 0, h / 2 - border / 2, facing * 0.01),
    [w + 0.01, border, depth],
    wood,
    0.008,
  );
  b.box(
    translate(base(), 0, -h / 2 + border / 2, facing * 0.01),
    [w + 0.01, border, depth],
    wood,
    0.008,
  );
  b.box(
    translate(base(), -w / 2 + border / 2, 0, facing * 0.01),
    [border, h, depth],
    wood,
    0.008,
  );
  b.box(
    translate(base(), w / 2 - border / 2, 0, facing * 0.01),
    [border, h, depth],
    wood,
    0.008,
  );
  // Subtle golden top clasp detail (mockup 04).
  b.box(
    translate(base(), 0, h / 2 + 0.005, facing * 0.014),
    [w * 0.28, 0.028, depth * 0.9],
    trim,
    0.008,
  );
}

/**
 * Villager bodies: customizable Floatsees by default (6 sculpted floating heads, hollow-collar
 * bell cloak, carved front/back graphic tee frames, glowing expressions), or any Catalog Design
 * chosen via `set_body`.
 */
export class BodyModels {
  readonly cube: number;
  readonly hoe: number;
  readonly rod: number;
  readonly hammer: number;
  private rigs = new Map<string, Rig | null>();
  private catalog: Catalog | null = null;

  constructor(private lib: MeshLibrary) {
    const at = (x: number, y: number, z: number) => translate(identity(place), x, y, z);
    this.cube = lib.define("cube", (b) => b.box(null, [1, 1, 1], { color: WHITE }));
    this.hoe = lib.define("tool.hoe", (b) => {
      b.cylinder(rotateX(at(0, -0.34, -0.05), Math.PI / 2), 0.03, 0.03, 0.78, { color: WOOD }, {
        segments: 12,
      });
      b.box(at(0, -0.44, 0.71), [0.2, 0.22, 0.04], { color: IRON }, 0.01);
    });
    this.rod = lib.define("tool.rod", (b) => {
      // Held in the right hand: the rod points forward and up, the line hangs straight down.
      b.cylinder(
        rotateX(at(0, -0.32, 0), 2.214),
        0.022,
        0.01,
        1.6,
        { color: WOOD, sway: [0, 0.3] },
        { segments: 10 },
      );
      b.cylinder(rotateX(at(0, -1.28, 1.28), -1.845), 0.004, 0.004, 1.3, {
        color: [0.8, 0.8, 0.75],
      });
      b.sphere(translate(rotateX(at(0, -1.28, 1.28), -1.845), 0, 1.3, 0), [0.045, 0.045, 0.045], {
        color: [0.85, 0.12, 0.08],
      }, { detail: 1 });
    });
    this.hammer = lib.define("tool.hammer", (b) => {
      b.cylinder(rotateX(at(0, -0.34, -0.05), Math.PI / 2), 0.03, 0.03, 0.78, { color: WOOD }, {
        segments: 12,
      });
      b.box(at(0, -0.34, 0.69), [0.16, 0.16, 0.12], { color: IRON }, 0.02);
    });
  }

  /**
   * The rig for a villager: a Catalog Design they chose via `set_body`, or their sculpted
   * customizable Floatsee rig by default. Built and cached on first use.
   */
  villager(catalog: Catalog, body: number | null, look: FloatseeAppearance): Rig | null {
    if (catalog !== this.catalog) this.catalog = catalog, this.rigs.clear();
    const chosen = body === null ? undefined : catalog.get(body);
    const design = chosen && catalog.current(chosen);
    const own = design?.kind === "design" &&
      (design.content as DesignContent).parts.some((p) => p.role === "body");
    if (own && design) {
      const key = `design:${design.id}`;
      if (this.rigs.has(key)) return this.rigs.get(key)!;
      const d = design.content as DesignContent;
      const rig: Rig = { pieces: {} };
      for (const role of POSED) {
        const only = role === "body"
          ? (p: DesignPart) => !p.role || !POSED.includes(p.role) || p.role === "body"
          : (p: DesignPart) => p.role === role;
        if (!d.parts.some(only)) continue;
        const at = jointOf(d, role);
        const id = this.lib.define(
          `villager:${key}:${role}`,
          (b) => meshDesign(b, catalog, d, { only, origin: at, sway: false }),
        );
        rig.pieces[role] = { id, at: [at[0] - ANCHOR[0], at[1] - ANCHOR[1], at[2] - ANCHOR[2]] };
      }
      this.rigs.set(key, rig);
      return rig;
    }

    // Customizable Floatsee rig!
    const hasFront = look.frontTee !== "none";
    const hasBack = look.backTee !== "none";
    const key = `floatsee:${look.head}:${look.colors.primary}:${look.colors.accent}:` +
      `${look.colors.glow}:${hasFront ? 1 : 0}:${hasBack ? 1 : 0}`;
    if (this.rigs.has(key)) return this.rigs.get(key)!;

    const primary = materialRgb(look.colors.primary);
    const accent = materialRgb(look.colors.accent);
    const glow = materialRgb(look.colors.glow);
    const footColor = mixRgb(primary, accent, 0.55);

    const cloakStyle = {
      color: primary,
      rough: 0.46,
      grain: 0.08,
      grainScale: [6, 6, 6] as const,
      ao: 0.24,
    };
    const trimStyle = {
      color: accent,
      rough: 0.42,
      grain: 0.06,
      grainScale: [8, 8, 8] as const,
      ao: 0.18,
    };
    const footStyle = { color: footColor, rough: 0.45, ao: 0.2 };
    const m = mat4();

    // Stubby rounded feet tucked under the bell cloak hem (pivoted at y=0.22).
    const legMesh = (b: MeshBuilder) => {
      b.sphere(translate(identity(m), 0, -0.14, 0.01), [0.085, 0.09, 0.11], footStyle, {
        detail: 2,
      });
      b.cylinder(translate(identity(m), 0, -0.14, 0), 0.075, 0.08, 0.14, footStyle, {
        segments: 12,
      });
    };
    const leftLegId = this.lib.define(`${key}:lleg`, legMesh);
    const rightLegId = this.lib.define(`${key}:rleg`, legMesh);

    // Bell-shaped ceramic/cloth cloak torso with rolled hollow collar & framed graphic tees.
    const bodyId = this.lib.define(`${key}:body`, (b) => {
      // Main outer bell cloak profile (pivoted at y=0.22 in world space -> local y=0 at hem base).
      b.lathe(
        null,
        [
          [0.001, -0.04],
          [0.26, -0.04],
          [0.345, -0.01],
          [0.365, 0.04],
          [0.348, 0.16],
          [0.312, 0.34],
          [0.272, 0.54],
          [0.242, 0.68],
          [0.236, 0.74],
          [0.212, 0.765],
          [0.18, 0.752],
        ],
        cloakStyle,
        24,
      );
      // Deeply shaded hollow collar pocket so the floating neck opening reads clearly (mockup 04).
      b.lathe(
        null,
        [
          [0.18, 0.752],
          [0.166, 0.65],
          [0.145, 0.55],
          [0.001, 0.54],
        ],
        { color: mixRgb(primary, [0.025, 0.03, 0.05], 0.76), rough: 0.82, ao: 0.45 },
        24,
      );
      // Decorative accent hem trim band circling the lower skirt (mockup 04).
      b.lathe(
        null,
        [
          [0.354, 0.03],
          [0.374, 0.055],
          [0.368, 0.12],
          [0.346, 0.145],
        ],
        trimStyle,
        24,
      );
      // Subtle collar rim highlight ring.
      b.lathe(
        null,
        [
          [0.238, 0.715],
          [0.246, 0.742],
          [0.226, 0.768],
          [0.205, 0.765],
        ],
        trimStyle,
        24,
      );
      // Sculpted wooden picture frames on chest (+z) and back (-z).
      if (hasFront) buildPictureFrame(b, 0.314, -0.17, 0.285, 0.305, accent, 1);
      if (hasBack) buildPictureFrame(b, -0.316, 0.17, 0.34, 0.37, accent, -1);
    });

    // Cute flared stubby bell sleeves with accent cuffs and rounded hand nubs.
    const armMesh = (side: number) => (b: MeshBuilder) => {
      const a = rotateZ(identity(mat4()), side * 0.28);
      const copy = () => {
        const t = mat4();
        t.set(a);
        return t;
      };
      b.cylinder(translate(copy(), 0, -0.3, 0), 0.105, 0.072, 0.32, cloakStyle, {
        segments: 14,
      });
      b.cylinder(translate(copy(), 0, -0.31, 0), 0.112, 0.106, 0.06, trimStyle, {
        segments: 14,
      });
      b.sphere(translate(copy(), 0, -0.32, 0), [0.076, 0.076, 0.076], {
        color: mixRgb(primary, [1, 1, 1], 0.18),
        rough: 0.38,
      }, { detail: 2 });
    };
    const leftArmId = this.lib.define(`${key}:larm`, armMesh(-1));
    const rightArmId = this.lib.define(`${key}:rarm`, armMesh(1));

    // Sculpted floating head (one of 6 shapes!).
    const headId = this.lib.define(
      `${key}:head`,
      (b) => buildFloatseeHead(b, look.head, primary, accent, glow),
    );

    const rig: Rig = {
      floatsee: true,
      pieces: {
        "left leg": { id: leftLegId, at: [-0.14, 0.22, 0] },
        "right leg": { id: rightLegId, at: [0.14, 0.22, 0] },
        body: { id: bodyId, at: [0, 0.22, 0] },
        "left arm": { id: leftArmId, at: [-0.25, 0.8, 0] },
        "right arm": { id: rightArmId, at: [0.25, 0.8, 0] },
        head: { id: headId, at: [0, 1.16, 0] },
      },
    };
    this.rigs.set(key, rig);
    return rig;
  }
}

/**
 * Villager bodies: customizable Floatsees (or custom Catalog Designs) posed from sim state
 * (walking stride, floating head hover, tools) plus glowing expressions & graphic tee decals.
 */
export function buildBodies(
  agents: AgentView[],
  time: number,
  out: InstanceBatch,
  ids: BodyModels,
  catalog: Catalog,
  decals?: FloatseeDecals,
) {
  const add = (id: number, m: Float32Array, c: Rgb = WHITE) => out.add(id, m, c[0], c[1], c[2]);

  for (const a of agents) {
    const rig = ids.villager(catalog, a.body, a.floatsee);
    if (!rig) continue;
    const pieces = rig.pieces;
    /** Move `m` from `from`'s pivot to `to`'s. */
    const joint = (m: Float32Array, to: Role, from?: Role) => {
      const t = pieces[to]!.at, f = from ? pieces[from]!.at : [0, 0, 0];
      return translate(m, t[0] - f[0], t[1] - f[1], t[2] - f[2]);
    };
    const t = time + a.id * 1.7;
    const phase = a.stride * 2.4;
    const walking = a.anim === Anim.Walk;

    let legSwing = 0, armL = 0, armR = 0, bob = 0, lean = 0, headPitch = 0, headYaw = 0, crouch = 0;
    const work = 0.5 + 0.5 * Math.sin(t * 6);
    switch (a.anim) {
      case Anim.Walk:
        legSwing = (Math.sin(phase) + Math.sin(phase * 2) * 0.1) * 0.52;
        armL = -Math.sin(phase - 0.18) * 0.42;
        armR = Math.sin(phase - 0.18) * 0.42;
        bob = Math.abs(Math.cos(phase)) * 0.045;
        lean = 0.06;
        break;
      case Anim.Till:
        armR = -2.0 + work * 1.4;
        armL = -0.9 + work * 0.5;
        lean = 0.14 + work * 0.1;
        headPitch = 0.28;
        break;
      case Anim.Plant:
        crouch = 0.18;
        armR = -0.85 + Math.sin(t * 4) * 0.25;
        armL = -0.45;
        lean = 0.3;
        headPitch = 0.4;
        break;
      case Anim.Harvest:
        crouch = 0.1;
        armR = -1.0 + Math.sin(t * 5) * 0.42;
        armL = -1.0 - Math.sin(t * 5) * 0.42;
        lean = 0.26;
        headPitch = 0.32;
        break;
      case Anim.Fish: {
        const twitch = Math.sin(t * 1.5) * 0.04 + Math.max(0, Math.sin(t * 7)) * 0.03;
        armR = -1.25 + twitch;
        armL = -0.95 + twitch;
        lean = 0.04;
        headPitch = 0.2;
        break;
      }
      case Anim.Build:
        armR = -2.2 + work * 1.3;
        armL = -0.3;
        lean = 0.1;
        break;
      case Anim.Eat: {
        const bite = Math.max(0, Math.sin(t * 5));
        armR = -1.9 + bite * 0.35;
        armL = -0.5;
        headPitch = -0.1 + bite * 0.1;
        lean = 0.05;
        break;
      }
      case Anim.Sleep:
        armL = armR = 0.05;
        bob = Math.sin(t * 1.1) * 0.01;
        headYaw = 0.25;
        break;
      default: {
        const breathe = Math.sin(t * 1.8);
        armL = 0.04 + breathe * 0.03;
        armR = -0.04 - breathe * 0.03;
        bob = breathe * 0.008;
        headYaw = Math.sin(t * 0.37) * 0.42 * Math.max(0, Math.sin(t * 0.13));
        headPitch = Math.sin(t * 0.23) * 0.07;
      }
    }

    // Something carried overhead: both arms up, holding it.
    if (a.carrying && a.anim !== Anim.Fall) armL = armR = -2.7;
    // Knocked over: topple backward, lie a moment, get up.
    let fall = 0;
    if (a.anim === Anim.Fall || a.down > 0) {
      const p = 1 - Math.min(1, a.down / DOWN_TICKS);
      fall = p < 0.2 ? p / 0.2 : p < 0.7 ? 1 : (1 - p) / 0.3;
      fall = 1.45 * fall * fall * (3 - 2 * fall);
      armL = -1.5 * fall / 1.45, armR = -1.5 * fall / 1.45, legSwing = 0, headPitch = 0;
      lean = 0, bob = 0;
    }

    identity(root);
    translate(root, a.x, a.y + bob - crouch, a.z);
    rotateY(root, a.yaw);
    if (walking) translate(root, Math.sin(phase) * 0.025, 0, 0);
    if (fall) rotateX(root, -fall);
    const asleep = a.anim === Anim.Sleep;
    if (asleep) {
      translate(root, 0, 0.12, 0.95);
      rotateX(root, -Math.PI / 2);
    }

    // Feet/legs pivot at the hips.
    for (const [side, role] of [[-1, "left leg"], [1, "right leg"]] as const) {
      if (!pieces[role]) continue;
      part.set(root);
      translate(joint(part, role), 0, crouch * 0.5, 0);
      rotateX(part, (walking ? side * legSwing : 0) - crouch * 1.1);
      add(pieces[role].id, part);
    }
    if (!pieces.body) continue;

    // Torso counter-rotates slightly as they walk.
    const torsoTwist = walking ? -Math.sin(phase) * 0.08 : 0;
    torso.set(root);
    joint(torso, "body");
    rotateY(torso, torsoTwist);
    rotateX(torso, lean);
    add(pieces.body.id, torso);

    // Emit front and back framed graphic tee decals for Floatsees!
    if (rig.floatsee && decals) {
      const frontLayer = decals.teeLayer(a.floatsee.frontTee);
      if (frontLayer >= 0) {
        decalMat.set(torso);
        translate(decalMat, 0, 0.36, 0.334);
        rotateX(decalMat, -0.17);
        scale(decalMat, 0.23, 0.25, 1);
        decals.add(DECAL_FLAT, decalMat, frontLayer, false);
      }
      const backLayer = decals.teeLayer(a.floatsee.backTee);
      if (backLayer >= 0) {
        decalMat.set(torso);
        translate(decalMat, 0, 0.36, -0.336);
        rotateY(decalMat, Math.PI);
        rotateX(decalMat, -0.17);
        scale(decalMat, 0.285, 0.315, 1);
        decals.add(DECAL_FLAT, decalMat, backLayer, false);
      }
    }

    // Sleeves/arms hang from the shoulders; the right hand carries a tool while working.
    for (const [side, role] of [[-1, "left arm"], [1, "right arm"]] as const) {
      if (!pieces[role]) continue;
      limb.set(torso);
      joint(limb, role, "body");
      rotateX(limb, side < 0 ? armL : armR);
      add(pieces[role].id, limb);
      if (side > 0 && a.anim === Anim.Till) add(ids.hoe, limb);
      if (side > 0 && a.anim === Anim.Build) add(ids.hammer, limb);
      if (side > 0 && a.anim === Anim.Fish) add(ids.rod, limb);
    }

    // Floating head hovers gently above the hollow collar!
    if (!pieces.head) continue;
    head.set(torso);
    joint(head, "head", "body");
    if (rig.floatsee) {
      const hover = asleep ? -0.04 : Math.sin(t * 2.4) * 0.036;
      const swayZ = asleep ? 0 : Math.sin(t * 1.45) * 0.04;
      translate(head, 0, hover, 0);
      rotateZ(head, swayZ);
    }
    rotateY(head, headYaw - torsoTwist * 0.65);
    rotateX(head, headPitch - (walking ? lean * 0.5 : 0));
    add(pieces.head.id, head);

    if (rig.floatsee && decals) {
      // Glowing facial expression hugs the front surface of the Floatsee head!
      const fp = FACE_PLACEMENT[a.floatsee.head] ?? FACE_PLACEMENT.sphere;
      const exprLayer = decals.expressionLayer(
        a.expression,
        a.floatsee.expressions[a.expression],
        a.floatsee.colors.glow,
      );
      const blink = asleep ? 0.18 : (a.expression === "happy" && (t % 4.7) < 0.11 ? 0.22 : 1);
      decalMat.set(head);
      translate(decalMat, fp.x, fp.y, fp.z);
      scale(decalMat, fp.w, fp.h * blink, fp.w);
      decals.add(fp.shape, decalMat, exprLayer, true, 1.85);
    } else if (pieces.eyes) {
      const blink = asleep || (t % 4.3) < 0.12 ? 0.15 : 1;
      part.set(head);
      add(pieces.eyes.id, scale(joint(part, "eyes", "head"), 1, blink, 1));
    }
  }
}
