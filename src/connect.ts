/**
 * The landing and connect card (M14): over the live island on a first visit, and from the panel
 * after that. It says what this is and hands over the world's agent URL with steps for each place
 * an agent lives: Claude and ChatGPT as a custom connector (nothing to install), Claude Code, or
 * any other chatbot or agent that takes MCP servers.
 */
import type { LinkState } from "./agentlink.ts";
import {
  agentCloudHook,
  agentPrompt,
  type MessageKey,
  onLocaleChange,
  populateLanguageSelect,
  setLocale,
  t,
} from "./i18n.ts";

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
.ai-connect .head-row{display:flex;justify-content:space-between;align-items:center;gap:10px;
  flex-wrap:wrap}
.ai-connect h1{margin:0;font-size:20px;letter-spacing:-.01em}
.ai-connect .lang{padding:3px 8px;border-radius:7px;border:1px solid #c9c3b4;background:#fff;
  color:#1d232c;font:inherit;font-size:12px;max-width:170px}
.ai-connect .lead{margin:6px 0 14px;color:#3c4450}
.ai-connect h2{margin:14px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;
  color:#6b6556}
.ai-connect .copy{display:flex;gap:6px;align-items:flex-start;margin:4px 0}
.ai-connect code,.ai-connect pre{flex:1;min-width:0;margin:0;padding:7px 9px;border-radius:7px;
  background:#fff;border:1px solid #d6d0c1;font:12px/1.45 ui-monospace,monospace;
  white-space:pre-wrap;overflow-wrap:anywhere;color:#1d232c}
.ai-connect code.ltr,.ai-connect pre.ltr{direction:ltr;text-align:left}
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
.ai-connect ol{margin:4px 0;padding-inline-start:20px}
.ai-connect li{margin:4px 0}
.ai-connect .warn{color:#8a4b2a}
@media (pointer:coarse){.ai-connect button{min-height:40px;padding:8px 14px}
  .ai-connect .lang{min-height:36px;font-size:14px}
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
 * Steps for the chat apps, as message keys holding **bold** menu labels. The step with `hasUrl`
 * gets the link's copy row under it. Menu names move between releases; the README has the same.
 */
const CHAT_STEPS: Record<
  "claude" | "chatgpt",
  { steps: { key: MessageKey; hasUrl?: boolean }[]; note: MessageKey }
> = {
  claude: {
    steps: [
      { key: "connect.claudeStep1" },
      { key: "connect.claudeStep2", hasUrl: true },
      { key: "connect.claudeStep3" },
    ],
    note: "connect.claudeNote",
  },
  chatgpt: {
    steps: [
      { key: "connect.chatgptStep1" },
      { key: "connect.chatgptStep2", hasUrl: true },
      { key: "connect.chatgptStep3" },
    ],
    note: "connect.chatgptNote",
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

const STATES: Record<LinkState, [string, MessageKey]> = {
  connecting: ["", "connect.stateConnecting"],
  connected: ["on", "connect.stateConnected"],
  offline: ["off", "connect.stateOffline"],
  replaced: ["off", "connect.stateReplaced"],
  refused: ["off", "connect.stateRefused"],
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
  let applyLocale = () => {};

  const close = () => {
    root?.remove();
    root = null;
    refresh = () => {};
    applyLocale = () => {};
  };

  onLocaleChange(() => {
    if (root) {
      applyLocale();
      refresh();
    }
  });

  const copyRow = (text: () => string, opts: { block?: boolean; ltr?: boolean } = {}) => {
    const row = document.createElement("div");
    row.className = "copy";
    const code = document.createElement(opts.block ? "pre" : "code");
    if (opts.ltr) code.className = "ltr";
    else code.dir = "auto";
    const b = document.createElement("button");
    b.type = "button";
    let feedback: "idle" | "copied" | "select" = "idle";
    const updateLabel = () => {
      b.textContent = feedback === "copied"
        ? t("connect.copied")
        : feedback === "select"
        ? t("connect.select")
        : t("connect.copy");
    };
    updateLabel();
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text());
        feedback = "copied";
      } catch {
        // Clipboard blocked: select it so ctrl+c works.
        getSelection()?.selectAllChildren(code);
        feedback = "select";
      }
      updateLabel();
      setTimeout(() => {
        feedback = "idle";
        updateLabel();
      }, 1500);
    };
    row.append(code, b);
    return {
      row,
      set: () => {
        code.textContent = text();
        updateLabel();
      },
    };
  };

  const show = () => {
    if (root) return;
    root = document.createElement("div");
    root.className = "ai-connect";
    root.dataset.modal = "connect";
    const card = document.createElement("div");
    card.setAttribute("role", "dialog");

    const headRow = document.createElement("div");
    headRow.className = "head-row";
    const title = document.createElement("h1");
    const langSelect = document.createElement("select");
    langSelect.className = "lang";
    langSelect.onchange = () => setLocale(langSelect.value);
    headRow.append(title, langSelect);

    const lead = document.createElement("p");
    lead.className = "lead";

    const h1 = document.createElement("h2");
    const label = () => {
      const d = document.createElement("div");
      d.className = "label";
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
    const select = (tTab: Tab) => {
      current = tTab;
      for (const [k, b] of tabButtons) b.setAttribute("aria-selected", String(k === tTab));
      for (const [k, p] of panels) p.hidden = k !== tTab;
      refresh();
    };
    const tabKeys: [Tab, MessageKey][] = [
      ["claude", "connect.tabClaude"],
      ["chatgpt", "connect.tabChatgpt"],
      ["code", "connect.tabCode"],
      ["other", "connect.tabOther"],
    ];
    for (const [tabId] of tabKeys) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.onclick = () => select(tabId);
      tabButtons.set(tabId, b);
      tabs.append(b);
      const p = document.createElement("div");
      p.setAttribute("role", "tabpanel");
      panels.set(tabId, p);
    }

    // A link on this machine can't be reached from the cloud, where chat apps run.
    const localWarn = document.createElement("small");
    localWarn.className = "warn";

    const chatTextSlots: { el: HTMLElement; key: MessageKey }[] = [];
    const chatNotes: { el: HTMLElement; key: MessageKey }[] = [];
    for (const tabId of ["claude", "chatgpt"] as const) {
      const ol = document.createElement("ol");
      for (const step of CHAT_STEPS[tabId].steps) {
        const li = document.createElement("li");
        const slot = document.createElement("span");
        chatTextSlots.push({ el: slot, key: step.key });
        li.append(slot);
        if (step.hasUrl) li.append(row(copyRow(() => info().agentUrl, { ltr: true })).row);
        ol.append(li);
      }
      const note = document.createElement("small");
      chatNotes.push({ el: note, key: CHAT_STEPS[tabId].note });
      panels.get(tabId)!.append(ol, note);
    }

    const codeLabel = label();
    const cc = row(
      copyRow(() => `claude mcp add --transport http agent-inception ${info().agentUrl}`, {
        ltr: true,
      }),
    );
    panels.get("code")!.append(codeLabel, cc.row);

    const other = row(copyRow(
      () =>
        JSON.stringify(
          { mcpServers: { "agent-inception": { type: "http", url: info().agentUrl } } },
          null,
          2,
        ),
      { block: true, ltr: true },
    ));
    const otherIntro = document.createElement("small");
    const otherLinkLabel = label();
    const otherHookLabel = label();
    const configBox = document.createElement("details");
    const summary = document.createElement("summary");
    configBox.append(summary, other.row);
    panels.get("other")!.append(
      otherIntro,
      otherLinkLabel,
      row(copyRow(() => info().agentUrl, { ltr: true })).row,
      otherHookLabel,
      row(copyRow(() => agentCloudHook(info().agentUrl), { block: true })).row,
      configBox,
    );

    const h2 = document.createElement("h2");
    const prompt = row(copyRow(() => agentPrompt(), { block: true }));
    const sideBySide = document.createElement("small");

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
    fresh.type = "button";
    fresh.onclick = async () => {
      if (!confirm(t("connect.newLinkConfirm"))) return;
      await renew();
      refresh();
    };
    const watch = document.createElement("button");
    watch.type = "button";
    watch.className = "primary";
    watch.onclick = close;
    buttons.append(fresh, " ", watch);
    footer.append(status, buttons);

    card.append(
      headRow,
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
    // Block bodies: an on* handler returning false cancels the event (Tab, Space, ctrl+c…).
    root.onpointerdown = (e) => {
      if (e.target === root) close();
    };
    root.onkeydown = (e) => {
      if (e.key === "Escape") close();
    };
    document.body.append(root);
    watch.focus();

    applyLocale = () => {
      card.setAttribute("aria-label", t("connect.aria"));
      populateLanguageSelect(langSelect);
      lead.textContent = t("connect.lead");
      h1.textContent = t("connect.step1");
      for (const [tabId, key] of tabKeys) tabButtons.get(tabId)!.textContent = t(key);
      localWarn.textContent = t("connect.localWarn");
      for (const slot of chatTextSlots) slot.el.replaceChildren(rich(t(slot.key)));
      for (const note of chatNotes) {
        note.el.textContent = `${t(note.key)} ${t("connect.menuMoveNote")}`;
      }
      codeLabel.textContent = t("connect.codeLabel");
      otherIntro.textContent = t("connect.otherIntro");
      otherLinkLabel.textContent = t("connect.otherLink");
      otherHookLabel.textContent = t("connect.otherHookLabel");
      summary.textContent = t("connect.otherConfig");
      h2.textContent = t("connect.step2");
      sideBySide.textContent = t("connect.sideBySide");
      fresh.textContent = t("connect.newLink");
      fresh.title = t("connect.newLinkTitle");
      watch.textContent = t("connect.startWatching");
    };

    refresh = () => {
      if (!root) return;
      const i = info();
      title.textContent = `agent-inception · ${i.worldName}`;
      for (const r of rows) r.set();
      // Not .hidden: small is display:block here, which beats the attribute.
      localWarn.style.display = current === "code" || reachableFromCloud(i.agentUrl) ? "none" : "";
      fresh.style.display = i.paired ? "" : "none";
      const [cls, key] = STATES[i.state];
      dot.className = `dot ${cls}`;
      statusText.textContent = t(key);
      notes.textContent = (i.paired ? t("connect.notePaired") : t("connect.noteLocal")) +
        (i.ephemeral ? t("connect.noteEphemeral") : "") +
        t("connect.noteWorlds");
    };
    applyLocale();
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
