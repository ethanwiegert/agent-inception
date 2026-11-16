import { ok, strictEqual } from "node:assert/strict";
import { F } from "./frame.ts";
import { applyLook, LOOKS } from "./look.ts";

function frameAt(time: number, clouds = 0.35, look = LOOKS.natural) {
  const out = new Float32Array(F.size);
  applyLook(out, look, time, 1, { clouds });
  return out;
}

Deno.test("every look writes finite uniforms around the clock, in any weather", () => {
  for (const look of Object.values(LOOKS)) {
    for (let t = 0; t < 1; t += 1 / 48) {
      for (const clouds of [0, 0.35, 1]) {
        const out = frameAt(t, clouds, look);
        ok(out.every(Number.isFinite), `${look.name} at ${t}, clouds ${clouds}`);
      }
    }
  }
});

Deno.test("mist gathers at dawn and dusk, clears by noon, and stays thin", () => {
  const mist = (t: number, clouds = 0) => frameAt(t, clouds)[F.grassBase + 3];
  strictEqual(mist(0.5), 0);
  ok(mist(0.25) > 0.15 && mist(0.75) > 0.15);
  ok(mist(0.75) > mist(0.65) && mist(0.65) >= mist(0.5));
  for (let t = 0; t < 1; t += 1 / 96) ok(mist(t, 1) >= 0 && mist(t, 1) < 0.5);
});

Deno.test("each look carries its bloom to the post pass", () => {
  for (const look of Object.values(LOOKS)) {
    ok(look.bloom > 0 && look.bloom <= 0.25);
    strictEqual(frameAt(0.5, 0.35, look)[F.weather + 3], Math.fround(look.bloom));
  }
});

Deno.test("each look carries its split-tone to the post pass, quiet in Natural", () => {
  for (const look of Object.values(LOOKS)) {
    ok((look.splitTone ?? 0) >= 0 && (look.splitTone ?? 0) <= 0.5);
    strictEqual(
      frameAt(0.5, 0.35, look)[F.lookParams],
      Math.fround(look.splitTone ?? 0),
    );
  }
  strictEqual(LOOKS.natural.splitTone ?? 0, 0);
  ok((LOOKS.storybook.splitTone ?? 0) > 0);
});

Deno.test("the dusk horizon stays warm without outshining the day's", () => {
  const horizon = (t: number) => {
    const out = frameAt(t, 0);
    // As shown: the sky color times the exposure the post pass applies.
    return [0, 1, 2].map((i) => out[F.skyHorizon + i] * out[F.skyZenith + 3]);
  };
  const dusk = horizon(0.75), noon = horizon(0.5);
  ok(dusk[0] > dusk[2] * 1.5, "red over blue at sunset");
  ok(noon[2] > noon[0], "blue over red at noon");
  ok(Math.max(...dusk) <= Math.max(...noon) * 1.25);
});
