import { LOOKS } from "./render/look.ts";

export interface DevHandlers {
  look: (id: string) => void;
  time: (t: number) => void;
  speed: (s: number) => void;
  seed: (seed: number) => void;
  follow: (agentId: number | null) => void;
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
  stats: string[];
}

const BUTTON = "margin:2px 4px 0 0;padding:2px 8px;border-radius:6px;border:1px solid #445;" +
  "background:#1a2029;color:inherit;font:inherit;cursor:pointer";
const SPEEDS: [string, number][] = [["pause", 0], ["1×", 1], ["10×", 10], ["60×", 60]];

/** Spectator/dev controls. Plain DOM, rebuilt only when its inputs change. */
export function createDevPanel(on: DevHandlers) {
  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;top:12px;right:12px;padding:12px 14px;background:rgba(10,14,18,.72);" +
    "backdrop-filter:blur(6px);border-radius:10px;font:12px/1.5 ui-monospace,monospace;" +
    "color:#d8dee9;display:grid;gap:8px;width:250px;user-select:none";
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
  world.body.append(seedButton);

  const agents = section("agents");
  let agentsKey = "";

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
      agents.head.textContent = `agents · bridge ${s.bridge ? "connected" : "offline"}`;

      const key = JSON.stringify([s.agents, s.following]);
      if (key !== agentsKey) {
        agentsKey = key;
        agents.body.replaceChildren(
          ...(s.agents.length
            ? s.agents.map((a) => {
              const b = button(a.name, () => on.follow(s.following === a.id ? null : a.id));
              mark(b, s.following === a.id);
              return b;
            })
            : [Object.assign(document.createElement("span"), { textContent: "none yet" })]),
        );
      }
      stats.textContent = s.stats.join("  ·  ");
    },
  };
}
