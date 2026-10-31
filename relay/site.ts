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
