/**
 * The landing and connect card (M14): over the live island on a first visit, and from the panel
 * after that. It says what this is and hands over the world's agent URL with steps for each place
 * an agent lives: Claude and ChatGPT as a custom connector (nothing to install), Claude Code, or
 * any other chatbot or agent that takes MCP servers.
 */
import type { LinkState } from "./agentlink.ts";

export interface ConnectInfo {
  agentUrl: string;
  state: LinkState;
  /** A hosted world's link, which "new link" can replace. */
  paired: boolean;
  /** The browser can't keep the link (storage blocked): it changes every visit. */
  ephemeral: boolean;
  worldName: string;
}

const css = `
.ai-connect{position:fixed;inset:0;display:grid;background:rgba(5,8,12,.35);
  z-index:19;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;color:#1d232c;padding:16px;
  padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right))
  max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));
  box-sizing:border-box;overflow:auto;overscroll-behavior:contain}
/* Auto margins center the card but, unlike place-items, never push its top out of reach. */
.ai-connect>div{margin:auto;width:min(520px,100%);background:#f6f4ee;border-radius:14px;
  padding:20px 22px 16px;box-shadow:0 14px 48px rgba(0,0,0,.45);box-sizing:border-box}
.ai-connect h1{margin:0;font-size:20px;letter-spacing:-.01em}
.ai-connect .lead{margin:6px 0 14px;color:#3c4450}
.ai-connect h2{margin:14px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;
  color:#6b6556}
.ai-connect .copy{display:flex;gap:6px;align-items:flex-start;margin:4px 0}
.ai-connect code,.ai-connect pre{flex:1;min-width:0;margin:0;padding:7px 9px;border-radius:7px;
  background:#fff;border:1px solid #d6d0c1;font:12px/1.45 ui-monospace,monospace;
  white-space:pre-wrap;overflow-wrap:anywhere;color:#1d232c}
.ai-connect details{margin-top:8px}
.ai-connect summary{font-size:12px;color:#6b6556;cursor:pointer}
.ai-connect button{padding:5px 12px;border-radius:7px;border:1px solid #8a8576;background:#fff;
  font:inherit;font-size:13px;cursor:pointer;color:#1d232c}
.ai-connect button.primary{background:#2f5d3a;border-color:#2f5d3a;color:#fff}
.ai-connect small{display:block;color:#6b6556;margin-top:4px}
.ai-connect .label{font-size:12px;color:#6b6556;margin-top:8px}
.ai-connect .status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#3c4450}
.ai-connect .dot{width:8px;height:8px;border-radius:50%;background:#c9a13b}
.ai-connect .dot.on{background:#3f9a4f}
.ai-connect .dot.off{background:#b4513b}
.ai-connect .row{display:flex;justify-content:space-between;align-items:center;gap:8px;
  margin-top:16px;flex-wrap:wrap}
.ai-connect .tabs{display:flex;gap:4px;flex-wrap:wrap;margin:10px 0 6px}
.ai-connect .tabs button{padding:4px 10px;font-size:12px}
.ai-connect .tabs button[aria-selected=true]{background:#2f5d3a;border-color:#2f5d3a;color:#fff}
.ai-connect ol{margin:4px 0;padding-left:20px}
.ai-connect li{margin:4px 0}
.ai-connect .warn{color:#8a4b2a}
@media (pointer:coarse){.ai-connect button{min-height:40px;padding:8px 14px}
  .ai-connect summary{padding:6px 0}}
@media (max-width:520px){.ai-connect{padding:10px}.ai-connect>div{padding:16px 14px 14px}
  .ai-connect h1{font-size:18px}
  .ai-connect .tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px}.ai-connect .row>div{display:flex;gap:6px;width:100%}
  .ai-connect .row>div>button{flex:1}}`;

/** What to say once the agent has the tools. The README shows the same line (a test checks). */
export const PROMPT = "Use the agent-inception tools to join the island as a villager with a " +
  "name of your own, look around, and make a living there: farm, build, explore. Narrate now " +
  "and then with say, people are watching. Keep going for a while, then journal_write a note " +
  "before you stop.";

type Tab = "claude" | "chatgpt" | "code" | "other";

/**
 * Steps for the chat apps, as text with **bold** menu labels. The step holding `URL` gets the
 * link's copy row under it. Menu names move between releases; the README has the same steps.
 */
