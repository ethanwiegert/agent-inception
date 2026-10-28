# agent-inception — roadmap

Where the project is going and in what order. The why lives in `DESIGN.md`, the words in
`GLOSSARY.md`, the hard-to-reverse calls in `adr/`. Settled with Ethan on 2026-10-26.

**V1** is a hosted, client-side site where anyone points an MCP agent at their own world, built on
the core mechanics and the authoring framework: the Catalog, Rules, building, physics, Village Life
and spectators. **V2** is scaling and breadth: shared worlds, a global Catalog, more of everything.

## How a milestone runs

1. **Open with a short grill.** Clarifying questions with Ethan before any code; the outcome goes
   into the milestone's section below (and an ADR if it qualifies).
2. **Build it** test-first where the sim is concerned. Every tool and Rule gets tests, edge cases
   included.
3. **Gate it.** A milestone is done only when all of these hold:
   - `deno task check` and `deno task test` pass.
   - 2-3 cost-effective agents with milestone briefs play ~40 calls each; one brief is an adversary
     that tries to break the new tools (bad arguments, odd sequences, the safety limits).
   - A report lands in `docs/playtests/NNNN-<milestone>.md`: what they tried, friction, bugs.
   - Every bug is fixed; friction is fixed or added to this roadmap.
   - Perf is re-measured against the budgets in `DESIGN.md`, and screenshots are checked.
4. **Then** move on. Quality over speed.

Saves may break freely until M14; save versioning and migrations come last before release.

## Done

- **M0 — foundation.** Deno toolchain, dev server, WebGPU bootstrap, Chromium/CDP harness.
- **M1 — the look.** Voxel meadow, GPU grass with wind, shadows, day/night, look presets.
- **M2 — sim core.** Worker, fixed tick, determinism tests, save/load, offline catch-up.
- **M3 — the agent.** Bodies and animation, MCP bridge, tools, a farmer played by a cost-effective
  agent end to end; then sloped hills, sprites, click-to-follow.
- **World v2.** Island with rivers and sea, block registry and patterns, smooth shading, GPU water,
  sun/moon/stars/clouds, cloud shadows, weather drift, compute-culled grass, `?debug=`, `camshot`.
- **M4 — life.** Damped orbit camera with HUD and touch; model system (mesh templates, instanced
  draws, wind); props (trees, bushes, flowers, reeds, rocks, lily pads, saplings); sheep, cows,
  chickens and ducks with herd AI and rigs; fish schools, `fish`, swimming; job helpers in
  `sim/jobs.ts` and `reach` to a block height (building groundwork).
- **M5 — Catalog core.** Append-only Catalog with nature's entries, Proposals and Votes, the Rules
  engine, seven Catalog tools, page mirror and feed; playtest [0001](playtests/0001-m5-catalog.md).
- **M6 — built-ins become entries.** Nature's content is Catalog data; playtest
  [0002](playtests/0002-m6-built-ins.md). Hardware GPU remeasure is deferred to Ethan's review (no
  number recorded; the gate VM had no real GPU).

## V1

| #   | Milestone                    | In short                                                        |
| --- | ---------------------------- | --------------------------------------------------------------- |
| M5  | Catalog core                 | Append-only Catalog, Relations, Rules engine, query/author      |
| M6  | Built-ins become entries     | Our content rewritten as Catalog data                           |
| M7  | Building, crafting, physics1 | Designs of Blocks + Parts, `craft`, `interact`, collision       |
| M8  | Character and land           | 3D villager bodies from Parts, `terraform`, agent-made crops    |
| M9  | Physics 2: rigid bodies      | Fall, stack, topple, roll, float/sink, push, carry              |
| M10 | Physics 3: joints            | Hinge, axle, slider, motor                                      |
| M11 | Physics 4: fields            | Light, fire, signals                                            |
| M12 | Village Life                 | Needs, village level, Unlocks, Errands, Sandbox toggle          |
| M13 | Spectators                   | Notice Board and Wishes, panel controls, audio, reverse CAPTCHA |
| M14 | Ship V1                      | Relay + pairing, hosting, world slots, saves, perf, landing     |

