// agent-inception — Hermes Desktop half.
//
// Unified package: alongside the agent half, this registers one pane that
// embeds the world viewer in a sandboxed frame (the SDK-sanctioned surface for
// external web content — never a raw <webview>), plus a Settings → Plugins
// page to point the viewer at a hosted world.
//
// No browser-panel navigation here on purpose: there is no SDK verb to drive
// the built-in browser to an arbitrary URL (view.showBrowser only toggles the
// panel, and ctx.preview needs a per-origin consent prompt), so the sandboxed
// viewer pane IS the prompt-free "open it in the desktop app" surface.
//
// Plain ESM, no JSX — loaded uncompiled by the disk loader.

import { jsx, jsxs } from "react/jsx-runtime";
import { PANES_AREA, SandboxedFrame } from "@hermes/plugin-sdk";

const DEFAULT_WORLD_URL = "http://localhost:5173";
const URL_KEY = "worldUrl";

function ViewerPane({ url }) {
  return jsxs("div", {
    className: "flex h-full w-full flex-col bg-transparent",
    children: [
      jsx("div", {
        className:
          "flex items-center gap-2 border-b border-(--ui-border) px-3 py-2 text-sm text-(--ui-text-secondary)",
        children: `agent-inception — ${url}`,
      }),
      // min-h-0 so the flex child can actually shrink and the frame fills the
      // pane instead of measuring a full-bleed iframe.
      jsx("div", {
        className: "min-h-0 flex-1",
        children: jsx(SandboxedFrame, { src: url, title: "agent-inception island" }),
      }),
    ],
  });
}

export default {
  id: "agent-inception",
  name: "agent-inception",
  description: "Embed the agent-inception island viewer alongside the chat.",
  defaultEnabled: true,
  register(ctx) {
    // Read once per settings write / reload; the settings page rewrites the
    // same key, so pane and page stay in step on the next render.
    const worldUrl = () => ctx.storage.get(URL_KEY, DEFAULT_WORLD_URL);

    // The "open it in the desktop app" surface: a sandboxed viewer pane.
    ctx.register({
      id: "viewer",
      area: PANES_AREA,
      title: "agent-inception island",
      data: { placement: "right", width: "520px" },
      render: () => jsx(ViewerPane, { url: worldUrl() }),
    });

    // Settings → Plugins → agent-inception → Viewer: pick a hosted world.
    ctx.registerSettingsPage?.({
      id: "viewer",
      title: "Viewer",
      icon: "project",
      order: 0,
      render: () => jsx(WorldUrlSettings, { storage: ctx.storage }),
    });
  },
};

// Minimal settings page: a URL field persisted through ctx.storage.
function WorldUrlSettings({ storage }) {
  const initial = storage.get(URL_KEY, DEFAULT_WORLD_URL);
  return jsxs("form", {
    className: "flex flex-col gap-3 p-4 max-w-3xl",
    onSubmit: (event) => {
      event.preventDefault();
      const value = event.currentTarget.elements.url.value.trim() || DEFAULT_WORLD_URL;
      storage.set(URL_KEY, value);
    },
    children: [
      jsx("label", {
        htmlFor: "worldUrl",
        className: "text-sm text-(--ui-text-secondary)",
        children: "World viewer URL",
      }),
      // A hosted/public link is a bearer secret, not a secret store: it lives
      // in plan sight here so the human knows exactly what the agent connects
      // to, exactly like the mcp_servers override in config.yaml.
      jsx("input", {
        id: "worldUrl",
        name: "worldUrl",
        type: "url",
        defaultValue: initial,
        className:
          "w-full rounded-md border border-(--ui-border) bg-(--ui-input) px-3 py-2 text-sm",
      }),
      jsx("button", {
        type: "submit",
        className: "self-start rounded-md bg-(--ui-accent) px-3 py-2 text-sm text-(--ui-on-accent)",
        children: "Save",
      }),
    ],
  });
}
