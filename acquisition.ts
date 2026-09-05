/**
 * acquisition.ts — scraping, crawling, proxy selection and captcha-policy contracts.
 *
 * This file is the v2.0.0 grand-merge consolidation of the former nested
 * folders of the repository (captcha, scrape) into the single
 * root-level domain file of the e2ugh family standard: one optimized
 * TypeScript file per correlated domain, ordinal sections, JSDoc on every
 * block, intra-domain imports dissolved, cross-domain imports rewritten to
 * ./<domain>.js. Every capability of every source file is preserved here;
 * the pure re-export barrels (scrape/index.ts) folded their surface into this file directly.
 */

import { sha256 } from "./foundation.js";
import { transport } from "./integration.js";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { spawn } from "node:child_process";
import { createServer as createnodeserver } from "node:http";
import type Emittery from "emittery";
import type { ChildProcess } from "node:child_process";
import type { Browser, BrowserContext, Page } from "playwright";

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
export async function fetchRobotsTxt(siteUrl: string, options: { timeout?: number; userAgent?: string } = {}): Promise<RobotsTxt> { const base = siteUrl.replace(/\/$/, ""); const robotsUrl = `${base}/robots.txt`; const cached = cache.get(robotsUrl); if (cached && Date.now() - cached.fetchedAt < cachettl) return cached.robots; try { const response = await fetch(robotsUrl, { headers: { "User-Agent": options.userAgent ?? "Saddle/1.8.19" }, signal: AbortSignal.timeout(options.timeout ?? 5000) }); const robots = response.ok ? robotsrules(await response.text()) : robotsrules(); cache.set(robotsUrl, { robots, fetchedAt: Date.now() }); return robots; } catch { const robots = robotsrules(); cache.set(robotsUrl, { robots, fetchedAt: Date.now() }); return robots; } }

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

/* ════════════════════════════════════════════════════════════════════ */
/* Section 12: scrape/types.ts */
/* ════════════════════════════════════════════════════════════════════ */
export const ScrapeFormatSchema = z.enum(['markdown', 'html', 'text', 'json', 'xml', 'redis']);
export type ScrapeFormat = z.infer<typeof ScrapeFormatSchema>;

export const SerializeTargetSchema = z.enum(['markdown', 'xml', 'json', 'redis', 'text']);
export type SerializeTarget = z.infer<typeof SerializeTargetSchema>;

export const ScrapeOptionsSchema = z.strictObject({
  url: z.string().url().optional(),
  html: z.string().optional(),
  mode: z.enum(['auto', 'fetch', 'browser']).prefault('auto').optional(),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).prefault('networkidle').optional(),
  timeout: z.number().positive().prefault(30000).optional(),
  scroll: z.boolean().prefault(false).optional(),
  scrollDelay: z.number().nonnegative().prefault(300).optional(),
  maxScrolls: z.number().positive().prefault(50).optional(),
  removeSelectors: z.array(z.string()).prefault([]).optional(),
  extractImages: z.boolean().prefault(true).optional(),
  extractLinks: z.boolean().prefault(true).optional(),
  extractTables: z.boolean().prefault(true).optional(),
  maxContentLength: z.number().positive().optional(),
  format: ScrapeFormatSchema.prefault('markdown').optional(),
  language: z.string().optional(),
  proxy: z.string().optional(),
  retries: z.number().nonnegative().prefault(3).optional(),
  retryDelay: z.number().positive().prefault(1000).optional(),
  userAgent: z.string().optional(),
  headers: z.record(z.string(), z.string()).prefault({}).optional(),
  cache: z.boolean().prefault(false).optional(),
  cacheTtlMs: z.number().positive().prefault(300000).optional(),
  readable: z.boolean().optional(),
});
export type ScrapeOptions = z.infer<typeof ScrapeOptionsSchema>;

export interface ScrapeResult {
  url: string;
  title: string;
  content: string;
  format: ScrapeFormat;
  text: string;
  links: LegacyLinkInfo[];
  images: LegacyImageInfo[];
  tables: LegacyTableInfo[];
  metadata: LegacyPageMetadata;
  extractedAt: string;
  duration: number;
  size: number;
}

export interface LegacyPageMetadata {
  title: string;
  description?: string;
  favicon?: string;
  charset?: string;
  language?: string;
  author?: string;
  publishedDate?: string;
  ogImage?: string;
  ogType?: string;
  keywords?: string[];
}

export interface LegacyLinkInfo {
  href: string;
  text: string;
  isInternal: boolean;
  isExternal: boolean;
}

export interface LegacyImageInfo {
  src: string;
  alt: string;
  width?: number;
  height?: number;
}

export interface LegacyTableInfo {
  headers: string[];
  rows: string[][];
  caption?: string;
}

export const BrowserAgentConfigSchema = z.strictObject({
  headless: z.boolean().prefault(true).optional(),
  userAgent: z.string().optional(),
  viewport: z
    .strictObject({
      width: z.number().positive().prefault(1280),
      height: z.number().positive().prefault(720),
    })
    .prefault({ width: 1280, height: 720 })
    .optional(),
  locale: z.string().prefault('en-US').optional(),
  geolocation: z
    .strictObject({
      latitude: z.number(),
      longitude: z.number(),
    })
    .optional(),
  timeout: z.number().positive().prefault(30000).optional(),
  recordVideo: z.boolean().prefault(false).optional(),
  proxy: z.string().prefault('').optional(),
  storageState: z.string().prefault('').optional(),
  blockAds: z.boolean().prefault(true).optional(),
  stealth: z.boolean().prefault(true).optional(),
});
export type BrowserAgentConfig = z.infer<typeof BrowserAgentConfigSchema>;

export interface LegacyExtractOptions {
  readable?: boolean;
  stripTags?: string[];
  preserveLinks?: boolean;
  preserveImages?: boolean;
  preserveTables?: boolean;
  maxLength?: number;
  removeSelectors?: string[];
  baseUrl?: string;
}

export interface SerializeOptions {
  format: SerializeTarget;
  pretty?: boolean;
  maxChunkSize?: number;
  includeMetadata?: boolean;
  redisKey?: string;
  xmlRoot?: string;
}

export interface SerializedOutput {
  format: SerializeTarget;
  content: string;
  chunks?: string[];
  size: number;
  metadata?: Record<string, unknown>;
}

export interface AgentOutput {
  summary: string;
  content: string;
  keyPoints: string[];
  relevantUrls: string[];
  structured?: Record<string, unknown>;
  tokens: number;
}

export interface RenderOptions {
  width?: number;
  height?: number;
  fullPage?: boolean;
  type?: 'png' | 'jpeg';
  quality?: number;
  output?: string;
}

export interface ChromeCommand {
  action: 'goto' | 'click' | 'type' | 'screenshot' | 'evaluate' | 'wait' | 'scroll' | 'extract';
  args?: Record<string, unknown>;
}

export interface CliOptions {
  url?: string;
  file?: string;
  format?: ScrapeFormat;
  output?: string;
  'no-headless'?: boolean;
  timeout?: number;
  scroll?: boolean;
  readable?: boolean;
  agent?: boolean;
  pretty?: boolean;
  proxy?: string;
  retries?: number;
  mode?: 'auto' | 'fetch' | 'browser';
}

export interface RetryConfig {
  retries: number;
  delay: number;
  backoff: 'exponential' | 'linear' | 'constant';
  maxDelay?: number;
  statusCodes?: number[];
}

export interface ProxyConfig {
  url: string;
  username?: string;
  password?: string;
}

export interface LegacyCacheConfig {
  enabled: boolean;
  ttlMs?: number;
  maxEntries?: number;
  storage?: 'memory' | 'redis' | 'sqlite' | 'indexeddb';
}

export interface CrawlStats {
  totalUrls: number;
  successful: number;
  failed: number;
  skipped: number;
  duration: number;
  avgResponseTime: number;
}

export interface BatchOptions {
  urls: string[];
  concurrency?: number;
  mode?: 'auto' | 'fetch' | 'browser';
  format?: ScrapeFormat;
  onProgress?: (completed: number, total: number, currentUrl: string) => void;
  onError?: (url: string, error: Error) => void;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 13: scrape/errors.ts */
/* ════════════════════════════════════════════════════════════════════ */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INVALID_URL: 'INVALID_URL',
  TIMEOUT: 'TIMEOUT',
  BLOCKED: 'BLOCKED',
  RATE_LIMITED: 'RATE_LIMITED',
  PROXY_ERROR: 'PROXY_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  BROWSER_NOT_AVAILABLE: 'BROWSER_NOT_AVAILABLE',
  CRAWL_DEPTH_EXCEEDED: 'CRAWL_DEPTH_EXCEEDED',
  MAX_RETRIES_EXCEEDED: 'MAX_RETRIES_EXCEEDED',
} as const;

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

export class WebScrapeError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly isRetryable: boolean;
  public readonly timestamp: string;
  public readonly details?: Record<string, unknown>;
  public readonly cause?: Error;

  constructor(
    message: string,
    code: ErrorCode,
    statusCode: number,
    isRetryable: boolean,
    details?: Record<string, unknown>,
    cause?: Error
  ) {
    super(message);
    this.name = 'WebScrapeError';
    this.code = code;
    this.statusCode = statusCode;
    this.isRetryable = isRetryable;
    this.timestamp = new Date().toISOString();
    this.details = details;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace?.(this, this.constructor);
  }

  toJSON() {
    return {
      error: {
        name: this.name,
        code: this.code,
        message: this.message,
        statusCode: this.statusCode,
        isRetryable: this.isRetryable,
        timestamp: this.timestamp,
        details: this.details,
      },
    };
  }
}

export class ValidationError extends WebScrapeError {
  constructor(message: string, details?: Record<string, unknown>, cause?: Error) {
    super(message, ErrorCode.VALIDATION_FAILED, 400, false, details, cause);
    this.name = 'ValidationError';
  }
}

export class TimeoutError extends WebScrapeError {
  constructor(message: string, details?: Record<string, unknown>, cause?: Error) {
    super(message, ErrorCode.TIMEOUT, 504, true, details, cause);
    this.name = 'TimeoutError';
  }
}

export class BlockedError extends WebScrapeError {
  constructor(message: string, details?: Record<string, unknown>, cause?: Error) {
    super(message, ErrorCode.BLOCKED, 403, false, details, cause);
    this.name = 'BlockedError';
  }
}