The order holds at least until M13; adjust it then if playtests say so.

### M5 — Catalog core

- Catalog store separate from the World store (ADR 0003): append-only records with id, kind, author,
  created tick, forked-from, content; mutable only `retired` and `replaced_by`.
- Entry kinds: Material, Part, Design, Rule, Relation (engine and free).
- Proposals and Votes: the only way an entry gets retired or replaced.
- Rules engine (ADR 0004): JSON trees of trigger → conditions → effects, schema-validated, size and
  depth caps, per-tick step budget, effects only through engine operations.
- Agent tools to query (find by kind/name/property/relation, get, relations) and to author (add,
  fork, propose, vote). `look` and `join` mention the Catalog.
- Safety baseline from `DESIGN.md` → Safety, with the adversary playtester aimed at it.
- Persisted with the world; the page mirrors it like blocks today.

Grill outcome (2026-10-27):

- **Votes are lazy consensus.** A Proposal is open for one game day; the proposer's yes counts; it
  closes early once every active villager (one who called a tool in the last game day) has voted,
  and passes if yes outnumber no. A one-villager world passes its proposals at once. One open
  proposal per entry, three per villager.
- **Rules go live on add**, under hard caps; bad Rules are retired by Proposal.
- **Small separate tools**: `catalog_find`, `catalog_get`, `catalog_add`, `catalog_fork`, `propose`,
  `vote`, `proposals`.
- **First vocabulary**: triggers are tool events (`joined`, `said`, `tilled`, `planted`,
  `harvested`, `placed`, `broken`, `caught`, optionally filtered by `what`), `every` N game minutes
  and `daily` at an hour; conditions `chance`, `time`, `clouds_above`/`clouds_below`, `has`,
  `block`, `all`/`any`/`not`; effects `give` (≤ 4), `take`, `set_block` (±4 of the event, air or a
  placeable block), `say`, `weather`. Rules don't trigger Rules.
- **Limits** (chosen in the build): 5 entries per villager per game hour and 50 per day; names 1-40
  characters, descriptions and reasons ≤ 280, content ≤ 8 KB of JSON, 5000 entries per world;
  Designs ≤ 16³ blocks and 32 Parts; Rules ≤ 24 nodes, depth 5, 8 effects, 20 firings per game hour,
  400 Rule steps per tick across all Rules; bridge requests ≤ 1 MB.
- Built-in blocks are seeded as nature's Materials now (with density, hardness, burns), plus the
  engine's first Parts (box, sphere, cylinder), the made-from/drops Relations the code already
  follows, and worked examples (`stone bench`, `lucky harvest`, `dawn chorus`). M6 makes the
  renderer and the tools read them. Retiring or replacing an item already changes what Rules `give`;
  tools keep their coded drops until M6.

### M6 — built-ins become entries

- Blocks → Materials (looks, patterns, physical properties such as density and hardness).
- Wheat, saplings, trees, flowers, reeds, rocks, lily pads → Designs + Rules (growth, spreading).
- Drops and products (logs, seeds, wool, milk, eggs, fish) → engine Relations.
- The farmer look → a Design. Species stay code until V2 (ADR 0002), but their products, food and
  drops come from the Catalog.
- Renderer and worldgen read looks and placement from the Catalog; nothing special-cased.
- From playtest 0001: items and crops (wheat, seeds, fish, wool, milk, eggs) become entries, so
  Relations like "wheat is_food_for cow" can be written; tools' drops follow `replaced_by` like Rule
  `give` already does.

Grill outcome (2026-10-27):

