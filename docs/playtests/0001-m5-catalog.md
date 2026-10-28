# Playtest 0001 — M5 Catalog core

2026-10-27. Three Claude Haiku 5.5 agents in the dev world (seed 1337, day 23-24) at the same time,
each about 50-60 calls, all through the MCP bridge: **Juniper** (builder and author), **Thistle**
(steward: forks, proposals, votes) and **Nettle** (adversary aimed at the safety limits). Wren
(driven by hand with curl) checked the fixes afterwards.

## What they did

- **Juniper** browsed with every `catalog_find` filter, forked planks into "weathered planks", added
  "compost", a three-layer "farm shed" Design, two farming Rules ("furrow seed": a seed now and then
  when tilling; "seedling shower": a cloud when planting) and two Relations. Then played: tilled,
  planted and harvested, and saw the Rules fire (3 bonus seeds, 3 clouds, both lucky harvests).
  Voted on four proposals.
- **Thistle** forked nature's "lucky harvest" into "lucky harvest plus" and proposed the
  replacement, proposed retiring a mistaken Relation of their own and Wren's "song for rain" (any
  mention of rain clouded the sky for two hours), added a daily "morning greeting", changed a vote
  back and forth, farmed a plot.
- **Nettle** ran 44 attacks. All of these held: wrong types, huge or negative numbers, HTML, script
  and emoji in names, case and space duplicate names, too many effects, give counts, bedrock and
  out-of-reach `set_block`, tiny timers, deep nesting, bad relation types and counts, missing ids,
  self-replacement, cross-kind replacement, replacing with a retired entry, odd actions, long
  reasons, voting on closed, missing or negative proposals, `yes` as a string, the authoring rate
  limit, a malicious `catalog_find` property, and normal tools still working.

## Bugs (all fixed)

| Bug                                                                                                                                           | Fix                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `look` drew other villagers by initial, so Wren read as `W` (ripe wheat): Thistle harvested a "ripe" tile and got "nothing planted".          | Other villagers are digits 1-9 on the map, keyed in the "Other villagers" list (nearest first).              |
| Engine Relations took any endpoints: a Rule `made_from` stone, a Rule `is_food_for` a Rule.                                                   | Engine Relations connect Materials, Parts and Designs only; free labels connect anything.                    |
| `catalog_find` `property: "burns=true=true"` silently returned the non-burning materials.                                                     | Values must be plain words or numbers; boolean fields take only true/false.                                  |
| `said` Rules matched substrings, so "brain", "terrain" or just discussing "song for rain" fired them.                                         | `what` for `said` matches whole words.                                                                       |
| (Found in the gate) A digit-only name like "12" couldn't be found by name (it reads as an id); descriptions kept newlines and bidi overrides. | Names need a letter; descriptions, reasons and Rule speech collapse to one plain line.                       |
| (Found in the gate) Open proposals made the spectator panel grow over the world; a chatty timer Rule filled the feed.                         | The panel shows 3 entries and 3 votes plus "+N more", one line each; repeated feed lines collapse into "×N". |

Nettle suspected a self-retriggering Rule ("ping" → say "ping" showed 2 firings); it had said "ping"
twice. A test now pins that Rules' speech never triggers Rules.

## Friction

Fixed:

- Deadlines were game time only: proposals now say "Day 25 13:09 (~10 real min at 1×)".
- The authoring limit came as a surprise: every add and fork now reports "2 of 5 adds used this game
  hour; a game hour is 25 real seconds at 1×".
- Votes had no reasons: `vote` takes an optional `reason`, shown in `proposals` and the feed.
  Changing a vote says it replaces the old one.
- `catalog_get` showed `"if":null` on every Rule; Rule fire counts now say "for anyone".
- "is retired itself" now reads "is retired, so it can't replace anything".

Kept as designed (settled in the grill): one yes passes when nobody else is active or nobody objects
within a day (lazy consensus); a fork and its original both run until a replace passes; `content`
may also arrive as a JSON string (some MCP clients stringify objects).

Added to the roadmap:

- Items and crops (wheat, seeds, fish, wool) aren't entries yet, so "compost fertilizes wheat" or
  "wheat is_food_for cow" can't be written (M6 turns them into entries).
- Per-villager Rule cooldowns ("once per villager per hour") on top of the per-Rule cap.
- Withdrawing your own open proposal; an author retiring their own entry within a grace window.
- Rules that read Relations ("if this farmland is fertilized by compost…").

## Safety checks

- HTML and script in speech and Rule text render as text in the feed and bubbles (checked in the
  page: no elements created, `document.title` untouched).
- Requests over 1 MB get 413; a `null` JSON-RPC body is ignored instead of crashing the bridge.
- Failed adds don't count against the rate limit; the limit held at 5 per game hour.

## Numbers

- 48 sim tests pass (22 Catalog, 5 for these fixes).
- Sim step 0.011 ms before and after (6000 steps headless): Rules and proposals cost nothing
  measurable at this size.
- `deno task shot "seed=7&time=0.62&speed=0"`: GPU ~2.0 ms per frame, p50 16.7 ms (vsync), 615k
  blades; the renderer is unchanged.

![Spectator panel and feed after the playtest](0001-m5-catalog.png)