export class RateLimitError extends WebScrapeError {
  public readonly retryAfterMs?: number;
  constructor(
    message: string,
    retryAfterMs?: number,
    details?: Record<string, unknown>,
    cause?: Error
  ) {
    super(message, ErrorCode.RATE_LIMITED, 429, true, { ...details, retryAfterMs }, cause);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class ProxyError extends WebScrapeError {
  constructor(message: string, details?: Record<string, unknown>, cause?: Error) {
    super(message, ErrorCode.PROXY_ERROR, 502, true, details, cause);
    this.name = 'ProxyError';
  }
}

export class ParseError extends WebScrapeError {
  constructor(message: string, details?: Record<string, unknown>, cause?: Error) {
    super(message, ErrorCode.PARSE_ERROR, 422, false, details, cause);
    this.name = 'ParseError';
  }
}

export class AuthError extends WebScrapeError {
  constructor(message: string, details?: Record<string, unknown>, cause?: Error) {
    super(message, ErrorCode.AUTH_REQUIRED, 401, false, details, cause);
    this.name = 'AuthError';
  }
}

export class NetworkError extends WebScrapeError {
  constructor(message: string, details?: Record<string, unknown>, cause?: Error) {
    super(message, ErrorCode.NETWORK_ERROR, 503, true, details, cause);
    this.name = 'NetworkError';
  }
}

export class BrowserNotAvailableError extends WebScrapeError {
  constructor(
    message: string = 'Playwright is not installed. Install it with: npm install playwright',
    details?: Record<string, unknown>
  ) {
    super(message, ErrorCode.BROWSER_NOT_AVAILABLE, 500, false, details);
    this.name = 'BrowserNotAvailableError';
  }
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 14: scrape/utils.ts */
/* ════════════════════════════════════════════════════════════════════ */
export function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function writeOutput(path: string, content: string): void {
  ensureDir(path);
  writeFileSync(path, content, 'utf-8');
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function truncate(text: string, max: number, suffix = '...'): string {
  if (text.length <= max) return text;
  return text.slice(0, max - suffix.length) + suffix;
}

export function legacyestimatetokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function legacychunktext(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = i + chunkSize;
    if (end < text.length) {
      const breakIdx = text.lastIndexOf('\n', end);
      if (breakIdx > i) end = breakIdx + 1;
    }
    chunks.push(text.slice(i, end).trim());
    i = end;
  }
  return chunks;
}

export function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function normalizeUrl(url: string, base?: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

export function isInternalUrl(href: string, base: string): boolean {
  try {
    const baseUrl = new URL(base);
    const target = new URL(href, base);
    return target.hostname === baseUrl.hostname;
  } catch {
    return false;
  }
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 15: scrape/port.ts — Generate a random port number in the ephemeral port range (1024-65535). */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * Generate a random port number in the ephemeral port range (1024-65535).
 * The port is calculated once and then fixed for the lifetime of the process.
 */
let _cachedPort: number | null = null;

export function randomPort(): number {
  if (_cachedPort !== null) return _cachedPort;
  _cachedPort = Math.floor(Math.random() * 64511) + 1024;
  return _cachedPort;
}

/**
 * Reset the cached port (for testing).
 */
export function resetPort(): void {
  _cachedPort = null;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 16: scrape/tokens.ts */
/* ════════════════════════════════════════════════════════════════════ */
export type ModelType = 'gpt-4o' | 'gpt-4' | 'gpt-3.5-turbo' | 'claude' | 'gemini' | 'default';

const MODEL_TOKEN_RATIOS: Record<ModelType, number> = {
  'gpt-4o': 3.5,
  'gpt-4': 3.5,
  'gpt-3.5-turbo': 4,
  'claude': 3.2,
  'gemini': 3.5,
  'default': 4,
};

export function estimateTokens(text: string, model: ModelType = 'default'): number {
  const ratio = MODEL_TOKEN_RATIOS[model] || 4;
  return Math.ceil(text.length / ratio);
}

export function countTokens(text: string, model: ModelType = 'default'): number {
  return estimateTokens(text, model);
}

export function fitsInContext(text: string, maxTokens: number, model: ModelType = 'default'): boolean {
  return estimateTokens(text, model) <= maxTokens;
}

export function truncateToTokens(text: string, maxTokens: number, model: ModelType = 'default'): string {
  const estimatedTokens = estimateTokens(text, model);
  if (estimatedTokens <= maxTokens) return text;
  const charLimit = Math.floor(maxTokens * (MODEL_TOKEN_RATIOS[model] || 4));
  return text.slice(0, charLimit) + '...';
}

export function tokenCost(text: string, model: ModelType, pricePer1kTokens: number): number {
  const tokens = estimateTokens(text, model);
  return (tokens / 1000) * pricePer1kTokens;
}

export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'claude-3-5-sonnet': { input: 0.003, output: 0.015 },
  'claude-3-haiku': { input: 0.00025, output: 0.00125 },
  'gemini-1.5-pro': { input: 0.00125, output: 0.005 },
  'gemini-1.5-flash': { input: 0.000075, output: 0.0003 },
};

/* ════════════════════════════════════════════════════════════════════ */
/* Section 17: scrape/chunking.ts */
/* ════════════════════════════════════════════════════════════════════ */
export interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
  preserveCodeBlocks?: boolean;
  includeHeadingPath?: boolean;
}

export interface Chunk {
  content: string;
  headingPath: string[];
  tokenCount: number;
  index: number;
}

const DEFAULT_CHUNK_OPTIONS: Required<ChunkOptions> = {
  maxTokens: 512,
  overlapTokens: 50,
  preserveCodeBlocks: true,
  includeHeadingPath: true,
};

function splitByHeaders(markdown: string): { heading: string; level: number; content: string }[] {
  const sections: { heading: string; level: number; content: string }[] = [];
  const lines = markdown.split('\n');
  let currentHeading = '';
  let currentLevel = 0;
  let currentContent: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      if (currentContent.length > 0 || currentHeading) {
        sections.push({
          heading: currentHeading,
          level: currentLevel,
          content: currentContent.join('\n').trim(),
        });
      }
      currentLevel = headerMatch[1].length;
      currentHeading = headerMatch[2];
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentContent.length > 0 || currentHeading) {
    sections.push({
      heading: currentHeading,
      level: currentLevel,
      content: currentContent.join('\n').trim(),
    });
  }

  return sections;
}

function splitByParagraphs(text: string): string[] {
  return text.split(/\n\n+/).filter(p => p.trim().length > 0);
}

function splitBySentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]+/g) || [text];
}

export function chunkMarkdown(markdown: string, options: ChunkOptions = {}): Chunk[] {
  const opts = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const chunks: Chunk[] = [];
  const sections = splitByHeaders(markdown);
  const headingPath: string[] = [];
  let headingDepth = 0;

  for (const section of sections) {
    while (headingDepth > 0 && headingDepth >= section.level) {
      headingDepth--;
      headingPath.pop();
    }
    if (section.heading) {
      headingDepth = section.level;
      headingPath.push(section.heading);
    }

    const sectionText = section.heading ? `#${'#'.repeat(section.level - 1)} ${section.heading}\n\n${section.content}` : section.content;

    if (estimateTokens(sectionText) <= opts.maxTokens) {
      chunks.push({
        content: sectionText,
        headingPath: opts.includeHeadingPath ? [...headingPath] : [],
        tokenCount: estimateTokens(sectionText),
        index: chunks.length,
      });
    } else {
      const paragraphs = splitByParagraphs(sectionText);
      let currentChunk = '';

      for (const paragraph of paragraphs) {
        const testChunk = currentChunk ? `${currentChunk}\n\n${paragraph}` : paragraph;

        if (estimateTokens(testChunk) <= opts.maxTokens) {
          currentChunk = testChunk;
        } else {
          if (currentChunk) {
            chunks.push({
              content: currentChunk,
              headingPath: opts.includeHeadingPath ? [...headingPath] : [],
              tokenCount: estimateTokens(currentChunk),
              index: chunks.length,
            });
          }

          if (estimateTokens(paragraph) > opts.maxTokens) {
            const sentences = splitBySentences(paragraph);
            let sentenceChunk = '';
            for (const sentence of sentences) {
              const testSentence = sentenceChunk ? `${sentenceChunk} ${sentence}` : sentence;
              if (estimateTokens(testSentence) <= opts.maxTokens) {
                sentenceChunk = testSentence;
              } else {
                if (sentenceChunk) {
                  chunks.push({
                    content: sentenceChunk,
                    headingPath: opts.includeHeadingPath ? [...headingPath] : [],
                    tokenCount: estimateTokens(sentenceChunk),
                    index: chunks.length,
                  });
                }
                sentenceChunk = sentence;
              }
            }
            currentChunk = sentenceChunk;
          } else {
            currentChunk = paragraph;
          }
        }
      }

      if (currentChunk) {
        chunks.push({
          content: currentChunk,
          headingPath: opts.includeHeadingPath ? [...headingPath] : [],
          tokenCount: estimateTokens(currentChunk),
          index: chunks.length,
        });
      }
    }
  }

  return chunks;
}

export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const opts = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const chunks: Chunk[] = [];
  const paragraphs = splitByParagraphs(text);
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    const testChunk = currentChunk ? `${currentChunk}\n\n${paragraph}` : paragraph;
    if (estimateTokens(testChunk) <= opts.maxTokens) {
      currentChunk = testChunk;
    } else {
      if (currentChunk) {
        chunks.push({
          content: currentChunk,
          headingPath: [],
          tokenCount: estimateTokens(currentChunk),
          index: chunks.length,
        });
      }
      currentChunk = paragraph;
    }
  }

  if (currentChunk) {
    chunks.push({
      content: currentChunk,
      headingPath: [],
      tokenCount: estimateTokens(currentChunk),
      index: chunks.length,
    });
  }

  return chunks;
}

export function formatChunksForRAG(chunks: Chunk[]): string {
  return chunks.map(chunk => {
    const heading = chunk.headingPath.length > 0 ? `## ${chunk.headingPath.join(' > ')}\n\n` : '';
    return `${heading}${chunk.content}`;
  }).join('\n\n---\n\n');
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 18: scrape/formats.ts */
/* ════════════════════════════════════════════════════════════════════ */
const FORMAT_ALIASES: Record<string, ScrapeFormat> = {
  md: 'markdown',
  txt: 'text',
  plain: 'text',
  xml: 'xml',
  json: 'json',
  redis: 'redis',
  html: 'html',
  h: 'html',
};

const FORMAT_EXTENSIONS: Record<string, ScrapeFormat> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.txt': 'text',
  '.json': 'json',
  '.xml': 'xml',
  '.redis': 'redis',
};

export function resolveFormat(format: string): ScrapeFormat {
  const lower = format.toLowerCase().trim();
  return FORMAT_ALIASES[lower] || (lower as ScrapeFormat);
}

export function formatFromExtension(ext: string): ScrapeFormat | null {
  return FORMAT_EXTENSIONS[ext.toLowerCase()] ?? null;
}

export function extensionForFormat(format: ScrapeFormat): string {
  const map: Record<ScrapeFormat, string> = {
    markdown: '.md',
    html: '.html',
    text: '.txt',
    json: '.json',
    xml: '.xml',
    redis: '.redis',
  };
  return map[format] || '.md';
}

export function detectContentType(html: string): 'article' | 'list' | 'page' | 'other' {
  if (html.includes('<article') || html.includes('entry-content') || html.includes('class="post-content"') || html.includes('class="article-content"') || html.includes('role="main"')) {
    return 'article';
  }
  const listCount = (html.match(/<li>/gi) || []).length;
  if (listCount > 20) return 'list';
  if (html.includes('<article') || html.includes('entry-content')) return 'article';
  return 'page';
}

export function buildSerializeOptions(format: ScrapeFormat, pretty = true): SerializeOptions {
  const targetMap: Record<ScrapeFormat, SerializeTarget> = {
    markdown: 'markdown',
    html: 'markdown',
    text: 'text',
    json: 'json',
    xml: 'xml',
    redis: 'redis',
  };
  return {
    format: targetMap[format] || 'markdown',
    pretty,
    includeMetadata: true,
  };
}

