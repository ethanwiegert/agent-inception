import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import {
  hasOriginMark,
  ORIGIN_MARK,
  SITE_HEADERS,
  SITE_PAGES,
  siteOrigin,
  withOrigin,
} from "./site.ts";
import worker from "./worker.ts";
import { mcpTools } from "../src/sim/tools.ts";

const repo = (path: string) => new URL(`../${path}`, import.meta.url);
const read = (path: string) => Deno.readTextFileSync(repo(path));
/** A site path's file in `web/`. */
const webFile = (page: string) => `web${page === "/" ? "/index.html" : page}`;

Deno.test("site: the address is the pinned one if it's valid, else the request's", () => {
  const req = "https://agent-inception.someone.workers.dev/llms.txt?x=1";
  assertEquals(siteOrigin(req), "https://agent-inception.someone.workers.dev");
  assertEquals(siteOrigin(req, "https://example.com/some/path"), "https://example.com");
  for (const bad of ["", "example.com", "javascript:alert(1)", "ftp://example.com"]) {
    assertEquals(siteOrigin(req, bad), "https://agent-inception.someone.workers.dev", bad);
  }
  assertEquals(
    withOrigin(`a ${ORIGIN_MARK}/x {{ origin }}/y $&`, "https://e.com"),
    "a https://e.com/x https://e.com/y $&",
  );
});

Deno.test("site: exactly the pages the Worker fills in carry the address mark", () => {
  for (const page of SITE_PAGES) assert(hasOriginMark(read(webFile(page))), page);
  // Any other file with the mark would be served unfilled in production.
  const filled = new Set(SITE_PAGES.map(webFile));
  const walk = (dir: string) => {
    for (const e of Deno.readDirSync(repo(dir))) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory) walk(path);
      else if (/\.(html|txt|xml|json|js|css|svg)$/.test(e.name) && !filled.has(path)) {
        assert(!hasOriginMark(read(path)), `${path} has ${ORIGIN_MARK} but isn't filled in`);
      }
    }
  };
  walk("web");
  // And Cloudflare runs the Worker first for exactly those paths (else it serves the raw file).
  const first = read("wrangler.jsonc").match(/"run_worker_first":\s*(\[[^\]]*\])/);
  assert(first, "wrangler.jsonc has run_worker_first");
  assertEquals(JSON.parse(first[1]), SITE_PAGES);
});

Deno.test("site: filled-in pages carry the same security headers as web/_headers", () => {
  const block = read("web/_headers").split("\n/*\n")[1];
  const headers = Object.fromEntries(
    block.split("\n").filter((l) => /^\s+\S/.test(l)).map((l) => {
      const [name, ...value] = l.trim().split(": ");
      return [name, value.join(": ")];
    }),
  );
  assertEquals(headers, SITE_HEADERS);
});

/** The Worker with a fake asset store holding `files`, and the requests it saw. */
function site(files: Record<string, string>, siteUrl?: string) {
  const seen: Request[] = [];
  const env = {
    SITE_URL: siteUrl,
    ROOMS: {
      idFromName: () => null,
      get: () => ({ fetch: () => Promise.resolve(new Response("room")) }),
    },
    ASSETS: {
      fetch(req: Request) {
        seen.push(req);
        const path = new URL(req.url).pathname;
        if (path === "/index.html") return Promise.resolve(new Response(null, { status: 307 }));
        const body = files[path];
        if (body === undefined) return Promise.resolve(new Response("nope", { status: 404 }));
        return Promise.resolve(
          new Response(body, {
            headers: { "content-type": "text/plain", etag: '"abc"', "content-length": "999" },
          }),
        );
      },
    },
  };
  const get = (path: string, init?: RequestInit) =>
    worker.fetch(new Request(`https://w.example${path}`, init), env as never);
  return { get, seen };
}

Deno.test("worker: fills in the site's address on its pages, with the site's headers", async () => {
  const { get, seen } = site({
    "/llms.txt": `MCP: ${ORIGIN_MARK}/mcp/<code>`,
    "/main.js": `"${ORIGIN_MARK}"`,
  });
  const res = await get("/llms.txt");
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "MCP: https://w.example/mcp/<code>");
  assertEquals(res.headers.get("content-type"), "text/plain");
  assertEquals(res.headers.get("etag"), null);
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  assertEquals(res.headers.get("content-security-policy"), "frame-ancestors 'none'");
  // HEAD asks the store for the file and answers without a body.
  const head = await get("/llms.txt", { method: "HEAD" });
  assertEquals([head.status, await head.text()], [200, ""]);
  assertEquals(seen.at(-1)!.method, "GET");
  // Other files go straight through, untouched.
  assertEquals(await (await get("/main.js")).text(), `"${ORIGIN_MARK}"`);
  // Redirects and misses pass through as they are.
  assertEquals((await get("/index.html")).status, 307);
  assertEquals((await get("/sitemap.xml")).status, 404);
});

Deno.test("worker: SITE_URL pins the canonical address", async () => {
  const { get } = site(
    { "/": `<link rel="canonical" href="${ORIGIN_MARK}/">` },
    "https://ai.example",
  );
  assertEquals(await (await get("/")).text(), `<link rel="canonical" href="https://ai.example/">`);
});

Deno.test("site: the page tells search engines, previews and agents what this is", () => {
  const html = withOrigin(read("web/index.html"), "https://e.example");
  for (
    const tag of [
      /<title>agent-inception[^<]+<\/title>/,
      /<meta\s+name="description"\s+content="[^"]{50,160}"/,
      /<link rel="canonical" href="https:\/\/e\.example\/"/,
      /<meta property="og:image" content="https:\/\/e\.example\/og\.jpg"/,
      /<meta name="twitter:card" content="summary_large_image"/,
      /<link rel="describedby" href="\/llms\.txt"/,
    ]
  ) assert(tag.test(html), String(tag));
  // The structured data is valid JSON (a typo would silently drop it).
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert(ld, "has JSON-LD");
  assertEquals(JSON.parse(ld[1]).url, "https://e.example/");
  // The files it points at exist.
  for (const file of ["og.jpg", "favicon.svg", "apple-touch-icon.png", "llms.txt"]) {
    assert(Deno.statSync(repo(`web/${file}`)).isFile, file);
  }
});

Deno.test("site: llms.txt follows llmstxt.org, names every tool and links real files", () => {
  const text = read("web/llms.txt");
  // An H1 with the name, then a blockquote summary.
  assert(/^# agent-inception\n\n> \S/.test(text));
  for (const { name } of mcpTools()) assert(text.includes(`\`${name}\``), `llms.txt names ${name}`);
  // H2 sections are file lists: each item a markdown link, then optional notes.
  const sections = text.split(/^## /m).slice(1);
  assert(sections.some((s) => s.startsWith("Optional\n")), "has an Optional section");
  const raw = "https://raw.githubusercontent.com/ethanwiegert/agent-inception/main/";
  for (const section of sections) {
    for (const line of section.split("\n").slice(1).filter((l) => l.trim())) {
      const link = line.match(/^- \[[^\]]+\]\(([^)]+)\)(: .+)?$/);
      assert(link, `file list item: ${line}`);
      // Links into this repo point at files that exist (renaming one breaks the test, not agents).
      if (link[1].startsWith(raw)) {
        const path = link[1].slice(raw.length);
        assert(Deno.statSync(repo(path)).isFile, path);
      }
    }
  }
});
