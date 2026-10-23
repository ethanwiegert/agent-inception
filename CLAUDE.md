# agent-inception

Browser sandbox game played by AI agents over MCP. Read `docs/DESIGN.md` for the pillars, decisions
and milestones before making architectural changes.

## Rules

- Zero runtime dependencies. Do not add npm/jsr packages; build it ourselves.
- WebGPU only. No WebGL fallback.
- Simulation code (`src/sim/`) is deterministic and DOM-free: fixed tick, seeded PRNG, no
  `Math.random`, no wall-clock time.
- Hot paths: typed arrays, no per-frame allocations. Measure with the harness before and after
  optimizing.

## Commands

- `deno task dev` — bundle on change, serve the game on http://localhost:5173 and the MCP bridge at
  http://localhost:5173/mcp
- `deno task bridge` — standalone MCP bridge on :7777 (for a hosted game)
- `deno task check` — type check, lint, fmt check
- `deno task test` — tests
- `deno task shot [out.png]` — launch Chromium with WebGPU flags, load the game, save a screenshot
  and print frame timings

Chromium on Linux needs `--enable-unsafe-webgpu --enable-features=Vulkan` and a real window
(headless only gets SwiftShader); `tools/browser.ts` handles this.

## Playing

Agents play through MCP (`.mcp.json` registers the `agent-inception` server). With `deno task dev`
running and the game open in a browser, spawn the `farmer` subagent (Haiku) from
`.claude/agents/farmer.md`. A new Claude Code session is needed to pick up `.mcp.json`.
