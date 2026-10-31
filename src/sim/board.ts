import type { Agent, Sim } from "./sim.ts";
import { TICK_HZ, TICKS_PER_DAY } from "./time.ts";

/**
 * The Notice Board (M13): spectators pin Wishes, short suggestions open to every villager or meant
 * for one. Villagers read them in `look` and the `board` tool, reply, and mark them done. A Wish is
 * never an order: nothing checks it, nothing pays for it, and ignoring one costs nothing.
 */

const HOUR = TICKS_PER_DAY / 24;

export const BOARD_LIMITS = {
  /** Characters in a Wish, a reply or a done note. */
  text: 140,
  /** Open Wishes on the board at most; a spectator pins another once one is done or unpinned. */
  open: 12,
  /** Replies one Wish keeps, and how many of them one villager may write. */
  replies: 8,
  perVillager: 2,
  /** An open Wish comes down after this long, and a done one after this long. */
  posted: TICKS_PER_DAY * 3,
  kept: TICKS_PER_DAY,
} as const;

export interface Reply {
  by: string;
  text: string;
  tick: number;
}

export interface Wish {
  id: number;
  text: string;
  /** The villager it's meant for (their name), or null for anyone. */
  for: string | null;
  posted: number;
  /** The tick it comes down. */
  until: number;
  replies: Reply[];
  done: { by: string; note: string; tick: number } | null;
}

export interface BoardSave {
  wishes: Wish[];
  serial: number;
}

/**
 * Spectator or villager text, cleaned to one line: control characters and bidirectional overrides
 * out (they could flip the feed's text around), spaces collapsed.
 */
export function cleanText(raw: unknown, what: string, optional = false): string {
  if (raw === undefined && optional) return "";
  if (raw === undefined) throw new Error(`${what} is missing: pass it as text.`);
  if (typeof raw !== "string") throw new Error(`${what} is a string of text.`);
  const text = raw.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/g, " ").trim();
  if (!text && !optional) throw new Error(`${what} is empty.`);
  if (text.length > BOARD_LIMITS.text) {
    throw new Error(`${what} is ${text.length} characters; at most ${BOARD_LIMITS.text}.`);
  }
  return text;
}

export class Board {
  wishes: Wish[] = [];
  serial = 0;
  /** Bumps whenever a Wish is pinned, answered, done or taken down (the page mirrors the board). */
  version = 0;

  constructor(private readonly sim: Sim) {}

  get open(): Wish[] {
    return this.wishes.filter((w) => !w.done);
  }

  /** A spectator pins a Wish, for anyone or for the villager named `forName`. */
  pin(raw: unknown, forName: string | null = null): Wish {
    const sim = this.sim;
    const text = cleanText(raw, "A Wish");
    let target: Agent | null = null;
    if (forName !== null && forName !== "") {
      target = sim.agents.find((a) => a.name.toLowerCase() === String(forName).toLowerCase()) ??
        null;
      if (!target) throw new Error(`No villager is called ${forName}.`);
    }
    if (this.open.length >= BOARD_LIMITS.open) {
      throw new Error(
        `The board holds ${BOARD_LIMITS.open} open Wishes; unpin one or wait for one to be done.`,
      );
    }
    const wish: Wish = {
      id: ++this.serial,
      text,
      for: target?.name ?? null,
      posted: sim.tick,
      until: sim.tick + BOARD_LIMITS.posted,
      replies: [],
      done: null,
    };
    this.wishes.push(wish);
    this.version++;
    const note = `A spectator pinned a Wish on the Notice Board${target ? " for you" : ""}: ` +
      `#${wish.id} “${text}” (board to read and reply; a Wish is never an order).`;
    for (const a of target ? [target] : sim.agents) a.notes.push(note);
    sim.events.push({
      type: "board",
      agent: 0,
      wish: wish.id,
      text: `pinned #${wish.id}${target ? ` for ${target.name}` : ""}: “${text}”`,
    });
    return wish;
  }

  /** A spectator takes a Wish down. False if there's no such Wish. */
  unpin(id: number): boolean {
    const i = this.wishes.findIndex((w) => w.id === id);
    if (i < 0) return false;
    this.wishes.splice(i, 1);
    this.version++;
    return true;
  }

  find(id: unknown): Wish {
    // A number, or digits in a string; never an array or a boolean that Number() would take.
    const n = typeof id === "number" || (typeof id === "string" && id.trim()) ? Number(id) : NaN;
    if (!Number.isInteger(n)) throw new Error("id is the Wish's number, as board lists it.");
    const wish = this.wishes.find((w) => w.id === n);
    if (!wish) {
      throw new Error(
        `There's no Wish #${n} on the board${this.wishes.length ? "" : " (it's empty)"}.`,
      );
    }
    return wish;
  }