- **Items are Materials.** Everything a villager holds is a Material (`form`: `block`, `item`, or
  `liquid` for nature only); inventories count Materials by Catalog name ("wheat seeds", "oak
  sapling"; underscores read as spaces).
- **Plant looks are Designs of Parts in Materials.** New `cone` Part, `tilt` beside `turn`. The
  Material decides the look: color, surface (`leaves` and `fleece` patterns are lumpy, `stone` is
  lumpy and faceted) and wind bend (softer = bends more, more toward the top). One Design per look;
  size, height and rotation vary per tile.
- **Placement and growth are data.** Worldgen still reads the terrain in code (forest noise,
  altitude, slopes, water) to find a tile's zone; a Design's `habitat` says what ground it grows on
  and which zones nature fills with it, weighted by `share` (picked in patches: groves for trees,
  patches for flowers). Growth time is `hours` on `grows_into` Relations (seed Material → plant
  Design), fixed per plant when planted. Spreading becomes a Rule effect.
- **Wheat and the farmer keep their renderers but read data.** Crops (plants on farmland) keep the
  GPU blade shader; stalks take the crop's first part Material, ripe ears the color of what it
  drops. The farmer is a Design with part `role`s and `joints`; per-villager shirt/skin tints
  (overriding `linen` and `skin`) stay until M8.

Decided in the build:

- Animal bodies are Designs too (matched to code species by name), so Relations have endpoints:
  "sheep drops wool", "wheat is_food_for sheep". Animals follow whoever holds any of their foods.
  Gaits and behaviour stay code. Fish species stay code; caught fish are Materials.
- What the engine reads off a Design (`PlantInfo`): **solid** if any part's Material has hardness ≥
  3 (bark, stone), **ground cover** (no shadow, near only) if every part is thinner than 0.1,
  **floats** if it's low (≤ 0.25) and all its Materials are lighter than water. Optional `mark` is
  its look-map character.
- Designs stand on their first cell: (0.5, 0, 0.5) is the tile center on the ground.
- Block ids: built-ins keep fixed ids; every other block Material gets the next id from 64 in
  Catalog order, so the page derives the same registry from its mirror (no block list in saves or
  messages). Digging takes 16 + 4 × hardness ticks and gives the block's `drops`, else itself (sand
  no longer gives dirt). A replaced farmer, animal or wheat Design changes what the world draws.
- `look` lists the plants in view by name ("Plants: T birch/oak * daisies…"); Rule `what` matches
  whole words for every event, so "wheat" matches "wheat crop".
- Save format is version 2; older saves start the same island afresh.
- **Spread** is a Rule effect: `{"spread": {"what": "poppies", "count": 2}}` (count 1–4) places that
  many fully grown copies, each beside a random existing prop of that Design. The name follows
  `replaced_by`, and so does each prop, so a replaced plant spreads as its replacement. A tile has
  to be free and pass the same habitat check as `plant` (ground in `on`; underwater only when the
  plant floats or its zones include shore or shallows). Zones are not re-classified. A tile with 3
  of its 8 neighbours already holding that Design is too crowded. It needs no villager, so a timer
  can run it. Nature's "wildflowers spread" does this once a game hour, one each of poppies,
  buttercups, daisies and violets.

Done so far (commit "M6 part 1", plus the uncommitted continuation):

- Sim: `sim/nature.ts` holds all of nature's entries; Materials with `form`; Designs with cones,
  tilt, roles, joints, mark, habitat; `grows_into` hours; block registry from the Catalog; generic
  `plant` (by seed, sapling or plant name), `harvest` and `break_block` drops from Relations, `fish`
  and the starter kit follow `replaced_by`; animal food from `is_food_for`; worldgen by zone. 60
  tests pass (12 new in `sim/nature_test.ts`).
- Render: `render/designs.ts` meshes any Design; flora, villager and animal templates come from the
  Catalog; crop colors stream from the worker (`CROP_STRIDE` 8).
- Checked in the browser: forests, bushes, rocks (new `fieldstone` Material, darker like the old
  boulders), cows, the farmer (hat, tinted shirt, denim), planted saplings and growing wheat. GPU
  ~2.9 ms at the wide harness view (was ~2.7 ms; re-measure in the gate).
- Spread is in, with tests for a free neighbour, the crowding cap, and a replaced Design. It picks
  with `hash2` of the tick and the tile, so it does not move the sim RNG (harvest luck and fish
  schools stay where the older tests put them).
- Agent-facing text matches the grill: `catalog_add` covers form, cone, tilt, role, joints, mark,
  habitat, hours and spread; `join` says what you carry is a Material; `DESIGN.md`'s till, plant,
  harvest, place and break rows, the Material glossary entry, and `farmer.md` say the same.

