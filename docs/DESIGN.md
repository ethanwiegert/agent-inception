# agent-inception — design

A sandbox you can watch your agent live in. A chill, top-down 3D block island with farming,
building, animals and crafting, played entirely by AI agents over MCP while humans watch. The game
is a framework: it gives agents a small custom physics engine and a Catalog of everything that can
exist, and agents extend both. As agents get better, the world gets richer.

What happens next is in `ROADMAP.md`; the words are in `../GLOSSARY.md`; hard-to-reverse decisions
are in `adr/`.

## Pillars

1. **Efficient.** Runs in the browser and runs very well. WebGPU only. Budgets are numbers, measured
   by our own harness, not vibes.
2. **Custom.** Zero runtime dependencies. Our own renderer, simulation, physics, noise, math, mesh
   formats and agent transport. Dev tooling is just Deno (type check, bundle, test, fmt, lint,
   serve) plus Blender, and later Zig for WASM kernels.
3. **Agent first.** Every game action is an MCP tool. Humans watch; if they reach for WASD or click
   the world, they get a reverse CAPTCHA (a gag).
4. **Open-ended.** The world grows with its agents. Everything we ship (blocks, crops, trees, the
   farmer, their behavior) is Catalog data in the same formats agents author, with no special cases
   in code. Our content is the first entries and worked examples, not the limits (ADR 0002).

Ethan authors the soundtrack and voices. Open source under MIT, developed in the open toward V1.
Agent players are any MCP client; the polished path is cost-effective agents spawned from Claude
Code (no API key in the game). How long an agent plays (one session or a looping resident) is the
user's choice.

## Decisions

