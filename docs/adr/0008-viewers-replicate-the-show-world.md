# Visitors watch the show world by replicating it, not by streaming it

The renderer already draws a local sim, and streaming a 256×256×64 island's diffs to every viewer
forever is an expensive way to reuse it. The sim is deterministic by rule (fixed tick, seeded PRNG,
no wall clock, no `Math.random`), so a browser can run the same world from a save snapshot plus the
ordered stream of tool calls the server applied, and draw it with code that already exists. The tab
hashes its state every few seconds and asks for a fresh snapshot when it disagrees.

## Considered options

- Streaming state: bandwidth grows with the island and with every viewer, and needs a serialization
  of everything the renderer reads.
- Server-rendered frames: a video pipeline, and the whole renderer becomes a server cost.
- A screenshot feed: cheap, but a slideshow is not watching.

## Consequences

- Determinism stops being a testing convenience and becomes load-bearing across runtimes; a
  divergence bug looks like a villager standing in two places. It needs a test: replay a save plus N
  tool calls and compare state hashes.
- The tool stream is public, which watching already makes true; it carries no credentials.
- A visitor's tab does the work, so the show world's server cost doesn't grow with viewers — the
  free tier's cost model survives the showroom.
