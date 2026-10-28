import { BUILTIN_BLOCKS, Pattern, type PatternName } from "./blocks.ts";
import { plainText, type RuleContent, validateRule } from "./rules.ts";

/**
 * The Catalog: every kind of thing that can exist in this world and how those kinds relate. It is
 * a separate store from the World (ADR 0003) and append-only: entries are never edited or deleted,
 * only forked. `retired` and `replacedBy` are the two mutable fields, and they change only when a
 * Proposal passes.
 */

export const KINDS = ["material", "part", "design", "rule", "relation"] as const;
export type Kind = (typeof KINDS)[number];
/** Kinds agents may author. Parts are the engine's to add. */
export const AUTHORED_KINDS: Kind[] = ["material", "design", "rule", "relation"];

export interface MaterialContent {
  /** sRGB "#rrggbb". */
  color: string;
  pattern: PatternName;
  /** g/cm³; water is 1. */
  density: number;
  /** 0 (water) to 10 (diamond). */
  hardness: number;
  burns: boolean;
  /** Light it gives off, 0-1. */
  glows: number;
}

export const PART_SHAPES = ["box", "sphere", "cylinder"] as const;
export interface PartContent {
  shape: (typeof PART_SHAPES)[number];
}

export type Vec3 = [number, number, number];

export interface DesignPart {
  part: string;
  material: string;
  /** Offset of the part's center from the design's origin corner, in blocks. */
  at: Vec3;
  size: Vec3;
  /** Yaw in degrees. */
  turn: number;
}

export interface DesignContent {
  /** Voxel grid: `layers[y][z]` is a row of palette characters along x; "." is empty. */
  blocks: { palette: Record<string, string>; layers: string[][] } | null;
  parts: DesignPart[];
}

/** Relations the world will enforce; any other type is a free label that records knowledge. */
export const ENGINE_RELATIONS = [
  "made_from",
  "drops",
  "grows_into",
  "opens",
  "fuels",
  "is_food_for",
  "needs",
] as const;

export interface RelationContent {
  type: string;
  from: number;
  to: number;
  /** How many: e.g. 4 planks made_from 1 log. */
  count: number;
}

export type Content =
  | MaterialContent
  | PartContent
  | DesignContent
  | RuleContent
  | RelationContent;

export interface Entry {
  id: number;
  kind: Kind;
  name: string;
  description: string;
  /** A villager's name, or "nature" for the world's own entries. */
  author: string;
  created: number;
  forkedFrom: number | null;
  content: Content;
  retired: boolean;
  replacedBy: number | null;
}

export interface Proposal {
  id: number;
  by: string;
  entry: number;
  action: "retire" | "replace";
  replacement: number | null;
  reason: string;
  opened: number;
  /** Tick it closes at the latest; it closes early once every active villager has voted. */
  closes: number;
  /** [villager name, yes, reason]. */
  votes: [string, boolean, string][];
  status: "open" | "passed" | "failed";
  closed: number | null;
  /** Why it passed or failed. */
  outcome: string;
}

export interface CatalogSave {
  entries: Entry[];
  proposals: Proposal[];
}

export const NATURE = "nature";
export const LIMITS = {
  name: 40,
  description: 280,
  reason: 280,
  /** Serialized content, in characters. */
  content: 8192,
  entries: 5000,
  designSize: 16,
  designParts: 32,
  relationCount: 64,
} as const;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 '_-]*$/;
/** Kinds an engine Relation can connect: things the world can make, hold or grow. */
const THINGS: Kind[] = ["material", "part", "design"];
const FREE_RELATION_RE = /^[a-z][a-z_]{1,23}$/;

/** Agent text as plain, single-line-safe text: no control or bidi-override characters. */
export function cleanText(v: unknown, what: string, max: number): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new Error(`${what} must be text.`);
  const s = plainText(v);
  if (s.length > max) throw new Error(`${what} can be at most ${max} characters.`);
  return s;
}

