import type { Catalog, Kind, Vec3 } from "./catalog.ts";
import { hash2 } from "./rng.ts";

/**
 * Nature's entries: everything the world starts with, written in the same formats agents author
 * (ADR 0002). Blocks, items and the ingredients of every look are Materials; plants, the farmer
 * and the animals are Designs of Parts; drops, growth and food are engine Relations. The engine
 * keeps only the vocabulary (zones, roles, patterns) and the species' behaviour (until V2).
 *
 * Designs stand on their first cell: (0.5, 0, 0.5) is the middle of the tile, on the ground.
 */

type Draft = { kind: Kind; name: string; description: string; content: unknown };
const entries: Draft[] = [];
const add = (kind: Kind, name: string, description: string, content: unknown) =>
  entries.push({ kind, name, description, content });

// ---------------------------------------------------------------- materials

const material = (
  name: string,
  form: "block" | "item" | "liquid",
  color: string,
  pattern: string,
  density: number,
  hardness: number,
  burns: boolean,
  description: string,
) => add("material", name, description, { form, color, pattern, density, hardness, burns });

// Blocks: the terrain and what villagers build with.
material("grass", "block", "#4a8a2a", "grass", 1.3, 1, false, "Meadow ground.");
material("dirt", "block", "#7a5232", "dirt", 1.3, 1, false, "Soil; piles into mounds.");
material("stone", "block", "#8a8a88", "stone", 2.6, 6, false, "Bedrock under the soil.");
material("farmland", "block", "#3c2414", "farmland", 1.2, 1, false, "Tilled soil for seeds.");
material("water", "liquid", "#2a6f8a", "plain", 1, 0, false, "Rivers, lakes and the sea.");
material("sand", "block", "#b8a272", "sand", 1.6, 1, false, "Beaches and riverbeds.");
material("gravel", "block", "#7a6f62", "cobble", 1.8, 2, false, "Loose stones under water.");
material("clay", "block", "#8a7c68", "dirt", 1.8, 2, false, "Riverbank clay; craft into bricks.");
material("log", "block", "#6b4a2c", "log", 0.7, 3, true, "Tree trunks; craft into planks.");
material("planks", "block", "#b08850", "planks", 0.6, 2, true, "Sawn wood for floors and walls.");
material("cobble", "block", "#77756f", "cobble", 2.4, 5, false, "Rough stone for walls and paths.");
material("brick", "block", "#a4523a", "bricks", 1.9, 5, false, "Fired clay bricks.");
material("thatch", "block", "#c9a85a", "thatch", 0.2, 1, true, "Bundled straw for roofs.");
material("tiles", "block", "#9a4a35", "tiles", 2, 4, false, "Fired roof tiles.");
material(
  "fieldstone",
  "block",
  "#72706d",
  "stone",
  2.7,
  6,
  false,
  "Weathered grey stone of boulders.",
);

// Things villagers carry: harvests, seeds, saplings, animal products and fish.
material("wheat", "item", "#e6c76f", "thatch", 0.3, 0.5, true, "Ripe grain; animals follow it.");
material("wheat seeds", "item", "#c8a46a", "plain", 0.7, 1, true, "Plant them on farmland.");
material("oak sapling", "item", "#517838", "leaves", 0.6, 0.5, true, "A young oak to plant.");
material("birch sapling", "item", "#7b9841", "leaves", 0.6, 0.5, true, "A young birch to plant.");
material("pine sapling", "item", "#346541", "leaves", 0.6, 0.5, true, "A young pine to plant.");
material("wool", "item", "#e4e0d6", "fleece", 0.2, 0.5, true, "Soft fleece from sheep.");
material("milk", "item", "#f4f1ea", "plain", 1.03, 0, false, "Fresh from a cow.");
material("egg", "item", "#e8d8bd", "plain", 1.05, 1, false, "Laid by a chicken.");
material("minnow", "item", "#616851", "plain", 1.05, 1, false, "A tiny river fish.");
material("trout", "item", "#616547", "plain", 1.05, 1, false, "A speckled river fish.");
material("perch", "item", "#7b883b", "plain", 1.05, 1, false, "A striped river fish.");
material("mackerel", "item", "#34616c", "plain", 1.05, 1, false, "A quick sea fish.");
material("cod", "item", "#7b6f5a", "plain", 1.05, 1, false, "A big sea fish.");

