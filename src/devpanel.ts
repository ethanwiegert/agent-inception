import type { LinkState } from "./agentlink.ts";
import { type SlotInfo, SLOTS } from "./sim/protocol.ts";
import { BOARD_LIMITS, type Wish } from "./sim/board.ts";
import type { Catalog } from "./sim/catalog.ts";
import type { VillageStatus } from "./sim/village.ts";
import { pref, setPref } from "./prefs.ts";

export interface DevHandlers {
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
  /** Pin a Wish on the Notice Board, for anyone (null) or one villager by name. */
  wish: (text: string, forName: string | null) => void;
  unpin: (id: number) => void;
  /** Hide one reply on a Wish (or show it again), without touching the Wish. */
  hideReply: (wish: number, index: number, hidden: boolean) => void;
  /** Feature tier: a tier locks it (the governor holds its hands off), "auto" frees it. */
  quality: (q: "auto" | "low" | "medium" | "high") => void;
  sound: (muted: boolean) => void;
}

export interface DevStatus {
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
  board: Wish[];
  boardVersion: number;
  muted: boolean;
  stats: string[];
  quality: "low" | "medium" | "high";
  /** true while the frame-rate governor may move the tier (the "auto" button). */
  qualityAuto: boolean;
}

const SPEEDS: [string, number][] = [["pause", 0], ["1×", 1], ["10×", 10], ["60×", 60]];
const skyLabel = (clouds: number) =>
  clouds < 0.16
    ? "clear sky"
    : clouds < 0.36
    ? "light clouds"
    : clouds < 0.62
    ? "partly cloudy"
    : clouds < 0.84
    ? "cloudy"
    : "overcast";
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
  right:calc(12px + env(safe-area-inset-right));width:254px;box-sizing:border-box;
  display:flex;flex-direction:column;background:rgba(24,22,30,.66);backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,244,218,.18);border-radius:14px;
  font:12px/1.5 ui-monospace,monospace;color:#f2ebe0;user-select:none;-webkit-user-select:none;
  box-shadow:0 8px 28px rgba(10,8,16,.3);
  /* Clear of the camera and quick dock buttons at the bottom. */
  max-height:calc(100vh - 142px);max-height:calc(100dvh - 142px)}
.ai-panel.closed{width:auto;max-width:calc(100vw - 120px)}
.ai-panel-bar{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;margin:0;
  padding:4px 10px 4px 14px;border:0;background:none;color:inherit;font:inherit;cursor:pointer;
  text-align:left;border-radius:14px;-webkit-tap-highlight-color:transparent}
