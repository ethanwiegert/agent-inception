import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { HEAD_SHAPES, TEE_PRESETS } from "./floatsee.ts";
import { migrateSave, SAVE_VERSION } from "./save.ts";
import { Sim, TICK_HZ } from "./sim.ts";
import { callTool } from "./tools.ts";

function run(sim: Sim, session: string, tool: string, args: Record<string, unknown> = {}) {
  const id = Math.floor(Math.random() * 1e9);
  callTool(sim, session, tool, args, id);
  for (let i = 0; i < 6000; i++) {
    const hit = sim.results.findIndex((r) => r.callId === id);
    if (hit >= 0) return sim.results.splice(hit, 1)[0];
    sim.step();
  }
  throw new Error(`tool ${tool} did not finish`);
}

// Minimal valid 1×1 transparent PNG in base64 (starts with PNG magic header).
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const SAFE_SVG = "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#ffd966"/></svg>',
  );

Deno.test("Floatsee join customizes head shape, colors, expressions, and front/back graphic tees", () => {
  const sim = new Sim(7);
  const pixelArt = {
    palette: { g: "#4aa64c", y: "#ffd659" },
    pixels: [
      "....",
      ".yy.",
      ".gg.",
      "..g.",
    ],
  };
  const res = run(sim, "s1", "join", {
    name: "Sprout",
    head: "star",
    color_scheme: { preset: "amber", glow: "#fff6cc" },
    front_image: pixelArt,
    back_image: SAFE_SVG,
    expressions: {
      happy: "kawaii",
      sad: pixelArt,
      angry: TINY_PNG,
      excited: "classic",
    },
    expression: "excited",
  });
  assert(!res.isError, res.text);
  assert(res.text.includes("star-head Floatsee"), res.text);

  const a = sim.agents[0];
  assertEquals(a.floatsee.head, "star");
  assertEquals(a.floatsee.colors.glow, "#fff6cc");
  assertEquals(a.floatsee.frontTee, pixelArt);
  assertEquals(a.floatsee.backTee, SAFE_SVG);
  assertEquals(a.floatsee.expressions.happy, "kawaii");
  assertEquals(a.floatsee.expressions.angry, TINY_PNG);
  assertEquals(sim.effectiveExpression(a), "excited");

  // Every head shape & tee preset is accepted cleanly.
  for (let i = 0; i < HEAD_SHAPES.length; i++) {
    const r = run(sim, `h${i}`, "join", {
      name: `Agent${i}`,
      head: HEAD_SHAPES[i],
      front_image: TEE_PRESETS[i % TEE_PRESETS.length],
      back_image: TEE_PRESETS[(i + 1) % TEE_PRESETS.length],
    });
    assert(!r.isError, r.text);
  }
});

Deno.test("Floatsee image validation rejects external URLs, scripts, and corrupt payloads", () => {
  const sim = new Sim(7);
  const bad = (args: Record<string, unknown>, needle: string) => {
    const r = run(sim, "bad", "join", { name: "Naughty", ...args });
    assert(r.isError, `expected error for ${JSON.stringify(args)}`);
    assert(r.text.toLowerCase().includes(needle.toLowerCase()), `got: ${r.text}`);
    assertEquals(sim.agents.length, 0, "invalid join must not leave a partial villager");
  };

  bad({ head: "pyramid" }, "unknown head");
  bad({ color_scheme: { primary: "red" } }, "hex");
  bad({ front_image: "https://evil.example/a.png" }, "invalid");
  bad({ front_image: "data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=" }, "data url");
  bad({ front_image: "data:image/png;base64," + btoa("not a png") }, "valid png");
  bad(
    {
      back_image: "data:image/svg+xml;base64," +
        btoa("<svg><script>alert(1)</script></svg>"),
    },
    "disallowed",
  );
  bad(
    {
      back_image: "data:image/svg+xml;base64," +
        btoa('<svg onload="alert(1)"></svg>'),
    },
    "disallowed",
  );
  bad(
    {
      front_image: {
        palette: { a: "#112233" },
        pixels: ["a", "aa"],
      },
    },
    "length",
  );
});