// What plants are made of. Softer materials bend more in the wind; leaves are lumpy.
material("bark", "item", "#6f5541", "log", 0.7, 3, true, "Rough brown bark of oaks and pines.");
material("birch bark", "item", "#e4e1d9", "plain", 0.7, 3, true, "Papery white bark.");
material("dark bark", "item", "#474141", "plain", 0.7, 3, true, "The black bands on birches.");
material("leaves", "item", "#517838", "leaves", 0.3, 0.2, true, "Broad green leaves.");
material("birch leaves", "item", "#7b9841", "leaves", 0.3, 0.2, true, "Light, bright leaves.");
material("pine needles", "item", "#346541", "leaves", 0.3, 0.3, true, "Dark evergreen needles.");
material("stem", "item", "#619441", "plain", 0.5, 0.3, true, "Green stalks of small plants.");
material("red petals", "item", "#e04741", "plain", 0.3, 0.1, true, "Poppy red.");
material("yellow petals", "item", "#f3d941", "plain", 0.3, 0.1, true, "Buttercup yellow.");
material("white petals", "item", "#f3f1e9", "plain", 0.3, 0.1, true, "Daisy white.");
material("purple petals", "item", "#a86cd9", "plain", 0.3, 0.1, true, "Violet purple.");
material("pink petals", "item", "#f3baca", "plain", 0.3, 0.1, true, "Water lily pink.");
material("reed", "item", "#94a05a", "plain", 0.4, 0.5, true, "Tall waterside grass.");
material("cattail", "item", "#755134", "fleece", 0.4, 0.3, true, "Brown seed heads on reeds.");
material("lily leaf", "item", "#4c8841", "plain", 0.5, 0.1, true, "Round leaves that float.");

// What villagers gather from plants with interact; each grows back into its plant when planted.
material("poppy", "item", "#e04741", "plain", 0.3, 0.1, true, "A picked poppy; plant it.");
material("buttercup", "item", "#f3d941", "plain", 0.3, 0.1, true, "A picked buttercup; plant it.");
material("daisy", "item", "#f3f1e9", "plain", 0.3, 0.1, true, "A picked daisy; plant it.");
material("violet", "item", "#a86cd9", "plain", 0.3, 0.1, true, "A picked violet; plant it.");
material("lily flower", "item", "#f3baca", "plain", 0.3, 0.1, true, "A water lily's bloom.");
material("berries", "item", "#7a2d4a", "plain", 1, 0.2, false, "Dark berries off a bush.");

// What villagers and animals are made of.
material("linen", "item", "#e8e2d4", "plain", 1.5, 0.5, true, "Woven cloth for shirts.");
material("skin", "item", "#e0b79a", "plain", 1.1, 0.5, false, "A villager's skin.");
material("denim", "item", "#414c65", "plain", 1.5, 0.5, true, "Sturdy blue cloth.");
material("leather", "item", "#5a412b", "plain", 0.9, 2, true, "Tanned hide for boots.");
material("straw", "item", "#d9bd75", "thatch", 0.2, 0.5, true, "Woven straw for hats.");
material("red cloth", "item", "#9e4134", "plain", 1.5, 0.5, true, "A bright red band.");
material("ink", "item", "#262630", "plain", 1, 0.5, false, "Near black, for eyes.");
material("cowhide", "item", "#e0dcd6", "plain", 1.1, 1, false, "A cow's white coat.");
material("dark hide", "item", "#413c38", "plain", 1.1, 1, false, "Dark faces, patches, hooves.");
material("snout", "item", "#ca9e9a", "plain", 1.1, 0.5, false, "A pink muzzle.");
material("horn", "item", "#d2cab7", "plain", 1.3, 4, false, "Pale curved horn.");
material("amber", "item", "#bab17b", "plain", 1, 0.5, false, "Golden sheep eyes.");
material("feathers", "item", "#edeae4", "plain", 0.1, 0.2, true, "White plumage.");
material("comb", "item", "#ca3b34", "plain", 1.1, 0.3, false, "A chicken's red comb.");
material("beak", "item", "#e0ac41", "plain", 1.2, 2, false, "Orange beaks and feet.");
material("duck feathers", "item", "#947b61", "plain", 0.1, 0.2, true, "Mottled brown.");
material("green feathers", "item", "#347b51", "plain", 0.1, 0.2, true, "A drake's green head.");

