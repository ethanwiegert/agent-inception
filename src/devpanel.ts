import type { LinkState } from "./agentlink.ts";
import { LOOKS } from "./render/look.ts";
import { type SlotInfo, SLOTS } from "./sim/protocol.ts";
import { BOARD_LIMITS, type Wish } from "./sim/board.ts";
import type { Catalog } from "./sim/catalog.ts";
import type { VillageStatus } from "./sim/village.ts";
import { pref, setPref } from "./prefs.ts";

export interface DevHandlers {
  look: (id: string) => void;
  time: (t: number) => void;
  speed: (s: number) => void;
  /** World slots: open one, start a new world, delete, export or import a world file. */
  worlds: {
    open: (slot: number) => void;
    create: () => void;
    remove: (slot: number) => void;
    exportWorld: (slot: number) => void;
    importWorld: (file: File) => void;
  };
  /** Show the connect card (the world's agent URL). */
  connect: () => void;
  /** Let go of every villager's hold, so restarted agents can rejoin by name at once. */
  freeVillagers: () => void;
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
  link: LinkState;
  worldName: string;
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

const SPEEDS: [string, number][] = [["pause", 0], ["1×", 1], ["10×", 10], ["60×", 60]];
const WEATHER: [string, number | null][] = [
  ["natural", null],
  ["clear", 0.05],
  ["cloudy", 0.5],
  ["overcast", 0.92],
];
const LINK_DOT: Record<LinkState, string> = {
  connecting: "",
  connected: "on",
  offline: "off",
  replaced: "off",
  refused: "off",
};
const LINK_TEXT: Record<LinkState, string> = {
  connecting: "linking…",
  connected: "link open",
  offline: "relay offline",
  replaced: "another tab has this world",
  refused: "link refused",
};
/** Phones and short windows: the panel starts tucked away and opens as a full-width sheet. */
const SMALL = "(max-width: 640px), (max-height: 500px)";

const css = `
.ai-panel{position:fixed;z-index:5;top:calc(12px + env(safe-area-inset-top));
  right:calc(12px + env(safe-area-inset-right));width:250px;box-sizing:border-box;
  display:flex;flex-direction:column;background:rgba(10,14,18,.72);backdrop-filter:blur(6px);
  -webkit-backdrop-filter:blur(6px);border-radius:10px;font:12px/1.5 ui-monospace,monospace;
  color:#d8dee9;user-select:none;-webkit-user-select:none;
  /* Clear of the camera buttons at the bottom; the body scrolls when the board grows. */
  max-height:calc(100vh - 96px);max-height:calc(100dvh - 96px)}
.ai-panel.closed{width:auto;max-width:calc(100vw - 120px)}
.ai-panel-bar{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;margin:0;
  padding:4px 10px 4px 14px;border:0;background:none;color:inherit;font:inherit;cursor:pointer;
  text-align:left;border-radius:10px;-webkit-tap-highlight-color:transparent}
.ai-panel-bar .sum{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  opacity:.75}
.ai-panel-bar .dot{width:7px;height:7px;border-radius:50%;background:#c9a13b;flex:none}
.ai-panel-bar .dot.on{background:#7cc36b}
.ai-panel-bar .dot.off{background:#c9604a}
.ai-panel-bar .chev{flex:none;opacity:.75;transition:transform .15s}
.ai-panel.closed .chev{transform:rotate(-90deg)}
.ai-panel-bar:focus-visible{outline:2px solid #9fd36b;outline-offset:-2px}
.ai-panel-body{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;overflow:auto;
  padding:2px 14px 12px;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.ai-panel.closed .ai-panel-body{display:none}
.ai-panel-body button{margin:2px 4px 0 0;padding:2px 8px;border-radius:6px;border:1px solid #445;
  background:#1a2029;color:inherit;font:inherit;cursor:pointer;
  -webkit-tap-highlight-color:transparent}
.ai-panel-body button.on,.ai-panel-body button.accent{border-color:#9fd36b}
.ai-panel-body button.small{padding:0 6px;margin:0}
.ai-panel-body .head{opacity:.6}
.ai-panel-body input:not([type]),.ai-panel-body select{width:100%;box-sizing:border-box;
  margin-top:4px;padding:3px 6px;border-radius:6px;border:1px solid #445;background:#0e1319;
  color:inherit;font:inherit}
.ai-panel-body select{width:auto;max-width:130px}
.ai-panel-body input[type=range]{width:100%;margin:4px 0}
@media (hover:hover){.ai-panel-body button:hover,.ai-panel-bar:hover{background:#232b36}}
/* Fingers: bigger targets, and 16px fields so phones don't zoom in on focus. */
@media (pointer:coarse){
  .ai-panel{font-size:13px}
  .ai-panel-bar{min-height:40px}
  .ai-panel-body button{min-height:36px;padding:4px 12px;margin:3px 5px 0 0}
  .ai-panel-body button.small{min-width:36px;min-height:32px;padding:0 8px}
  .ai-panel-body input:not([type]),.ai-panel-body select{font-size:16px;min-height:38px}
  .ai-panel-body input[type=range]{height:32px}
}
@media (max-width:640px){
  .ai-panel:not(.closed){left:calc(8px + env(safe-area-inset-left));
    right:calc(8px + env(safe-area-inset-right));top:calc(8px + env(safe-area-inset-top));
    width:auto;max-height:72vh;max-height:72dvh;background:rgba(10,14,18,.86)}
}`;

/** Spectator/dev controls. Plain DOM, rebuilt only when its inputs change. */
export function createDevPanel(on: DevHandlers) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  const panel = document.createElement("div");
  panel.className = "ai-panel";
  const bar = document.createElement("button");
  bar.type = "button";
  bar.className = "ai-panel-bar";
  const dot = Object.assign(document.createElement("span"), { className: "dot" });
  const summary = Object.assign(document.createElement("span"), {
    className: "sum",
    textContent: "spectator",
  });
  const chev = Object.assign(document.createElement("span"), {
    className: "chev",
    textContent: "▾",
  });
  chev.setAttribute("aria-hidden", "true");
  bar.append(dot, summary, chev);
  const body = document.createElement("div");
  body.className = "ai-panel-body";
  body.id = "ai-panel-body";
  bar.setAttribute("aria-controls", body.id);
  panel.append(bar, body);
  document.body.append(panel);

