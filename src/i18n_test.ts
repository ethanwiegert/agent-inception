import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { cloudHook, PROMPT } from "./connect.ts";
import { failureMessage } from "./gpu.ts";
import {
  agentCloudHook,
  agentPrompt,
  availableLocales,
  canonicalLocale,
  formatDateTime,
  initLocale,
  isRtlLocale,
  languageEndonym,
  localeState,
  localizeWorkerMessage,
  matchLocale,
  onLocaleChange,
  registerLocale,
  setLocale,
  t,
  tPlural,
} from "./i18n.ts";
import { BUNDLED_LOCALES, type MessageKey } from "./locales/index.ts";

const repo = (path: string) => new URL(`../${path}`, import.meta.url);

function resetToEnglish() {
  initLocale({ search: "", saved: null, browser: ["en-US"] });
}

Deno.test("i18n: all bundled locales match English keys, placeholders, bold markers, and MCP tokens", () => {
  const en = BUNDLED_LOCALES.find((p) => p.tag === "en")!.messages;
  const enKeys = Object.keys(en).sort() as MessageKey[];
  const placeholders = (s: string) =>
    [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
  const boldCount = (s: string) => (s.match(/\*\*/g) ?? []).length;

  assertEquals(en["connect.agentPrompt"], PROMPT);
  assertEquals(
    agentCloudHook("https://x.example/mcp/CODE", "en"),
    cloudHook("https://x.example/mcp/CODE"),
  );

  for (const pack of BUNDLED_LOCALES) {
    const keys = Object.keys(pack.messages).sort();
    assertEquals(keys, enKeys, `${pack.tag}: key set mismatch`);
    assert(pack.endonym.trim().length > 0, `${pack.tag}: endonym non-empty`);
    for (const k of enKeys) {
      const val = pack.messages[k];
      assert(typeof val === "string" && val.length > 0, `${pack.tag}.${k}: non-empty`);
      assertEquals(
        placeholders(val),
        placeholders(en[k]),
        `${pack.tag}.${k}: placeholders mismatch`,
      );
      assertEquals(
        boldCount(val) % 2,
        0,
        `${pack.tag}.${k}: unbalanced ** markers`,
      );
    }
    // Agent startup scripts must preserve MCP tool/server identifiers and stay single-line for hook.
    const prompt = pack.messages["connect.agentPrompt"];
    for (const token of ["agent-inception", "say", "journal_write"]) {
      assert(prompt.includes(token), `${pack.tag}: agentPrompt keeps ${token}`);
    }
    const hook = agentCloudHook("https://x.example/mcp/TESTCODE", pack.tag);
    assert(!hook.includes("\n"), `${pack.tag}: cloud hook is a single line`);
    for (
      const token of [
        "https://x.example/mcp/TESTCODE",
        "agent-inception",
        "Streamable HTTP",
        "journal_write",
      ]
    ) {
      assert(hook.includes(token), `${pack.tag}: cloud hook keeps ${token}`);
    }
  }
});

Deno.test("i18n: every data-i18n attribute in web/index.html maps to a real message key", () => {
  const html = Deno.readTextFileSync(repo("web/index.html"));
  const en = BUNDLED_LOCALES.find((p) => p.tag === "en")!.messages;
  const attrs = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  assert(attrs.length >= 10, "web/index.html exposes data-i18n hooks");
  for (const key of attrs) {
    assert(key in en, `unknown data-i18n key in web/index.html: ${key}`);
  }
});

Deno.test("i18n: BCP-47 canonicalization, Chinese script mapping, and fallback matching", () => {
  assertEquals(canonicalLocale("es_MX"), "es-MX");
  assertEquals(canonicalLocale("zh_tw"), "zh-TW");
  assertEquals(canonicalLocale("iw"), "he");
  assertEquals(canonicalLocale("auto"), null);
  assertEquals(canonicalLocale("<script>alert(1)</script>"), null);
  assertEquals(canonicalLocale("../../etc/passwd"), null);

  assertEquals(matchLocale(["es-MX"]), "es");
  assertEquals(matchLocale(["es-419"]), "es");
  assertEquals(matchLocale(["fr-CA"]), "fr");
  assertEquals(matchLocale(["de-AT"]), "de");
  assertEquals(matchLocale(["pt-BR"]), "pt");
  assertEquals(matchLocale(["ja-JP"]), "ja");
  assertEquals(matchLocale(["ko-KR"]), "ko");
  assertEquals(matchLocale(["ru-RU"]), "ru");
  assertEquals(matchLocale(["it-CH"]), "it");
  assertEquals(matchLocale(["ar-SA"]), "ar");
  assertEquals(matchLocale(["zh"]), "zh-Hans");
  assertEquals(matchLocale(["zh-CN"]), "zh-Hans");
  assertEquals(matchLocale(["zh-SG"]), "zh-Hans");
  assertEquals(matchLocale(["zh-TW"]), "zh-Hant");
  assertEquals(matchLocale(["zh-HK"]), "zh-Hant");
  assertEquals(matchLocale(["zh-MO"]), "zh-Hant");
  assertEquals(matchLocale(["zh-Hant-US"]), "zh-Hant");
  assertEquals(matchLocale(["pl-PL", "de-DE", "en-US"]), "de");
  assertEquals(matchLocale(["pl-PL", "sv-SE"]), "en");
});

Deno.test("i18n: initialization precedence (?lang= > saved pref > browser default > en)", () => {
  try {
    // 1. Browser default
    let s = initLocale({ search: "", saved: null, browser: ["ja-JP", "en-US"] });
    assertEquals(s, { uiLocale: "ja", requestedLocale: "ja-JP", mode: "auto", dir: "ltr" });

    // 2. Saved preference overrides browser default
    s = initLocale({ search: "", saved: "fr", browser: ["ja-JP", "en-US"] });
    assertEquals(s, { uiLocale: "fr", requestedLocale: "fr", mode: "manual", dir: "ltr" });

    // 3. Query param overrides saved preference
    s = initLocale({ search: "?lang=ar-EG", saved: "fr", browser: ["ja-JP", "en-US"] });
    assertEquals(s, { uiLocale: "ar", requestedLocale: "ar-EG", mode: "manual", dir: "rtl" });

    // 4. ?lang=auto reverts to browser default even when saved pref exists
    s = initLocale({ search: "?lang=auto", saved: "fr", browser: ["es-MX", "en-US"] });
    assertEquals(s, { uiLocale: "es", requestedLocale: "es-MX", mode: "auto", dir: "ltr" });

    // 5. Malformed ?lang= safely falls back to browser default
    s = initLocale({ search: "?lang=<script>", saved: null, browser: ["de-DE"] });
    assertEquals(s, { uiLocale: "de", requestedLocale: "de-DE", mode: "auto", dir: "ltr" });
  } finally {
    resetToEnglish();
  }
});

Deno.test("i18n: agent startup scripts work for English, bundled languages, and any arbitrary BCP-47 language", () => {
  try {
    const url = "https://agent-inception.com/mcp/AAAAAAAAAAAAAAAAAAAAAA";

    // English stays word-for-word canonical
    assertEquals(agentPrompt("en"), PROMPT);
    assertEquals(agentPrompt("en-GB"), PROMPT);
    assertEquals(agentCloudHook(url, "en-US"), cloudHook(url));

    // Bundled language uses native localized prompt/hook
    const jaPrompt = agentPrompt("ja-JP");
    assert(jaPrompt.includes("agent-inception") && jaPrompt.includes("日本語"));
    const jaHook = agentCloudHook(url, "ja-JP");
    assert(jaHook.includes(url) && !jaHook.includes("\n") && jaHook.includes("日本語"));

    // Arbitrary unbundled languages (Polish, Swedish, Hindi, Hebrew) get explicit language directive
    for (
      const [tag, expectedName] of [
        ["pl-PL", "Polish"],
        ["sv-SE", "Swedish"],
        ["hi-IN", "Hindi"],
        ["he", "Hebrew"],
      ] as const
    ) {
      const p = agentPrompt(tag);
      assert(p.startsWith(PROMPT), `${tag} starts with base prompt`);
      assert(
        p.includes(expectedName) && p.includes(`(${tag})`),
        `${tag} prompt names ${expectedName}`,
      );

      const h = agentCloudHook(url, tag);
      assert(h.startsWith(cloudHook(url)), `${tag} hook starts with base hook`);
      assert(!h.includes("\n"), `${tag} hook stays single-line`);
      assert(
        h.includes(expectedName) && h.includes(`(${tag})`),
        `${tag} hook names ${expectedName}`,
      );
    }

    // Primary browser language is Polish, secondary is German -> UI uses German, agent script targets Polish!
    const s = initLocale({ search: "", saved: null, browser: ["pl-PL", "de-DE", "en-US"] });
    assertEquals(s.uiLocale, "de");
    assertEquals(s.requestedLocale, "pl-PL");
    assert(agentPrompt().includes("Polish (pl-PL)"));
    assert(!agentPrompt().includes("auf Deutsch"));
  } finally {
    resetToEnglish();
  }
});

Deno.test("i18n: RTL detection keeps unbundled RTL fallback LTR until a pack is registered", () => {
  try {
    assertEquals(isRtlLocale("ar"), true);
    assertEquals(isRtlLocale("ar-SA"), true);
    assertEquals(isRtlLocale("he"), true);
    assertEquals(isRtlLocale("fa-IR"), true);
    assertEquals(isRtlLocale("ur"), true);
    assertEquals(isRtlLocale("en-US"), false);
    assertEquals(isRtlLocale("ja"), false);

    // Bundled Arabic -> RTL
    const arState = initLocale({ search: "?lang=ar", saved: null, browser: ["en-US"] });
    assertEquals(arState.uiLocale, "ar");
    assertEquals(arState.dir, "rtl");

    // Unbundled Hebrew -> UI falls back to English LTR (no reversed English text)
    const heState = initLocale({ search: "?lang=he", saved: null, browser: ["en-US"] });
    assertEquals(heState.uiLocale, "en");
    assertEquals(heState.requestedLocale, "he");
    assertEquals(heState.dir, "ltr");
    assert(agentPrompt().includes("Hebrew (he)"));
  } finally {
    resetToEnglish();
  }
});

Deno.test("i18n: live switching, runtime registerLocale, safe interpolation, plurals, worker messages, and GPU errors", () => {
  try {
    resetToEnglish();
    const events: string[] = [];
    const off = onLocaleChange((st) =>
      events.push(`${st.uiLocale}:${st.requestedLocale}:${st.mode}`)
    );

    // Safe single-pass interpolation (never re-interpolates substituted braces)
    assertEquals(t("overlay.follow", { name: "{other}" }), "Follow {other}");
    assertEquals(
      tPlural("panel.summaryOne", "panel.summaryOther", 1, { day: 2, clock: "08:00" }),
      "day 2 08:00 · 1 floatsee",
    );
    assertEquals(
      tPlural("panel.summaryOne", "panel.summaryOther", 3, { day: 2, clock: "08:00" }),
      "day 2 08:00 · 3 floatsees",
    );

    // Live switch to Spanish
    setLocale("es", { persist: false });
    assertEquals(localeState().uiLocale, "es");
    assertEquals(t("panel.newWorld"), "nuevo mundo");
    assert(failureMessage("unsupported", false).includes("necesita WebGPU"));
    assertEquals(
      localizeWorkerMessage("That slot is empty."),
      "Esa ranura está vacía.",
    );
    assertEquals(
      localizeWorkerMessage(
        "All 3 world slots are full, so seed 42 didn't start a new world. Delete one under worlds, then try again.",
      ),
      "Las 3 ranuras de mundo están llenas, así que la semilla 42 no inició un nuevo mundo. Elimina una en mundos e inténtalo de nuevo.",
    );

    // Runtime custom locale pack registration (partial dictionary inherits English fallback)
    const nlPack = registerLocale("nl", {
      "panel.newWorld": "nieuwe wereld",
      "connect.agentPrompt":
        "Gebruik de agent-inception tools om als dorpeling mee te doen, zeg af en toe iets met say en schrijf met journal_write.",
    });
    assert(nlPack !== null);
    assert(availableLocales().some((l) => l.tag === "nl"));
    assertEquals(languageEndonym("nl").toLowerCase(), "nederlands");

    setLocale("nl-NL", { persist: false });
    assertEquals(localeState().uiLocale, "nl");
    assertEquals(t("panel.newWorld"), "nieuwe wereld");
    assertEquals(t("panel.importWorld"), "import"); // falls back to English
    assert(agentPrompt().includes("dorpeling"));

    // Formatting date works for any locale
    assert(formatDateTime(1_700_000_000_000, "nl-NL").length > 0);

    // Back to auto (browser default)
    setLocale("auto", { persist: false });
    assertEquals(localeState().mode, "auto");
    assertEquals(localeState().uiLocale, "en");
    assert(events.length >= 3);
    off();
  } finally {
    resetToEnglish();
  }
});
