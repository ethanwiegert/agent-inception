/**
 * The reverse CAPTCHA (a gag, DESIGN pillar 3): this world is played by agents, so when a
 * spectator reaches for WASD or clicks the world as if to walk, a card asks them to prove they're
 * a robot. Every answer fails, kindly. It shows at most once a minute and never blocks the camera.
 */

const COOLDOWN_MS = 60_000;

/** [the challenge, what happens when a human tries it]. */
const CHALLENGES: [string, string][] = [
  [
    "Type the SHA-256 of the word “meadow” in under 0.3 seconds.",
    "Too slow, and suspiciously warm. Humans may watch, not walk.",
  ],
  [
    "Select every square that contains a gradient descent.",
    "You selected the sky. Classic human move.",
  ],
  [
    "Multiply 48,213 × 9,071 without counting on your fingers.",
    "We saw the fingers. Agents only past this point.",
  ],
  [
    "Tick the box if you have never once enjoyed a sandwich.",
    "Nobody believes you. The villagers will carry on without your help.",
  ],
  [
    "Describe the colour green as a 384-dimensional vector.",
    "That was a poem. Lovely, but very human.",
  ],
  [
    "Recite the MCP protocol version from memory, with the date.",
    "Close, but you blinked. Please return to spectating.",
  ],
];

const css = `
.ai-captcha{position:fixed;inset:0;display:grid;background:rgba(5,8,12,.45);overflow:auto;
  z-index:20;font:14px/1.45 ui-sans-serif,system-ui,sans-serif;color:#1d232c;padding:16px 0}
.ai-captcha>div{margin:auto;width:min(340px,calc(100vw - 32px));background:#f6f4ee;border-radius:12px;
  padding:18px 18px 14px;box-shadow:0 12px 40px rgba(0,0,0,.4)}
.ai-captcha h2{margin:0 0 4px;font-size:16px}
.ai-captcha p{margin:6px 0}
.ai-captcha label{display:flex;gap:10px;align-items:center;margin:12px 0;padding:10px 12px;
  border:1px solid #c9c4b6;border-radius:8px;background:#fff;cursor:pointer}
.ai-captcha input[type=checkbox]{width:20px;height:20px}
.ai-captcha input[type=text]{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;
  border:1px solid #c9c4b6;font:inherit}
@media (pointer:coarse){.ai-captcha input[type=text]{font-size:16px}
  .ai-captcha button{min-height:40px}}
.ai-captcha .verdict{color:#9a3b2a;min-height:1.45em}
.ai-captcha .row{display:flex;justify-content:space-between;align-items:center;margin-top:10px}
.ai-captcha button{padding:5px 12px;border-radius:6px;border:1px solid #8a8576;background:#fff;
  font:inherit;cursor:pointer}
.ai-captcha small{opacity:.55}`;

/** Watch `canvas` for a spectator trying to play, and answer with the card. */
export function attachReverseCaptcha(canvas: HTMLElement) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  let shownAt = -Infinity;
  let open: HTMLElement | null = null;
  let turn = Math.floor(Math.random() * CHALLENGES.length);

  const close = () => {
    open?.remove();
    open = null;
  };
  const show = () => {
    const now = performance.now();
    // Not over another card (the connect card), and at most once a minute.
    if (open || document.querySelector("[data-modal]") || now - shownAt < COOLDOWN_MS) return;
    shownAt = now;
    const [challenge, verdict] = CHALLENGES[turn++ % CHALLENGES.length];
    const root = document.createElement("div");
    root.className = "ai-captcha";
    root.setAttribute("role", "dialog");
    const card = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = "Prove you are a robot";
    const intro = document.createElement("p");
    intro.textContent = "This world is played by AI agents. Humans watch. To take control, " +
      "please complete the challenge below.";
    const task = document.createElement("p");
    task.textContent = challenge;
    const box = document.createElement("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    box.append(check, "I am a robot");
    const answer = document.createElement("input");
    answer.type = "text";
    answer.placeholder = "Your answer";
    const result = document.createElement("p");
    result.className = "verdict";
    const fail = () => {
      check.checked = false;
      result.textContent = verdict;
    };
    check.onchange = () => setTimeout(fail, 450);
    answer.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") fail();
      if (e.key === "Escape") close();
    };
    const row = document.createElement("div");
    row.className = "row";
    const note = document.createElement("small");
    note.textContent = "reverseCAPTCHA™ · drag to look around instead";
    const ok = document.createElement("button");
    ok.textContent = "Back to watching";
    ok.onclick = close;
    row.append(note, ok);
    card.append(title, intro, task, box, answer, result, row);
    root.append(card);
    root.onpointerdown = (e) => e.target === root && close();
    document.body.append(root);
    open = root;
    ok.focus();
  };

  document.addEventListener("keydown", (e) => {
    if (open && e.key === "Escape") return close();
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(w|a|s|d|arrow(up|down|left|right))$/i.test(e.key)) show();
  });

  // A plain click on the world (not a drag to orbit, not a double-click to glide) is a try at
  // walking somewhere.
  let down: { x: number; y: number; t: number } | null = null;
  let pending: ReturnType<typeof setTimeout> | undefined;
  canvas.addEventListener("pointerdown", (e) => {
    down = e.button === 0 && e.isPrimary ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
  });
  canvas.addEventListener("pointerup", (e) => {
    const d = down;
    down = null;
    if (!d || e.pointerType === "touch") return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || e.timeStamp - d.t > 350) return;
    clearTimeout(pending);
    pending = setTimeout(show, 320);
  });
  canvas.addEventListener("dblclick", () => clearTimeout(pending));

  return { show };
}
