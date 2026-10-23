# agent-inception

Browser sandbox game played by AI agents over MCP while humans watch. Read `docs/DESIGN.md` for the
pillars, decisions, art direction, status and next steps before making architectural changes.

## Rules

- Zero runtime dependencies. Do not add npm/jsr packages (tests use `node:assert/strict`, built in).
- WebGPU only. No WebGL fallback.
- Simulation code (`src/sim/`) is deterministic and DOM-free: fixed tick, seeded PRNG (`Rng`,
  `hash2`), no `Math.random`, no wall-clock time. Anything non-deterministic (image decoding,
  screenshots) happens in the page before or after the sim.
- Hot paths: typed arrays, no per-frame allocations (reuse scratch matrices/buffers). Measure GPU
  time with the harness or `__perf` before and after optimizing.
- Every game action is a tool in `src/sim/tools.ts`. New gameplay = new or extended tool + test.

## Commands

- `deno task dev` — rebuild on change; serve the game at http://localhost:5173 and the MCP bridge at
  http://localhost:5173/mcp (same process). Start it first; everything else depends on it.
- `deno task check` — type check, lint, fmt check (run `deno fmt` to fix formatting)
- `deno task test` — sim + world tests (headless, fast)
- `deno task shot [out.png] [query]` — build, open Chromium on the real GPU, print frame/GPU
  timings, save a screenshot. Query is URL params, e.g. `"seed=7&time=0.62&speed=0"`.
- `deno task build` — minified `dist/main.js` + `dist/worker.js`
- `deno task bridge` — standalone MCP bridge on :7777 (for a hosted game; not used in dev)

URL params: `seed` (a different seed than the save starts a NEW world and overwrites the save),
`time` (0-1, 0.5 = noon), `speed` (0, 1, 10, 60), `look` (`crisp` default, `lush`, `storybook`),
`bridge` (WebSocket URL override).

## Code map

```
src/main.ts         page entry: WebGPU init, frame loop, tool routing, screenshot, sprite decoding
src/worker.ts       sim worker: 20 Hz loop, streams ticks to the page, IndexedDB save/load
src/simclient.ts    page-side mirror of the sim: world copy, agent interpolation, tool calls
src/agentlink.ts    page ↔ bridge WebSocket (auto-reconnect)
src/camera.ts       orbit camera, follow/focus; src/overlay.ts name tags, speech, activity feed
src/devpanel.ts     spectator panel: look, time, speed, seed, agent list
src/sim/            deterministic core — sim.ts (Sim, Agent, clock, save), tools.ts (tool defs +
                    handlers as generator jobs), world.ts (voxels, slopes), worldgen.ts, path.ts
                    (A*), protocol.ts (worker messages), noise.ts, rng.ts
src/render/         renderer.ts (passes, shadows, GPU timer), frame.ts (shared uniforms + lighting
                    WGSL), terrain.ts + mesher.ts, grass.ts, crops.ts, boxes.ts (instanced cubes) +
                    body.ts (farmer bodies, sprite dolls), sky.ts, post.ts, look.ts (presets,
                    day/night)
tools/              dev.ts, bridge.ts (MCP server), serve.ts, browser.ts (CDP driver), shot.ts
```

Uniform layout lives in `render/frame.ts`: the `F` offsets and the WGSL `Frame` struct must change
together. Slope rules live in `World.slopeMask`/`slopeDrop`; the grass shader has a WGSL mirror of
`slopeDrop` that must stay identical.

## Testing and debugging

- The T3 preview pane gets the real GPU: open http://localhost:5173 there to watch. The page exposes
  `__game` (`client`, `call(session, tool, args)`, `camera()`) and `__perf` (`summary()`,
  `gpuErrors`) for `preview_evaluate`.
- `deno task shot` uses a fresh Chromium profile, so its world is empty (no saved agents). Use it
  for looks and perf; use the preview tab or the MCP `screenshot` tool to see agents.
- Hidden tabs pause `requestAnimationFrame`; the sim worker keeps running and `screenshot` renders a
  frame directly, so agents work while nobody watches.
- Drive the bridge without an agent:

  ```sh
  M=http://localhost:5173/mcp; H='-H content-type:application/json'
  SID=$(curl -si $M $H -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' | grep -i mcp-session-id | awk '{print $2}' | tr -d '\r')
  curl -s $M $H -H "mcp-session-id: $SID" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"join","arguments":{"name":"Fern"}}}'
  ```

## Gotchas

- Chromium on Linux needs `--enable-unsafe-webgpu --enable-features=Vulkan` and a real window;
  headless only gets SwiftShader. `tools/browser.ts` handles it (a window briefly appears).
- Run the dev server in the background with the maximum timeout; a Claude Code restart kills it.
  `.mcp.json` is read at session start; if the server was down then, use `/mcp` to reconnect.
- WGSL: one declaration per `let`; mixing `*` and `^` needs parentheses. Shader errors surface in
  `__perf.gpuErrors`, not as exceptions.
- Typed arrays crossing `postMessage` are typed `Float32Array<ArrayBuffer>` in `protocol.ts`.
- `deno fmt` reflows code and markdown; match formatted text when editing by exact string.
- Don't `pkill -f` with a pattern that also matches your own shell command.

## Playing

Agents play through MCP (`.mcp.json` registers `agent-inception`). With `deno task dev` running and
the game open in a browser, spawn the `farmer` subagent (Haiku, `.claude/agents/farmer.md`), or
delegate a Haiku task with a name and a play brief. Agents `join` by name (rejoining reattaches the
body), and the world persists in the browser's IndexedDB.
