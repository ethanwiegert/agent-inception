import { identity, mat4, rotateX, rotateY, rotateZ, scale, translate } from "../math.ts";
import { AnimalAnim, SPECIES } from "../sim/animals.ts";
import { ANIMAL_READY } from "../sim/protocol.ts";
import type { AnimalView } from "../simclient.ts";
import type { InstanceBatch, MeshBuilder, MeshLibrary, Rgb } from "./meshes.ts";

/**
 * Animals as rigs: each species is a list of parts (mesh templates) hung from pivots, and each
 * part has a role that says how it moves: legs swing with the stride, heads graze and look
 * around, tails wag, bodies bob. Species are matched to sim species by name, so new ones only
 * need a rig here (or, later, an agent-defined one).
 */
type Role = "body" | "head" | "leg" | "tail" | "product";

interface Part {
  model: string;
  /** Pivot relative to the animal's feet, facing +z. */
  at: [number, number, number];
  role: Role;
  /** Legs: 0 or 1, which diagonal pair it belongs to. */
  phase?: number;
}

interface Rig {
  models: Record<string, (b: MeshBuilder) => void>;
  parts: Part[];
  /** Leg swing per block walked. */
  gait: number;
  /** How far the body sinks when asleep. */
  sleepDrop: number;
  /** Floats instead of walking (ducks). */
  swims?: boolean;
}

const place = mat4();
const at = (x: number, y: number, z: number) => translate(identity(place), x, y, z);

const WOOL: Rgb = [0.78, 0.75, 0.68];
const SHEEP_FACE: Rgb = [0.06, 0.05, 0.045];
const COW_WHITE: Rgb = [0.75, 0.72, 0.68];
const COW_PATCH: Rgb = [0.04, 0.035, 0.03];
const MUZZLE: Rgb = [0.6, 0.35, 0.33];
const HORN: Rgb = [0.65, 0.6, 0.48];
const FEATHER: Rgb = [0.85, 0.83, 0.78];
const COMB: Rgb = [0.6, 0.04, 0.03];
const BEAK: Rgb = [0.75, 0.42, 0.05];
const DUCK_BODY: Rgb = [0.3, 0.2, 0.12];
const DUCK_HEAD: Rgb = [0.03, 0.2, 0.08];
const EYE: Rgb = [0.01, 0.01, 0.01];
const HOOF: Rgb = [0.05, 0.04, 0.03];

const leg = (color: Rgb, length: number, r: number) => (b: MeshBuilder) =>
  b.cylinder(at(0, -length, 0), r * 0.85, r, length, { color, ao: 0.3 }, { segments: 6 });

