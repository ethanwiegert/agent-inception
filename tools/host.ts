/**
 * Host a world without a screen or a GPU: a headless Chromium tab (software WebGPU) runs the game
 * page, so agents play over MCP and the `screenshot` tool still works. For servers and cloud VMs.
 *
 *   deno task host                   uses `deno task dev` if it's up, else serves a fresh build
 *   deno task host http://host:port/ any running copy of the game
 *
 * The browser profile (and so the worlds, in its IndexedDB) lives in `AI_HOST_PROFILE`, by default
 * `.host-profile/` here, and survives restarts. If Chromium dies the tab is relaunched.
 */
Deno.env.set("AI_HEADLESS", "1"); // before browser.ts reads it: a host never opens a window
const { launch } = await import("./browser.ts");
const { ensureGame } = await import("./serve.ts");

const CHECK_MS = 30_000;
/** A software screenshot can hold the page for seconds; a minute of silence means it's stuck. */
const CHECK_TIMEOUT_MS = 60_000;
const profile = Deno.env.get("AI_HOST_PROFILE") ?? ".host-profile";

let page = Deno.args[0];
if (!page) page = await ensureGame("host");

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => {
    stopping = true;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A DevTools call that gives up: a dead browser never answers. */
const within = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error(`${what} didn't answer in ${ms / 1000} s`);
    }),
  ]);

while (!stopping) {
  let browser: Awaited<ReturnType<typeof launch>> | null = null;
  try {
    browser = await launch(page, { profile });
    await browser.waitForFrames(1, 180_000);
    const fatal = await within(
      browser.evaluate<string>(`document.getElementById("fatal").textContent`),
      CHECK_TIMEOUT_MS,
      "the page",
    );
    if (fatal) throw new Error(fatal);
    const url = await within(
      browser.evaluate<string | null>(`__game.agentUrl()`),
      CHECK_TIMEOUT_MS,
      "the page",
    );
    console.log(`host: world running headless. Agents connect to ${url ?? "(link pending)"}`);
    // Stay up; a crashed or wedged page shows as a failed check, and the tab is relaunched.
    for (let waited = 0; !stopping; waited += 1000) {
      await sleep(1000);
      if (waited % CHECK_MS) continue;
      const ok = await within(
        browser.evaluate<boolean>(`!!globalThis.__game`),
        CHECK_TIMEOUT_MS,
        "the page",
      );
      if (!ok) throw new Error("the game page went away");
    }
  } catch (e) {
    if (!stopping) console.error(`host: ${(e as Error).message}; relaunching in 5 s`);
    await sleep(5000);
  } finally {
    await browser?.close();
  }
}
Deno.exit(0);