// ---------------------------------------------------------------- parts

add("part", "box", "A rectangular block of any size.", { shape: "box" });
add("part", "sphere", "A ball, stretched by its size.", { shape: "sphere" });
add("part", "cylinder", "A round post, stretched by its size.", { shape: "cylinder" });
add("part", "cone", "A point on a round base, stretched by its size.", { shape: "cone" });

// ---------------------------------------------------------------- designs

const r2 = (n: number) => Math.round(n * 1000) / 1000;
const v3 = (x: number, y: number, z: number): Vec3 => [r2(x), r2(y), r2(z)];
const part = (
  shape: string,
  mat: string,
  at: Vec3,
  size: Vec3,
  turn = 0,
  tilt = 0,
  role?: string,
) => ({
  part: shape,
  material: mat,
  at: v3(...at),
  size: v3(...size),
  turn: r2(turn),
  tilt: r2(tilt),
  ...(role ? { role } : {}),
});
const DEG = Math.PI / 180;
/** Center of a post of height `h` rising from `base`, leaning `tilt`° toward `turn`°. */
const lean = (base: Vec3, h: number, turn: number, tilt: number): Vec3 => {
  const s = Math.sin(tilt * DEG) * h / 2;
  return [
    base[0] + s * Math.sin(turn * DEG),
    base[1] + Math.cos(tilt * DEG) * h / 2,
    base[2] + s * Math.cos(turn * DEG),
  ];
};
/** A deterministic scatter for clumps of small plants. */
const scatter = (seed: number) => {
  let i = 0;
  return (lo: number, hi: number) => lo + hash2(seed, i++, 977) * (hi - lo);
};

add("design", "stone bench", "A low seat of stone with a plank top.", {
  blocks: { palette: { s: "stone" }, layers: [["s.s"]] },
  parts: [part("box", "planks", [1.5, 1.1, 0.5], [3, 0.2, 1])],
});

const TREE_GROUND = ["grass", "dirt"];

add("design", "oak", "A broad oak with a round crown.", {
  mark: "T",
  habitat: { on: TREE_GROUND, zones: ["forest"], share: 0.65 },
  parts: [
    part("cylinder", "bark", [0.5, 1.425, 0.5], [0.34, 2.85, 0.34]),
    part("cylinder", "bark", lean([0.5, 1.575, 0.5], 0.9, 57, 46), [0.13, 0.9, 0.13], 57, 46),
    part("cylinder", "bark", lean([0.5, 1.575, 0.5], 0.9, 195, 46), [0.13, 0.9, 0.13], 195, 46),
    part("sphere", "leaves", [0.5, 3.33, 0.5], [2.1, 1.8, 2.1]),
    part("sphere", "leaves", [1.25, 3.0, 0.65], [1.7, 1.45, 1.7]),
    part("sphere", "leaves", [-0.15, 3.15, 0.85], [1.8, 1.5, 1.8]),
    part("sphere", "leaves", [0.35, 2.95, -0.2], [1.6, 1.35, 1.6]),
    part("sphere", "leaves", [0.8, 3.5, 1.15], [1.5, 1.3, 1.5]),
  ],
});