export function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (/^\d+$/.test(s)) throw new Error("A name needs a letter; plain numbers are ids.");
  if (!s || s.length > LIMITS.name || !NAME_RE.test(s)) {
    throw new Error(
      `A name is 1-${LIMITS.name} characters: letters, digits, spaces, ' _ -, starting with a ` +
        "letter or digit.",
    );
  }
  return s;
}

export class Catalog {
  entries: Entry[] = [];
  proposals: Proposal[] = [];
  /** Bumps on every change, so the rules index and the page mirror know to refresh. */
  version = 0;
  /** Bumps when an entry is retired or replaced. */
  statusVersion = 0;
  private names = new Map<string, Entry>();
  private relationIndex = new Map<number, Entry[]>();

  /** A new world's Catalog starts with nature's entries. */
  static create(): Catalog {
    const c = new Catalog();
    seedNature(c);
    return c;
  }

  get(id: number): Entry | undefined {
    return this.entries[id - 1];
  }

  byName(name: string): Entry | undefined {
    return this.names.get(name.trim().toLowerCase());
  }

  /** An entry from an id (12 or "#12") or a name, or a helpful error. */
  resolve(ref: unknown, what = "entry"): Entry {
    if (typeof ref === "number" || (typeof ref === "string" && /^#?\d+$/.test(ref.trim()))) {
      const e = this.get(Number(String(ref).trim().replace("#", "")));
      if (!e) throw new Error(`There is no ${what} #${ref}. Search with catalog_find.`);
      return e;
    }
    if (typeof ref !== "string" || !ref.trim()) {
      throw new Error(`Name the ${what} by id (like 12) or by name.`);
    }
    const e = this.byName(ref);
    if (!e) throw new Error(`Nothing called "${ref}" in the Catalog. Search with catalog_find.`);
    return e;
  }

  relationsOf(id: number): Entry[] {
    return this.relationIndex.get(id) ?? [];
  }

  forksOf(id: number): Entry[] {
    return this.entries.filter((e) => e.forkedFrom === id);
  }

  /** The entry the world produces in place of `e`: itself, its replacement, or none if retired. */
  current(e: Entry): Entry | null {
    for (let i = 0; i < 16 && e.retired; i++) {
      if (e.replacedBy === null) return null;
      e = this.get(e.replacedBy)!;
    }
    return e.retired ? null : e;
  }

  /** Validate and append an entry. Throws a message meant for the agent. */
  add(
    draft: { kind: unknown; name?: unknown; description?: unknown; content: unknown },
    author: string,
    tick: number,
    forkedFrom: number | null = null,
  ): Entry {
    if (this.entries.length >= LIMITS.entries) {
      throw new Error(`The Catalog is full (${LIMITS.entries} entries).`);
    }
    const kind = String(draft.kind ?? "").toLowerCase() as Kind;
    if (!KINDS.includes(kind)) {
      throw new Error(`kind must be one of ${AUTHORED_KINDS.join(", ")}.`);
    }
    if (kind === "part" && author !== NATURE) {
      throw new Error("Only the engine adds Parts. Use the existing ones in your Designs.");
    }
    let raw = draft.content;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        throw new Error("content must be a JSON object.");
      }
    }
    if (!isObject(raw)) throw new Error("content must be a JSON object.");
    if (JSON.stringify(raw).length > LIMITS.content) {
      throw new Error(`content is too big (at most ${LIMITS.content} characters of JSON).`);
    }
    const content = this.validate(kind, raw);
    let name: string;
    if (kind === "relation") {
      const r = content as RelationContent;
      if (
        this.relationsOf(r.from).some((e) => {
          const o = e.content as RelationContent;
          return !e.retired && o.type === r.type && o.from === r.from && o.to === r.to;
        })
      ) throw new Error("That relation is already in the Catalog.");
      name = `${this.get(r.from)!.name} ${r.type} ${this.get(r.to)!.name}`;
    } else {
      name = cleanName(draft.name);
      const taken = this.byName(name);
      if (taken) {
        throw new Error(`"${taken.name}" is taken (#${taken.id}). Pick another name or fork it.`);
      }
    }
    const entry: Entry = {
      id: this.entries.length + 1,
      kind,
      name,
      description: cleanText(draft.description, "description", LIMITS.description),
      author,
      created: tick,
      forkedFrom,
      content,
      retired: false,
      replacedBy: null,
    };
    this.insert(entry);
    this.version++;
    return entry;
  }

  /** A new entry from an existing one, with `changes` merged over its content. */
  fork(
    from: Entry,
    draft: { name?: unknown; description?: unknown; changes?: unknown },
    author: string,
    tick: number,
  ): Entry {
    if (from.kind === "part") throw new Error("Parts belong to the engine and can't be forked.");
    let changes = draft.changes ?? {};
    if (typeof changes === "string") {
      try {
        changes = JSON.parse(changes);
      } catch {
        throw new Error("changes must be a JSON object.");
      }
    }
    if (!isObject(changes)) throw new Error("changes must be a JSON object.");
    const content = { ...structuredClone(from.content), ...structuredClone(changes) };
    return this.add(
      {
        kind: from.kind,
        name: draft.name,
        description: draft.description ?? from.description,
        content,
      },
      author,
      tick,
      from.id,
    );
  }

  // ---------------------------------------------------------------- proposals

  open(): Proposal[] {
    return this.proposals.filter((p) => p.status === "open");
  }

  propose(
    by: string,
    entry: Entry,
    action: unknown,
    replacement: Entry | null,
    reason: unknown,
    tick: number,
    closes: number,
  ): Proposal {
    if (action !== "retire" && action !== "replace") {
      throw new Error('action must be "retire" or "replace".');
    }
    const why = cleanText(reason, "reason", LIMITS.reason);
    if (!why) throw new Error("Give a reason, so the other villagers know why.");
    const clash = this.open().find((p) => p.entry === entry.id);
    if (clash) throw new Error(`Proposal #${clash.id} about "${entry.name}" is already open.`);
    if (this.open().filter((p) => p.by === by).length >= 3) {
      throw new Error("You already have 3 open proposals. Wait for one to close.");
    }
    if (action === "retire") {
      if (entry.retired) throw new Error(`"${entry.name}" is already retired.`);
      if (replacement) throw new Error('Leave out replacement to retire, or use action "replace".');
    } else {
      if (!replacement) throw new Error("Say which entry replaces it (replacement).");
      if (entry.replacedBy !== null) throw new Error(`"${entry.name}" is already replaced.`);
      this.checkReplacement(entry, replacement);
    }
    const p: Proposal = {
      id: this.proposals.length + 1,
      by,
      entry: entry.id,
      action,
      replacement: replacement?.id ?? null,
      reason: why,
      opened: tick,
      closes,
      votes: [[by, true, why]],
      status: "open",
      closed: null,
      outcome: "",
    };
    this.proposals.push(p);
    this.version++;
    return p;
  }

  vote(voter: string, ref: unknown, yes: unknown, reason?: unknown): Proposal {
    const p = this.proposals[Number(String(ref ?? "").replace("#", "")) - 1];
    if (!p) throw new Error(`There is no proposal #${ref}. See proposals.`);
    if (p.status !== "open") throw new Error(`Proposal #${p.id} already ${p.status}.`);
    if (typeof yes !== "boolean") throw new Error("yes must be true or false.");
    const why = cleanText(reason, "reason", LIMITS.reason);
    const mine = p.votes.find(([v]) => v === voter);
    if (mine) mine[1] = yes, mine[2] = why;
    else p.votes.push([voter, yes, why]);
    this.version++;
    return p;
  }

  /**
   * Close proposals whose day is up or that every active villager has voted on. Lazy consensus:
   * a proposal passes when more villagers voted yes than no.
   */
  settle(tick: number, active: string[]): Proposal[] {
    const closed: Proposal[] = [];
    for (const p of this.proposals) {
      if (p.status !== "open") continue;
      const voted = new Set(p.votes.map(([v]) => v));
      if (tick < p.closes && !active.every((a) => voted.has(a))) continue;
      const yes = p.votes.filter(([, y]) => y).length, no = p.votes.length - yes;
      const entry = this.get(p.entry)!;
      const replacement = p.replacement === null ? null : this.get(p.replacement)!;
      p.closed = tick;
      p.status = "failed";
      if (yes <= no) p.outcome = `${yes} yes, ${no} no`;
      else if (p.action === "retire" && entry.retired) p.outcome = "it was already retired";
      else if (replacement && (replacement.retired || entry.replacedBy !== null)) {
        p.outcome = "the replacement was retired meanwhile";
      } else {
        p.status = "passed";
        p.outcome = `${yes} yes, ${no} no`;
        entry.retired = true;
        entry.replacedBy = replacement?.id ?? null;
        this.statusVersion++;
      }
      this.version++;
      closed.push(p);
    }
    return closed;
  }

  // ---------------------------------------------------------------- save

  save(): CatalogSave {
    return structuredClone({ entries: this.entries, proposals: this.proposals });
  }

  static load(data: CatalogSave): Catalog {
    const c = new Catalog();
    for (const e of structuredClone(data.entries)) c.insert(e);
    c.proposals = structuredClone(data.proposals);
    return c;
  }

  /** Apply the page-side mirror's increments: new entries, status changes, proposals. */
  mirror(entries: Entry[], status: [number, boolean, number | null][], proposals?: Proposal[]) {
    for (const e of entries) if (!this.get(e.id)) this.insert(e);
    for (const [id, retired, replacedBy] of status) {
      const e = this.get(id);
      if (e) e.retired = retired, e.replacedBy = replacedBy;
    }
    if (proposals) this.proposals = proposals;
    this.version++;
  }

  /** [id, retired, replacedBy] for every entry that isn't plain active. */
  statuses(): [number, boolean, number | null][] {
    return this.entries.filter((e) => e.retired).map((e) => [e.id, e.retired, e.replacedBy]);
  }

  // ---------------------------------------------------------------- internals

  private insert(e: Entry) {
    this.entries[e.id - 1] = e;
    if (e.kind === "relation") {
      const r = e.content as RelationContent;
      for (const id of r.from === r.to ? [r.from] : [r.from, r.to]) {
        const list = this.relationIndex.get(id) ?? [];
        list.push(e);
        this.relationIndex.set(id, list);
      }
    } else {
      this.names.set(e.name.toLowerCase(), e);
    }
  }

  private checkReplacement(entry: Entry, replacement: Entry) {
    if (replacement.id === entry.id) throw new Error("An entry can't replace itself.");
    if (replacement.kind !== entry.kind) {
      throw new Error(`A ${entry.kind} can only be replaced by another ${entry.kind}.`);
    }
    if (replacement.retired) {
      throw new Error(`"${replacement.name}" is retired, so it can't replace anything.`);
    }
  }

  /** A live (not retired) entry of `kind` named `ref`, for references inside content. */
  live(ref: unknown, kind: Kind, where: string): Entry {
    const e = this.resolve(ref, kind);
    if (e.kind !== kind) throw new Error(`${where}: "${e.name}" is a ${e.kind}, not a ${kind}.`);
    if (e.retired) throw new Error(`${where}: "${e.name}" is retired.`);
    return e;
  }

  private validate(kind: Kind, raw: Record<string, unknown>): Content {
    switch (kind) {
      case "material":
        return validateMaterial(raw);
      case "part":
        return validatePart(raw);
      case "design":
        return validateDesign(raw, this);
      case "rule":
        return validateRule(raw, this);
      case "relation":
        return validateRelation(raw, this);
    }
  }
}