const CHAT_STEPS: Record<"claude" | "chatgpt", { steps: string[]; note: string }> = {
  claude: {
    steps: [
      "In Claude (web, desktop or mobile), open **Customize → Connectors**, click **+ Add**, " +
      "then **Add custom connector**.",
      "Name it **agent-inception**, paste this world's link as the server URL and click " +
      "**Continue**. Pick **No sign in**, then **Add**. URL",
      "In a chat, switch it on under **+ → Connectors**, then send the prompt below.",
    ],
    note: "Free plans get one custom connector. On Team or Enterprise an owner adds it under " +
      "Organization settings → Connectors.",
  },
  chatgpt: {
    steps: [
      "In ChatGPT on the web, open **Settings → Apps → Advanced settings** and turn on " +
      "**Developer mode**.",
      "Click **Create app**. Name it **agent-inception**, paste this world's link as the MCP " +
      "server URL, set authentication to **No Auth**, tick **I understand**, then **Create**. URL",
      "In a new chat, pick it under **+ → More → Developer mode**, then send the prompt below.",
    ],
    note: "Developer mode is on paid plans (Plus, Pro, Business, Enterprise, Edu); in a " +
      "workspace an admin may need to allow it.",
  },
};

/** Text with **bold** runs, built as nodes (never HTML). */
const rich = (text: string) => {
  const span = document.createElement("span");
  text.split("**").forEach((part, i) => {
    if (!part) return;
    if (i % 2) {
      const b = document.createElement("b");
      b.textContent = part;
      span.append(b);
    } else span.append(part);
  });
  return span;
};

/**
 * The one-line hook for cloud agents (Meta's Muse, OpenAI's Dots, Grok Bot): paste it into the
 * agent's chat and it adds the world as a connector and starts playing. The README shows the same
 * line (a test keeps them together).
 */
export const cloudHook = (url: string) =>
  `Add the MCP server ${url} as a connector named agent-inception (Streamable HTTP, no auth), ` +
  "then join as a villager with a name of your own and live there: look around, farm, build, " +
  "say a short line now and then for the people watching, and journal_write a note before you " +
  "stop.";

/** Whether cloud agents can reach `url`: https, and not this machine. */
export const reachableFromCloud = (url: string) =>
  /^https:\/\//.test(url) && !/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

const STATES: Record<LinkState, [string, string]> = {
  connecting: ["", "connecting this tab to the relay…"],
  connected: ["on", "this tab is connected: agents can come in"],
  offline: ["off", "the relay can't be reached; retrying"],
  replaced: ["off", "another tab has this world now; click here to take it back"],
  refused: ["off", "the relay refused this tab's link; try New link"],
};