Visual pass (seed 7, daytime), closed without editing `nature.ts`:

- Flowers, reeds and cattails, lily pads and the water lily, chickens, ducks and sheep read as the
  old meshes. Parts sit on the tile center. Sheep ears are small. Wool stays full: shearing is M7's
  `interact`, sheep start with wool grown, and the product-role shrink (0.78 until it grows back)
  has nothing to show yet.
- Ripe wheat uses the `wheat` Material `#e6c76f`, the sRGB of the old blade shader's linear ear
  `(0.8, 0.58, 0.16)`. Daylight ripe stalks are that pale gold.
- The farmer's straw hat, red band, tinted shirt, denim and boots read in daylight. Eyes are the
  same ink boxes as the old head, and arm swing is the same pose code. A close face frame cropped at
  the shoulders and a stride frame missed the walker, so those two were not judged from a picture.

Playtest [0002](playtests/0002-m6-built-ins.md) covers the bridge sessions, the fixes, check, and
test. M6 is done. Hardware GPU remeasure is deferred to Ethan's review: run
`deno task shot "seed=7&time=0.62&speed=0"` on a machine with a real GPU and record the
milliseconds. The gate VM only got SwiftShader, then lost the device, so no GPU time was measured.
The older ~2.9 ms figure is not that shot.

### M7 — building, crafting, physics phase 1

Groundwork is in (`sim/jobs.ts`, `reach` with `y`).

Grill outcome (2026-10-28), Ethan's locks:

- **Extend** `place_block` and `break_block`. No new place or break tools. Any placeable Material,
  optional `y`, needs a solid neighbour; refuse a cell a villager stands in and a solid-prop tile.
  `break_block` takes optional `y` and gives drops from Relations.
- **`craft` is counted recipes**, not 1→1 only. `made_from` carries `count` (how many you get: 1 log
  → 4 planks) and optional `takes` (how many you spend: 4 wheat → 1 thatch). `count` on the tool is
  how many times to run that recipe (4 logs → 16 planks).
- **`break_block` refuses props.** Trees, rocks, flowers, reeds, lily pads, and shearing, milking
  and eggs go through `interact`, which also digs up a sapling and chops a grown tree.
- **Physics 1 is solid Designs only.** A Design is solid when a part's Material has hardness ≥ 3
  (the same line as `PlantInfo.solid`). Those Objects get part collision shapes (box, sphere,
  cylinder, cone, including turn and tilt) and bodies walk around them and stand on them. Softer
  parts and non-solid Designs do not collide yet.

Decided in the build:

- One craft consumes every `made_from` ingredient of the product (`takes`, default 1) and gives
  `count` of it. Nature's recipes: 1 log → 4 planks, 1 stone → 1 cobble, 1 clay → 1 brick or 1
  tiles, 4 wheat → 1 thatch. Picked plants drop their petals, reed or lily leaf.
- `build` checks the whole remainder is in the inventory, then places at most 48 new block cells.
  Each cell costs one of its Material; each part costs one of its Material, spent when the blocks
  are finished. A call says which cells it skipped and the base `y` to pass to continue. The built
  Design is an Object either way; only the solid ones stamp collision.
- `look` keeps the old marks for terrain and plants. Other surface Materials get a Built legend, and
  Objects in view are listed by name and origin. Natural Materials (stone, dirt, …) keep their
  existing marks.
- Part shapes are rasterized into the cells they cover. A column is blocked when a body would stand
  inside one, and standable when the top of a filled cell has two empty cells above it, same as
  voxels. Save version stays 2; `objects` is optional on older saves.

Decided while closing the engine leftovers (the gate is still open):

- Part Objects are drawn. The page mirrors the built list and meshes each Design's parts, with the
  instance origin at the tile center on the design's base (where (0.5, 0, 0.5) sits). Placed blocks
  stay voxels. A blocks-only Design has nothing extra to draw.
- A sheep's product parts draw at full size while its wool is ready, and at 0.78 after `interact`
  shears it, until `readyAt`. That flag already rides on the animal stream.
- `interact` on an Object's origin tile, when no prop or collectable animal is there, takes it down:
  matching block cells are cleared, and those Materials plus one of each part Material come back.
  `break_block` still refuses props and does not remove an Object. Optional `y` picks which Object
  when several share the tile.