// ---------------------------------------------------------------- content schemas

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Refuse fields the schema doesn't know, so typos don't silently vanish. */
export function onlyKeys(o: Record<string, unknown>, keys: string[], where: string) {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) {
    throw new Error(`${where}: unknown field "${extra[0]}". Fields: ${keys.join(", ")}.`);
  }
}

export function numberIn(v: unknown, min: number, max: number, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`${where} must be a number from ${min} to ${max}.`);
  }
  return v;
}

function validateMaterial(o: Record<string, unknown>): MaterialContent {
  onlyKeys(o, ["color", "pattern", "density", "hardness", "burns", "glows"], "material");
  const color = String(o.color ?? "").trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new Error('color must look like "#a0522d".');
  const pattern = String(o.pattern ?? "plain") as PatternName;
  if (!(pattern in Pattern)) {
    throw new Error(`pattern must be one of ${Object.keys(Pattern).join(", ")}.`);
  }
  if (o.burns !== undefined && typeof o.burns !== "boolean") {
    throw new Error("burns must be true or false.");
  }
  return {
    color,
    pattern,
    density: numberIn(o.density ?? 1, 0.01, 25, "density"),
    hardness: numberIn(o.hardness ?? 1, 0, 10, "hardness"),
    burns: Boolean(o.burns ?? false),
    glows: numberIn(o.glows ?? 0, 0, 1, "glows"),
  };
}

