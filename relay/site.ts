/**
 * The site's own address in its static files. Search engines, link previews and agents need
 * absolute URLs (the canonical link, the social card, the sitemap, robots.txt's Sitemap line,
 * llms.txt's MCP endpoint), but the site doesn't know its address until it's served: workers.dev, a
 * custom domain, `wrangler dev` or localhost. So those files write `{{origin}}` and whoever serves
 * them fills it in: the Worker in production (`relay/worker.ts`, which runs first for exactly these
 * paths: `run_worker_first` in `wrangler.jsonc`), `tools/serve.ts` in dev. A deploy needs no
 * setting; the Worker var `SITE_URL` pins one canonical address once the site answers on several.
 */

/** What the site's files write where their absolute address goes. */
export const ORIGIN_MARK = "{{origin}}";
/** The mark as found: `deno fmt` spaces it out in some places (`{{ origin }}` in XML text). */
const MARK = /\{\{\s*origin\s*\}\}/;
const MARKS = new RegExp(MARK.source, "g");

/** Whether a file names the site's address. */
export const hasOriginMark = (text: string) => MARK.test(text);

/** The paths whose files carry the mark (each must be in `run_worker_first`, a test checks). */
export const SITE_PAGES = ["/", "/robots.txt", "/sitemap.xml", "/llms.txt"];

/**
 * The headers `web/_headers` gives every static file (a test keeps the two the same). Responses the
 * Worker makes itself don't get `_headers`, so it sets these on the pages it fills in.
 */
export const SITE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/**
 * The address to write into the pages: `pinned` (the `SITE_URL` var) when it's a valid http(s)
 * URL, else the address the request came in on. Always an origin, with no trailing slash.
 */
export function siteOrigin(requestUrl: string, pinned?: string): string {
  if (pinned) {
    try {
      const url = new URL(pinned);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch { /* not a URL: fall back to the request's own */ }
  }
  return new URL(requestUrl).origin;
}

/** A site file's text with its address filled in. */
export const withOrigin = (text: string, origin: string) => text.replace(MARKS, () => origin);

/**
 * The site's Markdown for agents (llmstxt.org): what this is and how to connect and play. The home
 * page advertises it as its Markdown alternate, and answers with it when a request prefers Markdown.
 */
export const MARKDOWN_PAGE = "/llms.txt";

/**
 * What the home page adds to its headers, whichever form it answers in: where its Markdown is, and
 * that the answer depends on `Accept` (so caches never hand an agent's Markdown to a browser).
 */
export const HOME_HEADERS: Readonly<Record<string, string>> = {
  Link: `<${MARKDOWN_PAGE}>; rel="alternate"; type="text/markdown"`,
  Vary: "Accept",
};

/** The content type the home page's Markdown answers with. */
export const MARKDOWN_TYPE = "text/markdown; charset=utf-8";

/**
 * Whether an `Accept` header asks for Markdown over HTML: it names `text/markdown` with a quality
 * above zero, at least as high as `text/html`'s. Browsers never name Markdown, so they get the page.
 */
export function wantsMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  let markdown = 0, html = 0;
  for (const range of accept.slice(0, 1024).split(",")) {
    const [type, ...params] = range.split(";").map((s) => s.trim().toLowerCase());
    const qParam = params.find((p) => p.startsWith("q="));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    if (!(q >= 0 && q <= 1)) continue;
    if (type === "text/markdown") markdown = Math.max(markdown, q);
    else if (type === "text/html") html = Math.max(html, q);
  }
  return markdown > 0 && markdown >= html;
}

/**
 * What an MCP client gets at `/mcp` or a malformed world link: not a bare 404, but where world
 * links come from and where the instructions are, so an agent that guessed the endpoint can tell
 * its person what to do.
 */
export const noWorldText = (origin: string) =>
  "No world here. Each world has its own MCP link, " + `${origin}/mcp/<code>` +
  " (a 22-character code), shown on the game's connect card: ask the person whose world it is. " +
  `How to connect and play: ${origin}${MARKDOWN_PAGE}`;
