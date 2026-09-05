/**
 * operations.ts — transport-neutral public library helpers.
 *
 * This file is the v2.0.0 grand-merge consolidation of the former nested
 * folders of the repository (library) into the single
 * root-level domain file of the saddle family standard: one optimized
 * TypeScript file per correlated domain, ordinal sections, JSDoc on every
 * block, intra-domain imports dissolved, cross-domain imports rewritten to
 * ./<domain>.js. Every capability of every source file is preserved here;
 * the pure re-export barrels (none in this domain) folded their surface into this file directly.
 */

import { crawl, extracthtml, normalizeresponse } from "./acquisition.js";
import { chunkmarkdown, estimatetokens } from "./intelligence.js";
import { browseragent } from "./browser.js";

/* ════════════════════════════════════════════════════════════════════ */
/* Section 1: library/public.ts — public library helpers compose fetch extraction serialization chunking and crawl contracts. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * public library helpers compose fetch extraction serialization chunking and crawl contracts.
 */

/** Selects the fetch or browser execution path. */
export async function saddleurl(url, options = {}) {
  const mode = options.mode ?? "fetch";
  if (mode === "browser") return scrapewithbrowser(url, options);
  return scrapeurl(url, options);
}

/** Fetches one URL through the caller supplied transport. */
export async function scrapeurl(url, options = {}) {
  const target = safeurl(url);
  const response = await (options.fetcher ?? fetch)(target, { signal: options.signal, headers: options.headers });
  if (!response.ok) throw new Error(`scrape request failed with ${response.status}`);
  const normalized = await normalizeresponse(response, { url: target, defaultcontenttype: "text/html", maxbytes: options.maxbytes });
  const result = normalized.kind === "html" ? scrapehtml(normalized.content, target, options) : { content: normalized.content, data: normalized.data, metadata: { url: target, contenttype: normalized.contenttype, size: normalized.size }, bytes: normalized.bytes };
  return formatresult(result, options);
}

/** Extracts a serializable result from HTML without network access. */
export function scrapehtml(html, url, options = {}) {
  const result = extracthtml(html, url);
  return { content: result.text, metadata: { url: result.url, title: result.title, description: result.description, links: result.links }, html: options.includehtml ? html : undefined };
}

/** Exposes structured extraction for callers that do not need formatting. */
export function extractcontent(html, options = {}) { return extracthtml(html, options.url); }

/** Runs a scrape through the injected browser agent contract. */
export async function scrapewithbrowser(url, options = {}) {
  const agent = browseragent(options.browser);
  await agent.navigate({ url, waituntil: options.waituntil ?? "networkidle" });
  return formatresult({ content: await agent.text(), metadata: { url, title: await agent.title(), html: options.includehtml ? await agent.html() : undefined } }, options);
}

/** Serializes a result into a supported output format. */
export function serializeresult(result, options = {}) {
  const format = options.format ?? "json";
  if (format === "json") return JSON.stringify(result, null, options.pretty ? 2 : 0);
  if (format === "text") return result.content ?? "";
  if (format === "markdown") return `# ${result.metadata?.title ?? "result"}\n\n${result.content ?? ""}`;
  if (format === "xml") return `<result><title>${escape(result.metadata?.title ?? "")}</title><content>${escape(result.content ?? "")}</content></result>`;
  if (format === "redis") return JSON.stringify({ content: result.content, metadata: result.metadata });
  throw new TypeError(`unsupported format: ${format}`);
}

/** Converts local HTML into Markdown. */
export function serializehtml(html, options = {}) { return serializeresult(scrapehtml(html, options.url), { format: "markdown" }); }

/** Builds compact context for an agent or a vector pipeline. */
export function formatforagent(result, options = {}) {
  const content = result.content ?? "";
  const chunks = chunkmarkdown(content, { maxtokens: options.maxchunksize ?? 4000 });
  const lines = content.split(/[.!?]\s+/).filter(Boolean);
  return { summary: lines.slice(0, 2).join(". "), keypoints: lines.slice(0, options.keypoints ?? 5), relevanturls: result.metadata?.links ?? [], chunks, tokencount: estimatetokens(content, options.model) };
}

/** Processes URLs in bounded groups and emits progress events. */
export async function batchscrape(options = {}) {
  const urls = options.urls ?? [];
  const concurrency = options.concurrency ?? 10;
  const results = [];
  for (let index = 0; index < urls.length; index += concurrency) {
    const group = urls.slice(index, index + concurrency);
    const completed = await Promise.all(group.map((url) => scrapeurl(url, options)));
    results.push(...completed);
    options.onprogress?.({ completed: results.length, total: urls.length });
  }
  return results;
}

/** Runs the crawler through the public scrape contract. */
export async function crawlurl(url, options = {}) { return crawl(url, { ...options, scrape: (target) => scrapeurl(target, options) }); }

function safeurl(value) { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("url must use http or https"); return url.href; }
function formatresult(result, options) { return options.format ? { ...result, serialized: serializeresult(result, options) } : result; }
function escape(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
