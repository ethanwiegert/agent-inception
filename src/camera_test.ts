import { deepStrictEqual as assertEquals, ok } from "node:assert/strict";
import { Camera } from "./camera.ts";
import { GrassRenderer } from "./render/grass.ts";

Deno.test("the spectator camera shows a wider slice of the meadow", () => {
  const camera = new Camera([256, 256], () => 0);
  ok(camera.fovY >= 0.66, `expected a wider vertical FOV, got ${camera.fovY}`);
  ok(camera.fovY <= 0.72, "the wider view should keep the miniature world readable");
});

Deno.test("wider grass uses a cheap outer grid instead of full-density candidates", () => {
  const count = GrassRenderer.instanceCount as unknown as (
    radius: number,
    blades: number,
    fovReach: number,
  ) => number;
  assertEquals(count(40, 64, 1), 409600);
  // 100² outer cells × 8 blades + 80² inner cells × 56 additional blades.
  assertEquals(count(50, 64, 1.25), 438400);
});
