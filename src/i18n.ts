/**
 * Zero-dependency client-side localization engine.
 *
 * Works for any BCP-47 language tag:
 * - Defaults to the browser's preferred languages (`navigator.languages` / `navigator.language`).
 * - Can be overridden via `?lang=<tag>` or saved preference (`localStorage`, `lang`).
 * - Matches bundled UI packs with BCP-47 script/region fallbacks, and supports runtime registration
 *   of any additional locale via `registerLocale`.
 * - Adapts the agent startup scripts (`agentPrompt`, `agentCloudHook`) for *any* language, using
 *   native localized prompts for bundled languages and `Intl.DisplayNames` directives for any other
 *   BCP-47 language.
 * - Uses native `Intl` APIs for pluralization, date/time formatting, number formatting, and
 *   language endonyms.
 */
import {
  BUNDLED_LOCALES,
  type LocalePack,
  type MessageKey,
  type Messages,
} from "./locales/index.ts";
import { pref, setPref } from "./prefs.ts";

export type { LocalePack, MessageKey, Messages };

export type Params = Record<string, string | number>;
export type LocaleMode = "auto" | "manual";

export interface LocaleState {
  /** Bundled/registered UI catalog currently rendering DOM strings. */
  readonly uiLocale: string;
  /** Canonical BCP-47 language requested by the user or their browser (may be any language). */
  readonly requestedLocale: string;
  /** Whether the locale follows the browser default or was manually chosen. */
  readonly mode: LocaleMode;
  /** Text direction of the rendered UI (`ltr` or `rtl`). */
  readonly dir: "ltr" | "rtl";
}

export interface InitLocaleOptions {
  /** URL query string (defaults to `location.search` in browsers). */
  search?: string;
  /** Saved preference value (defaults to `pref("lang")`). */
  saved?: string | null;
  /** Browser preferred languages (defaults to `detectBrowserLocales()`). */
  browser?: readonly string[];
}

const RTL_LANGS = new Set([
  "ar",
  "arc",
  "dv",
  "fa",
  "ha",
  "he",
  "iw",
  "ji",
  "khw",
  "ks",
  "ku",
  "ps",
  "sd",
  "ug",
  "ur",
  "yi",
]);

const TRADITIONAL_ZH_REGIONS = new Set(["TW", "HK", "MO"]);
const LEGACY_LANG_MAP: Record<string, string> = { iw: "he", in: "id", ji: "yi" };
const BCP47_FALLBACK_RE = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/;

const packs = new Map<string, LocalePack>();
for (const pack of BUNDLED_LOCALES) packs.set(pack.tag, pack);

const listeners = new Set<(state: LocaleState) => void>();

let browserLocales: string[] = ["en"];
let state: LocaleState = {
  uiLocale: "en",
  requestedLocale: "en",
  mode: "auto",
  dir: "ltr",
};

/** Canonicalize and validate a BCP-47 locale tag, or return null if invalid. */
export function canonicalLocale(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/_/g, "-");
  if (!trimmed || trimmed.toLowerCase() === "auto" || trimmed.length > 35) return null;
  if (!BCP47_FALLBACK_RE.test(trimmed)) return null;
  try {
    const [canon] = Intl.getCanonicalLocales(trimmed);
    if (!canon) return null;
    const parts = canon.split("-");
    const mapped = LEGACY_LANG_MAP[parts[0].toLowerCase()];
    if (mapped) parts[0] = mapped;
    return parts.join("-");
  } catch {
    return null;
  }
}

/** Primary language subtag in lowercase (e.g. `"zh"` for `"zh-Hant-TW"`). */
export function baseLanguage(tag: string): string {
  return tag.split("-")[0].toLowerCase();
}

/** Whether `tag` is a right-to-left language. */
export function isRtlLocale(tag: string): boolean {
  const canon = canonicalLocale(tag) ?? tag;
  try {
    const loc = new Intl.Locale(canon) as Intl.Locale & {
      getTextInfo?: () => { direction?: string };
      textInfo?: { direction?: string };
    };
    const dir = loc.getTextInfo?.().direction ?? loc.textInfo?.direction;
    if (dir === "rtl") return true;
    if (dir === "ltr") return false;
  } catch {
    // Fallback to static RTL language set below.
  }
  return RTL_LANGS.has(baseLanguage(canon));
}

