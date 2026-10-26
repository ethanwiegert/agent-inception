import { identity, mat4, rotateX, rotateY, rotateZ, scale, translate } from "../math.ts";
import { Anim, type Sprite } from "../sim/sim.ts";
import type { AgentView } from "../simclient.ts";
import type { InstanceBatch, MeshLibrary, Rgb } from "./meshes.ts";

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
const BOOTS: Rgb = [0.1, 0.05, 0.02];
const STRAW: Rgb = [0.7, 0.52, 0.18];
const BAND: Rgb = [0.35, 0.05, 0.03];
const EYES: Rgb = [0.02, 0.02, 0.03];
const WOOD: Rgb = [0.3, 0.16, 0.06];
const IRON: Rgb = [0.35, 0.36, 0.38];
const WHITE: Rgb = [1, 1, 1];

const root = mat4(), part = mat4(), torso = mat4(), limb = mat4(), head = mat4(), place = mat4();

/** Template ids for bodies, from `defineBodyModels`. */
export type BodyModels = ReturnType<typeof defineBodyModels>;

/**
 * Farmer parts as rounded mesh templates, each with its pivot at the origin (hip, shoulder, neck).
 * Shirt and skin parts are white and take the agent's colors as instance tints.
 */
export function defineBodyModels(lib: MeshLibrary) {
  const at = (x: number, y: number, z: number) => translate(identity(place), x, y, z);
  return {
    cube: lib.define("cube", (b) => b.box(null, [1, 1, 1], { color: WHITE })),
    leg: lib.define("farmer.leg", (b) => {
      b.box(at(0, -0.33, 0), [0.2, 0.66, 0.22], { color: PANTS, ao: 0.3 }, 0.07);
      b.box(at(0, -0.66, 0.02), [0.21, 0.13, 0.27], { color: BOOTS }, 0.05);
    }),
    torso: lib.define("farmer.torso", (b) => {
      b.box(at(0, 0.3, 0), [0.5, 0.6, 0.3], { color: WHITE, ao: 0.2 }, 0.1);
    }),
    sleeve: lib.define("farmer.sleeve", (b) => {
      b.box(at(0, -0.26, 0), [0.16, 0.54, 0.16], { color: WHITE }, 0.07);
    }),
    hand: lib.define("farmer.hand", (b) => {
      b.sphere(at(0, -0.6, 0), [0.08, 0.08, 0.08], { color: WHITE }, { detail: 1 });
    }),
    head: lib.define("farmer.head", (b) => {
      b.box(at(0, 0.22, 0), [0.42, 0.42, 0.42], { color: WHITE }, 0.09);
      b.box(at(0, 0.18, 0.22), [0.07, 0.08, 0.06], { color: WHITE }, 0.025);
    }),
    eyes: lib.define("farmer.eyes", (b) => {
      for (const x of [-0.1, 0.1]) b.box(at(x, 0, 0), [0.07, 0.09, 0.02], { color: EYES }, 0.01);
    }),
    hat: lib.define("farmer.hat", (b) => {
      const straw = { color: STRAW, jitter: 0.08 };
      b.cylinder(at(0, 0.42, 0), 0.4, 0.38, 0.04, straw, { segments: 18 });
      b.cylinder(at(0, 0.45, 0), 0.24, 0.21, 0.22, straw, { segments: 14 });
      b.cylinder(at(0, 0.47, 0), 0.245, 0.235, 0.06, { color: BAND }, { segments: 14 });
    }),
    hoe: lib.define("tool.hoe", (b) => {
      b.cylinder(rotateX(at(0, -0.62, -0.08), Math.PI / 2), 0.03, 0.03, 0.78, { color: WOOD });
      b.box(at(0, -0.72, 0.68), [0.2, 0.22, 0.04], { color: IRON }, 0.01);
    }),
    hammer: lib.define("tool.hammer", (b) => {
      b.cylinder(rotateX(at(0, -0.62, -0.08), Math.PI / 2), 0.03, 0.03, 0.78, { color: WOOD });
      b.box(at(0, -0.62, 0.66), [0.16, 0.16, 0.12], { color: IRON }, 0.02);
    }),
  };
}

/** A horizontal run of same-colored sprite pixels, drawn as one box. Color is linear. */
interface Run {
  x: number;
  y: number;
  length: number;
  color: Rgb;
}