add("design", "birch", "A slim white birch with a tall, light crown.", {
  mark: "T",
  habitat: { on: TREE_GROUND, zones: ["forest"], share: 0.35 },
  parts: [
    part("cylinder", "birch bark", [0.5, 1.85, 0.5], [0.2, 3.7, 0.2]),
    ...[0.42, 1.07, 1.72, 2.37, 3.02].map((y) =>
      part("cylinder", "dark bark", [0.5, y, 0.5], [0.25, 0.05, 0.25])
    ),
    part("sphere", "birch leaves", [0.5, 3.8, 0.5], [1.5, 1.95, 1.5]),
    part("sphere", "birch leaves", [0.95, 3.55, 0.6], [1.3, 1.7, 1.3]),
    part("sphere", "birch leaves", [0.2, 3.7, 0.85], [1.3, 1.7, 1.3]),
    part("sphere", "birch leaves", [0.45, 4.1, 0.1], [1.2, 1.6, 1.2]),
  ],
});

add("design", "pine", "A dark evergreen of stacked cones; it grows up high.", {
  mark: "A",
  habitat: { on: TREE_GROUND, zones: ["highland"] },
  parts: [
    part("cylinder", "bark", [0.5, 0.8, 0.5], [0.27, 1.6, 0.27]),
    ...[0, 1, 2, 3].map((i) => {
      const t = i / 4, h = 1.5 * (1 - t * 0.35), d = 2.5 * (1 - t * 0.75);
      return part("cone", "pine needles", [0.5, 1.1 + i * 0.85 + h / 2, 0.5], [d, h, d]);
    }),
  ],
});

add("design", "bush", "A round leafy shrub at the edges of woods.", {
  mark: "b",
  habitat: { on: ["grass"], zones: ["forest edge"] },
  parts: [
    part("sphere", "leaves", [0.5, 0.27, 0.5], [0.9, 0.72, 0.9]),
    part("sphere", "leaves", [0.72, 0.25, 0.62], [0.85, 0.68, 0.85]),
    part("sphere", "leaves", [0.3, 0.27, 0.35], [0.8, 0.64, 0.8]),
  ],
});

/** A patch of six flowers on thin stems. */
function flowers(seed: number, petals: string) {
  const r = scatter(seed);
  const parts = [];
  for (let i = 0; i < 6; i++) {
    const base: Vec3 = [0.5 + r(-0.35, 0.35), 0, 0.5 + r(-0.35, 0.35)];
    const h = r(0.22, 0.42), turn = r(0, 360), tilt = r(0, 11);
    parts.push(part("cylinder", "stem", lean(base, h, turn, tilt), [0.024, h, 0.024], turn, tilt));
    const top = lean(base, h * 2, turn, tilt);
    parts.push(part("box", petals, top, [0.07, 0.025, 0.07], (turn + 45) % 360, tilt));
  }
  return parts;
}

const MEADOW = { on: ["grass", "dirt"], zones: ["meadow"], share: 0.25 };
add("design", "poppies", "Red poppies in the meadow; they spread slowly.", {
  mark: "*",
  habitat: MEADOW,
  parts: flowers(1, "red petals"),
});
add("design", "buttercups", "Yellow buttercups; they spread slowly.", {
  mark: "*",
  habitat: MEADOW,
  parts: flowers(2, "yellow petals"),
});
add("design", "daisies", "White daisies; they spread slowly.", {
  mark: "*",
  habitat: MEADOW,
  parts: flowers(3, "white petals"),
});
add("design", "violets", "Purple violets; they spread slowly.", {
  mark: "*",
  habitat: MEADOW,
  parts: flowers(4, "purple petals"),
});

add("design", "reeds", "Tall reeds with cattails along the water's edge.", {
  mark: "|",
  habitat: { on: ["grass", "sand", "dirt", "gravel", "clay"], zones: ["shore"] },
  parts: (() => {
    const r = scatter(9), parts = [];
    for (let i = 0; i < 8; i++) {
      const base: Vec3 = [0.5 + r(-0.3, 0.3), 0, 0.5 + r(-0.3, 0.3)];
      const h = r(0.7, 1.3), turn = r(0, 360), tilt = r(0, 7);
      parts.push(part("cone", "reed", lean(base, h, turn, tilt), [0.07, h, 0.07], turn, tilt));
      if (i % 3 === 1) {
        const head = lean(base, h * 1.2 + 0.16, turn, tilt);
        parts.push(part("cylinder", "cattail", head, [0.08, 0.16, 0.08], turn, tilt));
      }
    }
    return parts;
  })(),
});

