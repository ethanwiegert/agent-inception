/**
 * Like `shot`, but positions the camera first and prints GPU errors.
 * Usage: deno task camshot out.png "query" '{"distance":60,"pitch":0.2,"yaw":2.1,"dx":-60,"dz":30}'
 * dx/dz offset the view target from the world center; pitch 0 is level, ~1.4 straight down.
 */
import { headless, launch } from "./browser.ts";
import { serve } from "./serve.ts";

const [out = "camshot.png", query = "", cam = "{}"] = Deno.args;
const build = await new Deno.Command("deno", { args: ["task", "-q", "build"] }).output();
if (!build.success) {
  console.error(new TextDecoder().decode(build.stderr));
  Deno.exit(1);
}
const server = serve(0);
const browser = await launch(`http://127.0.0.1:${server.addr.port}/?${query}`);
let fatal = "";
try {
  await browser.waitForFrames(headless ? 4 : 60, headless ? 120_000 : 10_000);
  await browser.evaluate(`(() => {
    const c = __game.camera(), o = ${cam};
    c.snap({ x: c.target[0] + (o.dx ?? 0), z: c.target[2] + (o.dz ?? 0),
      distance: o.distance, pitch: o.pitch, yaw: o.yaw });
    return 1;
  })()`);
  await (headless ? browser.waitForFrames(8, 60_000) : new Promise((r) => setTimeout(r, 2000)));
  fatal = await browser.evaluate<string>(`document.getElementById("fatal").textContent`) ?? "";
  const perf = await browser.evaluate(`__perf.summary()`);
  const errors = await browser.evaluate(`__perf.gpuErrors.slice(0, 3)`);
  await Deno.writeFile(out, await browser.screenshot());
  console.log(JSON.stringify(
    {
      fatal: fatal || null,
      gpuMeasured: !fatal && !headless,
      perf,
      errors,
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
