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
  glows = 0,
) =>
  add("material", name, description, {
    form,
    color,
    pattern,
    density,
    hardness,
    burns,
    ...(glows ? { glows } : {}),
  });

// Blocks: the terrain and what villagers build with.
material("grass", "block", "#5c8c38", "grass", 1.3, 1, false, "Meadow ground.");
material("dirt", "block", "#7b5638", "dirt", 1.3, 1, false, "Soil; piles into mounds.");
material("stone", "block", "#8d887e", "stone", 2.6, 6, false, "Bedrock under the soil.");
material("farmland", "block", "#422717", "farmland", 1.2, 1, false, "Tilled soil for seeds.");
material("water", "liquid", "#2a7490", "plain", 1, 0, false, "Rivers, lakes and the sea.");
material("sand", "block", "#cbb686", "sand", 1.6, 1, false, "Beaches and riverbeds.");
material("gravel", "block", "#807568", "cobble", 1.8, 2, false, "Loose stones under water.");
material("clay", "block", "#8f806c", "dirt", 1.8, 2, false, "Riverbank clay; craft into bricks.");
material("log", "block", "#6b492d", "log", 0.7, 3, true, "Tree trunks; craft into planks.");
material("planks", "block", "#b68952", "planks", 0.6, 2, true, "Sawn wood for floors and walls.");
material("cobble", "block", "#7e796e", "cobble", 2.4, 5, false, "Rough stone for walls and paths.");
material("brick", "block", "#a4523a", "bricks", 1.9, 5, false, "Fired clay bricks.");
material("thatch", "block", "#cfa95c", "thatch", 0.2, 1, true, "Bundled straw for roofs.");
material("tiles", "block", "#9e4d37", "tiles", 2, 4, false, "Fired roof tiles.");
material(
  "fieldstone",
  "block",
  "#858176",
  "stone",
  2.7,
  6,
  false,
  "Weathered warm stone of boulders.",
);

// Things villagers carry: harvests, seeds, saplings, animal products and fish.
material("wheat", "item", "#e8c86e", "thatch", 0.3, 0.5, true, "Ripe grain; animals follow it.");
material("wheat seeds", "item", "#c8a46a", "plain", 0.7, 1, true, "Plant them on farmland.");
material("oak sapling", "item", "#5a863a", "leaves", 0.6, 0.5, true, "A young oak to plant.");
material(
  "birch sapling",
  "item",
  "#d88aa4",
  "leaves",
  0.6,
  0.5,
  true,
  "A young blossom birch to plant.",
);
material("pine sapling", "item", "#305d4b", "leaves", 0.6, 0.5, true, "A young pine to plant.");
material("wool", "item", "#ece6dc", "fleece", 0.2, 0.5, true, "Soft fleece from sheep.");
material("milk", "item", "#f4f1ea", "plain", 1.03, 0, false, "Fresh from a cow.");
material("egg", "item", "#e8d8bd", "plain", 1.05, 1, false, "Laid by a chicken.");
material("minnow", "item", "#616851", "plain", 1.05, 1, false, "A tiny river fish.");
material("trout", "item", "#616547", "plain", 1.05, 1, false, "A speckled river fish.");
material("perch", "item", "#7b883b", "plain", 1.05, 1, false, "A striped river fish.");
material("mackerel", "item", "#34616c", "plain", 1.05, 1, false, "A quick sea fish.");
material("cod", "item", "#7b6f5a", "plain", 1.05, 1, false, "A big sea fish.");

// What plants are made of. Softer materials bend more in the wind; leaves are lumpy.
material("bark", "item", "#6a472d", "log", 0.7, 3, true, "Warm brown bark of oaks and pines.");
material("birch bark", "item", "#dfd5c4", "log", 0.7, 3, true, "Warm cream papery bark.");
material("dark bark", "item", "#544842", "plain", 0.7, 3, true, "The dark bands on birches.");
material("leaves", "item", "#5a863a", "leaves", 0.3, 0.2, true, "Lush botanical oak leaves.");
material(
  "birch leaves",
  "item",
  "#d88aa4",
  "leaves",
  0.3,
  0.2,
  true,
  "Soft rose-blossom birch leaves.",
);
material("pine needles", "item", "#305d4b", "leaves", 0.3, 0.3, true, "Deep spruce-teal needles.");
material("stem", "item", "#6e9942", "plain", 0.5, 0.3, true, "Green stalks of small plants.");
material("red petals", "item", "#e2524c", "plain", 0.3, 0.1, true, "Poppy red.");
material("yellow petals", "item", "#f5d752", "plain", 0.3, 0.1, true, "Buttercup yellow.");
material("white petals", "item", "#f6f2e8", "plain", 0.3, 0.1, true, "Daisy white.");
material("purple petals", "item", "#ae7ad8", "plain", 0.3, 0.1, true, "Violet purple.");
material("pink petals", "item", "#f4b2c4", "plain", 0.3, 0.1, true, "Blossom pink.");
material("reed", "item", "#9aa65c", "plain", 0.4, 0.5, true, "Tall waterside grass.");
material("cattail", "item", "#785336", "fleece", 0.4, 0.3, true, "Brown seed heads on reeds.");
material("lily leaf", "item", "#4e8b46", "plain", 0.5, 0.1, true, "Round leaves that float.");

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
// Joints: a pin along its length (a slider's rail) joining two pieces of a Design.
add("part", "hinge", "A pin two pieces swing about, between limits: doors, gates, lids.", {
  shape: "cylinder",
  joint: "hinge",
});
add("part", "axle", "A pin a piece spins freely on: wheels, rollers, weathervanes.", {
  shape: "cylinder",
  joint: "axle",
});
add("part", "slider", "A rail a piece slides along, between limits: drawers, sliding doors.", {
  shape: "box",
  joint: "slider",
});
add("part", "motor", "An axle that turns itself while it's switched on: sails, mills, carts.", {
  shape: "cylinder",
  joint: "motor",
});

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

