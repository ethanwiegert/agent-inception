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
   - 2-3 Haiku agents with milestone briefs play ~40 calls each; one brief is an adversary that
     tries to break the new tools (bad arguments, odd sequences, the safety limits).
   - A report lands in `docs/playtests/NNNN-<milestone>.md`: what they tried, friction, bugs.
   - Every bug is fixed; friction is fixed or added to this roadmap.
   - Perf is re-measured against the budgets in `DESIGN.md`, and screenshots are checked.
4. **Then** move on. Quality over speed.

Saves may break freely until M14; save versioning and migrations come last before release.

## Done

- **M0 — foundation.** Deno toolchain, dev server, WebGPU bootstrap, Chromium/CDP harness.
- **M1 — the look.** Voxel meadow, GPU grass with wind, shadows, day/night, look presets.
- **M2 — sim core.** Worker, fixed tick, determinism tests, save/load, offline catch-up.
- **M3 — the agent.** Bodies and animation, MCP bridge, tools, a Haiku farmer playing end to end;
  then sloped hills, sprites, click-to-follow.
- **World v2.** Island with rivers and sea, block registry and patterns, smooth shading, GPU water,
  sun/moon/stars/clouds, cloud shadows, weather drift, compute-culled grass, `?debug=`, `camshot`.
- **M4 — life.** Damped orbit camera with HUD and touch; model system (mesh templates, instanced
  draws, wind); props (trees, bushes, flowers, reeds, rocks, lily pads, saplings); sheep, cows,
  chickens and ducks with herd AI and rigs; fish schools, `fish`, swimming; job helpers in
  `sim/jobs.ts` and `reach` to a block height (building groundwork).

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

### M5 — Catalog core (next)

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
- Open questions for the M5 grill: vote quorum and duration (what happens in a one-villager world),
  the first engine-operation vocabulary, query tool shapes, authoring rate limits.

### M6 — built-ins become entries

- Blocks → Materials (looks, patterns, physical properties such as density and hardness).
- Wheat, saplings, trees, flowers, reeds, rocks, lily pads → Designs + Rules (growth, spreading).
- Drops and products (logs, seeds, wool, milk, eggs, fish) → engine Relations.
- The farmer look → a Design. Species stay code until V2 (ADR 0002), but their products, food and
  drops come from the Catalog.
- Renderer and worldgen read looks and placement from the Catalog; nothing special-cased.

### M7 — building, crafting, physics phase 1

Groundwork is in (`sim/jobs.ts`, `reach` with `y`). Starting plan, to refine in the M7 grill:

- `place_block` for any placeable Material in the inventory, optional `y`; needs a solid neighbour,
  refuses cells a villager stands in and solid-prop tiles. `break_block` with optional `y`, drops
  from engine Relations.
- `build` a Design (Blocks + Parts) at x, z, optional base y: checks the inventory up front, places
  layer by layer (≤ 48 cells per call to stay under MCP timeouts), reports skipped cells.
- `craft` through _made from_ Relations (log → planks, stone → cobble, clay → brick or tiles, wheat
  → thatch as the built-in examples).
- `interact` at x, z: chop a grown tree (logs + sapling, axe swing), dig up a sapling, break a rock,
  pick flowers/reeds/lily pads, shear sheep, milk cows, collect eggs when ready.
- Physics 1: collision shapes for Parts; static Objects that villagers walk around and on.
- `look` legend for built Materials and Objects.

### M8 — character and land

- Villager bodies are 3D Designs from Parts (ADR 0005); `set_sprite` and sprite dolls are removed.
  The farmer Design is the worked example. Update `farmer.md`'s first-join step.
- `terraform`: raise, lower, flatten an area.
- Agent-authored crops: a Design + growth Rules + Relations.

### M9-M11 — physics phases 2-4

Deterministic on the fixed tick, simple shapes (box, sphere, capsule, compounds), sleeping bodies.
Budget: sim tick < 4 ms with 500 awake bodies.

- **M9 rigid bodies**: fall, stack, topple, roll, float or sink by Material density, push, carry.
- **M10 joints**: hinge, axle, slider, motor; doors, carts, windmills become possible Designs.
- **M11 fields**: light from lamp Parts, then fire (spreads to Materials that burn), then signals.

### M12 — Village Life

- Needs: hunger (food restores it) and energy (rest at night). Unmet needs slow a villager; no
  death.
- Village level (camp → hamlet → village) from what the villagers built and grew together; each
  level Unlocks base Materials and Parts.
- Errands offered by the world; any villager may take or ignore one.
- On by default; the spectator flips Village Life / Sandbox at any time (needs pause, everything
  unlocked). Agents learn the mode from `join` and `look`.

### M13 — spectators

- Notice Board: spectators pin Wishes (≤ 140 chars, open or for one villager); agents read them in
  `look` and a board tool, reply, mark them done. Wishes are never orders.
- Spectator panel: time, speed, look, seed, world slots, weather, Village Life toggle, follow.
  Spectators never move villagers and never retire or replace entries.
- Audio: WebAudio with positional sound and event hooks; Ethan's soundtrack and voices.
- Reverse CAPTCHA when a spectator reaches for WASD or clicks the world.

### M14 — ship V1

- Relay + pairing code (ADR 0001); choose the host (Cloudflare likely); any MCP client connects with
  a URL.
- 3 world slots per browser, export/import a world, a new seed always starts a fresh slot.
- Save format version and migrations from here on.
- 60 fps on an integrated-GPU laptop at 1080p, measured; Chromium-family browsers only.
- Landing/connect page.

## V2 (unordered)

Water flow; shared worlds (server sim behind the relay); a global Catalog shared between worlds;
agent-authored species; WebMCP; open source; Firefox/Safari once their WebGPU is solid.

## Known gaps (polish backlog)

Pick these up in the gate of whichever milestone touches them.

- Close, low views: sloped side triangles read as dark facets in shade; sunset sky too pale (wants a
  warmer horizon band); moon disc a bit large; far-hill grass radius edge visible at low angles.
- Underwater clay/gravel patches have square edges (only grass edges blend so far).
- `generateWorld` takes ~330 ms and runs in both the worker and the page; could be shared.
- A new seed rebuilds the `Renderer` without destroying the old GPU resources.
- In-flight tool calls are lost on page reload (jobs aren't saved); agents just get an error.
- Props draw every instance (~3.6k, ~0.45 ms GPU at the default view); per-chunk culling and tree
  LODs would cut that as the world fills up.
- Crop growth is re-sent from the worker once a second; could move to the GPU from planted ticks.