.ai-panel-bar .sum{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  opacity:.82}
.ai-panel-bar .dot{width:7px;height:7px;border-radius:50%;background:#e4b956;flex:none}
.ai-panel-bar .dot.on{background:#9ad88c}
.ai-panel-bar .dot.off{background:#e07b67}
.ai-panel-bar .chev{flex:none;opacity:.75;transition:transform .15s}
.ai-panel.closed .chev{transform:rotate(-90deg)}
.ai-panel-bar:focus-visible{outline:2px solid #b8df90;outline-offset:-2px}
.ai-panel-body{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;overflow:auto;
  padding:2px 14px 12px;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.ai-panel.closed .ai-panel-body{display:none}
.ai-panel-body button{margin:2px 4px 0 0;padding:3px 8px;border-radius:8px;
  border:1px solid rgba(255,244,218,.18);background:rgba(38,35,48,.75);color:inherit;font:inherit;
  cursor:pointer;-webkit-tap-highlight-color:transparent}
.ai-panel-body button.on,.ai-panel-body button.accent{border-color:#b8df90;
  background:rgba(56,82,56,.62)}
.ai-panel-body button.small{padding:0 6px;margin:0}
.ai-panel-body .head{opacity:.66;color:#dfd4c2}
.ai-panel-body input:not([type]),.ai-panel-body select{width:100%;box-sizing:border-box;
  margin-top:4px;padding:4px 7px;border-radius:8px;border:1px solid rgba(255,244,218,.2);
  background:rgba(16,15,22,.78);color:inherit;font:inherit}
.ai-panel-body select{width:auto;max-width:130px}
.ai-panel-body input[type=range]{width:100%;margin:4px 0;accent-color:#b8df90}
@media (hover:hover){.ai-panel-body button:hover,.ai-panel-bar:hover{background:rgba(56,52,70,.72)}}
/* Frosted-glass bottom-right mood dock (weather, time-of-day, village life — mockup 06). */
.ai-dock{position:fixed;z-index:5;right:calc(12px + env(safe-area-inset-right));
  bottom:calc(54px + env(safe-area-inset-bottom));display:flex;gap:8px;align-items:center}
.ai-dock button{width:38px;height:38px;border-radius:11px;border:1px solid rgba(255,246,228,.36);
  background:rgba(28,26,38,.44);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  color:#faf4e8;display:grid;place-items:center;cursor:pointer;padding:0;
  box-shadow:0 4px 14px rgba(10,10,18,.24);transition:background .15s,border-color .15s,transform .12s;
  -webkit-tap-highlight-color:transparent;touch-action:manipulation}
.ai-dock button svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.8;
  stroke-linecap:round;stroke-linejoin:round}
.ai-dock button.on{border-color:rgba(184,223,144,.82);background:rgba(44,68,48,.58)}
@media (hover:hover){.ai-dock button:hover{background:rgba(46,43,60,.68);
  border-color:rgba(255,244,218,.68);transform:translateY(-1px)}}
/* Fingers: bigger targets, and 16px fields so phones don't zoom in on focus. */
@media (pointer:coarse){
  .ai-panel{font-size:13px}
  .ai-panel-bar{min-height:40px}
  .ai-panel-body button{min-height:36px;padding:4px 12px;margin:3px 5px 0 0}
  .ai-panel-body button.small{min-width:36px;min-height:32px;padding:0 8px}
  .ai-panel-body input:not([type]),.ai-panel-body select{font-size:16px;min-height:38px}
  .ai-panel-body input[type=range]{height:32px}
  .ai-dock{bottom:calc(62px + env(safe-area-inset-bottom))}
  .ai-dock button{width:42px;height:42px}
}
@media (max-width:640px){
  .ai-panel:not(.closed){left:calc(8px + env(safe-area-inset-left));
    right:calc(8px + env(safe-area-inset-right));top:calc(8px + env(safe-area-inset-top));
    width:auto;max-height:72vh;max-height:72dvh;background:rgba(22,20,28,.88)}
}`;

const MOOD_TIMES: [string, number][] = [
  ["Sunlit morning", 0.36],
  ["High noon", 0.5],
  ["Golden dusk", 0.73],
  ["Twilight lanterns", 0.85],
];

function svgIcon(paths: string[]): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

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

  // Minimal frosted-glass bottom-right quick bar (time-of-day mood, village life heart).
  const dock = document.createElement("div");
  dock.className = "ai-dock";
  let curTimeIdx = 0;
  let curLife = true;
  const timeQuick = document.createElement("button");
  timeQuick.type = "button";
  timeQuick.title = "Cycle time of day (Morning / Noon / Golden Dusk / Twilight)";
  timeQuick.append(svgIcon(["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 7v5l3.5 2"]));
  timeQuick.onclick = () => {
    curTimeIdx = (curTimeIdx + 1) % MOOD_TIMES.length;
    on.time(MOOD_TIMES[curTimeIdx][1]);
  };
  const heartQuick = document.createElement("button");
  heartQuick.type = "button";
  heartQuick.title = "Toggle Village Life / Sandbox";
  heartQuick.append(
    svgIcon([
      "M12 20s-7.5-4.7-7.5-10.2A4.3 4.3 0 0 1 12 6.8a4.3 4.3 0 0 1 7.5 3C19.5 15.3 12 20 12 20Z",
    ]),
  );
  heartQuick.onclick = () => on.villageLife(!curLife);
  dock.append(timeQuick, heartQuick);
  document.body.append(dock);

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

  const quality = section("quality");
  const QUALITY_BUTTONS = ["auto", "low", "medium", "high"] as const;
  const qualityButtons = QUALITY_BUTTONS.map((id) => button(id, () => on.quality(id)));
  quality.body.append(...qualityButtons);

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
  let muted = false;
  const soundButton = button("", () => on.sound(!muted));
  world.body.append(soundButton);

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
      qualityButtons.forEach((b, i) => {
        const id = QUALITY_BUTTONS[i];
        mark(b, id === "auto" ? s.qualityAuto : id === s.quality && !s.qualityAuto);
      });
      quality.head.textContent = `quality · ${s.qualityAuto ? `auto (${s.quality})` : s.quality}`;
      speedButtons.forEach((b, i) => mark(b, SPEEDS[i][1] === s.speed));
      if (!dragging) slider.value = String(s.timeOfDay);
      const minutes = Math.floor(s.timeOfDay * 24 * 60);
      time.head.textContent = `time · day ${s.day}, ${
        String(Math.floor(minutes / 60)).padStart(2, "0")
      }:${String(minutes % 60).padStart(2, "0")}`;
      worlds.head.textContent = `worlds · seed ${s.seed}`;
      world.head.textContent = `world · ${skyLabel(s.clouds)}`;
      world.head.title = `today's sky (${Math.round(s.clouds * 100)}% clouds, random per day)`;
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
            w.replies.forEach((r, i) => {
              const line = document.createElement("div");
              line.style.cssText = "padding-left:10px;color:#a9c48b" +
                (r.hidden ? ";opacity:.45" : "");
              const hide = button("×", () => on.hideReply(w.id, i, !r.hidden));
              hide.title = r.hidden ? "show" : "hide";
              hide.setAttribute("aria-label", hide.title);
              hide.classList.add("small");
              hide.style.cssText = "float:right;margin-left:4px";
              line.textContent = `${r.by}: ${r.text}`;
              line.prepend(hide);
              el.append(line);
            });
            if (w.done?.note) {
              const line = document.createElement("div");
              line.style.cssText = "padding-left:10px;color:#a9c48b";
              line.textContent = `${w.done.by}: ${w.done.note}`;
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
      summary.textContent = `day ${s.day} ${clock} · ${n} floatsee${n === 1 ? "" : "s"}`;
      dot.className = `dot ${LINK_DOT[s.link]}`;
      bar.setAttribute("aria-label", `${summary.textContent}, ${LINK_TEXT[s.link]}: panel`);

      const v = s.village;
      if (v) {
        life = v.life;
        curLife = life;
        mark(lifeButton, life);
        mark(sandboxButton, !life);
        mark(heartQuick, life);
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
