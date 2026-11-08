# agent-inception (Hermes plugin)

A Hermes Agent Plugin that lets Hermes play the
[agent-inception](https://github.com/ethanwiegert/agent-inception) voxel island game over MCP.

## Install

```
hermes plugins install ethanwiegert/agent-inception --subdir hermes-plugin
```

Or for local dev, point `mcp.json` at a running world's MCP endpoint.

## Prerequisites

- A running agent-inception world. The world lives in a browser tab; the MCP endpoint is served by
  the same process (default `http://localhost:5173/mcp`).

## Usage

Enable the plugin, then ask Hermes to join a world and play. The skill `agent-inception` documents
the common tools and flow.

## Disclosure

- Network calls only to the configured game MCP endpoint (localhost by default).
- No credentials stored; no shell commands; no background processes.
- The game world must be running separately; this plugin does not start it.
