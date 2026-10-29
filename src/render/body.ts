import { identity, mat4, rotateX, rotateY, scale, translate } from "../math.ts";
import type { Catalog, DesignContent, DesignPart, Role, Vec3 } from "../sim/catalog.ts";
import { Anim } from "../sim/sim.ts";
import type { AgentView } from "../simclient.ts";
import { ANCHOR, jointOf, meshDesign } from "./designs.ts";
import type { InstanceBatch, MeshLibrary, Rgb } from "./meshes.ts";

/** Villagers in the default farmer look vary its shirt and skin; chosen bodies keep their own. */
const SHIRTS: Rgb[] = [
  [0.55, 0.08, 0.05],
  [0.04, 0.3, 0.32],
  [0.6, 0.4, 0.04],
  [0.25, 0.1, 0.4],
  [0.1, 0.22, 0.55],
  [0.65, 0.2, 0.15],
];
const SKINS: Rgb[] = [[0.75, 0.48, 0.33], [0.5, 0.3, 0.18], [0.85, 0.6, 0.45], [0.32, 0.18, 0.1]];
const WOOD: Rgb = [0.3, 0.16, 0.06];
const IRON: Rgb = [0.35, 0.36, 0.38];
const WHITE: Rgb = [1, 1, 1];

const root = mat4(), part = mat4(), torso = mat4(), limb = mat4(), head = mat4(), place = mat4();

/** A villager look ready to pose: a template and a pivot (relative to the feet) per role. */
interface Rig {
  pieces: Partial<Record<Role, { id: number; at: Vec3 }>>;
}

const POSED: Role[] = ["left leg", "right leg", "body", "left arm", "right arm", "head", "eyes"];

/**
 * Villager bodies: the Catalog's "farmer" Design (or whatever replaced it) cut into its moving
 * roles, one template per role pivoted at its joint, plus the tools hands hold while working.
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
      b.cylinder(rotateX(at(0, -0.62, -0.08), Math.PI / 2), 0.03, 0.03, 0.78, { color: WOOD });
      b.box(at(0, -0.72, 0.68), [0.2, 0.22, 0.04], { color: IRON }, 0.01);
    });
    this.rod = lib.define("tool.rod", (b) => {
      // Held in the right hand: the rod points forward and up, the line hangs straight down.
      b.cylinder(rotateX(at(0, -0.6, 0), 2.214), 0.022, 0.01, 1.6, { color: WOOD, sway: [0, 0.3] });
      b.cylinder(rotateX(at(0, -1.56, 1.28), -1.845), 0.004, 0.004, 1.3, {
        color: [0.8, 0.8, 0.75],
      });
      b.sphere(translate(rotateX(at(0, -1.56, 1.28), -1.845), 0, 1.3, 0), [0.04, 0.04, 0.04], {
        color: [0.7, 0.05, 0.03],
      }, { detail: 0 });
    });
    this.hammer = lib.define("tool.hammer", (b) => {
      b.cylinder(rotateX(at(0, -0.62, -0.08), Math.PI / 2), 0.03, 0.03, 0.78, { color: WOOD });
      b.box(at(0, -0.62, 0.66), [0.16, 0.16, 0.12], { color: IRON }, 0.02);
    });
  }

  /**
   * The rig for a villager: the Design they chose (as the Catalog now has it), or the farmer in
   * this shirt and skin. Built on first use.
   */
  villager(catalog: Catalog, body: number | null, shirt: number, skin: number): Rig | null {
    if (catalog !== this.catalog) this.catalog = catalog, this.rigs.clear();
    const chosen = body === null ? undefined : catalog.get(body);
    let design = chosen && catalog.current(chosen);
    const own = design?.kind === "design" &&
      (design.content as DesignContent).parts.some((p) => p.role === "body");
    if (!own) {
      // The default, or a body whose Design was retired or replaced by something bodiless.
      const farmer = catalog.byName("farmer");
      design = farmer && catalog.current(farmer);
    }
    if (!design || design.kind !== "design") return null;
    const key = own ? `${design.id}` : `${design.id}:${shirt}:${skin}`;
    if (this.rigs.has(key)) return this.rigs.get(key)!;
    const d = design.content as DesignContent;
    const colors = own ? undefined : new Map([["linen", SHIRTS[shirt]], ["skin", SKINS[skin]]]);
    const rig: Rig = { pieces: {} };
    for (const role of POSED) {
      // Parts the pose doesn't move (no role, a tail, four legs) ride on the body.
      const only = role === "body"
        ? (p: DesignPart) => !p.role || !POSED.includes(p.role) || p.role === "body"
        : (p: DesignPart) => p.role === role;
      if (!d.parts.some(only)) continue;
      const at = jointOf(d, role);
      const id = this.lib.define(
        `villager:${key}:${role}`,
        (b) => meshDesign(b, catalog, d, { only, origin: at, sway: false, colors }),
      );
      rig.pieces[role] = { id, at: [at[0] - ANCHOR[0], at[1] - ANCHOR[1], at[2] - ANCHOR[2]] };
    }
    this.rigs.set(key, rig);
    return rig;
  }
}