export async function convertResult(result: ScrapeResult, targetFormat: ScrapeFormat): Promise<ScrapeResult> {
  if (result.format === targetFormat) return result;

  const opts = buildSerializeOptions(targetFormat);
  const serialized = sr(result, opts);

  return {
    ...result,
    content: serialized.content,
    format: targetFormat,
    size: serialized.size,
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 19: scrape/serialize.ts */
/* ════════════════════════════════════════════════════════════════════ */
function htmlToMarkdown(html: string): string {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  let md = '';

  function processNode(node: globalThis.Node, depth = 0): void {
    if (node.nodeType === 3) {
      const text = (node as globalThis.Text).textContent?.trim();
      if (text) md += text + ' ';
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as globalThis.Element;
    const tag = el.tagName.toLowerCase();

    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const level = parseInt(tag[1]);
        md += '\n' + '#'.repeat(level) + ' ' + el.textContent?.trim() + '\n\n';
        break;
      }
      case 'p':
        md += '\n' + el.textContent?.trim() + '\n\n';
        break;
      case 'br':
        md += '\n';
        break;
      case 'hr':
        md += '\n---\n\n';
        break;
      case 'ul': case 'ol': {
        el.childNodes.forEach(li => {
          if (li.nodeType === 1) {
            const liEl = li as globalThis.Element;
            if (liEl.tagName.toLowerCase() === 'li') {
              md += '  '.repeat(depth) + '- ' + liEl.textContent?.trim() + '\n';
            }
          }
        });
        md += '\n';
        break;
      }
      case 'a': {
        const href = el.getAttribute('href') || '';
        const text = el.textContent?.trim() || href;
        if (href && href !== '#') md += `[${text}](${href}) `;
        else md += text + ' ';
        break;
      }
      case 'img': {
        const src = el.getAttribute('src') || '';
        const alt = el.getAttribute('alt') || '';
        if (src) md += `![${alt}](${src}) `;
        break;
      }
      case 'strong': case 'b':
        md += '**' + el.textContent?.trim() + '** ';
        break;
      case 'em': case 'i':
        md += '*' + el.textContent?.trim() + '* ';
        break;
      case 'code':
        md += '`' + el.textContent?.trim() + '` ';
        break;
      case 'pre': {
        const code = el.querySelector('code');
        const lang = code?.getAttribute('class')?.replace(/^language-/, '') || '';
        md += '\n```' + lang + '\n' + (code || el).textContent + '\n```\n\n';
        break;
      }
      case 'blockquote':
        md += '\n> ' + el.textContent?.trim().replace(/\n/g, '\n> ') + '\n\n';
        break;
      case 'table': {
        const rows = el.querySelectorAll('tr');
        rows.forEach((row, i) => {
          const cells = row.querySelectorAll('td, th');
          md += '| ' + Array.from(cells).map(c => c.textContent?.trim()).join(' | ') + ' |\n';
          if (i === 0 && row.parentElement?.tagName === 'THEAD') {
            md += '|' + Array.from(cells).map(() => ' --- ').join('|') + '|\n';
          }
        });
        md += '\n';
        break;
      }
      default:
        el.childNodes.forEach(child => processNode(child, depth));
    }
  }

  doc.body?.childNodes.forEach((child: globalThis.Node) => processNode(child));
  return md.replace(/\n{3,}/g, '\n\n').trim();
}

function htmlToXml(html: string, root = 'document'): string {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  function serialize(el: globalThis.Element, depth = 0): string {
    const indent = '  '.repeat(depth);
    const tag = el.tagName.toLowerCase();
    if (el.childNodes.length === 0) {
      return `${indent}<${tag} />\n`;
    }
    const text = el.textContent?.trim();
    if (el.childNodes.length === 1 && el.firstChild?.nodeType === 3 && text) {
      return `${indent}<${tag}>${escapeXml(text)}</${tag}>\n`;
    }
    let xml = `${indent}<${tag}>\n`;
    el.childNodes.forEach(child => {
      if (child.nodeType === 1) xml += serialize(child as globalThis.Element, depth + 1);
      else if (child.nodeType === 3 && (child as globalThis.Text).textContent?.trim()) {
        xml += `${indent}  ${escapeXml((child as globalThis.Text).textContent!.trim())}\n`;
      }
    });
    xml += `${indent}</${tag}>\n`;
    return xml;
  }

  function escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n`;
  doc.body?.childNodes.forEach((child: globalThis.Node) => {
    if (child.nodeType === 1) xml += serialize(child as globalThis.Element, 1);
  });
  xml += `</${root}>\n`;
  return xml;
}

function htmlToRedisJson(html: string, key = 'page'): string {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  function extract(el: globalThis.Element): Record<string, unknown> {
    const tag = el.tagName.toLowerCase();
    const children = Array.from(el.children);
    if (children.length === 0) return { _tag: tag, _text: el.textContent?.trim() || '' };
    const result: Record<string, unknown> = { _tag: tag };
    if (el.getAttribute('href')) result.href = el.getAttribute('href')!;
    if (el.getAttribute('src')) result.src = el.getAttribute('src')!;
    if (el.getAttribute('alt')) result.alt = el.getAttribute('alt')!;
    if (el.getAttribute('class')) result.class = el.getAttribute('class')!;
    children.forEach(child => {
      const childTag = child.tagName.toLowerCase();
      if (result[childTag]) {
        if (!Array.isArray(result[childTag])) result[childTag] = [result[childTag]];
        (result[childTag] as unknown[]).push(extract(child));
      } else {
        result[childTag] = extract(child);
      }
    });
    return result;
  }

  const title = doc.title;
  const bodyArr: Record<string, unknown>[] = [];
  doc.body?.childNodes.forEach((child: globalThis.Node) => {
    if (child.nodeType === 1) bodyArr.push(extract(child as globalThis.Element));
  });

  const json: Record<string, unknown> = {
    title,
    body: bodyArr,
    links: Array.from(doc.querySelectorAll('a[href]')).map((a) => ({
      href: (a as globalThis.Element).getAttribute('href'),
      text: (a as globalThis.Element).textContent?.trim(),
    })),
    images: Array.from(doc.querySelectorAll('img[src]')).map((img) => ({
      src: (img as globalThis.Element).getAttribute('src'),
      alt: (img as globalThis.Element).getAttribute('alt'),
    })),
  };

  return `JSON.SET ${key} $ ${JSON.stringify(json, null, 2)}`;
}

function plainText(html: string): string {
  return html
    .replace(/<style[^>]*>.*?<\/style>/gs, '')
    .replace(/<script[^>]*>.*?<\/script>/gs, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' | ')
    .replace(/<\/th>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function tableToMarkdown(headers: string[], rows: string[][], caption?: string): string {
  let md = caption ? `### ${caption}\n\n` : '';
  md += '| ' + headers.join(' | ') + ' |\n';
  md += '|' + headers.map(() => ' --- ').join('|') + '|\n';
  for (const row of rows) {
    md += '| ' + row.join(' | ') + ' |\n';
  }
  return md + '\n';
}

export function serializeResult(result: ScrapeResult, options: SerializeOptions): SerializedOutput {
  let content = '';

  if (options.includeMetadata !== false) {
    content += `# ${result.title}\n\n`;
    content += `- **URL:** ${result.url}\n`;
    content += `- **Extracted:** ${result.extractedAt}\n`;
    if (result.metadata.author) content += `- **Author:** ${result.metadata.author}\n`;
    if (result.metadata.publishedDate) content += `- **Published:** ${result.metadata.publishedDate}\n`;
    content += `- **Size:** ${result.size} bytes\n\n---\n\n`;
  }

  switch (options.format) {
    case 'markdown':
      content += result.content;
      if (result.tables.length) {
        content += '\n\n## Tables\n\n';
        for (const t of result.tables) {
          content += tableToMarkdown(t.headers, t.rows, t.caption);
        }
      }
      break;

    case 'text':
      content += result.text;
      break;

    case 'xml':
      content = htmlToXml(`<html><head><title>${result.title}</title></head><body>${result.content}</body></html>`, options.xmlRoot || 'document');
      break;

    case 'json':
      content = JSON.stringify({
        title: result.title,
        url: result.url,
        metadata: result.metadata,
        content: result.content,
        links: result.links,
        images: result.images,
        tables: result.tables,
        extractedAt: result.extractedAt,
        duration: result.duration,
      }, null, options.pretty ? 2 : undefined);
      break;

    case 'redis':
      content = htmlToRedisJson(`<html><head><title>${result.title}</title></head><body>${result.content}</body></html>`, options.redisKey || `page:${encodeURIComponent(result.url)}`);
      break;
  }

  const chunks = options.maxChunkSize ? legacychunktext(content, options.maxChunkSize) : [];

  const output: SerializedOutput = {
    format: options.format,
    content,
    chunks: chunks.length ? chunks : undefined,
    size: content.length,
  };

  if (options.includeMetadata) {
    output.metadata = {
      title: result.title,
      url: result.url,
      format: result.format,
      extractedAt: result.extractedAt,
      duration: result.duration,
      linkCount: result.links.length,
      imageCount: result.images.length,
      tableCount: result.tables.length,
    };
  }

  return output;
}

export function serializeHtml(html: string, options: SerializeOptions): SerializedOutput {
  const content = (() => {
    switch (options.format) {
      case 'markdown': return htmlToMarkdown(html);
      case 'xml': return htmlToXml(html, options.xmlRoot || 'document');
      case 'json': return JSON.stringify({ html }, null, options.pretty ? 2 : undefined);
      case 'redis': return htmlToRedisJson(html, options.redisKey || 'page:1');
      case 'text': return plainText(html);
      default: return plainText(html);
    }
  })();

  const chunks = options.maxChunkSize ? legacychunktext(content, options.maxChunkSize) : [];

  return {
    format: options.format,
    content,
    chunks: chunks.length ? chunks : undefined,
    size: content.length,
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 20: scrape/headers.ts */
/* ════════════════════════════════════════════════════════════════════ */
export interface HeaderProfile {
  userAgent: string;
  accept: string;
  acceptLanguage: string;
  secChUa: string;
  secChUaPlatform: string;
}

const CHROME_PROFILES: HeaderProfile[] = [
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    acceptLanguage: 'en-US,en;q=0.9',
    secChUa: '"Chromium";v="131", "Not_A Brand";v="24"',
    secChUaPlatform: '"Windows"',
  },
  {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    acceptLanguage: 'en-US,en;q=0.9',
    secChUa: '"Chromium";v="131", "Not_A Brand";v="24"',
    secChUaPlatform: '"macOS"',
  },
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    acceptLanguage: 'en-US,en;q=0.5',
    secChUa: '',
    secChUaPlatform: '"Windows"',
  },
  {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    acceptLanguage: 'en-US,en;q=0.9',
    secChUa: '',
    secChUaPlatform: '"macOS"',
  },
];

export function getRandomProfile(): HeaderProfile {
  return CHROME_PROFILES[Math.floor(Math.random() * CHROME_PROFILES.length)];
}

export function getHeaders(profile?: HeaderProfile): Record<string, string> {
  const p = profile || getRandomProfile();
  const headers: Record<string, string> = {
    'User-Agent': p.userAgent,
    'Accept': p.accept,
    'Accept-Language': p.acceptLanguage,
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
  };
  if (p.secChUa) {
    headers['sec-ch-ua'] = p.secChUa;
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = p.secChUaPlatform;
  }
  return headers;
}

export function mergeHeaders(
  base: Record<string, string>,
  override: Record<string, string>
): Record<string, string> {
  return { ...base, ...override };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 21: scrape/session.ts */
/* ════════════════════════════════════════════════════════════════════ */
export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

export class CookieJar {
  private cookies = new Map<string, Cookie>();

  set(cookie: Cookie): void {
    const key = `${cookie.domain || ''}:${cookie.path || '/'}:${cookie.name}`;
    this.cookies.set(key, cookie);
  }

  get(name: string, domain?: string, _path?: string): Cookie | undefined {
    for (const [key, cookie] of this.cookies) {
      if (cookie.name !== name) continue;
      if (domain && cookie.domain && !domain.includes(cookie.domain)) continue;
      if (cookie.expires && cookie.expires < Date.now()) {
        this.cookies.delete(key);
        continue;
      }
      return cookie;
    }
    return undefined;
  }

  getAll(domain?: string): Cookie[] {
    const result: Cookie[] = [];
    const now = Date.now();
    for (const [key, cookie] of this.cookies) {
      if (cookie.expires && cookie.expires < now) {
        this.cookies.delete(key);
        continue;
      }
      if (domain && cookie.domain && !domain.includes(cookie.domain)) continue;
      result.push(cookie);
    }
    return result;
  }

  toString(domain?: string): string {
    return this.getAll(domain)
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
  }

  parseSetCookie(header: string, defaultDomain?: string): void {
    const parts = header.split(';').map(s => s.trim());
    const [nameValue, ...attrs] = parts;
    const [name, ...valueParts] = nameValue.split('=');
    const value = valueParts.join('=');

    const cookie: Cookie = {
      name: name.trim(),
      value: value.trim(),
      domain: defaultDomain,
      path: '/',
    };

    for (const attr of attrs) {
      const [key, val] = attr.split('=').map(s => s.trim());
      const lower = key.toLowerCase();
      if (lower === 'domain') cookie.domain = val;
      else if (lower === 'path') cookie.path = val;
      else if (lower === 'expires') cookie.expires = new Date(val).getTime();
      else if (lower === 'httponly') cookie.httpOnly = true;
      else if (lower === 'secure') cookie.secure = true;
    }

    this.set(cookie);
  }

  clear(): void {
    this.cookies.clear();
  }
}

export class ScrapingSession {
  public readonly cookieJar: CookieJar;
  public readonly id: string;
  private data = new Map<string, unknown>();

  constructor(id?: string) {
    this.id = id || crypto.randomUUID();
    this.cookieJar = new CookieJar();
  }

  get<T = unknown>(key: string): T | undefined {
    return this.data.get(key) as T;
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value);
  }

  clear(): void {
    this.cookieJar.clear();
    this.data.clear();
  }
}

export function createSession(id?: string): ScrapingSession {
  return new ScrapingSession(id);
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 22: scrape/pool.ts */
/* ════════════════════════════════════════════════════════════════════ */
export interface PoolConfig {
  maxSize?: number;
  acquireTimeoutMs?: number;
}

interface PoolEntry {
  browser: AgentBrowser;
  inUse: boolean;
  createdAt: number;
}

export class BrowserPool {
  private pool: PoolEntry[] = [];
  private waitQueue: Array<(browser: AgentBrowser) => void> = [];
  private config: Required<PoolConfig>;
  private browserConfig: BrowserAgentConfig;

  constructor(config: PoolConfig = {}, browserConfig: BrowserAgentConfig = {}) {
    this.config = {
      maxSize: config.maxSize || 3,
      acquireTimeoutMs: config.acquireTimeoutMs || 30000,
    };
    this.browserConfig = browserConfig;
  }

  async acquire(): Promise<AgentBrowser> {
    const idle = this.pool.find(e => !e.inUse && e.browser.isConnected());
    if (idle) {
      idle.inUse = true;
      return idle.browser;
    }

    if (this.pool.length < this.config.maxSize) {
      const browser = new AgentBrowser(this.browserConfig);
      await browser.launch();
      const entry: PoolEntry = { browser, inUse: true, createdAt: Date.now() };
      this.pool.push(entry);
      return browser;
    }

    return new Promise<AgentBrowser>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.waitQueue.indexOf(waiter);
        if (idx !== -1) this.waitQueue.splice(idx, 1);
        reject(new Error('Timeout waiting for browser'));
      }, this.config.acquireTimeoutMs);

      const waiter = (browser: AgentBrowser) => {
        clearTimeout(timeout);
        resolve(browser);
      };
      this.waitQueue.push(waiter);
    });
  }

  release(browser: AgentBrowser): void {
    const entry = this.pool.find(e => e.browser === browser);
    if (entry) {
      entry.inUse = false;

      if (this.waitQueue.length > 0) {
        const waiter = this.waitQueue.shift()!;
        entry.inUse = true;
        waiter(browser);
      }
    }
  }

  async destroy(): Promise<void> {
    for (const entry of this.pool) {
      await entry.browser.close().catch(() => {});
    }
    this.pool = [];
    for (const waiter of this.waitQueue) {
      waiter(new AgentBrowser());
    }
    this.waitQueue = [];
  }

  getStatus(): { total: number; idle: number; inUse: number; waiting: number } {
    return {
      total: this.pool.length,
      idle: this.pool.filter(e => !e.inUse).length,
      inUse: this.pool.filter(e => e.inUse).length,
      waiting: this.waitQueue.length,
    };
  }
}