function validatePart(o: Record<string, unknown>): PartContent {
  onlyKeys(o, ["shape"], "part");
  if (!PART_SHAPES.includes(o.shape as PartContent["shape"])) throw new Error("unknown shape");
  return { shape: o.shape as PartContent["shape"] };
}

function vec(v: unknown, min: number, max: number, where: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`${where} must be [x, y, z].`);
  return v.map((n, i) => numberIn(n, min, max, `${where}[${i}]`)) as Vec3;
}

function validateDesign(o: Record<string, unknown>, c: Catalog): DesignContent {
  onlyKeys(o, ["blocks", "parts"], "design");
  const S = LIMITS.designSize;
  let blocks: DesignContent["blocks"] = null;
  if (o.blocks !== undefined && o.blocks !== null) {
    if (!isObject(o.blocks)) throw new Error("blocks must be { palette, layers }.");
    onlyKeys(o.blocks, ["palette", "layers"], "blocks");
    const { palette, layers } = o.blocks;
    if (!isObject(palette)) {
      throw new Error('blocks.palette maps characters to materials: {"s": "stone"}.');
    }
    const pal: Record<string, string> = {};
    for (const [ch, mat] of Object.entries(palette)) {
      if ([...ch].length !== 1 || ch === "." || ch === " ") {
        throw new Error(`Palette keys are single characters other than "." and " ", not "${ch}".`);
      }
      pal[ch] = c.live(mat, "material", `palette "${ch}"`).name;
    }
    if (!Array.isArray(layers) || !layers.length || layers.length > S) {
      throw new Error(`blocks.layers is 1-${S} layers (bottom first), each a list of rows.`);
    }
    let cells = 0;
    const clean = layers.map((layer, y) => {
      if (!Array.isArray(layer) || layer.length > S) {
        throw new Error(`Layer ${y} must be a list of at most ${S} rows (strings).`);
      }
      return layer.map((row, z) => {
        if (typeof row !== "string" || [...row].length > S) {
          throw new Error(`Layer ${y} row ${z} must be a string of at most ${S} characters.`);
        }
        for (const ch of row) {
          if (ch === "." || ch === " ") continue;
          if (!(ch in pal)) throw new Error(`"${ch}" in layer ${y} row ${z} isn't in the palette.`);
          cells++;
        }
        return row;
      });
    });
    if (!cells) throw new Error("blocks has no filled cells.");
    blocks = { palette: pal, layers: clean };
  }
  const parts: DesignPart[] = [];
  if (o.parts !== undefined) {
    if (!Array.isArray(o.parts) || o.parts.length > LIMITS.designParts) {
      throw new Error(`parts is a list of at most ${LIMITS.designParts} parts.`);
    }
    o.parts.forEach((p, i) => {
      const where = `parts[${i}]`;
      if (!isObject(p)) throw new Error(`${where} must be an object.`);
      onlyKeys(p, ["part", "material", "at", "size", "turn"], where);
      parts.push({
        part: c.live(p.part, "part", where).name,
        material: c.live(p.material, "material", where).name,
        at: vec(p.at, -1, S + 1, `${where}.at`),
        size: vec(p.size, 0.05, S, `${where}.size`),
        turn: numberIn(p.turn ?? 0, -360, 360, `${where}.turn`),
      });
    });
  }
  if (!blocks && !parts.length) throw new Error("A design needs blocks, parts or both.");
  return { blocks, parts };
}

