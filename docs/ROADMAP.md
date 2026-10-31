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

- **Open source (2026-10-31).** MIT license, README, contributing guide, funding links.
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
- **M6 — built-ins become entries.** Blocks, items, plants, the farmer and animal bodies are Catalog
  data; growth, drops and food are Relations; spread is a Rule effect; playtest
  [0002](playtests/0002-m6-built-ins.md). Closed 2026-10-29 with Ethan's OK on software numbers; the
  hardware remeasure moved to the standing TODO under Known gaps.
- **Overhaul (2026-10-28, between M6 and M7, asked for by Ethan).** Efficiency, agent fluidity and
  looks across the board; report [0003](playtests/0003-overhaul.md). Worldgen ~3× faster and no
  longer run twice, a ~2.5× faster mesher, GPU-culled props, compact water, crop growth on the GPU;
  instant tool answers and no `_whoami` round trip; building pulled forward from M7 (below); PBR
  Neutral tonemap, sharpening, warm sunsets, lit clouds, organic ground edges; offscreen
  `screenshot` with name tags; a headless harness for VMs without a display.
- **M7 — building, crafting, physics phase 1.** `craft` along made_from, `interact` (gather,
  dismantle, collect from animals), Designs' parts built as Objects in quarter turns and paid by
  volume, Objects rasterized for walking (stand on low tops, walk around tall ones); playtest
  [0004](playtests/0004-m7.md).
- **M8 — character and land.** `set_body` (any Design with a body part; sprites removed),
  `terraform` (raise, lower, flatten, conserving earth), crops drawn from their Design (wheat opts
  into blades), a `grow` Rule effect; playtest [0005](playtests/0005-m8.md).
- **M9 — rigid bodies.** Built Objects fall, stack, topple, roll, float or sink by Material density;
  `push`, `carry`, `put_down`; knockdowns with grace and blame; `pushed`/`carried`/`landed` triggers
  and an `impulse` effect; playtest [0006](playtests/0006-m9.md).
- **M10 — joints.** Hinge, axle, slider and motor Parts join a Design's pieces, each its own body;
  `use` swings doors and sliders and switches motors; a closed door is a wall; `used` and `switch`
  for Rules; a garden gate, hand cart and windmill as worked examples; playtest
  [0007](playtests/0007-m10.md).
- **M11 — fields.** Light as a field over the cells (lamps, flames, fire, glowing Materials; walls
  stop it) that `look` and Rules read; wild fire that spreads to what burns, capped, with `ignite`
  and `douse`; signals on named channels from levers and pressure plates to lamps, flames, motors
  and doors; lantern post, torch, campfire, signal lever and pressure plate as worked examples;
  playtest [0008](playtests/0008-m11.md).
- **M12 — Village Life.** Needs (`eat`, `sleep`, beds), worth that recipes pass along (chains can't
  multiply), workbenches (`needs`), a village level from camp to hamlet to village whose Unlocks
  gate Parts and Materials, world-posted `errands`, a daily bounty for villagers' Rules, and the
  spectator's Sandbox switch; playtest [0009](playtests/0009-m12.md).
- **M13 — spectators.** The Notice Board (spectators pin Wishes; agents read, reply and mark them
  done with `board`; never orders, never paid), panel weather and sound, synthesized positional
  audio with file slots for Ethan's soundtrack and voices, and the reverse CAPTCHA; playtest
  [0010](playtests/0010-m13.md).
- **M14 — ship V1 (built, gate passed in software; two steps left for Ethan).** A relay with a
  secret link per world (one Cloudflare Worker, a Durable Object per link), the connect card, world
  slots with export and import, save version 3 with migrations, villagers held by the session
  playing them, adaptive render scale; playtest [0011](playtests/0011-m14.md). Discoverability
  (2026-10-31): `llms.txt`, robots.txt, sitemap, social card, structured data and a crawlable intro,
  with the site's address filled in as it's served. Left: a deploy (`deno task build`, then
  `npx wrangler deploy`) to a real Cloudflare account with the README's after-deploy steps, and the
  60 fps measure on an integrated-GPU laptop at 1080p (with the standing hardware remeasure).

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

### M6 — built-ins become entries (done)

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
test. Still open:

- **Hardware GPU remeasure**: not measured in M6's gate (the VM only had SwiftShader). Ethan closed
  M6 on 2026-10-29 without it; the remeasure is one standing TODO under Known gaps for M6, the
  overhaul and M7.

### M7 — building, crafting, physics phase 1 (done)

Groundwork is in (`sim/jobs.ts`, `reach` with `y`). Starting plan, as it stood before the grill:

- Done in the overhaul (`sim/buildtools.ts`; revisit in the grill): `place_block` for any held block
  Material over areas (≤ 16 columns, `layers` ≤ 4, ≤ 48 blocks) or at a `y` with a solid neighbour,
  refusing cells another villager stands in (your own body steps aside) and solid-prop tiles;
  `break_block` over areas and layers or upward from `y`; `build` of a Design's _blocks_ at x, z,
  optional base y, bottom layer first, ≤ 48 blocks or ~50 s per call, idempotent (calling again
  carries on; it finds its own earlier work as the base), says what's still needed. Diggers work
  inside-out, builders defer the block that would shut them in, reach falls back to arm's length
  (two tiles) and bodies hop down up to 4 blocks when there's no other way. `look` names built
  blocks (planks `P`, brick `B`…) with marks nothing else uses.