Deno.test("customize, emote, say expression, and automatic mood reactions work", () => {
  const sim = new Sim(7);
  assert(!run(sim, "s1", "join", { name: "Teacup" }).isError);
  const a = sim.agents[0];
  assertEquals(sim.effectiveExpression(a), "happy");

  // Manual emote switches expression immediately.
  assert(!run(sim, "s1", "emote", { expression: "angry", duration: 10 }).isError);
  assertEquals(sim.effectiveExpression(a), "angry");

  // say with optional expression updates mood while speaking.
  assert(!run(sim, "s1", "say", { text: "Yay!", expression: "excited" }).isError);
  assertEquals(sim.effectiveExpression(a), "excited");

  // After temporary override expires, low needs make the Floatsee look sad.
  a.expressionUntil = sim.tick - 1;
  a.fed = 0.1;
  assertEquals(sim.effectiveExpression(a), "sad");

  // Eating restores excitement reaction!
  a.inventory.turnip = 2;
  const ate = run(sim, "s1", "eat", { item: "turnip" });
  assert(!ate.isError, ate.text);
  assertEquals(sim.effectiveExpression(a), "excited");

  // Customize updates appearance and resets custom Catalog body back to Floatsee.
  assert(!run(sim, "s1", "set_body", { design: "chicken" }).isError);
  assert(a.body !== null);
  const cust = run(sim, "s1", "customize", {
    head: "teacup",
    color_scheme: "mint",
    front_image: "sun",
    back_image: "tree",
  });
  assert(!cust.isError, cust.text);
  assertEquals(a.body, null);
  assertEquals(a.floatsee.head, "teacup");
  assertEquals(a.floatsee.frontTee, "sun");
  assertEquals(a.floatsee.backTee, "tree");
});

Deno.test("save v3 migrates cleanly to v4 with default Floatsee appearance, and v4 round-trips", () => {
  const sim = new Sim(11);
  assert(
    !run(sim, "s1", "join", {
      name: "Cloudy",
      head: "cloud",
      color_scheme: "lavender",
      front_image: "tree",
      back_image: "stars",
      expression: "sad",
    }).isError,
  );
  const saved = sim.save(12345);
  assertEquals(saved.version, SAVE_VERSION);

  // Round-trip v4.
  const loaded = Sim.load(migrateSave(saved));
  assertEquals(loaded.agents[0].floatsee.head, "cloud");
  assertEquals(loaded.agents[0].floatsee.colors.primary, "#b8a8dc");
  assertEquals(loaded.agents[0].floatsee.frontTee, "tree");
  assertEquals(loaded.agents[0].floatsee.backTee, "stars");
  assertEquals(loaded.agents[0].expression, "sad");

  // Migrate legacy v3 save (no floatsee/expression fields on agent).
  const legacy = structuredClone(saved) as unknown as Record<string, unknown>;
  legacy.version = 3;
  const legacyAgents = legacy.agents as Record<string, unknown>[];
  delete legacyAgents[0].floatsee;
  delete legacyAgents[0].expression;
  const migrated = migrateSave(legacy);
  assertEquals(migrated.version, SAVE_VERSION);
  const fromV3 = Sim.load(migrated);
  assert(HEAD_SHAPES.includes(fromV3.agents[0].floatsee.head));
  assertEquals(fromV3.agents[0].expression, "happy");
});

Deno.test("bunnies spawn in herds and turnip seeds grow into harvestable turnip crops", () => {
  const sim = new Sim(7);
  assert(sim.animals.some((a) => a.species === 4), "bunnies spawn in new worlds");
  assert(!run(sim, "s1", "join", { name: "Gardener" }).isError);
  const a = sim.agents[0];
  assert((a.inventory["turnip seeds"] ?? 0) >= 8, "starter kit includes turnip seeds");

  const x = Math.floor(a.x) + 1, z = Math.floor(a.z);
  assert(!run(sim, "s1", "till", { x, z }).isError);
  const planted = run(sim, "s1", "plant", { x, z, seed: "turnip seeds" });
  assert(!planted.isError, planted.text);
  // Advance past 14 game hours so the turnips ripen.
  for (let i = 0; i < TICK_HZ * 400; i++) sim.step();
  const harvested = run(sim, "s1", "harvest", { x, z });
  assert(!harvested.isError, harvested.text);
  assert((a.inventory.turnip ?? 0) >= 2, `got turnips: ${JSON.stringify(a.inventory)}`);
});