/**
 * Villager bodies: their Design's roles posed from sim state (walking stride, current work) plus
 * time for idle life.
 */
export function buildBodies(
  agents: AgentView[],
  time: number,
  out: InstanceBatch,
  ids: BodyModels,
  catalog: Catalog,
) {
  const add = (id: number, m: Float32Array, c: Rgb = WHITE) => out.add(id, m, c[0], c[1], c[2]);

  for (const a of agents) {
    const rig = ids.villager(catalog, a.body, a.color % SHIRTS.length, (a.id * 7) % SKINS.length);
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
        legSwing = Math.sin(phase) * 0.65;
        armL = -Math.sin(phase) * 0.5;
        armR = Math.sin(phase) * 0.5;
        bob = Math.abs(Math.cos(phase)) * 0.06;
        lean = 0.06;
        break;
      case Anim.Till:
        armR = -2.2 + work * 1.6; // raise the hoe and bring it down
        armL = -1.0 + work * 0.6;
        lean = 0.15 + work * 0.12;
        headPitch = 0.3;
        break;
      case Anim.Plant:
        crouch = 0.22;
        armR = -0.9 + Math.sin(t * 4) * 0.25;
        armL = -0.5;
        lean = 0.35;
        headPitch = 0.45;
        break;
      case Anim.Harvest:
        crouch = 0.12;
        armR = -1.1 + Math.sin(t * 5) * 0.45;
        armL = -1.1 - Math.sin(t * 5) * 0.45;
        lean = 0.3;
        headPitch = 0.35;
        break;
      case Anim.Fish: {
        const twitch = Math.sin(t * 1.5) * 0.04 + Math.max(0, Math.sin(t * 7)) * 0.03;
        armR = -1.3 + twitch;
        armL = -1.05 + twitch;
        lean = 0.04;
        headPitch = 0.25;
        break;
      }
      case Anim.Build:
        armR = -2.4 + work * 1.4;
        armL = -0.3;
        lean = 0.1;
        break;
      default: {
        const breathe = Math.sin(t * 1.8);
        armL = 0.04 + breathe * 0.03;
        armR = -0.04 - breathe * 0.03;
        bob = breathe * 0.008;
        headYaw = Math.sin(t * 0.37) * 0.5 * Math.max(0, Math.sin(t * 0.13));
        headPitch = Math.sin(t * 0.23) * 0.08;
      }
    }

    identity(root);
    translate(root, a.x, a.y + bob - crouch, a.z);
    rotateY(root, a.yaw);

    // Legs pivot at the hips; crouching bends them forward a little.
    for (const [side, role] of [[-1, "left leg"], [1, "right leg"]] as const) {
      if (!pieces[role]) continue;
      part.set(root);
      translate(joint(part, role), 0, crouch * 0.5, 0);
      rotateX(part, (walking ? side * legSwing : 0) - crouch * 1.2);
      add(pieces[role].id, part);
    }
    if (!pieces.body) continue;

    // The body leans from the hips.
    torso.set(root);
    joint(torso, "body");
    rotateX(torso, lean);
    add(pieces.body.id, torso);

    // Arms hang from the shoulders; the right hand carries a tool while working.
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

    // Head on the neck, with blinking eyes.
    if (!pieces.head) continue;
    head.set(torso);
    joint(head, "head", "body");
    rotateY(head, headYaw);
    rotateX(head, headPitch);
    add(pieces.head.id, head);
    if (pieces.eyes) {
      const blink = (t % 4.3) < 0.12 ? 0.15 : 1;
      part.set(head);
      add(pieces.eyes.id, scale(joint(part, "eyes", "head"), 1, blink, 1));
    }
  }
}
