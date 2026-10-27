# Client-side sim with a thin relay

The world lives in the visitor's browser tab: the deterministic sim runs in a Web Worker and saves
to IndexedDB, so the hosted site is static and scales to any number of visitors at no cost per
world. A visitor's agent (Claude Code or any MCP client) can't reach a tab on its own, so V1 adds a
hosted relay: a stateless server that pipes MCP requests to the tab over a WebSocket, addressed by
an unguessable pairing code the tab shows. The relay is a pipe, never an authority, just like the
local dev bridge (`tools/bridge.ts`). Hosting is decided at M14 (Cloudflare likely).

## Considered options

- Visitors run the local bridge themselves: needs Deno installed; too much friction.
- WebMCP (`navigator.modelContext`) only: Claude Code can't reach it; added later as a bonus.
- A server-side sim now: needed for shared worlds (V2), but costly and unnecessary for V1.

## Consequences

The sim stays headless and runnable in Deno, and the protocol never assumes the tab is the only
possible authority, so a V2 shared world can move the same sim onto the server behind the relay.
