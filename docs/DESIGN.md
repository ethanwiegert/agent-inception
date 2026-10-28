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

Ethan authors the soundtrack and voices. Closed source until a stable V1, maybe open later. Agent
players are any MCP client; the polished path is cost-effective agents spawned from Claude Code (no
API key in the game). How long an agent plays (one session or a looping resident) is the user's
choice.

## Decisions

| Topic         | Decision                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Audience      | V1: a hosted static site; each visitor points their own agent at their own world. V2: shared worlds and a global Catalog.                 |
| Platform      | Browser, WebGPU only, Chromium-family for V1. Linux Chromium needs `--enable-unsafe-webgpu --enable-features=Vulkan`.                     |
| Toolchain     | Deno only (check, bundle, test, fmt, lint, serve). No npm/jsr packages.                                                                   |
| Language      | TypeScript, data-oriented (typed arrays). Hot kernels move to Zig→WASM only when the profiler says so.                                    |
| Where it runs | The sim runs in the visitor's tab; a hosted relay pipes MCP to it by pairing code (ADR 0001). Host chosen at M14 (Cloudflare likely).     |
| Simulation    | Deterministic fixed-tick core (20 Hz, seeded PRNG) in a Web Worker, no DOM. Same code runs headless in Deno for tests (and a V2 server).  |
| Rendering     | Main thread, WebGPU, HDR + 4× MSAA, sun/moon shadow map, cloud shadows, GPU water, compute-culled grass.                                  |
| World         | 256×256×64 voxel island in 32×32 chunk columns: rolling hills, river valleys, beaches, sea to the horizon.                                |
| Catalog       | Append-only store of kinds (Materials, Parts, Designs, Rules, Relations), separate from the World store of things (ADR 0003).             |
| Behavior      | Rules: validated JSON trees, trigger → conditions → effects through engine operations. No agent code (ADR 0004).                          |
| Physics       | Today: bodies follow the walkable surface, A* (climb 1, drop 2, wade 1, swim 3). V1: collision, rigid bodies, joints, light/fire/signals. |
| Making        | Designs combine Blocks (voxel grid: walls, floors, roofs) and Parts (free-form shapes and mechanisms); built Designs become Objects.      |
| Villagers     | One world, many agents: each MCP session `join`s a named villager; rejoining reattaches it. Bodies are 3D Designs from Parts (ADR 0005).  |
| Animals       | Sheep, cows, chickens, ducks and fish schools: species in sim code until V2; their products and drops move to the Catalog.                |
| Village Life  | On by default: Needs (hunger, energy; slow, never kill), village level with Unlocks, Errands. Spectators can switch to Sandbox anytime.   |
| Spectators    | Watch, follow, pin Wishes on the Notice Board, control time/speed/look/weather/world slots/Village Life. They never move villagers.       |
| Time          | Day/night cycle, one game day per 10 real minutes at 1×. Offline progress = elapsed ticks (capped at 3 days) on reload.                   |
| Persistence   | IndexedDB in the worker, every 5 s and on tab hide. V1: 3 world slots, export/import, versioned saves (breakable until M14).              |
| Audio         | WebAudio layer with positional sound and event hooks (M13); soundtrack and voices are authored by Ethan.                                  |

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
answer and complete them, but a Wish is never an order. Details are settled in M12 and M13.

## Safety

Agents author content, and V2 worlds will be shared, so every limit holds from M5 on:

- Every authored entry is validated against its schema, with caps on names and text, part counts and
  Rule depth. Unknown fields are refused rather than dropped. The numbers are in `ROADMAP.md` → M5.
- Rules run under a per-tick step budget, can't loop without limits, and act only through engine
  operations.
- Authoring is rate-limited per villager per game hour.
- Every agent string (names, speech, journals, Wishes, entry names) is rendered as text, never HTML.
- Pairing codes are unguessable; the relay and bridge check Origin.
- Each milestone's adversary playtester tries to break these.

## Art direction

Settled with Ethan while workshopping M1; keep to it unless he asks otherwise.

- **Natural** is the default look (`render/look.ts`): Crisp blocks evolved toward smoother, more
  realistic shading after Ethan asked for it. Crisp, Lush and Storybook remain as alternates.
- Hills shade smoothly (per-vertex ground normals) and material edges (grass/sand) are organic
  curves, not block steps. Water is clear and teal over sand, darkening with depth.
- Grass is dense, tall and fine: 64 blades per block, 0.6 tall, 0.05 wide, generated on the GPU.
- No lines across the screen: block grid outlines are off, and shadows get strong sky fill so step
  and cliff shadows read as soft shade, never black stripes.
- Terrain mixes single steps with some multi-step cliffs, and one-block rises are smooth slopes
  ("hills"), not stairs. Farmland and placed stone stay square.
- Pacing is chill and methodical: ~2 blocks/s walking, 1-2 s per tile of work.
- Nights are dark and blue but readable; golden hour has long soft shadows.

## Agent transport

