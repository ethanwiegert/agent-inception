import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { cleanTools } from "../../relay/core.ts";
import { mcpTools, TOOL_DEFS } from "./tools.ts";

/**
 * Hosted agents (Muse, Dots, Grok Bot…) hand the tool schemas to their model's own function API,
 * and some of those refuse JSON Schema that MCP clients take: a list of types, $ref, oneOf…
 * Every schema stays in a plain subset.
 */
Deno.test("mcp: every tool schema is in the plain subset hosted models accept", () => {
  const issues: string[] = [];
  const walk = (s: Record<string, unknown>, path: string) => {
    if (typeof s.type !== "string") issues.push(`${path}: one plain type`);
    for (const k of ["oneOf", "anyOf", "allOf", "$ref", "not", "patternProperties"]) {
      if (k in s) issues.push(`${path}: ${k}`);
    }
    if (s.type === "array" && !s.items) issues.push(`${path}: an array says its items`);
    for (const [k, v] of Object.entries((s.properties ?? {}) as Record<string, unknown>)) {
      walk(v as Record<string, unknown>, `${path}.${k}`);
    }
    if (s.items) walk(s.items as Record<string, unknown>, `${path}[]`);
  };
  for (const t of TOOL_DEFS) {
    walk(t.inputSchema, t.name);
    for (const r of t.inputSchema.required ?? []) {
      if (!(r in t.inputSchema.properties)) issues.push(`${t.name}: requires unknown ${r}`);
    }
  }
  assertEquals(issues, []);
});

Deno.test("mcp: tools carry annotations the relay keeps; reads are marked read-only", () => {
  const tools = cleanTools(mcpTools());
  assertEquals(tools.length, TOOL_DEFS.length);
  const hint = (name: string) => tools.find((t) => t.name === name)!.annotations!;
  for (const name of ["look", "catalog_get", "journal_read", "screenshot"]) {
    assert(hint(name).readOnlyHint, name);
  }
  for (const name of ["join", "walk_to", "say", "catalog_add", "vote"]) {
    assert(!hint(name).readOnlyHint, name);
  }
  assert(hint("ignite").destructiveHint);
  assert(!hint("plant").destructiveHint);
  assert(tools.every((t) => t.annotations?.openWorldHint === false));
});