/** A joint part: a pin of `mat` at `at`, `size` long, joining two pieces. */
const joint = (
  kind: string,
  mat: string,
  at: Vec3,
  size: Vec3,
  joins: [string, string],
  extra: Record<string, unknown> = {},
  turn = 0,
  tilt = 0,
) => ({ ...part(kind, mat, at, size, turn, tilt), joins, ...extra });
const piece = (p: ReturnType<typeof part>, name: string) => ({ ...p, piece: name });

// Worked examples of joints. The gate hangs at the north edge of its tile and swings north, clear
// of the gateway, so the way through is open once it's open.
add("design", "garden gate", "A plank gate between two posts. use it to open and shut.", {
  anchored: true,
  parts: [
    part("box", "planks", [0.9, 0.6, 0.1], [0.16, 1.2, 0.16]),
    part("box", "planks", [2.1, 0.6, 0.1], [0.16, 1.2, 0.16]),
    piece(part("box", "planks", [1.5, 0.55, 0.1], [0.9, 0.85, 0.06]), "gate"),
    joint("hinge", "planks", [1.02, 0.55, 0.1], [0.05, 0.85, 0.05], ["main", "gate"], {
      limits: [0, 95],
    }),
  ],
});
const wheels = [[0.45, 0.04], [0.45, 0.96], [1.55, 0.04], [1.55, 0.96]].flatMap(([x, z], i) => [
  piece(part("cylinder", "planks", [x, 0.28, z], [0.56, 0.07, 0.56], 0, 90), `wheel ${i + 1}`),
  joint(
    "axle",
    "planks",
    [x, 0.28, 0.5 + (z - 0.5) * 0.85],
    [0.05, 0.12, 0.05],
    [
      "main",
      `wheel ${i + 1}`,
    ],
    {},
    0,
    90,
  ),
]);
add("design", "hand cart", "A plank bed on four wheels: put things on it and push it along.", {
  parts: [
    part("box", "planks", [1, 0.5, 0.5], [1.7, 0.08, 0.84]),
    part("box", "planks", [0.45, 0.36, 0.5], [0.08, 0.2, 0.76]),
    part("box", "planks", [1.55, 0.36, 0.5], [0.08, 0.2, 0.76]),
    ...wheels,
  ],
});
const sails = [0, 90, 180, -90].map((t) =>
  piece(
    part(
      "box",
      "planks",
      [0.5 + 0.85 * Math.sin(t * DEG), 3.6 + 0.85 * Math.cos(t * DEG), -0.22],
      [0.04, 1.3, 0.32],
      90,
      t,
    ),
    "sails",
  )
);
add("design", "windmill", "A post mill whose sails turn on a motor. use it to start or stop.", {
  anchored: true,
  parts: [
    part("box", "planks", [0.5, 2, 0.5], [0.8, 4, 0.8]),
    part("cone", "thatch", [0.5, 4.3, 0.5], [1.1, 0.6, 1.1]),
    piece(part("cylinder", "planks", [0.5, 3.6, -0.18], [0.3, 0.12, 0.3], 0, 90), "sails"),
    ...sails,
    joint(
      "motor",
      "planks",
      [0.5, 3.6, -0.02],
      [0.08, 0.2, 0.08],
      ["main", "sails"],
      {
        speed: 45,
      },
      0,
      90,
    ),
  ],
});

const TREE_GROUND = ["grass", "dirt"];

add("design", "oak", "A broad painterly miniature oak with clustered foliage and a sturdy trunk.", {
  mark: "T",
  habitat: { on: TREE_GROUND, zones: ["forest"], share: 0.65 },
  parts: [
    // Flared root buttress & sturdy carved trunk (part 0 stays bark cone for grain consistency).
    part("cone", "bark", [0.5, 0.14, 0.5], [0.76, 0.38, 0.76]),
    part("cylinder", "bark", [0.5, 1.32, 0.5], [0.42, 2.55, 0.42]),
    part("cylinder", "bark", lean([0.5, 1.5, 0.5], 1.0, 52, 44), [0.16, 1.0, 0.16], 52, 44),
    part("cylinder", "bark", lean([0.5, 1.55, 0.5], 0.95, 188, 45), [0.15, 0.95, 0.15], 188, 45),
    part("cylinder", "bark", lean([0.5, 1.72, 0.5], 0.9, 308, 40), [0.14, 0.9, 0.14], 308, 40),
    // Deep cool-teal shaded lower bough clusters (mockup 01/02/06).
    part("box", "pine needles", [0.15, 2.48, 0.25], [1.15, 0.85, 1.1], 14),
    part("box", "pine needles", [0.95, 2.45, 0.78], [1.1, 0.82, 1.05], -18),
    part("sphere", "pine needles", [-0.28, 2.55, 0.82], [1.15, 0.95, 1.1]),
    // Sculpted rounded-voxel & tufted botanical mid-crown.
    part("box", "leaves", [0.5, 3.05, 0.5], [1.55, 1.25, 1.55], 8),
    part("box", "leaves", [1.18, 2.95, 0.32], [1.22, 1.02, 1.18], 26),
    part("box", "leaves", [-0.15, 3.0, 0.65], [1.25, 1.05, 1.2], -22),
    part("box", "leaves", [0.32, 2.86, -0.22], [1.18, 0.96, 1.14], 38),
    part("sphere", "leaves", [0.85, 3.38, 0.98], [1.28, 1.08, 1.24]),
    part("sphere", "leaves", [0.12, 3.45, 0.12], [1.22, 1.04, 1.2]),
    // Sunlit warm golden-olive upper crown tufts.
    part("box", "leaves", [0.55, 3.85, 0.52], [1.15, 0.9, 1.15], 18),
    part("sphere", "leaves", [0.95, 3.72, 0.22], [0.92, 0.78, 0.92]),
    part("sphere", "leaves", [0.18, 3.88, 0.86], [0.88, 0.76, 0.88]),
    // Tiny warm golden blossom buds tucked into the crown.
    part("sphere", "yellow petals", [0.92, 3.45, 1.32], [0.11, 0.11, 0.11]),
    part("sphere", "yellow petals", [-0.28, 3.18, 0.95], [0.1, 0.1, 0.1]),
  ],
});