/** Match an ordered list of preferred BCP-47 locales against `available` pack tags. */
export function matchLocale(
  preferred: readonly string[],
  available: readonly string[] = [...packs.keys()],
  fallback: string | null = "en",
): string | null {
  const byLower = new Map<string, string>();
  for (const tag of available) byLower.set(tag.toLowerCase(), tag);

  for (const raw of preferred) {
    const canon = canonicalLocale(raw);
    if (!canon) continue;
    const lower = canon.toLowerCase();
    const exact = byLower.get(lower);
    if (exact) return exact;

    const parts = canon.split("-");
    const lang = parts[0].toLowerCase();

    // Chinese script and regional mapping: TW/HK/MO/Hant -> zh-Hant, otherwise zh-Hans.
    if (lang === "zh") {
      const hasHant = parts.some((p) => p.toLowerCase() === "hant") ||
        parts.some((p) => TRADITIONAL_ZH_REGIONS.has(p.toUpperCase()));
      const zhTarget = hasHant ? "zh-hant" : "zh-hans";
      const zhMatch = byLower.get(zhTarget);
      if (zhMatch) return zhMatch;
    }

    // Progressive subtag truncation (e.g. es-419 -> es, pt-BR -> pt).
    for (let len = parts.length - 1; len >= 1; len--) {
      const prefix = parts.slice(0, len).join("-").toLowerCase();
      const hit = byLower.get(prefix);
      if (hit) return hit;
    }
  }
  return fallback;
}

/** Read preferred languages from the browser environment, canonicalized and deduplicated. */
export function detectBrowserLocales(): string[] {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const raw: string[] = [];
  if (nav?.languages?.length) raw.push(...nav.languages);
  if (nav?.language) raw.push(nav.language);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const c = canonicalLocale(entry);
    if (c && !seen.has(c.toLowerCase())) {
      seen.add(c.toLowerCase());
      out.push(c);
    }
  }
  return out.length ? out : ["en"];
}

function computeState(mode: LocaleMode, manualTag: string | null): LocaleState {
  const preferred = mode === "manual" && manualTag
    ? [manualTag, ...browserLocales]
    : browserLocales;
  const requestedLocale = mode === "manual" && manualTag ? manualTag : (browserLocales[0] ?? "en");
  const uiLocale = matchLocale(preferred) ?? "en";
  const pack = packs.get(uiLocale);
  return {
    uiLocale,
    requestedLocale,
    mode,
    dir: pack?.dir ?? (isRtlLocale(uiLocale) ? "rtl" : "ltr"),
  };
}

function notify() {
  for (const cb of listeners) cb(state);
}

/**
 * Initialize active locale from `?lang=`, saved preference, and browser languages.
 * Call once at client startup before rendering any UI.
 */
export function initLocale(opts: InitLocaleOptions = {}): LocaleState {
  browserLocales = opts.browser
    ? opts.browser.map(canonicalLocale).filter((x): x is string => x !== null)
    : detectBrowserLocales();
  if (!browserLocales.length) browserLocales = ["en"];

  const search = opts.search ?? (typeof location !== "undefined" ? location.search : "");
  const queryLang = new URLSearchParams(search).get("lang")?.trim() ?? null;
  const savedLang = opts.saved !== undefined ? opts.saved : pref("lang");

  if (queryLang !== null) {
    if (queryLang.toLowerCase() === "auto" || queryLang === "") {
      state = computeState("auto", null);
    } else {
      const canon = canonicalLocale(queryLang);
      state = canon ? computeState("manual", canon) : computeState("auto", null);
    }
  } else if (savedLang) {
    const canon = canonicalLocale(savedLang);
    state = canon ? computeState("manual", canon) : computeState("auto", null);
  } else {
    state = computeState("auto", null);
  }
  notify();
  return state;
}

/** Current active localization state. */
export function localeState(): LocaleState {
  return state;
}

/** Browser's primary detected locale (used for the "Auto (...)" option label). */
export function browserDefaultLocale(): string {
  return browserLocales[0] ?? "en";
}

/** All bundled and dynamically registered UI locale packs. */
export function availableLocales(): readonly LocalePack[] {
  return [...packs.values()];
}

/**
 * Switch the active language live. Pass `null`, `""`, or `"auto"` to follow the browser default,
 * or any valid BCP-47 tag (bundled or unbundled).
 */
export function setLocale(
  tag: string | null,
  opts: { persist?: boolean } = {},
): LocaleState {
  const persist = opts.persist ?? true;
  if (!tag || tag.trim().toLowerCase() === "auto") {
    if (persist) setPref("lang", null);
    state = computeState("auto", null);
    notify();
    return state;
  }
  const canon = canonicalLocale(tag);
  if (!canon) return state;
  if (persist) setPref("lang", canon);
  state = computeState("manual", canon);
  notify();
  return state;
}

/**
 * Register a new locale pack or override an existing one at runtime (zero dependencies).
 * Omitted message keys automatically fall back to English.
 */
