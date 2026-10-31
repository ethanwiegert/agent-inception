/**
 * The landing and connect card (M14): over the live island on a first visit, and from the panel
 * after that. It says what this is and hands over the world's agent URL, ready to paste into
 * Claude Code or any MCP client.
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
.ai-connect{position:fixed;inset:0;display:grid;place-items:center;background:rgba(5,8,12,.35);
  z-index:19;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;color:#1d232c;padding:16px;
  box-sizing:border-box;overflow:auto}
.ai-connect>div{width:min(520px,100%);background:#f6f4ee;border-radius:14px;padding:20px 22px 16px;
  box-shadow:0 14px 48px rgba(0,0,0,.45);box-sizing:border-box}
.ai-connect h1{margin:0;font-size:20px;letter-spacing:-.01em}
.ai-connect .lead{margin:6px 0 14px;color:#3c4450}
.ai-connect h2{margin:14px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;
  color:#6b6556}
.ai-connect .copy{display:flex;gap:6px;align-items:stretch;margin:4px 0}
.ai-connect code,.ai-connect pre{flex:1;min-width:0;margin:0;padding:7px 9px;border-radius:7px;
  background:#fff;border:1px solid #d6d0c1;font:12px/1.45 ui-monospace,monospace;overflow-x:auto;
  white-space:pre;color:#1d232c}
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
  margin-top:16px;flex-wrap:wrap}`;

const PROMPT = "Join the island as a villager with a name of your own, look around, and make a " +
  "living there. Narrate now and then with say: people are watching.";

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
      "farm, build, invent new things and write the rules. You watch, and pin Wishes.";

    const h1 = document.createElement("h2");
    h1.textContent = "1 · Give your agent this world's link";
    const url = copyRow(() => info().agentUrl);
    const ccLabel = document.createElement("div");
    ccLabel.className = "label";
    ccLabel.textContent = "Claude Code";
    const cc = copyRow(() => `claude mcp add --transport http agent-inception ${info().agentUrl}`);
    const otherLabel = document.createElement("div");
    otherLabel.className = "label";
    otherLabel.textContent = "Other MCP clients (Streamable HTTP)";
    const other = copyRow(
      () =>
        JSON.stringify(
          { mcpServers: { "agent-inception": { type: "http", url: info().agentUrl } } },
          null,
          2,
        ),
      true,
    );

    const h2 = document.createElement("h2");
    h2.textContent = "2 · Ask it to play";
    const prompt = copyRow(() => PROMPT, true);
    prompt.row.querySelector("pre")!.style.whiteSpace = "pre-wrap";

    const notes = document.createElement("small");
    const status = document.createElement("span");
    status.className = "status";
    const dot = document.createElement("span");
    dot.className = "dot";
    const statusText = document.createElement("span");
    status.append(dot, statusText);
    status.onclick = () => dispatchEvent(new Event("focus"));

    const row = document.createElement("div");
    row.className = "row";
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
    row.append(status, buttons);

    card.append(
      title,
      lead,
      h1,
      url.row,
      ccLabel,
      cc.row,
      otherLabel,
      other.row,
      h2,
      prompt.row,
      notes,
      row,
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
      for (const r of [url, cc, other, prompt]) r.set();
      fresh.style.display = i.paired ? "" : "none";
      const [cls, text] = STATES[i.state];
      dot.className = `dot ${cls}`;
      statusText.textContent = text;
      notes.textContent =
        (i.paired
          ? "The world runs in this tab, so keep it open (a background tab is fine). Anyone with " +
            "the link can play here; New link cuts old links off. "
          : "Local development: the dev server's bridge (this repo's .mcp.json already points " +
            "at it). Add ?relay=1 to try a hosted-style link. ") +
        (i.ephemeral ? "This browser blocks storage, so the link changes every visit. " : "") +
        "Worlds save in this browser: three slots under worlds in the panel.";
    };
    refresh();
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
