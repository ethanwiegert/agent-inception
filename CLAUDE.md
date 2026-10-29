# agent-inception

Browser sandbox game played by AI agents over MCP while humans watch. The game is a framework: a
Catalog of everything that can exist plus a small physics engine, which agents extend. Before
architectural changes read `docs/DESIGN.md` (pillars, decisions, art direction), `docs/ROADMAP.md`
(milestones, the playtest gate), `docs/adr/` (decisions not to undo) and use the terms in
`GLOSSARY.md` (villager, not farmer; Catalog, Design, Rule…).

## Rules

- Zero runtime dependencies. Do not add npm/jsr packages (tests use `node:assert/strict`, built in).
- WebGPU only. No WebGL fallback.
- Simulation code (`src/sim/`) is deterministic and DOM-free: fixed tick, seeded PRNG (`Rng`,
  `hash2`), no `Math.random`, no wall-clock time. Anything non-deterministic (image decoding,
  screenshots) happens in the page before or after the sim.
- Hot paths: typed arrays, no per-frame allocations (reuse scratch matrices/buffers). Measure GPU
  time with the harness or `__perf` before and after optimizing.
- Every game action is a tool in `src/sim/tools.ts`. New gameplay = new or extended tool + test.
- Built-in content is Catalog data in the formats agents author; no special-cased content in code
  (ADR 0002, from M6 on).

## Commands

- `deno task dev` — rebuild on change; serve the game at http://localhost:5173 and the MCP bridge at
  http://localhost:5173/mcp (same process). Start it first; everything else depends on it.
- `deno task check` — type check, lint, fmt check (run `deno fmt` to fix formatting)
- `deno task test` — sim + world tests (headless, fast)
- `deno task shot [out.png] [query]` — build, open Chromium on the real GPU, print frame/GPU
  timings, save a screenshot. Query is URL params, e.g. `"seed=7&time=0.62&speed=0"`. With no
  display (cloud VMs, CI) it runs headless on SwiftShader and captures offscreen: the picture is
  real, the milliseconds are CPU emulation (`gpuMeasured: false`), good only for before/after.
- `deno task camshot out.png "query" '{"distance":60,"pitch":0.2,"yaw":2.1,"dx":-60,"dz":30}'` —
  like `shot`, but poses the camera (offset from world center) and prints GPU errors
- `deno task build` — minified `dist/main.js` + `dist/worker.js`
- `deno task bridge` — standalone MCP bridge on :7777 (for a hosted game; not used in dev)