const RIGS: Record<string, Rig> = {
  sheep: {
    gait: 5,
    sleepDrop: 0.25,
    models: {
      "sheep.wool": (b) => {
        for (const [x, y, z, r] of [[0, 0, 0, 0.34], [0, 0.04, 0.2, 0.28], [0, 0.03, -0.2, 0.3]]) {
          b.sphere(at(x, y, z), [r, r * 0.9, r], { color: WOOL, ao: 0.35, jitter: 0.06 }, {
            detail: 1,
            noise: 0.15,
            seed: Math.round(z * 10 + 3),
          });
        }
      },
      "sheep.head": (b) => {
        b.box(at(0, 0, 0.12), [0.19, 0.22, 0.28], { color: SHEEP_FACE }, 0.07);
        b.sphere(at(0, 0.1, 0.04), [0.13, 0.08, 0.12], { color: WOOL, jitter: 0.05 }, {
          detail: 1,
        });
        for (const s of [-1, 1]) {
          b.box(rotateZ(at(s * 0.13, 0.05, 0.06), s * 0.5), [0.12, 0.04, 0.07], {
            color: SHEEP_FACE,
          }, 0.015);
          b.box(at(s * 0.08, 0.04, 0.2), [0.035, 0.035, 0.02], { color: [0.5, 0.45, 0.2] });
        }
      },
      "sheep.leg": leg(SHEEP_FACE, 0.36, 0.05),
    },
    parts: [
      { model: "sheep.wool", at: [0, 0.58, 0], role: "product" },
      { model: "sheep.head", at: [0, 0.66, 0.38], role: "head" },
      { model: "sheep.leg", at: [-0.13, 0.38, 0.22], role: "leg", phase: 0 },
      { model: "sheep.leg", at: [0.13, 0.38, 0.22], role: "leg", phase: 1 },
      { model: "sheep.leg", at: [-0.13, 0.38, -0.22], role: "leg", phase: 1 },
      { model: "sheep.leg", at: [0.13, 0.38, -0.22], role: "leg", phase: 0 },
    ],
  },
  cow: {
    gait: 3.5,
    sleepDrop: 0.4,
    models: {
      "cow.body": (b) => {
        b.box(null, [0.62, 0.6, 1.2], { color: COW_WHITE, ao: 0.3 }, 0.18);
        for (
          const [x, y, z, r] of [[0.3, 0.05, 0.2, 0.2], [-0.3, -0.02, -0.25, 0.24], [
            0.28,
            0.1,
            -0.35,
            0.15,
          ], [0, 0.3, -0.05, 0.22]]
        ) {
          b.sphere(at(x, y, z), [r * (x ? 0.25 : 1), r * (x ? 1 : 0.2), r], { color: COW_PATCH }, {
            detail: 1,
            noise: 0.2,
          });
        }
        b.cylinder(rotateX(at(0, 0.2, -0.6), -2.7), 0.025, 0.02, 0.6, { color: COW_WHITE }, {
          segments: 4,
        });
      },
      "cow.head": (b) => {
        b.box(at(0, 0, 0.18), [0.32, 0.34, 0.42], { color: COW_WHITE }, 0.1);
        b.box(at(0, -0.07, 0.4), [0.3, 0.2, 0.12], { color: MUZZLE }, 0.06);
        for (const s of [-1, 1]) {
          b.cone(rotateZ(at(s * 0.13, 0.15, 0.1), -s * 1.1), 0.04, 0.18, { color: HORN }, {
            segments: 5,
          });
          b.box(rotateZ(at(s * 0.21, 0.07, 0.08), s * 0.4), [0.14, 0.05, 0.08], {
            color: COW_PATCH,
          }, 0.02);
          b.box(at(s * 0.1, 0.06, 0.39), [0.04, 0.04, 0.02], { color: EYE });
        }
      },
      "cow.leg": (b) => {
        leg(COW_WHITE, 0.6, 0.075)(b);
        b.cylinder(at(0, -0.62, 0), 0.08, 0.08, 0.1, { color: HOOF }, { segments: 6 });
      },
    },
    parts: [
      { model: "cow.body", at: [0, 0.9, 0], role: "body" },
      { model: "cow.head", at: [0, 1.05, 0.62], role: "head" },
      { model: "cow.leg", at: [-0.2, 0.62, 0.42], role: "leg", phase: 0 },
      { model: "cow.leg", at: [0.2, 0.62, 0.42], role: "leg", phase: 1 },
      { model: "cow.leg", at: [-0.2, 0.62, -0.42], role: "leg", phase: 1 },
      { model: "cow.leg", at: [0.2, 0.62, -0.42], role: "leg", phase: 0 },
    ],
  },
  chicken: {
    gait: 12,
    sleepDrop: 0.12,
    models: {
      "chicken.body": (b) => {
        b.sphere(null, [0.15, 0.14, 0.19], { color: FEATHER, ao: 0.3 }, { detail: 1 });
        b.box(rotateX(at(0, 0.08, -0.17), -0.6), [0.12, 0.16, 0.05], { color: FEATHER }, 0.02);
      },
      "chicken.head": (b) => {
        b.sphere(at(0, 0.06, 0.03), [0.075, 0.085, 0.075], { color: FEATHER }, { detail: 1 });
        b.box(at(0, 0.15, 0.03), [0.025, 0.06, 0.09], { color: COMB }, 0.01);
        b.box(at(0, 0.0, 0.1), [0.025, 0.05, 0.025], { color: COMB }, 0.01);
        b.cone(rotateX(at(0, 0.05, 0.08), Math.PI / 2), 0.025, 0.07, { color: BEAK }, {
          segments: 4,
        });
        for (const s of [-1, 1]) {
          b.box(at(s * 0.065, 0.08, 0.06), [0.015, 0.02, 0.02], { color: EYE });
        }
      },
      "chicken.leg": leg(BEAK, 0.17, 0.014),
    },
    parts: [
      { model: "chicken.body", at: [0, 0.27, 0], role: "body" },
      { model: "chicken.head", at: [0, 0.36, 0.14], role: "head" },
      { model: "chicken.leg", at: [-0.05, 0.17, 0], role: "leg", phase: 0 },
      { model: "chicken.leg", at: [0.05, 0.17, 0], role: "leg", phase: 1 },
    ],
  },
  duck: {
    gait: 0,
    sleepDrop: 0.03,
    swims: true,
    models: {
      "duck.body": (b) => {
        b.sphere(null, [0.14, 0.11, 0.23], { color: DUCK_BODY, ao: 0.4, jitter: 0.06 }, {
          detail: 1,
        });
        b.box(rotateX(at(0, 0.07, -0.21), -0.5), [0.1, 0.04, 0.1], { color: DUCK_BODY }, 0.02);
      },
      "duck.head": (b) => {
        b.cylinder(at(0, -0.08, 0), 0.045, 0.04, 0.1, { color: [0.7, 0.7, 0.68] }, { segments: 6 });
        b.sphere(at(0, 0.06, 0.02), [0.07, 0.07, 0.08], { color: DUCK_HEAD }, { detail: 1 });
        b.box(at(0, 0.04, 0.11), [0.06, 0.025, 0.08], { color: BEAK }, 0.01);
        for (const s of [-1, 1]) {
          b.box(at(s * 0.06, 0.08, 0.05), [0.015, 0.02, 0.02], { color: EYE });
        }
      },
    },
    parts: [
      { model: "duck.body", at: [0, 0.04, 0], role: "body" },
      { model: "duck.head", at: [0, 0.16, 0.16], role: "head" },
    ],
  },
};