add("design", "rock", "A mossy boulder of stone; it blocks the way.", {
  mark: "o",
  habitat: {
    on: ["grass", "sand", "dirt", "gravel", "stone"],
    zones: ["slope", "scattered", "riverbed"],
  },
  parts: [part("sphere", "fieldstone", [0.5, 0.125, 0.5], [1.0, 0.6, 0.85])],
});

/** Round leaves floating in a cluster. */
function pads(seed: number) {
  const r = scatter(seed);
  return [0, 1, 2].map(() =>
    part("cylinder", "lily leaf", [0.5 + r(-0.3, 0.3), 0.01, 0.5 + r(-0.3, 0.3)], [0.4, 0.02, 0.4])
  );
}
const SHALLOWS = { on: ["sand", "gravel", "clay", "dirt"], zones: ["shallows"], share: 0.5 };
add("design", "lily pads", "Floating leaves on calm shallow water.", {
  mark: "%",
  habitat: SHALLOWS,
  parts: pads(11),
});
add("design", "water lily", "Lily pads with a pink flower.", {
  mark: "%",
  habitat: SHALLOWS,
  parts: (() => {
    const p = pads(12);
    const [x, , z] = p[0].at;
    return [...p, part("sphere", "pink petals", [x, 0.05, z], [0.14, 0.09, 0.14])];
  })(),
});

add("design", "wheat crop", "Wheat growing on farmland; ripe ears show the wheat's color.", {
  mark: "W",
  look: "blades",
  habitat: { on: ["farmland"] },
  parts: (() => {
    const r = scatter(13), parts = [];
    for (let i = 0; i < 5; i++) {
      const base: Vec3 = [0.14 + i * 0.18, 0, 0.5 + r(-0.2, 0.2)];
      const turn = r(0, 360), tilt = r(0, 6);
      parts.push(
        part("cylinder", "stem", lean(base, 0.8, turn, tilt), [0.03, 0.8, 0.03], turn, tilt),
      );
      parts.push(
        part("sphere", "wheat", lean(base, 1.75, turn, tilt), [0.07, 0.2, 0.07], turn, tilt),
      );
    }
    return parts;
  })(),
});

// Bodies: parts with roles, so the engine can walk, work and graze them.
const limb = (mat: string, x: number, y: number, z: number, size: Vec3, role: string) =>
  part("box", mat, [x, y, z], size, 0, 0, role);

add("design", "farmer", "The villager look: straw hat, linen shirt, denim and boots.", {
  parts: [
    limb("denim", 0.38, 0.39, 0.5, [0.2, 0.66, 0.22], "left leg"),
    limb("leather", 0.38, 0.06, 0.52, [0.21, 0.13, 0.27], "left leg"),
    limb("denim", 0.62, 0.39, 0.5, [0.2, 0.66, 0.22], "right leg"),
    limb("leather", 0.62, 0.06, 0.52, [0.21, 0.13, 0.27], "right leg"),
    limb("linen", 0.5, 1.02, 0.5, [0.5, 0.6, 0.3], "body"),
    limb("linen", 0.17, 1.02, 0.5, [0.16, 0.54, 0.16], "left arm"),
    part("sphere", "skin", [0.17, 0.68, 0.5], [0.16, 0.16, 0.16], 0, 0, "left arm"),
    limb("linen", 0.83, 1.02, 0.5, [0.16, 0.54, 0.16], "right arm"),
    part("sphere", "skin", [0.83, 0.68, 0.5], [0.16, 0.16, 0.16], 0, 0, "right arm"),
    limb("skin", 0.5, 1.54, 0.5, [0.42, 0.42, 0.42], "head"),
    limb("skin", 0.5, 1.5, 0.72, [0.07, 0.08, 0.06], "head"),
    part("cylinder", "straw", [0.5, 1.76, 0.5], [0.8, 0.04, 0.8], 0, 0, "head"),
    part("cylinder", "straw", [0.5, 1.88, 0.5], [0.46, 0.22, 0.46], 0, 0, "head"),
    part("cylinder", "red cloth", [0.5, 1.82, 0.5], [0.49, 0.06, 0.49], 0, 0, "head"),
    limb("ink", 0.4, 1.57, 0.712, [0.07, 0.09, 0.02], "eyes"),
    limb("ink", 0.6, 1.57, 0.712, [0.07, 0.09, 0.02], "eyes"),
  ],
  joints: {
    "left leg": [0.38, 0.72, 0.5],
    "right leg": [0.62, 0.72, 0.5],
    body: [0.5, 0.72, 0.5],
    "left arm": [0.17, 1.28, 0.5],
    "right arm": [0.83, 1.28, 0.5],
    head: [0.5, 1.32, 0.5],
    eyes: [0.5, 1.57, 0.71],
  },
});