export function registerLocale(
  tag: string,
  messages: Partial<Messages>,
  meta: { endonym?: string; dir?: "ltr" | "rtl" } = {},
): LocalePack | null {
  const canon = canonicalLocale(tag);
  if (!canon) return null;
  const base = packs.get("en")!.messages;
  const merged: Messages = { ...base, ...messages };
  const pack: LocalePack = {
    tag: canon,
    endonym: meta.endonym ?? languageEndonym(canon),
    dir: meta.dir ?? (isRtlLocale(canon) ? "rtl" : "ltr"),
    messages: merged,
  };
  packs.set(canon, pack);
  // Recompute in case the currently requested locale now matches or was updated.
  const next = computeState(state.mode, state.mode === "manual" ? state.requestedLocale : null);
  if (next.uiLocale !== state.uiLocale || next.dir !== state.dir || canon === state.uiLocale) {
    state = next;
    notify();
  }
  return pack;
}

/** Populate a `<select>` with Auto (browser default) plus all bundled/registered locales. */
export function populateLanguageSelect(select: HTMLSelectElement): void {
  const autoOption = document.createElement("option");
  autoOption.value = "auto";
  autoOption.textContent = t("panel.languageAuto", {
    name: languageEndonym(browserDefaultLocale()),
  });

  const options: HTMLOptionElement[] = [autoOption];
  const seen = new Set<string>();
  for (const pack of availableLocales()) {
    seen.add(pack.tag.toLowerCase());
    const opt = document.createElement("option");
    opt.value = pack.tag;
    opt.textContent = pack.endonym;
    options.push(opt);
  }

  // If the user explicitly requested an unbundled BCP-47 tag (e.g. `?lang=pl`), show it cleanly.
  if (state.mode === "manual" && !seen.has(state.requestedLocale.toLowerCase())) {
    const opt = document.createElement("option");
    opt.value = state.requestedLocale;
    const endonym = languageEndonym(state.requestedLocale);
    opt.textContent = endonym === state.requestedLocale
      ? state.requestedLocale
      : `${endonym} (${state.requestedLocale})`;
    options.push(opt);
  }

  select.replaceChildren(...options);
  select.setAttribute("aria-label", t("panel.languageAria"));
  const activeValue = state.mode === "auto"
    ? "auto"
    : seen.has(state.requestedLocale.toLowerCase())
    ? [...packs.values()].find((p) => p.tag.toLowerCase() === state.requestedLocale.toLowerCase())
      ?.tag ?? state.requestedLocale
    : seen.has(state.uiLocale.toLowerCase()) &&
        baseLanguage(state.requestedLocale) === baseLanguage(state.uiLocale)
    ? state.uiLocale
    : state.requestedLocale;
  // If a regional variant like `es-MX` matched `es`, ensure it selects an existing option.
  if (!options.some((o) => o.value === activeValue)) {
    const opt = document.createElement("option");
    opt.value = state.requestedLocale;
    const endonym = languageEndonym(state.requestedLocale);
    opt.textContent = endonym === state.requestedLocale
      ? state.requestedLocale
      : `${endonym} (${state.requestedLocale})`;
    select.append(opt);
    select.value = state.requestedLocale;
  } else {
    select.value = activeValue;
  }
}

