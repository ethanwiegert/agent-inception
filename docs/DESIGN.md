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
| Rendering     | Main thread, WebGPU, HDR + 4× MSAA, one sun/moon shadow map, interpolates between sim ticks.                                             |
| World         | 256×256×64 voxel world in 32×32 chunk columns. Rolling meadow with sloped one-block rises and occasional terraced cliffs.                |
| Camera        | Angled top-down orbit (drag), pan (right-drag), zoom (wheel); click a name to follow. Watching isn't playing.                            |
| Time          | Day/night cycle, one game day per 10 real minutes at 1×. Offline progress = elapsed ticks (capped at 3 days) on reload.                  |
| Agents        | One world, many agents: each MCP session `join`s a named body. Rejoining by name reattaches it.                                          |
| Physics       | Today: bodies follow the walkable surface (slopes, edits) and path with A* (climb 1, drop 2). Planned: swept AABB, rigid items, joints.  |
| Agent body    | Procedural blocky farmer (straw hat, walk/work/idle animation) or an agent-drawn sprite extruded into voxels.                            |
| Animals       | Planned (M4): a couple of species, procedural meshes, simple needs.                                                                      |
| Objects       | Planned (M5): agents author declarative recipes (shapes, materials, physics props), upload via MCP; validated and meshed in the browser. |
| Persistence   | IndexedDB in the worker: seed + block diff + crops + agents + session bindings, every 5 s and on tab hide.                               |
| Audio         | Planned: WebAudio layer with positional sound and event hooks; soundtrack and voices are authored by Ethan.                              |

## Art direction

Settled with Ethan while workshopping M1; keep to it unless he asks otherwise.

- **Crisp blocks** is the look (`render/look.ts`); Lush meadow and Storybook remain as alternates.
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

| Tool                             | What it does                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `join`                           | Enter as a named farmer (or reattach). Must come first.                                    |
| `look`                           | Text map (radius 3-12) with tile types, relative heights, crops, other farmers.            |
| `walk_to`                        | A* walk to a tile.                                                                         |
| `till` / `plant` / `harvest`     | Area actions (≤16 tiles). Wheat ripens in ~18 game hours; harvest gives 1 wheat + 2 seeds. |
| `place_block` / `break_block`    | Stack dirt/stone on a column, or dig its top block into inventory.                         |
| `set_sprite`                     | Pixel-art body: `rows` + `palette`, or `image_base64`; `reset` for the farmer.             |
| `say`                            | Speech bubble + activity feed line.                                                        |
| `wait`                           | Rest 1-60 real seconds.                                                                    |
| `journal_write` / `journal_read` | Persistent notes per agent (last 50).                                                      |
| `screenshot`                     | JPEG centered on the caller, ~20 blocks across.                                            |

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
- **M4 — life.** Next. Two animal species (procedural box bodies via `boxes.ts`, simple needs and
  wandering), trees and wild plants that grow, and tools to interact with them.
- **M5 — making.** Object recipes + upload, crafting, reverse-CAPTCHA gag for WASD/clicks.

### Next up

1. Re-run a Haiku playtest (Clover's first run was cut off before she gave tool feedback) and fold
   the feedback into tool descriptions and `look` output.
2. Start M4: animals first (they make the meadow feel alive to watch), then trees.
3. Physics pass: swept AABB for bodies and animals, dropped items as simple rigid bodies.
4. Measure on an integrated GPU; if grass is the bottleneck, move blade culling into a compute pass
   with indirect draws.

### Known gaps

- Choosing a new seed (panel or `?seed=`) rebuilds the `Renderer` without destroying the old GPU
  resources. Fine for dev; fix before it matters.
- In-flight tool calls are lost on page reload (jobs aren't saved); agents just get an error.
- Crop growth is re-sent from the worker once a second; could move to the GPU from planted ticks.
- WebMCP (`navigator.modelContext`), audio hooks and the reverse CAPTCHA aren't started.

## Performance budgets

- 60 fps on an integrated-GPU laptop at 1080p (unmeasured so far); 144 fps on the dev box.
- < 2 MB transferred to first frame, < 1 s to first frame. Today: ~55 KB + ~20 KB minified JS.
- Sim tick < 2 ms at M4 scale. No per-frame allocations in hot paths.
- Measured on the RTX 2070 Super: ~0.8-1.0 ms GPU per frame with ~600k grass blades.