const runsCache = new WeakMap<Sprite, Run[]>();
const facingLeft = new Map<number, boolean>();

function spriteRuns(sprite: Sprite): Run[] {
  let runs = runsCache.get(sprite);
  if (runs) return runs;
  runs = [];
  const { width, height, pixels } = sprite;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width;) {
      const p = pixels[y * width + x];
      let end = x + 1;
      while (end < width && pixels[y * width + end] === p) end++;
      if (p >= 0) {
        const lin = (c: number) => Math.pow(c / 255, 2.2);
        runs.push({
          x,
          y,
          length: end - x,
          color: [lin(p >> 16), lin((p >> 8) & 255), lin(p & 255)],
        });
      }
      x = end;
    }
  }
  runsCache.set(sprite, runs);
  return runs;
}

/**
 * Procedural farmer: rounded parts posed from sim state (walking stride, current work) plus time
 * for idle life. Agents with a sprite become an extruded paper doll that turns to face the camera
 * instead.
 */
export function buildBodies(
  agents: AgentView[],
  time: number,
  out: InstanceBatch,
  cameraYaw: number,
  ids: BodyModels,
) {
  const add = (id: number, m: Float32Array, c: Rgb = WHITE) => out.add(id, m, c[0], c[1], c[2]);

  /** Sprite agents: billboard about Y toward the camera, flip to face the way they walk. */
  const doll = (a: AgentView, sprite: Sprite) => {
    const t = time + a.id * 1.7;
    const phase = a.stride * 2.4;
    // Which way they face on screen, with a dead zone so standing still doesn't flicker.
    const side = Math.sin(a.yaw - cameraYaw);
    if (Math.abs(side) > 0.25) facingLeft.set(a.id, side < 0);
    const flip = facingLeft.get(a.id) ? -1 : 1;

    let bob = 0, sway = 0, squash = 1;
    const work = 0.5 + 0.5 * Math.sin(t * 6);
    if (a.anim === Anim.Walk) {
      bob = Math.abs(Math.sin(phase)) * 0.1;
      sway = Math.sin(phase) * 0.1;
    } else if (a.anim !== Anim.Idle) {
      squash = 1 - 0.08 * work;
      sway = -flip * 0.18 * work;
    } else {
      squash = 1 + 0.02 * Math.sin(t * 1.8);
    }

    const px = Math.min(1.9 / sprite.height, 1.5 / sprite.width);
    const depth = px * 1.2;
    identity(root);
    translate(root, a.x, a.y + bob, a.z);
    rotateY(root, cameraYaw);
    rotateZ(root, sway);
    scale(root, 1, squash, 1);
    for (const r of spriteRuns(sprite)) {
      const cx = (r.x + r.length / 2 - sprite.width / 2) * px * flip;
      const cy = (sprite.height - r.y - 0.5) * px;
      part.set(root);
      add(ids.cube, scale(translate(part, cx, cy, 0), r.length * px, px, depth), r.color);
    }
  };

  for (const a of agents) {
    if (a.sprite) {
      doll(a, a.sprite);
      continue;
    }
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
      add(ids.leg, part);
    }

    // Torso leans from the hips.
    torso.set(root);
    translate(torso, 0, 0.72, 0);
    rotateX(torso, lean);
    add(ids.torso, torso, shirt);

    // Arms hang from the shoulders; the right hand carries a tool while working.
    for (const side of [-1, 1]) {
      limb.set(torso);
      translate(limb, side * 0.33, 0.56, 0);
      rotateX(limb, side < 0 ? armL : armR);
      add(ids.sleeve, limb, shirt);
      add(ids.hand, limb, skin);
      if (side > 0 && a.anim === Anim.Till) add(ids.hoe, limb);
      if (side > 0 && a.anim === Anim.Build) add(ids.hammer, limb);
    }

    // Head on the neck, with blinking eyes and a straw hat.
    head.set(torso);
    translate(head, 0, 0.6, 0);
    rotateY(head, headYaw);
    rotateX(head, headPitch);
    add(ids.head, head, skin);
    add(ids.hat, head);
    part.set(head);
    const blink = (t % 4.3) < 0.12 ? 0.15 : 1;
    add(ids.eyes, scale(translate(part, 0, 0.25, 0.212), 1, blink, 1));
  }
}