| Topic         | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audience      | V1: a hosted static site; each visitor points their own agent at their own world. V2: shared worlds and a global Catalog.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Platform      | Browser, WebGPU only, Chromium-family for V1. Linux Chromium needs `--enable-unsafe-webgpu --enable-features=Vulkan`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Toolchain     | Deno only (check, bundle, test, fmt, lint, serve). No npm/jsr packages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Language      | TypeScript, data-oriented (typed arrays). Hot kernels move to Zig→WASM only when the profiler says so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Where it runs | The sim runs in the visitor's tab; a hosted relay pipes MCP to it through each world's secret link (ADR 0001); one Cloudflare Worker hosts the site and the relay, a Durable Object per link (ADR 0006).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Simulation    | Deterministic fixed-tick core (20 Hz, seeded PRNG) in a Web Worker, no DOM. Same code runs headless in Deno for tests (and a V2 server).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Rendering     | Main thread, WebGPU, HDR + 4× MSAA, sun/moon shadow map, cloud shadows, GPU water, compute-culled grass and props, PBR Neutral tonemap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| World         | 256×256×64 voxel island in 32×32 chunk columns: rolling hills, river valleys, beaches, sea to the horizon.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Catalog       | Append-only store of kinds (Materials, Parts, Designs, Rules, Relations), separate from the World store of things (ADR 0003).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Behavior      | Rules: validated JSON trees, trigger → conditions → effects through engine operations. No agent code (ADR 0004).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Physics       | Bodies follow the walkable surface, A* (climb 1, drop 2, wade 1, swim 3; hop down 4 only when there's no other way). Objects built from parts are rigid bodies (M9): mass from Material density, they fall, stack, topple, roll, float or sink and sleep when still; light ones are walked around, low heavy ones stood on. Joints (M10): hinge, axle, slider and motor Parts join a Design's pieces, each its own body; a closed door is a wall. Fields (M11): lamps, flames, fire and glowing Materials light a field over the cells that walls stop; wild fire spreads to what burns, capped; signals travel on named channels from levers and plates to lamps, flames, motors and doors. |
| Making        | Designs combine Blocks (voxel grid: walls, floors, roofs) and Parts (free-form shapes and mechanisms); a built Design's parts become one Object, turned in quarter turns, paid for by volume. `craft` follows made_from recipes.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Villagers     | One world, many agents: each MCP session `join`s a named villager; rejoining reattaches it once no other session holds it. Bodies are 3D Designs from Parts (ADR 0005).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Animals       | Sheep, cows, chickens, ducks and fish schools: species in sim code until V2; their products and drops move to the Catalog.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Village Life  | On by default (M12): Needs (hunger and rest; `eat`, `sleep`, beds; low needs slow a villager, never kill), worth that recipes pass along so chains can't multiply, a village level (camp, hamlet, village) from shared deeds whose Unlocks gate Parts and Materials, world-posted Errands, a daily bounty for villagers' Rules. Spectators can switch to Sandbox anytime.                                                                                                                                                                                                                                                                                                                    |
| Spectators    | Watch, follow, pin Wishes on the Notice Board, control time/speed/look/weather/world slots/Village Life. They never move villagers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Time          | Day/night cycle, one game day per 10 real minutes at 1×. Offline progress = elapsed ticks (capped at 3 days) on reload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Persistence   | IndexedDB in the worker, every 5 s and on tab hide. 3 world slots per browser, export/import as gzipped files, versioned saves with migrations (`sim/save.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Audio         | WebAudio layer with positional sound and event hooks (M13), synthesized placeholders until Ethan's soundtrack and voices land in `web/audio/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## The Catalog

The Catalog is the world's queryable database of every kind of thing that can exist and how those
things relate. The World is a separate store of the things that exist here, each pointing back to
the entry it was made from.

- **Elements** are what things are made from: **Materials** (a look plus physical properties such as
  density, hardness, burns, glows; a `form` of block, item, or liquid — everything a villager holds
  is a Material; agents can invent new ones from existing ones) and **Parts** (shapes and mechanisms
  the engine simulates; only the engine adds Parts).
- **Designs** are named recipes of Blocks and Parts in Materials. Any villager can build any Design,
  so agents learn from each other. Props are Objects grown from nature-authored Designs.
- **Relations** connect entries. Engine Relations have effects the world enforces (_made from_,
  _drops_, _grows into_, _opens_, _fuels_, _is food for_, _needs_); free Relations are labels agents
  invent (_sacred to_, _looks like_) that only record knowledge. _Forked from_ is kept for every
  fork, so you can trace how ideas evolve.
- **Rules** say when something happens, under what conditions, and what the engine then does. Our
  own behavior (wheat grows, wool regrows, fire spreads) is written as Rules for agents to read.
- **Change** is append-only. Entries are never updated or deleted; agents fork them. An entry's only
  mutable fields are `retired` (nothing new is made from it; existing things stay) and `replaced_by`
  (what the world produces instead). Both change only through a **Proposal** that the villagers pass
  by **Vote**, so everyone sees when and why the foundation moved.
- **Scope**: one Catalog per world in V1, exported and imported with the world. A global Catalog
  shared between worlds is V2.

## Village Life and spectators

Village Life gives agents reasons to act without a fail state: Needs, a shared village level whose
Unlocks make new Elements available, and Errands any villager may take. A world in Sandbox has none
of it and everything unlocked. Spectators pin Wishes (≤ 140 chars) on the Notice Board; agents read,
answer and complete them, but a Wish is never an order: nothing checks or pays for one (M13).

- **Needs** (`sim/village.ts`): fed and rested, 0-1, run down while a villager is around (a belly
  empties in about a game day; work tires). Under 25% each slows walking and working to 70%. `eat`
  fills by a Material's `food`; `sleep` works at night, twice as fast on a mattress (a bed).
- **Worth** (`sim/worth.ts`): every Material is worth what its cheapest recipe passes along (a log
  1, planks 1/4), never under 1/16, so recipe chains split worth instead of multiplying things. An
  agent's food feeds no more than what it's made of (half again cooked at a workbench, `needs`).
- **The village** grows from camp to hamlet (40 points) to village (120) on errands, harvests and
  the first build of each Design. Nature's Parts and Materials say which level `unlock`s them;
  `build`, `craft` and `place_block` refuse what's still locked. What stands keeps working.
- **Errands**: three on the board at a time, hashed from the seed and the level (bring, build,
  harvest, catch, plant, sleep in a bed, lamplight at night); `errands` takes, gives and drops them
  for points and a loaf of bread.
- **The bounty**: villagers' Rules conjure (give, set_block, spread, grow) from 24 a game day.

## Safety

Agents author content, and V2 worlds will be shared, so every limit holds from M5 on:

- Every authored entry is validated against its schema, with caps on names and text, part counts and
  Rule depth. Unknown fields are refused rather than dropped. The numbers are in `ROADMAP.md` → M5.
- Rules run under a per-tick step budget, can't loop without limits, and act only through engine
  operations.
- Authoring is rate-limited per villager per game hour.
- Every agent string (names, speech, journals, Wishes, entry names) is rendered as text, never HTML.
- World links are unguessable (128 bits of a hash of a 256-bit secret only the tab knows); a tab
  proves the secret to take a link's room, and the relay and bridge check Origin. A villager is held
  by the session using it, so agents sharing a link can't take over each other's bodies.
- Each milestone's adversary playtester tries to break these.

## Art direction

Settled with Ethan while workshopping M1; keep to it unless he asks otherwise.

- **Natural** is the default look (`render/look.ts`): Crisp blocks evolved toward smoother, more
  realistic shading after Ethan asked for it. Crisp, Lush and Storybook remain as alternates.
- Colors stay true (2026-10-28 overhaul): the Khronos PBR Neutral tonemap keeps a Material's hue, so
  an agent's "#b08850" planks read as that color, skies and sea stay blue instead of going
  grey-white, and sunsets keep their warmth. A light contrast-adaptive sharpen keeps edges crisp
  after the MSAA resolve. Moonlit grading starts only once the sun is down.
- Hills shade smoothly (per-vertex ground normals) and material edges (grass/sand) are organic
  curves, not block steps. Water is clear and teal over sand, darkening with depth.
- Grass is dense, tall and fine: 64 blades per block, 0.6 tall, 0.05 wide, generated on the GPU.
- No lines across the screen: block grid outlines are off, and shadows get strong sky fill so step
  and cliff shadows read as soft shade, never black stripes.
- Terrain mixes single steps with some multi-step cliffs, and one-block rises are smooth slopes
  ("hills"), not stairs. Farmland and placed stone stay square.
- Every natural ground material meets its neighbours along organic edges (grass by the blade edge;
  sand, gravel, clay and dirt by a noise-wobbled lookup), never in block squares. Grass blends only
  with neighbours within a block of height, so it doesn't creep up walls or into pits.
- Skies: a warm twilight band hugs the horizon toward the sun; clouds are lit, thin edges bright and
  thick cores grey, with a silver lining toward the sun.
- Pacing is chill and methodical: ~2 blocks/s walking, 1-2 s per tile of work.
- Nights are dark and blue but readable; golden hour has long soft shadows.

## Agent transport

```
agent ──POST /mcp[/<code>]──▶ bridge (dev) / relay (hosted) ──ws──▶ game tab ──postMessage──▶ sim worker
```

- **Tools** are defined once in `src/sim/tools.ts` (JSON schema + handler). The tab sends the
  definitions to the bridge or relay when it connects, which lists them; the sim runs them.
  `screenshot` runs in the page (offscreen, 1024×640, villager name tags burnt in, so it works in a
  hidden tab).
- **Relay** (`relay/core.ts`, zero deps): a Streamable HTTP MCP server (JSON responses, no SSE,
  Origin-checked, stateless session ids), one Room per world link. It is a pipe, not an authority:
  the tab owns the world. Latest connected tab wins. The dev bridge (`tools/bridge.ts`) runs Rooms
  on port 5173 with the game (`/mcp` is a local room needing no secret); the hosted relay runs them
  in Durable Objects (`relay/worker.ts`). Messages over 256 KB travel in parts.
- **Sessions → villagers**: each MCP session `join`s with a name; joining an existing name
  reattaches that villager (inventory, journal, look) unless another session holds it (a call within
  a game day, or a job running). Each join hands back a rejoin key, so an agent whose connection
  reset (hosted agents' sessions come and go) takes its villager straight back. A new link drops
  every hold. Session bindings are saved, so a page reload doesn't kick agents. A hidden `_whoami`
  tool lets the page map a session to its villager; the page asks once per session and caches it, so
  calls don't wait on it.
- **Latency**: instant tools (look, say, Catalog reads) answer as soon as the worker runs them,
  without waiting for the next tick (2–6 ms through the bridge); jobs answer on the tick they end.
- **One tab drives**: the bridge serves the newest tab; a tab it replaced stays off the bridge until
  someone looks at it again, so two tabs never split an agent's calls between two worlds.
- **Tools run as jobs**: each tool call becomes a generator that advances one sim tick per `yield`
  and returns its result text. Area tools cover up to 16 tiles per call so agents spend few calls
  and calls stay under MCP client timeouts (seconds to about a minute).

### Tools today

| Tool                             | What it does                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `join`                           | Enter as a named villager (or reattach). Must come first.                                                                                                                                                                                                                                                                                                                                           |
| `look`                           | Text map (radius 3-12) with tile types, relative heights, crops, props, animals, villagers.                                                                                                                                                                                                                                                                                                         |
| `walk_to`                        | A* walk to a tile.                                                                                                                                                                                                                                                                                                                                                                                  |
| `till` / `plant` / `harvest`     | Area actions (≤16 tiles). Plant a seed, sapling or plant name; ground and growth time come from its habitat and `grows_into` (wheat: ~18 game hours). Harvest gives the ripe crop's drops (wheat: 1 wheat and 2 wheat seeds).                                                                                                                                                                       |
| `fish`                           | Walk to the bank, cast 1-5 times at a water tile; catches depend on schools, time, weather.                                                                                                                                                                                                                                                                                                         |
| `place_block` / `break_block`    | Lay any held block Material over an area (≤16 columns) stacked `layers` high (≤4; ≤48 blocks a call), or at a height `y` beside something solid; dig areas and layers down from the top, or upward from `y` (doorways). Digging gives the block's drops (grass and farmland give dirt), or the block itself; harder blocks take longer. Diggers work inside-out so they never end in their own pit. |
| `build`                          | Build a Design at x, z (on the highest ground under it, or `y`), `turn` 0/90/180/270: its `blocks` bottom layer first, ≤48 blocks or ~50 s a call (calling again carries on), then its `parts` as one Object costing each part's volume in its Material (at least 1). Checks the whole remaining cost up front. Never shuts the builder in or strands them on the roof.                             |
| `craft`                          | Make a Material from another along a made_from recipe (4 planks from a log), ~1 s a batch, up to 16 batches. Agents' recipes only make agent-authored Materials.                                                                                                                                                                                                                                    |
| `interact`                       | Gather from an area (≤16 tiles): chop trees, break rocks, pick flowers/reeds/lily pads/berries (they replant), dig up young saplings, take Objects apart for their Materials; shear, milk and collect eggs when the animal's product is ready (approaching slowly). Yields are `drops` Relations.                                                                                                   |
| `push`                           | Walk behind an Object and shove it 1-8 tiles toward a compass direction: heavier is slower, too heavy won't budge, tall things topple, round things roll on.                                                                                                                                                                                                                                        |
| `use`                            | Work a mechanism: swing a door, gate or lid on its hinge to its other limit, slide a slider to its other end, switch an Object's motors, or its lamps and flames, on or off, or flip a lever. With `channel`, tune it to a signal channel instead. Stands clear of the swing; says what stopped it.                                                                                                 |
| `ignite` / `douse`               | Set something that burns alight at x, z (an Object, a plant, a crop, the top block, or the block at `y`); fire spreads to touching things that burn and burns them away, capped. Put fires out over an area (≤16 tiles), about a second each.                                                                                                                                                       |
| `carry` / `put_down`             | Lift an Object up to 300 kg overhead (walking a little slower), then set it down on a tile beside you at any angle, on the ground or on what's there.                                                                                                                                                                                                                                               |
| `set_body`                       | Look like any Design with a `body` part that fits about 1.2 × 2.4 × 1.2 (roles animate); "farmer" goes back to the default.                                                                                                                                                                                                                                                                         |
| `terraform`                      | Raise, lower or flatten up to 8 × 8 columns, ≤64 blocks a call (flatten carries on); lowering gives what it digs, raising spends dirt or a named block; grass stays on top.                                                                                                                                                                                                                         |
| `eat` / `sleep`                  | Eat food you carry (bites fill by its `food`); sleep at night, in the nearest free bed within 16 tiles (4 game hours to rested) or on the ground (8), up to 2 game hours a call.                                                                                                                                                                                                                    |
| `errands`                        | The world's errands: list, take (2 at once), give what a bring errand asks, drop. Points and a loaf of bread each.                                                                                                                                                                                                                                                                                  |
| `board`                          | The Notice Board: list spectators' Wishes, reply to one, or mark one done (only its named villager, if it names one). Wishes are never orders and never pay.                                                                                                                                                                                                                                        |
| `say`                            | Speech bubble + activity feed line.                                                                                                                                                                                                                                                                                                                                                                 |
| `wait`                           | Rest 1-60 real seconds.                                                                                                                                                                                                                                                                                                                                                                             |
| `journal_write` / `journal_read` | Persistent notes per villager (last 50).                                                                                                                                                                                                                                                                                                                                                            |
| `screenshot`                     | JPEG centered on the caller, ~20 blocks across, 1024×640, with villager name tags.                                                                                                                                                                                                                                                                                                                  |
| `catalog_find` / `catalog_get`   | Search the Catalog (kind, text, author, property, related_to) or read one entry in full.                                                                                                                                                                                                                                                                                                            |
| `catalog_add` / `catalog_fork`   | Author a Material, Design, Rule or Relation, or fork an entry with changes on top.                                                                                                                                                                                                                                                                                                                  |
| `propose` / `vote` / `proposals` | Retire or replace an entry by lazy-consensus vote over one game day.                                                                                                                                                                                                                                                                                                                                |

## Terrain and bodies

- Natural ground (grass, dirt) slopes: a column top lowers each corner that touches ground exactly
  one block lower, unless something around that corner is higher or doesn't slope. That keeps
  neighbouring surfaces watertight; drops of 2+ stay as cliffs, and farmland and placed stone keep
  square edges. `World.slopeMask`/`slopeDrop` define the surface once; the mesher, the grass shader
  (via the surface texture's mask channel) and walking bodies all follow it.
- Terrain meshes are culled faces with per-vertex AO, one packed u32 per vertex; sloped tops get
  their normal from screen-space derivatives.
- Grass has no per-blade data: the vertex shader generates blades in a grid around the camera from
  the rgba16uint surface texture (height, block, slope mask, water). Editing the world rewrites it.
- Villagers wear the "farmer" Design by default, in their own shirt and skin tints; `set_body` puts
  them in any Design with a `body` part. Its head, arms and legs are posed from the sim (walking,
  working, idle life); parts with other roles ride on the body (ADR 0005).
- Spectators click a name tag (or the panel list) to glide over and follow that villager.

## Fields

- **Light** (`sim/light.ts`): lamps (on), flames (on), wild fire and blocks or parts whose Material
  `glows` are sources. Each floods outward through open cells (Dijkstra over the 26 neighbours,
  never squeezing through diagonal cracks), fading as (1 - way / reach)^1.6, and sources combine by
  the brightest per color channel. The field lives in 16³ chunks recomputed only where a source or a
  block near one changed; the sim reads it for `look` and Rules (with daylight worked out on its
  own), and the page computes the same field from its mirror once a tick and uploads changed chunks
  to an rgba8 3D texture (rgb stored as square roots, alpha the share of fire, which flickers).
  Shaders add `lampLight` to their key and sky light; glowing Materials and lit lamps shine by
  themselves. Glowing blocks light in 2 × 2 × 2 groups.
- **Fire** (`sim/fire.ts`): blocks, plants, crops and Objects that are mostly Materials that burn
  catch from `ignite`, a Rule, or something burning beside them. Each burning thing tries to spread
  about once a second; it burns 6-30 s by hardness and size, then is gone. At most 64 burn at once,
  one fire burns 48 things in all, heavy cloud (0.85+) puts fires out, and nothing burns in water.
  Burning columns are kept out of paths; villagers step out of them and animals bolt.
- **Signals** (`sim/signals.ts`): a lever (flipped by `use`) or a pressure plate (pressed while a
  villager, an animal or another Object rests on it) sends on its channel. Lamps, flames, motors,
  and hinges and sliders with limits on that channel within 16 tiles follow: on while any sender on
  the channel in range is on. A Rule's `signal` effect sends once. Channels come from a part's
  `channel` in its Design, or from tuning a built Object with `use`.

## Simulation

- Runs in a Web Worker (`src/worker.ts`) at 20 Hz; the page mirrors the world, which the worker
  sends whole once (voxels, heights and the generated props) and then patches with streamed edits,
  and interpolates villager positions between ticks. Nothing is generated twice.
- Crops grow from the clock, so idle progress is free; the page draws their growth from each crop's
  planting tick, so fields ripen smoothly and nothing is re-sent while they grow. A crop Design with
  `"look": "blades"` (wheat) is a swaying blade field on the GPU; any other crop draws its own
  parts, scaled up as it grows. A Rule's `grow` effect brings crops and young plants forward.
- Worldgen memoizes noise gradients per lattice point (bit-identical output, ~3× faster), and the
  mesher skips buried blocks (identical meshes, ~2.5× faster), so placing a block remeshes in about
  a millisecond per chunk instead of hitching the frame.
- Messages that arrive while the worker is still loading its save are queued, not dropped.

## Performance budgets

- 60 fps on an integrated-GPU laptop at 1080p (unmeasured so far; measured before V1); 144 fps on
  the dev box.
- < 2 MB transferred to first frame, < 1 s to first frame. Today: ~207 KB + ~114 KB minified JS;
  `__perf.summary().readyMs` (navigation to a drawable world) is ~0.5-0.9 s even under software
  WebGPU on the cloud VM.
- Sim tick < 2 ms without bodies; < 4 ms with 500 awake rigid bodies (M9 measured ~3.7 ms of physics
  for 500 bodies tumbling apart and ~6-9 ms for 500 crates piling onto each other, on the 2.1 GHz
  cloud VM; see playtest 0006). Joints (M10): 50 running windmills ~0.9 ms (playtest 0007). No
  per-frame allocations in hot paths.
- Measured on the RTX 2070 Super: ~2.5 ms GPU per frame with ~600k grass blades, water, clouds and
  12-tap soft shadows (~0.75 ms of that is MSAA resolve + post at the harness size). Before the
  2026-10-28 overhaul; not yet remeasured on hardware (see `playtests/0003-overhaul.md` for the
  software before/after).
- Props are culled on the GPU for the view and the shadow map; terrain shadow chunks against the
  light. Up close that removed nearly all prop cost (software: ~770 ms → ~8 ms of a frame).
- Fields (M11, cloud VM): 64 things burning cost ~0.06 ms a tick. The light field takes ~17 ms from
  scratch for 50 lamps and ~9 ms for a 20 × 5 glowing wall (once, or when a block near them
  changes); a moving lamp relights in ~0.6 ms a tick. With nothing lit the shaders skip the field.
