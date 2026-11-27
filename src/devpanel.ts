import type { LinkState } from "./agentlink.ts";
import {
  formatDateTime,
  type MessageKey,
  onLocaleChange,
  populateLanguageSelect,
  setLocale,
  t,
  tPlural,
} from "./i18n.ts";
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

const SPEEDS: [string | null, number][] = [[null, 0], ["1×", 1], ["10×", 10], ["60×", 60]];
const skyLabel = (clouds: number) =>
  clouds < 0.16
    ? t("panel.skyClear")
    : clouds < 0.36
    ? t("panel.skyLight")
    : clouds < 0.62
    ? t("panel.skyPartly")
    : clouds < 0.84
    ? t("panel.skyCloudy")
    : t("panel.skyOvercast");
const LINK_DOT: Record<LinkState, string> = {
  connecting: "",
  connected: "on",
  offline: "off",
  replaced: "off",
  refused: "off",
};
const LINK_KEY: Record<LinkState, MessageKey> = {
  connecting: "panel.linkConnecting",
  connected: "panel.linkConnected",
  offline: "panel.linkOffline",
  replaced: "panel.linkReplaced",
  refused: "panel.linkRefused",
};
const QUALITY_KEY: Record<"auto" | "low" | "medium" | "high", MessageKey> = {
  auto: "panel.qualityAuto",
  low: "panel.qualityLow",
  medium: "panel.qualityMedium",
  high: "panel.qualityHigh",
};
const LEVEL_KEY: Record<string, MessageKey> = {
  camp: "panel.levelCamp",
  hamlet: "panel.levelHamlet",
  village: "panel.levelVillage",
};
const KIND_KEY: Record<string, MessageKey> = {
  material: "panel.kindMaterial",
  design: "panel.kindDesign",
  rule: "panel.kindRule",
  relation: "panel.kindRelation",
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
  padding:4px 10px 4px 14px;padding-inline:14px 10px;border:0;background:none;color:inherit;
  font:inherit;cursor:pointer;text-align:start;border-radius:14px;-webkit-tap-highlight-color:transparent}
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
.ai-panel-body button{margin:2px 0 0;margin-inline-end:4px;padding:3px 8px;border-radius:8px;
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
.ai-panel-body select.full{width:100%;max-width:100%}
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
  .ai-panel-body button{min-height:36px;padding:4px 12px;margin:3px 0 0;margin-inline-end:5px}
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
    textContent: t("panel.spectator"),
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
  timeQuick.append(svgIcon(["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 7v5l3.5 2"]));
  timeQuick.onclick = () => {
    curTimeIdx = (curTimeIdx + 1) % MOOD_TIMES.length;
    on.time(MOOD_TIMES[curTimeIdx][1]);
  };
  const heartQuick = document.createElement("button");
  heartQuick.type = "button";
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
  const setOpen = (isOpen: boolean, remember = true) => {
    open = isOpen;
    panel.classList.toggle("closed", !isOpen);
    bar.setAttribute("aria-expanded", String(isOpen));
    bar.title = isOpen ? t("panel.hide") : t("panel.show");
    if (remember) setPref("panel", isOpen ? "open" : "closed");
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

  const quality = section(t("panel.quality"));
  const QUALITY_BUTTONS = ["auto", "low", "medium", "high"] as const;
  const qualityButtons = QUALITY_BUTTONS.map((id) =>
    button(t(QUALITY_KEY[id]), () => on.quality(id))
  );
  quality.body.append(...qualityButtons);

  const time = section(t("panel.time"));
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "1";
  slider.step = "0.001";
  let dragging = false;
  slider.onpointerdown = () => (dragging = true);
  slider.onpointerup = slider.onpointercancel = () => (dragging = false);
  slider.oninput = () => on.time(Number(slider.value));
  const speedButtons = SPEEDS.map(([label, s]) =>
    button(label ?? t("panel.pause"), () => on.speed(s))
  );
  time.body.append(slider, ...speedButtons);

  const world = section(t("panel.world"));
  let muted = false;
  const soundButton = button("", () => on.sound(!muted));
  world.body.append(soundButton);

  const language = section(t("panel.language"));
  const langSelect = document.createElement("select");
  langSelect.className = "full";
  langSelect.onchange = () => setLocale(langSelect.value);
  language.body.append(langSelect);

  // World slots: three worlds per browser, each with its own seed, save and agent link.
  const worlds = section(t("panel.worlds"));
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
  const newWorldButton = button(t("panel.newWorld"), () => on.worlds.create());
  const importButton = button(t("panel.importWorld"), () => file.click());
  worlds.body.append(slotList, newWorldButton, importButton, file, note);

  // The Notice Board: spectators pin Wishes for villagers. Never orders, and never moves anyone.
  const board = section(t("panel.board"));
  const wishText = document.createElement("input");
  wishText.maxLength = BOARD_LIMITS.text;
  wishText.enterKeyHint = "send";
  const wishFor = document.createElement("select");
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
  const pinButton = button(t("panel.wishPin"), pin);
  const wishes = document.createElement("div");
  wishes.style.cssText = "max-height:140px;overflow:auto";
  board.body.append(wishText, wishFor, pinButton, wishes);
  let boardVersion = -1;
  let forKey: string | null = null; // null: the "anyone" option isn't in yet

  const village = section(t("panel.village"));
  let life = true;
  const lifeButton = button(t("panel.villageLife"), () => on.villageLife(true));
  const sandboxButton = button(t("panel.sandbox"), () => on.villageLife(false));
  const errands = document.createElement("div");
  village.body.append(lifeButton, sandboxButton, errands);
  let villageKey = "";

  const agents = section(t("panel.agents"));
  const connectButton = button(t("panel.connectAgent"), () => on.connect());
  connectButton.classList.add("accent");
  const freeButton = button(t("panel.freeVillagers"), () => on.freeVillagers());
  agents.head.after(connectButton, freeButton);
  let agentsKey = "";

  const catalog = section(t("panel.catalog"));
  let catalogVersion = -1;

  const stats = document.createElement("div");
  stats.style.opacity = "0.8";
  body.append(stats);

  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSlots: { slots: SlotInfo[]; current: number } | null = null;
  let lastStatus: DevStatus | null = null;

  const renderWorlds = (slots: SlotInfo[], current: number) => {
    lastSlots = { slots, current };
    slotList.replaceChildren(
      ...slots.slice(0, SLOTS).map((w) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:2px;margin-top:2px";
        const label = document.createElement("span");
        label.style.cssText = "flex:1;min-width:0;white-space:nowrap;overflow:hidden;" +
          "text-overflow:ellipsis;" + (w.slot === current ? "color:#9fd36b" : "");
        if (w.empty) {
          label.textContent = t("panel.slotEmpty", { slot: w.slot + 1 });
          label.style.opacity = "0.5";
          row.append(label);
          return row;
        }
        // World and villager names are text, never HTML.
        label.textContent = t("panel.slotLabel", { slot: w.slot + 1, name: w.name, day: w.day });
        label.title = t("panel.slotSeed", { seed: w.seed }) +
          (w.villagers.length ? ` · ${w.villagers.join(", ")}` : ` · ${t("panel.slotNobody")}`) +
          (w.savedAt ? ` · ${t("panel.slotSaved", { date: formatDateTime(w.savedAt) })}` : "");
        const smallBtn = (text: string, title: string, f: () => void) => {
          const b = button(text, f);
          b.title = title;
          b.setAttribute("aria-label", title);
          b.classList.add("small");
          return b;
        };
        row.append(label);
        if (w.slot !== current) {
          row.append(
            smallBtn(t("panel.slotOpen"), t("panel.slotOpenTitle"), () => on.worlds.open(w.slot)),
          );
        }
        row.append(
          smallBtn("⤓", t("panel.slotExportTitle"), () => on.worlds.exportWorld(w.slot)),
        );
        if (w.slot !== current) {
          row.append(smallBtn("×", t("panel.slotDeleteTitle"), () => on.worlds.remove(w.slot)));
        }
        return row;
      }),
    );
  };

  const renderStatus = (s: DevStatus) => {
    lastStatus = s;
    qualityButtons.forEach((b, i) => {
      const id = QUALITY_BUTTONS[i];
      mark(b, id === "auto" ? s.qualityAuto : id === s.quality && !s.qualityAuto);
    });
    const qLabel = t(QUALITY_KEY[s.quality]);
    quality.head.textContent = s.qualityAuto
      ? t("panel.qualityHeadAuto", { quality: qLabel })
      : t("panel.qualityHeadFixed", { quality: qLabel });
    speedButtons.forEach((b, i) => mark(b, SPEEDS[i][1] === s.speed));
    if (!dragging) slider.value = String(s.timeOfDay);
    const minutes = Math.floor(s.timeOfDay * 24 * 60);
    const clock = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${
      String(minutes % 60).padStart(2, "0")
    }`;
    time.head.textContent = t("panel.timeHead", { day: s.day, clock });
    worlds.head.textContent = t("panel.worldsHead", { seed: s.seed });
    world.head.textContent = t("panel.worldHead", { sky: skyLabel(s.clouds) });
    world.head.title = t("panel.worldSkyTitle", { pct: Math.round(s.clouds * 100) });
    muted = s.muted;
    soundButton.textContent = muted ? t("panel.soundOff") : t("panel.soundOn");
    mark(soundButton, !muted);

    const names = s.agents.map((a) => a.name);
    if (names.join("\n") !== forKey) {
      forKey = names.join("\n");
      const was = wishFor.value;
      wishFor.replaceChildren(
        Object.assign(document.createElement("option"), {
          value: "",
          textContent: t("panel.wishAnyone"),
        }),
        // Villagers' names go in as text, never HTML.
        ...names.map((n) =>
          Object.assign(document.createElement("option"), { value: n, textContent: n })
        ),
      );
      wishFor.value = names.includes(was) ? was : "";
    }
    if (s.boardVersion !== boardVersion) {
      boardVersion = s.boardVersion;
      const openCount = s.board.filter((w) => !w.done).length;
      board.head.textContent = t("panel.boardHead", { open: openCount, max: BOARD_LIMITS.open });
      wishes.replaceChildren(
        ...[...s.board].reverse().map((w) => {
          const el = document.createElement("div");
          el.style.cssText = "margin-top:6px;opacity:" + (w.done ? ".6" : ".95");
          const head = document.createElement("div");
          const x = button("×", () => on.unpin(w.id));
          x.title = t("panel.wishUnpin");
          x.setAttribute("aria-label", t("panel.wishUnpin"));
          x.classList.add("small");
          x.style.cssText = "float:inline-end;margin-inline-start:4px";
          // Spectators' and villagers' words are text, never HTML.
          head.textContent = `#${w.id}${w.for ? ` → ${w.for}` : ""}${
            w.done ? ` ✓ ${w.done.by}` : ""
          }: ${w.text}`;
          head.prepend(x);
          el.append(head);
          w.replies.forEach((r, i) => {
            const line = document.createElement("div");
            line.style.cssText = "padding-inline-start:10px;color:#a9c48b" +
              (r.hidden ? ";opacity:.45" : "");
            const hide = button("×", () => on.hideReply(w.id, i, !r.hidden));
            hide.title = r.hidden ? t("panel.wishShow") : t("panel.wishHide");
            hide.setAttribute("aria-label", hide.title);
            hide.classList.add("small");
            hide.style.cssText = "float:inline-end;margin-inline-start:4px";
            line.textContent = `${r.by}: ${r.text}`;
            line.prepend(hide);
            el.append(line);
          });
          if (w.done?.note) {
            const line = document.createElement("div");
            line.style.cssText = "padding-inline-start:10px;color:#a9c48b";
            line.textContent = `${w.done.by}: ${w.done.note}`;
            el.append(line);
          }
          return el;
        }),
      );
      if (!s.board.length) wishes.textContent = t("panel.wishEmpty");
    }
    const linkLabel = t(LINK_KEY[s.link]);
    agents.head.textContent = t("panel.agentsHead", { link: linkLabel });
    // The bar says enough to watch by with the panel put away.
    const n = s.agents.length;
    summary.textContent = tPlural("panel.summaryOne", "panel.summaryOther", n, {
      day: s.day,
      clock,
    });
    dot.className = `dot ${LINK_DOT[s.link]}`;
    bar.setAttribute(
      "aria-label",
      t("panel.barAria", { summary: summary.textContent, link: linkLabel }),
    );

    const v = s.village;
    if (v) {
      life = v.life;
      curLife = life;
      mark(lifeButton, life);
      mark(sandboxButton, !life);
      mark(heartQuick, life);
      const levelLabel = LEVEL_KEY[v.level] ? t(LEVEL_KEY[v.level]) : v.level;
      village.head.textContent = life
        ? v.next === null
          ? t("panel.villageHead", { level: levelLabel, points: v.points })
          : t("panel.villageHeadNext", { level: levelLabel, points: v.points, next: v.next })
        : t("panel.villageSandbox");
      const key = JSON.stringify([life, v.errands]);
      if (key !== villageKey) {
        villageKey = key;
        errands.replaceChildren(
          ...(life ? v.errands : []).map((errand) => {
            const el = document.createElement("div");
            // Errands can name villagers' Designs: text, never HTML.
            el.textContent = el.title = errand;
            el.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
              "opacity:.85";
            return el;
          }),
        );
      }
    }
    // Each villager's needs, to the nearest tenth, so the buttons don't rebuild every tick.
    const needs = new Map((s.village?.needs ?? []).map(([id, f, r]) => [id, [f, r]]));
    const tenth = (val: number) => Math.round(val * 10) * 10;
    const label = (a: { id: number; name: string }) => {
      const need = needs.get(a.id);
      return need && life ? `${a.name} ${tenth(need[0])}·${tenth(need[1])}` : a.name;
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
            const need = needs.get(a.id);
            if (need && life) {
              b.title = t("panel.needsTitle", { fed: tenth(need[0]), rested: tenth(need[1]) });
            }
            mark(b, s.following === a.id);
            return b;
          })
          : [Object.assign(document.createElement("span"), { textContent: t("panel.noneYet") })]),
      );
    }
    if (s.catalog.version !== catalogVersion) {
      catalogVersion = s.catalog.version;
      const c = s.catalog;
      const mine = c.entries.filter((e) => e.author !== "nature");
      catalog.head.textContent = t("panel.catalogHead", {
        total: c.entries.length,
        byVillagers: mine.length,
      });
      // Agent-written names go in as text, never HTML.
      const line = (text: string, color = "") => {
        const el = document.createElement("div");
        el.textContent = el.title = text;
        el.style.cssText = `color:${color};white-space:nowrap;overflow:hidden;` +
          "text-overflow:ellipsis";
        return el;
      };
      const openVotes = c.proposals.filter((p) => p.status === "open");
      catalog.body.replaceChildren(
        ...mine.filter((e) => e.kind !== "relation").slice(-3).reverse().map((e) => {
          const kind = KIND_KEY[e.kind] ? t(KIND_KEY[e.kind]) : e.kind;
          return line(t("panel.catalogEntry", { kind, name: e.name, author: e.author }));
        }),
        ...openVotes.slice(0, 3).map((p) =>
          line(
            t("panel.catalogVote", {
              id: p.id,
              action: p.action,
              name: c.get(p.entry)?.name ?? "",
              by: p.by,
            }),
            "#e8c46a",
          )
        ),
        ...(openVotes.length > 3
          ? [line(t("panel.catalogMoreVotes", { count: openVotes.length - 3 }), "#e8c46a")]
          : []),
      );
      if (!catalog.body.childElementCount) catalog.body.append(line(t("panel.catalogEmpty")));
    }
    stats.textContent = s.stats.join("  ·  ");
  };

  const applyStaticLocale = () => {
    bar.title = open ? t("panel.hide") : t("panel.show");
    timeQuick.title = t("panel.dockTime");
    timeQuick.setAttribute("aria-label", t("panel.dockTime"));
    heartQuick.title = t("panel.dockLife");
    heartQuick.setAttribute("aria-label", t("panel.dockLife"));
    quality.head.textContent = t("panel.quality");
    qualityButtons.forEach((b, i) => (b.textContent = t(QUALITY_KEY[QUALITY_BUTTONS[i]])));
    time.head.textContent = t("panel.time");
    slider.setAttribute("aria-label", t("panel.timeAria"));
    speedButtons[0].textContent = t("panel.pause");
    world.head.textContent = t("panel.world");
    soundButton.textContent = muted ? t("panel.soundOff") : t("panel.soundOn");
    language.head.textContent = t("panel.language");
    populateLanguageSelect(langSelect);
    worlds.head.textContent = t("panel.worlds");
    newWorldButton.textContent = t("panel.newWorld");
    importButton.textContent = t("panel.importWorld");
    board.head.textContent = t("panel.board");
    wishText.placeholder = t("panel.wishPlaceholder");
    wishText.setAttribute("aria-label", t("panel.wishAria"));
    wishFor.setAttribute("aria-label", t("panel.wishForAria"));
    pinButton.textContent = t("panel.wishPin");
    village.head.textContent = t("panel.village");
    lifeButton.textContent = t("panel.villageLife");
    sandboxButton.textContent = t("panel.sandbox");
    agents.head.textContent = t("panel.agents");
    connectButton.textContent = t("panel.connectAgent");
    freeButton.textContent = t("panel.freeVillagers");
    freeButton.title = t("panel.freeVillagersTitle");
    catalog.head.textContent = t("panel.catalog");
    if (!lastStatus) summary.textContent = t("panel.spectator");
  };
  applyStaticLocale();
  onLocaleChange(() => {
    applyStaticLocale();
    forKey = null;
    boardVersion = -1;
    villageKey = "";
    agentsKey = "";
    catalogVersion = -1;
    if (lastSlots) renderWorlds(lastSlots.slots, lastSlots.current);
    if (lastStatus) renderStatus(lastStatus);
  });

  return {
    /** Something the spectator should know about worlds: a full slot list, a failed import. */
    notice(text: string) {
      note.textContent = text;
      note.style.display = "";
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => (note.style.display = "none"), 15_000);
    },
    /** The world slots, as the worker last listed them. */
    worlds: renderWorlds,
    /** Refresh readouts; call a few times a second, not every frame. */
    update: renderStatus,
  };
}
