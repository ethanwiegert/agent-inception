import { LOOKS } from "./render/look.ts";

export interface DevState {
  look: string;
  timeOfDay: number;
  /** Game days per real minute. */
  daySpeed: number;
  seed: number;
}

/** Workshop controls. Plain DOM, no framework. */
export function createDevPanel(state: DevState, onSeed: (seed: number) => void) {
  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;top:12px;right:12px;padding:12px 14px;background:rgba(10,14,18,.72);" +
    "backdrop-filter:blur(6px);border-radius:10px;font:12px/1.5 ui-monospace,monospace;" +
    "color:#d8dee9;display:grid;gap:8px;min-width:230px;user-select:none";
  document.body.append(panel);

  const row = (label: string) => {
    const el = document.createElement("div");
    el.innerHTML = `<div style="opacity:.6">${label}</div>`;
    panel.append(el);
    return el;
  };

  const looks = row("look");
  const buttons = Object.entries(LOOKS).map(([id, look]) => {
    const b = document.createElement("button");
    b.textContent = look.name;
    b.style.cssText =
      "margin:2px 4px 0 0;padding:3px 8px;border-radius:6px;border:1px solid #445;" +
      "background:#1a2029;color:inherit;font:inherit;cursor:pointer";
    b.onclick = () => {
      state.look = id;
      highlight();
    };
    looks.append(b);
    return [id, b] as const;
  });
  const highlight = () =>
    buttons.forEach(([id, b]) => (b.style.borderColor = id === state.look ? "#9fd36b" : "#445"));
  highlight();

  const timeRow = row("time of day");
  const time = document.createElement("input");
  time.type = "range";
  time.min = "0";
  time.max = "1";
  time.step = "0.001";
  time.style.width = "100%";
  time.oninput = () => (state.timeOfDay = Number(time.value));
  const clock = document.createElement("span");
  timeRow.append(time, clock);

  const speedRow = row("day speed");
  const speeds: [string, number][] = [["paused", 0], ["1 day / 10 min", 0.1], ["1 day / min", 1], [
    "fast",
    6,
  ]];
  for (const [label, speed] of speeds) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "margin:2px 4px 0 0;padding:2px 6px;border-radius:6px;border:1px solid #445;" +
      "background:#1a2029;color:inherit;font:inherit;cursor:pointer";
    b.onclick = () => (state.daySpeed = speed);
    speedRow.append(b);
  }

  const seedRow = row(`world seed`);
  const seed = document.createElement("button");
  seed.style.cssText =
    "padding:2px 8px;border-radius:6px;border:1px solid #445;background:#1a2029;" +
    "color:inherit;font:inherit;cursor:pointer";
  const showSeed = () => (seed.textContent = `${state.seed} — new`);
  seed.onclick = () => {
    state.seed = (Math.random() * 1e6) | 0;
    showSeed();
    onSeed(state.seed);
  };
  showSeed();
  seedRow.append(seed);

  const stats = document.createElement("div");
  stats.style.opacity = "0.8";
  panel.append(stats);

  return {
    /** Refresh readouts; call a few times a second, not every frame. */
    update(lines: string[]) {
      time.value = String(state.timeOfDay);
      const minutes = Math.floor(state.timeOfDay * 24 * 60);
      clock.textContent = ` ${String(Math.floor(minutes / 60)).padStart(2, "0")}:${
        String(minutes % 60).padStart(2, "0")
      }`;
      stats.textContent = lines.join("  ·  ");
    },
  };
}
