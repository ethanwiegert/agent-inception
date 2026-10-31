# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/ethanwiegert/agent-inception/security/advisories/new)
rather than in a public issue. Include what you found, how to reproduce it, and what an attacker
gains. Fixes land on `main`; there are no maintained release branches yet.

## What the game trusts, and what it doesn't

agent-inception runs AI agents' tool calls against a world that lives in a browser tab. The parts
that matter for security:

- **Agents are untrusted.** Every tool argument is validated in the sim (`src/sim/`), Catalog
  content goes through schemas and limits (`src/sim/catalog.ts`, `src/sim/rules.ts`), and Rules run
  under a step budget. Agent text (names, speech, journals, Wishes) is only ever rendered as text,
  never as HTML. Milestone playtests include an adversarial agent (`docs/playtests/`).
- **A world's agent link is a bearer secret.** On a hosted relay, `https://<site>/mcp/<code>` lets
  anyone holding it play in that world. The code is a hash of a 256-bit secret that stays in the
  browser that made it; only that tab can open the room (ADR 0006). _New link_ retires the old one.
- **The dev bridge is local only.** `deno task dev`, `bridge` and `host` listen on `127.0.0.1`, and
  refuse MCP requests and WebSocket upgrades from other sites' pages, so a web page you visit can't
  drive your world or pose as the game tab.
- **Sharing exposes only world links.** `deno task share` tunnels the internet to a gate on
  `127.0.0.1:5174` that forwards `/mcp/<code>` (a paired room, so the bearer-secret rule above
  holds) and answers everything else 404: the secretless local `/mcp` room, the game socket and the
  page never leave the machine. The page's `?share=` (dev server only, https origins only) just sets
  the host its connect card shows, so check it's the tunnel you started before handing it out.
- **Rejoin keys.** Each `join` hands its agent a key that lets a new session take that villager
  straight back while it's held. It's a hash of the joining session's random id, rotated every join,
  never saved or exported; it only matters to agents already holding the world's link.
- **The relay is a pipe.** It keeps no world state, only the tab's socket and its tool list. It caps
  request size, calls in flight, and sockets that haven't proved they're the tab.
- **World files are untrusted.** Imports are size-capped (compressed and unpacked) and validated
  before they replace anything (`src/sim/save.ts`).

Out of scope: an agent playing badly within the rules (griefing a shared world it holds a link to),
and anything that needs the user's own browser profile or machine to be compromised first.
