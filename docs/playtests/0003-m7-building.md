# Playtest 0003 — M7 building, not a gate

M7 is not done. This note is what this VM could check, and what it could not.

## Checked here

`deno task check` and `deno task test` (the sim and mesh tests, including part placement, wool scale
0.78, and taking an Object down with `interact`). No browser, no agents.

## Not checked

- No WebGPU device in this VM, so no `deno task shot` and no screenshot. No milliseconds are
  recorded. The M6 hardware remeasure is still deferred to Ethan's machine.
- No playtest agents (builder, crafter, adversary). That pass is still the gate.
