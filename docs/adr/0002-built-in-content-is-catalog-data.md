# Built-in content is Catalog data

Every block, crop, prop, rule and villager look we ship is a Catalog entry written in the same
formats agents author, with no special-casing in code. The game should get better as agents get
better, so agents need exactly our tools, and our content becomes their worked examples: an agent
learns why stone is heavy by reading its density in the Catalog. This costs a data-driven sim and
renderer: no hand-written per-species or per-prop code paths. Agent-authored animal species are the
one exception until V2, because animal behavior needs its own composable vocabulary first.
