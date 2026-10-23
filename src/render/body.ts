import { identity, mat4, rotateX, rotateY, scale, translate } from "../math.ts";
import { Anim } from "../sim/sim.ts";
import type { AgentView } from "../simclient.ts";
import { BOX_FLOATS } from "./boxes.ts";

type Rgb = [number, number, number];

const SHIRTS: Rgb[] = [
  [0.55, 0.08, 0.05],
  [0.04, 0.3, 0.32],
  [0.6, 0.4, 0.04],
  [0.25, 0.1, 0.4],
  [0.1, 0.22, 0.55],
  [0.65, 0.2, 0.15],
];
const SKINS: Rgb[] = [[0.75, 0.48, 0.33], [0.5, 0.3, 0.18], [0.85, 0.6, 0.45], [0.32, 0.18, 0.1]];
const PANTS: Rgb = [0.05, 0.07, 0.13];
const STRAW: Rgb = [0.7, 0.52, 0.18];
const BAND: Rgb = [0.35, 0.05, 0.03];
const EYES: Rgb = [0.02, 0.02, 0.03];
const WOOD: Rgb = [0.3, 0.16, 0.06];
const IRON: Rgb = [0.35, 0.36, 0.38];

/** Max boxes per farmer, for buffer sizing. */
export const BODY_BOXES = 16;

const root = mat4(), part = mat4(), torso = mat4(), limb = mat4(), head = mat4();

/**
 * Procedural farmer: a blocky body built from boxes and animated from sim
 * state (walking stride, current work) plus time for idle life.
 */
export function buildBodies(agents: AgentView[], time: number, out: Float32Array): number {
  let n = 0;
  const emit = (m: Float32Array, color: Rgb) => {
    out.set(m, n * BOX_FLOATS);
    out[n * BOX_FLOATS + 16] = color[0];
    out[n * BOX_FLOATS + 17] = color[1];
    out[n * BOX_FLOATS + 18] = color[2];
    out[n * BOX_FLOATS + 19] = 1;
    n++;
  };
  /** Box of `size` whose center sits at (cx, cy, cz) in the frame `base`. */
  const box = (
    base: Float32Array,
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    color: Rgb,
  ) => {
    part.set(base);
    scale(translate(part, cx, cy, cz), sx, sy, sz);
    emit(part, color);
  };

  for (const a of agents) {
    const shirt = SHIRTS[a.color % SHIRTS.length];
    const skin = SKINS[(a.id * 7) % SKINS.length];
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
    for (const side of [-1, 1]) {
      part.set(root);
      translate(part, side * 0.12, 0.72 + crouch * 0.5, 0);
      rotateX(part, (walking ? side * legSwing : 0) - crouch * 1.2);
      scale(translate(part, 0, -0.36, 0), 0.2, 0.72, 0.22);
      emit(part, PANTS);
    }

    // Torso leans from the hips.
    torso.set(root);
    translate(torso, 0, 0.72, 0);
    rotateX(torso, lean);
    box(torso, 0, 0.3, 0, 0.5, 0.6, 0.3, shirt);

    // Arms hang from the shoulders; the right hand carries a tool while working.
    for (const side of [-1, 1]) {
      limb.set(torso);
      translate(limb, side * 0.33, 0.56, 0);
      rotateX(limb, side < 0 ? armL : armR);
      const arm = limb;
      box(arm, 0, -0.27, 0, 0.16, 0.56, 0.16, shirt);
      box(arm, 0, -0.6, 0, 0.14, 0.12, 0.14, skin);
      if (side > 0 && (a.anim === Anim.Till || a.anim === Anim.Build)) {
        const hoe = a.anim === Anim.Till;
        box(arm, 0, -0.62, 0.3, 0.05, 0.05, 0.75, WOOD);
        box(arm, 0, hoe ? -0.72 : -0.62, 0.66, hoe ? 0.2 : 0.16, hoe ? 0.22 : 0.16, 0.05, IRON);
      }
    }

    // Head on the neck, with eyes and a straw hat.
    head.set(torso);
    translate(head, 0, 0.6, 0);
    rotateY(head, headYaw);
    rotateX(head, headPitch);
    const h = head;
    box(h, 0, 0.22, 0, 0.42, 0.42, 0.42, skin);
    const blink = (t % 4.3) < 0.12 ? 0.015 : 0.09;
    box(h, -0.1, 0.24, 0.215, 0.07, blink, 0.02, EYES);
    box(h, 0.1, 0.24, 0.215, 0.07, blink, 0.02, EYES);
    box(h, 0, 0.45, 0, 0.72, 0.05, 0.72, STRAW);
    box(h, 0, 0.52, 0, 0.44, 0.1, 0.44, BAND);
    box(h, 0, 0.6, 0, 0.42, 0.1, 0.42, STRAW);
  }
  return n;
}
