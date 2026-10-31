import { LOOKS } from "./render/look.ts";
import { BOARD_LIMITS, type Wish } from "./sim/board.ts";
import type { Catalog } from "./sim/catalog.ts";
import type { VillageStatus } from "./sim/village.ts";

export interface DevHandlers {
  look: (id: string) => void;
  time: (t: number) => void;
  speed: (s: number) => void;
  seed: (seed: number) => void;
  follow: (agentId: number | null) => void;
  /** Village Life on, or the world a Sandbox. */
  villageLife: (on: boolean) => void;
  /** Hold the sky at this cloud cover, or let the weather drift (null). */
  weather: (clouds: number | null) => void;
  /** Pin a Wish on the Notice Board, for anyone (null) or one villager by name. */
  wish: (text: string, forName: string | null) => void;
  unpin: (id: number) => void;
  sound: (muted: boolean) => void;
}

export interface DevStatus {
  look: string;
  timeOfDay: number;
  day: number;
  speed: number;
  seed: number;
  bridge: boolean;
  agents: { id: number; name: string }[];
  following: number | null;
  catalog: Catalog;
  village: VillageStatus | null;
  clouds: number;
  heldClouds: number | null;
  board: Wish[];
  boardVersion: number;
  muted: boolean;
  stats: string[];
}

const BUTTON = "margin:2px 4px 0 0;padding:2px 8px;border-radius:6px;border:1px solid #445;" +
  "background:#1a2029;color:inherit;font:inherit;cursor:pointer";
const SPEEDS: [string, number][] = [["pause", 0], ["1×", 1], ["10×", 10], ["60×", 60]];
const WEATHER: [string, number | null][] = [
  ["natural", null],
  ["clear", 0.05],
  ["cloudy", 0.5],
  ["overcast", 0.92],
];
const INPUT = "width:100%;box-sizing:border-box;margin-top:4px;padding:3px 6px;border-radius:6px;" +
  "border:1px solid #445;background:#0e1319;color:inherit;font:inherit";

