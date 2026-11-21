/**
 * Floatsees: customizable floating-head island villagers. Agents choose a head shape, four
 * expressions (happy, sad, angry, excited), a color scheme, and front/back graphic tee images
 * when joining or customizing. Everything here is deterministic, DOM-free, and strictly validated
 * against untrusted agent inputs (SECURITY.md).
 */

export const HEAD_SHAPES = ["sphere", "cube", "star", "teacup", "cloud", "horned"] as const;
export type HeadShape = (typeof HEAD_SHAPES)[number];

export const EXPRESSIONS = ["happy", "sad", "angry", "excited"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export const TEE_PRESETS = [
  "sprout",
  "sun",
  "tree",
  "campfire",
  "stars",
  "shield",
  "flower",
  "heart",
  "none",
] as const;
export type TeePreset = (typeof TEE_PRESETS)[number];

export const EXPRESSION_PRESETS = ["classic", "minimal", "kawaii"] as const;
export type ExpressionPreset = (typeof EXPRESSION_PRESETS)[number];

export interface FloatseeColors {
  /** Main body & head glaze color, "#rrggbb". */
  primary: string;
  /** Hem trim, collar highlight & frame accent color, "#rrggbb". */
  accent: string;
  /** Emissive face / twilight glow tint, "#rrggbb". */
  glow: string;
}

export const COLOR_PRESETS: Record<string, FloatseeColors> = {
  mint: { primary: "#9fd8c2", accent: "#5ba493", glow: "#fff8d6" },
  terracotta: { primary: "#de8f69", accent: "#b65a3c", glow: "#ffea9a" },
  lavender: { primary: "#b8a8dc", accent: "#7c6bb3", glow: "#edf4ff" },
  indigo: { primary: "#4c568e", accent: "#2d3461", glow: "#ffe69c" },
  amber: { primary: "#eaa85b", accent: "#c56b32", glow: "#fff3b0" },
  rose: { primary: "#db6f7e", accent: "#9e3f52", glow: "#ffdfe4" },
};
export const COLOR_PRESET_NAMES = Object.keys(COLOR_PRESETS);

/** Inline agent-authored pixel art: 1-16 rows of single-character palette keys ('.' or ' ' clear). */
export interface PixelArt {
  palette: Record<string, string>;
  pixels: string[];
}

/** A graphic tee or custom expression face: a preset name, a PixelArt grid, or a safe data URL. */
export type FloatseeArt = string | PixelArt;

export interface FloatseeAppearance {
  head: HeadShape;
  colors: FloatseeColors;
  frontTee: FloatseeArt;
  backTee: FloatseeArt;
  /** Optional custom art or preset style per mood; omitted moods use the built-in classic face. */
  expressions: Partial<Record<Expression, FloatseeArt>>;
}

export const MAX_GRID = 16;
export const MAX_PALETTE = 16;
/** Max decoded byte length of a base64 PNG/SVG data URL so saves stay small and safe. */
export const MAX_DATA_URL_BYTES = 16 * 1024;

const HEX = /^#[0-9a-fA-F]{6}$/;
const PNG_PREFIX = "data:image/png;base64,";
const SVG_PREFIX = "data:image/svg+xml;base64,";
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const DEFAULT_LINEUP: {
  head: HeadShape;
  preset: string;
  front: TeePreset;
  back: TeePreset;
}[] = [
  { head: "sphere", preset: "mint", front: "sprout", back: "tree" },
  { head: "cube", preset: "terracotta", front: "sprout", back: "stars" },
  { head: "star", preset: "amber", front: "campfire", back: "stars" },
  { head: "teacup", preset: "mint", front: "sun", back: "tree" },
  { head: "cloud", preset: "lavender", front: "tree", back: "stars" },
  { head: "horned", preset: "indigo", front: "shield", back: "stars" },
];

export function expressionIndex(e: Expression): number {
  const i = EXPRESSIONS.indexOf(e);
  return i >= 0 ? i : 0;
}

export function expressionFromIndex(i: number): Expression {
  return EXPRESSIONS[Math.max(0, Math.min(EXPRESSIONS.length - 1, Math.round(i)))] ?? "happy";
}

/** Deterministic starter Floatsee look for a villager slot, matching the mockup lineup. */
export function defaultFloatsee(slot: number): FloatseeAppearance {
  const pick = DEFAULT_LINEUP[
    ((slot % DEFAULT_LINEUP.length) + DEFAULT_LINEUP.length) % DEFAULT_LINEUP.length
  ];
  return {
    head: pick.head,
    colors: { ...COLOR_PRESETS[pick.preset] },
    frontTee: pick.front,
    backTee: pick.back,
    expressions: {},
  };
}

function normHex(v: unknown, label: string): string {
  if (typeof v !== "string" || !HEX.test(v.trim())) {
    throw new Error(`${label} must be a "#rrggbb" hex color.`);
  }
  return v.trim().toLowerCase();
}

export function parseHeadShape(v: unknown): HeadShape {
  if (typeof v !== "string") {
    throw new Error(`head must be one of: ${HEAD_SHAPES.join(", ")}.`);
  }
  const s = v.trim().toLowerCase();
  if ((HEAD_SHAPES as readonly string[]).includes(s)) return s as HeadShape;
  throw new Error(`Unknown head "${v}". Choose from: ${HEAD_SHAPES.join(", ")}.`);
}

export function parseExpression(v: unknown): Expression {
  if (typeof v !== "string") {
    throw new Error(`expression must be one of: ${EXPRESSIONS.join(", ")}.`);
  }
  const s = v.trim().toLowerCase();
  if ((EXPRESSIONS as readonly string[]).includes(s)) return s as Expression;
  throw new Error(`Unknown expression "${v}". Choose from: ${EXPRESSIONS.join(", ")}.`);
}

export function parseColorScheme(v: unknown, base: FloatseeColors): FloatseeColors {
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error("color_scheme JSON could not be parsed.");
      }
      return parseColorScheme(parsed, base);
    }
    const key = trimmed.toLowerCase();
    const preset = COLOR_PRESETS[key];
    if (preset) return { ...preset };
    if (HEX.test(key)) return { ...base, primary: key };
    throw new Error(
      `Unknown color_scheme "${v}". Use a preset (${
        COLOR_PRESET_NAMES.join(", ")
      }) or { primary, accent, glow }.`,
    );
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("color_scheme must be a preset name or { primary, accent, glow } object.");
  }
  const obj = v as Record<string, unknown>;
  const allowed = new Set(["preset", "primary", "accent", "glow"]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new Error(`Unknown color_scheme field "${k}".`);
  }
  let out: FloatseeColors = { ...base };
  if (obj.preset !== undefined) {
    const key = String(obj.preset).trim().toLowerCase();
    const preset = COLOR_PRESETS[key];
    if (!preset) {
      throw new Error(
        `Unknown color preset "${obj.preset}". Choose from: ${COLOR_PRESET_NAMES.join(", ")}.`,
      );
    }
    out = { ...preset };
  }
  if (obj.primary !== undefined) out.primary = normHex(obj.primary, "color_scheme.primary");
  if (obj.accent !== undefined) out.accent = normHex(obj.accent, "color_scheme.accent");
  if (obj.glow !== undefined) out.glow = normHex(obj.glow, "color_scheme.glow");
  return out;
}

