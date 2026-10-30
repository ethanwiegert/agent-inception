import { Pattern, type PatternName } from "./blocks.ts";
import { seedNature } from "./nature.ts";
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

/** How a Material exists: laid as a block, only held and used in Parts, or a liquid (nature's). */
export const FORMS = ["block", "item", "liquid"] as const;
export type Form = (typeof FORMS)[number];

export interface MaterialContent {
  form: Form;
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

export const PART_SHAPES = ["box", "sphere", "cylinder", "cone"] as const;
export type PartShapeName = (typeof PART_SHAPES)[number];
/** Mechanisms: a joint part joins two pieces of a Design and lets them move about its axis. */
export const JOINTS = ["hinge", "axle", "slider", "motor"] as const;
export type JointKind = (typeof JOINTS)[number];
/** The shape each joint is drawn and collides as: a pin, or a slider's rail. */
export const JOINT_SHAPES: Record<JointKind, PartShapeName> = {
  hinge: "cylinder",
  axle: "cylinder",
  slider: "box",
  motor: "cylinder",
};
/** The piece of a Design its parts belong to unless they name another (and its blocks always). */
export const MAIN_PIECE = "main";
export interface PartContent {
  shape: PartShapeName;
  /** A mechanism: it joins two pieces of a Design and lets them move about its axis. */
  joint?: JointKind;
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
  /** Lean from upright in degrees, toward the way it's turned. */
  tilt: number;
  /** For bodies: which moving piece it belongs to. */
  role?: Role;
  /** Which rigid piece of a jointed Design it belongs to ("main" if none). */
  piece?: string;
  /** Joint parts: the two pieces it joins. The joint itself belongs to the first. */
  joins?: [string, string];
  /** Hinge (degrees) or slider (blocks) travel from how it's built: [min, max], min ≤ 0 ≤ max. */
  limits?: [number, number];
  /** Motor: degrees per second while it's on (negative turns the other way). */
  speed?: number;
}

/** Moving pieces of a body. Legs and arms swing from the top, heads turn on the neck. */
export const ROLES = [
  "body",
  "head",
  "eyes",
  "tail",
  "product",
  "left arm",
  "right arm",
  "left leg",
  "right leg",
  "front left leg",
  "front right leg",
  "back left leg",
  "back right leg",
] as const;
export type Role = (typeof ROLES)[number];

/** Where nature grows a plant when it makes a world: terrain the world generator recognises. */
export const ZONES = [
  "forest",
  "highland",
  "forest edge",
  "meadow",
  "shore",
  "shallows",
  "slope",
  "scattered",
  "riverbed",
] as const;
export type Zone = (typeof ZONES)[number];

export interface Habitat {
  /** Ground Materials it grows on (the block under it, or the bed under shallow water). */
  on: string[];
  /** Where nature places it in a new world; none means only villagers plant it. */
  zones: Zone[];
  /** Its weight among the other plants of the same zone. */
  share: number;
}

export interface DesignContent {
  /** Voxel grid: `layers[y][z]` is a row of palette characters along x; "." is empty. */
  blocks: { palette: Record<string, string>; layers: string[][] } | null;
  parts: DesignPart[];
  /** Pivot of each moving role; by default legs and arms turn at their top, heads at their base. */
  joints?: Partial<Record<Role, Vec3>>;
  /** One character for it on the look map. */
  mark?: string;
  /** For plants: what it grows on and where nature puts it. */
  habitat?: Habitat;
  /** "blades": a crop drawn as a swaying field of stalks (wheat) instead of its own parts. */
  look?: "blades";
  /** Its Object stays where it's built (a signpost, a statue): no falling, pushing or carrying. */
  anchored?: boolean;
}

/** The shape a Design's part is drawn and collides as, by its Part's name. */
export function shapeOf(part: string): PartShapeName {
  return (JOINT_SHAPES as Record<string, PartShapeName>)[part] ?? part as PartShapeName;
}

/** The joint a Part is, by name, if it's one. */
export function jointKind(part: string): JointKind | null {
  return (JOINTS as readonly string[]).includes(part) ? part as JointKind : null;
}

/** How a Design's parts split into rigid pieces, and the joints between them. */
export interface Rig {
  /** Piece names, the root first: the piece with the blocks, else the first part's. */
  pieces: string[];
  /** Which piece each part belongs to (a joint belongs to the first piece it joins). */
  pieceOf: number[];
  /** Joint parts: their index in `parts`, and the pieces they join (a carries the pin). */
  joints: { part: number; kind: JointKind; a: number; b: number }[];
}

const rigs = new WeakMap<DesignContent, Rig>();

/** The pieces and joints of a Design (one piece and no joints for most). */
export function rigOf(d: DesignContent): Rig {
  let rig = rigs.get(d);
  if (rig) return rig;
  const pieces: string[] = [];
  const index = (name: string) => {
    let i = pieces.indexOf(name);
    if (i < 0) i = pieces.push(name) - 1;
    return i;
  };
  const own = (p: DesignPart) => jointKind(p.part) && p.joins ? p.joins[0] : p.piece ?? MAIN_PIECE;
  if (d.blocks || d.parts.some((p) => !p.joins && !p.piece)) index(MAIN_PIECE);
  for (const p of d.parts) if (!p.joins) index(own(p));
  const pieceOf = d.parts.map((p) => index(own(p)));
  const joints: Rig["joints"] = [];
  d.parts.forEach((p, i) => {
    const kind = jointKind(p.part);
    if (kind && p.joins) joints.push({ part: i, kind, a: index(p.joins[0]), b: index(p.joins[1]) });
  });
  rig = { pieces: pieces.length ? pieces : [MAIN_PIECE], pieceOf, joints };
  rigs.set(d, rig);
  return rig;
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
  /** grows_into only: game hours from planting to grown. */
  hours?: number;
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
  /** grows_into: at most 30 game days. */
  growHours: 720,
  /** What one craft of an agent's recipe may yield (nature's planks: 4 from a log). */
  recipeCount: 4,
  /** Joint parts per Design (so at most 9 pieces). */
  joints: 8,
  /** A motor's fastest turn, degrees per second. */
  motorSpeed: 360,
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

let pristine: Catalog | null = null;
/** Nature's entries as a new world starts with them; shared, never changed. */
export function natureCatalog(): Catalog {
  return pristine ??= Catalog.create();
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

  /**
   * Live Relations of `type` leaving entry `id` (or arriving at it, with `into`): the entry at the
   * other end and the count. Retired Relations don't count; the other end is returned as is, so
   * callers follow `current` when they produce it.
   */
  links(id: number, type: string, into = false): { entry: Entry; rel: RelationContent }[] {
    const out: { entry: Entry; rel: RelationContent }[] = [];
    for (const r of this.relationsOf(id)) {
      const rc = r.content as RelationContent;
      if (r.retired || rc.type !== type || (into ? rc.to : rc.from) !== id) continue;
      out.push({ entry: this.get(into ? rc.from : rc.to)!, rel: rc });
    }
    return out;
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
    const content = this.validate(kind, raw, author);
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
    }
    const taken = this.byName(name);
    if (taken) {
      throw new Error(`"${taken.name}" is taken (#${taken.id}). Pick another name or fork it.`);
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

  /**
   * Add nature's entries a world was saved without (Parts and examples added since), so an older
   * world gains what a new one starts with. Relations are left out: they name entries by id.
   */
  addMissingNature(tick: number) {
    for (const e of natureCatalog().entries) {
      if (!e.name || e.kind === "relation" || this.byName(e.name)) continue;
      try {
        this.add(
          { kind: e.kind, name: e.name, description: e.description, content: e.content },
          NATURE,
          tick,
        );
      } catch {
        // Something it builds on was retired or renamed in this world: it stays out.
      }
    }
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
    // Relations are named ("wheat seeds grows_into wheat crop") and tools hand that name back.
    // It has to resolve, the same as any other entry.
    if (e.name) this.names.set(e.name.toLowerCase(), e);
    if (e.kind === "relation") {
      const r = e.content as RelationContent;
      for (const id of r.from === r.to ? [r.from] : [r.from, r.to]) {
        const list = this.relationIndex.get(id) ?? [];
        list.push(e);
        this.relationIndex.set(id, list);
      }
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

  private validate(kind: Kind, raw: Record<string, unknown>, author: string): Content {
    switch (kind) {
      case "material":
        return validateMaterial(raw, author);
      case "part":
        return validatePart(raw);
      case "design":
        return validateDesign(raw, this);
      case "rule":
        return validateRule(raw, this);
      case "relation":
        return validateRelation(raw, this, author);
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

function validateMaterial(o: Record<string, unknown>, author: string): MaterialContent {
  onlyKeys(o, ["form", "color", "pattern", "density", "hardness", "burns", "glows"], "material");
  const color = String(o.color ?? "").trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new Error('color must look like "#a0522d".');
  const pattern = String(o.pattern ?? "plain") as PatternName;
  if (!(pattern in Pattern)) {
    throw new Error(`pattern must be one of ${Object.keys(Pattern).join(", ")}.`);
  }
  if (o.burns !== undefined && typeof o.burns !== "boolean") {
    throw new Error("burns must be true or false.");
  }
  const form = String(o.form ?? "block") as Form;
  if (!FORMS.includes(form)) throw new Error(`form must be one of ${FORMS.join(", ")}.`);
  if (form === "liquid" && author !== NATURE) {
    throw new Error('Only nature makes liquids for now. Use "block" or "item".');
  }
  return {
    form,
    color,
    pattern,
    density: numberIn(o.density ?? 1, 0.01, 25, "density"),
    hardness: numberIn(o.hardness ?? 1, 0, 10, "hardness"),
    burns: Boolean(o.burns ?? false),
    glows: numberIn(o.glows ?? 0, 0, 1, "glows"),
  };
}

function validatePart(o: Record<string, unknown>): PartContent {
  onlyKeys(o, ["shape", "joint"], "part");
  if (!PART_SHAPES.includes(o.shape as PartShapeName)) throw new Error("unknown shape");
  const out: PartContent = { shape: o.shape as PartShapeName };
  if (o.joint !== undefined) {
    if (!JOINTS.includes(o.joint as JointKind)) throw new Error("unknown joint");
    out.joint = o.joint as JointKind;
  }
  return out;
}

const PIECE_RE = /^[a-z0-9][a-z0-9 '_-]*$/;

function pieceName(v: unknown, where: string): string {
  const s = typeof v === "string" ? v.trim().toLowerCase().replace(/\s+/g, " ") : "";
  if (!s || s.length > 24 || !PIECE_RE.test(s)) {
    throw new Error(
      `${where} names a piece: 1-24 letters, digits, spaces, ' _ - ("door", "wheel").`,
    );
  }
  return s;
}

/** A joint part's own fields: what it joins, how far it may move, how fast a motor turns. */
function jointFields(
  p: Record<string, unknown>,
  kind: JointKind,
  part: DesignPart,
  where: string,
) {
  if (p.piece !== undefined) {
    throw new Error(`${where}: a joint belongs to the first piece it joins; drop "piece".`);
  }
  if (!Array.isArray(p.joins) || p.joins.length !== 2) {
    throw new Error(`${where}.joins names the two pieces the ${kind} joins: ["main", "door"].`);
  }
  const joins = p.joins.map((v, i) => pieceName(v, `${where}.joins[${i}]`)) as [string, string];
  if (joins[0] === joins[1]) throw new Error(`${where}.joins needs two different pieces.`);
  part.joins = joins;
  if (p.limits !== undefined) {
    if (kind !== "hinge" && kind !== "slider") {
      throw new Error(
        `${where}: a${kind === "axle" ? "n" : ""} ${kind} turns all the way round; only hinges ` +
          "and sliders take limits.",
      );
    }
    const max = kind === "hinge" ? 180 : LIMITS.designSize;
    if (!Array.isArray(p.limits) || p.limits.length !== 2) {
      throw new Error(`${where}.limits is [min, max] ${kind === "hinge" ? "degrees" : "blocks"}.`);
    }
    const [lo, hi] = p.limits.map((v, i) => numberIn(v, -max, max, `${where}.limits[${i}]`));
    if (lo > 0 || hi < 0 || hi - lo < 1e-3) {
      throw new Error(
        `${where}.limits [min, max] is measured from how it's built: min ≤ 0 ≤ max, min < max ` +
          (kind === "hinge" ? "(a door opening one way: [0, 100])." : "(a drawer: [0, 0.8])."),
      );
    }
    part.limits = [lo, hi];
  } else if (kind === "slider") {
    throw new Error(`${where}: a slider needs limits, [min, max] blocks along its length.`);
  }
  if (p.speed !== undefined) {
    if (kind !== "motor") throw new Error(`${where}: only motors take a speed.`);
    const speed = numberIn(p.speed, -LIMITS.motorSpeed, LIMITS.motorSpeed, `${where}.speed`);
    if (!speed) throw new Error(`${where}.speed can't be 0 (degrees per second).`);
    part.speed = speed;
  } else if (kind === "motor") part.speed = 30;
}

/** Every piece hangs off the root through joints, like a tree: no strays, no loops. */
function checkPieces(d: DesignContent) {
  const rig = rigOf(d);
  if (rig.joints.length > LIMITS.joints) {
    throw new Error(`A design has at most ${LIMITS.joints} joints.`);
  }
  const named = new Set<string>();
  d.parts.forEach((p) => !p.joins && named.add(p.piece ?? MAIN_PIECE));
  if (d.blocks) named.add(MAIN_PIECE);
  for (const j of rig.joints) {
    for (const k of [j.a, j.b]) {
      if (!named.has(rig.pieces[k])) {
        const main = rig.pieces[k] === MAIN_PIECE
          ? ' (a Design\'s blocks, and parts without a "piece", are "main"; a joint belongs to ' +
            "the first piece it joins, so it can't make one on its own)"
          : "";
        throw new Error(
          `parts[${j.part}].joins: no part is in piece "${rig.pieces[k]}"${main}. Pieces: ` +
            `${[...named].join(", ") || "none"}.`,
        );
      }
    }
  }
  const group = rig.pieces.map((_, i) => i);
  const find = (i: number): number => group[i] === i ? i : (group[i] = find(group[i]));
  for (const j of rig.joints) {
    const a = find(j.a), b = find(j.b);
    if (a === b) {
      throw new Error(
        `parts[${j.part}]: "${rig.pieces[j.a]}" and "${rig.pieces[j.b]}" are already joined; ` +
          "pieces hang off each other like a tree, without loops.",
      );
    }
    group[b] = a;
  }
  const root = find(0);
  for (let i = 1; i < rig.pieces.length; i++) {
    if (find(i) !== root) {
      throw new Error(
        `Piece "${rig.pieces[i]}" isn't joined to "${rig.pieces[0]}": add a hinge, axle, slider ` +
          "or motor part that joins them.",
      );
    }
  }
  if (rig.joints.length && d.habitat) throw new Error("Plants can't have joints.");
}

function vec(v: unknown, min: number, max: number, where: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`${where} must be [x, y, z].`);
  return v.map((n, i) => numberIn(n, min, max, `${where}[${i}]`)) as Vec3;
}

function validateDesign(o: Record<string, unknown>, c: Catalog): DesignContent {
  onlyKeys(o, ["blocks", "parts", "joints", "mark", "habitat", "look", "anchored"], "design");
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
      const m = c.live(mat, "material", `palette "${ch}"`);
      if ((m.content as MaterialContent).form !== "block") {
        throw new Error(`palette "${ch}": "${m.name}" isn't a block material. Use it in parts.`);
      }
      pal[ch] = m.name;
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
      onlyKeys(
        p,
        [
          "part",
          "material",
          "at",
          "size",
          "turn",
          "tilt",
          "role",
          "piece",
          "joins",
          "limits",
          "speed",
        ],
        where,
      );
      const kind = (c.live(p.part, "part", where).content as PartContent).joint;
      const part: DesignPart = {
        part: c.live(p.part, "part", where).name,
        material: c.live(p.material, "material", where).name,
        at: vec(p.at, -1, S + 1, `${where}.at`),
        size: vec(p.size, 0.01, S, `${where}.size`),
        turn: numberIn(p.turn ?? 0, -360, 360, `${where}.turn`),
        tilt: numberIn(p.tilt ?? 0, -180, 180, `${where}.tilt`),
      };
      if (p.role !== undefined) part.role = role(p.role, `${where}.role`);
      if (kind) jointFields(p, kind, part, where);
      else {
        for (const k of ["joins", "limits", "speed"]) {
          if (p[k] !== undefined) {
            throw new Error(`${where}: only joint parts (${JOINTS.join(", ")}) take ${k}.`);
          }
        }
        if (p.piece !== undefined) {
          const piece = pieceName(p.piece, `${where}.piece`);
          if (piece !== MAIN_PIECE) part.piece = piece;
        }
      }
      parts.push(part);
    });
  }
  if (!blocks && !parts.length) throw new Error("A design needs blocks, parts or both.");
  const out: DesignContent = { blocks, parts };
  if (o.joints !== undefined) {
    if (!isObject(o.joints)) {
      throw new Error('joints maps roles to points: {"head": [0.5, 1, 0.8]}.');
    }
    const joints: Partial<Record<Role, Vec3>> = {};
    for (const [k, v] of Object.entries(o.joints)) {
      const r = role(k, "joints");
      if (!parts.some((p) => p.role === r)) throw new Error(`joints: no part has role "${r}".`);
      joints[r] = vec(v, -1, S + 1, `joints.${r}`);
    }
    out.joints = joints;
  }
  if (o.mark !== undefined) {
    const mark = String(o.mark);
    if ([...mark].length !== 1 || /[\s\d@]/.test(mark) || mark.charCodeAt(0) < 33) {
      throw new Error("mark is one character for the look map (not a digit, @ or a space).");
    }
    out.mark = mark;
  }
  if (o.habitat !== undefined) out.habitat = habitat(o.habitat, c);
  if (o.look !== undefined) {
    if (o.look !== "blades") throw new Error('look is "blades" (a swaying field, like wheat).');
    out.look = "blades";
  }
  if (o.anchored !== undefined) {
    if (typeof o.anchored !== "boolean") throw new Error("anchored is true or false.");
    if (o.anchored) out.anchored = true;
  }
  checkPieces(out);
  return out;
}

function role(v: unknown, where: string): Role {
  const r = String(v ?? "").trim().toLowerCase().replace(/_/g, " ") as Role;
  if (!ROLES.includes(r)) throw new Error(`${where} must be one of ${ROLES.join(", ")}.`);
  return r;
}

function habitat(v: unknown, c: Catalog): Habitat {
  if (!isObject(v)) {
    throw new Error('habitat is {"on": ["grass"], "zones": ["meadow"], "share": 1}.');
  }
  onlyKeys(v, ["on", "zones", "share"], "habitat");
  if (!Array.isArray(v.on) || !v.on.length || v.on.length > 8) {
    throw new Error("habitat.on lists 1-8 ground materials it grows on.");
  }
  const on = v.on.map((m, i) => {
    const e = c.live(m, "material", `habitat.on[${i}]`);
    if ((e.content as MaterialContent).form !== "block") {
      throw new Error(`habitat.on[${i}]: "${e.name}" isn't ground (a block material).`);
    }
    return e.name;
  });
  const zones = v.zones ?? [];
  if (!Array.isArray(zones) || zones.length > ZONES.length) {
    throw new Error(`habitat.zones lists where nature grows it: ${ZONES.join(", ")}.`);
  }
  for (const z of zones) {
    if (!ZONES.includes(z as Zone)) {
      throw new Error(`habitat.zones: "${z}" isn't a zone. Zones: ${ZONES.join(", ")}.`);
    }
  }
  return {
    on,
    zones: [...new Set(zones as Zone[])],
    share: numberIn(v.share ?? 1, 0.01, 1, "habitat.share"),
  };
}

function validateRelation(
  o: Record<string, unknown>,
  c: Catalog,
  author: string,
): RelationContent {
  onlyKeys(o, ["type", "from", "to", "count", "hours"], "relation");
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
  const out: RelationContent = {
    type,
    from: from.id,
    to: to.id,
    count: Math.round(numberIn(o.count ?? 1, 1, LIMITS.relationCount, "count")),
  };
  if (type === "grows_into") {
    if (
      from.kind !== "material" || to.kind !== "design" || !(to.content as DesignContent).habitat
    ) {
      throw new Error(
        "grows_into goes from a Material you plant (like a seed) to a Design with a habitat.",
      );
    }
    out.hours = numberIn(o.hours ?? 24, 0.1, LIMITS.growHours, "hours");
  } else if (type === "made_from") {
    // A recipe: `count` of `from` crafted out of one `to`. Nature's Materials keep nature's
    // recipes, so nobody crafts logs out of dirt; agents' recipes make their own Materials.
    if (from.kind !== "material" || to.kind !== "material") {
      throw new Error("made_from goes from the Material you craft to the Material it's made of.");
    }
    if (from.id === to.id) throw new Error("A Material can't be made from itself.");
    if (author !== NATURE && from.author === NATURE) {
      throw new Error(
        `"${from.name}" is nature's, and comes only from nature's recipes. Make your own ` +
          `Material (catalog_fork "${from.name}") and give that a recipe.`,
      );
    }
    if (author !== NATURE && out.count > LIMITS.recipeCount) {
      throw new Error(`A recipe makes at most ${LIMITS.recipeCount} from each ingredient.`);
    }
    // No loops: crafting round a cycle would make something from nothing.
    const seen = new Set<number>(), stack = [to.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === from.id) {
        throw new Error(
          `"${to.name}" is already made (maybe through other recipes) from "${from.name}"; a ` +
            "recipe loop would make things out of nothing.",
        );
      }
      if (seen.has(id)) continue;
      seen.add(id);
      for (const { entry } of c.links(id, "made_from")) stack.push(entry.id);
    }
  }
  if (type !== "grows_into" && o.hours !== undefined) {
    throw new Error("hours is only for grows_into.");
  }
  return out;
}
