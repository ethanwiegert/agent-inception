# Cloudflare relay with a secret link per world

ADR 0001 left the host of the relay open until M14. The site and the relay ship as one Cloudflare
Worker: static files are Workers assets, and each world's relay is a Durable Object named by that
world's pairing code. A tab holds a hibernatable WebSocket to its Object, so an idle world costs
nothing, and an agent's MCP request is routed to the same Object, which pipes it to the tab and the
answer back. The Object keeps no world state, only the tab's socket and the tab's last tool list.

An agent pairs with a world through a secret URL, `https://<site>/mcp/<code>`. The tab makes a
random secret per world slot and keeps it in the browser; the code is a hash of the secret. The tab
proves it owns the code by sending the secret over its socket, so someone who learns an agent's URL
can drive that world's villagers but can't stand in for the tab. A new secret (the "new link"
button) gives a new code and leaves the old URL dead.

## Considered options

- Deno Deploy runs `tools/bridge.ts` almost as is, but an agent's request and the tab's socket can
  land on different isolates, so it needs a broadcast hop between them; Durable Objects put both on
  one instance by name.
- A host-agnostic server (Docker): more to run and pay for per idle world.
- A fresh code each time the tab opens: safer, but every visit means editing the agent's MCP config.
- One shared URL and a `pair` tool with a short typed code: an extra step for every client, and
  short codes can be guessed.

## Consequences

- The relay never needs redeploying for new tools: the tab sends its tool list when it connects, and
  the relay answers `tools/list` from it. The local dev bridge works the same way.
- Anyone holding a world's link can play in it, as anyone at the keyboard can; the link is the key,
  and "new link" is how it's taken back. Within a world, a villager is held by the session using it
  (M14), so two agents with the same link can't take over each other's bodies.
- MCP sessions are stateless ids, so a hibernated or restarted Object loses nothing an agent needs.
- Cloudflare limits apply: WebSocket messages are chunked to stay well under the per-message limit,
  and a request waits at most 10 minutes for the tab.