add("design", "birch", "A storybook cream-bark birch crowned with soft rose blossoms.", {
  mark: "T",
  habitat: { on: TREE_GROUND, zones: ["forest"], share: 0.35 },
  parts: [
    part("cone", "birch bark", [0.5, 0.11, 0.5], [0.46, 0.3, 0.46]),
    part("cylinder", "birch bark", [0.5, 1.65, 0.5], [0.26, 3.25, 0.26]),
    ...[0.46, 1.08, 1.68, 2.28, 2.84].map((y) =>
      part("cylinder", "dark bark", [0.5, y, 0.5], [0.29, 0.055, 0.29])
    ),
    part(
      "cylinder",
      "birch bark",
      lean([0.5, 2.35, 0.5], 0.78, 38, 38),
      [0.09, 0.78, 0.09],
      38,
      38,
    ),
    part(
      "cylinder",
      "birch bark",
      lean([0.5, 2.55, 0.5], 0.72, 215, 42),
      [0.09, 0.72, 0.09],
      215,
      42,
    ),
    // Soft tucked-in rose-mauve under-blossoms (mockup 01/02/03 top-center tree!).
    part("sphere", "birch leaves", [0.16, 2.94, 0.28], [1.05, 0.84, 1.02]),
    part("sphere", "birch leaves", [0.9, 2.88, 0.68], [0.98, 0.8, 0.98]),
    // Rounded-voxel & fluffy rose-blossom main canopy.
    part("box", "birch leaves", [0.5, 3.45, 0.5], [1.42, 1.18, 1.42], 12),
    part("box", "birch leaves", [1.02, 3.25, 0.52], [1.1, 0.95, 1.08], -20),
    part("box", "birch leaves", [-0.04, 3.32, 0.74], [1.08, 0.94, 1.1], 28),
    part("sphere", "birch leaves", [0.42, 3.72, -0.05], [1.14, 1.0, 1.12]),
    part("sphere", "birch leaves", [0.55, 4.18, 0.52], [1.04, 0.88, 1.04]),
    // Sunlit pale-pink petal highlights crowning the top.
    part("sphere", "pink petals", [0.78, 3.92, 0.82], [0.78, 0.68, 0.78]),
    part("sphere", "pink petals", [0.22, 3.98, 0.35], [0.74, 0.64, 0.74]),
  ],
});

add("design", "pine", "A tiered miniature spruce-teal evergreen with mossy sunlit tips.", {
  mark: "A",
  habitat: { on: TREE_GROUND, zones: ["highland"] },
  parts: [
    part("cone", "bark", [0.5, 0.12, 0.5], [0.54, 0.3, 0.54]),
    part("cylinder", "bark", [0.5, 0.85, 0.5], [0.32, 1.65, 0.32]),
    // Tiered sculpted evergreen cones + rounded botanical bough pads.
    ...[0, 1, 2, 3, 4].map((i) => {
      const t = i / 5, h = 1.48 * (1 - t * 0.32), d = 2.45 * (1 - t * 0.72);
      return part("cone", "pine needles", [0.5, 1.05 + i * 0.68 + h / 2, 0.5], [d, h, d], i * 33);
    }),
    part("box", "pine needles", [0.5, 1.68, 0.5], [1.55, 0.52, 1.55], 18),
    part("box", "leaves", [0.5, 2.55, 0.5], [1.22, 0.48, 1.22], 42),
    part("box", "leaves", [0.5, 3.45, 0.5], [0.88, 0.42, 0.88], 12),
    part("cone", "leaves", [0.5, 4.65, 0.5], [0.42, 0.65, 0.42]),
    part("sphere", "cattail", [0.62, 1.95, 0.92], [0.11, 0.14, 0.11]),
    part("sphere", "cattail", [0.28, 2.75, 0.36], [0.11, 0.14, 0.11]),
  ],
});

add("design", "bush", "A compact flowering miniature shrub at the edges of woods.", {
  mark: "b",
  habitat: { on: ["grass"], zones: ["forest edge"] },
  parts: [
    part("cylinder", "cattail", lean([0.5, 0, 0.5], 0.24, 30, 22), [0.045, 0.24, 0.045], 30, 22),
    part("cylinder", "cattail", lean([0.5, 0, 0.5], 0.22, 165, 24), [0.045, 0.22, 0.045], 165, 24),
    part("box", "pine needles", [0.5, 0.2, 0.5], [0.64, 0.36, 0.62], 16),
    part("sphere", "leaves", [0.64, 0.28, 0.58], [0.5, 0.42, 0.48]),
    part("sphere", "leaves", [0.34, 0.26, 0.42], [0.48, 0.4, 0.48]),
    part("box", "leaves", [0.5, 0.4, 0.5], [0.44, 0.32, 0.44], 34),
    part("sphere", "berries", [0.62, 0.38, 0.72], [0.075, 0.075, 0.075]),
    part("sphere", "berries", [0.32, 0.34, 0.56], [0.075, 0.075, 0.075]),
    part("sphere", "yellow petals", [0.46, 0.53, 0.44], [0.09, 0.08, 0.09]),
    part("sphere", "pink petals", [0.68, 0.44, 0.48], [0.085, 0.075, 0.085]),
    part("sphere", "pink petals", [0.36, 0.45, 0.64], [0.08, 0.07, 0.08]),
  ],
});

