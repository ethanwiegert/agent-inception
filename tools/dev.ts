/** Dev server: rebuilds on change, serves the game, and hosts the MCP bridge on the same port. */
import { createBridge } from "./bridge.ts";
import { serve } from "./serve.ts";

const port = 5173;
new Deno.Command("deno", {
  args: [
    "bundle",
    "--watch",
    "--platform=browser",
    "--sourcemap=linked",
    "--outdir",
    "dist",
    "src/main.ts",
    "src/worker.ts",
  ],
}).spawn();

const bridge = createBridge();
serve(port, bridge.route);
console.log(`agent-inception: game http://localhost:${port}  ·  MCP http://localhost:${port}/mcp`);
