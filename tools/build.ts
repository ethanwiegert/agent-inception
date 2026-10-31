/**
 * Production build: minified `dist/main.js` + `dist/worker.js`, with `web/` copied in beside them,
 * so `dist/` is the whole static site (what `wrangler deploy` uploads as assets).
 */
const bundle = await new Deno.Command("deno", {
  args: [
    "bundle",
    "--platform=browser",
    "--minify",
    "--outdir",
    "dist",
    "src/main.ts",
    "src/worker.ts",
  ],
  stdout: "inherit",
  stderr: "inherit",
}).output();
if (!bundle.success) Deno.exit(1);

async function copy(from: string, to: string) {
  await Deno.mkdir(to, { recursive: true });
  for await (const e of Deno.readDir(from)) {
    if (e.isDirectory) await copy(`${from}/${e.name}`, `${to}/${e.name}`);
    else if (e.isFile) await Deno.copyFile(`${from}/${e.name}`, `${to}/${e.name}`);
  }
}
await copy("web", "dist");
let bytes = 0;
for await (const e of Deno.readDir("dist")) {
  if (e.isFile) bytes += (await Deno.stat(`dist/${e.name}`)).size;
}
console.log(`dist/ ready: ${(bytes / 1024).toFixed(0)} KB at the top level, web/ copied in`);
