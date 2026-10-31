/**
 * The corner links: the source on GitHub, and a small Support button that opens a note with a
 * Ko-fi link. Top left, clear of the panel (top right), the feed (bottom left) and the camera
 * buttons (bottom right); under the connect card and the CAPTCHA gag, so those stay modal.
 */

export const GITHUB_URL = "https://github.com/ethanwiegert/agent-inception";
export const KOFI_URL = "https://ko-fi.com/ethanwiegert";

/** Octicons `mark-github-16` (MIT, GitHub Inc.). */
const GITHUB_MARK = "M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 " +
  "0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15" +
  ".08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03" +
  "-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95" +
  "-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34" +
  ".19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 " +
  "0 8c0-4.42 3.58-8 8-8Z";

const NOTE = "Tips go straight to me, Ethan, the solo dev behind this island. No catch: it's a " +
  "thank-you, and I'll use it as I see fit.";

const css = `
.ai-support{position:fixed;left:calc(12px + env(safe-area-inset-left));
  top:calc(12px + env(safe-area-inset-top));z-index:18;display:flex;gap:6px;align-items:center;
  font:600 13px/1 ui-sans-serif,system-ui,sans-serif;user-select:none}
.ai-support>a,.ai-support>button{height:32px;min-width:32px;box-sizing:border-box;
  border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(10,14,18,.55);
  color:#fff;cursor:pointer;font:inherit;padding:0 12px;display:inline-flex;align-items:center;
  justify-content:center;gap:6px;text-decoration:none;-webkit-tap-highlight-color:transparent}
.ai-support>a{padding:0}
@media (hover:hover){.ai-support>a:hover,.ai-support>button:hover{background:rgba(10,14,18,.8)}}
.ai-support>button[aria-expanded="true"]{border-color:#9fd36b;background:rgba(20,40,16,.8)}
.ai-support a:focus-visible,.ai-support button:focus-visible{outline:2px solid #9fd36b;
  outline-offset:2px}
.ai-support svg{width:18px;height:18px;fill:currentColor}
.ai-support .heart{color:#e58b7a}
.ai-support-pop{position:absolute;left:0;top:40px;width:min(260px,calc(100vw - 24px));
  box-sizing:border-box;background:#fdfbf4;color:#1d232c;border-radius:12px;padding:12px 14px;
  box-shadow:0 6px 24px rgba(0,0,0,.35);font:13px/1.45 ui-sans-serif,system-ui,sans-serif;
  user-select:text}
.ai-support-pop p{margin:0 0 10px}
.ai-support-pop a{display:block;text-align:center;padding:7px 12px;border-radius:8px;
  background:#2f5d3a;color:#fff;text-decoration:none;font-weight:600}
.ai-support-pop a:hover{background:#3a7048}
.ai-support-pop small{display:block;margin-top:6px;text-align:center;color:#6b6556;font-size:11px}
@media (pointer:coarse){.ai-support>a,.ai-support>button{height:40px;min-width:40px}
  .ai-support-pop{top:48px}.ai-support-pop a{padding:11px 12px}}
@media (max-width:520px){.ai-support .label{display:none}.ai-support>button{padding:0}}`;

/** Mount the GitHub link and the Support button. Returns the root, for tests and teardown. */
export function createSupportLinks() {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);

  const root = document.createElement("div");
  root.className = "ai-support";

  const external = (a: HTMLAnchorElement, href: string) => {
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  };

  const gh = external(document.createElement("a"), GITHUB_URL);
  gh.title = "Source on GitHub";
  gh.setAttribute("aria-label", "agent-inception on GitHub");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", GITHUB_MARK);
  svg.append(path);
  gh.append(svg);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.title = "Support the dev";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "ai-support-pop");
  const heart = Object.assign(document.createElement("span"), {
    className: "heart",
    textContent: "♥",
  });
  heart.setAttribute("aria-hidden", "true");
  const label = Object.assign(document.createElement("span"), {
    className: "label",
    textContent: "Support",
  });
  toggle.append(heart, label);
  toggle.setAttribute("aria-label", "Support");

  const pop = document.createElement("div");
  pop.id = "ai-support-pop";
  pop.className = "ai-support-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Support the dev");
  pop.hidden = true;
  const note = Object.assign(document.createElement("p"), { textContent: NOTE });
  const kofi = external(document.createElement("a"), KOFI_URL);
  kofi.textContent = "Click here to support me";
  const where = Object.assign(document.createElement("small"), {
    textContent: "on Ko-fi · opens in a new tab",
  });
  pop.append(note, kofi, where);

  let open = false;
  const set = (on: boolean) => {
    open = on;
    pop.hidden = !on;
    toggle.setAttribute("aria-expanded", String(on));
  };
  toggle.onclick = () => {
    set(!open);
    if (open) kofi.focus();
  };
  kofi.onclick = () => set(false);
  root.onkeydown = (e) => {
    if (e.key !== "Escape" || !open) return;
    set(false);
    toggle.focus();
  };
  // A press anywhere else (the world, the panel) closes it.
  addEventListener("pointerdown", (e) => {
    if (open && !root.contains(e.target as Node)) set(false);
  }, true);

  root.append(gh, toggle, pop);
  document.body.append(root);
  return root;
}
