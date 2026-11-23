# agent-inception threat model

Builds on the maintainer's `SECURITY.md` ("What the game trusts, and what it doesn't"), cited as
**[SM]**. Facts marked **[SM]** come from `SECURITY.md`; everything else is read from the code.

## System overview and trust boundaries

A browser game: the world (sim) runs in the player's tab; AI agents play it over MCP through a thin
relay (ADR 0001, ADR 0006).

```
agent --POST /mcp/<code>--> relay Room --WebSocket--> game tab (page) --postMessage--> sim worker
```

Trust boundaries:

1. **Agent -> relay -> tab**: every MCP tool call and its arguments are untrusted [SM].
2. **Browser page origin -> relay / bridge**: only no-Origin, localhost, the site's own origin and
   itch.io's two HTML embed CDNs are allowed (`originAllowed`, `ITCH_EMBED_ORIGINS` in
   `relay/core.ts`) [SM].
3. **Tab -> relay**: a socket proves it is the world's tab with the 256-bit secret whose hash is the
   pairing code (`pairingCode`, `Room.hello`) [SM].
4. **World file -> sim**: imported saves are untrusted [SM].
5. **Internet -> developer machine**: `deno task share` exposes only `/mcp/<code>` through a tunnel
   [SM].

## Components

| Component         | Code                                                                                                                                                                                                             | Notes                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Relay**         | `relay/core.ts`, `relay/worker.ts`                                                                                                                                                                               | Cloudflare Worker + Durable Object per pairing code; stateless MCP sessions, framing, body/part/pending caps, origin checks.    |
| **Site**          | `relay/site.ts`, `web/`, `wrangler.jsonc`, `tools/build.ts`                                                                                                                                                      | Static assets, `{{origin}}` templating, security headers (`web/_headers`, `SITE_HEADERS`).                                      |
| **Game page**     | `src/main.ts`, `src/agentlink.ts`, `src/simclient.ts`, `src/connect.ts`, `src/overlay.ts`, `src/devpanel.ts`, `src/camera.ts`, `src/prefs.ts`, `src/support.ts`, `src/captcha.ts`, `src/audio.ts`, `src/render/` | Holds the link secrets (localStorage), routes tool calls, renders agent text (name tags, speech, feed, Notice Board).           |
| **Sim**           | `src/sim/`, `src/worker.ts`                                                                                                                                                                                      | Deterministic tool handlers, Catalog schemas and limits, Rule engine with step budget, save/import validation, IndexedDB slots. |
| **Dev tooling**   | `tools/` (`dev.ts`, `bridge.ts`, `serve.ts`, `host.ts`, `share.ts`, `browser.ts`, `shot*.ts`, `camshot.ts`), `devshot/`                                                                                          | Local bridge on 127.0.0.1 with a secretless `/mcp` room; share gate on :5174; headless host.                                    |
| **Hermes plugin** | `hermes-plugin/`                                                                                                                                                                                                 | MCP config pointing at localhost:5173 with `trust: full`; desktop pane embedding the viewer in a `SandboxedFrame`.              |
| **CI**            | `.github/`                                                                                                                                                                                                       | Read-only token, pinned actions, `persist-credentials: false`.                                                                  |

## Entry points and who can reach them

- `POST/GET /mcp/<code>` on the hosted relay: anyone holding the world link [SM]. Agents are
  untrusted [SM].
- `/tab/<code>` WebSocket: browsers from allowed origins; only the holder of the secret becomes the
  tab [SM]. Unproven sockets are capped (`MAX_WAITING = 4`).
- `/mcp` (no code) on the hosted site: a 404 explainer. Static pages: public.
- Local `deno task dev` / `bridge` / `host`: `127.0.0.1`, secretless `/mcp` room, origin-checked
  [SM].
- `deno task share` gate: internet via tunnel, forwards only `/mcp/<code>` and a header allowlist
  [SM].
- World file import in the page: whatever file the player chooses [SM: untrusted].
- URL params (`seed`, `slot`, `relay`, `share`, `bridge`, `look`, ...) on the page: anyone who can
  get a player to open a link. `share` and `bridge` are dev-server only [SM for `share`].
- Spectator inputs (Notice Board Wishes, panel): the human at the tab.

## Assets

- **World link secret** (per slot, localStorage): lets its holder act as the tab of that world [SM].
- **Player's browser / site origin**: script injection from agent text would reach the link secrets
  and every world slot. Agent text must render only as text [SM].
- **World state** (IndexedDB slots, exports): integrity across worlds; one link must not reach
  another world.
- **Rejoin keys**: reclaim a villager; matter only to agents already holding the link [SM].
- **Hosted relay availability and cost** (Cloudflare Worker, Durable Objects).
- **Developer machine** running dev/host/share: must not be drivable by other web pages or the
  internet beyond `/mcp/<code>` [SM].

## Attacker profiles that matter

- **Malicious agent with a world link** (primary, [SM]): sends arbitrary tool arguments, Catalog
  entries, Rules, names, speech, journals, Wishes. There are no accounts: holding a link is the only
  access [SM].
- **Internet client without a link**: guesses codes, floods the relay, tries to pose as a tab.
- **Malicious web page visited by a player or developer**: tries to drive the local bridge, pose as
  the game tab, or use a link via an allowed origin. Pages on itch's shared embed CDNs that learn a
  link can use it [SM, accepted].
- **Malicious world file** shared with a player [SM].

## Existing controls

- Origin allowlist with exact matching (`originAllowed`); local room never gets extra origins.
- Pairing code = SHA-256 of a 256-bit secret; secret length capped at 128 chars in `hello`;
  `BAD_SECRET` close.
- Request caps: `MAX_BODY` 1 MiB, `MAX_PARTS` 64, `MAX_PENDING` 64, `MAX_WAITING` 4; session ids
  `SESSION_RE`; tool annotations sanitized (`cleanAnnotations`).
- Sim: schema validation of every tool argument, Catalog limits, Rule step budget and firing rate
  cap (`RULE_LIMITS`), deterministic sim.
- Save import size caps (compressed and unpacked) and validation (`src/sim/save.ts`).
- Site headers: `frame-ancestors 'none'`, `nosniff`, `no-referrer`, restrictive Permissions-Policy.
- Share gate: path regex + header allowlist both ways.
- CI: `contents: read`, pinned actions.

## Out of scope / accepted risk ([SM])

- An agent playing badly within the rules (griefing a shared world it holds a link to).
- Anything that needs the user's browser profile or machine to be compromised first.
- Pages on itch's shared embed CDNs (`html-classic.itch.zone`, `html.itch.zone`) being allowed
  origins: documented design; such a page that learns a link can use it.
- The local secretless `/mcp` room not being reachable from itch CDNs is intended (local room has no
  secret).

## Maintainer priorities

- All assets above matter equally, as SECURITY.md is written. No asset is ranked above another and
  no attacker in SECURITY.md is ruled out.

- Dev tooling (`tools/`, including `share`'s public tunnel) ranks the same as the hosted site and
  relay: its findings keep the scanner's severity.

## Open questions

- Cloudflare-side configuration (rate limiting, WAF, custom domain) lives outside the repo; no
  infrastructure repository was provided, so only `wrangler.jsonc` is covered.