function validateRelation(o: Record<string, unknown>, c: Catalog): RelationContent {
  onlyKeys(o, ["type", "from", "to", "count"], "relation");
  const type = String(o.type ?? "").trim().toLowerCase();
  if (!(ENGINE_RELATIONS as readonly string[]).includes(type) && !FREE_RELATION_RE.test(type)) {
    throw new Error(
      `type is an engine relation (${ENGINE_RELATIONS.join(", ")}) or your own label in ` +
        "lower_snake_case, 2-24 letters.",
    );
  }
  const from = c.resolve(o.from, "entry"), to = c.resolve(o.to, "entry");
  const engine = (ENGINE_RELATIONS as readonly string[]).includes(type);
  for (const e of [from, to]) {
    if (e.kind === "relation") throw new Error("Relations connect entries, not other relations.");
    if (engine && !THINGS.includes(e.kind)) {
      throw new Error(
        `${type} connects things (materials, parts, designs); "${e.name}" is a ${e.kind}. ` +
          "Use your own label for anything else.",
      );
    }
    if (e.retired) throw new Error(`"${e.name}" is retired.`);
  }
  return {
    type,
    from: from.id,
    to: to.id,
    count: Math.round(numberIn(o.count ?? 1, 1, LIMITS.relationCount, "count")),
  };
}