/** Four legs: posts hanging from hips at (±dx, top, ±dz) around the middle of the tile. */
function legs(mat: string, dx: number, dz: number, top: number, len: number, w: number) {
  const parts = [], joints: Record<string, Vec3> = {};
  for (const [side, x] of [["left", -dx], ["right", dx]] as const) {
    for (const [end, z] of [["front", dz], ["back", -dz]] as const) {
      const role = `${end} ${side} leg`;
      parts.push(part("cylinder", mat, [0.5 + x, top - len / 2, 0.5 + z], [w, len, w], 0, 0, role));
      joints[role] = v3(0.5 + x, top, 0.5 + z);
    }
  }
  return { parts, joints };
}

const sheepLegs = legs("dark hide", 0.13, 0.22, 0.38, 0.36, 0.09);
add("design", "sheep", "A woolly sheep. Shear it for wool; it follows wheat.", {
  parts: [
    part("sphere", "wool", [0.5, 0.58, 0.5], [0.68, 0.61, 0.68], 0, 0, "product"),
    part("sphere", "wool", [0.5, 0.62, 0.7], [0.56, 0.5, 0.56], 0, 0, "product"),
    part("sphere", "wool", [0.5, 0.61, 0.3], [0.6, 0.54, 0.6], 0, 0, "product"),
    part("box", "dark hide", [0.5, 0.66, 1.0], [0.19, 0.22, 0.28], 0, 0, "head"),
    part("sphere", "wool", [0.5, 0.76, 0.92], [0.26, 0.16, 0.24], 0, 0, "head"),
    part("box", "dark hide", [0.37, 0.71, 0.94], [0.07, 0.04, 0.12], 90, 28.6, "head"),
    part("box", "dark hide", [0.63, 0.71, 0.94], [0.07, 0.04, 0.12], -90, 28.6, "head"),
    part("box", "amber", [0.42, 0.7, 1.08], [0.035, 0.035, 0.02], 0, 0, "head"),
    part("box", "amber", [0.58, 0.7, 1.08], [0.035, 0.035, 0.02], 0, 0, "head"),
    ...sheepLegs.parts,
  ],
  joints: { product: [0.5, 0.58, 0.5], head: [0.5, 0.66, 0.88], ...sheepLegs.joints },
});

