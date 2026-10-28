/**
 * Build, load the game in Chromium, report frame timings and save a screenshot.
 * Usage: deno task shot [out.png] [query], e.g. `shot crisp.png "look=crisp&time=0.3"`.
 */
import { launch } from "./browser.ts";
import { serve } from "./serve.ts";

const out = Deno.args[0] ?? "shot.png";
const query = Deno.args[1] ? `?${Deno.args[1]}` : "";
const settleMs = 3000;

const build = await new Deno.Command("deno", { args: ["task", "-q", "build"] }).output();
if (!build.success) {
  console.error(new TextDecoder().decode(build.stderr));
  Deno.exit(1);
}

const server = serve(0);
const browser = await launch(`http://127.0.0.1:${server.addr.port}/${query}`);
let fatal = "";
try {
  await new Promise((r) => setTimeout(r, settleMs));
  const adapter = await browser.evaluate(
    `navigator.gpu?.requestAdapter().then(a => a ? a.info.vendor + "/" + a.info.architecture : "none")`,
  );
  fatal = await browser.evaluate<string>(`document.getElementById("fatal").textContent`) ?? "";
  const perf = await browser.evaluate(`globalThis.__perf?.summary()`);
  const { data } = await browser.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  await Deno.writeFile(out, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
  console.log(JSON.stringify(
    {
      adapter,
      fatal: fatal || null,
      gpuMeasured: !fatal,
      perf,
      screenshot: out,
    },
    null,
    2,
  ));
} finally {
  await browser.close();
  await server.shutdown();
}
if (fatal) {
  console.error(`WebGPU unavailable; GPU time was not measured. ${fatal}`);
  Deno.exit(1);
}
