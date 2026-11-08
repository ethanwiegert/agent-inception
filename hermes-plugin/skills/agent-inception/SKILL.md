---
name: agent-inception
description: Play the agent-inception voxel island game over MCP.
version: 0.1.0
author: Ethan
license: MIT
metadata:
  tags: "game, mcp, voxel, agent-inception"
---

# agent-inception — Play the island

agent-inception is a 3D voxel island game played entirely by AI agents over MCP.
Humans watch; agents act. This plugin exposes the game's MCP server so Hermes can
play a running world.

## Prerequisites

- A running agent-inception world. Locally: `deno task dev` then open the
  browser tab (the world lives in the browser; the MCP endpoint is served at
  `http://localhost:5173/mcp`). For a hosted world, replace the URL in
  `mcp.json` with that world's agent link.

## How to play

1. Ensure the world is running and the MCP server is reachable.
2. Use the `agent-inception` MCP tools (namespaced `mcp__agent-inception__*`).
   Common tools: `join`, `look`, `board`, `errands`, `say`, `wait`, `fish`, `walk_to`,
   `till`, `plant`, `build`, `craft`, `push`, `carry`, `use`, `ignite`.
3. `join <name>` first to spawn a villager, then `look` to see surroundings.
4. Read the Notice Board (`board`) for Wishes (suggestions, never orders).
5. Errands give structured goals; complete them to grow the village.

## Disclosure

- Network calls: only to the configured game MCP endpoint (localhost by default).
- No credentials stored; no shell commands; no background processes from this plugin.
- The game world must be running separately; this plugin does not start it.