/** A patch of six plump miniature wildflowers. */
function flowers(seed: number, petals: string) {
  const r = scatter(seed);
  const parts = [];
  for (let i = 0; i < 6; i++) {
    const base: Vec3 = [0.5 + r(-0.34, 0.34), 0, 0.5 + r(-0.34, 0.34)];
    const h = r(0.18, 0.34), turn = r(0, 360), tilt = r(0, 12);
    parts.push(part("cylinder", "stem", lean(base, h, turn, tilt), [0.028, h, 0.028], turn, tilt));
    const top = lean(base, h * 2, turn, tilt);
    parts.push(part("sphere", petals, top, [0.1, 0.07, 0.1], (turn + 45) % 360, tilt));
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

add("design", "rock", "A hand-carved mossy diorama boulder; it blocks the way.", {
  mark: "o",
  habitat: {
    on: ["grass", "sand", "dirt", "gravel", "stone"],
    zones: ["slope", "scattered", "riverbed"],
  },
  parts: [
    part("box", "fieldstone", [0.5, 0.2, 0.5], [0.84, 0.44, 0.72], 14),
    part("sphere", "fieldstone", [0.24, 0.14, 0.54], [0.52, 0.34, 0.48]),
    part("box", "fieldstone", [0.72, 0.11, 0.66], [0.46, 0.26, 0.42], -22),
    part("sphere", "leaves", [0.44, 0.42, 0.46], [0.52, 0.18, 0.46]),
    part("sphere", "leaves", [0.68, 0.34, 0.6], [0.34, 0.14, 0.32]),
  ],
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
    limb("leather", 0.38, 0.02, 0.56, [0.22, 0.05, 0.32], "left leg"),
    limb("denim", 0.62, 0.39, 0.5, [0.2, 0.66, 0.22], "right leg"),
    limb("leather", 0.62, 0.06, 0.52, [0.21, 0.13, 0.27], "right leg"),
    limb("leather", 0.62, 0.02, 0.56, [0.22, 0.05, 0.32], "right leg"),
    limb("linen", 0.5, 1.02, 0.5, [0.5, 0.6, 0.3], "body"),
    limb("leather", 0.5, 0.74, 0.5, [0.52, 0.09, 0.32], "body"),
    limb("leather", 0.5, 1.06, 0.66, [0.09, 0.18, 0.03], "body"),
    limb("linen", 0.17, 1.02, 0.5, [0.16, 0.54, 0.16], "left arm"),
    part("sphere", "skin", [0.17, 0.68, 0.5], [0.16, 0.16, 0.16], 0, 0, "left arm"),
    limb("linen", 0.83, 1.02, 0.5, [0.16, 0.54, 0.16], "right arm"),
    part("sphere", "skin", [0.83, 0.68, 0.5], [0.16, 0.16, 0.16], 0, 0, "right arm"),
    part("sphere", "skin", [0.5, 1.54, 0.5], [0.42, 0.42, 0.42], 0, 0, "head"),
    part("sphere", "skin", [0.5, 1.5, 0.71], [0.1, 0.09, 0.08], 0, 0, "head"),
    part("sphere", "skin", [0.29, 1.54, 0.5], [0.07, 0.09, 0.07], 0, 0, "head"),
    part("sphere", "skin", [0.71, 1.54, 0.5], [0.07, 0.09, 0.07], 0, 0, "head"),
    part("box", "leather", [0.5, 1.62, 0.29], [0.34, 0.22, 0.16], 0, 0, "head"),
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

const sheepLegs = legs("dark hide", 0.14, 0.2, 0.24, 0.22, 0.11);
add("design", "sheep", "A plush woolly sheep. Shear it for wool; it follows wheat.", {
  parts: [
    part("sphere", "dark hide", [0.5, 0.44, 0.5], [0.52, 0.44, 0.54], 0, 0, "body"),
    // Plush multi-puff cloud of wool around the chunky body.
    part("sphere", "wool", [0.5, 0.48, 0.5], [0.7, 0.58, 0.72], 0, 0, "product"),
    part("sphere", "wool", [0.5, 0.54, 0.72], [0.56, 0.48, 0.5], 0, 0, "product"),
    part("sphere", "wool", [0.5, 0.52, 0.28], [0.58, 0.5, 0.52], 0, 0, "product"),
    part("sphere", "wool", [0.5, 0.66, 0.5], [0.54, 0.36, 0.56], 0, 0, "product"),
    part("sphere", "wool", [0.24, 0.5, 0.52], [0.36, 0.38, 0.46], 0, 0, "product"),
    part("sphere", "wool", [0.76, 0.5, 0.52], [0.36, 0.38, 0.46], 0, 0, "product"),
    part("sphere", "wool", [0.5, 0.48, 0.1], [0.28, 0.26, 0.26], 0, 0, "tail"),
    // Cozy rounded warm-grey face with wool crown puff and gentle bead eyes.
    part("sphere", "dark hide", [0.5, 0.49, 0.92], [0.3, 0.28, 0.28], 0, 0, "head"),
    part("sphere", "wool", [0.5, 0.63, 0.87], [0.32, 0.18, 0.28], 0, 0, "head"),
    part("sphere", "dark hide", [0.32, 0.53, 0.88], [0.12, 0.08, 0.14], 25, 25, "head"),
    part("sphere", "dark hide", [0.68, 0.53, 0.88], [0.12, 0.08, 0.14], -25, 25, "head"),
    part("sphere", "ink", [0.41, 0.5, 1.05], [0.045, 0.032, 0.03], 0, 0, "head"),
    part("sphere", "ink", [0.59, 0.5, 1.05], [0.045, 0.032, 0.03], 0, 0, "head"),
    part("sphere", "snout", [0.5, 0.44, 1.06], [0.08, 0.05, 0.04], 0, 0, "head"),
    ...sheepLegs.parts,
  ],
  joints: {
    product: [0.5, 0.48, 0.5],
    head: [0.5, 0.5, 0.82],
    tail: [0.5, 0.48, 0.22],
    ...sheepLegs.joints,
  },
});

const cowLegs = legs("cowhide", 0.22, 0.34, 0.36, 0.34, 0.17);
add("design", "cow", "A chunky mossy-horned spotted cow. Milk it; it follows wheat.", {
  parts: [
    // Chunky rounded-blocky cream body with rich warm chestnut patches and mossy accents.
    part("box", "cowhide", [0.5, 0.68, 0.5], [0.72, 0.62, 0.98], 0, 0, "body"),
    part("sphere", "bark", [0.82, 0.72, 0.66], [0.14, 0.36, 0.38], 0, 0, "body"),
    part("sphere", "bark", [0.18, 0.68, 0.32], [0.14, 0.42, 0.44], 0, 0, "body"),
    part("sphere", "bark", [0.5, 0.98, 0.44], [0.52, 0.12, 0.44], 0, 0, "body"),
    part("sphere", "stem", [0.56, 1.01, 0.72], [0.22, 0.08, 0.2], 0, 0, "body"),
    part("sphere", "snout", [0.5, 0.38, 0.28], [0.22, 0.16, 0.22], 0, 0, "body"),
    part(
      "cylinder",
      "bark",
      lean([0.5, 0.76, -0.02], 0.38, 0, -148),
      [0.06, 0.38, 0.06],
      0,
      -148,
      "tail",
    ),
    part("sphere", "leather", [0.5, 0.44, -0.2], [0.1, 0.12, 0.1], 0, 0, "tail"),
    // Adorable boxy-plush head with wide rosy muzzle, sweet bead eyes, and curved mossy horns.
    part("box", "bark", [0.5, 0.78, 1.08], [0.54, 0.5, 0.48], 0, 0, "head"),
    part("box", "cowhide", [0.5, 0.88, 1.1], [0.34, 0.3, 0.46], 0, 0, "head"),
    part("box", "snout", [0.5, 0.66, 1.32], [0.46, 0.24, 0.22], 0, 0, "head"),
    part("cone", "horn", lean([0.74, 1.0, 1.05], 0.24, 80, 42), [0.12, 0.24, 0.12], 80, 42, "head"),
    part(
      "cone",
      "horn",
      lean([0.26, 1.0, 1.05], 0.24, -80, 42),
      [0.12, 0.24, 0.12],
      -80,
      42,
      "head",
    ),
    part("sphere", "stem", [0.82, 1.1, 1.06], [0.11, 0.09, 0.11], 0, 0, "head"),
    part("sphere", "stem", [0.18, 1.1, 1.06], [0.11, 0.09, 0.11], 0, 0, "head"),
    part("sphere", "bark", [0.82, 0.84, 1.04], [0.16, 0.09, 0.14], -25, 18, "head"),
    part("sphere", "bark", [0.18, 0.84, 1.04], [0.16, 0.09, 0.14], 25, 18, "head"),
    part("sphere", "ink", [0.64, 0.82, 1.33], [0.06, 0.075, 0.04], 0, 0, "head"),
    part("sphere", "ink", [0.36, 0.82, 1.33], [0.06, 0.075, 0.04], 0, 0, "head"),
    part("sphere", "ink", [0.42, 0.67, 1.44], [0.035, 0.04, 0.03], 0, 0, "head"),
    part("sphere", "ink", [0.58, 0.67, 1.44], [0.035, 0.04, 0.03], 0, 0, "head"),
    ...cowLegs.parts,
    ...[-0.22, 0.22].flatMap((x) =>
      [0.34, -0.34].map((z) => {
        const role = `${z > 0 ? "front" : "back"} ${x < 0 ? "left" : "right"} leg`;
        return part(
          "cylinder",
          "dark hide",
          [0.5 + x, 0.045, 0.5 + z],
          [0.18, 0.09, 0.18],
          0,
          0,
          role,
        );
      })
    ),
  ],
  joints: { head: [0.5, 0.78, 0.94], tail: [0.5, 0.76, 0.02], ...cowLegs.joints },
});

add("design", "chicken", "A plump miniature chicken. Collect its eggs; it follows wheat.", {
  parts: [
    // Chubby egg-shaped cream body sitting cozy on tiny orange feet.
    part("sphere", "feathers", [0.5, 0.26, 0.5], [0.44, 0.4, 0.48], 0, 0, "body"),
    part("sphere", "feathers", [0.3, 0.26, 0.48], [0.12, 0.22, 0.26], 0, 12, "body"),
    part("sphere", "feathers", [0.7, 0.26, 0.48], [0.12, 0.22, 0.26], 0, -12, "body"),
    part("sphere", "feathers", [0.5, 0.34, 0.26], [0.18, 0.18, 0.16], 0, -25, "body"),
    // Plump integrated head with 3-lobe red comb, cute beak, and shiny dark bead eyes.
    part("sphere", "feathers", [0.5, 0.41, 0.58], [0.32, 0.3, 0.3], 0, 0, "head"),
    part("sphere", "comb", [0.5, 0.57, 0.61], [0.08, 0.1, 0.09], 0, 0, "head"),
    part("sphere", "comb", [0.5, 0.56, 0.54], [0.075, 0.09, 0.08], 0, 0, "head"),
    part("sphere", "comb", [0.5, 0.53, 0.47], [0.065, 0.075, 0.075], 0, 0, "head"),
    part("cone", "beak", [0.5, 0.39, 0.75], [0.09, 0.1, 0.09], 0, 90, "head"),
    part("sphere", "ink", [0.39, 0.43, 0.71], [0.04, 0.045, 0.035], 0, 0, "head"),
    part("sphere", "ink", [0.61, 0.43, 0.71], [0.04, 0.045, 0.035], 0, 0, "head"),
    part("cylinder", "beak", [0.43, 0.055, 0.5], [0.035, 0.11, 0.035], 0, 0, "left leg"),
    part("cylinder", "beak", [0.57, 0.055, 0.5], [0.035, 0.11, 0.035], 0, 0, "right leg"),
    part("box", "beak", [0.43, 0.015, 0.54], [0.07, 0.025, 0.11], 0, 0, "left leg"),
    part("box", "beak", [0.57, 0.015, 0.54], [0.07, 0.025, 0.11], 0, 0, "right leg"),
  ],
  joints: {
    head: [0.5, 0.36, 0.56],
    "left leg": [0.43, 0.11, 0.5],
    "right leg": [0.57, 0.11, 0.5],
  },
});

add("design", "duck", "A duck paddling on calm water.", {
  parts: [
    part("sphere", "duck feathers", [0.5, 0.04, 0.5], [0.28, 0.22, 0.46], 0, 0, "body"),
    part("sphere", "duck feathers", [0.38, 0.06, 0.5], [0.07, 0.14, 0.3], 0, 0, "body"),
    part("sphere", "duck feathers", [0.62, 0.06, 0.5], [0.07, 0.14, 0.3], 0, 0, "body"),
    part("box", "duck feathers", [0.5, 0.11, 0.29], [0.1, 0.04, 0.1], 0, -28.6, "body"),
    part("box", "feathers", [0.5, 0.16, 0.26], [0.08, 0.03, 0.08], 0, -35, "body"),
    part("cylinder", "feathers", [0.5, 0.13, 0.66], [0.085, 0.1, 0.085], 0, 0, "head"),
    part("sphere", "green feathers", [0.5, 0.22, 0.68], [0.14, 0.14, 0.16], 0, 0, "head"),
    part("cylinder", "green feathers", [0.5, 0.16, 0.67], [0.1, 0.04, 0.1], 0, 0, "head"),
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

// ---------------------------------------------------------------- fields (M11)
// Appended after everything older, so a saved world's entry ids stay where they were.

material(
  "lantern glass",
  "block",
  "#ffd98a",
  "plain",
  2.5,
  1,
  false,
  "Warm glowing glass blown from sand: lamps, and blocks that light a room.",
  0.8,
);
add("part", "lamp", "A light: shines in its Material's color while it's on (use or a signal).", {
  shape: "sphere",
  device: "lamp",
});
add("part", "flame", "A tame fire (torches, campfires): glows warm and never spreads.", {
  shape: "cone",
  device: "flame",
});
add("part", "lever", "use flips it on or off, and it sends that on its channel.", {
  shape: "box",
  device: "lever",
});
add("part", "plate", "A pressure plate: on while someone or something stands on it.", {
  shape: "box",
  device: "plate",
});

/** A device part on a signal channel. */
const wired = (p: ReturnType<typeof part>, channel: string) => ({ ...p, channel });

add(
  "design",
  "lantern post",
  'A crooked wooden post with a hanging glass lantern, on the "lanterns" channel (nature lights them at dusk).',
  {
    anchored: true,
    parts: [
      part("box", "planks", [0.36, 1.1, 0.5], [0.16, 2.2, 0.16]),
      part("box", "planks", [0.58, 2.2, 0.5], [0.62, 0.14, 0.24]),
      wired(part("lamp", "lantern glass", [0.76, 1.94, 0.5], [0.3, 0.36, 0.3]), "lanterns"),
    ],
  },
);
add("design", "torch", "A stick with a small tame flame: warm light that never spreads.", {
  anchored: true,
  parts: [
    part("cylinder", "planks", [0.5, 0.5, 0.5], [0.09, 1, 0.09]),
    part("flame", "planks", [0.5, 1.12, 0.5], [0.18, 0.3, 0.18]),
  ],
});
add("design", "campfire", "Crossed logs in a snug ring of river cobble with a warm tame fire.", {
  anchored: true,
  parts: [
    ...[0, 45, 90, 135, 180, 225, 270, 315].map((t, i) =>
      part(
        "sphere",
        "cobble",
        [0.5 + 0.4 * Math.sin(t * DEG), 0.09, 0.5 + 0.4 * Math.cos(t * DEG)],
        [0.24 + (i % 2) * 0.04, 0.18, 0.22],
        t,
      )
    ),
    part("cylinder", "log", [0.5, 0.12, 0.5], [0.13, 0.62, 0.13], 35, 86),
    part("cylinder", "log", [0.5, 0.16, 0.5], [0.13, 0.62, 0.13], -40, 86),
    part("cylinder", "log", [0.5, 0.14, 0.5], [0.11, 0.56, 0.11], 95, 84),
    part("flame", "log", [0.5, 0.46, 0.5], [0.46, 0.64, 0.46]),
  ],
});
add(
  "design",
  "signal lever",
  'A lever on a stone base. use flips it; it sends on the "gate" channel.',
  {
    anchored: true,
    parts: [
      part("box", "cobble", [0.5, 0.1, 0.5], [0.36, 0.2, 0.36]),
      wired(part("lever", "planks", [0.5, 0.42, 0.5], [0.07, 0.5, 0.07]), "gate"),
    ],
  },
);
add(
  "design",
  "pressure plate",
  'A plank plate flush with the ground: on while anyone stands on it ("gate" channel).',
  {
    anchored: true,
    parts: [wired(part("plate", "planks", [0.5, 0.025, 0.5], [0.8, 0.05, 0.8]), "gate")],
  },
);

rel("lantern glass", "made_from", "sand");

add("rule", "lanterns at dusk", 'Nature lights the "lanterns" channel at nightfall.', {
  when: { daily: 19 },
  do: [{ signal: { channel: "lanterns", on: true } }],
});
add("rule", "lanterns at dawn", 'Nature puts out the "lanterns" channel in the morning.', {
  when: { daily: 6.5 },
  do: [{ signal: { channel: "lanterns", on: false } }],
});
add("rule", "lamplit fields", "At night, wheat that a lamp or fire lights keeps growing.", {
  when: { every: 30 },
  if: { time: [19, 6] },
  do: [{ grow: { what: "wheat crop", hours: 0.5, light_above: 0.3 } }],
});

// ---------------------------------------------------------------- Village Life (M12)

material(
  "bread",
  "item",
  "#c8914f",
  "plain",
  0.3,
  0.5,
  true,
  "A loaf baked from wheat in an oven.",
);
add("part", "mattress", "Furniture: villagers sleep twice as well on one (a bed).", {
  shape: "box",
  furniture: "mattress",
});
add("design", "bed", "A plank bed with a wool mattress: sleep on it at night.", {
  anchored: true,
  mark: "b",
  parts: [
    part("box", "planks", [0.5, 0.27, 1], [0.96, 0.26, 1.96]),
    part("box", "planks", [0.5, 0.55, 0.06], [0.96, 0.62, 0.1]),
    part("mattress", "wool", [0.5, 0.49, 1.05], [0.88, 0.18, 1.8]),
  ],
});
add("design", "oven", "A domed cobble oven with a tame fire: bake bread beside it (craft).", {
  anchored: true,
  parts: [
    part("box", "cobble", [0.5, 0.25, 0.5], [0.96, 0.5, 0.96]),
    part("sphere", "cobble", [0.5, 0.62, 0.5], [0.9, 0.7, 0.9]),
    part("cylinder", "cobble", [0.72, 1.05, 0.72], [0.18, 0.4, 0.18]),
    part("flame", "log", [0.5, 0.62, 0.08], [0.26, 0.24, 0.12]),
  ],
});
rel("bread", "made_from", "wheat");
rel("bread", "needs", "oven");
add("rule", "sweet dreams", "Now and then a night in a bed brings a dream.", {
  when: { event: "slept", what: "bed" },
  if: { chance: 0.3 },
  do: [{ say: "You dreamt of wheat fields rolling to the sea." }],
});
add("rule", "warm bread", "Fresh bread cheers whoever eats it.", {
  when: { event: "ate", what: "bread" },
  do: [{ say: "Warm bread. The day looks brighter." }],
});

// ---------------------------------------------------------------- Floatsee & Sanctuary (v4)
// Appended after M12 so saved worlds keep every older Catalog id unchanged.

material(
  "fawn fur",
  "item",
  "#d9baa0",
  "fleece",
  0.3,
  0.3,
  true,
  "Soft tan fur of island bunnies.",
);
material("inner ear", "item", "#e8b2ad", "plain", 0.3, 0.2, false, "Pale rosy ear lining.");
material(
  "turnip",
  "item",
  "#e65c92",
  "plain",
  0.8,
  0.6,
  false,
  "A plump rosy garden turnip; bunnies love them.",
);
material(
  "turnip seeds",
  "item",
  "#c6a36b",
  "plain",
  0.7,
  1,
  true,
  "Plant them on farmland for colorful root bulbs.",
);
material(
  "turnip gold",
  "item",
  "#f4aa3d",
  "plain",
  0.8,
  0.6,
  false,
  "A sun-kissed golden turnip bulb.",
);
material("parchment", "item", "#f3ebd4", "plain", 0.4, 0.3, true, "Cream paper for notice pins.");
material("iron", "item", "#6b7380", "tiles", 7.8, 7, false, "Forged metal for tools and pins.");
material(
  "floatsee glaze",
  "item",
  "#9fd8c2",
  "tiles",
  1.4,
  3,
  false,
  "Smooth painted ceramic glaze of a Floatsee.",
);

const bunnyLegs = legs("fawn fur", 0.11, 0.13, 0.11, 0.11, 0.08);
add("design", "bunny", "A boxy-plush hopping bunny. It loves turnips and wheat.", {
  parts: [
    part("box", "fawn fur", [0.5, 0.24, 0.5], [0.34, 0.28, 0.4], 0, 0, "body"),
    part("sphere", "wool", [0.5, 0.26, 0.27], [0.13, 0.13, 0.13], 0, 0, "tail"),
    // Head with tall upright rounded ears, rosy inner ears, and shiny bead eyes.
    part("box", "fawn fur", [0.5, 0.33, 0.72], [0.3, 0.26, 0.26], 0, 0, "head"),
    part("cylinder", "fawn fur", [0.42, 0.57, 0.7], [0.09, 0.26, 0.07], 0, -6, "head"),
    part("cylinder", "fawn fur", [0.58, 0.57, 0.7], [0.09, 0.26, 0.07], 0, 6, "head"),
    part("cylinder", "inner ear", [0.42, 0.56, 0.73], [0.05, 0.2, 0.03], 0, -6, "head"),
    part("cylinder", "inner ear", [0.58, 0.56, 0.73], [0.05, 0.2, 0.03], 0, 6, "head"),
    part("sphere", "ink", [0.42, 0.34, 0.85], [0.036, 0.044, 0.03], 0, 0, "head"),
    part("sphere", "ink", [0.58, 0.34, 0.85], [0.036, 0.044, 0.03], 0, 0, "head"),
    part("sphere", "snout", [0.5, 0.3, 0.86], [0.045, 0.032, 0.03], 0, 0, "head"),
    ...bunnyLegs.parts,
  ],
  joints: {
    head: [0.5, 0.32, 0.66],
    tail: [0.5, 0.26, 0.32],
    ...bunnyLegs.joints,
  },
});

add("design", "turnip crop", "Plump rosy and golden turnips with bright leafy tops on farmland.", {
  mark: "T",
  habitat: { on: ["farmland"] },
  parts: [
    // Four plump root bulbs nested in the tilled soil, each topped with lush green leaves.
    ...[
      { x: 0.28, z: 0.3, mat: "turnip", s: 0.26 },
      { x: 0.72, z: 0.32, mat: "turnip gold", s: 0.27 },
      { x: 0.32, z: 0.72, mat: "turnip gold", s: 0.26 },
      { x: 0.7, z: 0.7, mat: "turnip", s: 0.25 },
    ].flatMap(({ x, z, mat, s }) => [
      part("sphere", mat, [x, s * 0.42, z], [s, s * 0.88, s]),
      part("sphere", "leaves", [x - 0.06, s * 1.05, z], [0.13, 0.2, 0.08], 20, -22),
      part("sphere", "leaves", [x + 0.06, s * 1.05, z], [0.13, 0.2, 0.08], -20, 22),
      part("sphere", "stem", [x, s * 1.12, z + 0.05], [0.11, 0.22, 0.08], 0, 14),
    ]),
  ],
});

add("design", "notice board", "A rustic wooden signboard with pinned parchment wishes.", {
  anchored: true,
  parts: [
    part("box", "planks", [0.5, 0.72, 0.5], [0.18, 1.44, 0.16]),
    part("box", "planks", [0.5, 1.04, 0.56], [1.14, 0.22, 0.09]),
    part("box", "planks", [0.5, 0.8, 0.56], [1.12, 0.21, 0.09]),
    part("box", "planks", [0.5, 0.56, 0.56], [1.14, 0.21, 0.09]),
    part("box", "parchment", [0.24, 0.76, 0.62], [0.3, 0.36, 0.025], 0, -4),
    part("sphere", "yellow petals", [0.24, 0.91, 0.64], [0.05, 0.05, 0.04]),
    part("box", "parchment", [0.76, 0.86, 0.62], [0.28, 0.32, 0.025], 0, 5),
    part("sphere", "comb", [0.76, 0.99, 0.64], [0.05, 0.05, 0.04]),
    part("sphere", "leaves", [0.38, 0.06, 0.5], [0.14, 0.12, 0.14]),
    part("sphere", "leaves", [0.62, 0.05, 0.52], [0.12, 0.1, 0.12]),
  ],
});

add("design", "workbench", "A sturdy wooden crafting bench with a rack of miniature tools.", {
  anchored: true,
  parts: [
    // Table top and four chunky timber legs.
    part("box", "planks", [0.5, 0.58, 0.5], [1.26, 0.1, 0.66]),
    part("box", "planks", [0.04, 0.28, 0.24], [0.12, 0.56, 0.12]),
    part("box", "planks", [0.96, 0.28, 0.24], [0.12, 0.56, 0.12]),
    part("box", "planks", [0.04, 0.28, 0.76], [0.12, 0.56, 0.12]),
    part("box", "planks", [0.96, 0.28, 0.76], [0.12, 0.56, 0.12]),
    part("box", "planks", [0.5, 0.18, 0.5], [0.92, 0.07, 0.08]),
    // Backboard tool rack with hanging mallet, wrenches, saw, and spool.
    part("box", "planks", [0.5, 0.86, 0.2], [1.2, 0.44, 0.07]),
    part("cylinder", "bark", [0.2, 0.86, 0.26], [0.045, 0.26, 0.045]),
    part("box", "iron", [0.2, 0.97, 0.26], [0.16, 0.09, 0.09]),
    part("cylinder", "iron", [0.46, 0.86, 0.26], [0.04, 0.24, 0.04]),
    part("cylinder", "iron", [0.66, 0.88, 0.26], [0.035, 0.2, 0.035]),
    part("box", "iron", [0.24, 0.65, 0.52], [0.32, 0.02, 0.14], 15),
    part("box", "red cloth", [0.1, 0.66, 0.54], [0.12, 0.05, 0.1], 15),
    part("cylinder", "bark", [0.58, 0.65, 0.58], [0.04, 0.24, 0.04], -30, 90),
    part("box", "iron", [0.68, 0.66, 0.52], [0.14, 0.08, 0.08], -30),
    part("cylinder", "floatsee glaze", [0.88, 0.67, 0.54], [0.14, 0.09, 0.14]),
  ],
});

add(
  "design",
  "floatsee",
  "A customizable Floatsee: floating ceramic head over a bell cloak with graphic tee.",
  {
    parts: [
      part("cylinder", "floatsee glaze", [0.38, 0.12, 0.5], [0.16, 0.24, 0.16], 0, 0, "left leg"),
      part("cylinder", "floatsee glaze", [0.62, 0.12, 0.5], [0.16, 0.24, 0.16], 0, 0, "right leg"),
      part("cylinder", "floatsee glaze", [0.5, 0.62, 0.5], [0.62, 0.84, 0.62], 0, 0, "body"),
      part("sphere", "floatsee glaze", [0.16, 0.72, 0.5], [0.18, 0.36, 0.18], 0, 0, "left arm"),
      part("sphere", "floatsee glaze", [0.84, 0.72, 0.5], [0.18, 0.36, 0.18], 0, 0, "right arm"),
      part("sphere", "floatsee glaze", [0.5, 1.44, 0.5], [0.56, 0.56, 0.56], 0, 0, "head"),
    ],
    joints: {
      "left leg": [0.38, 0.24, 0.5],
      "right leg": [0.62, 0.24, 0.5],
      body: [0.5, 0.24, 0.5],
      "left arm": [0.22, 0.88, 0.5],
      "right arm": [0.78, 0.88, 0.5],
      head: [0.5, 1.18, 0.5],
    },
  },
);

rel("turnip seeds", "grows_into", "turnip crop", 1, 14);
rel("turnip crop", "drops", "turnip", 2);
rel("turnip crop", "drops", "turnip seeds", 2);
rel("turnip", "is_food_for", "bunny");
rel("wheat", "is_food_for", "bunny");

// Food: how much one fills a villager's hunger (a full belly is 1).
const FOOD: Record<string, number> = {
  wheat: 0.1,
  turnip: 0.2,
  berries: 0.1,
  egg: 0.15,
  milk: 0.15,
  minnow: 0.1,
  trout: 0.2,
  perch: 0.2,
  mackerel: 0.25,
  cod: 0.3,
  bread: 0.35,
};
// Unlocks: what a hamlet and a village make available. Everything else is there from the camp.
const UNLOCK: Record<string, string> = {
  hinge: "hamlet",
  axle: "hamlet",
  slider: "hamlet",
  lamp: "hamlet",
  flame: "hamlet",
  brick: "hamlet",
  tiles: "hamlet",
  motor: "village",
  lever: "village",
  plate: "village",
  "lantern glass": "village",
};
for (const e of entries) {
  const content = e.content as Record<string, unknown>;
  if (e.kind === "material" && FOOD[e.name]) content.food = FOOD[e.name];
  if (UNLOCK[e.name]) content.unlock = UNLOCK[e.name];
}

/** Add nature's entries to a new Catalog. */
export function seedNature(c: Catalog) {
  for (const e of entries) c.add(e, "nature", 0);
}
