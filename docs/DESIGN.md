# agent-inception — design

A sandbox you can watch your agent live in. A chill, top-down 3D block world — a procedural meadow
with farming, building, animals and crafting — played entirely by AI agents over MCP while a human
watches.

## Pillars

1. **Efficient.** Runs in the browser and runs very well. WebGPU only. Budgets are numbers, measured
   by our own harness, not vibes.
2. **Custom.** Zero runtime dependencies. Our own renderer, simulation, physics, noise, math, mesh
   formats and agent transport. Dev tooling is just Deno (type check, bundle, test, fmt, lint,
   serve) plus Blender, and later Zig for WASM kernels.
3. **Agent first.** Every game action is an MCP tool. Humans watch; if they reach for WASD or click
   the world, they get a reverse CAPTCHA (a gag).

Ethan authors the soundtrack and voices. The project is closed source; hosting is undecided. Agent
players are Haiku subagents spawned from Claude Code (no API key in the game).

## Decisions

| Topic         | Decision                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Platform      | Browser, WebGPU only. Linux Chromium needs `--enable-unsafe-webgpu --enable-features=Vulkan`.                                            |
| Toolchain     | Deno only (check, bundle, test, fmt, lint, serve). No npm/jsr packages.                                                                  |
| Language      | TypeScript, data-oriented (typed arrays). Hot kernels move to Zig→WASM only when the profiler says so.                                   |
| Where it runs | Fully client-side; the static site scales to any number of players. Each tab owns one world.                                             |
| Simulation    | Deterministic fixed-tick core (20 Hz, seeded PRNG) in a Web Worker, no DOM. Same code runs headless in Deno for tests.                   |
| Rendering     | Main thread, WebGPU, HDR + 4× MSAA, sun/moon shadow map, cloud shadows, GPU water, compute-culled grass.                                 |
| World         | 256×256×64 voxel island in 32×32 chunk columns: rolling hills, river valleys, beaches, sea to the horizon.                               |
| Camera        | Angled top-down orbit (drag), pan (right-drag), zoom (wheel); click a name to follow. Watching isn't playing.                            |
| Time          | Day/night cycle, one game day per 10 real minutes at 1×. Offline progress = elapsed ticks (capped at 3 days) on reload.                  |
| Agents        | One world, many agents: each MCP session `join`s a named body. Rejoining by name reattaches it.                                          |
| Physics       | Bodies follow the walkable surface and path with A* (climb 1, drop 2, wade 1, swim 3). Planned: swept AABB, rigid items, joints.         |
| Agent body    | Procedural farmer from rounded mesh parts (straw hat, walk/work/idle animation) or an agent-drawn sprite extruded into voxels.           |
| Animals       | Sheep, cows, chickens, ducks: data-driven species in the sim, rigged parts on the model system (fish next).                              |
| Objects       | Planned (M5): agents author declarative recipes (shapes, materials, physics props), upload via MCP; validated and meshed in the browser. |
| Persistence   | IndexedDB in the worker: seed + block diff + crops + agents + session bindings, every 5 s and on tab hide.                               |
| Audio         | Planned: WebAudio layer with positional sound and event hooks; soundtrack and voices are authored by Ethan.                              |

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
agent ──POST /mcp──▶ bridge ──ws /bridge──▶ game tab ──postMessage──▶ sim worker
```

- **Tools** are defined once in `src/sim/tools.ts` (JSON schema + handler). The bridge imports the
  definitions to list them; the sim runs them. `screenshot` runs in the page, and the page decodes
  `set_sprite` images to pixels before the sim sees them.
- **Bridge** (`tools/bridge.ts`, zero deps): a Streamable HTTP MCP server (JSON responses, no SSE,
  Origin-checked). In dev it shares port 5173 with the game; standalone it's `deno task bridge` on
  7777. It is a pipe, not an authority: the tab owns the world. Latest connected tab wins.
- **Sessions → bodies**: each MCP session `join`s with a name; joining an existing name reattaches
  that body (inventory, journal, sprite). Session bindings are saved, so a page reload doesn't kick
  agents. A hidden `_whoami` tool lets the page map a session to its body.
- **Actions are jobs**: each tool call becomes a generator that advances one sim tick per `yield`
  and returns its result text. Area tools cover up to 16 tiles per call so agents spend few calls
  and calls stay under MCP client timeouts (seconds to about a minute).

### Tools

| Tool                             | What it does                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `join`                           | Enter as a named farmer (or reattach). Must come first.                                     |
| `look`                           | Text map (radius 3-12) with tile types, relative heights, crops, other farmers.             |
| `walk_to`                        | A* walk to a tile.                                                                          |
| `till` / `plant` / `harvest`     | Area actions (≤16 tiles). Wheat ripens in ~18 game hours; harvest gives 1 wheat + 2 seeds.  |
| `fish`                           | Walk to the bank, cast 1-5 times at a water tile; catches depend on schools, time, weather. |
| `place_block` / `break_block`    | Stack dirt/stone on a column, or dig its top block into inventory.                          |
| `set_sprite`                     | Pixel-art body: `rows` + `palette`, or `image_base64`; `reset` for the farmer.              |
| `say`                            | Speech bubble + activity feed line.                                                         |
| `wait`                           | Rest 1-60 real seconds.                                                                     |
| `journal_write` / `journal_read` | Persistent notes per agent (last 50).                                                       |
| `screenshot`                     | JPEG centered on the caller, ~20 blocks across.                                             |

## Terrain and bodies

- Natural ground (grass, dirt) slopes: a column top lowers each corner that touches ground exactly
  one block lower, unless something around that corner is higher or doesn't slope. That keeps
  neighbouring surfaces watertight; drops of 2+ stay as cliffs, and farmland and placed stone keep
  square edges. `World.slopeMask`/`slopeDrop` define the surface once; the mesher, the grass shader
  (via the surface texture's mask channel) and walking bodies all follow it.
- Terrain meshes are culled faces with per-vertex AO, one packed u32 per vertex; sloped tops get
  their normal from screen-space derivatives.
- Grass has no per-blade data: the vertex shader generates blades in a grid around the camera from
  an rgba8 surface texture (height, block, slope mask). Editing the world rewrites that texture.
- Agents are procedural farmers by default. `set_sprite` swaps in pixel art rendered as extruded
  voxel runs that billboard toward the camera and flip with walking direction (draw facing right).
- Spectators click a name tag (or the panel list) to glide over and follow that agent.

## Simulation

- Runs in a Web Worker (`src/worker.ts`) at 20 Hz; the page mirrors the world by regenerating it
  from the seed and applying streamed edits, and interpolates agent positions between ticks.
- Wheat ripens in 0.75 game days. Crops grow from the clock, so idle progress is free.
- Messages that arrive while the worker is still loading its save are queued, not dropped.

## Milestones

- **M0 — foundation.** ✅ Deno toolchain, dev server, WebGPU bootstrap, Chromium/CDP harness.
- **M1 — the look.** ✅ Meadow chunks, GPU grass with wind, shadows, day/night, look presets.
- **M2 — sim core.** ✅ Worker, fixed tick, determinism tests, save/load, offline catch-up.
- **M3 — the agent.** ✅ Bodies + animation, MCP bridge, tools, Haiku farmer playing end to end.
  Since then: sloped hills, agent sprites, click-to-follow.
- **World v2.** ✅ (commit 0477d69) Island worldgen with rivers and sea, block registry with
  procedural patterns, smooth normals, organic grass edges, GPU water + ocean, sun/moon/stars/
  clouds, cloud shadows, weather drift, compute-culled grass, `?debug=` profiling, `camshot`.
- **M4 — life.** Next. Trees, plants and four animal species (see the upgrade checklist).
- **M5 — making.** Building, crafting, agent-defined content, reverse-CAPTCHA gag.

### Upgrade checklist (Ethan's 2026-10-25 goal, in progress)

Goal: smoother/more realistic look, better camera, sun/moon, plants, trees, 3-4 animals,
rivers/water, basic building, and everything extendable by agents through MCP. Stay efficient, zero
dependencies; use Haiku subagents for playtests and content.

Done: island + rivers + water, sun/moon/stars/clouds, smoother shading (phase 1 above), model system
(item 2), camera (item 1; reviewed and verified in the browser, plus terrain collision for low
orbits).

To do, in order:

1. ~~**Camera**~~ (done, `src/camera.ts`): time-based damped orbit/pan/zoom with goal values, zoom
   toward the cursor, grab-the-ground panning (right/middle drag), pitch range down to ~0.12 so the
   horizon/sun/moon are visible, double-click to glide to a point, touch (one-finger orbit, pinch
   zoom, two-finger pan), and a small HUD (compass that resets north, rotate ±45°, overview,
   cinematic auto-orbit toggle). No keyboard camera: WASD is reserved for the gag.
2. ~~**Model system**~~ (done, `render/meshes.ts` + `render/models.ts`): rounded box, ico-sphere
   with noise, cylinder/cone primitives with linear vertex colors, sway and AO gradients, packed 20
   bytes per vertex into one shared buffer of named templates (`MeshLibrary`, re-uploaded when
   templates change). `InstanceBatch` groups instances (mat4 + tint + wind weight) by template
   without per-frame allocation; one `drawIndexed` per template, shadows, wind in the vertex shader.
   The farmer is rounded parts tinted per agent; sprite dolls use the `cube` template.
3. ~~**Props in the sim**~~ (done, `sim/props.ts` + `render/flora.ts`): oak, birch, pine (3 variants
   each), bushes, flower patches (4 colors), reeds, rocks and lily pads, one per tile, placed
   deterministically from the seed (trees on a jittered 3×3 grid by forest noise, the rest by
   habitat; a clearing around spawn). Saves keep a diff against generation; the page regenerates and
   applies the streamed diff. Trees and rocks block walking, tilling and building; `plant` takes
   `seed: oak|birch|pine` (new farmers carry one sapling of each), saplings grow over 2 game days.
   Ground cover is a separate no-shadow batch that fades out past 70 blocks. `look` shows props,
   sand and water.
4. ~~**Animals**~~ (done, `sim/animals.ts` + `render/fauna.ts`): sheep (wool), cow (milk), chicken
   (eggs) on land and ducks on rivers and ponds, ~37 animals in herds placed from the seed. Wander
   near the herd, graze, sleep at night, shy away from farmers walking at them, follow anyone
   carrying wheat; all on the sim RNG (~7 µs per tick). Saved in full, streamed like agents (with a
   product-ready flag), and drawn from rigs: parts hung from pivots with roles (legs swing with the
   stride, heads graze/peck/look around, ducks bob and dabble, sheared wool shrinks). `look` marks
   animals and lists nearby herds with products ready. Collecting products comes with `interact`
   (item 6).
5. ~~**Fish and fishing**~~ (done, `sim/fish.ts`, fish in `render/fauna.ts`): minnow, trout and
   perch in rivers and ponds, mackerel and cod in the sea ring (24 schools, each within casting
   distance of a shore; every river species has a school near spawn). Schools drift around home; the
   page animates their fish circling just under the surface, tinted by the water, with an occasional
   leap. `fish` walks to the bank within 4 tiles, casts 1-5 times (3-9 s each); bites depend on a
   nearby school, species, dawn/dusk, night and clouds. Catches thin the school (a fish returns
   every two game hours), go to the inventory and pop a speech bubble. The farmer holds a rod with
   line and bobber. `look` marks schools (f) and lists them. Farmers can now swim water up to 3 deep
   (slow; heads above water), so rivers no longer cut the island apart.
6. **Building** (next; groundwork in): job helpers now live in `sim/jobs.ts` so new tool groups can
   sit in their own files (planned `sim/building.ts`, merged into `TOOL_DEFS` and the handlers), and
   `reach(sim, agent, x, z, y)` takes an optional block height (reachable within `MAX_REACH` = 3 of
   the farmer's feet) so tall walls and roofs are workable. Plan:
   - `place_block` for any placeable block in the inventory, with optional `y`; needs a solid
     neighbour (no floating blocks), refuses cells a farmer stands in and solid-prop tiles.
   - `break_block` with optional `y` (an exposed block); drops come from the block registry.
   - `build`: text blueprint (layers bottom→top of rows + palette, like `set_sprite`) at x, z,
     optional base y; checks the inventory up front, places layer by layer (≤ 48 blocks per call, ~8
     ticks each to stay under MCP timeouts), and reports skipped cells.
   - `craft`: log → 4 planks, stone → cobble, clay → brick or 2 tiles, 2 wheat → thatch.
   - `interact` at x, z: chop a grown tree (logs + a sapling, axe swing anim), dig up a sapling,
     break a rock (cobble), pick flowers/reeds/lily pads, and for animals within reach shear sheep /
     milk cows / collect eggs when their product is ready (`readyAt`).
   - `look` legend for built blocks (log, planks, cobble, brick, thatch, tiles) and a test per tool.
7. **Agent extensibility tools**: `define_block` (name, color, pattern — renderer already reads the
   palette), `define_object` (parts list → model template) + `place_object` / `remove_object`,
   `define_species` + `spawn_animal`, `terraform` (raise/lower/flatten/water/ drain an area),
   `set_weather` (sim has `weatherOverride`), `world_info` (list registries). Persist all registries
   in saves; mirror to the page like blocks.
8. **Haiku playtests**: delegate 2-3 Haiku farmers (one builder, one rancher, one designer who
   defines objects/blocks), collect their feedback, fix tool friction; update `farmer.md` tools.
9. **Polish and measure**: see known gaps.

### Known gaps

- Close, low views: sloped side triangles still read as dark facets in shade; sunset sky is too pale
  (wants a warmer horizon band); the moon disc is a bit large; far-hill grass radius edge is visible
  at low angles.
- Underwater clay/gravel patches have square edges (only grass edges blend so far).
- `generateWorld` takes ~330 ms and runs in both the worker and the page; could be shared.
- Choosing a new seed (panel or `?seed=`) rebuilds the `Renderer` without destroying the old GPU
  resources. Fine for dev; fix before it matters.
- In-flight tool calls are lost on page reload (jobs aren't saved); agents just get an error.
- Props draw every instance (~3.6k, ~0.45 ms GPU at the default view); per-chunk culling and tree
  LODs would cut that when the world fills up. Chopping trees comes with `interact`.
- Crop growth is re-sent from the worker once a second; could move to the GPU from planted ticks.
- WebMCP (`navigator.modelContext`), audio hooks and the reverse CAPTCHA aren't started.
- Old saves from the flat meadow load onto the new island generator (blocks diffs still apply);
  start a fresh world with a new seed if they look odd.

## Performance budgets

- 60 fps on an integrated-GPU laptop at 1080p (unmeasured so far); 144 fps on the dev box.
- < 2 MB transferred to first frame, < 1 s to first frame. Today: ~55 KB + ~20 KB minified JS.
- Sim tick < 2 ms at M4 scale. No per-frame allocations in hot paths.
- Measured on the RTX 2070 Super: ~2.5 ms GPU per frame with ~600k grass blades, water, clouds and
  12-tap soft shadows (~0.75 ms of that is MSAA resolve + post at the harness size).