/** Spectator/dev controls. Plain DOM, rebuilt only when its inputs change. */
export function createDevPanel(on: DevHandlers) {
  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;top:12px;right:12px;padding:12px 14px;background:rgba(10,14,18,.72);" +
    "backdrop-filter:blur(6px);border-radius:10px;font:12px/1.5 ui-monospace,monospace;" +
    "color:#d8dee9;display:grid;grid-template-columns:minmax(0,1fr);gap:8px;width:250px;" +
    // Clear of the camera buttons at the bottom; scrolls when the board grows.
    "user-select:none;max-height:calc(100vh - 96px);overflow:auto;box-sizing:border-box";
  document.body.append(panel);

  const section = (label: string) => {
    const el = document.createElement("div");
    const head = document.createElement("div");
    head.style.opacity = "0.6";
    head.textContent = label;
    const body = document.createElement("div");
    el.append(head, body);
    panel.append(el);
    return { head, body };
  };
  const button = (label: string, onclick: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = BUTTON;
    b.onclick = onclick;
    return b;
  };
  const mark = (
    b: HTMLButtonElement,
    active: boolean,
  ) => (b.style.borderColor = active ? "#9fd36b" : "#445");

  const looks = section("look");
  const lookButtons = Object.entries(LOOKS).map(([id, l]) => {
    const b = button(l.name, () => on.look(id));
    looks.body.append(b);
    return [id, b] as const;
  });

  const time = section("time");
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "1";
  slider.step = "0.001";
  slider.style.width = "100%";
  let dragging = false;
  slider.onpointerdown = () => (dragging = true);
  slider.onpointerup = () => (dragging = false);
  slider.oninput = () => on.time(Number(slider.value));
  const speedButtons = SPEEDS.map(([label, s]) => button(label, () => on.speed(s)));
  time.body.append(slider, ...speedButtons);

  const world = section("world");
  const seedButton = button("", () => on.seed((Math.random() * 1e6) | 0));
  const weatherButtons = WEATHER.map(([label, c]) => button(label, () => on.weather(c)));
  let muted = false;
  const soundButton = button("", () => on.sound(!muted));
  world.body.append(seedButton, document.createElement("br"), ...weatherButtons, soundButton);

  // The Notice Board: spectators pin Wishes for villagers. Never orders, and never moves anyone.
  const board = section("notice board");
  const wishText = document.createElement("input");
  wishText.maxLength = BOARD_LIMITS.text;
  wishText.placeholder = "Pin a Wish (a suggestion, never an order)";
  wishText.style.cssText = INPUT;
  const wishFor = document.createElement("select");
  wishFor.style.cssText = INPUT + ";width:auto;max-width:130px";
  const pin = () => {
    const text = wishText.value.trim();
    if (!text) return;
    on.wish(text, wishFor.value || null);
    wishText.value = "";
  };
  wishText.onkeydown = (e) => e.key === "Enter" && pin();
  const pinButton = button("pin", pin);
  const wishes = document.createElement("div");
  wishes.style.cssText = "max-height:140px;overflow:auto";
  board.body.append(wishText, wishFor, pinButton, wishes);
  let boardVersion = -1;
  let forKey = "";

  const village = section("village");
  let life = true;
  const lifeButton = button("Village Life", () => on.villageLife(true));
  const sandboxButton = button("Sandbox", () => on.villageLife(false));
  const errands = document.createElement("div");
  village.body.append(lifeButton, sandboxButton, errands);
  let villageKey = "";

  const agents = section("agents");
  let agentsKey = "";

  const catalog = section("catalog");
  let catalogVersion = -1;

  const stats = document.createElement("div");
  stats.style.opacity = "0.8";
  panel.append(stats);

  return {
    /** Refresh readouts; call a few times a second, not every frame. */
    update(s: DevStatus) {
      lookButtons.forEach(([id, b]) => mark(b, id === s.look));
      speedButtons.forEach((b, i) => mark(b, SPEEDS[i][1] === s.speed));
      if (!dragging) slider.value = String(s.timeOfDay);
      const minutes = Math.floor(s.timeOfDay * 24 * 60);
      time.head.textContent = `time · day ${s.day}, ${
        String(Math.floor(minutes / 60)).padStart(2, "0")
      }:${String(minutes % 60).padStart(2, "0")}`;
      seedButton.textContent = `seed ${s.seed} — new world`;
      weatherButtons.forEach((b, i) => mark(b, WEATHER[i][1] === s.heldClouds));
      weatherButtons[0].title = `clouds ${Math.round(s.clouds * 100)}%`;
      muted = s.muted;
      soundButton.textContent = muted ? "sound off" : "sound on";
      mark(soundButton, !muted);

      const names = s.agents.map((a) => a.name);
      if (names.join("\n") !== forKey) {
        forKey = names.join("\n");
        const was = wishFor.value;
        wishFor.replaceChildren(
          Object.assign(document.createElement("option"), { value: "", textContent: "anyone" }),
          // Villagers' names go in as text, never HTML.
          ...names.map((n) =>
            Object.assign(document.createElement("option"), { value: n, textContent: n })
          ),
        );
        wishFor.value = names.includes(was) ? was : "";
      }
      if (s.boardVersion !== boardVersion) {
        boardVersion = s.boardVersion;
        const open = s.board.filter((w) => !w.done).length;
        board.head.textContent = `notice board · ${open}/${BOARD_LIMITS.open} open`;
        wishes.replaceChildren(
          ...[...s.board].reverse().map((w) => {
            const el = document.createElement("div");
            el.style.cssText = "margin-top:6px;opacity:" + (w.done ? ".6" : ".95");
            const head = document.createElement("div");
            const x = button("×", () => on.unpin(w.id));
            x.title = "unpin";
            x.style.cssText += ";float:right;padding:0 6px;margin:0";
            // Spectators' and villagers' words are text, never HTML.
            head.textContent = `#${w.id}${w.for ? ` → ${w.for}` : ""}${
              w.done ? ` ✓ ${w.done.by}` : ""
            }: ${w.text}`;
            head.prepend(x);
            el.append(head);
            for (
              const r of [
                ...w.replies,
                ...(w.done?.note ? [{ by: w.done.by, text: w.done.note }] : []),
              ]
            ) {
              const line = document.createElement("div");
              line.style.cssText = "padding-left:10px;color:#a9c48b";
              line.textContent = `${r.by}: ${r.text}`;
              el.append(line);
            }
            return el;
          }),
        );
        if (!s.board.length) wishes.textContent = "no Wishes pinned";
      }
      agents.head.textContent = `agents · bridge ${s.bridge ? "connected" : "offline"}`;

      const v = s.village;
      if (v) {
        life = v.life;
        mark(lifeButton, life);
        mark(sandboxButton, !life);
        village.head.textContent = life
          ? `village · a ${v.level}, ${v.points}${v.next === null ? "" : `/${v.next}`} points`
          : "village · sandbox: no needs, all unlocked";
        const key = JSON.stringify([life, v.errands]);
        if (key !== villageKey) {
          villageKey = key;
          errands.replaceChildren(
            ...(life ? v.errands : []).map((t) => {
              const el = document.createElement("div");
              // Errands can name villagers' Designs: text, never HTML.
              el.textContent = el.title = t;
              el.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
                "opacity:.85";
              return el;
            }),
          );
        }
      }
      // Each villager's needs, to the nearest tenth, so the buttons don't rebuild every tick.
      const needs = new Map((s.village?.needs ?? []).map(([id, f, r]) => [id, [f, r]]));
      const tenth = (n: number) => Math.round(n * 10) * 10;
      const label = (a: { id: number; name: string }) => {
        const n = needs.get(a.id);
        return n && life ? `${a.name} ${tenth(n[0])}·${tenth(n[1])}` : a.name;
      };
      const key = JSON.stringify([s.agents.map(label), s.following]);
      if (key !== agentsKey) {
        agentsKey = key;
        agents.body.replaceChildren(
          ...(s.agents.length
            ? s.agents.map((a) => {
              const b = button(label(a), () => on.follow(s.following === a.id ? null : a.id));
              const n = needs.get(a.id);
              if (n && life) b.title = `fed ${tenth(n[0])}%, rested ${tenth(n[1])}%`;
              mark(b, s.following === a.id);
              return b;
            })
            : [Object.assign(document.createElement("span"), { textContent: "none yet" })]),
        );
      }
      if (s.catalog.version !== catalogVersion) {
        catalogVersion = s.catalog.version;
        const c = s.catalog;
        const mine = c.entries.filter((e) => e.author !== "nature");
        catalog.head.textContent =
          `catalog · ${c.entries.length} entries, ${mine.length} by villagers`;
        // Agent-written names go in as text, never HTML.
        const line = (text: string, color = "") => {
          const el = document.createElement("div");
          el.textContent = el.title = text;
          el.style.cssText = `color:${color};white-space:nowrap;overflow:hidden;` +
            "text-overflow:ellipsis";
          return el;
        };
        const open = c.proposals.filter((p) => p.status === "open");
        catalog.body.replaceChildren(
          ...mine.filter((e) => e.kind !== "relation").slice(-3).reverse().map((e) =>
            line(`${e.kind} “${e.name}” · ${e.author}`)
          ),
          ...open.slice(0, 3).map((p) =>
            line(`vote #${p.id}: ${p.action} “${c.get(p.entry)?.name}” · ${p.by}`, "#e8c46a")
          ),
          ...(open.length > 3 ? [line(`+${open.length - 3} more open votes`, "#e8c46a")] : []),
        );
        if (!catalog.body.childElementCount) catalog.body.append(line("nothing by villagers yet"));
      }
      stats.textContent = s.stats.join("  ·  ");
    },
  };
}
