import { deepStrictEqual as assertEquals, ok } from "node:assert/strict";
import {
  advanceMidday,
  DECODE_HOLD_MS,
  freshMidday,
  type MiddayState,
  NOON,
  SCRUB_MS,
} from "./midday.ts";

const WORLD = "0:7";

interface Step {
  day?: number;
  time: number;
  now?: number;
  gap?: number;
  playing?: boolean;
  audible?: boolean;
  ready?: boolean;
  world?: string;
}

/** Runs samples in order. A start latches `playing` until a step sets `playing: false`. */
function run(steps: Step[]) {
  const state = freshMidday();
  const starts: number[] = [];
  let playing = false;
  let now = 0;
  for (const step of steps) {
    if (step.now !== undefined) now = step.now;
    else now += step.gap ?? 16;
    if (step.playing !== undefined) playing = step.playing;
    const start = advanceMidday(
      state,
      { world: step.world ?? WORLD, day: step.day ?? 1, time: step.time },
      now,
      step.gap ?? 16,
      playing,
      step.audible ?? true,
      step.ready ?? true,
    );
    if (start) {
      starts.push(step.day ?? 1);
      playing = true;
    }
  }
  return { state, starts };
}

Deno.test("the song waits for noon, then starts once that day", () => {
  const morning = run([{ time: 0.3 }, { time: 0.49 }]);
  assertEquals(morning.starts, []);

  const noon = run([{ time: 0.49 }, { time: NOON }, { time: NOON + 0.01 }, { time: 0.7 }]);
  assertEquals(noon.starts, [1]);
  assertEquals(noon.state.playedDay, 1);
});

Deno.test("the next day's noon starts again after the previous play has ended", () => {
  const { starts } = run([
    { time: NOON },
    { day: 1, time: 0.8, playing: false },
    { day: 2, time: 0.4, playing: false },
    { day: 2, time: NOON, playing: false },
    { day: 2, time: 0.52, playing: false },
  ]);
  assertEquals(starts, [1, 2]);
});

Deno.test("a fast clock does not stack a play on every noon the song is still covering", () => {
  const steps: Step[] = [];
  for (let day = 1; day <= 6; day++) {
    for (let time = 0.2; time < 0.9; time += 0.01) steps.push({ day, time });
  }
  // The first noon latches playing for the whole run: later noons must not start.
  const fast = run(steps);
  assertEquals(fast.starts, [1]);
  assertEquals(fast.state.playedDay, 6);

  const released = run([
    ...steps,
    { day: 6, time: 0.95, playing: false },
    { day: 7, time: 0.4, playing: false },
    { day: 7, time: NOON, playing: false },
  ]);
  assertEquals(released.starts, [1, 7]);
});

Deno.test("scrubbing across one or many noons plays once and spends the days landed on", () => {
  const one = run([{ time: 0.3, now: 0 }, { time: 0.8, now: 40, gap: 40 }]);
  assertEquals(one.starts, [1]);
  assertEquals(one.state.playedDay, 1);

  const many = run([
    { day: 1, time: 0.3, now: 0 },
    { day: 4, time: 0.8, now: 50, gap: 50 },
    { day: 4, time: 0.85, playing: false },
    { day: 5, time: NOON, playing: false },
  ]);
  assertEquals(many.starts, [4, 5]);
});

Deno.test("a skip that lands before the next noon does not play at dawn", () => {
  const { starts, state } = run([
    { day: 1, time: 0.3, now: 0 },
    { day: 3, time: 0.2, now: 30, gap: 30 },
    { day: 3, time: NOON, playing: false },
  ]);
  assertEquals(state.playedDay, 3);
  assertEquals(starts, [3]);
});

Deno.test("time spent away does not start the song unless the clock is still near noon", () => {
  const night = run([
    { day: 1, time: 0.3, now: 0 },
    { day: 4, time: 0.8, now: 60_000, gap: 60_000 },
    { day: 4, time: 0.9 },
  ]);
  assertEquals(night.starts, []);
  assertEquals(night.state.playedDay, 4);

  const stillMidday = run([
    { day: 1, time: 0.3, now: 0 },
    { day: 3, time: NOON + 0.01, now: 60_000, gap: 60_000 },
  ]);
  assertEquals(stillMidday.starts, [3]);

  const justOver = run([
    { time: 0.3, now: 0 },
    { time: 0.8, now: SCRUB_MS, gap: SCRUB_MS },
  ]);
  const tooLong = run([
    { time: 0.3, now: 0 },
    { time: 0.8, now: SCRUB_MS + 1, gap: SCRUB_MS + 1 },
  ]);
  assertEquals(justOver.starts, [1]);
  assertEquals(tooLong.starts, []);
});