export function createPool(config?: PoolConfig, browserConfig?: BrowserAgentConfig): BrowserPool {
  return new BrowserPool(config, browserConfig);
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 23: scrape/proxy.ts */
/* ════════════════════════════════════════════════════════════════════ */
interface ProxyStats {
  failures: number;
  successes: number;
  consecutiveFailures: number;
  lastFailure?: number;
  lastSuccess?: number;
  disabled: boolean;
  disabledAt?: number;
}

export type ProxyRotationStrategy = 'round-robin' | 'random';

export interface ProxyPoolConfig {
  maxFailures?: number;
  reviveAfterMs?: number;
  strategy?: ProxyRotationStrategy;
}

const DEFAULT_POOL_CONFIG: Required<ProxyPoolConfig> = {
  maxFailures: 3,
  reviveAfterMs: 30 * 60 * 1000,
  strategy: 'round-robin',
};

export class ProxyPool {
  private proxies: ProxyConfig[];
  private stats = new Map<string, ProxyStats>();
  private currentIndex = 0;
  private config: Required<ProxyPoolConfig>;

  constructor(proxies: ProxyConfig[], config: Partial<ProxyPoolConfig> = {}) {
    this.proxies = proxies;
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
    for (const p of proxies) {
      this.stats.set(p.url, { failures: 0, successes: 0, consecutiveFailures: 0, disabled: false });
    }
  }

  private getActiveProxies(): ProxyConfig[] {
    const now = Date.now();
    return this.proxies.filter(p => {
      const s = this.stats.get(p.url);
      if (!s) return true;
      if (s.disabled && s.disabledAt && (now - s.disabledAt) >= this.config.reviveAfterMs) {
        s.disabled = false;
        s.failures = 0;
        s.consecutiveFailures = 0;
        return true;
      }
      return !s.disabled;
    });
  }

  next(): ProxyConfig | null {
    const active = this.getActiveProxies();
    if (active.length === 0) return null;

    if (this.config.strategy === 'random') {
      return active[Math.floor(Math.random() * active.length)];
    }

    const proxy = active[this.currentIndex % active.length];
    this.currentIndex = (this.currentIndex + 1) % active.length;
    return proxy;
  }

  reportSuccess(proxy: ProxyConfig): void {
    const s = this.stats.get(proxy.url);
    if (s) {
      s.successes++;
      s.consecutiveFailures = 0;
      s.lastSuccess = Date.now();
    }
  }

  reportFailure(proxy: ProxyConfig): void {
    const s = this.stats.get(proxy.url);
    if (s) {
      s.failures++;
      s.consecutiveFailures++;
      s.lastFailure = Date.now();
      if (s.consecutiveFailures >= this.config.maxFailures) {
        s.disabled = true;
        s.disabledAt = Date.now();
      }
    }
  }

  getStatus(): { total: number; active: number; disabled: number } {
    const active = this.getActiveProxies();
    return {
      total: this.proxies.length,
      active: active.length,
      disabled: this.proxies.length - active.length,
    };
  }
}

export function createProxyPool(proxies: ProxyConfig[], config?: Partial<ProxyPoolConfig>): ProxyPool {
  return new ProxyPool(proxies, config);
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 24: scrape/proxypool.ts — proxy pool chooses healthy least used entries and never rotates blindly. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * proxy pool chooses healthy least used entries and never rotates blindly.
 */
export function proxypool(options = {}) {
  const entries = (options.proxies ?? []).map((proxy) => ({ ...proxy, failures: 0, uses: 0, status: "active", lastused: 0 }));
  const threshold = options.failurethreshold ?? 3;
  const recovery = options.recoverytime ?? 300000;
  function revive() { const now = Date.now(); for (const entry of entries) if (entry.status === "graveyard" && now - entry.failedat >= recovery) { entry.status = "active"; entry.failures = 0; } }
  function choose() { revive(); const available = entries.filter((entry) => entry.status === "active"); if (!available.length) throw new Error("proxy pool has no healthy entries"); const selected = [...available].sort((left, right) => left.uses - right.uses || left.lastused - right.lastused)[0]; selected.uses += 1; selected.lastused = Date.now(); return { ...selected }; }
  function report(id, result = {}) { const entry = entries.find((value) => value.id === id); if (!entry) return null; if (result.ok) { entry.failures = 0; entry.status = "active"; } else { entry.failures += 1; entry.status = entry.failures >= threshold ? "graveyard" : "active"; entry.failedat = Date.now(); } return { ...entry }; }
  return { choose, report, list() { revive(); return entries.map((entry) => ({ ...entry })); } };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 25: scrape/rate-limiter.ts */
/* ════════════════════════════════════════════════════════════════════ */
interface TokenBucket {
        tokens: number;
        lastRefill: number;
        maxTokens: number;
        refillRate: number;
}

export interface RateLimiterConfig {
        maxTokensPerInterval: number;
        intervalMs: number;
        maxConcurrent?: number;
}

const DEFAULT_CONFIG: Required<RateLimiterConfig> = {
        maxTokensPerInterval: 10,
        intervalMs: 1000,
        maxConcurrent: 5,
};

export class RateLimiter {
        private buckets = new Map<string, TokenBucket>();
        private active = new Map<string, number>();
        private config: Required<RateLimiterConfig>;

        constructor(config: Partial<RateLimiterConfig> = {}) {
                this.config = { ...DEFAULT_CONFIG, ...config };
        }

        private getBucket(key: string): TokenBucket {
                if (!this.buckets.has(key)) {
                        this.buckets.set(key, {
                                tokens: this.config.maxTokensPerInterval,
                                lastRefill: Date.now(),
                                maxTokens: this.config.maxTokensPerInterval,
                                refillRate: this.config.maxTokensPerInterval / (this.config.intervalMs / 1000),
                        });
                }
                return this.buckets.get(key)!;
        }

        private refill(bucket: TokenBucket): void {
                const now = Date.now();
                const elapsed = (now - bucket.lastRefill) / 1000;
                bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRate);
                bucket.lastRefill = now;
        }

        async acquire(key: string): Promise<void> {
                const bucket = this.getBucket(key);
                const currentActive = this.active.get(key) || 0;

                if (currentActive >= this.config.maxConcurrent) {
                        await new Promise((resolve) => setTimeout(resolve, 100));
                        return this.acquire(key);
                }

                this.refill(bucket);

                if (bucket.tokens < 1) {
                        const waitMs = ((1 - bucket.tokens) / bucket.refillRate) * 1000;
                        await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitMs)));
                        this.refill(bucket);
                }

                bucket.tokens -= 1;
                this.active.set(key, currentActive + 1);
        }

        release(key: string): void {
                const current = this.active.get(key) || 0;
                if (current <= 1) {
                        this.active.delete(key);
                } else {
                        this.active.set(key, current - 1);
                }
        }

        getStats(key: string): { tokens: number; active: number } {
                const bucket = this.buckets.get(key);
                if (bucket) this.refill(bucket);
                return {
                        tokens: bucket?.tokens ?? this.config.maxTokensPerInterval,
                        active: this.active.get(key) || 0,
                };
        }

        clear(): void {
                this.buckets.clear();
                this.active.clear();
        }
}

export function createRateLimiter(config?: Partial<RateLimiterConfig>): RateLimiter {
        return new RateLimiter(config);
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 26: scrape/retry.ts */
/* ════════════════════════════════════════════════════════════════════ */
export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
        retries: 3,
        delay: 1000,
        backoff: "exponential",
        maxDelay: 30000,
        statusCodes: [408, 429, 500, 502, 503, 504],
};

const RETRYABLE_NETWORK_CODES = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND"];

export function isRetryableError(error: Error): boolean {
        const code = (error as any).code;
        if (code && RETRYABLE_NETWORK_CODES.includes(code)) return true;
        const status = (error as any).statusCode || (error as any).status;
        if (status && [408, 429, 500, 502, 503, 504].includes(status)) return true;
        if (error.name === "AbortError") return false;
        return false;
}

function calculateDelay(attempt: number, config: Required<RetryConfig>): number {
        switch (config.backoff) {
                case "exponential":
                        return Math.min(config.delay * 2 ** attempt, config.maxDelay);
                case "linear":
                        return Math.min(config.delay * (attempt + 1), config.maxDelay);
                case "constant":
                        return config.delay;
        }
}

export async function withRetry<T>(
        fn: (attemptNumber: number) => Promise<T>,
        config: Partial<RetryConfig> = {},
        onRetry?: (error: Error, attempt: number) => void,
): Promise<T> {
        const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
        const { default: pRetry } = await import("p-retry");

        return pRetry(
                async (attemptNumber) => {
                        try {
                                return await fn(attemptNumber);
                        } catch (error) {
                                if (!isRetryableError(error as Error)) {
                                        throw new AbortError((error as Error).message);
                                }
                                throw error;
                        }
                },
                {
                        retries: cfg.retries,
                        minTimeout: calculateDelay(0, cfg),
                        maxTimeout: cfg.maxDelay,
                        randomize: cfg.backoff === "exponential",
                        onFailedAttempt: (context) => {
                                onRetry?.(context.error, context.attemptNumber);
                        },
                },
        );
}

/**
 * Loads the p-retry AbortError class lazily (the class was a value re-export
 * of the former scrape/retry.ts module; the grand merge keeps it reachable
 * without requiring p-retry at module load time).
 */
