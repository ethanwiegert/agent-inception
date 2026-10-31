import {
  type Catalog,
  type DesignContent,
  type Entry,
  type LevelName,
  LEVELS,
  LIMITS,
  type MaterialContent,
  NATURE,
  type PartContent,
} from "./catalog.ts";

/**
 * What the Catalog's Materials are worth, how much they feed, and which village level unlocks each
 * Element and Design (Village Life, M12). All of it is read off the Catalog: nature's entries say
 * their own; an agent's Material is worth what goes into it, feeds no more than what it's made of,
 * and is locked as long as its ingredients are.
 *
 * Worth: nature's Materials are worth 1, or what their recipe splits off (planks: a quarter of a
 * log). Each recipe makes `count` from one ingredient, so a product is worth the ingredient's
 * worth over its count, the cheapest way it's made. Nothing may be worth less than
 * `LIMITS.worthFloor`, so recipe chains can't multiply things out of nothing.
 */

/** Cooking at a workbench (a recipe that `needs` a Design) makes nature's food go this much further. */
export const BENCH_FOOD = 1.5;

/** A recipe about to be added: `count` of `from` crafted out of one `to`. */
export interface DraftRecipe {
  from: number;
  to: number;
  count: number;
}

interface Memo {
  version: number;
  worth: Map<number, number>;
  food: Map<number, number>;
  unlock: Map<number, number>;
}
const memos = new WeakMap<Catalog, Memo>();

function memo(c: Catalog): Memo {
  let m = memos.get(c);
  if (!m || m.version !== c.version) {
    m = { version: c.version, worth: new Map(), food: new Map(), unlock: new Map() };
    memos.set(c, m);
  }
  return m;
}

/** made_from recipes of Material `id`: [ingredient id, how many one craft makes]. */
function recipes(c: Catalog, id: number, extra?: DraftRecipe): [number, number][] {
  const out = c.links(id, "made_from").map(({ entry, rel }) =>
    [entry.id, rel.count] as [
      number,
      number,
    ]
  );
  if (extra?.from === id) out.push([extra.to, extra.count]);
  return out;
}

function rawWorth(
  c: Catalog,
  id: number,
  seen: Map<number, number>,
  extra?: DraftRecipe,
): number {
  const hit = seen.get(id);
  if (hit !== undefined) return hit;
  seen.set(id, 1); // a loop (refused when added) reads as raw
  const list = recipes(c, id, extra);
  let w = list.length ? Infinity : 1;
  for (const [input, n] of list) w = Math.min(w, rawWorth(c, input, seen, extra) / n);
  seen.set(id, w);
  return w;
}

/** What one of Material `e` is worth (a log is 1), never below the floor. */
export function worth(c: Catalog, e: Entry): number {
  if (e.kind !== "material") return 0;
  const m = memo(c);
  let w = m.worth.get(e.id);
  if (w === undefined) {
    w = Math.max(LIMITS.worthFloor, rawWorth(c, e.id, new Map()));
    m.worth.set(e.id, w);
  }
  return w;
}

/** What a Design costs to build, in worth: its blocks and each part's Material by volume. */
export function costWorth(c: Catalog, cost: Map<string, number>): number {
  let sum = 0;
  for (const [m, n] of cost) {
    const e = c.byName(m);
    sum += (e ? worth(c, e) : 1) * n;
  }
  return sum;
}

/**
 * Why adding recipe `r` (by a villager) would split something finer than the floor: the product,
 * or anything already made from it. Nothing if it's fine.
 */
export function recipeRefusal(c: Catalog, r: DraftRecipe): string | void {
  const seen = new Map<number, number>();
  const down = [r.from], visited = new Set<number>();
  while (down.length) {
    const id = down.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const w = rawWorth(c, id, seen, r);
    if (w < LIMITS.worthFloor - 1e-9) {
      const input = c.get(r.to)!, product = c.get(r.from)!;
      const most = Math.floor(rawWorth(c, r.to, seen, r) / LIMITS.worthFloor + 1e-9);
      const what = id === r.from
        ? `each ${product.name}`
        : `each ${c.get(id)!.name} (made from it)`;
      return `${what} would be worth ${fraction(w)}, and nothing is worth less than ` +
        `${fraction(LIMITS.worthFloor)} of a log. One ${input.name} is worth ` +
        `${fraction(rawWorth(c, r.to, seen, r))}` +
        (id === r.from ? `, so it makes at most ${Math.max(1, most)} ${product.name}` : "") +
        ". Recipes pass worth along; they don't multiply it";
    }
    for (const { entry } of c.links(id, "made_from", true)) down.push(entry.id);
  }
}

