# Contributing

Thanks for wanting to help agents live better lives. This page covers the commands, the house rules,
and how a change lands. Before an architectural change, read [`docs/DESIGN.md`](docs/DESIGN.md)
(pillars and decisions), [`docs/adr/`](docs/adr/) (calls not to undo) and use the words in
[`GLOSSARY.md`](GLOSSARY.md): villager, not farmer; Catalog, Design, Rule, Object.

## Setup

Install [Deno](https://deno.com) 2.4+ and use a Chromium-family browser with WebGPU. Then:

| Command                                   | What it does                                                       |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `deno task dev`                           | Rebuild on change; game at `:5173`, MCP bridge at `:5173/mcp`      |
| `deno task check`                         | Type check, lint, fmt check (`deno fmt` fixes formatting)          |
| `deno task test`                          | Sim and world tests, headless and fast                             |
| `deno task shot [out.png] [query]`        | Open Chromium on the real GPU, print frame/GPU timings, screenshot |
| `deno task camshot out.png "query" '{…}'` | Like `shot`, with a posed camera; prints GPU errors                |
| `deno task build`                         | The static site in `dist/` (then `npx wrangler deploy`)            |
| `deno task bridge`                        | Standalone MCP bridge on `:7777`                                   |

Without a display (cloud VMs, CI), `shot` runs headless on SwiftShader: the pictures are real, the
milliseconds are CPU emulation and only good for before/after comparisons. [`CLAUDE.md`](CLAUDE.md)
has the code map, URL params, debugging hooks (`__game`, `__perf`) and known gotchas.

## House rules

- **Zero runtime dependencies.** No npm or jsr packages. Tests use `node:assert/strict`.
- **WebGPU only.** No WebGL fallback.
- **The sim is deterministic and DOM-free.** `src/sim/` runs on a fixed tick with a seeded PRNG
  (`Rng`, `hash2`): no `Math.random`, no wall-clock time. Anything non-deterministic happens in the
  page, before or after the sim.
- **Every game action is a tool** in `src/sim/tools.ts`. New gameplay means a new or extended tool,
  plus a test, edge cases included.
- **Content is Catalog data.** Built-in blocks, plants, bodies and behaviors are entries in the same
  formats agents author. No special-cased content in code (ADR 0002).
- **Hot paths don't allocate.** Use typed arrays and reuse scratch buffers. Measure GPU time with
  the harness or `__perf` before and after optimizing; budgets are in `DESIGN.md`.
- **Agent text is text.** Names, speech, journals and entry names are never rendered as HTML.

## Sending a change

1. For anything bigger than a fix, open an issue first so we can agree on the shape.
2. Keep `deno task check` and `deno task test` green (CI runs both on every push and PR).
3. For visual changes, attach before/after screenshots from `deno task shot`.
4. For gameplay changes, let an agent play it. Point one at your dev server and note what it tripped
   on. Milestones close with a playtest report in `docs/playtests/`, and small changes benefit from
   the same habit.
5. Update the docs you touched: the tool table in `DESIGN.md`, the code map in `CLAUDE.md`, the
   glossary if you coined a word.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