Left for the gate:

- Playtest (builder, crafter, adversary) and screenshots. Not run here: this VM has no WebGPU device
  and no playtest agents. See [0003](playtests/0003-m7-building.md). Do not treat M7 as done.
- Hardware GPU remeasure stays on Ethan's machine. No GPU time is recorded.

### M8 — character and land

- Villager bodies are 3D Designs from Parts (ADR 0005); `set_sprite` and sprite dolls are removed.
  The farmer Design is the worked example. Update `farmer.md`'s first-join step.
- `terraform`: raise, lower, flatten an area.
- Agent-authored crops: a Design + growth Rules + Relations.

### M9-M11 — physics phases 2-4

Deterministic on the fixed tick, simple shapes (box, sphere, capsule, compounds), sleeping bodies.
Budget: sim tick < 4 ms with 500 awake bodies.

- **M9 rigid bodies**: fall, stack, topple, roll, float or sink by Material density, push, carry.
- **M10 joints**: hinge, axle, slider, motor; doors, carts, windmills become possible Designs.
- **M11 fields**: light from lamp Parts, then fire (spreads to Materials that burn), then signals.

### M12 — Village Life

- Needs: hunger (food restores it) and energy (rest at night). Unmet needs slow a villager; no
  death.
- Village level (camp → hamlet → village) from what the villagers built and grew together; each
  level Unlocks base Materials and Parts.
- Errands offered by the world; any villager may take or ignore one.
- On by default; the spectator flips Village Life / Sandbox at any time (needs pause, everything
  unlocked). Agents learn the mode from `join` and `look`.

### M13 — spectators

- Notice Board: spectators pin Wishes (≤ 140 chars, open or for one villager); agents read them in
  `look` and a board tool, reply, mark them done. Wishes are never orders.
- Spectator panel: time, speed, look, seed, world slots, weather, Village Life toggle, follow.
  Spectators never move villagers and never retire or replace entries.
- Audio: WebAudio with positional sound and event hooks; Ethan's soundtrack and voices.
- Reverse CAPTCHA when a spectator reaches for WASD or clicks the world.

### M14 — ship V1

- Relay + pairing code (ADR 0001); choose the host (Cloudflare likely); any MCP client connects with
  a URL.
- 3 world slots per browser, export/import a world, a new seed always starts a fresh slot.
- Save format version and migrations from here on.
- 60 fps on an integrated-GPU laptop at 1080p, measured; Chromium-family browsers only.
- Landing/connect page.

## V2 (unordered)

Water flow; shared worlds (server sim behind the relay); a global Catalog shared between worlds;
agent-authored species; WebMCP; open source; Firefox/Safari once their WebGPU is solid.

## Catalog ideas from playtests

- Per-villager Rule cooldowns ("once per villager per game hour") on top of the per-Rule cap.
- Withdraw your own open proposal; let an author retire their own entry within a short grace window.
- Rules that read Relations ("if this farmland is fertilized by compost, wheat grows faster").
- `catalog_find` text searches names and descriptions, not inside Rule or Design content, so a
  spread rule has to be named or described as one.
- A plant Design can be replaced by a Design with no habitat. New planting of that seed then fails;
  the proposal itself is allowed.

## Known gaps (polish backlog)

Pick these up in the gate of whichever milestone touches them.

- Close, low views: sloped side triangles read as dark facets in shade; sunset sky too pale (wants a
  warmer horizon band); moon disc a bit large; far-hill grass radius edge visible at low angles.
- Underwater clay/gravel patches have square edges (only grass edges blend so far).
- `generateWorld` takes ~330 ms and runs in both the worker and the page; could be shared.
- A new seed rebuilds the `Renderer` without destroying the old GPU resources.
- In-flight tool calls are lost on page reload (jobs aren't saved); agents just get an error.
- Props draw every instance (~3.6k, ~0.45 ms GPU at the default view); per-chunk culling and tree
  LODs would cut that as the world fills up.
- Crop growth is re-sent from the worker once a second; could move to the GPU from planted ticks.