/** Template ids per sim species, parallel to each rig's parts (-1 for species without a rig). */
export type FaunaModels = number[][];

export function defineFaunaModels(lib: MeshLibrary): FaunaModels {
  return SPECIES.map((def) => {
    const rig = RIGS[def.name];
    if (!rig) return [];
    const ids = new Map<string, number>();
    for (const [name, build] of Object.entries(rig.models)) ids.set(name, lib.define(name, build));
    return rig.parts.map((p) => ids.get(p.model) ?? -1);
  });
}

const root = mat4(), m = mat4();

export function buildAnimals(
  animals: AnimalView[],
  time: number,
  out: InstanceBatch,
  ids: FaunaModels,
) {
  for (const a of animals) {
    const def = SPECIES[a.species], rig = def && RIGS[def.name];
    if (!rig) continue;
    const t = time + a.id * 2.3;
    const walking = a.anim === AnimalAnim.Walk;
    const asleep = a.anim === AnimalAnim.Sleep;
    const grazing = a.anim === AnimalAnim.Graze;
    const swing = Math.sin(a.stride * rig.gait);
    let bob = walking ? Math.abs(Math.cos(a.stride * rig.gait)) * 0.03 : Math.sin(t * 1.6) * 0.006;
    if (rig.swims) bob = Math.sin(t * 2.1) * 0.015;
    identity(root);
    translate(root, a.x, a.y + bob - (asleep ? rig.sleepDrop : 0), a.z);
    rotateY(root, a.yaw);
    // Ducks dabble: tip forward with the tail up.
    if (rig.swims && grazing) rotateX(root, 0.5 + Math.sin(t * 3) * 0.2);

    rig.parts.forEach((p, i) => {
      const id = ids[a.species][i];
      if (id < 0) return;
      m.set(root);
      translate(m, p.at[0], p.at[1], p.at[2]);
      switch (p.role) {
        case "leg":
          if (asleep) scale(m, 1, 0.3, 1);
          else if (walking) rotateX(m, (p.phase ? -swing : swing) * 0.55);
          break;
        case "head":
          if (grazing && !rig.swims) {
            // Nibble: head down, with quick little dips (chickens peck hard).
            const fast = def.name === "chicken";
            rotateX(m, 0.75 + Math.max(0, Math.sin(t * (fast ? 9 : 3))) * (fast ? 0.5 : 0.15));
          } else if (asleep) rotateX(m, 0.5);
          else {
            rotateY(m, Math.sin(t * 0.4) * 0.5 * Math.max(0, Math.sin(t * 0.17)));
            rotateX(m, walking ? Math.sin(a.stride * rig.gait * 2) * 0.05 : 0);
          }
          break;
        case "product": {
          // Sheared sheep look trimmed until the wool grows back.
          const k = a.flags & ANIMAL_READY ? 1 : 0.78;
          scale(m, k, k, k);
          break;
        }
      }
      out.add(id, m);
    });
  }
}
