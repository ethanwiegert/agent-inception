/**
 * Build, load the game once, and capture a named set of posed shots plus their perf
 * readings into a directory, for before/after comparisons. The same set on two
 * revisions diffs a rendering change without a display.
 *
 * Usage: deno task shotset out/ [seed=7&speed=1] [only=noon-wide,shore]
 *
 * Each shot holds the weather and the time of day and passes a fixed `at` to
 * `__game.capture`, so a picture is a function of the code, not the clock.
 * `setup` is a JS expression evaluated in the page first (scripted builds; it can
 * `await __game.call("set", tool, args)`).
 */
import { headless, launch } from "./browser.ts";
import { serve } from "./serve.ts";

interface Shot {
  name: string;
  /** Game time of day 0-1 (0.5 = noon). */
  time: number;
  /** Held cloud cover 0-1 (the same value every run so skies compare). */
  clouds: number;
  /** Look id; natural when unset. */
  look?: string;
  /** Camera pose: dx/dz offset from its base, distance, pitch, yaw. */
  pose: { dx?: number; dz?: number; distance: number; pitch: number; yaw: number };
  /** Pose base: the camera target (default), or the village setup's build site. */
  poseBase?: "village";
  /** Render time in ms (wind, waves, drifting clouds); fixed per shot. */
  at: number;
  /** JS to evaluate (awaited) in the page before settling and capturing. */
  setup?: string;
}

const W = 1024, H = 640;

/** The comparison set on seed 7. Poses keep pitch ≥ 0.15 so the eye stays out of the terrain. */
const SHOTS: Shot[] = [
  {
    name: "noon-wide",
    time: 0.5,
    clouds: 0.35,
    pose: { distance: 60, pitch: 0.35, yaw: 2.1 },
    at: 5_000,
  },
  {
    name: "noon-horizon",
    time: 0.5,
    clouds: 0.35,
    pose: { distance: 45, pitch: 0.16, yaw: 0.6 },
    at: 6_000,
  },
  {
    name: "morning-close",
    time: 0.32,
    clouds: 0.35,
    pose: { distance: 18, pitch: 0.3, yaw: 4.0 },
    at: 7_000,
  },
  {
    name: "dusk-into-sun",
    time: 0.74,
    clouds: 0.4,
    pose: { distance: 45, pitch: 0.18, yaw: 2.1 },
    at: 8_000,
  },
  {
    name: "night-moon",
    time: 0.95,
    clouds: 0.1,
    pose: { distance: 55, pitch: 0.3, yaw: 2.6 },
    at: 9_000,
  },
  {
    name: "overcast",
    time: 0.5,
    clouds: 0.9,
    pose: { distance: 60, pitch: 0.35, yaw: 2.1 },
    at: 10_000,
  },
  {
    name: "shore",
    time: 0.45,
    clouds: 0.3,
    pose: { dx: -48, dz: 52, distance: 16, pitch: 0.35, yaw: 5.3 },
    at: 11_000,
  },
  {
    name: "river",
    time: 0.4,
    clouds: 0.3,
    pose: { dx: 6, dz: -34, distance: 15, pitch: 0.32, yaw: 0.4 },
    at: 12_000,
  },
  {
    name: "look-crisp",
    time: 0.5,
    clouds: 0.35,
    look: "crisp",
    pose: { distance: 60, pitch: 0.35, yaw: 2.1 },
    at: 13_000,
  },
  {
    name: "look-lush",
    time: 0.5,
    clouds: 0.35,
    look: "lush",
    pose: { distance: 60, pitch: 0.35, yaw: 2.1 },
    at: 14_000,
  },
  {
    name: "look-storybook",
    time: 0.5,
    clouds: 0.35,
    look: "storybook",
    pose: { distance: 60, pitch: 0.35, yaw: 2.1 },
    at: 15_000,
  },
  {
    name: "village",
    time: 0.38,
    clouds: 0.35,
    pose: { distance: 16, pitch: 0.3, yaw: 0.8 },
    poseBase: "village",
    at: 16_000,
    // A scripted build so built Materials are in frame: dig, gather logs, craft, and raise a
    // small mixed-material wall beside the agent. Joins "Set"; the wall lands east of it.
    setup: `(async () => {
      const call = (tool, args) => __game.call("set", tool, args);
      await call("join", { name: "Set" });
      let me;
      for (let i = 0; i < 60 && !me; i++) {
        me = __game.client.agents(performance.now()).find(a => a.name === "Set");
        if (!me) await new Promise(r => setTimeout(r, 200));
      }
      if (!me) return "no agent";
      const x = Math.floor(me.x), z = Math.floor(me.z);
      const out = [];
      const run = async (tool, args) => {
        const r = await call(tool, args);
        const t = r.isError ? " " + tool + "!:" + r.content?.[0]?.text : "";
        out.push(t);
        return r;
      };
      // The look reply lists gatherables ("a rock to break for stone at x=.. z=.."); visit the
      // first few a walk away, interact (rocks give stone, trees logs), then dig for dirt.
      const look = await call("look", { radius: 6 });
      const text = look.content?.[0]?.text ?? "";
      out.push(look.isError ? " look!:" + text : " spots:" + text.slice(-400));
      const want = /tree|oak|birch|pine|rock|clay|sand/;
      const spots = [...text.matchAll(/(?:a|an) ([a-z ]+?) at x=(\\d+) z=(\\d+)/g)]
        .map(m => ({ kind: m[1], x: +m[2], z: +m[3] }))
        .filter(s => want.test(s.kind)).slice(0, 4);
      for (const s of spots) {
        await run("walk_to", { x: s.x + 1, z: s.z });
        await run("interact", { x: s.x, z: s.z });
      }
      const here = __game.client.agents(performance.now()).find(a => a.name === "Set");
      if (!here) return "lost agent";
      globalThis.__villageAt = [Math.floor(here.x) + 3, Math.floor(here.z) + 2];
      const hx = Math.floor(here.x), hz = Math.floor(here.z);
      await run("break_block", { x: hx - 4, z: hz - 4, width: 2, depth: 2, layers: 4 });
      await run("craft", { item: "planks", times: 6 });
      await run("craft", { item: "cobble", times: 6 });
      // Each call stacks its layer on the columns' tops: passes build a mixed wall.
      for (const block of ["dirt", "sand", "stone", "cobble", "log", "planks"]) {
        const r = await run("place_block",
          { x: hx + 2, z: hz + 2, width: 4, depth: 1, layers: 1, block });
        if (r.isError) continue;
        // Stop once the wall is a few layers tall: enough variety for the picture.
        if (out.filter((s) => !s).length > 6) break;
      }
      // Something burnable beside the wall for night-lamps: a planted sapling.
      await run("plant", { x: hx + 2, z: hz + 4, seed: "oak sapling" });
      globalThis.__fireAt = [hx + 2, hz + 4];
      return "built" + out.join("|");
    })()`,
  },
  {
    name: "night-lamps",
    time: 0.97,
    clouds: 0.1,
    pose: { distance: 14, pitch: 0.25, yaw: 0.8 },
    poseBase: "village",
    at: 17_000,
    // Whatever village left built, plus a fire for flame light: ignite one of the placed
    // planks. Runs after "village" in the default order; needs that shot's agent.
    setup: `(async () => {
      const call = (tool, args) => __game.call("set", tool, args);
      const me = __game.client.agents(performance.now()).find(a => a.name === "Set");
      if (!me) return "no agent";
      const x = Math.floor(me.x), z = Math.floor(me.z);
      // The village setup plants a sapling beside its wall; ignite that tile.
      const at = globalThis.__fireAt ?? [x + 3, z + 2];
      const r = await call("ignite", { x: at[0], z: at[1] });
      return r.isError ? "no fire: " + r.content?.[0]?.text : "lit";
    })()`,
  },
];

