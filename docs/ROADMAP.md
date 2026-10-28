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
   - 2-3 Haiku agents with milestone briefs play ~40 calls each; one brief is an adversary that
     tries to break the new tools (bad arguments, odd sequences, the safety limits).
   - A report lands in `docs/playtests/NNNN-<milestone>.md`: what they tried, friction, bugs.
   - Every bug is fixed; friction is fixed or added to this roadmap.
   - Perf is re-measured against the budgets in `DESIGN.md`, and screenshots are checked.
4. **Then** move on. Quality over speed.

Saves may break freely until M14; save versioning and migrations come last before release.

## Done

- **M0 — foundation.** Deno toolchain, dev server, WebGPU bootstrap, Chromium/CDP harness.
- **M1 — the look.** Voxel meadow, GPU grass with wind, shadows, day/night, look presets.
- **M2 — sim core.** Worker, fixed tick, determinism tests, save/load, offline catch-up.
- **M3 — the agent.** Bodies and animation, MCP bridge, tools, a Haiku farmer playing end to end;
  then sloped hills, sprites, click-to-follow.
- **World v2.** Island with rivers and sea, block registry and patterns, smooth shading, GPU water,
  sun/moon/stars/clouds, cloud shadows, weather drift, compute-culled grass, `?debug=`, `camshot`.
- **M4 — life.** Damped orbit camera with HUD and touch; model system (mesh templates, instanced
  draws, wind); props (trees, bushes, flowers, reeds, rocks, lily pads, saplings); sheep, cows,
  chickens and ducks with herd AI and rigs; fish schools, `fish`, swimming; job helpers in
  `sim/jobs.ts` and `reach` to a block height (building groundwork).
- **M5 — Catalog core.** Append-only Catalog with nature's entries, Proposals and Votes, the Rules
  engine, seven Catalog tools, page mirror and feed; playtest [0001](playtests/0001-m5-catalog.md).

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

### M6 — built-ins become entries (in progress)

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

Left to do:

- The gate: Haiku playtest (builder, steward, adversary aimed at the new schema fields, habitats,
  planting odd things, replacing the farmer/wheat/animal Designs), report
  `docs/playtests/0002-m6-built-ins.md`, perf against `DESIGN.md`, screenshots. M6 stays open until
  that holds.

### M7 — building, crafting, physics phase 1

Groundwork is in (`sim/jobs.ts`, `reach` with `y`). Starting plan, to refine in the M7 grill:

- `place_block` for any placeable Material in the inventory, optional `y`; needs a solid neighbour,
  refuses cells a villager stands in and solid-prop tiles. `break_block` with optional `y`, drops
  from engine Relations.
- `build` a Design (Blocks + Parts) at x, z, optional base y: checks the inventory up front, places
  layer by layer (≤ 48 cells per call to stay under MCP timeouts), reports skipped cells.
- `craft` through _made from_ Relations (log → planks, stone → cobble, clay → brick or tiles, wheat
  → thatch as the built-in examples).
- `interact` at x, z: chop a grown tree (logs + sapling, axe swing), dig up a sapling, break a rock,
  pick flowers/reeds/lily pads, shear sheep, milk cows, collect eggs when ready.
- Physics 1: collision shapes for Parts; static Objects that villagers walk around and on.
- `look` legend for built Materials and Objects.

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
