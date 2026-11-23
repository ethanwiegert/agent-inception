import { deepStrictEqual as assertEquals, ok } from "node:assert/strict";
import { Camera } from "./camera.ts";
import { F } from "./render/frame.ts";
import { GrassRenderer } from "./render/grass.ts";

Deno.test("the spectator camera shows a wider slice of the meadow", () => {
  const camera = new Camera([256, 256], () => 0);
  ok(camera.fovY >= 0.66, `expected a wider vertical FOV, got ${camera.fovY}`);
  ok(camera.fovY <= 0.72, "the wider view should keep the miniature world readable");
});

Deno.test("grass covers the entire island with a bounded near-detail grid", () => {
  const frame = new Float32Array(F.size);
  const count = GrassRenderer.candidates(frame, 256, 240, 56);
  assertEquals(frame[F.wind + 3], 1);
  assertEquals(count, 256 * 240 * 7 + 64 ** 2 * 49);
  assertEquals(GrassRenderer.candidates(frame, 256, 240, 1), 256 * 240);
  const large = GrassRenderer.candidates(frame, 1025, 1023, 64);
  ok(frame[F.wind + 3] > 1);
  ok(large <= 600_000 + 64 ** 2 * 56);
});