URL params: `seed` (a different seed than the save starts a NEW world and overwrites the save),
`time` (0-1, 0.5 = noon), `speed` (0, 1, 10, 60), `look` (`natural` default, `crisp`, `lush`,
`storybook`), `bridge` (WebSocket URL override), `debug` (comma list of passes to skip for
profiling: `shadow,terrain,grass,water,sky,bodies,props`), `headless` (never touch the canvas;
frames render only when `__game.capture()` asks; for software WebGPU, which can't back a canvas).

## Code map

```
src/main.ts         page entry: WebGPU init, frame loop, tool routing, offscreen screenshot/capture
                    (name tags burnt in), session → villager cache
src/worker.ts       sim worker: 20 Hz loop, streams ticks to the page, IndexedDB save/load
src/simclient.ts    page-side mirror of the sim: world copy, agent interpolation, tool calls
src/agentlink.ts    page ↔ bridge WebSocket (auto-reconnect; a tab another tab replaced waits to be
                    looked at again)
src/camera.ts       orbit camera, follow/focus; src/overlay.ts name tags, speech, activity feed
src/devpanel.ts     spectator panel: look, time, speed, seed, agent list
src/sim/            deterministic core — sim.ts (Sim, Agent, clock, weather, save), tools.ts (tool
                    defs + handlers as generator jobs), jobs.ts (walk/reach/work/inventory helpers
                    shared by handlers), blocks.ts (block ids for the Catalog's Materials, patterns),
                    catalog.ts (append-only Catalog: entries, content schemas, Proposals),
                    nature.ts (nature's entries as Catalog data: every block, item, plant, the
                    farmer, animal bodies, drops/growth/food Relations, example Rules),
                    rules.ts (Rule schema + engine: triggers, budget, effects),
                    catalogtools.ts (catalog_* / propose / vote tools),
                    buildtools.ts (place_block / break_block over areas and layers, terraform, build a
                    Design's blocks across calls, never trapping the builder, then its parts as
                    an Object), maketools.ts (craft along made_from, interact: gather, dismantle,
                    collect from animals), objects.ts (Objects: quarter turns, part cost, parts
                    rasterized to tiles for walking: stand on low tops, walk around tall ones),
                    world.ts (voxels, water, slopes, floors), worldgen.ts (island, rivers),
                    props.ts (plants as Objects of Designs: worldgen by habitat zone, growth,
                    save diff, PlantInfo read off a Design),
                    animals.ts (species, herds, wander/graze/sleep/shy/follow-wheat AI),
                    fish.ts (fish species, schools, river/sea habitat),
                    path.ts (A* over floors, wading, swimming), protocol.ts, noise.ts, rng.ts
src/render/         renderer.ts (passes into any target, shadows, GPU timer, debug skips, readback
                    captures), frame.ts (uniforms + common/lighting WGSL: noise, sky, clouds,
                    shadows), terrain.ts + mesher.ts (skips buried blocks), surface.ts
                    (per-column GPU texture), grass.ts (compute cull + indirect), water.ts (wet
                    columns of visible chunks), crops.ts (growth on the GPU from planting ticks),
                    meshes.ts (primitives → templates, instance batches) + models.ts (instanced
                    draws, wind, GPU culling per view) + designs.ts (any Design → mesh: parts in their
                    Materials' looks, role groups around joints) + body.ts (villager rigs from any
                    body Design, the tinted "farmer" by default, tools) + flora.ts (plant templates and
                    instances) + fauna.ts (animal rigs from their Designs; fish schools),
                    sky.ts, post.ts (PBR Neutral tonemap, grading, sharpening), look.ts (presets,
                    sun/moon, weather)
tools/              dev.ts, bridge.ts (MCP server), serve.ts, browser.ts (CDP driver), shot.ts
```

Uniform layout lives in `render/frame.ts`: the `F` offsets and the WGSL `Frame` struct must change
together. The surface texture (`render/surface.ts`, rgba16uint per column) is read by grass, water
and terrain: r height, g block, b slope mask | grass-neighbour bits << 4 (grassy neighbours within a
block of height), a water level + 1. Slope rules live in `World.slopeMask`/`slopeDrop`; the grass
shader has a WGSL mirror of `slopeDrop` that must stay identical.

## Current work

`docs/ROADMAP.md` lists the V1 milestones in order (M5-M8 are done; M9, rigid bodies, is next. The
hardware GPU remeasure is a standing TODO for Ethan's dev box). Each milestone opens with a short
clarifying grill with Ethan and closes with the playtest gate described there (tests, playtests with
cost-effective agents including an adversary, a report in `docs/playtests/`, fixes, perf,
screenshots).

## Testing and debugging

- The T3 preview pane gets the real GPU: open http://localhost:5173 there to watch. The page exposes
  `__game` (`client`, `call(session, tool, args)`, `camera()`, `setLook(id)`,
  `capture(width, height, pose?, atMs?)` → PNG data URL rendered offscreen; fix `atMs` to compare
  shots without drifting clouds) and `__perf` (`summary()` with `gpuMs` and `readyMs`, the
  first-frame budget; `gpuErrors`) for `preview_evaluate`.
- `deno task shot` uses a fresh Chromium profile, so its world is empty (no saved agents). Use it
  for looks and perf; use the preview tab or the MCP `screenshot` tool to see agents.
- Hidden tabs pause `requestAnimationFrame`; the sim worker keeps running and `screenshot` renders
  offscreen (1024×640, name tags burnt in), so agents work while nobody watches.
- Without a display, drive a headless tab yourself: `launch()` from `tools/browser.ts` adds
  `headless` and SwiftShader flags; then `__game.capture()` for pictures. A software frame takes
  seconds.
- Drive the bridge without an agent:

  ```sh
  M=http://localhost:5173/mcp; H='-H content-type:application/json'
  SID=$(curl -si $M $H -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' | grep -i mcp-session-id | awk '{print $2}' | tr -d '\r')
  curl -s $M $H -H "mcp-session-id: $SID" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"join","arguments":{"name":"Fern"}}}'
  ```

## Gotchas

- Chromium on Linux needs `--enable-unsafe-webgpu --enable-features=Vulkan` and a real window;
  headless only gets SwiftShader. `tools/browser.ts` handles it (a window briefly appears).
  SwiftShader can't back a WebGPU canvas (the device is lost on the first frame), which is why
  headless runs use `?headless` and offscreen captures.
- Instant tools (look, say, Catalog reads) answer before the next tick message, so the page's mirror
  (agents, profiles) can lag a result by up to 50 ms.
- Killing a harness `deno` process can orphan its Chromium; the bridge then has two tabs. A tab the
  bridge replaced stays off until focused, but stray tabs still hold memory: kill them by PID.
- Run the dev server in the background with the maximum timeout; a Claude Code restart kills it.
  `.mcp.json` is read at session start; if the server was down then, use `/mcp` to reconnect.
- WGSL: one declaration per `let`; mixing `*` and `^` needs parentheses. Shader errors surface in
  `__perf.gpuErrors`, not as exceptions.
- Typed arrays crossing `postMessage` are typed `Float32Array<ArrayBuffer>` in `protocol.ts`.
- `deno fmt` reflows code and markdown; match formatted text when editing by exact string.
- Don't `pkill -f` with a pattern that also matches your own shell command.
- The bridge reads `TOOL_DEFS` when the dev server starts: after adding or changing a tool's schema,
  restart `deno task dev` (the game bundle rebuilds on its own).

## Playing

Agents play through MCP (`.mcp.json` registers `agent-inception`). With `deno task dev` running and
the game open in a browser, spawn the `farmer` subagent (a cost-effective agent;
`.claude/agents/farmer.md`), or delegate a task to a cost-effective agent with a name and a play
brief. Agents `join` by name (rejoining reattaches the body), and the world persists in the
browser's IndexedDB.