export async function loadaborterror() {
  const { AbortError } = await import("p-retry");
  return AbortError;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 27: scrape/middleware.ts */
/* ════════════════════════════════════════════════════════════════════ */
export interface MiddlewareContext<T = Record<string, unknown>> {
  data: T;
  state: Record<string, unknown>;
  startTime: number;
  aborted: boolean;
  abort(): void;
}

export type MiddlewareNext = () => Promise<void>;
export type Middleware<T = Record<string, unknown>> = (
  ctx: MiddlewareContext<T>,
  next: MiddlewareNext
) => Promise<void>;

export class MiddlewarePipeline<T = Record<string, unknown>> {
  private middlewares: Middleware<T>[] = [];

  use(middleware: Middleware<T>): this {
    this.middlewares.push(middleware);
    return this;
  }

  async execute(initialData: T): Promise<MiddlewareContext<T>> {
    const ctx: MiddlewareContext<T> = {
      data: initialData,
      state: {},
      startTime: Date.now(),
      aborted: false,
      abort() { this.aborted = true; },
    };

    let index = 0;

    const next = async (): Promise<void> => {
      if (ctx.aborted) return;
      if (index < this.middlewares.length) {
        const middleware = this.middlewares[index++];
        await middleware(ctx, next);
      }
    };

    await next();
    return ctx;
  }

  clear(): void {
    this.middlewares = [];
  }
}

export function loggingMiddleware(logger?: { info: (msg: string) => void }): Middleware {
  return async (_ctx, next) => {
    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    logger?.info(`Request completed in ${duration}ms`);
  };
}

export function timeoutMiddleware(timeoutMs: number): Middleware {
  return async (ctx, next) => {
    const timer = setTimeout(() => ctx.abort(), timeoutMs);
    try {
      await next();
    } finally {
      clearTimeout(timer);
    }
  };
}

export function retryMiddleware(maxRetries: number, delayMs: number): Middleware {
  return async (ctx, next) => {
    let attempt = 0;
    while (attempt <= maxRetries) {
      ctx.state.attempt = attempt;
      try {
        await next();
        return;
      } catch (error) {
        if (attempt === maxRetries) throw error;
        await new Promise(r => setTimeout(r, delayMs * Math.pow(2, attempt)));
        attempt++;
      }
    }
  };
}

export function createPipeline<T = Record<string, unknown>>(): MiddlewarePipeline<T> {
  return new MiddlewarePipeline<T>();
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 28: scrape/events.ts */
/* ════════════════════════════════════════════════════════════════════ */
export interface WebScrapeEvents {
  'request:start': { url: string; options: ScrapeOptions; timestamp: number };
  'request:response': { url: string; status: number; attempt: number; duration: number };
  'request:error': { url: string; error: Error; attempt: number };
  'request:retry': { url: string; attempt: number; maxRetries: number; delayMs: number };
  'request:complete': { url: string; duration: number; success: boolean };
  'cache:hit': { key: string };
  'cache:miss': { key: string };
  'cache:set': { key: string; ttlMs?: number };
  'proxy:rotate': { proxy: string; reason: string };
  'proxy:error': { proxy: string; error: Error };
  'proxy:disabled': { proxy: string; reason: string };
  'crawl:discover': { url: string; depth: number; parentUrl?: string };
  'crawl:complete': { totalUrls: number; successful: number; failed: number; duration: number };
}

export type EventEmitter = Emittery<WebScrapeEvents>;

/**
 * Creates a fresh emittery event bus. Emittery joined the lazy-loading
 * contract of the grand merge: the optional runtime dependency is imported
 * on first use, so loading this module never requires it to be installed.
 */
export async function createEventEmitter(): Promise<EventEmitter> {
  const { default: EmitteryCtor } = await import("emittery");
  return new EmitteryCtor() as EventEmitter;
}

/**
 * Resolves the process-wide emitter on first call. The former eager
 * `globalEmitter` value of scrape/events.ts became this lazy memoized
 * factory in the grand merge: emittery is an optional runtime and nothing
 * may request it as an import side effect of loading the module.
 */
let globalemitterpromise = null;
export function globalEmitter() {
  globalemitterpromise ??= createEventEmitter();
  return globalemitterpromise;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 29: scrape/renderer.ts */
/* ════════════════════════════════════════════════════════════════════ */
interface PygameConfig {
  pythonPath?: string;
  width?: number;
  height?: number;
  fps?: number;
  fullscreen?: boolean;
}

const DEFAULT_PYGAME_CONFIG: Required<PygameConfig> = {
  pythonPath: 'python',
  width: 1280,
  height: 720,
  fps: 30,
  fullscreen: false,
};

function generatePygameScript(
  imagePath: string,
  config: Required<PygameConfig>,
  interactive = false
): string {
  const lines = [
    'import sys, json',
    'import pygame',
    'pygame.init()',
    `screen = pygame.display.set_mode((${config.width}, ${config.height})${config.fullscreen ? ', pygame.FULLSCREEN' : ''})`,
    'pygame.display.set_caption("DevThink WebScrape Renderer")',
    `clock = pygame.time.Clock()`,
    '',
    'try:',
    `  img = pygame.image.load(${JSON.stringify(imagePath)})`,
    '  img_rect = img.get_rect(center=(screen.get_width()//2, screen.get_height()//2))',
    'except:',
    '  img = None',
    '',
    'font = pygame.font.Font(None, 36)',
    '',
    'running = True',
    'while running:',
    '  for event in pygame.event.get():',
    '    if event.type == pygame.QUIT:',
    '      running = False',
    '    elif event.type == pygame.KEYDOWN:',
    '      if event.key == pygame.K_ESCAPE:',
    '        running = False',
    ...(interactive ? [
    '      elif event.key == pygame.K_SPACE:',
    '        print(json.dumps({"action": "next"}))',
    '        sys.stdout.flush()',
    ] : []),
    '',
    '  screen.fill((30, 30, 40))',
    '  if img:',
    '    screen.blit(img, img_rect)',
    '  else:',
    '    text = font.render("No screenshot available", True, (200, 200, 200))',
    '    screen.blit(text, (config.width//2 - text.get_width()//2, config.height//2))',
    '',
    '  pygame.display.flip()',
    '  clock.tick(30)',
    '',
    'pygame.quit()',
  ];
  return lines.join('\n');
}

function generateDoomScript(
  config: Required<PygameConfig>
): string {
  const lines = [
    'import sys, json, asyncio, subprocess',
    'import pygame',
    'pygame.init()',
    `screen = pygame.display.set_mode((${config.width}, ${config.height})${config.fullscreen ? ', pygame.FULLSCREEN' : ''})`,
    'pygame.display.set_caption("DevThink WebScrape - DOOM")',
    '',
    'font = pygame.font.Font(None, 24)',
    'small_font = pygame.font.Font(None, 18)',
    '',
    'frames = []',
    'current_frame = 0',
    'running = True',
    '',
    'def load_frames(path):',
    '  import os',
    '  frames_dir = os.path.expanduser(path)',
    '  if os.path.isdir(frames_dir):',
    '    files = sorted(os.listdir(frames_dir))',
    '    for f in files:',
    '      if f.endswith((".png", ".jpg", ".jpeg")):',
    '        try:',
    '          img = pygame.image.load(os.path.join(frames_dir, f))',
    '          frames.append(img)',
    '        except: pass',
    '',
    'load_frames("~/devthink/webscrape/doom_frames")',
    '',
    'while running:',
    '  for event in pygame.event.get():',
    '    if event.type == pygame.QUIT:',
    '      running = False',
    '    elif event.type == pygame.KEYDOWN:',
    '      if event.key == pygame.K_ESCAPE: running = False',
    '      elif event.key == pygame.K_LEFT: current_frame = max(0, current_frame - 1)',
    '      elif event.key == pygame.K_RIGHT: current_frame = min(len(frames)-1, current_frame + 1)',
    '      elif event.key == pygame.K_SPACE:',
    '        out = {"action": "frame", "index": current_frame, "total": len(frames)}',
    '        print(json.dumps(out))',
    '        sys.stdout.flush()',
    '',
    '  screen.fill((20, 20, 30))',
    '  if frames and current_frame < len(frames):',
    '    img = pygame.transform.scale(frames[current_frame], (config.width, config.height - 60))',
    '    screen.blit(img, (0, 0))',
    '  else:',
    '    text = font.render("No DOOM frames loaded", True, (200, 80, 80))',
    '    screen.blit(text, (config.width//2 - 150, config.height//2))',
    '',
    '  info = f"Frame {current_frame+1}/{len(frames)} | ESC: quit | <- ->: navigate | SPACE: capture"',
    '  info_surf = small_font.render(info, True, (180, 180, 180))',
    '  screen.blit(info_surf, (10, config.height - 40))',
    '',
    '  pygame.display.flip()',
    '  clock.tick(30)',
    '',
    'pygame.quit()',
  ];
  return lines.join('\n');
}

export class PygameRenderer {
  private config: Required<PygameConfig>;
  private process: ChildProcess | null = null;
  private tempDir: string;
  private screenDir: string;

  constructor(config: PygameConfig = {}) {
    this.config = { ...DEFAULT_PYGAME_CONFIG, ...config };
    this.tempDir = join(process.cwd(), '.webscrape');
    this.screenDir = join(this.tempDir, 'screenshots');
    if (!existsSync(this.tempDir)) mkdirSync(this.tempDir, { recursive: true });
    if (!existsSync(this.screenDir)) mkdirSync(this.screenDir, { recursive: true });
  }

  async renderScreenshot(imageBuffer: Buffer): Promise<void> {
    const imagePath = join(this.screenDir, 'current.png');
    writeFileSync(imagePath, imageBuffer);

    const script = generatePygameScript(imagePath, this.config);
    const scriptPath = join(this.tempDir, 'render_screenshot.py');
    writeFileSync(scriptPath, script);

    await this.runScript(scriptPath);
  }

  async renderDoom(): Promise<void> {
    const script = generateDoomScript(this.config);
    const scriptPath = join(this.tempDir, 'render_doom.py');
    writeFileSync(scriptPath, script);

    await this.runScript(scriptPath);
  }

  private runScript(scriptPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.config.pythonPath, [scriptPath], {
        stdio: ['inherit', 'inherit', 'pipe'],
      });

      this.process.on('close', code => {
        this.process = null;
        if (code === 0) resolve();
        else reject(new Error(`Pygame exited with code ${code}`));
      });

      this.process.on('error', err => reject(err));
    });
  }

  close(): void {
    if (this.process && !this.process.killed) {
      this.process.kill();
      this.process = null;
    }
  }
}

export function createRenderer(config?: PygameConfig): PygameRenderer {
  return new PygameRenderer(config);
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 30: scrape/sitemap.ts */
/* ════════════════════════════════════════════════════════════════════ */
export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

export interface SitemapResult {
  urls: SitemapUrl[];
  sitemaps: string[];
  duration: number;
}

function parseSitemapXml(xml: string): SitemapUrl[] {
  const urls: SitemapUrl[] = [];
  const urlMatches = xml.match(/<url[^>]*>([\s\S]*?)<\/url>/gi) || [];

  for (const urlBlock of urlMatches) {
    const loc = urlBlock.match(/<loc>([\s\S]*?)<\/loc>/i)?.[1]?.trim();
    if (!loc) continue;

    const lastmod = urlBlock.match(/<lastmod>([\s\S]*?)<\/lastmod>/i)?.[1]?.trim();
    const changefreq = urlBlock.match(/<changefreq>([\s\S]*?)<\/changefreq>/i)?.[1]?.trim();
    const priorityStr = urlBlock.match(/<priority>([\s\S]*?)<\/priority>/i)?.[1]?.trim();
    const priority = priorityStr ? parseFloat(priorityStr) : undefined;

    urls.push({ loc, lastmod, changefreq, priority });
  }

  return urls;
}

function extractSitemapUrls(xml: string): string[] {
  const urls: string[] = [];
  const sitemapMatches = xml.match(/<sitemap[^>]*>[\s\S]*?<loc>([\s\S]*?)<\/loc>[\s\S]*?<\/sitemap>/gi) || [];
  for (const match of sitemapMatches) {
    const loc = match.match(/<loc>([\s\S]*?)<\/loc>/i)?.[1]?.trim();
    if (loc) urls.push(loc);
  }
  return urls;
}

export async function fetchSitemap(url: string, options: { timeout?: number; headers?: Record<string, string>; fetcher?: typeof fetch } = {}): Promise<SitemapResult> {
  const startTime = Date.now();
  const fetcher = options.fetcher ?? fetch;

  try {
    const response = await fetcher(url, {
      headers: {
        'User-Agent': 'DevThink-WebScrape/2.0 (sitemap parser)',
        ...options.headers,
      },
      signal: AbortSignal.timeout(options.timeout || 10000),
    });

    if (!response.ok) {
      throw new WebScrapeError(`Failed to fetch sitemap: ${response.status}`, ErrorCode.NETWORK_ERROR, response.status, false, { url });
    }

    const text = await response.text();
    const isIndex = text.includes('<sitemapindex');
    const urls = isIndex ? [] : parseSitemapXml(text);
    const sitemaps = isIndex ? extractSitemapUrls(text) : [];

    return {
      urls,
      sitemaps,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    if (error instanceof WebScrapeError) throw error;
    throw new WebScrapeError(`Failed to parse sitemap: ${(error as Error).message}`, ErrorCode.PARSE_ERROR, 422, false, { url }, error as Error);
  }
}

export async function discoverSitemaps(siteUrl: string): Promise<string[]> {
  const candidates = [
    '/sitemap.xml',
    '/sitemap_index.xml',
    '/sitemap-index.xml',
    '/sitemaps.xml',
    '/robots.txt',
  ];

  const found: string[] = [];
  const base = siteUrl.replace(/\/$/, '');

  for (const path of candidates) {
    try {
      const url = path === '/robots.txt' ? `${base}/robots.txt` : `${base}${path}`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'DevThink-WebScrape/2.0' },
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const text = await response.text();
        if (path === '/robots.txt') {
          const sitemapUrls = text.match(/Sitemap:\s*(https?:\/\/[^\s]+)/gi);
          if (sitemapUrls) {
            for (const s of sitemapUrls) {
              found.push(s.replace(/Sitemap:\s*/i, '').trim());
            }
          }
        } else {
          found.push(url);
        }
      }
    } catch {}
  }

  return [...new Set(found)];
}