- Still to do: `build` of a Design's _Parts_ (Objects), and checking the whole inventory up front
  (today it builds with what you have and lists what's missing).
- `craft` through _made from_ Relations (log → planks, stone → cobble, clay → brick or tiles, wheat
  → thatch as the built-in examples).
- `interact` at x, z: chop a grown tree (logs + sapling, axe swing), dig up a sapling, break a rock,
  pick flowers/reeds/lily pads, shear sheep, milk cows, collect eggs when ready.
- Physics 1: collision shapes for Parts; static Objects that villagers walk around and on.
- `look` legend for Objects (built Materials are in).

Grill outcome (2026-10-29):

- **Recipes.** `craft` follows `made_from` (`count` of the output from one of the ingredient).
  Agents' recipes go live at once, but only for Materials an agent authored: nature's Materials
  (log, stone, wheat…) keep nature's recipes, so nobody crafts logs from dirt. Crafting works
  anywhere, about a second per batch; workbenches can come later as a `needs` Relation.
- **Objects are tile-anchored.** A Design's parts become one Object anchored at its first cell and
  turned in quarter turns. For walking, each part's box is rasterized onto the tiles it covers: a
  top up to a block over the ground is stood on, anything taller is walked around, parts two blocks
  up leave room to walk under. Real shapes and free placement wait for rigid bodies (M9).
- **Part cost by volume.** Each part costs ceil(its volume in blocks) of its Material, at least 1.
  `build` checks the whole remaining cost (blocks and parts) up front and refuses with the list.
- **`interact` needs no tool items.** One tool at x, z (or an area ≤ 16): the target decides the
  verb, yields are `drops` Relations, animal products regrow on the species' timer. Axes and shears
  as items can come with Village Life.
- **Dismantling**: `interact` on any tile of an Object takes it apart and returns its full part
  cost, whoever built it (a shared village).
- **Playtests** run as cost-effective subagents calling the MCP bridge through a small shell helper,
  since the cloud session has no MCP connection of its own.

Decided in the build and the gate:

- Objects live in their own store (`sim/objects.ts`), saved with the world and mirrored whole to the
  page on change. Each column keeps the Object over it, whether it's in the way, and how far it
  lifts a body; paths, animals, `place_block`, `break_block`, `till`, `plant`, spread and
  `set_block` Rules all respect it. A part's box after its own turn and tilt is what's rasterized.
- A parts-only Object stands on the highest ground under it (`y` refused); a mixed Design's parts
  stand on its block base. The builder raises parts from any tile beside the footprint.
- Agents' recipes yield at most 4 per ingredient and may not loop. Picked plants give items that
  grow back into the plant (poppy → poppies, reed → reeds, lily leaf → lily pads, berries → bush);
  berries are chicken food. Rules gain `crafted`, `gathered` and `built`.
- `interact` targets match names or what a thing gives; animals up to two tiles outside the area
  count, since they wander.

### M8 — character and land (done)

- Villager bodies are 3D Designs from Parts (ADR 0005); `set_sprite` and sprite dolls are removed.
  The farmer Design is the worked example. Update `farmer.md`'s first-join step.
- `terraform`: raise, lower, flatten an area.
- Agent-authored crops: a Design + growth Rules + Relations.

Grill outcome (2026-10-29):

- **`set_body {design}` replaces `set_sprite`**, free (a look, not a build): any live Design with a
  `body` role that fits in about 1.2 × 2.4 × 1.2 blocks. Its roles animate (head, arms, legs);
  missing roles just hold still. The default stays the farmer with per-villager shirt and skin
  tints; a chosen body shows its own Materials.
- **`terraform` conserves material**: lowering gives what it digs, raising spends dirt (or a named
  block Material) from the inventory, flatten does both to a target height. Earthwork pace, about
  three times faster per block than `place_block`; up to 8 × 8 columns and 64 blocks a call, and
  calling again carries on.
- **Crop looks are data**: a Design with `"look": "blades"` draws as the GPU blade field (wheat opts
  in); any other crop draws its own Parts, scaled up as it grows, like a sapling.
- **A `grow` Rule effect** (`{"grow": {"what": "radish", "hours": 2}}`) advances matching crops near
  the event, or everywhere on a timer: rain makes radishes grow, compost speeds wheat.

Decided in the build and the gate:

- A body must be centered on its first cell, at least partly above y = 0, and its parts' boxes fit
  1.2 × 2.4 × 1.2. Only parts make a body (a Design's blocks are ignored). A body whose Design is
  later replaced by one without a body part is drawn as the farmer.
- terraform keeps the turf: raising dirt onto grass lifts the grass, lowering grass sinks it. Trees,
  rocks, crops and Objects are skipped. Lowering never leaves the digger in the pit.
- Paths never hop down into a place with no ordinary way back unless the villager is already
  stranded, and a villager with nowhere to walk works from where they stand (dig up, pillar out).
- `grow` reaches ±4 tiles of the event, up to 24 hours; on a timer everywhere, up to 1 hour a
  firing. It follows `replaced_by` like spread.

### M9-M11 — physics phases 2-4

Deterministic on the fixed tick, simple shapes (box, sphere, capsule, compounds), sleeping bodies.
Budget: sim tick < 4 ms with 500 awake bodies.

- **M9 rigid bodies**: fall, stack, topple, roll, float or sink by Material density, push, carry.
- **M10 joints**: hinge, axle, slider, motor; doors, carts, windmills become possible Designs.
- **M11 fields**: light from lamp Parts, then fire (spreads to Materials that burn), then signals.

M9 is done (playtest [0006](playtests/0006-m9.md)). Grill outcome (2026-10-29):

- **Built Objects are rigid bodies.** Every Object built from a parts-only Design is a body made of
  its parts (a compound shape; mass is each part's volume × its Material's density). It falls,
  stacks, topples, rolls, floats or sinks, and rests in any pose, no longer snapped to tiles or
  quarter turns. Props stay static scenery that bodies bump into. A Design marked `"anchored": true`
  stays put.
- **Blocks stay static.** Voxels are the world bodies collide with (slopes included). Digging out
  what an Object stands on makes it fall; blocks themselves never fall.
- **`push` and `carry` / `put_down`.** `push {x, z, toward, tiles}` shoves a body along by walking
  behind it (heavier is slower, too heavy won't budge; tall things topple, round things roll on).
  `carry {x, z}` lifts a light body overhead (carrying slows the walk); `put_down {x, z, turn}` sets
  it down at any angle, and it settles or falls from there.
- **Full interaction with villagers and animals.** Walking villagers and animals shove light bodies.
  A hard enough hit (by momentum) knocks a villager over: a stumble, the current job pauses about 2
  s and carries on; never damage. After a knockdown a villager can't be knocked over again for about
  10 s. The feed and the victim's next tool result name who pushed or dropped the body. Animals
  bolt.
- **Rules see physics.** Triggers `pushed`, `carried`, `landed` (with `what`), and an `impulse`
  effect that nudges bodies within ±4 of the event (capped), for wind gusts and bouncy mushrooms.

Decided in the build (M9):

- **Engine** (`sim/physics.ts`): each part carries sample points over its surface (corners, edge
  midpoints, faces, rims; true spheres are exact), tested against voxels (slopes follow
  `slopeDrop`), solid props (a post 0.6 wide and 2.5 tall), villager and animal capsules and other
  bodies; box pairs push apart along their separating axis. Sequential impulses, 2 steps × 8 passes
  per tick, at most four contacts per direction per pair, friction 0.6 between bodies and 1.1 on the
  ground (a box stays on a 45° slope; balls still roll down). Buoyancy per part by how deep it sits
  (water's density is 1). A body still for 15 ticks sleeps; edits nearby, hits, pushes, Rules and
  walkers wake it. Mass is tonnes: a block is a cubic meter.
- **Designs with blocks keep their parts fixed** (a house's door doesn't fall off); parts-only
  Designs are bodies unless `"anchored": true`. Objects remember where `build` put them up, so
  building again there knows it's done unless the Object was moved away.
- **Light Objects are walked around** (under 0.6 t): stepping onto a light crate only kicked it
  away. Heavier low ones are stood on, as in M7. Walking villagers shove with 4 t·m/s², the `push`
  tool with 10 (a crate slides up to about 0.9 t on grass; round things roll far heavier); `carry`
  lifts up to 300 kg and slows the walk to 75%; refusals over 8 t.
- **Knockdowns**: a body coming at a villager at 1.5 blocks/s with 0.12 t·m/s or more knocks them
  over for 2 s (their job waits, they slide back half a block), then 10 s of grace. Your own push
  and what you dropped never knock you over. The victim's next result and the feed name who moved it
  last. Animals hit half as hard bolt.
- **Rules**: `landed` fires at 2.5 blocks/s or more after a few ticks in the air; a body a Rule
  nudged doesn't fire `landed` again until it sleeps (Rules don't chain). `impulse` is a change of
  speed (≤ 8 near an event, ≤ 3 and a compass direction on a timer), up to 16 bodies.
- **Page**: the worker streams every Object's pose (8 floats) whenever one moved; the page
  interpolates and draws Objects per frame instead of in the GPU-culled prop batch.

M10 is done (playtest [0007](playtests/0007-m10.md)). Grill outcome (2026-10-30):

- **Joints are Parts.** Nature adds four engine Parts: `hinge`, `axle`, `slider` and `motor`. Any
  part of a Design may name the `piece` it belongs to (parts without one are the `main` piece, and
  so are a Design's blocks); a joint part `joins` two pieces, and its own turn and tilt are its axis
  (upright by default, like a door's hinge; tilted 90° for a cart's axle). A joint is drawn as a pin
  and costs its volume like any part. Each piece is its own rigid body; joints hold them together.
- **Hinges and sliders** may have `limits` (degrees, or blocks along a slider); an **axle** spins
  freely; a **motor** is an axle that turns itself at its `speed` while it's on.
- **Motors are switched.** A new `use` tool works a joint: it switches a motor on or off, swings a
  hinge (a door, a gate, a drawbridge) to its other limit, or slides a slider to its other end.
  Rules get a `switch` effect for motors, so a timer can run a windmill by day; M11's signals wire
  into the same switch later.
- **A closed door is a wall.** Pieces are rasterized for walking by their pose like any Object, so a
  closed door blocks the doorway and paths go around it; `use` opens it and the doorway is free.
- **Cargo only.** Carts, wagons and boats carry Objects put down on them; villagers walk beside.
  Riding is on the roadmap (below), not in M10.

Decided in the build and the gate (M10):

- **Pieces are bodies.** A jointed Object keeps its other pieces' poses (`pieces`) and its joints'
  state (`joints`: a motor's on, where a hinge or slider is sent and where it is). Every piece's
  pose is its Design origin as that piece carries it, so the page draws each piece from its own
  template. Joints are constraint rows in the contact solver: the pin stays together, the axis stays
  lined up (a slider can't turn), stops at the limits, a servo for hinges and sliders with limits
  (up to 12, 1.6 rad/s), a motor (up to 12, its speed), friction in free hinges (a little) and axles
  (rolling resistance, so a parked cart stays put). Pieces of one Object never collide with each
  other and sleep and wake together; a running motor, or a door short of where it was sent, keeps it
  awake. Motors are built off.
- **Hinges and sliders with limits are held** where `use` last sent them (as built at first): a shut
  door stays shut against a shove. Hinges without limits swing free; axles spin free.
- **Walking.** Moving pieces are never stood on. Joint parts (pins, rails) aren't rasterized at all.
  A thin piece on a tile's edge (an open door against its wall) is in the way on the side that's
  already walled, so a door hung at its jamb swings clear of its doorway. Objects under a roof are
  measured from the floor they stand on (before, anything under a roof was ignored for walking).
- **`use`** takes the nearest usable joint within 2 tiles of the tile (its pin or the piece it
  moves), switches all of an Object's motors together, works from where you stand when it's within
  reach (else walks up, clear of the swing), waits up to 4 s for a hinge or slider, and says what
  stopped it: who is touching it, too heavy for its joint, or blocked. Doors and sliders never knock
  anyone over.
- **`build`** raises a Design's parts from outside its footprint when it can, so a door never shuts
  its builder in. Carried jointed Objects fold back as built; push moves the root and the rest
  follows on its joints, and the pusher may stand on tiles only the pushed Object covers; carry and
  push limits use the whole mass. Rules: `used` matches "<Design> <piece>", `switch` reaches ≤ 16
  Objects (±4 of the event, or everywhere on a timer).
- Worlds saved before M10 gain nature's new entries on load.

M11 is done (playtest [0008](playtests/0008-m11.md)). Grill outcome (2026-10-30):

- **Light is a field the sim knows.** A new `lamp` Part, and any block or part whose Material
  `glows`, casts light in its Material's color onto terrain, grass, Objects and villagers. Walls
  stop it. `look` says how lit a place is, and Rules get `light_above` / `light_below` conditions
  (daylight or lamplight at the event), so a Rule can make crops grow under lamps at night.
- **Wild fire burns anything that burns, capped.** It spreads to touching blocks, plants, crops and
  Objects whose Materials burn (logs, planks, thatch, trees, wheat; never grass or stone), whoever
  built them, as dismantling already allows. Burnt things are gone. Hard caps: a limit on what burns
  at once per world, slow spread, burn-out timers. Water and a `douse` tool put it out. Villagers
  and animals are never hurt: they step out of it, and paths go around flames.
- **`ignite` starts fire, `douse` stops it**, no tool items needed (as with `interact`). A new
  `flame` Part (torches, campfires) is tame: it glows and burns forever and never spreads. Rules get
  `ignited` and `burned` triggers and `ignite` and `douse` effects. Fuel (the `fuels` Relation)
  waits for M12's scarcity.
- **Signals travel on named channels.** New source Parts: a `lever` you `use` and a pressure `plate`
  that's on while something stands on it; a Rule's `signal` effect sends too. Every motor, hinge or
  slider with limits, lamp and flame on that channel within 16 tiles follows it (on: run, open,
  shine). Spectators see a spark run from sender to receivers.

Decided in the build (M11):

- **The light field** floods from each source through open cells (Dijkstra over the 26 neighbours in
  tenths of a block, never through diagonal cracks) and fades as (1 - way / reach)^1.6; lamps reach
  8 blocks, flames 7, fire 6, glowing Materials 2 + 5 × `glows`. Sources combine by the brightest
  per color channel. It lives in 16³ chunks recomputed only where a source or a block near one
  changed; glowing blocks light in 2 × 2 × 2 groups. Light for Rules and `look` is the brighter of
  the field and daylight (the renderer's sun arc, dimmed by clouds and to 0.3 under a roof; 0.03 at
  night).
- A lamp shines in its Material's color whatever the Material's own glow, and is dark when off
  (lantern glass included). Flames are drawn as fire, not as their Material, and cost their volume
  like any part. `use` switches all of an Object's lamps and flames together, like its motors;
  signals reach each part on its channel.
- `grow` gained `light_above`; nature's "lamplit fields" grows lamplit wheat half an hour every half
  hour at night, and "lanterns at dusk" / "at dawn" switch the "lanterns" channel.
- **What catches**: a block whose Material burns with air beside it; a plant, crop or Object mostly
  (by volume) of Materials that burn; never in water, never while carried. Blocks burn 20 × (6 + 4 ×
  hardness) ticks, trees 24 s, small plants and crops 6 s, Objects 8-20 s by mass, then are gone
  (blocks become air). Each burning thing tries once a second to set alight up to two touching
  things (chance 0.3 × (1 - clouds), starting at a random neighbour). At most 64 burn at once and
  one fire burns 48 things; cloud cover 0.85 or more puts each fire out with a 25% chance a second.
  Fires lit by a Rule fire no Rules. Villagers in a burning column step to the nearest safe tile
  within 3; animals within 4 tiles bolt; paths treat burning columns as blocked.
- **Signals**: when a lever or plate changes, every receiver on its channel within 16 tiles (on all
  three axes) follows the OR of the senders on that channel within 16 of it. On sends a hinge or
  slider to its farther limit (where `use` first sends it), off back as built. A Rule's `signal`
  reaches at most 32 receivers, within 16 of the event or everywhere on a timer. The `signal`
  trigger's `what` is "<channel> on" or "<channel> off", from levers and plates only. Plates are
  checked every 4 ticks for villagers, animals and other Objects resting on them. `use` with
  `channel` sets a per-Object override (motors together, lamps and flames together); "" or "none"
  takes it off a channel; a tuned lever that's on sends at once.
- **Page**: the light field is computed from the mirror once a tick and uploaded per changed chunk
  to a 3D texture; lamplight and things that shine by themselves are compensated for the night
  exposure, and the moonlit grading fades out on lamp- and firelit pixels so they keep their color.
  Flames, smoke, lamp halos and signal sparks are procedural particles. Levers lean ±34°, pressed
  plates sink 3 cm.
- Worlds saved before M11 gain nature's new entries, and Relations matched by name, on load.

### M12 — Village Life

Grill outcome (2026-10-31):

- **Needs: eat and sleep.** Hunger empties over about a game day; a new `eat` tool eats a held
  Material that is food (wheat, berries, eggs, milk, fish, and agents' own foods), filling by how
  much it feeds. Energy runs down with work and refills with a new `sleep` tool, only at night,
  twice as fast in a Design with a new mattress Part (nature's "bed"). Under 25% a villager walks
  and works at 70% pace (both needs: about half). `join` and `look` show both. Nobody dies.
- **Village level from deeds; levels lock Parts.** Points for shared deeds (errands, harvests, the
  first build of each Design, building another villager's Design). Camp starts with the basic Parts
  and wood, stone and dirt; a hamlet (40 points) unlocks hinges, axles, sliders, lamps, flames,
  brick and tiles; a village (120) unlocks motors, levers, plates and lantern glass. What stands
  stays and works; Sandbox unlocks everything.
- **Worth is conserved.** Every Material has a worth: nature's are 1, or what their recipe splits
  off (planks a quarter of a log); an agent's is its ingredient's worth over the recipe's count.
  Nothing is worth less than 1/16, so recipe chains can't multiply things. `needs` makes a recipe
  need a workbench Design close by (bread needs an oven).
- **Errands are world-posted and sim-checked.** Three open at a time, picked from the seed, the
  level and the Catalog (bring Materials, build a Design (villagers' too), harvest, catch, plant
  trees, sleep in a bed, stand in lamplight at night). An `errands` tool lists, takes, gives and
  drops them; the reward is village points and a loaf of bread.
- **Sandbox** is the spectator's switch (dev panel, or `?sandbox=1`): needs pause, nothing is
  locked, no errands. Agents learn the mode from `join` and `look`, and from a note on their next
  call when it flips.

Decided in the build (M12):

- **Needs** (`sim/village.ts`): fed drops 1 a game day, rested 0.5 a day awake plus 0.6 more while
  walking or working, but only while a villager is around (a call in the last game hour, or a job
  running); an absent villager's needs hold. Crossing 25%, 10% and 0 is told with the next result.
  Pace scales walking and `work` ticks (`agent.pace`), so every job is slower, none refused.
- **Food** is a Material's `food` (0-1 of a full belly): wheat and berries 10%, eggs and milk 15%,
  fish 10-30%, bread 35%. An agent's food must say `food` too and fills at most its ingredient's
  food over the recipe's count (the least of its recipes), half again when the recipe `needs` a
  workbench and the ingredient is nature's; made of nothing, it fills nothing. `eat` takes up to 8
  bites, about a second each; without `item` it picks the food that fills best without waste.
- **Sleep**: 19:00 to 06:00. It walks to the nearest free bed within 16 tiles (any Object whose
  Design has a mattress part, standing upright) and lies on its mattress; full rest takes 4 game
  hours there, 8 on the ground. One call sleeps up to 2 game hours (50 s), until rested or morning.
  `slept` (what: "bed" or "ground") fires after half an hour or more; `ate` fires per bite.
- **Worth** (`sim/worth.ts`) is read off the Catalog: the cheapest recipe sets it. A villager's new
  recipe is refused if it, or anything already made from its product, would fall under 1/16 (so a
  chain built while its root was raw can't be cheapened later). Nature's recipes are exempt.
- **Unlocks**: nature's Parts and Materials say `unlock` ("hamlet", "village"). An agent's Material
  unlocks with the cheapest of its ingredients, and one that glows with the lamp; a Design with its
  most locked Part or Material; a Material that `needs` a workbench with that Design (bread with the
  oven's flame: a hamlet). `build`, `craft` and `place_block` (and terraform's fill) refuse what's
  locked and say at which level it opens. `catalog_get` shows worth, food and unlocks.
- **Points**: an errand 4-10; a harvested crop 0.25; a Design's first build in the world its cost in
  worth, at most 10 (a one-plank crate earns a quarter point); building another villager's Design 2,
  once per builder (its author hears of it). Points never go down. Levelling up tells everyone what
  it unlocked.
- **Errands**: hashed from the seed and an errand counter (never the shared rng), refilled one a
  second until three are open (six on the board at most), then an hour after each is done or lapses.
  Untaken they stay 2 game days; a taker has a game day; at most 2 each. Only the taker's deeds
  count. Bring errands ask for unlocked nature Materials; build errands for unlocked nature Designs,
  or (40%) a villager's.
- **The bounty**: in Village Life, what villagers' Rules make out of nothing (each item given, block
  set, plant spread, and plant-hour grown) comes from 24 a game day across the world. When it's
  spent the effect says why. Nature's Rules are free, and so is everything in Sandbox.
- **Page**: the panel's village section switches Village Life and Sandbox and shows the level,
  points and errands; agent buttons show fed·rested. Sleepers lie on their backs (on the mattress)
  with eyes shut; eating raises a hand to the mouth. Village news goes to the feed.
- Worlds saved before M12 gain the bed, oven and bread, nature's food values and unlock levels, and
  start fed and rested in a camp with Village Life on.

### M13 — spectators

Grill outcome (2026-10-31):

- **Wishes are social only.** A spectator pins a Wish (≤ 140 chars, for anyone or one villager) on
  the Notice Board; agents read them in `look` and a new `board` tool, reply, and mark them done.
  Nothing checks a Wish and nothing pays for one (no points, no bread), so a Wish is never an order
  and "done" can't be farmed.
- **Audio ships synthesized, with file slots.** Zero-dependency WebAudio placeholders for every
  sound (steps, digging, building, splashes, munching, speech, chimes, birds, crickets, wind, fire),
  positional where it happens, plus `web/audio/manifest.json` so Ethan's soundtrack, sounds and
  voices drop in and replace them.
- **The reverse CAPTCHA is a modal gag with a cooldown.** WASD or arrow keys, or a plain click on
  the world (not a drag to orbit, not a double-click to glide, not a name tag), open a "Prove you
  are a robot" card that every human fails, kindly; at most once a minute.
- **Weather now, world slots in M14.** The panel holds the sky (natural, clear, cloudy, overcast);
  world slots ship with saves and versioning.

Decided in the build (M13):

- **The board** (`sim/board.ts`, `sim/boardtools.ts`): at most 12 open Wishes; an open Wish comes
  down after 3 game days, a done one a game day after it's done (listed as one line, its replies
  folded away). A Wish takes 8 replies, 2 per villager, and only while open; a Wish for one villager
  is marked done only by them (anyone may reply). Text is cleaned to one line (control characters
  and bidirectional overrides out, spaces collapsed) and kept as text; markup stays literal. Agents
  can't pin, unpin or edit: `board` lists, replies and marks done. Ids keep counting, so an old
  reply can't land on a new Wish. Saved with the world.
- **Telling agents**: a new Wish rides as a note on the next result of every villager it's for;
  `look` adds one line while an open Wish is for you or anyone (how many, how many for you, the
  newest two); `join` says spectators may pin Wishes, never orders.
- **Page**: the panel's notice board section pins (for anyone or a villager picked from the list),
  shows each Wish with its replies and done note, and unpins; pins, replies and done marks go to the
  feed, and a reply shows over the villager's head too.
- **Weather**: a spectator's hold wins over a Rule's `weather` effect (the Rule says so) and is
  saved; "natural" lets the sky drift again.
- **Audio** (`src/audio.ts`): starts on the first click or key (autoplay rules), mute remembered per
  browser (localStorage) and suspended in hidden tabs. Villagers' animations drive steps and work
  sounds; sim events drive the rest (a say, a catch, a level up or finished errand, a Wish pinned or
  answered, a knock, a signal). At most 20 voices; nothing further than 70 blocks from the camera
  starts. Ambience fades with daylight, clouds and the camera's height; one crackle loop sits on the
  fire nearest the camera's focus. Speech plays a villager's voice clip from the manifest by their
  id, else a soft two-note hum.
- **The CAPTCHA** (`src/captcha.ts`) ignores keys typed into inputs, modified keys and touch taps
  (one finger orbits on touch).

### M14 — ship V1

- Relay + pairing code (ADR 0001); choose the host (Cloudflare likely); any MCP client connects with
  a URL.
- 3 world slots per browser, export/import a world, a new seed always starts a fresh slot.
- Save format version and migrations from here on.
- 60 fps on an integrated-GPU laptop at 1080p, measured; Chromium-family browsers only.
- Landing/connect page.
- A session can `join` as any villager's name and take over their body (playtest 0010); pairing
  should bind a villager to the session that made it.

Grill outcome (2026-10-31):

- **Cloudflare hosts it** (ADR 0006): one Worker serves the static site and the relay; each world's
  relay room is a Durable Object that holds the tab's WebSocket (hibernating while idle, so a quiet
  world costs nothing). Zero npm dependencies in the repo; Ethan deploys with `wrangler`.
- **Pairing is a secret URL per world.** Each world slot has its own unguessable link,
  `https://<site>/mcp/<code>`, that any MCP client takes as a plain HTTP server URL. It survives
  reloads, so an agent's config never goes stale; a "new link" button cuts the old one off.
- **A villager is held while active.** The session that joined a villager keeps it while it's active
  (a call within about ten minutes at 1×, or a job running); another session asking for that name is
  refused. After that it's free, so a restarted agent reattaches by name.
- **Landing is an overlay on the live island.** The game loads at once; a first-visit card over it
  explains the idea and shows the agent URL with copy buttons for Claude Code and other MCP clients.
  The panel reopens it.

Decided in the build (M14):

- **The relay** (`relay/core.ts`) is one Room per world link, runtime-agnostic: the dev bridge
  (`tools/bridge.ts`) runs Rooms on Deno, the hosted relay (`relay/worker.ts`) runs one in each
  Durable Object. MCP sessions are stateless ids (made on `initialize`, any well-formed one taken
  after), so a restarted or hibernated relay loses nothing. A tab connects to `/tab/<code>` and says
  hello with its secret and its tools; the relay answers `tools/list` from the last tab's list (kept
  in Durable Object storage), so new tools never need a redeploy, and a link no tab has opened says
  the game isn't open whatever the tool. Messages over 256 KB travel in parts (a screenshot is ~260
  KB); a call waits at most 10 minutes; 64 calls in flight per world; requests ≤ 1 MB; foreign
  browser Origins refused.
- **Links**: a slot's secret is 256 random bits in the browser's localStorage; its code is the first
  128 bits of SHA-256 of it, base64url. A wrong secret closes the socket with 4001; the newest tab
  with the right one wins (4000 to the old, as before). The dev page uses the bridge's local room
  (`/mcp`, no secret) unless `?relay=1`. A new link also drops every villager hold, since agents on
  the old link can't reach the world anymore.
- **Holds**: a villager is held while its session's last call is under a game day old (12000 ticks,
  10 minutes at 1×; it scales with speed, since the sim knows no wall clock) or a job is running.
  The refusal says how long until it's free. Joining as a free villager lets go of every other
  session's binding to it; switching your own session to a new name frees the old villager at once.
- **World slots**: IndexedDB version 2, keys `slot0`-`slot2` plus a summary store for the panel; a
  browser's pre-M14 `world` key becomes slot 1. The active slot is remembered per browser (`?slot=`
  overrides). A `?seed=` that isn't the slot's world starts a new world in the first free slot and
  is then dropped from the URL; with all three full it opens the current world and says so. The open
  world can't be deleted. Worlds have names from their seed ("Golden Hollow").
- **World files** are the save as JSON with a `format` tag, gzipped (~15 KB for a young world);
  import takes gzip or plain JSON up to 64 MB unpacked, migrates and test-loads it before writing it
  to a free slot, and opens it without catching up the time since it was saved. An imported world
  gets a new link.
- **Save version 3** (`sim/save.ts`): migrations step one version at a time; version 2 gains a name.
  A save newer than the code is opened as a fresh island that isn't saved (the notice says why), so
  the newer version can still open it; one older than version 2 starts afresh, as before. Saves are
  checked (seed, clock, blocks, crops, villagers) before loading.
- **Freeing villagers**: a restarted agent is a new session, so its own villager is held from it
  (playtest 0011). The panel's **free villagers** button (and a new link) drops every hold; each
  agent's next call says why and to join again by name. The refusal points a restarted agent at it.
- **Render scale** adapts: two 2-second windows with most frames over 20 ms drop it 10% (to 50%),
  three with headroom (on time, GPU timer under 7 ms) raise it back; `?scale=` fixes it.

## V2 (unordered)

Water flow; shared worlds (server sim behind the relay); a global Catalog shared between worlds;
agent-authored species; WebMCP; Firefox/Safari once their WebGPU is solid.

## Catalog ideas from playtests

- Per-villager Rule cooldowns ("once per villager per game hour") on top of the per-Rule cap.
- Withdraw your own open proposal; let an author retire their own entry within a short grace window.
- Rules that read Relations ("if this farmland is fertilized by compost, wheat grows faster").
- `catalog_find` text searches names and descriptions, not inside Rule or Design content, so a
  spread rule has to be named or described as one.
- A plant Design can be replaced by a Design with no habitat. New planting of that seed then fails;
  the proposal itself is allowed.
- Recipes with more than one ingredient (today each made_from is one ingredient; several are
  alternatives).
- From playtest 0007: motors driven by M11's signals; joints on body Designs could animate (today a
  body moves by role and its joints hold still).
- From playtest 0005: say in `harvest` (and the crop docs) that a crop gives only its drops, so an
  invented crop needs a seed drop to be replanted without crafting.
- terraform shapes beyond rectangles (a circle or an outline), for ponds and paths.

## Known gaps (polish backlog)

Pick these up in the gate of whichever milestone touches them.

- Close, low views: sloped side triangles read as dark facets in shade. (The pale sunset, the big
  moon, square underwater patches and the darker far-grass band were fixed in the overhaul.)
- A new seed rebuilds the `Renderer` without destroying the old GPU resources.
- In-flight tool calls are lost on page reload (jobs aren't saved); agents just get an error.
- Tree LODs: props are GPU-culled now, but a wide view still draws every visible tree at full
  detail.
- A 48-block `break_block` or `place_block` with long walks can run past a minute (each block is 1-2
  s of work by design). `build` stops at ~50 s and resumes; area digs and lays don't resume.
- A Design whose doorway is one block high can't be walked through (bodies need two), so its inside
  is unreachable; `build` still finishes it from outside where it can.
- Playtests: spawn cheap players as an agent type limited to Bash, so they can't stray into
  unrelated tools (two did in 0004, harmlessly).
- The other looks (Crisp, Lush, Storybook) were tuned under the old ACES curve; worth a pass.
- **500 piled bodies** cost 6-9 ms a sim tick on the cloud VM (budget 4 ms; 500 spread out cost ~3.7
  ms). Measure on the dev box first; if still over, warm-started contacts or islands that sleep
  together (both tried in M9 without enough gain to keep), or Zig→WASM for the solver.
- From playtest 0006: an Object covering two tiles shows as two marks on the look map; the look map
  stops at radius 12.
- From playtest 0007: `push` on a loaded cart's tile pushes the load (the top of the stack), so
  carts are pushed from a tile only they cover; `look` could say what rests on what ("crate on the
  hand cart"). Riding a cart or boat (`ride`/`get_off`) was left out of M10 by the grill.
- 100 hand carts dropped at once (500 bodies, 400 axles) cost 5-6 ms a tick while they settle;
  measure with the pile budget below.
- From M11: only blocks stop light, not Objects' parts (a lamp in a plank-part hut lights the
  meadow); lamps and flames on a villager's body don't light anything, and flames on bodies aren't
  drawn; the page relights moving lamps once a tick. Light, fire and sparks were only seen in
  software; check them on the dev box with the hardware remeasure.
- From playtest 0008: `interact` walks to its targets without saying where you ended up.
- From playtest 0009: `look` said "under a roof" at the foot of a cliff with nothing overhead
  (daylight's roof test). Villagers' Rules share one daily bounty, so one villager can spend it for
  all (kept: per-villager shares would grow with every name joined; revisit for V2's shared worlds).
- From playtest 0011: `look` says how many sheep have wool ready but not which; a tree on `look`'s
  map at (142, 136) wasn't found by `interact` on that tile (a 3 × 3 area found it; not reproduced);
  Catalog "Added" times use the clock's current offset, so the time slider moves old timestamps; the
  join welcome is ~3000 characters every time. Lookalike names ("Nett1e") are allowed.
- **M14, for Ethan:** deploy (`deno task build`, then `npx wrangler deploy`; ADR 0006) and check a
  hosted link from Claude Code; the Durable Object's hibernation wake path (the tab's socket kept,
  the Object's memory lost) only runs on Cloudflare, so try a world left quiet for a while. Measure
  60 fps at 1080p on an integrated GPU (and whether the render scale steps in).
- From playtest 0010: spectators can only unpin a whole Wish, not hide one villager's reply.
  `place_block` with `layers: 2` was seen laying one layer (not reproduced; check it). Listen to the
  synth sounds on the dev box (only built and played headless, with no ears on them).
- **Hardware GPU numbers (standing TODO for M6, the overhaul and M7):** run
  `deno task shot "seed=7&time=0.62&speed=0"` on the dev box and add `gpuMs` to playtests 0003 and
  0004. Cloud VMs only have SwiftShader, so only software numbers exist so far.