const cowLegs = legs("cowhide", 0.2, 0.42, 0.62, 0.6, 0.14);
add("design", "cow", "A spotted cow. Milk it; it follows wheat.", {
  parts: [
    part("box", "cowhide", [0.5, 0.9, 0.5], [0.62, 0.6, 1.2], 0, 0, "body"),
    part("sphere", "dark hide", [0.8, 0.95, 0.7], [0.1, 0.4, 0.4], 0, 0, "body"),
    part("sphere", "dark hide", [0.2, 0.88, 0.25], [0.12, 0.48, 0.48], 0, 0, "body"),
    part("sphere", "dark hide", [0.78, 1.0, 0.15], [0.075, 0.3, 0.3], 0, 0, "body"),
    part("sphere", "dark hide", [0.5, 1.2, 0.45], [0.44, 0.09, 0.44], 0, 0, "body"),
    part(
      "cylinder",
      "cowhide",
      lean([0.5, 1.1, -0.1], 0.6, 0, -154.7),
      [0.05, 0.6, 0.05],
      0,
      -154.7,
      "body",
    ),
    part("box", "cowhide", [0.5, 1.05, 1.3], [0.32, 0.34, 0.42], 0, 0, "head"),
    part("box", "snout", [0.5, 0.98, 1.52], [0.3, 0.2, 0.12], 0, 0, "head"),
    part("cone", "horn", lean([0.63, 1.2, 1.22], 0.18, 90, 63), [0.08, 0.18, 0.08], 90, 63, "head"),
    part(
      "cone",
      "horn",
      lean([0.37, 1.2, 1.22], 0.18, -90, 63),
      [0.08, 0.18, 0.08],
      -90,
      63,
      "head",
    ),
    part("box", "dark hide", [0.71, 1.12, 1.2], [0.08, 0.05, 0.14], -90, 22.9, "head"),
    part("box", "dark hide", [0.29, 1.12, 1.2], [0.08, 0.05, 0.14], 90, 22.9, "head"),
    part("box", "ink", [0.6, 1.11, 1.51], [0.04, 0.04, 0.02], 0, 0, "head"),
    part("box", "ink", [0.4, 1.11, 1.51], [0.04, 0.04, 0.02], 0, 0, "head"),
    ...cowLegs.parts,
    ...[-0.2, 0.2].flatMap((x) =>
      [0.42, -0.42].map((z) => {
        const role = `${z > 0 ? "front" : "back"} ${x < 0 ? "left" : "right"} leg`;
        return part(
          "cylinder",
          "dark hide",
          [0.5 + x, 0.05, 0.5 + z],
          [0.16, 0.1, 0.16],
          0,
          0,
          role,
        );
      })
    ),
  ],
  joints: { head: [0.5, 1.05, 1.12], ...cowLegs.joints },
});

add("design", "chicken", "A clucking chicken. Collect its eggs; it follows wheat.", {
  parts: [
    part("sphere", "feathers", [0.5, 0.27, 0.5], [0.3, 0.28, 0.38], 0, 0, "body"),
    part("box", "feathers", [0.5, 0.35, 0.33], [0.12, 0.16, 0.05], 0, -34.4, "body"),
    part("sphere", "feathers", [0.5, 0.42, 0.67], [0.15, 0.17, 0.15], 0, 0, "head"),
    part("box", "comb", [0.5, 0.51, 0.67], [0.025, 0.06, 0.09], 0, 0, "head"),
    part("box", "comb", [0.5, 0.36, 0.74], [0.025, 0.05, 0.025], 0, 0, "head"),
    part("cone", "beak", [0.5, 0.41, 0.755], [0.05, 0.07, 0.05], 0, 90, "head"),
    part("box", "ink", [0.435, 0.44, 0.7], [0.015, 0.02, 0.02], 0, 0, "head"),
    part("box", "ink", [0.565, 0.44, 0.7], [0.015, 0.02, 0.02], 0, 0, "head"),
    part("cylinder", "beak", [0.45, 0.085, 0.5], [0.026, 0.17, 0.026], 0, 0, "left leg"),
    part("cylinder", "beak", [0.55, 0.085, 0.5], [0.026, 0.17, 0.026], 0, 0, "right leg"),
  ],
  joints: {
    head: [0.5, 0.36, 0.64],
    "left leg": [0.45, 0.17, 0.5],
    "right leg": [0.55, 0.17, 0.5],
  },
});