  reply(agent: Agent, id: unknown, raw: unknown): string {
    const wish = this.find(id);
    const text = cleanText(raw, "Your reply");
    if (wish.done) throw new Error(`Wish #${wish.id} is done already (by ${wish.done.by}).`);
    if (wish.replies.length >= BOARD_LIMITS.replies) {
      throw new Error(`Wish #${wish.id} has ${BOARD_LIMITS.replies} replies, as many as it holds.`);
    }
    const mine = wish.replies.filter((r) => r.by === agent.name).length;
    if (mine >= BOARD_LIMITS.perVillager) {
      throw new Error(
        `You've replied to #${wish.id} ${mine} times, the most one villager may. Mark it done ` +
          "when it is, or leave it.",
      );
    }
    wish.replies.push({ by: agent.name, text, tick: this.sim.tick });
    this.version++;
    this.sim.events.push({
      type: "board",
      agent: agent.id,
      wish: wish.id,
      text: `replied to #${wish.id}: “${text}”`,
    });
    return `You replied to Wish #${wish.id}. Spectators see it on the board and over your head.`;
  }

  done(agent: Agent, id: unknown, raw: unknown): string {
    const wish = this.find(id);
    const note = cleanText(raw, "Your note", true);
    if (wish.done) throw new Error(`Wish #${wish.id} is done already (by ${wish.done.by}).`);
    if (wish.for && wish.for !== agent.name) {
      throw new Error(
        `Wish #${wish.id} is meant for ${wish.for}; only they mark it done. Reply instead.`,
      );
    }
    wish.done = { by: agent.name, note, tick: this.sim.tick };
    wish.until = this.sim.tick + BOARD_LIMITS.kept;
    this.version++;
    this.sim.events.push({
      type: "board",
      agent: agent.id,
      wish: wish.id,
      text: `marked #${wish.id} done${note ? `: “${note}”` : ""}`,
    });
    return `Wish #${wish.id} is marked done. It stays on the board a game day so spectators ` +
      "see it. (Wishes earn nothing; this one was for the people watching.)";
  }

  /** Wishes past their time come down, checked once a second. */
  step() {
    const sim = this.sim;
    if (sim.tick % TICK_HZ !== 0 || !this.wishes.length) return;
    const before = this.wishes.length;
    this.wishes = this.wishes.filter((w) => w.until > sim.tick);
    if (this.wishes.length !== before) this.version++;
  }

  /** "#3 for you, 2 h ago: “…”", with its replies and whether it's done. */
  line(w: Wish, viewer: Agent): string {
    const who = w.for ? (w.for === viewer.name ? "for you" : `for ${w.for}`) : "for anyone";
    const ago = Math.floor((this.sim.tick - w.posted) / HOUR);
    const when = ago < 1 ? "just now" : `${ago} game hour${ago === 1 ? "" : "s"} ago`;
    let s = `#${w.id} ${who}, ${when}: “${w.text}”`;
    // A done Wish is one line: who did it and their note, its replies folded away.
    if (w.done) return s + ` — done by ${w.done.by}${w.done.note ? `: “${w.done.note}”` : ""}`;
    for (const r of w.replies) s += `\n    ${r.by}: “${r.text}”`;
    return s;
  }

  /** The whole board, as the `board` tool lists it: Wishes for you first, then newest. */
  text(viewer: Agent): string {
    if (!this.wishes.length) {
      return "The Notice Board is empty: no spectator has pinned a Wish. They may at any time.";
    }
    const order = (w: Wish) => (w.done ? 2 : w.for === viewer.name ? 0 : 1);
    const list = [...this.wishes].sort((a, b) => order(a) - order(b) || b.id - a.id);
    const open = this.open.length;
    return `Notice Board: ${open} open Wish${open === 1 ? "" : "es"} from spectators. ` +
      "A Wish is a suggestion, never an order: take it up if you like it, reply, or leave it.\n" +
      list.map((w) => this.line(w, viewer)).join("\n");
  }

  /** look's line about the board, or "" when no open Wish is for this villager or anyone. */
  lookText(viewer: Agent): string {
    const mine = this.open.filter((w) => !w.for || w.for === viewer.name);
    if (!mine.length) return "";
    const forYou = mine.filter((w) => w.for === viewer.name).length;
    const newest = [...mine].sort((a, b) =>
      Number(b.for === viewer.name) - Number(a.for === viewer.name) || b.id - a.id
    ).slice(0, 2);
    return `Notice Board: ${mine.length} Wish${mine.length === 1 ? "" : "es"} from spectators` +
      (forYou ? ` (${forYou} for you)` : "") + ", e.g. " +
      newest.map((w) => `#${w.id} “${w.text}”`).join(", ") + " (board; never orders).";
  }

  save(): BoardSave {
    return structuredClone({ wishes: this.wishes, serial: this.serial });
  }

  load(s: BoardSave | undefined) {
    if (!s) return;
    const d = structuredClone(s);
    this.wishes = d.wishes, this.serial = d.serial;
  }
}
