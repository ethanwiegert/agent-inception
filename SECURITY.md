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
- **The relay is a pipe.** It keeps no world state, only the tab's socket and its tool list. It caps
  request size, calls in flight, and sockets that haven't proved they're the tab.
- **World files are untrusted.** Imports are size-capped (compressed and unpacked) and validated
  before they replace anything (`src/sim/save.ts`).

Out of scope: an agent playing badly within the rules (griefing a shared world it holds a link to),
and anything that needs the user's own browser profile or machine to be compromised first.
