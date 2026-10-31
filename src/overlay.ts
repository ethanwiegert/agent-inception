import type { Mat4 } from "./math.ts";
import type { AgentView } from "./simclient.ts";

interface Tag {
  root: HTMLDivElement;
  name: HTMLDivElement;
  bubble: HTMLDivElement;
  until: number;
}

const css = `
.ai-tag{position:fixed;left:0;top:0;pointer-events:none;display:flex;flex-direction:column;
  align-items:center;gap:4px;transform-origin:50% 100%;will-change:transform}
.ai-name{font:600 11px/1 ui-sans-serif,system-ui;color:#fff;background:rgba(10,14,18,.55);
  padding:3px 7px;border-radius:999px;white-space:nowrap;pointer-events:auto;cursor:pointer;
  border:1px solid transparent;transition:background .15s,border-color .15s;
  -webkit-tap-highlight-color:transparent;touch-action:manipulation}
@media (hover:hover){.ai-name:hover{background:rgba(10,14,18,.8)}}
.ai-name.followed{border-color:#9fd36b;background:rgba(20,40,16,.8)}
.ai-bubble{max-width:min(220px,60vw);font:13px/1.35 ui-sans-serif,system-ui;color:#1a1d21;background:#fdfbf4;
  padding:7px 10px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.25);opacity:0;
  transition:opacity .3s;text-align:center}
.ai-feed{position:fixed;left:calc(12px + env(safe-area-inset-left));
  bottom:calc(12px + env(safe-area-inset-bottom));width:min(360px,calc(100vw - 24px));
  max-height:40vh;overflow:hidden;
  display:flex;flex-direction:column-reverse;gap:3px;font:12px/1.4 ui-monospace,monospace;
  pointer-events:none;mask-image:linear-gradient(to top,#000 70%,transparent)}
.ai-feed div{background:rgba(10,14,18,.6);color:#d8dee9;padding:3px 8px;border-radius:6px}
.ai-feed b{color:#9fd36b;font-weight:600}
.ai-feed .err{color:#e58b7a}
.ai-feed i{color:#8a94a3;font-style:normal}
/* Fingers: name tags big enough to tap. */
@media (pointer:coarse){.ai-name{font-size:12px;padding:7px 11px}}
/* Narrow screens: the feed sits above the camera buttons, shorter, in smaller type. */
@media (max-width:640px){.ai-feed{bottom:calc(66px + env(safe-area-inset-bottom));
  max-height:24vh;font-size:11px}.ai-bubble{font-size:12px}}
`;

/** Name tags float this far above a villager's feet. */
export const TAG_HEIGHT = 2.3;
const at: [number, number] = [0, 0];

/**
 * Project a world point to pixels of a `width` × `height` view into `out`. False when the point
 * is behind the camera.
 */
export function project(
  m: Mat4,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  out: [number, number],
): boolean {
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (cw <= 0) return false;
  out[0] = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw * 0.5 + 0.5) * width;
  out[1] = (0.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw * 0.5) * height;
  return true;
}

/** DOM layer over the canvas: name tags, speech bubbles and an activity feed for spectators. */
export class Overlay {
  private tags = new Map<number, Tag>();
  private feed: HTMLDivElement;

  /** `onSelect` fires when a spectator clicks an agent's name tag. */
  constructor(private onSelect: (agentId: number) => void) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    this.feed = document.createElement("div");
    this.feed.className = "ai-feed";
    document.body.append(this.feed);
  }

  say(agentId: number, text: string, now: number) {
    const tag = this.tags.get(agentId);
    if (!tag) return;
    tag.bubble.textContent = text;
    tag.bubble.style.opacity = "1";
    tag.until = now + 5000 + text.length * 60;
  }

  log(who: string, text: string, isError = false) {
    // A repeat of the newest line (a chatty timer Rule, say) bumps its count instead.
    const last = this.feed.firstElementChild as HTMLDivElement | null;
    const key = `${who}\u0000${text}\u0000${isError}`;
    if (last?.dataset.key === key) {
      const n = Number(last.dataset.count ?? 1) + 1;
      last.dataset.count = String(n);
      last.querySelector("i")!.textContent = ` ×${n}`;
      return;
    }
    const line = document.createElement("div");
    line.dataset.key = key;
    const name = document.createElement("b");
    name.textContent = who;
    const body = document.createElement("span");
    body.textContent = " " + text;
    if (isError) body.className = "err";
    line.append(name, body, document.createElement("i"));
    this.feed.prepend(line);
    while (this.feed.childElementCount > 30) this.feed.lastElementChild!.remove();
  }

  /** Place tags over heads. `width`/`height` are CSS pixels of the canvas. */
  update(
    agents: AgentView[],
    viewProj: Mat4,
    width: number,
    height: number,
    now: number,
    followed: number | null,
  ) {
    const seen = new Set<number>();
    for (const a of agents) {
      seen.add(a.id);
      let tag = this.tags.get(a.id);
      if (!tag) tag = this.createTag(a);
      tag.name.classList.toggle("followed", a.id === followed);
      if (!project(viewProj, a.x, a.y + TAG_HEIGHT, a.z, width, height, at)) {
        tag.root.style.display = "none";
        continue;
      }
      tag.root.style.display = "";
      tag.root.style.transform = `translate(${at[0]}px, ${at[1]}px) translate(-50%, -100%)`;
      if (tag.until && now > tag.until) {
        tag.bubble.style.opacity = "0";
        tag.until = 0;
      }
    }
    for (const [id, tag] of this.tags) {
      if (!seen.has(id)) {
        tag.root.remove();
        this.tags.delete(id);
      }
    }
  }

  private createTag(a: AgentView): Tag {
    const root = document.createElement("div");
    root.className = "ai-tag";
    const bubble = document.createElement("div");
    bubble.className = "ai-bubble";
    const name = document.createElement("div");
    name.className = "ai-name";
    name.textContent = a.name;
    name.title = `Follow ${a.name}`;
    name.onclick = () => this.onSelect(a.id);
    root.append(bubble, name);
    document.body.append(root);
    const tag = { root, name, bubble, until: 0 };
    this.tags.set(a.id, tag);
    return tag;
  }
}
