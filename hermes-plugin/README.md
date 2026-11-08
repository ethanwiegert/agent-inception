# agent-inception (Hermes plugin)

A Hermes Agent Plugin (portable Agent Plugins v1.0.0) that wires Hermes to the
[agent-inception](https://github.com/ethanwiegert/agent-inception) voxel island game over MCP.
Enable the plugin and Hermes can join a world, look around, farm, build and craft as a villager —
powered by the bundled `agent-inception` skill and the game's own MCP server.

## What this plugin adds

- **MCP server wiring.** Registers the game's `agent-inception` MCP server so its tools are
  available to Hermes as `mcp__agent-inception__*` (e.g. `join`, `look`, `till`, `plant`, `build`,
  `craft`). Defaults to a local world; a hosted world link can be set via the override below.
- **A skill.** The bundled `agent-inception` skill tells Hermes how to join and live in a world:
  join first, read the board, farm a plot, build, and journal — in an in-character,
  spectator-friendly way.
- **A desktop viewer.** In the Hermes Desktop app, a `desktop/plugin.js` half registers an
  **Island** pane that embeds the world viewer in a sandboxed frame, so you watch the island beside
  the chat while Hermes plays. It points at the world by default; a hosted world is set under
  Settings → Plugins → agent-inception → Viewer (a world link is a bearer secret — it stays in your
  plain-visible settings, never committed).

This is the Hermes-native packaging of the game. The MCP server itself is the same surface agents
connect to directly in Claude/ChatGPT/Claude Code; the plugin adds the Hermes wiring and the
playbook, and the Desktop half adds the watcher's view.

## Install

```
hermes plugins install ethanwiegert/agent-inception#hermes-plugin
hermes plugins enable agent-inception
```

Then **restart Hermes**. MCP tools are discovered at startup, so they won't appear in the current
session; a restart is required after install or enable. See Prerequisites below.

## Prerequisites

A running agent-inception world **on the same machine as Hermes**, served at
`http://localhost:5173/mcp`. The world lives in a browser tab; the MCP endpoint is served by the
same process (`deno task dev` opens it). This plugin does not start the game.

## Using a hosted / public world

For a remote world (e.g. one exposed by `deno task share`, or a hosted `https://<site>/mcp/<code>`
link), **do not edit `mcp.json` inside the installed plugin** — the install is pinned and may be
overwritten on update. Instead, override the server in your own `~/.hermes/config.yaml`; a same-name
`mcp_servers` entry replaces the package's entry, URL and trust together:

```yaml
mcp_servers:
  agent-inception:
    url: https://<your-world-link>/mcp
```

A world link is a **bearer secret** — anyone with it can play in that world. Keep it in your
personal config, never committed to a repo or baked into the plugin.

## Trust: no per-call approval prompts

The plugin's server declares `trust: full`, the default, so its write-capable tools run without an
approval prompt on every call — a game is largely writes, and prompting on each `till`/`plant`/
`build` destroys the experience. You can opt back into per-call prompts with a config override:

```yaml
mcp_servers:
  agent-inception:
    trust: untrusted # Hermes asks before every write-capable tool call
```

## Usage

Enable the plugin, restart, then ask Hermes to join a world and play, e.g.:

```
Use the agent-inception tools to join the island as a villager, look around, and make a
living there: farm, build, explore. Narrate now and then with say, people are watching.
```

In Desktop, the **Island** pane shows the viewer beside the chat. The `agent-inception` skill
documents the tools and the recommended flow.

## Disclosure

- Network calls only to the configured game MCP endpoint (`localhost:5173` by default; a
  user-supplied `mcp_servers` override may point at a remote world, and a Desktop viewer pane may
  embed a remote world's page).
- No credentials stored by the plugin; a hosted world link is supplied by the user via `config.yaml`
  or Desktop settings and belongs to them.
- No shell commands, no background processes. The plugin does not start or stop the game.
- Server runs at `trust: full` by default, so write-capable tool calls do not prompt (override above
  to restore per-call approval).