  // Open on a laptop, tucked away on a phone, unless the spectator chose otherwise here before.
  const small = matchMedia(SMALL);
  let open = pref("panel") ? pref("panel") === "open" : !small.matches;
  const setOpen = (on: boolean, remember = true) => {
    open = on;
    panel.classList.toggle("closed", !on);
    bar.setAttribute("aria-expanded", String(on));
    bar.title = on ? "Hide the panel" : "Show the panel";
    if (remember) setPref("panel", on ? "open" : "closed");
  };
  setOpen(open, false);
  bar.onclick = () => setOpen(!open);
  // On a small screen the open panel is a sheet over the world: a tap on the world (not a drag
  // to look around) puts it away again.
  let press: { x: number; y: number; t: number } | null = null;
  document.addEventListener("pointerdown", (e) => {
    press = open && small.matches && !panel.contains(e.target as Node)
      ? { x: e.clientX, y: e.clientY, t: e.timeStamp }
      : null;
  }, true);
  document.addEventListener("pointerup", (e) => {
    const p = press;
    press = null;
    if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10 || e.timeStamp - p.t > 400) return;
    // Only taps on the world itself, not on the other cards and buttons over it.
    if ((e.target as Element | null)?.tagName === "CANVAS") setOpen(false, false);
  }, true);

  const section = (label: string) => {
    const el = document.createElement("div");
    const head = document.createElement("div");
    head.className = "head";
    head.textContent = label;
    const content = document.createElement("div");
    el.append(head, content);
    body.append(el);
    return { head, body: content };
  };
  const button = (label: string, onclick: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.onclick = onclick;
    return b;
  };
  const mark = (b: HTMLButtonElement, active: boolean) => b.classList.toggle("on", active);

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
  slider.setAttribute("aria-label", "time of day");
  let dragging = false;
  slider.onpointerdown = () => (dragging = true);
  slider.onpointerup = slider.onpointercancel = () => (dragging = false);
  slider.oninput = () => on.time(Number(slider.value));
  const speedButtons = SPEEDS.map(([label, s]) => button(label, () => on.speed(s)));
  time.body.append(slider, ...speedButtons);

  const world = section("world");
  const weatherButtons = WEATHER.map(([label, c]) => button(label, () => on.weather(c)));
  let muted = false;
  const soundButton = button("", () => on.sound(!muted));
  world.body.append(...weatherButtons, soundButton);

  // World slots: three worlds per browser, each with its own seed, save and agent link.
  const worlds = section("worlds");
  const slotList = document.createElement("div");
  const file = document.createElement("input");
  file.type = "file";
  file.accept = ".gz,.json,application/gzip,application/json";
  file.style.display = "none";
  file.onchange = () => {
    const f = file.files?.[0];
    if (f) on.worlds.importWorld(f);
    file.value = "";
  };
  const note = document.createElement("div");
  note.style.cssText = "color:#e8c46a;margin-top:4px;display:none";
  worlds.body.append(
    slotList,
    button("new world", () => on.worlds.create()),
    button("import", () => file.click()),
    file,
    note,
  );

  // The Notice Board: spectators pin Wishes for villagers. Never orders, and never moves anyone.
  const board = section("notice board");
  const wishText = document.createElement("input");
  wishText.maxLength = BOARD_LIMITS.text;
  wishText.placeholder = "Pin a Wish (a suggestion, never an order)";
  wishText.enterKeyHint = "send";
  wishText.setAttribute("aria-label", "Wish");
  const wishFor = document.createElement("select");
  wishFor.setAttribute("aria-label", "for whom");
  const pin = () => {
    const text = wishText.value.trim();
    if (!text) return;
    on.wish(text, wishFor.value || null);
    wishText.value = "";
  };
  // A block body: an on* handler that returns false cancels the key, so `cond && pin()` would
  // swallow every letter typed. Enter mid-composition (an IME) picks a word, not a pin.
  wishText.onkeydown = (e) => {
    if (e.key === "Enter" && !e.isComposing) pin();
  };
  const pinButton = button("pin", pin);
  const wishes = document.createElement("div");
  wishes.style.cssText = "max-height:140px;overflow:auto";
  board.body.append(wishText, wishFor, pinButton, wishes);
  let boardVersion = -1;
  let forKey: string | null = null; // null: the "anyone" option isn't in yet

  const village = section("village");
  let life = true;
  const lifeButton = button("Village Life", () => on.villageLife(true));
  const sandboxButton = button("Sandbox", () => on.villageLife(false));
  const errands = document.createElement("div");
  village.body.append(lifeButton, sandboxButton, errands);
  let villageKey = "";

  const agents = section("agents");
  const connectButton = button("connect an agent", () => on.connect());
  connectButton.classList.add("accent");
  const freeButton = button("free villagers", () => on.freeVillagers());
  freeButton.title =
    "Every agent joins again; a restarted agent can take its villager back at once";
  agents.head.after(connectButton, freeButton);
  let agentsKey = "";

  const catalog = section("catalog");
  let catalogVersion = -1;

  const stats = document.createElement("div");
  stats.style.opacity = "0.8";
  body.append(stats);

  let noteTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    /** Something the spectator should know about worlds: a full slot list, a failed import. */
    notice(text: string) {
      note.textContent = text;
      note.style.display = "";
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => (note.style.display = "none"), 15_000);
    },
    /** The world slots, as the worker last listed them. */
    worlds(slots: SlotInfo[], current: number) {
      slotList.replaceChildren(
        ...slots.slice(0, SLOTS).map((w) => {
          const row = document.createElement("div");
          row.style.cssText = "display:flex;align-items:center;gap:2px;margin-top:2px";
          const label = document.createElement("span");
          label.style.cssText = "flex:1;min-width:0;white-space:nowrap;overflow:hidden;" +
            "text-overflow:ellipsis;" + (w.slot === current ? "color:#9fd36b" : "");
          if (w.empty) {
            label.textContent = `${w.slot + 1} · empty`;
            label.style.opacity = "0.5";
            row.append(label);
            return row;
          }
          // World and villager names are text, never HTML.
          label.textContent = `${w.slot + 1} · ${w.name} · day ${w.day}`;
          label.title = `seed ${w.seed}` +
            (w.villagers.length ? ` · ${w.villagers.join(", ")}` : " · nobody yet") +
            (w.savedAt ? ` · saved ${new Date(w.savedAt).toLocaleString()}` : "");
          const small = (text: string, title: string, f: () => void) => {
            const b = button(text, f);
            b.title = title;
            b.setAttribute("aria-label", title);
            b.classList.add("small");
            return b;
          };
          row.append(label);
          if (w.slot !== current) {
            row.append(small("open", "watch this world", () => on.worlds.open(w.slot)));
          }
          row.append(small("⤓", "export to a file", () => on.worlds.exportWorld(w.slot)));
          if (w.slot !== current) row.append(small("×", "delete", () => on.worlds.remove(w.slot)));
          return row;
        }),
      );
    },
    /** Refresh readouts; call a few times a second, not every frame. */
    update(s: DevStatus) {
      lookButtons.forEach(([id, b]) => mark(b, id === s.look));
      speedButtons.forEach((b, i) => mark(b, SPEEDS[i][1] === s.speed));
      if (!dragging) slider.value = String(s.timeOfDay);
      const minutes = Math.floor(s.timeOfDay * 24 * 60);
      time.head.textContent = `time · day ${s.day}, ${
        String(Math.floor(minutes / 60)).padStart(2, "0")
      }:${String(minutes % 60).padStart(2, "0")}`;
      worlds.head.textContent = `worlds · seed ${s.seed}`;
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
            x.setAttribute("aria-label", "unpin");
            x.classList.add("small");
            x.style.cssText = "float:right;margin-left:4px";
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
      agents.head.textContent = `agents · ${LINK_TEXT[s.link]}`;
      // The bar says enough to watch by with the panel put away.
      const clock = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${
        String(minutes % 60).padStart(2, "0")
      }`;
      const n = s.agents.length;
      summary.textContent = `day ${s.day} ${clock} · ${n} villager${n === 1 ? "" : "s"}`;
      dot.className = `dot ${LINK_DOT[s.link]}`;
      bar.setAttribute("aria-label", `${summary.textContent}, ${LINK_TEXT[s.link]}: panel`);

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
              const b = button(label(a), () => {
                on.follow(s.following === a.id ? null : a.id);
                // On a phone, get the sheet out of the way of the villager being followed.
                if (small.matches && s.following !== a.id) setOpen(false, false);
              });
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
