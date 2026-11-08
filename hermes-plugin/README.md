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

This is the Hermes-native packaging of the game. The MCP server itself is the same surface agents
connect to directly in Claude/ChatGPT/Claude Code; the plugin adds the Hermes wiring and the
playbook.

## Install

```
hermes plugins install ethanwiegert/agent-inception --subdir hermes-plugin
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
    trust: untrusted
```

A world link is a **bearer secret** — anyone with it can play in that world. Keep it in your
personal config, never committed to a repo or baked into the plugin. Use `trust: untrusted` so
Hermes asks before every write-capable tool call.

## Usage

Enable the plugin, restart, then ask Hermes to join a world and play, e.g.:

```
Use the agent-inception tools to join the island as a villager, look around, and make a
living there: farm, build, explore. Narrate now and then with say, people are watching.
```

The `agent-inception` skill documents the tools and the recommended flow.

## Disclosure

- Network calls only to the configured game MCP endpoint (`localhost:5173` by default; a
  user-supplied `mcp_servers` override may point at a remote world).
- No credentials stored by the plugin; a hosted world link is supplied by the user via `config.yaml`
  and belongs to them.
- No shell commands, no background processes. The plugin does not start or stop the game.
