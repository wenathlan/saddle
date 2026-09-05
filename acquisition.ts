/**
 * acquisition.ts — scraping, crawling, proxy selection and captcha-policy
 * contracts of the engine generation.
 *
 * This file is the v2.0.0 grand-merge consolidation of the engine
 * acquisition surface (the captcha domain and the eight engine-generation
 * scrape modules: robots, cache, normalize, extract, schema, semantic,
 * crawl, scraper) into the single root-level domain file of the e2ugh
 * family standard: ordinal sections, JSDoc on every block, imports hoisted
 * and deduplicated, intra-domain imports dissolved. The whole file stays
 * free of npm dependencies (node built-ins only) so the public barrel and
 * the virtual-hardware runtime load it without node_modules — the legacy
 * webscrape toolkit generation lives in webscrape.ts.
 */
import { sha256 } from "./foundation.js";
import { transport } from "./integration.js";

/* ════════════════════════════════════════════════════════════════════ */
/* Section 1: captcha/contract.ts — captcha contracts separate detection and evidence from any solver provider. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * captcha contracts separate detection and evidence from any solver provider.
 */
export const captchatypes = Object.freeze(["hcaptcha", "turnstile", "recaptcha", "unknown"]);

export function captchacontract(options = {}) {
  const detect = options.detect ?? (() => ({ kind: "unknown", detected: false }));
  const solve = options.solve;
  return {
    async detect(context) { const result = await detect(context); return { kind: captchatypes.includes(result.kind) ? result.kind : "unknown", detected: Boolean(result.detected), sitekey: result.sitekey, evidenceurl: result.evidenceurl }; },
    async request(context) { return { status: "reviewrequired", kind: context.kind ?? "unknown", message: "captcha requires explicit human or external solver review", context }; },
    async solve(context) { if (typeof solve !== "function") return { status: "unavailable", reason: "no external solver configured" }; const result = await solve(context); return { status: result?.passed ? "passed" : "failed", passed: Boolean(result?.passed), solver: result?.solver ?? "external", token: result?.token, evidenceurl: result?.evidenceurl }; },
    assert(result) { if (!result?.passed) throw new Error("captcha assertion failed"); return result; }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 2: captcha/guard.ts — captcha guard blocks silent automation and records a review event for audit. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * captcha guard blocks silent automation and records a review event for audit.
 */
export function captchaguard(options = {}) {
  const events = [];
  return {
    async check(context) { const result = await options.contract.detect(context); if (!result.detected) return { allowed: true, result }; const event = { type: "captcha.detected", at: Date.now(), kind: result.kind, sitekey: result.sitekey }; events.push(event); return { allowed: false, result, event, action: "reviewrequired" }; },
    events() { return events.map((event) => ({ ...event })); }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 3: captcha/evidence.ts — captcha evidence stores references and hashes, never raw secrets or tokens by default. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * captcha evidence stores references and hashes, never raw secrets or tokens by default.
 */

export function evidence(options = {}) {
  const payload = options.data instanceof Uint8Array ? options.data : options.data ? new TextEncoder().encode(String(options.data)) : null;
  return { kind: options.kind ?? "unknown", passed: Boolean(options.passed), solver: options.solver ?? "manual", evidenceurl: options.evidenceurl, sha256: payload ? sha256(payload) : options.sha256, createdat: options.createdat ?? Date.now(), metadata: { ...(options.metadata ?? {}) } };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 4: scrape/robots.ts — robots context groups local rule parsing, fetch caching and active aliases. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * robots context groups local rule parsing, fetch caching and active aliases.
 */

export interface RobotsDirective { userAgent: string; allow: string[]; disallow: string[]; crawlDelay?: number; }
export interface RobotsGroup { agents: string[]; allow: string[]; disallow: string[]; delay?: number; sitemaps: string[]; }
export interface RobotsTxt { directives: RobotsDirective[]; groups: RobotsGroup[]; sitemaps: string[]; crawlDelay?: number; }

const cache = new Map<string, { robots: RobotsTxt; fetchedAt: number }>();
const cachettl = 24 * 60 * 60 * 1000;

/** Parses robots text into both historical directives and active groups. */
export function robotsrules(text = ""): RobotsTxt { const directives: RobotsDirective[] = []; const groups: RobotsGroup[] = []; const sitemaps: string[] = []; let directive: RobotsDirective | null = null; let group: RobotsGroup | null = null; for (const raw of text.split(/\r?\n/)) { const line = raw.split("#", 1)[0].trim(); if (!line) continue; const separator = line.indexOf(":"); if (separator < 0) continue; const key = line.slice(0, separator).trim().toLowerCase(); const value = line.slice(separator + 1).trim(); if (key === "user-agent") { directive = { userAgent: value, allow: [], disallow: [] }; directives.push(directive); group = { agents: [value.toLowerCase()], allow: [], disallow: [], sitemaps: [] }; groups.push(group); } else if (key === "allow" && value) { directive?.allow.push(value); group?.allow.push(value); } else if (key === "disallow" && value) { directive?.disallow.push(value); group?.disallow.push(value); } else if (key === "crawl-delay" && Number.isFinite(Number(value))) { const delay = Number(value); if (directive) directive.crawlDelay = delay; if (group) group.delay = delay; } else if (key === "sitemap" && value) { sitemaps.push(value); if (group) group.sitemaps.push(value); } } return { directives, groups, sitemaps, crawlDelay: directives.find((value) => value.crawlDelay !== undefined)?.crawlDelay }; }

/** Fetches and caches a site's robots policy without failing the caller's scrape. */
export async function fetchRobotsTxt(siteUrl: string, options: { timeout?: number; userAgent?: string } = {}): Promise<RobotsTxt> { const base = siteUrl.replace(/\/$/, ""); const robotsUrl = `${base}/robots.txt`; const cached = cache.get(robotsUrl); if (cached && Date.now() - cached.fetchedAt < cachettl) return cached.robots; try { const response = await fetch(robotsUrl, { headers: { "User-Agent": options.userAgent ?? "Saddle/2.0.0" }, signal: AbortSignal.timeout(options.timeout ?? 5000) }); const robots = response.ok ? robotsrules(await response.text()) : robotsrules(); cache.set(robotsUrl, { robots, fetchedAt: Date.now() }); return robots; } catch { const robots = robotsrules(); cache.set(robotsUrl, { robots, fetchedAt: Date.now() }); return robots; } }

/** Checks whether a URL is allowed for a selected agent. */
export function isAllowed(url: string, robots: RobotsTxt, userAgent = "*"): boolean { try { const path = new URL(url).pathname; const rules = robots.directives.filter((value) => matchagent(value.userAgent, userAgent)); return !rules.some((value) => value.disallow.some((pattern) => pattern && path.startsWith(pattern) && !value.allow.some((allowed) => allowed.length >= pattern.length && path.startsWith(allowed)))); } catch { return true; } }

/** Returns the selected agent's crawl delay. */
export function getCrawlDelay(robots: RobotsTxt, userAgent = "*"): number | undefined { return robots.directives.find((value) => matchagent(value.userAgent, userAgent))?.crawlDelay ?? robots.crawlDelay; }
export function getSitemaps(robots: RobotsTxt): string[] { return [...robots.sitemaps]; }
export function robotsallowed(rules: RobotsTxt, target: string, agent = "*"): boolean { return isAllowed(target, rules, agent); }
export function robotsdelay(rules: RobotsTxt, agent = "*"): number { return getCrawlDelay(rules, agent) ?? 0; }
function matchagent(pattern: string, userAgent: string): boolean { const normalized = pattern.toLowerCase(); const candidate = userAgent.toLowerCase(); return normalized === "*" || candidate.includes(normalized.replaceAll("*", "")); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 5: scrape/cache.ts — scrape cache context groups the active stale-aware fetch cache and the */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * scrape cache context groups the active stale-aware fetch cache and the
 * historical typed cache facade without requiring an external LRU package.
 */

export interface CacheEntry<T = unknown> {
  value: T;
  timestamp: number;
  expires?: number;
}

export interface CacheConfig {
  maxSize?: number;
  defaultTtlMs?: number;
  checkPeriodMs?: number;
}

interface StaleEntry<T = unknown> extends CacheEntry<T> {
  stale: number;
}

const defaultconfig: Required<CacheConfig> = { maxSize: 1000, defaultTtlMs: 300000, checkPeriodMs: 60000 };

/** Provides a bounded typed cache facade for historical scrape callers. */
export class WebScrapeCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly config: Required<CacheConfig>;

  constructor(config: Partial<CacheConfig> = {}) { this.config = { ...defaultconfig, ...config }; }

  get<T = unknown>(key: string): T | undefined { const entry = this.store.get(key); if (!entry) return undefined; if (entry.expires && Date.now() > entry.expires) { this.store.delete(key); return undefined; } return entry.value as T; }

  set<T = unknown>(key: string, value: T, ttlMs?: number): void { if (this.store.size >= this.config.maxSize && !this.store.has(key)) this.store.delete(this.store.keys().next().value as string); this.store.set(key, { value, timestamp: Date.now(), expires: ttlMs ? Date.now() + ttlMs : Date.now() + this.config.defaultTtlMs }); }

  has(key: string): boolean { return this.get(key) !== undefined; }
  delete(key: string): boolean { return this.store.delete(key); }
  clear(): void { this.store.clear(); }
  getOrSet<T = unknown>(key: string, factory: () => Promise<T>, ttlMs?: number): Promise<T> { const cached = this.get<T>(key); if (cached !== undefined) return Promise.resolve(cached); return factory().then((value) => { this.set(key, value, ttlMs); return value; }); }
  size(): number { return this.store.size; }
  keys(): string[] { return [...this.store.keys()]; }
}

/** Creates the historical typed cache facade. */
export function createCache(config?: Partial<CacheConfig>): WebScrapeCache { return new WebScrapeCache(config); }

/** Creates the active stale-aware fetch cache contract. */
export function ttlcache<T = unknown>(options: { ttl?: number; stale?: boolean } = {}) {
  const values = new Map<string, StaleEntry<T>>();
  const ttl = options.ttl ?? 300000;
  return {
    get(key: string): T | null { const item = values.get(key); if (!item) return null; const now = Date.now(); if (now > item.expires) { if (now > item.stale) values.delete(key); return options.stale ? item.value : null; } return item.value; },
    set(key: string, value: T, valueoptions: { ttl?: number; stale?: number } = {}): T { const now = Date.now(); values.set(key, { value, timestamp: now, expires: now + (valueoptions.ttl ?? ttl), stale: now + (valueoptions.stale ?? ttl * 2) }); return value; },
    delete(key: string): void { values.delete(key); },
    clear(): void { values.clear(); },
    size(): number { return values.size; }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 6: scrape/normalize.ts — content normalization classifies bounded response bytes without owning a parser, transport or storage backend. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * content normalization classifies bounded response bytes without owning a parser, transport or storage backend.
 */

const extensions = Object.freeze({
  ".json": "application/json",
  ".map": "application/json",
  ".xml": "application/xml",
  ".rss": "application/rss+xml",
  ".atom": "application/atom+xml",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".txt": "text/plain",
  ".csv": "text/csv"
});

/** Detects a normalized media type from a header, URL suffix or caller fallback. */
export function detectcontenttype(header, url, fallback = "application/octet-stream") {
  const value = String(header ?? "").split(";", 1)[0].trim().toLowerCase();
  if (value) return value;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const suffix = Object.keys(extensions).find((extension) => pathname.endsWith(extension));
    if (suffix) return extensions[suffix];
  } catch { /* invalid or absent URLs remain caller-owned metadata */ }
  return String(fallback).toLowerCase();
}

/** Normalizes bounded input bytes into a serializable text, JSON or binary result. */
export function normalizeresult(input, options = {}) {
  const contenttype = detectcontenttype(options.contenttype, options.url, options.defaultcontenttype ?? "application/octet-stream");
  const bytes = tobytes(input);
  const maxbytes = boundedlimit(options.maxbytes, 2_000_000);
  if (bytes.byteLength > maxbytes) throw normalizationerror("CONTENT_TOO_LARGE", `content exceeds ${maxbytes} bytes`);
  const kind = contentkind(contenttype);
  if (kind === "binary") return { contenttype, kind, size: bytes.byteLength, bytes };
  const text = new TextDecoder(options.charset ?? "utf-8", { fatal: false }).decode(bytes).replaceAll("\r\n", "\n");
  if (text.length > boundedlimit(options.maxtext, maxbytes)) throw normalizationerror("TEXT_TOO_LARGE", "decoded content exceeds the configured text limit");
  if (kind === "json") {
    try { return { contenttype, kind, size: bytes.byteLength, content: text, data: JSON.parse(text) }; } catch (error) { throw normalizationerror("INVALID_JSON", `invalid JSON content: ${error.message}`); }
  }
  return { contenttype, kind, size: bytes.byteLength, content: text };
}

/** Reads a caller-provided response body after checking declared and actual size limits. */
export async function normalizeresponse(response, options = {}) {
  if (!response || typeof response !== "object") throw new TypeError("response is required");
  const headers = response.headers;
  const header = typeof headers?.get === "function" ? headers.get("content-type") : headers?.["content-type"];
  const declared = Number(typeof headers?.get === "function" ? headers.get("content-length") : headers?.["content-length"]);
  const maxbytes = boundedlimit(options.maxbytes, 2_000_000);
  if (Number.isFinite(declared) && declared > maxbytes) throw normalizationerror("CONTENT_TOO_LARGE", `content exceeds ${maxbytes} bytes`);
  const body = typeof response.arrayBuffer === "function" ? await response.arrayBuffer() : await response.text();
  return normalizeresult(body, { ...options, contenttype: header ?? options.contenttype, url: options.url ?? response.url });
}

function contentkind(contenttype) {
  if (contenttype === "application/json" || contenttype.endsWith("+json")) return "json";
  if (contenttype === "text/html" || contenttype === "application/xhtml+xml") return "html";
  if (contenttype === "application/xml" || contenttype === "text/xml" || contenttype.endsWith("+xml")) return "xml";
  if (contenttype === "text/markdown") return "markdown";
  if (contenttype.startsWith("text/")) return "text";
  return "binary";
}

function tobytes(input) {
  if (typeof input === "string") return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError("content must be a string, ArrayBuffer or typed array");
}

function boundedlimit(value, fallback) {
  const limit = Number(value ?? fallback);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("content limit must be a positive safe integer");
  return limit;
}

function normalizationerror(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 7: scrape/extract.ts — scrape extraction context groups dependency-free HTML extraction and the */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * scrape extraction context groups dependency-free HTML extraction and the
 * historical structured extraction facade under one TypeScript contract.
 */

export interface LinkInfo { href: string; text: string; isInternal: boolean; isExternal: boolean; }
export interface ImageInfo { src: string; alt: string; width?: number; height?: number; }
export interface TableInfo { headers: string[]; rows: string[][]; caption?: string; }
export interface PageMetadata { title: string; description?: string; favicon?: string; charset?: string; language?: string; author?: string; publishedDate?: string; ogImage?: string; ogType?: string; keywords?: string[]; }
export interface ExtractOptions { readable?: boolean; preserveLinks?: boolean; preserveImages?: boolean; preserveTables?: boolean; removeSelectors?: string[]; maxLength?: number; }
export interface ExtractedContent { content: string; text: string; links: LinkInfo[]; images: ImageInfo[]; tables: TableInfo[]; metadata: PageMetadata; jsonLd: unknown[]; }

/** Extracts the compact active scrape result without a DOM dependency. */
export function extracthtml(html: string, url?: string) { const title = match(html, /<title[^>]*>([\s\S]*?)<\/title>/i); const description = match(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ?? match(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i); const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)].map((item) => resolveurl(item[1], url)).filter((value): value is string => Boolean(value)); const text = htmltotext(html); return { url, title: decode(title ?? ""), description: decode(description ?? ""), text, links: [...new Set(links)] }; }

/** Extracts structured content for historical TypeScript callers. */
export async function extractContent(html: string, options: ExtractOptions = {}): Promise<ExtractedContent> {
  let source = html;
  for (const selector of options.removeSelectors ?? []) source = removeSelector(source, selector);
  const metadata = extractmetadata(source);
  const text = options.readable ? readabletext(source) : htmltotext(source);
  const content = options.maxLength ? text.slice(0, options.maxLength) : text;
  return { content, text, links: options.preserveLinks === false ? [] : extractlinks(source), images: options.preserveImages === false ? [] : extractimages(source), tables: options.preserveTables === false ? [] : extracttables(source), metadata, jsonLd: extractjsonld(source) };
}

/** Extracts readable page text from a document string. */
export async function extractReadable(html: string): Promise<string> { return (await extractContent(html, { readable: true })).content; }

function match(value: string, expression: RegExp): string | undefined { return value.match(expression)?.[1]?.trim(); }
function decode(value: string): string { return value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'"); }
function resolveurl(value: string, base?: string): string | null { try { const parsed = new URL(value, base); return parsed.pathname === "/" && !parsed.search && !parsed.hash ? `${parsed.protocol}//${parsed.host}` : parsed.href; } catch { return null; } }
function htmltotext(html: string): string { return decode(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()); }
function readabletext(html: string): string { const selectors = [/ <article[\s\S]*?<\/article>/i, /<main[\s\S]*?<\/main>/i, /<body[\s\S]*?<\/body>/i]; for (const selector of selectors) { const matchvalue = html.match(selector)?.[0]; if (matchvalue) return htmltotext(matchvalue); } return htmltotext(html); }
function extractmetadata(html: string): PageMetadata { return { title: match(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? match(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i) ?? "", description: matchmeta(html, "description") ?? matchmeta(html, "og:description"), favicon: match(html, /<link[^>]+rel=["'](?:icon|shortcut icon)["'][^>]+href=["']([^"']*)["']/i), language: match(html, /<html[^>]+lang=["']([^"']*)["']/i), author: matchmeta(html, "author"), ogImage: matchmeta(html, "og:image"), ogType: matchmeta(html, "og:type"), keywords: matchmeta(html, "keywords")?.split(",").map((value) => value.trim()) }; }
function matchmeta(html: string, name: string): string | undefined { return match(html, new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']`, "i")) ?? match(html, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`, "i")); }
function extractlinks(html: string): LinkInfo[] { return [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((item) => ({ href: resolveurl(item[1]) ?? item[1], text: htmltotext(item[2]).slice(0, 200), isInternal: false, isExternal: true })); }
function extractimages(html: string): ImageInfo[] { return [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)].map((item) => ({ src: item[1], alt: match(item[0], /alt=["']([^"']*)["']/i) ?? "", width: numberattribute(item[0], "width"), height: numberattribute(item[0], "height") })); }
function numberattribute(value: string, name: string): number | undefined { const parsed = Number(match(value, new RegExp(`${name}=["'](\\d+)["']`, "i"))); return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined; }
function extracttables(html: string): TableInfo[] { return [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((table) => { const source = table[0]; const body = source.match(/<tbody[^>]*>[\s\S]*?<\/tbody>/i)?.[0] ?? source; return { headers: [...source.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((item) => htmltotext(item[1])), rows: [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((item) => htmltotext(item[1]))).filter((row) => row.length) }; }); }
function extractjsonld(html: string): unknown[] { const values: unknown[] = []; for (const item of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) try { values.push(JSON.parse(item[1])); } catch { /* malformed structured data remains non fatal */ } return values; }
function removeSelector(html: string, selector: string): string { const tag = selector.match(/^\s*([a-z][a-z0-9]*)\s*$/i)?.[1]; if (tag) return html.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\/${tag}>`, "gi"), ""); const className = selector.match(/^\.([a-z0-9_-]+)$/i)?.[1]; return className ? html.replace(new RegExp(`<([a-z][a-z0-9]*)[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/\\1>`, "gi"), "") : html; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 8: scrape/schema.ts — schema extraction accepts safe field descriptors and never evaluates source strings. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * schema extraction accepts safe field descriptors and never evaluates source strings.
 */
export function extractwithschema(html, schema = {}, url) {
  const result = {};
  for (const [name, descriptor] of Object.entries(schema)) result[name] = extractfield(html, descriptor, url);
  return result;
}

/** Extracts schema fields with bounded payload and field-level source provenance. */
export function extractstructured(html, schema = {}, options = {}) {
  if (typeof html !== "string") throw new TypeError("structured extraction requires html text");
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new TypeError("structured extraction requires a schema object");
  if (options.parser !== undefined && typeof options.parser !== "function") throw new TypeError("structured extraction parser must be a function");
  const sourceurl = String(options.url ?? "");
  const extractedat = String(options.extractedat ?? new Date(Number(options.now ?? Date.now())).toISOString());
  const maxbytes = normalizebound(options.maxbytes ?? 65536, "maxbytes");
  const parser = options.parser ?? ((input) => extractwithschema(input.html, input.schema, input.url));
  const values = parser({ html, schema, url: sourceurl });
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new TypeError("structured extraction parser must return an object");
  const bounded = boundpayload(values, maxbytes);
  const provenance = Object.fromEntries(Object.entries(schema).map(([name, descriptor]) => [name, {
    sourceurl,
    selector: descriptorselector(descriptor),
    extractedat,
    truncated: bounded.truncated.includes(name)
  }]));
  return { version: 1, sourceurl, extractedat, values: bounded.values, provenance, bytes: bounded.bytes, maxbytes, truncated: bounded.truncated };
}

function extractfield(html, descriptor, url) {
  if (typeof descriptor === "function") return descriptor({ html, url });
  if (typeof descriptor === "string") return textfromselector(html, descriptor);
  if (!descriptor || typeof descriptor.selector !== "string") throw new TypeError("schema field requires selector or function");
  if (descriptor.selector === "title") return html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
  const escaped = descriptor.selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attribute = descriptor.attribute;
  const pattern = attribute ? new RegExp(`<[^>]+${escaped}[^>]*${attribute}=["']([^"']+)["'][^>]*>`, "i") : new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i");
  return pattern.exec(html)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? null;
}

function textfromselector(html, selector) { return extractfield(html, { selector }); }

function descriptorselector(descriptor) { return typeof descriptor === "string" ? descriptor : typeof descriptor === "function" ? "function" : String(descriptor?.selector ?? "unknown"); }

function normalizebound(value, name) { const normalized = Number(value); if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new RangeError(`${name} must be a positive safe integer`); return normalized; }

function boundpayload(values, maxbytes) {
  const bounded = {};
  const truncated = [];
  for (const [name, value] of Object.entries(values)) {
    const candidate = JSON.stringify({ ...bounded, [name]: value });
    if (byteLength(candidate) <= maxbytes) { bounded[name] = value; continue; }
    if (typeof value === "string") {
      const clipped = clipstring(value, (trial) => byteLength(JSON.stringify({ ...bounded, [name]: trial })) <= maxbytes);
      bounded[name] = clipped;
    } else {
      bounded[name] = null;
    }
    truncated.push(name);
  }
  const bytes = byteLength(JSON.stringify(bounded));
  if (bytes > maxbytes) throw new RangeError("structured extraction payload budget is too small");
  return { values: bounded, bytes, truncated };
}

function clipstring(value, fits) {
  let low = 0;
  let high = value.length;
  let result = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = value.slice(0, middle);
    if (fits(candidate)) { result = candidate; low = middle + 1; } else high = middle - 1;
  }
  return result;
}

function byteLength(value) { return new TextEncoder().encode(String(value)).byteLength; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 9: scrape/semantic.ts — semantic extraction exposes bounded headings, landmarks, controls and links without evaluating page code. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * semantic extraction exposes bounded headings, landmarks, controls and links without evaluating page code.
 */

/** Extracts semantic page facts from HTML using safe built-in parsing heuristics. */
export function extractsemantic(html, url) {
  const source = String(html ?? "");
  const headings = [...source.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].slice(0, 100).map((match) => ({ level: Number(match[1]), text: clean(match[2]) })).filter((item) => item.text);
  const landmarks = [...source.matchAll(/<(main|nav|header|footer|aside|section|article)\b([^>]*)>/gi)].slice(0, 100).map((match) => ({ role: match[1].toLowerCase(), label: attribute(match[2], "aria-label") ?? attribute(match[2], "id") ?? "" }));
  const controls = [...source.matchAll(/<(button|input|textarea|select|a)\b([^>]*)>([\s\S]*?)<\/\1>|<(input)\b([^>]*)\/?\s*>/gi)].slice(0, 200).map((match, index) => {
    const tag = (match[1] ?? match[4]).toLowerCase();
    const attrs = match[2] ?? match[5] ?? "";
    return { ref: `e${index + 1}`, role: attribute(attrs, "role") ?? tag, name: attribute(attrs, "aria-label") ?? attribute(attrs, "placeholder") ?? clean(match[3] ?? ""), type: attribute(attrs, "type") };
  });
  const links = [...source.matchAll(/<a\b([^>]*)href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].slice(0, 500).map((match) => ({ url: resolveurlhelper(match[2], url), text: clean(match[3]), rel: attribute(match[1], "rel") })).filter((link) => link.url);
  return { url, title: clean(source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""), headings, landmarks, controls, links: dedupe(links, (item) => item.url), semantictext: clean(source.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).slice(0, 100000) };
}

function clean(value) { return String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").trim(); }
function attribute(value, name) { return value.match(new RegExp(`${name}=["']([^"']*)["']`, "i"))?.[1] ?? null; }
function resolveurlhelper(value, base) { try { return new URL(value, base).href; } catch { return null; } }
function dedupe(values, key) { const seen = new Set(); return values.filter((value) => { const item = key(value); if (seen.has(item)) return false; seen.add(item); return true; }); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 10: scrape/crawl.ts — scrape crawl context owns URL normalization traversal frontier and durable crawl state. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * scrape crawl context owns URL normalization traversal frontier and durable crawl state.
 *
 * The context keeps single page acquisition injectable while grouping the correlated
 * crawl responsibilities that previously lived in four separate top level files.
 */

/** Removes fragments and tracking parameters before crawl deduplication. */
export function normalizeurl(value) {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|msclkid$|gclid$|gclsrc$|dclid$|gbraid$|wbraid$|twclid$|campaign$|content$|term$|source$|medium$|ref$|share_id$)/i.test(key)) url.searchParams.delete(key);
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

/** Compares two crawl targets by origin. */
export function sameorigin(left, right) { return new URL(left).origin === new URL(right).origin; }

/** Creates a bounded priority frontier for crawler and queue adapters. */
export function crawlfrontier(options = {}) {
  const maxpages = Number(options.maxpages ?? 20);
  const maxperdomain = Number(options.maxperdomain ?? maxpages);
  const queue = [];
  const seen = new Set();
  const completed = new Set();
  const domains = new Map();

  /** Adds a URL once while respecting the global page budget. */
  function add(input = {}) {
    const url = String(input.url ?? "");
    if (!url || seen.has(url) || seen.size >= maxpages) return false;
    seen.add(url);
    queue.push({ url, depth: Number(input.depth ?? 0), priority: Number(input.priority ?? 0), discoveredat: Number(input.discoveredat ?? Date.now()) });
    queue.sort((left, right) => right.priority - left.priority || left.discoveredat - right.discoveredat);
    return true;
  }

  /** Removes the next URL that still fits its per-domain budget. */
  function next() {
    while (queue.length) {
      const item = queue.shift();
      const domain = new URL(item.url).hostname;
      if ((domains.get(domain) ?? 0) >= maxperdomain) continue;
      domains.set(domain, (domains.get(domain) ?? 0) + 1);
      return { ...item };
    }
    return null;
  }

  /** Records a completed URL for diagnostics and persistence-friendly state. */
  function complete(url) { completed.add(String(url)); }

  /** Returns stable frontier diagnostics without exposing mutable collections. */
  function state() { return { maxpages, maxperdomain, queued: queue.length, discovered: seen.size, completed: completed.size, domains: Object.fromEntries(domains) }; }

  return { add, next, complete, state, list() { return queue.map((item) => ({ ...item })); } };
}

/** Creates a durable crawl queue around a caller-owned store. */
export function persistentqueue(options = {}) {
  const store = options.store;
  const values = [];
  const seen = new Set();

  /** Restores unfinished crawl records from the injected store. */
  async function restore() { if (typeof store?.list !== "function") return; for (const item of await store.list()) if (!seen.has(item.url) && item.status !== "done") { seen.add(item.url); values.push(item); } }

  /** Adds a crawl record and persists it when the store supports writes. */
  async function add(item) { if (!item?.url || seen.has(item.url)) return false; const value = { url: item.url, depth: item.depth ?? 0, status: "queued", createdat: Date.now(), metadata: item.metadata ?? {} }; seen.add(value.url); values.push(value); if (typeof store?.save === "function") await store.save(value); return true; }

  /** Claims the next queued crawl record. */
  async function next() { const item = values.find((value) => value.status === "queued"); if (!item) return null; item.status = "running"; if (typeof store?.update === "function") await store.update(item.url, item); return item; }

  /** Completes a crawl record and persists the resulting status. */
  async function complete(url, patch = {}) { const item = values.find((value) => value.url === url); if (!item) return null; Object.assign(item, patch, { status: patch.status ?? "done", processedat: Date.now() }); if (typeof store?.update === "function") await store.update(url, item); return item; }

  return { restore, add, next, complete, list() { return values.map((value) => ({ ...value })); } };
}

/** Runs bounded breadth first traversal through the injected single page scrape contract. */
export async function crawl(start, options = {}) {
  const maxdepth = options.maxdepth ?? 1;
  const maxpages = options.maxpages ?? 20;
  const sameDomain = options.samedomain ?? true;
  const frontier = crawlfrontier({ maxpages, maxperdomain: options.maxperdomain ?? maxpages });
  frontier.add({ url: normalizeurl(start), depth: 0, priority: options.startpriority ?? 0 });
  const results = [];
  while (frontier.state().queued && results.length < maxpages) {
    const current = frontier.next();
    if (!current || current.depth > maxdepth) continue;
    const result = await options.scrape(current.url);
    results.push({ ...result, depth: current.depth });
    frontier.complete(current.url);
    if (current.depth >= maxdepth) continue;
    for (const link of result.links ?? []) {
      let url;
      try { url = normalizeurl(link); } catch { continue; }
      if (sameDomain && !sameorigin(start, url)) continue;
      frontier.add({ url, depth: current.depth + 1, priority: Number(options.priority?.(url, result) ?? 0) });
    }
  }
  return { results, stats: { ...frontier.state(), completed: results.length, maxdepth, maxpages } };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 11: scrape/scraper.ts — scraper composes robots policy cache transport and extraction without browser assumptions. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * scraper composes robots policy cache transport and extraction without browser assumptions.
 */

export function scraper(options = {}) {
  const client = options.transport ?? transport({ fetcher: options.fetcher, timeout: options.timeout, attempts: options.attempts });
  const cache = options.cache ?? ttlcache(options.cacheoptions);
  const agent = options.agent ?? "*";
  const policies = new Map();
  return {
    async robots(origin) {
      if (policies.has(origin)) return policies.get(origin);
      const url = new URL("/robots.txt", origin).href;
      const response = await client.request(url);
      const rules = robotsrules(response.ok ? await response.text() : "");
      policies.set(origin, rules);
      return rules;
    },
    async scrape(url) {
      const target = new URL(url);
      if (!["http:", "https:"].includes(target.protocol)) throw new TypeError("scraper accepts http and https only");
      const rules = await this.robots(target.origin);
      if (!robotsallowed(rules, target.href, agent)) throw new Error("robots policy disallows target");
      const cached = cache.get(target.href);
      if (cached) return cached;
      const wait = robotsdelay(rules, agent);
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      const response = await client.request(target.href, { headers: options.headers });
      if (!response.ok) throw new Error(`scrape request failed with ${response.status}`);
      const result = extracthtml(await response.text(), target.href);
      cache.set(target.href, result, { ttl: options.ttl });
      return result;
    },
    cache
  };
}

