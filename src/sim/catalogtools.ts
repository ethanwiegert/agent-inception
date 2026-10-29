import { Pattern } from "./blocks.ts";
import {
  AUTHORED_KINDS,
  ENGINE_RELATIONS,
  type Entry,
  KINDS,
  type MaterialContent,
  type Proposal,
  type RelationContent,
  ZONES,
} from "./catalog.ts";
import { type Args, clock, type Handler } from "./jobs.ts";
import { RULE_EVENTS, RULE_LIMITS, type RuleContent } from "./rules.ts";
import { type Agent, type Sim, TICK_HZ } from "./sim.ts";
import type { ToolDef } from "./tools.ts";

/** Catalog tools: find and read entries, add and fork them, propose and vote on changes. */

/** Entries a villager may add per game hour and per game day. */
export const AUTHOR_LIMITS = { hour: 5, day: 50 } as const;
const PAGE = 25;

const ref = (description: string) => ({
  type: ["string", "integer"],
  description: `${description} An id like 12 or a name.`,
});

export const CATALOG_TOOL_DEFS: ToolDef[] = [
  {
    name: "catalog_find",
    description: "Search the Catalog: the world's shared list of every kind of thing that can " +
      "exist (Materials, Parts, Designs, Rules, Relations) and how they relate. All filters are " +
      "optional; with none you get an overview. Retired entries are hidden unless you ask.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...KINDS] },
        text: { type: "string", description: "Words to look for in names and descriptions." },
        author: { type: "string", description: 'A villager\'s name, or "nature".' },
        property: {
          type: "string",
          description: 'A content field test, like "burns", "density>2", "pattern=planks" or ' +
            '"type=made_from". Operators: = != < <= > >=.',
        },
        related_to: ref("Only entries connected to this one by a Relation (and the Relations)."),
        include_retired: { type: "boolean" },
        page: { type: "integer", minimum: 1, description: `${PAGE} results per page.` },
      },
    },
  },
  {
    name: "catalog_get",
    description: "Read one Catalog entry in full: its content, author, what it was forked " +
      "from, its forks, its Relations, proposals about it, and for Rules how often they fired.",
    inputSchema: {
      type: "object",
      properties: { entry: ref("The entry.") },
      required: ["entry"],
    },
  },
  {
    name: "catalog_add",
    description: "Add a new entry to the Catalog. Entries are permanent and shared: anyone can " +
      "read, fork and use them, and they never change (fork to make a variant). " +
      `You can add ${AUTHOR_LIMITS.hour} entries per game hour. The content per kind:\n` +
      '- material: {"form": "item", "color": "#a0522d", "pattern": "planks", "density": 0.6, ' +
      '"hardness": 2, "burns": true, "glows": 0}. form is "block" (the default; it can be a ' +
      'placeable block), "item" (carried: seeds, wool, fish) or "liquid" (nature only). ' +
      "density in g/cm³ (water 1), hardness 0-10, glows 0-1. " +
      `Patterns: ${Object.keys(Pattern).join(", ")}.\n` +
      '- design: {"blocks": {"palette": {"s": "stone"}, "layers": [["sss", "s.s"]]}, "parts": ' +
      '[{"part": "cone", "material": "planks", "at": [0.5, 0.5, 0.5], "size": [0.2, 1, 0.2], ' +
      '"turn": 0, "tilt": 10, "role": "head"}], "joints": {"head": [0.5, 0.2, 0.5]}, ' +
      '"mark": "T", "habitat": {"on": ["grass"], "zones": ["meadow"], "share": 0.25}}. ' +
      "layers go bottom up; a layer is rows along z, each row characters along x, " +
      `"." empty. Parts: box, sphere, cylinder, cone. turn is yaw in degrees, tilt leans that ` +
      "way. role and joints make a body move (body, head, eyes, left arm, left leg, front left " +
      "leg, product, …). mark is one look-map character. habitat says the ground it grows on " +
      `and where nature plants it (zones: ${ZONES.join(", ")}); (0.5, 0, 0.5) is the tile ` +
      "center on the ground. Up to 16×16×16 blocks and 32 parts. build makes a Design: its " +
      "blocks are laid as blocks and its parts become one Object (each part costs its volume " +
      "in its Material, at least 1).\n" +
      '- rule: {"when": ..., "if": ..., "do": [...]}, live as soon as it\'s added. ' +
      `when: {"event": "harvested", "what": "wheat"} (events: ${RULE_EVENTS.join(", ")}; ` +
      'optional "what" matches the block, crop, fish or villager, or words for said), ' +
      '{"every": 60} game minutes (10-1440), or {"daily": 6} (hour). ' +
      'if (optional): {"chance": 0.2}, {"time": [18, 6]}, {"clouds_above": 0.6}, ' +
      '{"clouds_below": 0.3}, {"has": {"item": "wheat", "count": 2}}, ' +
      '{"block": {"at": [0, -1, 0], "is": "stone"}}, {"all": [...]}, {"any": [...]}, ' +
      `{"not": {...}}. do (1-${RULE_LIMITS.effects}): ` +
      `{"give": {"item": "wheat_seeds", "count": 1}} (≤${RULE_LIMITS.give}), ` +
      '{"take": {"item": "wheat", "count": 1}}, {"set_block": {"at": [0, 1, 0], "to": ' +
      `"cobble"}} ("air" clears), {"say": "text"}, {"weather": {"clouds": 0.8, "hours": 3}}, ` +
      `{"spread": {"what": "poppies", "count": 2}} (≤${RULE_LIMITS.spread}; copies that many ` +
      "fully grown plants onto free neighbouring tiles the habitat allows, and stops where " +
      `${RULE_LIMITS.crowd} neighbours already hold it). ` +
      `"at" is an offset (each -${RULE_LIMITS.reach}..${RULE_LIMITS.reach}) from the event's ` +
      "block; give, take, has, block and set_block need an event trigger. spread works on a " +
      "timer. A rule fires at most " +
      `${RULE_LIMITS.firingsPerHour} times per game hour and can't trigger other rules.\n` +
      '- relation: {"type": "grows_into", "from": "wheat seeds", "to": "wheat crop", "count": 1, ' +
      '"hours": 18}. hours is only for grows_into: game hours from planting to grown. ' +
      '{"type": "made_from", "from": "oak boards", "to": "log", "count": 4} is a recipe for ' +
      "craft: count of from out of one to (nature's own Materials keep nature's recipes; " +
      "invent a Material and give it one). drops says what interact or digging gives. Engine " +
      `types the world will enforce: ${ENGINE_RELATIONS.join(", ")}; or your own ` +
      'lower_snake_case label like "sacred_to" that just records knowledge. No name needed.\n' +
      'Read worked examples with catalog_get: "lucky harvest", "dawn chorus", "wildflowers ' +
      'spread", "stone bench".',
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: AUTHORED_KINDS },
        name: { type: "string", description: "1-40 letters, digits, spaces, ' _ -. Unique." },
        description: { type: "string", maxLength: 280, description: "What it is, in a line." },
        content: { type: "object", description: "The entry itself; see above per kind." },
      },
      required: ["kind", "content"],
    },
  },
  {
    name: "catalog_fork",
    description: "Make a new entry from an existing one: its content with your changes on top " +
      "(top-level fields replace the original's). The fork records where it came from. This is " +
      "how things change here; the original stays as it is. Counts toward your authoring limit.",
    inputSchema: {
      type: "object",
      properties: {
        from: ref("The entry to fork."),
        name: { type: "string", description: "A new unique name (relations need none)." },
        description: { type: "string", maxLength: 280 },
        changes: {
          type: "object",
          description: 'Fields to change, e.g. {"color": "#6b8e4e"} for a material or ' +
            '{"do": [...]} for a rule.',
        },
      },
      required: ["from"],
    },
  },
  {
    name: "propose",
    description: "Ask the villagers to retire an entry (nothing new is made from it; what " +
      "exists stays) or to replace it with another of the same kind (the world produces that " +
      "instead). Votes are open for one game day; it closes early once every villager active " +
      "in the last day has voted, and passes if yes outnumber no. Your own yes is counted.",
    inputSchema: {
      type: "object",
      properties: {
        entry: ref("The entry to change."),
        action: { type: "string", enum: ["retire", "replace"] },
        replacement: ref("For replace: the entry that takes its place."),
        reason: { type: "string", maxLength: 280, description: "Why, for the other villagers." },
      },
      required: ["entry", "action", "reason"],
    },
  },
  {
    name: "vote",
    description: "Vote yes or no on an open proposal. You can change your vote until it closes.",
    inputSchema: {
      type: "object",
      properties: {
        proposal: { type: "integer", description: "The proposal number." },
        yes: { type: "boolean" },
        reason: { type: "string", maxLength: 280, description: "Optional: why, for the others." },
      },
      required: ["proposal", "yes"],
    },
  },
  {
    name: "proposals",
    description: "List open proposals and the most recent decisions.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ---------------------------------------------------------------- handlers

export const CATALOG_HANDLERS: Record<string, Handler> = {
  catalog_find: (sim, _agent, args) => find(sim, args),
  catalog_get: (sim, _agent, args) => get(sim, sim.catalog.resolve(args.entry)),

  catalog_add(sim, agent, args) {
    allowAuthoring(sim, agent);
    const e = sim.catalog.add(
      { kind: args.kind, name: args.name, description: args.description, content: args.content },
      agent.name,
      sim.tick,
    );
    authored(sim, agent, `added ${e.kind} "${e.name}"`);
    return `Added #${e.id} ${e.kind} "${e.name}". ${afterAdd(sim, e)} ${budget(sim, agent)}`;
  },

  catalog_fork(sim, agent, args) {
    const from = sim.catalog.resolve(args.from);
    allowAuthoring(sim, agent);
    const e = sim.catalog.fork(
      from,
      { name: args.name, description: args.description, changes: args.changes },
      agent.name,
      sim.tick,
    );
    authored(sim, agent, `forked "${from.name}" into "${e.name}"`);
    return `Forked #${from.id} "${from.name}" into #${e.id} "${e.name}". ${afterAdd(sim, e)} ${
      budget(sim, agent)
    }`;
  },

  propose(sim, agent, args) {
    const c = sim.catalog;
    const entry = c.resolve(args.entry);
    const replacement = args.replacement === undefined || args.replacement === null ||
        args.replacement === ""
      ? null
      : c.resolve(args.replacement, "replacement");
    const p = c.propose(
      agent.name,
      entry,
      args.action,
      replacement,
      args.reason,
      sim.tick,
      sim.tick + sim.ticksPerDay,
    );
    sim.events.push({
      type: "catalog",
      agent: agent.id,
      text: `proposes to ${proposalWhat(sim, p)}: “${p.reason}”`,
    });
    sim.settleProposals();
    if (p.status !== "open") {
      return `Proposal #${p.id} ${p.status} at once (${p.outcome}): every active villager has ` +
        "voted.";
    }
    return `Proposal #${p.id} is open until ${when(sim, p.closes)}. Other villagers can vote ` +
      "with vote; it closes early once everyone active has voted.";
  },

  vote(sim, agent, args) {
    const p = sim.catalog.vote(agent.name, args.proposal, args.yes, args.reason);
    const why = p.votes.find(([v]) => v === agent.name)![2];
    sim.events.push({
      type: "catalog",
      agent: agent.id,
      text: `votes ${args.yes ? "yes" : "no"} on #${p.id} (${proposalWhat(sim, p)})` +
        (why ? `: “${why}”` : ""),
    });
    sim.settleProposals();
    return p.status === "open"
      ? `Voted ${args.yes ? "yes" : "no"} on #${p.id} (a new vote replaces your old one). ${
        tally(p)
      }; open until ${when(sim, p.closes)}.`
      : `Voted. Proposal #${p.id} ${p.status} (${p.outcome}).`;
  },

  proposals(sim) {
    const all = sim.catalog.proposals;
    const open = all.filter((p) => p.status === "open");
    const done = all.filter((p) => p.status !== "open").slice(-8).reverse();
    const lines = [open.length ? "Open:" : "No open proposals."];
    for (const p of open) {
      lines.push(
        `  #${p.id} ${p.by}: ${proposalWhat(sim, p)} (${tally(p)}; until ${when(sim, p.closes)})`,
        ...p.votes.map(([v, yes, why]) =>
          `    ${v} ${yes ? "yes" : "no"}${why ? `: “${why}”` : ""}`
        ),
      );
    }
    if (done.length) {
      lines.push("Recent decisions:");
      for (const p of done) {
        lines.push(`  #${p.id} ${proposalWhat(sim, p)}: ${p.status} (${p.outcome}), by ${p.by}`);
      }
    }
    lines.push(
      `Active villagers (vote counts wait for them): ${sim.activeVillagers().join(", ")}.`,
    );
    return lines.join("\n");
  },
};

/** A short line for `look` and `join`. */
export function catalogSummary(sim: Sim): string {
  const c = sim.catalog;
  const mine = c.entries.filter((e) => e.author !== "nature").length;
  const open = c.open().length;
  const latest = [...c.entries].reverse().find((e) =>
    e.author !== "nature" && e.kind !== "relation"
  );
  return `Catalog: ${c.entries.length} entries (${mine} by villagers)` +
    (latest ? `, newest ${latest.kind} "${latest.name}" by ${latest.author}` : "") +
    (open ? `; ${open} open proposal${open === 1 ? "" : "s"} — see proposals` : "") +
    ". Browse with catalog_find.";
}

// ---------------------------------------------------------------- helpers

function allowAuthoring(sim: Sim, agent: Agent) {
  const hour = sim.ticksPerDay / 24;
  agent.authored = agent.authored.filter((t) => sim.tick - t < sim.ticksPerDay);
  const lastHour = agent.authored.filter((t) => sim.tick - t < hour);
  if (lastHour.length >= AUTHOR_LIMITS.hour) {
    const wait = Math.ceil((lastHour[0] + hour - sim.tick) / (sim.ticksPerDay / 1440));
    throw new Error(
      `You've added ${AUTHOR_LIMITS.hour} entries this game hour. Try again in ~${wait} game ` +
        "minutes.",
    );
  }
  if (agent.authored.length >= AUTHOR_LIMITS.day) {
    throw new Error(`You've added ${AUTHOR_LIMITS.day} entries today. Try again tomorrow.`);
  }
}

/** How much of this game hour's authoring allowance is used. */
function budget(sim: Sim, agent: Agent): string {
  const used = agent.authored.filter((t) => sim.tick - t < sim.ticksPerDay / 24).length;
  return `(${used} of ${AUTHOR_LIMITS.hour} adds used this game hour; a game hour is ` +
    `${Math.round(sim.ticksPerDay / 24 / TICK_HZ)} real seconds at 1×.)`;
}

function authored(sim: Sim, agent: Agent, text: string) {
  agent.authored.push(sim.tick);
  sim.events.push({ type: "catalog", agent: agent.id, text });
}

function afterAdd(sim: Sim, e: Entry): string {
  if (e.kind === "rule") return "It's live now; check how it fires with catalog_get.";
  if (e.kind === "relation") {
    const r = e.content as RelationContent;
    if (r.type !== "made_from") return "";
    const made = sim.catalog.get(r.from)!.name, from = sim.catalog.get(r.to)!.name;
    return `A recipe: craft "${made}" makes ${r.count} from each ${from}.`;
  }
  return "Anyone can read it with catalog_get.";
}

function when(sim: Sim, tick: number): string {
  const day = Math.floor((tick + sim.dayOffset) / sim.ticksPerDay) + 1;
  const at = `Day ${day} ${clock(((tick + sim.dayOffset) % sim.ticksPerDay) / sim.ticksPerDay)}`;
  if (tick <= sim.tick) return at;
  const minutes = Math.ceil((tick - sim.tick) / TICK_HZ / 60);
  return `${at} (~${minutes} real min at 1×)`;
}

function tally(p: Proposal): string {
  const yes = p.votes.filter(([, y]) => y).length;
  return `${yes} yes, ${p.votes.length - yes} no`;
}

function proposalWhat(sim: Sim, p: Proposal): string {
  const e = sim.catalog.get(p.entry)!;
  return p.action === "retire"
    ? `retire #${e.id} "${e.name}"`
    : `replace #${e.id} "${e.name}" with #${p.replacement} "${
      sim.catalog.get(p.replacement!)!.name
    }"`;
}

function status(sim: Sim, e: Entry): string {
  if (!e.retired) return "";
  if (e.replacedBy === null) return " [retired]";
  return ` [replaced by #${e.replacedBy} "${sim.catalog.get(e.replacedBy)!.name}"]`;
}

/** One line per entry for lists. */
function line(sim: Sim, e: Entry): string {
  let extra = "";
  if (e.kind === "material") {
    const m = e.content as MaterialContent;
    extra = ` (density ${m.density}, hardness ${m.hardness}${m.burns ? ", burns" : ""}${
      m.glows ? `, glows ${m.glows}` : ""
    })`;
  }
  const by = e.author === "nature" ? "nature" : e.author;
  const desc = e.description ? ` — ${e.description}` : "";
  return `#${e.id} ${e.kind} "${e.name}" by ${by}${extra}${status(sim, e)}${desc}`;
}

/** A content field test like "density>2" or "burns". */
function propertyTest(expr: string): (e: Entry) => boolean {
  const m = /^\s*([a-z_]+)\s*(?:(<=|>=|!=|=|<|>)\s*(.+?))?\s*$/i.exec(expr);
  if (!m) throw new Error('property looks like "burns", "density>2" or "pattern=planks".');
  const [, key, op, rawValue] = m;
  if (op && !/^[\w .#-]+$/.test(rawValue)) {
    throw new Error('property looks like "burns", "density>2" or "pattern=planks".');
  }
  if (op && op !== "=" && op !== "!=" && !Number.isFinite(Number(rawValue))) {
    throw new Error(`"${op}" compares numbers, like "density${op}2".`);
  }
  return (e) => {
    const v = (e.content as unknown as Record<string, unknown>)[key];
    if (!op) return Boolean(v);
    if (v === undefined) return false;
    if (typeof v === "boolean" && rawValue !== "true" && rawValue !== "false") {
      throw new Error(`"${key}" is true or false.`);
    }
    const target = typeof v === "number"
      ? Number(rawValue)
      : typeof v === "boolean"
      ? rawValue === "true"
      : rawValue.toLowerCase();
    const value = typeof v === "string" ? v.toLowerCase() : v;
    switch (op) {
      case "=":
        return value === target;
      case "!=":
        return value !== target;
      case "<":
        return (value as number) < (target as number);
      case "<=":
        return (value as number) <= (target as number);
      case ">":
        return (value as number) > (target as number);
      default:
        return (value as number) >= (target as number);
    }
  };
}

function find(sim: Sim, args: Args): string {
  const c = sim.catalog;
  const filters: ((e: Entry) => boolean)[] = [];
  const said: string[] = [];
  if (args.kind !== undefined && args.kind !== "") {
    const kind = String(args.kind).toLowerCase();
    if (!(KINDS as readonly string[]).includes(kind)) {
      throw new Error(`kind must be one of ${KINDS.join(", ")}.`);
    }
    filters.push((e) => e.kind === kind);
    said.push(`kind ${kind}`);
  }
  if (typeof args.text === "string" && args.text.trim()) {
    const words = args.text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    filters.push((e) => {
      const hay = `${e.name} ${e.description}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    said.push(`text "${args.text.trim().slice(0, 40)}"`);
  }
  if (typeof args.author === "string" && args.author.trim()) {
    const a = args.author.trim().toLowerCase();
    filters.push((e) => e.author.toLowerCase() === a);
    said.push(`author ${a}`);
  }
  if (typeof args.property === "string" && args.property.trim()) {
    filters.push(propertyTest(args.property.slice(0, 60)));
    said.push(`property ${args.property.trim().slice(0, 60)}`);
  }
  if (args.related_to !== undefined && args.related_to !== "") {
    const hub = c.resolve(args.related_to);
    const near = new Set<number>();
    for (const r of c.relationsOf(hub.id)) {
      const rc = r.content as RelationContent;
      near.add(r.id).add(rc.from).add(rc.to);
    }
    near.delete(hub.id);
    filters.push((e) => near.has(e.id));
    said.push(`related to "${hub.name}"`);
  }
  if (!args.include_retired) filters.push((e) => !e.retired);
  if (!said.length) return overview(sim);
  const hits = c.entries.filter((e) => filters.every((f) => f(e)));
  const page = Math.max(1, Math.floor(Number(args.page) || 1));
  const shown = hits.slice((page - 1) * PAGE, page * PAGE);
  if (!hits.length) return `No entries match ${said.join(", ")}.`;
  const more = hits.length > page * PAGE ? ` More with page ${page + 1}.` : "";
  return `${hits.length} match ${said.join(", ")}:\n${shown.map((e) => line(sim, e)).join("\n")}${
    more ? `\n${more.trim()}` : ""
  }`;
}

function overview(sim: Sim): string {
  const c = sim.catalog;
  const counts = KINDS.map((k) => {
    const n = c.entries.filter((e) => e.kind === k && !e.retired).length;
    return `${n} ${k}${n === 1 ? "" : "s"}`;
  });
  const recent = c.entries.filter((e) => e.author !== "nature").slice(-8).reverse();
  return [
    `The Catalog holds ${counts.join(", ")} (retired ones hidden).`,
    "Materials are what things are made of; Parts are shapes the engine simulates; Designs are " +
    "recipes of blocks and parts; Rules say when something happens and what the engine does; " +
    "Relations connect entries. Filter with kind, text, author, property or related_to.",
    recent.length ? "Newest by villagers:" : "Villagers haven't added anything yet. Be the first.",
    ...recent.map((e) => "  " + line(sim, e)),
  ].join("\n");
}

function get(sim: Sim, e: Entry): string {
  const c = sim.catalog;
  const lines = [line(sim, e), `Added ${when(sim, e.created)} by ${e.author}.`];
  if (e.forkedFrom !== null) {
    const f = c.get(e.forkedFrom)!;
    lines.push(`Forked from #${f.id} "${f.name}" by ${f.author}.`);
  }
  const content = e.kind === "relation"
    ? relationText(sim, e)
    : JSON.stringify(e.content, (k, v) => (k === "if" && v === null ? undefined : v));
  lines.push(`Content: ${content}`);
  const forks = c.forksOf(e.id);
  if (forks.length) {
    lines.push(
      `Forks: ${forks.slice(0, 12).map((f) => `#${f.id} "${f.name}" by ${f.author}`).join(", ")}`,
    );
  }
  if (e.kind !== "relation") {
    const rels = c.relationsOf(e.id).filter((r) => !r.retired);
    if (rels.length) {
      lines.push(
        "Relations:",
        ...rels.slice(0, 20).map((r) => `  #${r.id} ${relationText(sim, r)}`),
      );
    }
  }
  const about = c.proposals.filter((p) => p.entry === e.id || p.replacement === e.id);
  if (about.length) {
    lines.push(
      "Proposals:",
      ...about.slice(-5).map((p) =>
        `  #${p.id} ${proposalWhat(sim, p)} by ${p.by}: ${p.status}` +
        (p.status === "open" ? ` (${tally(p)})` : ` (${p.outcome})`)
      ),
    );
  }
  if (e.kind === "rule") {
    const s = sim.rules.stats.get(e.id);
    const rule = e.content as RuleContent;
    const trigger = "event" in rule.when
      ? `on ${rule.when.event}${rule.when.what ? ` of "${rule.when.what}"` : ""}`
      : "every" in rule.when
      ? `every ${rule.when.every} game minutes`
      : `daily at ${rule.when.daily}:00`;
    lines.push(
      `Runs ${trigger}. Fired ${s?.fired ?? 0} times, for anyone` +
        (s?.dropped ? `, ${s.dropped} dropped by the limits` : "") +
        (s?.skipped ? `; last skipped effect: ${s.skipped}` : "") + ".",
    );
  }
  return lines.join("\n");
}

function relationText(sim: Sim, e: Entry): string {
  const r = e.content as RelationContent;
  const from = sim.catalog.get(r.from)!, to = sim.catalog.get(r.to)!;
  const engine = (ENGINE_RELATIONS as readonly string[]).includes(r.type) ? "" : " (free label)";
  const count = r.count !== 1 ? `${r.count} × ` : "";
  return `${count}"${from.name}" ${r.type} "${to.name}"${engine}`;
}
