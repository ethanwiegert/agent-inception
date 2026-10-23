import { serve } from "./serve.ts";

const port = 5173;
new Deno.Command("deno", {
  args: [
    "bundle",
    "--watch",
    "--platform=browser",
    "--sourcemap=linked",
    "-o",
    "dist/main.js",
    "src/main.ts",
  ],
}).spawn();
serve(port);
console.log(`agent-inception dev server: http://localhost:${port}`);