add("design", "duck", "A duck paddling on calm water.", {
  parts: [
    part("sphere", "duck feathers", [0.5, 0.04, 0.5], [0.28, 0.22, 0.46], 0, 0, "body"),
    part("box", "duck feathers", [0.5, 0.11, 0.29], [0.1, 0.04, 0.1], 0, -28.6, "body"),
    part("cylinder", "feathers", [0.5, 0.13, 0.66], [0.085, 0.1, 0.085], 0, 0, "head"),
    part("sphere", "green feathers", [0.5, 0.22, 0.68], [0.14, 0.14, 0.16], 0, 0, "head"),
    part("box", "beak", [0.5, 0.2, 0.77], [0.06, 0.025, 0.08], 0, 0, "head"),
    part("box", "ink", [0.44, 0.24, 0.71], [0.015, 0.02, 0.02], 0, 0, "head"),
    part("box", "ink", [0.56, 0.24, 0.71], [0.015, 0.02, 0.02], 0, 0, "head"),
  ],
  joints: { head: [0.5, 0.16, 0.66] },
});

// ---------------------------------------------------------------- relations

const rel = (from: string, type: string, to: string, count = 1, hours?: number) =>
  add("relation", "", "", { type, from, to, count, ...(hours ? { hours } : {}) });

rel("planks", "made_from", "log", 4);
rel("cobble", "made_from", "stone");
rel("brick", "made_from", "clay");
rel("tiles", "made_from", "clay");
rel("grass", "drops", "dirt");
rel("farmland", "drops", "dirt");
rel("wheat seeds", "grows_into", "wheat crop", 1, 18);
rel("wheat crop", "drops", "wheat");
rel("wheat crop", "drops", "wheat seeds", 2);
for (const tree of ["oak", "birch", "pine"]) {
  rel(`${tree} sapling`, "grows_into", tree, 1, 48);
  rel(tree, "drops", "log", 3);
  rel(tree, "drops", `${tree} sapling`);
}
rel("rock", "drops", "stone", 2);
// Picked plants give something to replant elsewhere.
for (
  const [plant, item] of [
    ["poppies", "poppy"],
    ["buttercups", "buttercup"],
    ["daisies", "daisy"],
    ["violets", "violet"],
  ]
) {
  rel(plant, "drops", item, 2);
  rel(item, "grows_into", plant, 1, 6);
}
rel("reeds", "drops", "reed", 2);
rel("reeds", "drops", "cattail");
rel("reed", "grows_into", "reeds", 1, 6);
rel("lily pads", "drops", "lily leaf", 2);
rel("lily leaf", "grows_into", "lily pads", 1, 6);
rel("water lily", "drops", "lily leaf");
rel("water lily", "drops", "lily flower");
rel("lily flower", "grows_into", "water lily", 1, 12);
rel("bush", "drops", "berries", 3);
rel("berries", "grows_into", "bush", 1, 24);
rel("berries", "is_food_for", "chicken");
rel("sheep", "drops", "wool");
rel("cow", "drops", "milk");
rel("chicken", "drops", "egg");
for (const animal of ["sheep", "cow", "chicken"]) rel("wheat", "is_food_for", animal);

// ---------------------------------------------------------------- rules

add("rule", "lucky harvest", "Now and then a wheat harvest gives back an extra seed.", {
  when: { event: "harvested", what: "wheat" },
  if: { chance: 0.1 },
  do: [{ give: { item: "wheat seeds", count: 1 } }],
});
add("rule", "dawn chorus", "Birds greet the morning when the sky is clear.", {
  when: { daily: 6 },
  if: { clouds_below: 0.5 },
  do: [{ say: "Birdsong drifts over the meadow." }],
});
add(
  "rule",
  "wildflowers spread",
  "Poppies, buttercups, daisies and violets slowly claim neighbouring grass.",
  {
    when: { every: 60 },
    do: [
      { spread: { what: "poppies", count: 1 } },
      { spread: { what: "buttercups", count: 1 } },
      { spread: { what: "daisies", count: 1 } },
      { spread: { what: "violets", count: 1 } },
    ],
  },
);

/** Add nature's entries to a new Catalog. */
export function seedNature(c: Catalog) {
  for (const e of entries) c.add(e, "nature", 0);
}
