import { identity, mat4, rotateX, rotateY, scale, translate } from "../math.ts";
import { AnimalAnim, SPECIES } from "../sim/animals.ts";
import type { Catalog, DesignContent, Role, Vec3 } from "../sim/catalog.ts";
import { FISH } from "../sim/fish.ts";
import { ANIMAL_READY, SCHOOL_STRIDE } from "../sim/protocol.ts";
import { hash2 } from "../sim/rng.ts";
import type { World } from "../sim/world.ts";
import type { AnimalView } from "../simclient.ts";
import { ANCHOR, jointOf, meshDesign } from "./designs.ts";
import type { InstanceBatch, MeshLibrary, Rgb } from "./meshes.ts";

/**
 * Animals: each species' body is its Design in the Catalog (matched by name), cut into roles that
 * say how each piece moves: legs swing with the stride, heads graze and look around, the product
 * (a sheep's wool) shrinks when collected. How a species moves stays code until V2 (ADR 0002).
 */
interface Gait {
  /** Leg swing per block walked. */
  gait: number;
  /** How far the body sinks when asleep. */
  sleepDrop: number;
  /** Floats instead of walking (ducks). */
  swims?: boolean;
  /** Pecks hard and fast when grazing (chickens). */
  pecks?: boolean;
}

const GAITS: Record<string, Gait> = {
  sheep: { gait: 5, sleepDrop: 0.25 },
  cow: { gait: 3.5, sleepDrop: 0.4 },
  chicken: { gait: 12, sleepDrop: 0.12, pecks: true },
  duck: { gait: 0, sleepDrop: 0.03, swims: true },
};

/** Legs that swing forward while their partners swing back. */
const LEAD: Role[] = ["front left leg", "back right leg", "left leg"];
const ANIMAL_ROLES: Role[] = [
  "body",
  "product",
  "head",
  "eyes",
  "tail",
  "left leg",
  "right leg",
  "front left leg",
  "front right leg",
  "back left leg",
  "back right leg",
];

interface Piece {
  role: Role;
  id: number;
  /** Pivot relative to the feet, facing +z. */
  at: Vec3;
}

/** Body templates per species, from the Catalog, built on first use. */
export class FaunaModels {
  private rigs = new Map<number, Piece[]>();
  private catalog: Catalog | null = null;

  constructor(private lib: MeshLibrary) {}

  pieces(catalog: Catalog, species: number): Piece[] {
    if (catalog !== this.catalog) this.catalog = catalog, this.rigs.clear();
    const hit = this.rigs.get(species);
    if (hit) return hit;
    const named = SPECIES[species] && catalog.byName(SPECIES[species].name);
    const design = named && catalog.current(named);
    const pieces: Piece[] = [];
    if (design?.kind === "design") {
      const d = design.content as DesignContent;
      for (const role of ANIMAL_ROLES) {
        if (!d.parts.some((p) => p.role === role)) continue;
        const at = jointOf(d, role);
        const id = this.lib.define(
          `animal:${design.id}:${role}`,
          (b) => meshDesign(b, catalog, d, { role, origin: at, sway: false }),
        );
        pieces.push({ role, id, at: [at[0] - ANCHOR[0], at[1] - ANCHOR[1], at[2] - ANCHOR[2]] });
      }
    }
    // Retired species without a replacement simply aren't drawn; check again next version.
    if (pieces.length) this.rigs.set(species, pieces);
    return pieces;
  }
}

const root = mat4(), m = mat4();

