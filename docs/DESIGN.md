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

## Decisions

| Topic         | Decision                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Platform      | Browser, WebGPU only. Linux Chromium needs `--enable-unsafe-webgpu --enable-features=Vulkan`.                                      |
| Toolchain     | Deno only. No npm packages.                                                                                                        |
| Language      | TypeScript, data-oriented (typed arrays, SoA). Hot kernels move to Zig→WASM only when the profiler says so.                        |
| Where it runs | Fully client-side; the static site scales to any number of players. Each tab owns one world.                                       |
| Simulation    | Deterministic fixed-tick core (20 Hz, seeded PRNG) in a Web Worker, no DOM. Same code runs headless in Deno for tests.             |
| Rendering     | Main thread, WebGPU, interpolates between sim ticks.                                                                               |
| World         | Voxel block chunks. Starts as a gently rolling, smooth meadow with lush instanced grass.                                           |
| Camera        | Angled top-down, orbit + zoom (human-controlled — watching isn't playing).                                                         |
| Time          | Day/night cycle. Offline progress = capped fast-forward on reload.                                                                 |
| Agents        | One world, many agents: each MCP session gets its own body.                                                                        |
| Physics (v1)  | Swept AABB vs voxels for bodies; simple rigid bodies for dropped items. Joints/water later.                                        |
| Agent body    | Procedural blocky character with procedural animation. Methodical, slow, chill pacing.                                             |
| Animals (v1)  | A couple of species, procedural meshes, simple needs.                                                                              |
| Objects       | Agents author declarative recipes (shapes, materials, physics props) and upload them via MCP; validated and meshed in the browser. |
| Persistence   | IndexedDB/OPFS snapshots.                                                                                                          |
| Audio         | WebAudio layer with positional sound and event hooks; soundtrack and voices are authored by Ethan.                                 |

## Agent transport

```
agent ──POST /mcp──▶ bridge ──ws /bridge──▶ game tab ──postMessage──▶ sim worker
```

- **Tools** are defined once in `src/sim/tools.ts` (JSON schema + handler). The bridge imports the
  definitions to list them; the sim runs them. `screenshot` is the one client-side tool.
- **Bridge** (`tools/bridge.ts`, zero deps): a Streamable HTTP MCP server (JSON responses, no SSE).
  In dev it shares port 5173 with the game; standalone it's `deno task bridge` on 7777. It is a
  pipe, not an authority: the tab owns the world. Latest connected tab wins.
- **Sessions → bodies**: each MCP session `join`s with a name; joining an existing name reattaches
  that body (inventory, journal). Session bindings are saved, so a page reload doesn't kick agents.
- **Actions are jobs**: each tool call becomes a generator that advances one sim tick per `yield`
  and returns its result text. Area tools (`till`, `plant`, `harvest`) cover up to 16 tiles per call
  so agents spend few calls; walking is ~2 blocks/s, so calls take seconds to a minute.
- **WebMCP** (`navigator.modelContext`) is a later option for in-browser agents, no bridge.

## Simulation

- Runs in a Web Worker (`src/worker.ts`) at 20 Hz; the page mirrors the world by regenerating it
  from the seed and applying streamed edits, and interpolates agent positions between ticks.
- One game day is 10 real minutes at 1×. Wheat ripens in 0.75 days. Crops grow from the clock, so
  offline progress is just elapsed ticks (capped at 3 days) applied on load.
- Saved to IndexedDB every 5 s and when the tab hides: seed + block diff + crops + agents +
  sessions.

## Milestones

- **M0 — foundation.** ✅ Deno toolchain, dev server, WebGPU bootstrap, Chromium/CDP harness for
  screenshots and frame timings.
- **M1 — the look.** ✅ Meadow terrain chunks, instanced grass with wind, lighting + shadows,
  day/night. Workshop variants together.
- **M2 — sim core.** ✅ Worker, fixed tick, determinism tests, save/load, offline catch-up.
- **M3 — the agent.** ✅ Body + animation, bridge, MCP tools, Haiku farmer subagent playing end to
  end.
- **M4 — life.** Two animal species, plants and trees that grow.
- **M5 — making.** Object recipes + upload, reverse-CAPTCHA gag.

## Performance budgets (initial)

- 60 fps on an integrated-GPU laptop at 1080p; 144 fps on the dev box.
- < 2 MB transferred to first frame, < 1 s to first frame.
- Sim tick < 2 ms at M4 scale. No per-frame allocations in hot paths.
