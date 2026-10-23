import type { Mat4 } from "./math.ts";
import type { AgentView } from "./simclient.ts";

interface Tag {
  root: HTMLDivElement;
  bubble: HTMLDivElement;
  until: number;
}

const css = `
.ai-tag{position:fixed;left:0;top:0;pointer-events:none;display:flex;flex-direction:column;
  align-items:center;gap:4px;transform-origin:50% 100%;will-change:transform}
.ai-name{font:600 11px/1 ui-sans-serif,system-ui;color:#fff;background:rgba(10,14,18,.55);
  padding:3px 7px;border-radius:999px;white-space:nowrap}
.ai-bubble{max-width:220px;font:13px/1.35 ui-sans-serif,system-ui;color:#1a1d21;background:#fdfbf4;
  padding:7px 10px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.25);opacity:0;
  transition:opacity .3s;text-align:center}
.ai-feed{position:fixed;left:12px;bottom:12px;width:360px;max-height:40vh;overflow:hidden;
  display:flex;flex-direction:column-reverse;gap:3px;font:12px/1.4 ui-monospace,monospace;
  pointer-events:none;mask-image:linear-gradient(to top,#000 70%,transparent)}
.ai-feed div{background:rgba(10,14,18,.6);color:#d8dee9;padding:3px 8px;border-radius:6px}
.ai-feed b{color:#9fd36b;font-weight:600}
.ai-feed .err{color:#e58b7a}
`;

/** DOM layer over the canvas: name tags, speech bubbles and an activity feed for spectators. */
export class Overlay {
  private tags = new Map<number, Tag>();
  private feed: HTMLDivElement;

  constructor() {
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
    const line = document.createElement("div");
    const name = document.createElement("b");
    name.textContent = who;
    const body = document.createElement("span");
    body.textContent = " " + text;
    if (isError) body.className = "err";
    line.append(name, body);
    this.feed.prepend(line);
    while (this.feed.childElementCount > 30) this.feed.lastElementChild!.remove();
  }

  /** Place tags over heads. `width`/`height` are CSS pixels of the canvas. */
  update(agents: AgentView[], viewProj: Mat4, width: number, height: number, now: number) {
    const seen = new Set<number>();
    for (const a of agents) {
      seen.add(a.id);
      let tag = this.tags.get(a.id);
      if (!tag) tag = this.createTag(a);
      const m = viewProj, x = a.x, y = a.y + 2.3, z = a.z;
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw <= 0) {
        tag.root.style.display = "none";
        continue;
      }
      const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
      const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
      const px = (cx * 0.5 + 0.5) * width, py = (0.5 - cy * 0.5) * height;
      tag.root.style.display = "";
      tag.root.style.transform = `translate(${px}px, ${py}px) translate(-50%, -100%)`;
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
    root.append(bubble, name);
    document.body.append(root);
    const tag = { root, bubble, until: 0 };
    this.tags.set(a.id, tag);
    return tag;
  }
}