function decodeBase64Bytes(b64: string, label: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  if (!clean.length || clean.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new Error(`${label} has invalid base64 data.`);
  }
  // Rough upper bound before decoding.
  if (Math.ceil(clean.length * 3 / 4) > MAX_DATA_URL_BYTES + 4) {
    throw new Error(`${label} is too large (max ${MAX_DATA_URL_BYTES} bytes).`);
  }
  let bin: string;
  try {
    bin = atob(clean);
  } catch {
    throw new Error(`${label} has invalid base64 data.`);
  }
  if (bin.length === 0 || bin.length > MAX_DATA_URL_BYTES) {
    throw new Error(`${label} must be 1-${MAX_DATA_URL_BYTES} bytes.`);
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const UNSAFE_SVG =
  /<\s*(script|foreignObject|iframe|object|embed|applet|link|meta|base)\b|on[a-z]+\s*=|javascript:|vbscript:|data\s*:\s*text\/html|@import|href\s*=\s*["']\s*https?:|src\s*=\s*["']\s*https?:|url\s*\(\s*["']?\s*https?:/i;

function validateDataUrl(url: string, label: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith(PNG_PREFIX)) {
    const b64 = trimmed.slice(PNG_PREFIX.length);
    const bytes = decodeBase64Bytes(b64, label);
    if (bytes.length < 8 || PNG_MAGIC.some((b, i) => bytes[i] !== b)) {
      throw new Error(`${label} is not a valid PNG image.`);
    }
    return PNG_PREFIX + b64.replace(/\s+/g, "");
  }
  if (trimmed.startsWith(SVG_PREFIX)) {
    const b64 = trimmed.slice(SVG_PREFIX.length);
    const bytes = decodeBase64Bytes(b64, label);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (!/<svg[\s>]/i.test(text) || !/<\/svg\s*>/i.test(text)) {
      throw new Error(`${label} must be a complete <svg> document.`);
    }
    // Strip standard SVG/XLink namespace declarations before checking for external URLs.
    const stripped = text
      .replace(
        /\bxmlns(?::xlink)?\s*=\s*["']https?:\/\/www\.w3\.org\/[0-9]{4}\/(?:svg|xlink)["']/gi,
        "",
      );
    if (UNSAFE_SVG.test(stripped) || /https?:\/\//i.test(stripped)) {
      throw new Error(`${label} contains disallowed SVG scripting or external references.`);
    }
    return SVG_PREFIX + b64.replace(/\s+/g, "");
  }
  throw new Error(
    `${label} data URL must start with "${PNG_PREFIX}" or "${SVG_PREFIX}" (external URLs are not allowed).`,
  );
}

export function isPixelArt(art: FloatseeArt | undefined): art is PixelArt {
  return typeof art === "object" && art !== null && Array.isArray(art.pixels);
}

function parsePixelArt(v: Record<string, unknown>, label: string): PixelArt {
  const allowed = new Set(["palette", "pixels"]);
  for (const k of Object.keys(v)) {
    if (!allowed.has(k)) throw new Error(`Unknown ${label} field "${k}".`);
  }
  if (typeof v.palette !== "object" || v.palette === null || Array.isArray(v.palette)) {
    throw new Error(`${label}.palette must map single characters to "#rrggbb" colors.`);
  }
  const rawPal = v.palette as Record<string, unknown>;
  const keys = Object.keys(rawPal);
  if (keys.length === 0 || keys.length > MAX_PALETTE) {
    throw new Error(`${label}.palette must have 1-${MAX_PALETTE} entries.`);
  }
  const palette: Record<string, string> = {};
  for (const k of keys) {
    if (k.length !== 1 || k === "." || k === " ") {
      throw new Error(`${label}.palette keys must be single characters (not "." or space).`);
    }
    palette[k] = normHex(rawPal[k], `${label}.palette["${k}"]`);
  }
  if (!Array.isArray(v.pixels) || v.pixels.length < 1 || v.pixels.length > MAX_GRID) {
    throw new Error(`${label}.pixels must be an array of 1-${MAX_GRID} rows.`);
  }
  const width = typeof v.pixels[0] === "string" ? v.pixels[0].length : 0;
  if (width < 1 || width > MAX_GRID) {
    throw new Error(`${label}.pixels rows must be 1-${MAX_GRID} characters wide.`);
  }
  const pixels: string[] = [];
  for (let r = 0; r < v.pixels.length; r++) {
    const row: unknown = v.pixels[r];
    if (typeof row !== "string" || row.length !== width) {
      throw new Error(`${label}.pixels row ${r} must be a string of length ${width}.`);
    }
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (ch !== "." && ch !== " " && !palette[ch]) {
        throw new Error(`${label}.pixels uses "${ch}" which is not in palette.`);
      }
    }
    pixels.push(row);
  }
  return { palette, pixels };
}

export function parseArt(
  v: unknown,
  presets: readonly string[],
  label: string,
): FloatseeArt {
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed.startsWith("data:")) return validateDataUrl(trimmed, label);
    if (trimmed.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error(`${label} JSON pixel art could not be parsed.`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${label} JSON must be a { palette, pixels } object.`);
      }
      return parsePixelArt(parsed as Record<string, unknown>, label);
    }
    const low = trimmed.toLowerCase();
    if (presets.includes(low)) return low;
    throw new Error(
      `Invalid ${label} "${v}". Use a preset (${
        presets.join(", ")
      }), a { palette, pixels } grid, or a base64 PNG/SVG data URL.`,
    );
  }
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return parsePixelArt(v as Record<string, unknown>, label);
  }
  throw new Error(
    `${label} must be a preset name, a { palette, pixels } grid, or a base64 PNG/SVG data URL.`,
  );
}

/**
 * Validate and apply optional Floatsee customization fields from `join` or `customize`.
 * Returns the updated appearance and whether anything changed.
 */
export function applyFloatseeArgs(
  args: Record<string, unknown>,
  current: FloatseeAppearance,
): { appearance: FloatseeAppearance; expression?: Expression; changed: boolean } {
  const next: FloatseeAppearance = {
    head: current.head,
    colors: { ...current.colors },
    frontTee: typeof current.frontTee === "string"
      ? current.frontTee
      : { palette: { ...current.frontTee.palette }, pixels: [...current.frontTee.pixels] },
    backTee: typeof current.backTee === "string"
      ? current.backTee
      : { palette: { ...current.backTee.palette }, pixels: [...current.backTee.pixels] },
    expressions: { ...current.expressions },
  };
  let changed = false;
  let expression: Expression | undefined;

  if (args.head !== undefined && args.head !== null) {
    next.head = parseHeadShape(args.head);
    changed = true;
  }
  if (args.color_scheme !== undefined && args.color_scheme !== null) {
    next.colors = parseColorScheme(args.color_scheme, next.colors);
    changed = true;
  }
  if (args.front_image !== undefined && args.front_image !== null) {
    next.frontTee = parseArt(args.front_image, TEE_PRESETS, "front_image");
    changed = true;
  }
  if (args.back_image !== undefined && args.back_image !== null) {
    next.backTee = parseArt(args.back_image, TEE_PRESETS, "back_image");
    changed = true;
  }
  if (args.expressions !== undefined && args.expressions !== null) {
    if (
      typeof args.expressions !== "object" || Array.isArray(args.expressions)
    ) {
      throw new Error("expressions must be an object keyed by happy, sad, angry, excited.");
    }
    const raw = args.expressions as Record<string, unknown>;
    for (const [k, val] of Object.entries(raw)) {
      const mood = parseExpression(k);
      if (val === null) {
        delete next.expressions[mood];
      } else {
        next.expressions[mood] = parseArt(val, EXPRESSION_PRESETS, `expressions.${mood}`);
      }
      changed = true;
    }
  }
  if (args.expression !== undefined && args.expression !== null) {
    expression = parseExpression(args.expression);
  }
  return { appearance: next, expression, changed };
}

/** Validate a saved FloatseeAppearance or fall back cleanly to defaults. */
export function sanitizeFloatsee(raw: unknown, slot: number): FloatseeAppearance {
  const fallback = defaultFloatsee(slot);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fallback;
  const r = raw as Record<string, unknown>;
  try {
    const head = r.head !== undefined ? parseHeadShape(r.head) : fallback.head;
    const colors = r.colors !== undefined
      ? parseColorScheme(r.colors, fallback.colors)
      : fallback.colors;
    const frontTee = r.frontTee !== undefined
      ? parseArt(r.frontTee, TEE_PRESETS, "frontTee")
      : fallback.frontTee;
    const backTee = r.backTee !== undefined
      ? parseArt(r.backTee, TEE_PRESETS, "backTee")
      : fallback.backTee;
    const expressions: Partial<Record<Expression, FloatseeArt>> = {};
    if (
      typeof r.expressions === "object" && r.expressions !== null && !Array.isArray(r.expressions)
    ) {
      for (const [k, v] of Object.entries(r.expressions as Record<string, unknown>)) {
        if ((EXPRESSIONS as readonly string[]).includes(k) && v !== undefined && v !== null) {
          expressions[k as Expression] = parseArt(v, EXPRESSION_PRESETS, `expressions.${k}`);
        }
      }
    }
    return { head, colors, frontTee, backTee, expressions };
  } catch {
    return fallback;
  }
}