const outDir = Deno.args[0] ?? "shotset";
const query = Deno.args[1] ?? "seed=7&speed=1";
const only = Deno.args[2]?.startsWith("only=") ? Deno.args[2].slice(5).split(",") : null;

const build = await new Deno.Command("deno", { args: ["task", "-q", "build"] }).output();
if (!build.success) {
  console.error(new TextDecoder().decode(build.stderr));
  Deno.exit(1);
}

await Deno.mkdir(outDir, { recursive: true });
const server = serve(0);
const browser = await launch(`http://127.0.0.1:${server.addr.port}/?${query}`);
let fatal = "";
try {
  await browser.waitForFrames(headless ? 8 : 60, headless ? 120_000 : 10_000);
  fatal = await browser.evaluate<string>(`document.getElementById("fatal").textContent`) ?? "";
  if (fatal) throw new Error(fatal);
  const results: Record<string, unknown> = {};
  for (const shot of SHOTS) {
    if (only && !only.includes(shot.name)) continue;
    console.log(`shotset: ${shot.name}`);
    if (shot.setup) {
      const r = await browser.evaluate(shot.setup).catch((e) => `setup failed: ${e}`);
      console.log(`  setup: ${r}`);
      // Setups run sim jobs (walking, placing); give them a moment at speed 1.
      await browser.evaluate(`new Promise(r => setTimeout(r, 1500))`);
    }
    const data = await browser.evaluate<string>(`(async () => {
      __game.setLook(${JSON.stringify(shot.look ?? "natural")});
      __game.client.send({ type: "weather", clouds: ${shot.clouds} });
      __game.client.send({ type: "setTime", timeOfDay: ${shot.time} });
      await new Promise(r => setTimeout(r, 600));
      const c = __game.camera();
      const base = ${
      shot.poseBase === "village" ? "(globalThis.__villageAt ?? c.target)" : "c.target"
    };
      const p = ${JSON.stringify(shot.pose)};
      return await __game.capture(${W}, ${H},
        { x: base[0] + (p.dx ?? 0), z: base[1] + (p.dz ?? 0),
          distance: p.distance, pitch: p.pitch, yaw: p.yaw }, ${shot.at});
    })()`);
    const perf = await browser.evaluate(`__perf.summary()`);
    const errors = await browser.evaluate(`__perf.gpuErrors.slice(0, 5)`);
    const png = data.slice(data.indexOf(",") + 1);
    await Deno.writeFile(
      `${outDir}/${shot.name}.png`,
      Uint8Array.from(atob(png), (c) => c.charCodeAt(0)),
    );
    results[shot.name] = { perf, errors };
  }
  await Deno.writeTextFile(
    `${outDir}/report.json`,
    JSON.stringify({ fatal: fatal || null, headless, results }, null, 2),
  );
  console.log(JSON.stringify({ outDir, shots: Object.keys(results), fatal: fatal || null }));
  const bad = Object.entries(results).filter(([, r]) => (r as { errors: string[] }).errors?.length);
  if (bad.length) console.error(`GPU errors in: ${bad.map(([n]) => n).join(", ")}`);
} finally {
  await browser.close();
  await server.shutdown();
}