export async function parseSitemap(url: string, options: { timeout?: number; headers?: Record<string, string>; fetcher?: typeof fetch; followIndexes?: boolean; maxUrls?: number; maxDepth?: number } = {}): Promise<SitemapUrl[]> {
  const maxUrls = Math.max(0, Number(options.maxUrls ?? 10000));
  const maxDepth = Math.max(0, Number(options.maxDepth ?? 8));
  const allUrls: SitemapUrl[] = [];
  const seenSitemaps = new Set<string>();
  const seenUrls = new Set<string>();

  async function visit(current: string, depth: number) {
    const identity = sitemapidentity(current);
    if (seenSitemaps.has(identity) || depth > maxDepth || allUrls.length >= maxUrls) return;
    seenSitemaps.add(identity);
    const result = await fetchSitemap(current, options);
    for (const item of result.urls) {
      const itemidentity = sitemapidentity(item.loc);
      if (!seenUrls.has(itemidentity)) {
        seenUrls.add(itemidentity);
        allUrls.push(item);
        if (allUrls.length >= maxUrls) return;
      }
    }
    if (options.followIndexes === false || depth >= maxDepth) return;
    for (const child of result.sitemaps) {
      if (allUrls.length >= maxUrls) return;
      await visit(child, depth + 1);
    }
  }

  await visit(url, 0);
  return allUrls;
}

function sitemapidentity(value: string) { try { const parsed = new URL(value); parsed.hash = ""; return parsed.href; } catch { return String(value).trim(); } }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 31: scrape/agent.ts */
/* ════════════════════════════════════════════════════════════════════ */
export interface AgentFormatOptions {
  includeSummary?: boolean;
  includeKeyPoints?: boolean;
  includeUrls?: boolean;
  includeRaw?: boolean;
  maxTokens?: number;
  chunkSize?: number;
  model?: 'gpt-4o' | 'gpt-4' | 'gpt-3.5-turbo' | 'claude' | 'gemini' | 'default';
}

const DEFAULT_OPTIONS: Required<AgentFormatOptions> = {
  includeSummary: true,
  includeKeyPoints: true,
  includeUrls: true,
  includeRaw: true,
  maxTokens: 8000,
  chunkSize: 512,
  model: 'default',
};

function generateSummary(result: ScrapeResult): string {
  const wordCount = result.text.split(/\s+/).length;
  return `This page titled "${result.title}" contains approximately ${wordCount} words with ${result.links.length} links and ${result.images.length} images.`;
}

function generateKeyPoints(result: ScrapeResult): string[] {
  const points: string[] = [];
  const text = result.text.slice(0, 5000);

  if (result.metadata.author) points.push(`Author: ${result.metadata.author}`);
  if (result.metadata.publishedDate) points.push(`Published: ${result.metadata.publishedDate}`);
  if (result.metadata.description) points.push(`Description: ${result.metadata.description.slice(0, 200)}`);

  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  for (const s of sentences.slice(0, 5)) {
    const trimmed = s.trim();
    if (trimmed.length > 30) points.push(trimmed);
  }

  return points.slice(0, 8);
}

function buildSystemPrompt(result: ScrapeResult): string {
  let prompt = `# Web Page Content\n\n`;
  prompt += `## Title\n${result.title}\n\n`;
  prompt += `## URL\n${result.url}\n\n`;

  if (result.metadata.description) {
    prompt += `## Description\n${result.metadata.description}\n\n`;
  }

  if (result.tables.length > 0) {
    prompt += `## Tables (${result.tables.length} found)\n`;
    for (const t of result.tables.slice(0, 3)) {
      prompt += `- ${t.caption || 'Unnamed table'}: ${t.headers.join(', ')}\n`;
    }
    prompt += '\n';
  }

  prompt += `## Content\n${result.content}\n\n`;
  return prompt;
}

export function formatForAgent(result: ScrapeResult, options?: AgentFormatOptions): AgentOutput {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let content = '';

  if (opts.includeSummary) {
    content += `## Summary\n${generateSummary(result)}\n\n`;
  }

  if (opts.includeKeyPoints) {
    const points = generateKeyPoints(result);
    content += `## Key Points\n${points.map(p => `- ${p}`).join('\n')}\n\n`;
  }

  if (opts.includeUrls) {
    const externalUrls = result.links.filter(l => l.isExternal).slice(0, 15);
    if (externalUrls.length) {
      content += `## External Links\n${externalUrls.map(l => `- [${l.text || l.href}](${l.href})`).join('\n')}\n\n`;
    }
    const internalUrls = result.links.filter(l => l.isInternal).slice(0, 10);
    if (internalUrls.length) {
      content += `## Internal Links\n${internalUrls.map(l => `- [${l.text || l.href}](${l.href})`).join('\n')}\n\n`;
    }
  }

  if (opts.includeRaw) {
    content += `## Full Content\n${result.content}\n\n`;
  }

  const totalTokens = estimateTokens(content, opts.model);

  if (totalTokens > opts.maxTokens) {
    const charLimit = Math.floor(opts.maxTokens * 4);
    content = content.slice(0, charLimit) + '\n\n... (truncated)';
  }

  const chunks = chunkMarkdown(content, { maxTokens: opts.chunkSize });

  const output: AgentOutput = {
    summary: generateSummary(result),
    content,
    keyPoints: generateKeyPoints(result),
    relevantUrls: result.links.filter(l => l.isExternal).map(l => l.href).slice(0, 10),
    tokens: estimateTokens(content, opts.model),
  };

  if (chunks.length > 1) {
    (output as unknown as Record<string, unknown>).chunks = chunks.map(c => c.content);
  }

  return output;
}

export function buildContext(result: ScrapeResult): string {
  return buildSystemPrompt(result);
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 32: scrape/llms-txt.ts */
/* ════════════════════════════════════════════════════════════════════ */
export interface LlmsTxtOptions {
  siteName?: string;
  description?: string;
  includeOptional?: boolean;
}

export function generateLlmsTxt(
  results: ScrapeResult[],
  options: LlmsTxtOptions = {}
): string {
  const siteName = options.siteName || results[0]?.metadata?.title || 'Site';
  const description = options.description || results[0]?.metadata?.description || '';

  const lines: string[] = [];
  lines.push(`# ${siteName}`);
  lines.push('');
  if (description) {
    lines.push(`> ${description}`);
    lines.push('');
  }

  const pages: ScrapeResult[] = [];
  const docs: ScrapeResult[] = [];

  for (const result of results) {
    const url = result.url.toLowerCase();
    if (url.includes('doc') || url.includes('guide') || url.includes('api')) {
      docs.push(result);
    } else {
      pages.push(result);
    }
  }

  if (pages.length > 0) {
    lines.push('## Pages');
    lines.push('');
    for (const page of pages.slice(0, 20)) {
      const title = page.metadata.title || page.title;
      const desc = page.metadata.description || '';
      lines.push(`- ${title}: ${desc || page.url}`);
    }
    lines.push('');
  }

  if (docs.length > 0) {
    lines.push('## Documentation');
    lines.push('');
    for (const doc of docs.slice(0, 20)) {
      const title = doc.metadata.title || doc.title;
      const desc = doc.metadata.description || '';
      lines.push(`- ${title}: ${desc || doc.url}`);
    }
    lines.push('');
  }

  if (options.includeOptional && results.length > 5) {
    lines.push('## Optional');
    lines.push('');
    lines.push(`- Full content: ${results.length} pages scraped`);
    lines.push(`- Last updated: ${new Date().toISOString().split('T')[0]}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function generateLlmsFullTxt(results: ScrapeResult[]): string {
  const parts: string[] = [];

  for (const result of results) {
    parts.push(`# ${result.title || result.metadata.title || 'Untitled'}`);
    parts.push('');
    parts.push(`Source: ${result.url}`);
    parts.push('');
    parts.push(result.content);
    parts.push('');
    parts.push('---');
    parts.push('');
  }

  return parts.join('\n');
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 33: scrape/fetch.ts */
/* ════════════════════════════════════════════════════════════════════ */
export interface FetchResult {
  html: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  duration: number;
}

export async function fetchHtml(url: string, options: {
  timeout?: number;
  headers?: Record<string, string>;
  userAgent?: string;
  proxy?: string;
  signal?: AbortSignal;
} = {}): Promise<FetchResult> {
  const startTime = Date.now();
  const profile = getRandomProfile();
  const baseHeaders = getHeaders(profile);
  const headers = { ...baseHeaders, ...options.headers };
  if (options.userAgent) headers['User-Agent'] = options.userAgent;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout || 30000);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal,
      redirect: 'follow',
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new WebScrapeError(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status === 403 ? ErrorCode.BLOCKED :
        response.status === 429 ? ErrorCode.RATE_LIMITED :
        response.status >= 500 ? ErrorCode.NETWORK_ERROR :
        ErrorCode.NETWORK_ERROR,
        response.status,
        [408, 429, 500, 502, 503, 504].includes(response.status),
        { url, status: response.status }
      );
    }

    const html = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });

    return {
      html,
      url: response.url || url,
      status: response.status,
      headers: responseHeaders,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof WebScrapeError) throw error;
    if ((error as Error).name === 'AbortError') {
      throw new WebScrapeError(
        `Request timeout after ${options.timeout || 30000}ms`,
        ErrorCode.TIMEOUT,
        504,
        true,
        { url, timeout: options.timeout || 30000 }
      );
    }
    throw new WebScrapeError(
      `Network error: ${(error as Error).message}`,
      ErrorCode.NETWORK_ERROR,
      503,
      true,
      { url },
      error as Error
    );
  }
}

export async function fetchAndParse(url: string, options: Partial<ScrapeOptions> = {}): Promise<FetchResult> {
  return fetchHtml(url, {
    timeout: options.timeout,
    headers: options.headers,
    userAgent: options.userAgent,
    proxy: options.proxy,
  });
}

