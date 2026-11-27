import { ar } from "./ar.ts";
import { de } from "./de.ts";
import { en, type MessageKey, type Messages } from "./en.ts";
import { es } from "./es.ts";
import { fr } from "./fr.ts";
import { it } from "./it.ts";
import { ja } from "./ja.ts";
import { ko } from "./ko.ts";
import { pt } from "./pt.ts";
import { ru } from "./ru.ts";
import { zhHans } from "./zh-Hans.ts";
import { zhHant } from "./zh-Hant.ts";

export type { MessageKey, Messages };

export interface LocalePack {
  readonly tag: string;
  readonly endonym: string;
  readonly dir: "ltr" | "rtl";
  readonly messages: Messages;
}

/** Built-in locale packs bundled directly into the client (zero runtime dependencies). */
export const BUNDLED_LOCALES: readonly LocalePack[] = [
  { tag: "en", endonym: "English", dir: "ltr", messages: en },
  { tag: "es", endonym: "Español", dir: "ltr", messages: es },
  { tag: "fr", endonym: "Français", dir: "ltr", messages: fr },
  { tag: "de", endonym: "Deutsch", dir: "ltr", messages: de },
  { tag: "pt", endonym: "Português", dir: "ltr", messages: pt },
  { tag: "it", endonym: "Italiano", dir: "ltr", messages: it },
  { tag: "ru", endonym: "Русский", dir: "ltr", messages: ru },
  { tag: "ja", endonym: "日本語", dir: "ltr", messages: ja },
  { tag: "zh-Hans", endonym: "简体中文", dir: "ltr", messages: zhHans },
  { tag: "zh-Hant", endonym: "繁體中文", dir: "ltr", messages: zhHant },
  { tag: "ko", endonym: "한국어", dir: "ltr", messages: ko },
  { tag: "ar", endonym: "العربية", dir: "rtl", messages: ar },
];