/** "1/4", "1/16", "2" for a worth. */
export function fraction(w: number): string {
  if (w >= 1 - 1e-9) return String(Math.round(w * 100) / 100);
  const inv = 1 / w;
  return Math.abs(inv - Math.round(inv)) < 1e-6 ? `1/${Math.round(inv)}` : w.toFixed(3);
}

/**
 * How much one of Material `e` fills a villager's hunger, 0-1. Nature's foods say so; an agent's
 * food (it must say `food` too) fills at most what its ingredient does over the recipe's count,
 * half again as much when it's cooked at a workbench from nature's food.
 */
export function food(c: Catalog, e: Entry): number {
  if (e.kind !== "material") return 0;
  const m = memo(c);
  let f = m.food.get(e.id);
  if (f !== undefined) return f;
  m.food.set(e.id, 0); // loops feed nobody
  const declared = Math.min(1, (e.content as MaterialContent).food ?? 0);
  if (!declared || e.author === NATURE) f = declared;
  else {
    const bench = c.links(e.id, "needs").length > 0;
    let derived = Infinity;
    for (const [input, n] of recipes(c, e.id)) {
      const ing = c.get(input)!;
      const boost = bench && ing.author === NATURE ? BENCH_FOOD : 1;
      derived = Math.min(derived, (food(c, ing) * boost) / n);
    }
    f = Math.min(declared, derived === Infinity ? 0 : derived);
  }
  m.food.set(e.id, f);
  return f;
}

/** The village level (an index into LEVELS) that unlocks entry `e`: a Material, Part or Design. */
export function unlockLevel(c: Catalog, e: Entry): number {
  const m = memo(c);
  let u = m.unlock.get(e.id);
  if (u !== undefined) return u;
  m.unlock.set(e.id, 0);
  u = 0;
  const declared = (v: LevelName | undefined) => Math.max(0, LEVELS.indexOf(v ?? "camp"));
  const named = (name: string) => {
    const x = c.byName(name);
    return x ? unlockLevel(c, x) : 0;
  };
  if (e.kind === "part") u = declared((e.content as PartContent).unlock);
  else if (e.kind === "material") {
    const mc = e.content as MaterialContent;
    u = declared(mc.unlock);
    if (e.author !== NATURE) {
      // A Material that glows lights the night like a lamp; it unlocks with lamps.
      if (mc.glows > 0) u = Math.max(u, named("lamp"));
      const list = recipes(c, e.id);
      if (list.length) {
        u = Math.max(u, Math.min(...list.map(([input]) => unlockLevel(c, c.get(input)!))));
      }
    }
    for (const { entry } of c.links(e.id, "needs")) u = Math.max(u, unlockLevel(c, entry));
  } else if (e.kind === "design") {
    const d = e.content as DesignContent;
    for (const mat of Object.values(d.blocks?.palette ?? {})) u = Math.max(u, named(mat));
    for (const p of d.parts) u = Math.max(u, named(p.part), named(p.material));
  }
  m.unlock.set(e.id, u);
  return u;
}

/** What in Design `e` waits for village level `level` or later: Parts and Materials by name. */
export function lockedIn(c: Catalog, e: Entry, level: number): string[] {
  const out = new Set<string>();
  const check = (name: string) => {
    const x = c.byName(name);
    if (x && unlockLevel(c, x) > level) out.add(x.name);
  };
  if (e.kind === "design") {
    const d = e.content as DesignContent;
    for (const mat of Object.values(d.blocks?.palette ?? {})) check(mat);
    for (const p of d.parts) check(p.part), check(p.material);
  } else if (unlockLevel(c, e) > level) out.add(e.name);
  return [...out];
}