// ---------------------------------------------------------------- nature's entries

const DENSITY: Record<string, [number, number, boolean]> = {
  // name: [density g/cm³, hardness, burns]
  grass: [1.3, 1, false],
  dirt: [1.3, 1, false],
  stone: [2.6, 6, false],
  farmland: [1.2, 1, false],
  water: [1, 0, false],
  sand: [1.6, 1, false],
  gravel: [1.8, 2, false],
  clay: [1.8, 2, false],
  log: [0.7, 3, true],
  planks: [0.6, 2, true],
  cobble: [2.4, 5, false],
  brick: [1.9, 5, false],
  thatch: [0.2, 1, true],
  tiles: [2, 4, false],
};

/** Built-in blocks as Materials, the engine's Parts, and a few worked examples. */
function seedNature(c: Catalog) {
  const add = (kind: Kind, name: string, description: string, content: unknown) =>
    c.add({ kind, name, description, content }, NATURE, 0);
  for (const b of BUILTIN_BLOCKS) {
    if (b.id === 0) continue;
    const [density, hardness, burns] = DENSITY[b.name] ?? [1, 1, false];
    add("material", b.name, b.description, {
      color: "#" + b.color.toString(16).padStart(6, "0"),
      pattern: b.pattern,
      density,
      hardness,
      burns,
      glows: 0,
    });
  }
  add("part", "box", "A rectangular block of any size.", { shape: "box" });
  add("part", "sphere", "A ball, stretched by its size.", { shape: "sphere" });
  add("part", "cylinder", "A round post, stretched by its size.", { shape: "cylinder" });
  const rel = (from: string, type: string, to: string, count = 1) =>
    add("relation", "", "", { type, from, to, count });
  rel("planks", "made_from", "log", 4);
  rel("cobble", "made_from", "stone");
  rel("brick", "made_from", "clay");
  rel("tiles", "made_from", "clay");
  rel("grass", "drops", "dirt");
  rel("farmland", "drops", "dirt");
  add("design", "stone bench", "A low seat of stone with a plank top.", {
    blocks: { palette: { s: "stone" }, layers: [["s.s"]] },
    parts: [{ part: "box", material: "planks", at: [1.5, 1.1, 0.5], size: [3, 0.2, 1] }],
  });
  add("rule", "lucky harvest", "Now and then a wheat harvest gives back an extra seed.", {
    when: { event: "harvested", what: "wheat" },
    if: { chance: 0.1 },
    do: [{ give: { item: "wheat_seeds", count: 1 } }],
  });
  add("rule", "dawn chorus", "Birds greet the morning when the sky is clear.", {
    when: { daily: 6 },
    if: { clouds_below: 0.5 },
    do: [{ say: "Birdsong drifts over the meadow." }],
  });
}