/** Subscribe to live locale changes. Returns an unsubscribe function. */
export function onLocaleChange(cb: (state: LocaleState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Single-pass `{key}` interpolation (substituted values are never re-parsed). */
function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(
    /\{(\w+)\}/g,
    (match, key) => Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
}

/** Look up and format a UI string for `locale` (defaults to the active `uiLocale`). */
export function t(key: MessageKey, params?: Params, locale = state.uiLocale): string {
  const pack = packs.get(locale) ?? packs.get(matchLocale([locale]) ?? "en") ?? packs.get("en")!;
  const template = pack.messages[key] ?? packs.get("en")!.messages[key];
  return interpolate(template, params);
}

/** Plural-aware helper using native `Intl.PluralRules`. */
export function tPlural(
  oneKey: MessageKey,
  otherKey: MessageKey,
  count: number,
  params: Params = {},
  locale = state.uiLocale,
): string {
  let category: Intl.LDMLPluralRule = count === 1 ? "one" : "other";
  try {
    category = new Intl.PluralRules(locale).select(count);
  } catch {
    // Fallback to simple 1 / other check above.
  }
  const key = category === "one" ? oneKey : otherKey;
  return t(key, { count, ...params }, locale);
}

/** Display name of a language tag in `inLocale` (uses native `Intl.DisplayNames`). */
export function languageDisplayName(tag: string, inLocale = state.uiLocale): string {
  const canon = canonicalLocale(tag) ?? tag;
  try {
    const dn = new Intl.DisplayNames([inLocale], { type: "language" });
    const name = dn.of(canon);
    if (name) return name;
  } catch {
    // Ignore unsupported display name queries.
  }
  return packs.get(canon)?.endonym ?? canon;
}

/** Native endonym of a language (e.g. `"Español"`, `"日本語"`, `"Polski"`). */
export function languageEndonym(tag: string): string {
  const canon = canonicalLocale(tag) ?? tag;
  const direct = packs.get(canon);
  if (direct) return direct.endonym;
  try {
    const dn = new Intl.DisplayNames([canon], { type: "language" });
    const name = dn.of(canon);
    if (name) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    // Fall back to canonical tag.
  }
  return canon;
}

/** Format a timestamp using the active locale's conventions. */
export function formatDateTime(ms: number, locale = state.requestedLocale): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

/**
 * Agent startup prompt ("2 · Ask it to play") adapted for *any* BCP-47 language:
 * - English returns the canonical English prompt verbatim.
 * - Any bundled/registered language returns its native localized prompt.
 * - Any other BCP-47 language appends an explicit language directive so the agent plays, narrates
 *   (`say`), and writes journal notes (`journal_write`) in the user's language.
 */
export function agentPrompt(locale = state.requestedLocale): string {
  const canon = canonicalLocale(locale) ?? "en";
  const direct = matchLocale([canon], [...packs.keys()], null);
  if (direct === "en") return packs.get("en")!.messages["connect.agentPrompt"];
  if (direct !== null) return packs.get(direct)!.messages["connect.agentPrompt"];
  const langName = languageDisplayName(baseLanguage(canon), "en");
  const suffix = t("connect.agentLanguageSuffix", { language: langName, locale: canon }, "en");
  return `${packs.get("en")!.messages["connect.agentPrompt"]} ${suffix}`;
}

/**
 * One-line startup hook for cloud agents (Muse, Dots, Grok Bot…), adapted for *any* BCP-47
 * language. Always remains a single line with `url` intact.
 */
export function agentCloudHook(url: string, locale = state.requestedLocale): string {
  const canon = canonicalLocale(locale) ?? "en";
  const direct = matchLocale([canon], [...packs.keys()], null);
  if (direct === "en") return t("connect.agentCloudHook", { url }, "en");
  if (direct !== null) return t("connect.agentCloudHook", { url }, direct);
  const langName = languageDisplayName(baseLanguage(canon), "en");
  const suffix = t("connect.agentLanguageSuffix", { language: langName, locale: canon }, "en");
  return `${t("connect.agentCloudHook", { url }, "en")} ${suffix}`;
}

/**
 * Translate known status/error messages emitted by `src/worker.ts` without duplicating locale
 * dictionaries into the worker bundle.
 */
export function localizeWorkerMessage(text: string): string {
  if (state.uiLocale === "en") return text;
  let m = text.match(
    /^All (\d+) world slots are full, so seed (-?\d+) didn't start a new world\. Delete one under worlds, then try again\.(.*)$/,
  );
  if (m) {
    const rest = m[3].trim();
    const base = t("worker.slotsFullSeed", { slots: m[1], seed: m[2] });
    return rest ? `${base} ${localizeWorkerMessage(rest)}` : base;
  }
  if (text === "This world was saved before saves were kept, so its island starts afresh.") {
    return t("worker.olderSave");
  }
  m = text.match(/^World slot (\d+) wasn't opened: (.*) This island won't be saved\.$/);
  if (m) return t("worker.slotNotOpened", { slot: m[1], why: m[2] });
  if (text === "That's the world you're watching.") return t("worker.watchingWorld");
  if (text === "That slot is empty.") return t("worker.slotEmpty");
  m = text.match(/^All (\d+) slots are full\. Delete one first\.$/);
  if (m) return t("worker.allSlotsFull", { slots: m[1] });
  if (text === "That file is too big.") return t("worker.fileTooBig");
  if (text === "That file is too big unpacked.") return t("worker.fileTooBigUnpacked");
  if (text === "That file isn't a world (it couldn't be unpacked).") {
    return t("worker.notWorldUnpack");
  }
  if (text === "That file isn't a world (not JSON).") return t("worker.notWorldJson");
  if (text === "That file isn't an agent-inception world.") return t("worker.notWorldFormat");
  return text;
}

/**
 * Apply the active locale to the page document (`<html lang/dir>`, `<title>`, `<meta description>`,
 * and `#about` static fallback copy) using safe text-only DOM updates.
 */
export function applyDocumentLocale(): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = state.uiLocale;
  document.documentElement.dir = state.dir;
  document.title = t("meta.title");
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.setAttribute("content", t("meta.description"));

  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset.i18n as MessageKey | undefined;
    if (key && key in packs.get("en")!.messages) {
      el.textContent = t(key);
    }
  }
}