export function buildAnimals(
  animals: AnimalView[],
  time: number,
  out: InstanceBatch,
  models: FaunaModels,
  catalog: Catalog,
) {
  for (const a of animals) {
    const def = SPECIES[a.species], rig = def && GAITS[def.name];
    if (!rig) continue;
    const pieces = models.pieces(catalog, a.species);
    if (!pieces.length) continue;
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

    for (const p of pieces) {
      m.set(root);
      translate(m, p.at[0], p.at[1], p.at[2]);
      switch (p.role) {
        case "head":
        case "eyes":
          if (grazing && !rig.swims) {
            // Nibble: head down, with quick little dips (chickens peck hard).
            const fast = rig.pecks;
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
        case "body":
        case "tail":
          break;
        default:
          if (asleep) scale(m, 1, 0.3, 1);
          else if (walking) rotateX(m, (LEAD.includes(p.role) ? swing : -swing) * 0.55);
      }
      out.add(p.id, m);
    }
  }
}

// ---------------------------------------------------------------- fish

const place = mat4();
const at = (x: number, y: number, z: number) => translate(identity(place), x, y, z);

const FISH_LOOKS: Record<string, { length: number; back: Rgb; belly: Rgb; fin: Rgb }> = {
  minnow: {
    length: 0.14,
    back: [0.12, 0.14, 0.08],
    belly: [0.55, 0.55, 0.5],
    fin: [0.2, 0.2, 0.15],
  },
  trout: {
    length: 0.38,
    back: [0.12, 0.13, 0.06],
    belly: [0.6, 0.4, 0.35],
    fin: [0.18, 0.15, 0.08],
  },
  perch: { length: 0.26, back: [0.2, 0.25, 0.04], belly: [0.6, 0.5, 0.2], fin: [0.5, 0.15, 0.05] },
  mackerel: {
    length: 0.34,
    back: [0.03, 0.12, 0.15],
    belly: [0.65, 0.68, 0.7],
    fin: [0.05, 0.1, 0.12],
  },
  cod: { length: 0.5, back: [0.2, 0.16, 0.1], belly: [0.55, 0.52, 0.45], fin: [0.2, 0.17, 0.12] },
};

/** Template id per fish species (`FISH` order), or -1. */
export function defineFishModels(lib: MeshLibrary): number[] {
  return FISH.map((def) => {
    const look = FISH_LOOKS[def.name];
    if (!look) return -1;
    const l = look.length;
    return lib.define(`fish.${def.name}`, (b) => {
      // Dark back over a pale belly, a tail fin and a dorsal fin; nose toward +z.
      b.sphere(at(0, 0.02 * l, 0), [0.16 * l, 0.17 * l, 0.5 * l], { color: look.back }, {
        detail: 1,
      });
      b.sphere(at(0, -0.05 * l, 0.02 * l), [0.14 * l, 0.12 * l, 0.42 * l], { color: look.belly }, {
        detail: 1,
      });
      b.box(rotateY(at(0, 0, -0.55 * l), Math.PI / 4), [0.03 * l, 0.3 * l, 0.25 * l], {
        color: look.fin,
      });
      b.box(at(0, 0.18 * l, 0), [0.02 * l, 0.12 * l, 0.3 * l], { color: look.fin });
    });
  });
}

/** Fish swim just under the surface (or above the bed in shallows). */
const FISH_DEPTH = 0.32;
const JUMP_PERIOD = 23;

/**
 * Each school's fish circle its center at their own pace and radius, wiggling as they go; now and
 * then one leaps out of the water and splashes back.
 */
export function buildFish(
  schools: Float32Array,
  world: World,
  time: number,
  out: InstanceBatch,
  ids: number[],
) {
  for (let i = 0; i < schools.length; i += SCHOOL_STRIDE) {
    const id = schools[i], species = schools[i + 1], count = schools[i + 4];
    const tid = ids[species];
    if (tid === undefined || tid < 0) continue;
    const sx = schools[i + 2], sz = schools[i + 3];
    const key = Math.floor(sz) * world.sizeX + Math.floor(sx);
    if (world.waterTop[key] < 0) continue;
    const surface = world.waterTop[key] + 1 - 0.12;
    const bed = world.heightAt(Math.floor(sx), Math.floor(sz)) + 1.1;
    const jump = ((time + id * 7.3) % JUMP_PERIOD) / JUMP_PERIOD;
    for (let f = 0; f < count; f++) {
      const h1 = hash2(id, f, 31), h2 = hash2(id, f, 32);
      const dir = h1 < 0.5 ? 1 : -1;
      const w = (0.35 + h2 * 0.4) * dir;
      const a = time * w + (f / count) * Math.PI * 2 + h1 * 3;
      const r = 0.35 + h2 * 0.9;
      const x = sx + Math.cos(a) * r, z = sz + Math.sin(a) * r;
      let y = Math.max(bed, surface - FISH_DEPTH - h1 * 0.15);
      let pitch = 0, wet = 1;
      if (f === 0 && jump < 0.04) {
        // A leap: out along a short arc, nose up then nose down.
        const k = jump / 0.04;
        y = surface - 0.15 + Math.sin(Math.PI * k) * 0.55;
        pitch = (k - 0.5) * 2.2;
        wet = y > surface ? 0 : 1;
      }
      identity(m);
      translate(m, x, y, z);
      // Facing along the circle, plus a tail-driven wiggle.
      rotateY(
        m,
        Math.atan2(-Math.sin(a) * dir, Math.cos(a) * dir) + Math.sin(time * 11 + f) * 0.18,
      );
      rotateX(m, pitch);
      // The water shader doesn't tint what's under it, so fish take the water's color themselves.
      const depth = Math.min(1, (surface - y) / 1.5);
      const k = 1 - wet * (0.35 + depth * 0.3);
      out.add(tid, m, k * 0.75 + 0.25 * (1 - wet), k * 0.95 + 0.05 * (1 - wet), k);
    }
  }
}