Deno.test("no gesture yet waits through the grace, then gives the noon up", () => {
  const caught = run([
    { time: NOON + 0.01, audible: false, now: 0 },
    { time: NOON + 0.02, audible: true, now: 1_000 },
  ]);
  assertEquals(caught.starts, [1]);

  const missed = run([
    { time: NOON + 0.01, audible: false, now: 0 },
    { time: 0.7, audible: false, now: 1_000 },
    { time: 0.72, audible: true, now: 2_000 },
  ]);
  assertEquals(missed.starts, []);
  assertEquals(missed.state.playedDay, 1);
});

Deno.test("mute spends a scrubbed noon instead of playing it when sound comes back", () => {
  const { starts, state } = run([
    { time: 0.3, audible: false, now: 0 },
    { time: 0.8, audible: false, now: 40, gap: 40 },
    { time: 0.82, audible: true, now: 80 },
  ]);
  assertEquals(starts, []);
  assertEquals(state.playedDay, 1);
});

Deno.test("a noon that arrives before the file decodes still starts once the buffer is ready", () => {
  const readyInTime = run([
    { time: NOON, ready: false, now: 0 },
    { time: NOON + 0.01, ready: false, now: 1_000 },
    { time: NOON + 0.02, ready: true, now: 2_000 },
  ]);
  assertEquals(readyInTime.starts, [1]);

  const decodedLate = run([
    { time: NOON, ready: false, now: 0 },
    { time: 0.7, ready: true, now: DECODE_HOLD_MS + 50, gap: DECODE_HOLD_MS + 50 },
  ]);
  assertEquals(decodedLate.starts, []);
  assertEquals(decodedLate.state.playedDay, 1);

  const scrub = run([
    { time: 0.3, now: 0 },
    { time: 0.8, ready: false, now: 30, gap: 30 },
    { time: 0.82, ready: true, now: 400, gap: 370 },
  ]);
  assertEquals(scrub.starts, [1]);
});

Deno.test("joining after noon does not play until the next one, and joining at noon does", () => {
  const late = run([{ day: 5, time: 0.8 }, { day: 5, time: 0.9 }, { day: 6, time: NOON }]);
  assertEquals(late.starts, [6]);

  const onTime = run([{ day: 2, time: NOON + 0.01 }]);
  assertEquals(onTime.starts, [2]);
});

Deno.test("a different world, or a day that rewinds, is a new clock", () => {
  const swapped = run([
    { day: 4, time: 0.8, world: "a" },
    { day: 1, time: NOON + 0.01, world: "b" },
  ]);
  assertEquals(swapped.starts, [1]);

  const rewound = run([{ day: 4, time: 0.8 }, { day: 1, time: NOON + 0.01 }]);
  assertEquals(rewound.starts, [1]);
});

Deno.test("a bad clock sample does not start the song or throw", () => {
  const state: MiddayState = freshMidday();
  ok(!advanceMidday(state, { world: WORLD, day: Number.NaN, time: 0.5 }, 0, 0, false, true, true));
  ok(!advanceMidday(state, { world: WORLD, day: 1, time: Number.NaN }, 0, 0, false, true, true));
  assertEquals(state.playedDay, 0);
});

Deno.test("the manifest points at the opus file that ships with the page", async () => {
  const dir = new URL("../web/audio/", import.meta.url);
  const manifest = JSON.parse(await Deno.readTextFile(new URL("manifest.json", dir)));
  assertEquals(manifest.midday, "midday.ogg");
  assertEquals(manifest.music, []);
  const bytes = await Deno.readFile(new URL("midday.ogg", dir));
  assertEquals(bytes.length, 1_221_939);
  assertEquals(bytes[0], 0x4f); // OggS
  assertEquals(bytes[1], 0x67);
  assertEquals(bytes[2], 0x67);
  assertEquals(bytes[3], 0x53);
});