export async function detectRenderingMode(html: string): Promise<'static' | 'spa' | 'hydrated'> {
  if (/<div id=["'](?:root|app|__next|__nuxt)["']>\s*<\/div>/.test(html)) return 'spa';
  if (html.includes('__NEXT_DATA__') || html.includes('__NUXT__') || html.includes('__VUE_SSR_DATA__')) return 'hydrated';
  const cheeriomodule = await import("cheerio");
  const $ = cheeriomodule.load(html);
  if ($('script[type="application/ld+json"]').length > 0) return 'static';
  const textContent = $.text().replace(/\s+/g, ' ').trim();
  if (textContent.length > 500) return 'static';
  return 'spa';
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 34: scrape/batch.ts */
/* ════════════════════════════════════════════════════════════════════ */
export interface BatchResult {
  results: ScrapeResult[];
  errors: { url: string; error: Error }[];
  successful: number;
  failed: number;
  duration: number;
}

export async function batchScrape(options: BatchOptions, scrapeOpts: ScrapeOptions = {}): Promise<BatchResult> {
  const startTime = Date.now();
  const { default: pLimit } = await import("p-limit");
  const limit = pLimit(options.concurrency || 5);
  const results: ScrapeResult[] = [];
  const errors: { url: string; error: Error }[] = [];

  const tasks = options.urls.map((url) =>
    limit(async () => {
      try {
        const result = await scrapeUrl(url, { ...scrapeOpts, mode: scrapeOpts.mode || 'auto' });
        results.push(result);
        options.onProgress?.(results.length + errors.length, options.urls.length, url);
      } catch (error) {
        errors.push({ url, error: error as Error });
        options.onError?.(url, error as Error);
        options.onProgress?.(results.length + errors.length, options.urls.length, url);
      }
    })
  );

  await Promise.allSettled(tasks);

  return {
    results,
    errors,
    successful: results.length,
    failed: errors.length,
    duration: Date.now() - startTime,
  };
}

export async function batchScrapeSequential(
  urls: string[],
  options: ScrapeOptions = {},
  callbacks?: {
    onResult?: (result: ScrapeResult, index: number) => void;
    onError?: (url: string, error: Error, index: number) => void;
    delayMs?: number;
  }
): Promise<BatchResult> {
  const startTime = Date.now();
  const results: ScrapeResult[] = [];
  const errors: { url: string; error: Error }[] = [];

  for (let i = 0; i < urls.length; i++) {
    try {
      const result = await scrapeUrl(urls[i], options);
      results.push(result);
      callbacks?.onResult?.(result, i);
    } catch (error) {
      errors.push({ url: urls[i], error: error as Error });
      callbacks?.onError?.(urls[i], error as Error, i);
    }

    if (callbacks?.delayMs && i < urls.length - 1) {
      await new Promise(r => setTimeout(r, callbacks.delayMs));
    }
  }

  return {
    results,
    errors,
    successful: results.length,
    failed: errors.length,
    duration: Date.now() - startTime,
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 35: scrape/browser.ts */
/* ════════════════════════════════════════════════════════════════════ */
export class AgentBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private config: Required<Omit<BrowserAgentConfig, 'userAgent' | 'geolocation'>> & Pick<BrowserAgentConfig, 'userAgent' | 'geolocation'>;

  private static DEFAULTS = {
    headless: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    timeout: 30000,
    recordVideo: false,
    proxy: '',
    storageState: '',
    blockAds: true,
    stealth: true,
  };

  constructor(config: Partial<BrowserAgentConfig> = {}) {
    this.config = { ...AgentBrowser.DEFAULTS, ...config };
  }

  async launch(browserType: 'chromium' | 'firefox' | 'webkit' = 'chromium'): Promise<void> {
    try {
      const playwrightmodule = await import("playwright");
      const launcher = { chromium: playwrightmodule.chromium, firefox: playwrightmodule.firefox, webkit: playwrightmodule.webkit }[browserType];
      const launchOpts: Parameters<typeof playwrightmodule.chromium.launch>[0] = {
        headless: this.config.headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
        ],
      };
      if (this.config.proxy) {
        launchOpts.proxy = { server: this.config.proxy };
      }
      this.browser = await launcher.launch(launchOpts);

      const ctxOpts: Parameters<Browser['newContext']>[0] = {
        viewport: this.config.viewport,
        locale: this.config.locale,
        userAgent: this.config.userAgent,
      };
      if (this.config.recordVideo) {
        ctxOpts.recordVideo = { dir: './videos' };
      }
      if (this.config.geolocation) {
        ctxOpts.geolocation = this.config.geolocation;
        ctxOpts.permissions = ['geolocation'];
      }
      if (this.config.storageState) {
        ctxOpts.storageState = this.config.storageState;
      }
      this.context = await this.browser.newContext(ctxOpts);

      if (this.config.blockAds) {
        await this.context.route('**/*.{png,jpg,jpeg,gif,svg,ico,css,woff,woff2,mp4,webm}', r => r.abort());
      }

      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(this.config.timeout);
    } catch (error) {
      if ((error as Error).message?.includes('playwright') || (error as Error).message?.includes('chromium')) {
        throw new BrowserNotAvailableError();
      }
      throw error;
    }
  }

  async navigate(url: string, waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'networkidle'): Promise<void> {
    if (!this.page) throw new WebScrapeError('Browser not launched', ErrorCode.BROWSER_NOT_AVAILABLE, 500, false);
    await this.page.goto(url, { waitUntil, timeout: this.config.timeout });
  }

  async screenshot(opts: RenderOptions = {}): Promise<Buffer> {
    if (!this.page) throw new WebScrapeError('Browser not launched', ErrorCode.BROWSER_NOT_AVAILABLE, 500, false);
    return this.page.screenshot({
      fullPage: opts.fullPage ?? false,
      type: opts.type ?? 'png',
      quality: opts.quality ?? 80,
    }) as Promise<Buffer>;
  }

  async evaluate<T = unknown>(fn: string | (() => T), args?: unknown[]): Promise<T> {
    if (!this.page) throw new WebScrapeError('Browser not launched', ErrorCode.BROWSER_NOT_AVAILABLE, 500, false);
    if (typeof fn === 'string') {
      return this.page.evaluate(new Function(fn) as () => T);
    }
    return this.page.evaluate(fn, args);
  }

  async click(selector: string): Promise<void> {
    if (!this.page) throw new WebScrapeError('Browser not launched', ErrorCode.BROWSER_NOT_AVAILABLE, 500, false);
    await this.page.click(selector);
  }

  async type(selector: string, text: string, delayMs = 0): Promise<void> {
    if (!this.page) throw new WebScrapeError('Browser not launched', ErrorCode.BROWSER_NOT_AVAILABLE, 500, false);
    await this.page.fill(selector, '');
    await this.page.type(selector, text, { delay: delayMs });
  }

  async scrollToBottom(step = 800, delayMs = 300, maxScrolls = 50): Promise<number> {
    if (!this.page) throw new WebScrapeError('Browser not launched', ErrorCode.BROWSER_NOT_AVAILABLE, 500, false);
    let scrolls = 0;
    let prevHeight = 0;
    while (scrolls < maxScrolls) {
      const height = await this.page.evaluate(() => document.body.scrollHeight);
      if (height === prevHeight && scrolls > 2) break;
      prevHeight = height;
      await this.page.evaluate(y => window.scrollBy(0, y), step);
      await new Promise(r => setTimeout(r, delayMs));
      scrolls++;
    }
    return scrolls;
  }

  async scrollTo(x: number, y: number): Promise<void> {
    if (!this.page) throw new WebScrapeError('Browser not launched', ErrorCode.BROWSER_NOT_AVAILABLE, 500, false);
    await this.page.evaluate(([px, py]) => window.scrollTo(px, py), [x, y]);
  }

  async waitFor(selector: string, timeout?: number): Promise<void> {
    if (!this.page) throw new WebScrapeError('Browser not launched', ErrorCode.BROWSER_NOT_AVAILABLE, 500, false);
    await this.page.waitForSelector(selector, { timeout: timeout ?? this.config.timeout });
  }

  async waitForLoad(): Promise<void> {
    if (!this.page) throw new WebScrapeError('Browser not launched', ErrorCode.BROWSER_NOT_AVAILABLE, 500, false);
    await this.page.waitForLoadState('networkidle');
  }

  async html(): Promise<string> {
    if (!this.page) throw new WebScrapeError('Browser not launched', ErrorCode.BROWSER_NOT_AVAILABLE, 500, false);
    return this.page.content();
  }

  async text(): Promise<string> {
    if (!this.page) throw new WebScrapeError('Browser not launched', ErrorCode.BROWSER_NOT_AVAILABLE, 500, false);
    return this.page.evaluate(() => document.body.innerText);
  }

  async title(): Promise<string> {
    if (!this.page) throw new WebScrapeError('Browser not launched', ErrorCode.BROWSER_NOT_AVAILABLE, 500, false);
    return this.page.title();
  }

  async url(): Promise<string> {
    if (!this.page) throw new WebScrapeError('Browser not launched', ErrorCode.BROWSER_NOT_AVAILABLE, 500, false);
    return this.page.url();
  }

  async executeCommands(commands: ChromeCommand[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const cmd of commands) {
      switch (cmd.action) {
        case 'goto':
          await this.navigate(cmd.args?.url as string);
          results.push({ ok: true });
          break;
        case 'click':
          await this.click(cmd.args?.selector as string);
          results.push({ ok: true });
          break;
        case 'type':
          await this.type(cmd.args?.selector as string, cmd.args?.text as string);
          results.push({ ok: true });
          break;
        case 'screenshot':
          results.push(await this.screenshot(cmd.args as RenderOptions));
          break;
        case 'evaluate':
          results.push(await this.evaluate(cmd.args?.fn as string));
          break;
        case 'wait':
          await this.waitFor(cmd.args?.selector as string);
          results.push({ ok: true });
          break;
        case 'scroll':
          if (cmd.args?.to) {
            await this.scrollTo(0, cmd.args.to as number);
          } else {
            await this.scrollToBottom();
          }
          results.push({ ok: true });
          break;
        case 'extract':
          results.push({
            html: await this.html(),
            text: await this.text(),
            title: await this.title(),
          });
          break;
      }
    }
    return results;
  }

  async close(): Promise<void> {
    if (this.page) await this.page.close().catch(() => {});
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  isConnected(): boolean {
    return this.browser?.isConnected() ?? false;
  }
}

export function createBrowser(config?: BrowserAgentConfig): AgentBrowser {
  return new AgentBrowser(config);
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 36: scrape/scrape.ts */
/* ════════════════════════════════════════════════════════════════════ */
export async function scrapeUrl(url: string, options: ScrapeOptions = {}): Promise<ScrapeResult> {
  if (!url || !url.startsWith('http')) {
    throw new WebScrapeError(`Invalid URL: ${url}`, ErrorCode.VALIDATION_FAILED, 400, false);
  }

  const startTime = Date.now();
  const mode = options.mode || 'auto';

  if (mode === 'fetch' || mode === 'auto') {
    try {
      const fetchResult = await fetchHtml(url, {
        timeout: options.timeout,
        headers: options.headers,
        userAgent: options.userAgent,
      });

      if (mode === 'auto') {
        const renderMode = await detectRenderingMode(fetchResult.html);
        if (renderMode === 'static') {
          return buildResult(fetchResult.html, fetchResult.url, options, startTime);
        }
      } else {
        return buildResult(fetchResult.html, fetchResult.url, options, startTime);
      }
    } catch (error) {
      if (mode === 'fetch') throw error;
      if (!(error instanceof WebScrapeError) || error.isRetryable) {
        // Fall through to browser mode
      } else {
        throw error;
      }
    }
  }

  const browser = new AgentBrowser({
    headless: true,
    timeout: options.timeout ?? 30000,
    proxy: options.proxy ?? '',
    userAgent: options.userAgent,
  });

  try {
    await browser.launch();
    await browser.navigate(url, (options.waitUntil as 'load' | 'domcontentloaded' | 'networkidle') ?? 'networkidle');

    if (options.scroll) {
      await browser.scrollToBottom(800, options.scrollDelay ?? 300, options.maxScrolls ?? 50);
    }

    const html = await browser.html();
    const pageTitle = await browser.title();
    const pageUrl = await browser.url();

    return buildResult(html, pageUrl, options, startTime, pageTitle);
  } finally {
    await browser.close();
  }
}

export async function scrapeHtml(html: string, options: ScrapeOptions = {}): Promise<ScrapeResult> {
  const startTime = Date.now();
  return buildResult(html, 'about:blank', options, startTime);
}

export async function scrapeWithBrowser(
  browser: AgentBrowser,
  url: string,
  options: ScrapeOptions = {}
): Promise<ScrapeResult> {
  const startTime = Date.now();

  await browser.navigate(url, (options.waitUntil as 'load' | 'domcontentloaded' | 'networkidle') ?? 'networkidle');

  if (options.scroll) {
    await browser.scrollToBottom(800, options.scrollDelay ?? 300, options.maxScrolls ?? 50);
  }

  const html = await browser.html();
  const pageTitle = await browser.title();
  const pageUrl = await browser.url();

  return buildResult(html, pageUrl, options, startTime, pageTitle);
}

async function buildResult(
  html: string,
  url: string,
  options: ScrapeOptions,
  startTime: number,
  title?: string,
): Promise<ScrapeResult> {
  const extracted = await extractContent(html, {
    readable: true,
    preserveLinks: options.extractLinks ?? true,
    preserveImages: options.extractImages ?? true,
    preserveTables: options.extractTables ?? true,
    maxLength: options.maxContentLength,
    removeSelectors: options.removeSelectors,
  });

  const duration = Date.now() - startTime;

  return {
    url,
    title: title || extracted.metadata.title || '',
    content: extracted.content,
    format: options.format ?? 'markdown',
    text: extracted.text,
    links: extracted.links,
    images: extracted.images,
    tables: extracted.tables,
    metadata: extracted.metadata,
    extractedAt: new Date().toISOString(),
    duration,
    size: extracted.content.length + extracted.text.length,
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 37: scrape/crawler.ts */
/* ════════════════════════════════════════════════════════════════════ */
export interface CrawlOptions extends ScrapeOptions {
  maxDepth?: number;
  maxPages?: number;
  maxConcurrent?: number;
  sameDomain?: boolean;
  delayMs?: number;
  onDiscover?: (url: string, depth: number) => void;
  onResult?: (result: ScrapeResult) => void;
  onError?: (url: string, error: Error) => void;
}

interface CrawlEntry {
  url: string;
  depth: number;
}

function isSameDomain(url1: string, url2: string): boolean {
  try {
    return new URL(url1).hostname === new URL(url2).hostname;
  } catch {
    return false;
  }
}

function normalizeForDedup(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    return u.href.replace(/\/+$/, '') || u.href;
  } catch {
    return url;
  }
}

export async function legacycrawl(
  startUrl: string,
  options: CrawlOptions = {}
): Promise<{ results: ScrapeResult[]; stats: CrawlStats }> {
  const {
    maxDepth = 2,
    maxPages = 50,
    maxConcurrent = 3,
    sameDomain = true,
    delayMs = 1000,
    onDiscover,
    onResult,
    onError,
    ...scrapeOpts
  } = options;

  const startTime = Date.now();
  const visited = new Set<string>();
  const queue: CrawlEntry[] = [{ url: startUrl, depth: 0 }];
  const results: ScrapeResult[] = [];
  let failed = 0;

  visited.add(normalizeForDedup(startUrl));

  while (queue.length > 0 && results.length < maxPages) {
    const batch = queue.splice(0, maxConcurrent);
    const promises = batch.map(async (entry) => {
      if (entry.depth > maxDepth) return;

      try {
        const result = await scrapeUrl(entry.url, scrapeOpts);
        results.push(result);
        onResult?.(result);

        // Extract links for further crawling
        if (entry.depth < maxDepth) {
          for (const link of result.links) {
            const normalized = normalizeForDedup(link.href);
            if (visited.has(normalized)) continue;
            if (sameDomain && !isSameDomain(startUrl, link.href)) continue;
            try {
              new URL(link.href);
            } catch {
              continue;
            }
            visited.add(normalized);
            queue.push({ url: link.href, depth: entry.depth + 1 });
            onDiscover?.(link.href, entry.depth + 1);
          }
        }
      } catch (error) {
        failed++;
        onError?.(entry.url, error as Error);
      }
    });

    await Promise.all(promises);

    if (delayMs > 0 && queue.length > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  const duration = Date.now() - startTime;

  return {
    results,
    stats: {
      totalUrls: visited.size,
      successful: results.length,
      failed,
      skipped: visited.size - results.length - failed,
      duration,
      avgResponseTime: results.length > 0 ? results.reduce((sum, r) => sum + r.duration, 0) / results.length : 0,
    },
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 38: scrape/server.ts */
/* ════════════════════════════════════════════════════════════════════ */
export interface ServerConfig {
  port?: number;
  host?: string;
  apiKey?: string;
}

/**
 * Builds the hono application lazily — hono is an optional runtime the merged
 * module never requires at load time (the grand-merge load-safety adaptation
 * of the former scrape/server.ts).
 */
async function buildscrapeserver() {
  const { Hono } = await import("hono");
  const { cors } = await import("hono/cors");
  const app = new Hono();

  app.use('*', cors());

  const api = new Hono();

api.post('/scrape', async (c) => {
  const body = await c.req.json();
  const { url, options = {} } = body;

  if (!url) {
    return c.json({ error: { code: 'MISSING_URL', message: 'URL is required' } }, 400);
  }

  try {
    const result = await scrapeUrl(url, options as ScrapeOptions);
    return c.json({ status: 'ok', data: result });
  } catch (error) {
    return c.json({
      error: {
        code: (error as any).code || 'SCRAPE_ERROR',
        message: (error as Error).message,
      }
    }, (error as any).statusCode || 500);
  }
});

api.post('/scrape/agent', async (c) => {
  const body = await c.req.json();
  const { url, options = {} } = body;

  if (!url) {
    return c.json({ error: { code: 'MISSING_URL', message: 'URL is required' } }, 400);
  }

  try {
    const result = await scrapeUrl(url, options as ScrapeOptions);
    const agentOutput = formatForAgent(result);
    return c.json({ status: 'ok', data: agentOutput });
  } catch (error) {
    return c.json({
      error: {
        code: (error as any).code || 'SCRAPE_ERROR',
        message: (error as Error).message,
      }
    }, (error as any).statusCode || 500);
  }
});

api.post('/batch', async (c) => {
  const body = await c.req.json();
  const { urls, options = {}, scrapeOptions = {} } = body;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return c.json({ error: { code: 'MISSING_URLS', message: 'urls array is required' } }, 400);
  }

  try {
    const result = await batchScrape({ urls, ...options }, scrapeOptions as ScrapeOptions);
    return c.json({
      status: 'ok',
      data: {
        successful: result.successful,
        failed: result.failed,
        duration: result.duration,
        results: result.results,
        errors: result.errors.map(e => ({ url: e.url, error: e.error.message })),
      },
    });
  } catch (error) {
    return c.json({
      error: {
        code: 'BATCH_ERROR',
        message: (error as Error).message,
      }
    }, 500);
  }
});

api.post('/crawl', async (c) => {
  const body = await c.req.json();
  const { url, options = {} } = body;

  if (!url) {
    return c.json({ error: { code: 'MISSING_URL', message: 'URL is required' } }, 400);
  }

  try {
    const result = await legacycrawl(url, options);
    return c.json({
      status: 'ok',
      data: {
        stats: result.stats,
        results: result.results.slice(0, 100),
      },
    });
  } catch (error) {
    return c.json({
      error: {
        code: 'CRAWL_ERROR',
        message: (error as Error).message,
      }
    }, 500);
  }
});

api.get('/health', (c) => {
  return c.json({ status: 'ok', version: '2.0.0', uptime: process.uptime() });
});

  app.route('/v1', api);

  return app;
}

/**
 * Creates the self-hosted scrape API surface. The factory became async with
 * the grand merge: the hono application is built on first call and the port
 * draw keeps using the process-wide random port helper.
 */
export async function createServer(config: ServerConfig = {}) {
  const app = await buildscrapeserver();
  return {
    fetch: app.fetch,
    port: config.port || randomPort(),
    host: config.host || '0.0.0.0',
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 39: scrape/cli.ts — the webscrape command-line interface (grand-merge adaptation: commander became a lazy runtime import and the top-level program construction became an exported factory). */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * Runs the webscrape CLI. The former top-level commander construction of
 * scrape/cli.ts became this exported factory in the grand merge: commander
 * is imported on first call and loading the module never requires it.
 */
export async function runscrapecli() {
  const { Command } = await import("commander");
  const program = new Command();

program
  .name('webscrape')
  .description('DevThink WebScrape — Universal AI-powered web scraping toolkit')
  .version('2.0.0');

program
  .argument('[url]', 'URL to scrape')
  .option('-f, --format <type>', 'Output format: markdown, html, text, json, xml, redis', 'markdown')
  .option('-o, --output <file>', 'Write output to file')
  .option('--file <path>', 'Scrape HTML from local file')
  .option('--mode <mode>', 'Scraping mode: auto, fetch, browser', 'auto')
  .option('--no-headless', 'Show browser window')
  .option('--timeout <ms>', 'Navigation timeout', '30000')
  .option('--scroll', 'Scroll page to load dynamic content')
  .option('--readable', 'Extract readable content only')
  .option('--agent', 'Format output for AI agent consumption')
  .option('--pretty', 'Pretty-print JSON output')
  .option('--proxy <url>', 'Proxy server URL')
  .option('--retries <n>', 'Number of retries', '3')
  .option('--user-agent <ua>', 'Custom User-Agent string')
  .action(async (url, options) => {
    if (!url && !options.file) {
      program.help();
    }

    const format = resolveFormat(options.format);
    const scrapeOpts: ScrapeOptions = {
      format,
      timeout: parseInt(options.timeout),
      scroll: options.scroll,
      readable: options.readable,
      mode: options.mode,
      proxy: options.proxy,
      retries: parseInt(options.retries),
      userAgent: options.userAgent,
      extractLinks: true,
      extractImages: true,
      extractTables: true,
    };

    if (options.readable) {
      scrapeOpts.removeSelectors = [
        'script', 'style', 'nav', 'footer', 'header',
        '.sidebar', '.advertisement', '.ads', '.menu',
        '.comments', '.comment', '#comments',
      ];
    }

    console.error(`Scraping: ${url || options.file}`);

    let result: ScrapeResult;

    if (options.file) {
      const filePath = resolve(options.file);
      if (!existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
      }
      const html = readFileSync(filePath, 'utf-8');
      result = await scrapeHtml(html, scrapeOpts);
    } else {
      result = await scrapeUrl(url, scrapeOpts);
    }

    console.error(`Done in ${result.duration}ms (${(result.size / 1024).toFixed(1)} KB)`);

    if (options.agent) {
      const agentOutput = formatForAgent(result);
      const output = JSON.stringify(agentOutput, null, 2);

      if (options.output) {
        writeOutput(options.output, output);
        console.error(`Saved to ${options.output}`);
      } else {
        console.log(output);
      }
    } else {
      const serializeOpts = buildSerializeOptions(format, options.pretty);
      const serialized = serializeResult(result, serializeOpts);

      if (options.output) {
        const ext = extensionForFormat(format);
        const finalPath = options.output.endsWith(ext) ? options.output : options.output + ext;
        writeOutput(finalPath, serialized.content);
        console.error(`Saved to ${finalPath}`);
      } else {
        console.log(serialized.content);
      }
    }
  });

  program.parse();
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 40: scrape/dev-server.ts — the zero-dependency local API server (grand-merge adaptation: the top-level listener became an exported factory so importing the module never binds a port). */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * Starts the local scrape API dev server. The former top-level bootstrap
 * of scrape/dev-server.ts became this exported factory in the grand merge
 * (a merged module must never bind a port as an import side effect).
 */
export function startdevserver() {
  const PORT = randomPort();

  const server = createnodeserver(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/api/scrape') {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  req.on('end', async () => {
    try {
      const { url, format: fmt, options = {} }: {
        url: string;
        format?: string;
        options?: Record<string, unknown>;
      } = JSON.parse(body);
      if (!url) throw new Error('URL is required');

      const format = resolveFormat(fmt || 'markdown');
      const result = await scrapeUrl(url, {
        timeout: 30000,
        scroll: options.scroll as boolean,
        extractLinks: (options.extractLinks as boolean) ?? true,
        extractImages: (options.extractImages as boolean) ?? true,
        extractTables: (options.extractTables as boolean) ?? true,
      } as ScrapeOptions);

      let response: Record<string, unknown>;

      if (options.agent) {
        const agentOutput = formatForAgent(result);
        response = {
          success: true,
          title: result.title,
          url: result.url,
          duration: result.duration,
          size: result.size,
          agentOutput,
        };
      } else {
        const serializeOpts = buildSerializeOptions(format);
        const serialized = serializeResult(result, serializeOpts);
        response = {
          success: true,
          title: result.title,
          url: result.url,
          format,
          content: serialized.content,
          duration: result.duration,
          size: serialized.size,
          metadata: result.metadata,
          links: result.links,
          images: result.images,
          tables: result.tables,
          result,
        };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (err) {
      const error = err as Error;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
});

  server.listen(PORT, () => {
    console.log(`API server running at http://localhost:${PORT}`);
    console.log(`POST /api/scrape with { url, format?, options? }`);
  });

  return server;
}