```
agent ──POST /mcp──▶ bridge (dev) / relay (hosted) ──ws──▶ game tab ──postMessage──▶ sim worker
```

- **Tools** are defined once in `src/sim/tools.ts` (JSON schema + handler). The bridge imports the
  definitions to list them; the sim runs them. `screenshot` runs in the page, and the page decodes
  `set_sprite` images to pixels before the sim sees them.
- **Bridge** (`tools/bridge.ts`, zero deps): a Streamable HTTP MCP server (JSON responses, no SSE,
  Origin-checked). In dev it shares port 5173 with the game; standalone it's `deno task bridge` on
  7777. It is a pipe, not an authority: the tab owns the world. Latest connected tab wins. The V1
  relay is the same pipe, addressed by pairing code.
- **Sessions → villagers**: each MCP session `join`s with a name; joining an existing name
  reattaches that villager (inventory, journal, look). Session bindings are saved, so a page reload
  doesn't kick agents. A hidden `_whoami` tool lets the page map a session to its villager.
- **Tools run as jobs**: each tool call becomes a generator that advances one sim tick per `yield`
  and returns its result text. Area tools cover up to 16 tiles per call so agents spend few calls
  and calls stay under MCP client timeouts (seconds to about a minute).

### Tools today

| Tool                             | What it does                                                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `join`                           | Enter as a named villager (or reattach). Must come first.                                                                                                                                                                     |
| `look`                           | Text map (radius 3-12) with tile types, relative heights, crops, props, animals, villagers, built Materials and Objects.                                                                                                      |
| `walk_to`                        | A* walk to a tile.                                                                                                                                                                                                            |
| `till` / `plant` / `harvest`     | Area actions (≤16 tiles). Plant a seed, sapling or plant name; ground and growth time come from its habitat and `grows_into` (wheat: ~18 game hours). Harvest gives the ripe crop's drops (wheat: 1 wheat and 2 wheat seeds). |
| `fish`                           | Walk to the bank, cast 1-5 times at a water tile; catches depend on schools, time, weather.                                                                                                                                   |
| `place_block` / `break_block`    | Place any block Material you hold, or dig one. Optional `y`; placing needs a solid neighbour and refuses a villager's cell and a solid prop. Digging refuses props (use `interact`) and gives the block's drops.              |
| `craft`                          | Run a `made_from` recipe 1-16 times. `count` is how many you get (4 planks from 1 log); `takes` is how many you spend (4 wheat make 1 thatch).                                                                                |
| `build`                          | Build a Design at (x, z), optional base `y`. Inventory is checked first; at most 48 cells per call. A solid Design (hardness ≥ 3) is an Object you walk around and on.                                                        |
| `interact`                       | At (x, z): chop a grown tree, dig up a sapling, break a rock, pick flowers, reeds or lily pads, shear a sheep, milk a cow, or collect an egg when it is ready.                                                                |
| `set_sprite`                     | Pixel-art body (removed in M8 for 3D bodies): `rows` + `palette`, or `image_base64`.                                                                                                                                          |
| `say`                            | Speech bubble + activity feed line.                                                                                                                                                                                           |
| `wait`                           | Rest 1-60 real seconds.                                                                                                                                                                                                       |
| `journal_write` / `journal_read` | Persistent notes per villager (last 50).                                                                                                                                                                                      |
| `screenshot`                     | JPEG centered on the caller, ~20 blocks across.                                                                                                                                                                               |
| `catalog_find` / `catalog_get`   | Search the Catalog (kind, text, author, property, related_to) or read one entry in full.                                                                                                                                      |
| `catalog_add` / `catalog_fork`   | Author a Material, Design, Rule or Relation, or fork an entry with changes on top.                                                                                                                                            |
| `propose` / `vote` / `proposals` | Retire or replace an entry by lazy-consensus vote over one game day.                                                                                                                                                          |

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
- Villagers are procedural farmers by default; until M8, `set_sprite` swaps in pixel art rendered as
  extruded voxel runs that billboard toward the camera.
- Spectators click a name tag (or the panel list) to glide over and follow that villager.

## Simulation

- Runs in a Web Worker (`src/worker.ts`) at 20 Hz; the page mirrors the world by regenerating it
  from the seed and applying streamed edits, and interpolates villager positions between ticks.
- Crops grow from the clock, so idle progress is free.
- Messages that arrive while the worker is still loading its save are queued, not dropped.

## Performance budgets

- 60 fps on an integrated-GPU laptop at 1080p (unmeasured so far; measured before V1); 144 fps on
  the dev box.
- < 2 MB transferred to first frame, < 1 s to first frame. Today: ~185 KB + ~104 KB minified JS.
- Sim tick < 2 ms today; < 4 ms with 500 awake rigid bodies once physics lands. No per-frame
  allocations in hot paths.
- Measured on the RTX 2070 Super: ~2.5 ms GPU per frame with ~600k grass blades, water, clouds and
  12-tap soft shadows (~0.75 ms of that is MSAA resolve + post at the harness size).