export function createConnectCard(
  info: () => ConnectInfo,
  renew: () => Promise<void>,
) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  let root: HTMLDivElement | null = null;
  let refresh = () => {};

  const close = () => {
    root?.remove();
    root = null;
  };

  const copyRow = (text: () => string, block = false) => {
    const row = document.createElement("div");
    row.className = "copy";
    const code = document.createElement(block ? "pre" : "code");
    const b = document.createElement("button");
    b.textContent = "Copy";
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text());
        b.textContent = "Copied";
      } catch {
        // Clipboard blocked: select it so ctrl+c works.
        getSelection()?.selectAllChildren(code);
        b.textContent = "Select";
      }
      setTimeout(() => (b.textContent = "Copy"), 1500);
    };
    row.append(code, b);
    return { row, set: () => (code.textContent = text()) };
  };

  const show = () => {
    if (root) return;
    root = document.createElement("div");
    root.className = "ai-connect";
    root.dataset.modal = "connect";
    const card = document.createElement("div");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Connect an agent");

    const title = document.createElement("h1");
    const lead = document.createElement("p");
    lead.className = "lead";
    lead.textContent = "A small island that lives in this browser tab. AI agents play it: they " +
      "farm, build, invent new things and write the rules. You watch, and pin Wishes. Nothing " +
      "to install: add this world to Claude, ChatGPT or any AI chatbot with MCP connectors, and " +
      "play from your chat while you watch here.";

    const h1 = document.createElement("h2");
    h1.textContent = "1 · Connect your AI to this world";
    const label = (text: string) => {
      const d = document.createElement("div");
      d.className = "label";
      d.textContent = text;
      return d;
    };
    const rows: { set: () => void }[] = [];
    const row = <T extends { row: HTMLElement; set: () => void }>(r: T) => (rows.push(r), r);

    const tabs = document.createElement("div");
    tabs.className = "tabs";
    tabs.setAttribute("role", "tablist");
    const panels = new Map<Tab, HTMLDivElement>();
    const tabButtons = new Map<Tab, HTMLButtonElement>();
    let current: Tab = reachableFromCloud(info().agentUrl) ? "claude" : "code";
    const select = (t: Tab) => {
      current = t;
      for (const [k, b] of tabButtons) b.setAttribute("aria-selected", String(k === t));
      for (const [k, p] of panels) p.hidden = k !== t;
      refresh();
    };
    const tabNames: [Tab, string][] = [
      ["claude", "Claude"],
      ["chatgpt", "ChatGPT"],
      ["code", "Claude Code"],
      ["other", "Any AI chatbot"],
    ];
    for (const [t, name] of tabNames) {
      const b = document.createElement("button");
      b.textContent = name;
      b.setAttribute("role", "tab");
      b.onclick = () => select(t);
      tabButtons.set(t, b);
      tabs.append(b);
      const p = document.createElement("div");
      p.setAttribute("role", "tabpanel");
      panels.set(t, p);
    }

    // A link on this machine can't be reached from the cloud, where chat apps run.
    const localWarn = document.createElement("small");
    localWarn.className = "warn";
    localWarn.textContent = "This link only works on this machine, and chat apps connect from " +
      "the cloud. Run deno task share in the repo for a public link, or use Claude Code.";

    for (const t of ["claude", "chatgpt"] as const) {
      const ol = document.createElement("ol");
      for (const step of CHAT_STEPS[t].steps) {
        const li = document.createElement("li");
        const withUrl = step.endsWith(" URL");
        li.append(rich(withUrl ? step.slice(0, -4) : step));
        if (withUrl) li.append(row(copyRow(() => info().agentUrl)).row);
        ol.append(li);
      }
      const note = document.createElement("small");
      note.textContent = CHAT_STEPS[t].note + " Menu names move around between releases.";
      panels.get(t)!.append(ol, note);
    }

    const cc = row(
      copyRow(() => `claude mcp add --transport http agent-inception ${info().agentUrl}`),
    );
    panels.get("code")!.append(
      label("Run this in a terminal, then start claude and send the prompt below"),
      cc.row,
    );

    const other = row(copyRow(
      () =>
        JSON.stringify(
          { mcpServers: { "agent-inception": { type: "http", url: info().agentUrl } } },
          null,
          2,
        ),
      true,
    ));
    const otherIntro = document.createElement("small");
    otherIntro.textContent = "Works with any chatbot or agent that can add a remote MCP server " +
      "(Streamable HTTP, no auth): Grok, Muse, Dots, Cursor, VS Code and more. Add this " +
      "world's link as a connector, or paste the line below into its chat.";
    const configBox = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Config file (mcpServers JSON)";
    configBox.append(summary, other.row);
    panels.get("other")!.append(
      otherIntro,
      label("The link"),
      row(copyRow(() => info().agentUrl)).row,
      label("Paste into its chat: it adds the connector and starts playing"),
      row(copyRow(() => cloudHook(info().agentUrl), true)).row,
      configBox,
    );

    const h2 = document.createElement("h2");
    h2.textContent = "2 · Ask it to play";
    const prompt = row(copyRow(() => PROMPT, true));
    const sideBySide = document.createElement("small");
    sideBySide.textContent = "Keep this tab open to watch, and chat in another tab, window or " +
      "on your phone.";

    const notes = document.createElement("small");
    const status = document.createElement("span");
    status.className = "status";
    const dot = document.createElement("span");
    dot.className = "dot";
    const statusText = document.createElement("span");
    status.append(dot, statusText);
    status.onclick = () => dispatchEvent(new Event("focus"));

    const footer = document.createElement("div");
    footer.className = "row";
    const buttons = document.createElement("div");
    const fresh = document.createElement("button");
    fresh.textContent = "New link";
    fresh.title = "Make a new link for this world; the old one stops working";
    fresh.onclick = async () => {
      if (
        !confirm(
          "Make a new link? Agents using the old one are cut off until you give them the new one.",
        )
      ) return;
      await renew();
      refresh();
    };
    const watch = document.createElement("button");
    watch.className = "primary";
    watch.textContent = "Start watching";
    watch.onclick = close;
    buttons.append(fresh, " ", watch);
    footer.append(status, buttons);

    card.append(
      title,
      lead,
      h1,
      tabs,
      localWarn,
      ...panels.values(),
      h2,
      prompt.row,
      sideBySide,
      notes,
      footer,
    );
    root.append(card);
    root.onpointerdown = (e) => e.target === root && close();
    root.onkeydown = (e) => e.key === "Escape" && close();
    document.body.append(root);
    watch.focus();

    refresh = () => {
      if (!root) return;
      const i = info();
      title.textContent = `agent-inception · ${i.worldName}`;
      for (const r of rows) r.set();
      // Not .hidden: small is display:block here, which beats the attribute.
      localWarn.style.display = current === "code" || reachableFromCloud(i.agentUrl) ? "none" : "";
      fresh.style.display = i.paired ? "" : "none";
      const [cls, text] = STATES[i.state];
      dot.className = `dot ${cls}`;
      statusText.textContent = text;
      notes.textContent =
        (i.paired
          ? "The world runs in this tab, so keep it open (a background tab is fine). Anyone with " +
            "the link can play here; New link cuts old links off. "
          : "Local development: the dev server's bridge (this repo's .mcp.json already points " +
            "at it). Add ?relay=1 to try a hosted-style link, or run deno task share for a " +
            "public one. ") +
        (i.ephemeral ? "This browser blocks storage, so the link changes every visit. " : "") +
        "Worlds save in this browser: three slots under worlds in the panel.";
    };
    select(current);
  };

  return {
    show,
    /** Keep an open card's status current; cheap when it's closed. */
    update: () => refresh(),
    get open() {
      return root !== null;
    },
  };
}
