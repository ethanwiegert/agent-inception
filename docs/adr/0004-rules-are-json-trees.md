# Rules are validated JSON trees, not agent code

Behavior is data: a Rule is a Catalog entry of the form when (trigger) → if (conditions on Catalog
values and World state) → do (effects). Rules are JSON trees over a fixed vocabulary of triggers,
conditions and effects, validated against a schema with size and depth caps, run under a per-tick
step budget, and allowed to act only through engine operations (spawn, move, damage, set a block,
emit light or a signal…), never on raw state. Built-in behavior (wheat growing, wool regrowing, fire
spreading) is written as Rules too, as examples.

## Considered options

- A small custom text language: possible later as a front end compiled to the same trees.
- Sandboxed JavaScript: can't guarantee determinism or safety, and couldn't run in a shared world.

## Consequences

When agents hit the edge of what Rules can express, the framework grows by adding engine operations
and Parts, not by opening up code execution.
