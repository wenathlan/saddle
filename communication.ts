/**
 * communication.ts — API, protocol and webhook communication contracts.
 *
 * This file is the v2.0.0 grand-merge consolidation of the former nested
 * folders of the repository (api) into the single
 * root-level domain file of the e2ugh family standard: one optimized
 * TypeScript file per correlated domain, ordinal sections, JSDoc on every
 * block, intra-domain imports dissolved, cross-domain imports rewritten to
 * ./<domain>.js. Every capability of every source file is preserved here;
 * the pure re-export barrels (none in this domain) folded their surface into this file directly.
 */

import { crawl } from "./acquisition.js";
import { controlsurface } from "./automation.js";
import { constanttimeequal, hmacsha256 } from "./foundation.js";

/* ════════════════════════════════════════════════════════════════════ */
/* Section 1: api/auth.ts — api authorization delegates token verification to the caller and never stores credentials. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * api authorization delegates token verification to the caller and never stores credentials.
 */

/** Authorizes a request through an injected verifier or returns an anonymous principal. */
export async function authorize(request, options = {}) {
  const token = request?.headers?.get?.("authorization")?.replace(/^Bearer\s+/i, "") ?? request?.headers?.get?.("x-api-key");
  if (typeof options.verify !== "function") return { authenticated: false, subject: "anonymous", tokenpresent: Boolean(token) };
  if (!token) return { authenticated: false, subject: "anonymous", tokenpresent: false };
  const principal = await options.verify(token, request);
  if (!principal) { const error = new Error("request is not authorized"); error.code = "UNAUTHORIZED"; throw error; }
  return { authenticated: true, subject: String(principal.subject ?? principal.id ?? "caller"), claims: { ...(principal.claims ?? {}) } };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 2: api/contracts.ts — api contracts keep request identity and success envelopes stable across HTTP and MCP adapters. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * api contracts keep request identity and success envelopes stable across HTTP and MCP adapters.
 */

export const apiversion = 1;

/** Extracts a caller supplied request id or creates a local id without exposing secrets. */
export function requestcontext(request, options = {}) {
  const requestid = request?.headers?.get?.("x-request-id") ?? options.requestid ?? `request${Date.now().toString(36)}`;
  return { version: apiversion, requestid: String(requestid), method: request?.method ?? options.method, path: options.path };
}

/** Creates a versioned success envelope for APIs that opt into envelopes. */
export function successpayload(data, context = {}) { return { version: apiversion, requestid: String(context.requestid ?? `request${Date.now().toString(36)}`), data }; }

/** Creates a versioned error payload with a stable retry hint. */
export function errorpayload(code, message, context = {}) { return { version: apiversion, requestid: String(context.requestid ?? `request${Date.now().toString(36)}`), error: { code: String(code), message: String(message), retryafter: Number(context.retryafter ?? 0) } }; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 3: api/security.ts — URL security rejects private network targets before a fetch is attempted. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * URL security rejects private network targets before a fetch is attempted.
 * DNS resolution remains a host adapter concern and is never performed silently.
 */
export function assertpublicurl(value, options = {}) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("url protocol is not allowed");
  if (Array.isArray(options.allowedhosts) && options.allowedhosts.length > 0 && !options.allowedhosts.includes(url.hostname)) throw new Error("url host is not allowed");
  if (options.allowprivate) return url;
  if (privatehostname(url.hostname) || privateip(url.hostname)) throw new Error("private network target is not allowed");
  return url;
}

/** Checks a resolved address list through a caller supplied DNS resolver to reduce rebinding risk. */
export async function assertresolvedpublicurl(value, options = {}) {
  const url = assertpublicurl(value, options);
  if (typeof options.resolve !== "function" || options.allowprivate) return url;
  const addresses = await options.resolve(url.hostname);
  if (!Array.isArray(addresses) || addresses.length === 0) throw new Error("url host did not resolve to an address");
  for (const address of addresses) if (privateip(String(address)) || privatehostname(String(address))) throw new Error("resolved target is private");
  return url;
}

/** Validates a redirect chain as public and bounded before a caller follows it. */
export function assertredirectchain(values = [], options = {}) {
  const maxredirects = Number(options.maxredirects ?? 5);
  if (!Array.isArray(values) || values.length > maxredirects + 1) throw new Error("redirect chain exceeds configured limit");
  return values.map((value) => assertpublicurl(value, options).href);
}

/** Returns a non throwing boolean for validators and middleware. */
export function ispublicurl(value, options = {}) { try { assertpublicurl(value, options); return true; } catch { return false; } }

function privatehostname(hostname) { const value = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, ""); return value.endsWith(".local") || value.endsWith(".internal") || value.endsWith(".localhost") || value === "localhost" || value === "broadcasthost"; }
function privateip(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:") || normalized.startsWith("::ffff:")) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return first === 10 || first === 127 || first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 4: api/rate.ts — token bucket rate limiting supports global user and domain keys. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * token bucket rate limiting supports global user and domain keys.
 */
export function ratebucket(options = {}) {
  const capacity = options.capacity ?? 10;
  const refill = options.refill ?? capacity;
  const interval = options.interval ?? 60000;
  const buckets = new Map();
  function consume(key, cost = 1) {
    const now = Date.now();
    const previous = buckets.get(key) ?? { tokens: capacity, at: now };
    const tokens = Math.min(capacity, previous.tokens + ((now - previous.at) / interval) * refill);
    if (tokens < cost) return { allowed: false, retryafter: Math.ceil(((cost - tokens) / refill) * interval) };
    buckets.set(key, { tokens: tokens - cost, at: now });
    return { allowed: true, retryafter: 0 };
  }
  return { consume, clear() { buckets.clear(); } };
}

export function ratelimiter(options = {}) {
  const global = ratebucket(options.global ?? { capacity: 1000, refill: 1000 });
  const user = ratebucket(options.user ?? { capacity: 100, refill: 100 });
  const domain = ratebucket(options.domain ?? { capacity: 10, refill: 10 });
  return {
    check(input = {}) {
      const checks = [[global, "global"], [user, `user:${input.user ?? "anonymous"}`], [domain, `domain:${input.domain ?? "unknown"}`]];
      for (const [bucket, key] of checks) { const result = bucket.consume(key); if (!result.allowed) return { allowed: false, retryafter: result.retryafter, scope: key }; }
      return { allowed: true, retryafter: 0 };
    }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 5: api/http.ts — http helpers use the web request response contract and remain framework neutral. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * http helpers use the web request response contract and remain framework neutral.
 */
export function jsonresponse(data, options = {}) { return new Response(JSON.stringify(data), { status: options.status ?? 200, headers: { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...(options.headers ?? {}) } }); }

export function errorresponse(code, message, options = {}) { return jsonresponse({ error: { code, message, retryafter: options.retryafter ?? 0, requestid: options.requestid ?? `request${Date.now().toString(36)}` } }, { status: options.status ?? 400, headers: options.headers }); }

export function sseresponse(events) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({ start(controller) { for (const event of events) controller.enqueue(encoder.encode(`event: ${event.event ?? "message"}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`)); controller.close(); } });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-store", connection: "keep-alive", "x-accel-buffering": "no", "x-content-type-options": "nosniff" } });
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 6: api/json.ts — json helpers keep serialization rules explicit at the protocol boundary. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * json helpers keep serialization rules explicit at the protocol boundary.
 */
export function jsonencode(value) { return JSON.stringify(value); }
export function jsondecode(value) { return JSON.parse(value); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 7: api/ndjson.ts — ndjson supports append only records and incremental parsing. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * ndjson supports append only records and incremental parsing.
 */

export async function* ndjsonencode(values) { for await (const value of values) yield `${jsonencode(value)}\n`; }

export async function* ndjsondecode(input) {
  let buffer = "";
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) yield jsondecode(line);
  }
  if (buffer.trim()) yield jsondecode(buffer);
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 8: api/sse.ts — sse helpers encode typed events without requiring a web framework. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * sse helpers encode typed events without requiring a web framework.
 */

export function sseencode(event) {
  const lines = [];
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  if (event.event) lines.push(`event: ${event.event}`);
  for (const line of jsonencode(event.data ?? {}).split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

export function ssedecode(chunk) {
  const fields = {};
  for (const line of String(chunk).split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index < 0) continue;
    fields[line.slice(0, index)] = line.slice(index + 1).trimStart();
  }
  return { id: fields.id, event: fields.event, data: fields.data ? jsondecode(fields.data) : undefined };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 9: api/blocks.ts — block streaming yields bounded chunks and lets the consumer control backpressure. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * block streaming yields bounded chunks and lets the consumer control backpressure.
 */
export async function* blockstream(input, options = {}) {
  const blockbytes = options.blockbytes;
  if (!Number.isInteger(blockbytes) || blockbytes < 1) throw new TypeError("blockbytes must be a positive integer");
  let index = 0;
  let offset = 0;
  let pending = new Uint8Array(0);
  for await (const part of input instanceof Uint8Array ? [input] : input) {
    const data = part instanceof Uint8Array ? part : new TextEncoder().encode(String(part));
    pending = concat(pending, data);
    while (pending.byteLength > blockbytes) { const block = pending.slice(0, blockbytes); pending = pending.slice(blockbytes); yield { index, offset, data: block, final: false }; index += 1; offset += block.byteLength; }
  }
  if (pending.byteLength) yield { index, offset, data: pending, final: true };
}

function concat(left, right) { const output = new Uint8Array(left.byteLength + right.byteLength); output.set(left); output.set(right, left.byteLength); return output; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 10: api/service.ts — saddle service exposes universal routes without choosing hono fastify express or another server. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * saddle service exposes universal routes without choosing hono fastify express or another server.
 */

export function saddleservice(options = {}) {
  if (typeof options.scrape !== "function") throw new TypeError("service requires scrape");
  const limit = options.ratelimiter ?? ratelimiter();
  const jobs = new Map();
  async function handle(request) {
    const url = new URL(request.url ?? request);
    const context = requestcontext(request, { path: url.pathname });
    const input = request.json ? await request.clone().json().catch(() => ({})) : request.body ?? {};
    let principal;
    try { principal = await authorize(request, { verify: options.verify }); } catch (error) { console.error(error); return errorresponse(error.code ?? "UNAUTHORIZED", error instanceof Error && (error as { code?: string }).code ? error.message : "authentication failed", { status: 401, requestid: context.requestid }); }
    const rate = limit.check({ user: request.headers?.get?.("x-api-key") ?? "anonymous", domain: url.hostname });
    if (!rate.allowed) return errorresponse("RATE_LIMITED", "request rate limit exceeded", { status: 429, retryafter: rate.retryafter, requestid: context.requestid });
    try {
      if (url.pathname === "/health" && request.method === "GET") return jsonresponse({ healthy: true, jobs: jobs.size, principal: principal.subject }, { headers: { "x-request-id": context.requestid } });
      if (url.pathname === "/v1/event" && request.method === "GET") return sseresponse([{ event: "health", data: { healthy: true } }]);
      if (url.pathname === "/v1/scrape" && request.method === "POST") { assertpublicurl(input.url, options.security); const result = await options.scrape(input.url, input); return jsonresponse(options.envelope ? successpayload(result, context) : result, { headers: { "x-request-id": context.requestid } }); }
      if (url.pathname === "/v1/crawl" && request.method === "POST") { assertpublicurl(input.url, options.security); const result = await crawl(input.url, { ...input, scrape: (target) => options.scrape(target, input) }); return jsonresponse(result); }
      if (url.pathname === "/v1/batch" && request.method === "POST") { const results = []; for (const item of input.urls ?? []) { assertpublicurl(item, options.security); results.push(await options.scrape(item, input)); } return jsonresponse({ results, completed: results.length, total: input.urls?.length ?? 0 }); }
      if (url.pathname === "/v1/scrape/async" && request.method === "POST") { assertpublicurl(input.url, options.security); const id = `task${Date.now().toString(36)}${jobs.size}`; jobs.set(id, { id, status: "queued" }); Promise.resolve(options.scrape(input.url, input)).then((result) => jobs.set(id, { id, status: "completed", result }), (error) => { console.error(error); jobs.set(id, { id, status: "failed", error: error instanceof Error && (error as { code?: string }).code ? error.message : "scrape failed" }); }); return jsonresponse({ id, status: "queued" }, { status: 202 }); }
      const match = url.pathname.match(/^\/v1\/scrape\/([^/]+)$/);
      if (match && request.method === "GET") return jobs.has(match[1]) ? jsonresponse(jobs.get(match[1])) : errorresponse("NOT_FOUND", "task not found", { status: 404 });
      return errorresponse("NOT_FOUND", "route not found", { status: 404 });
    } catch (error) { console.error(error); return errorresponse(error.code ?? "REQUEST_FAILED", error instanceof Error && (error as { code?: string }).code ? error.message : "request failed", { status: error.code === "UNAUTHORIZED" ? 401 : 500, requestid: context.requestid }); }
  }
  return { handle, jobs };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 11: api/control.ts — control service exposes operator controls through Web Request and Response without selecting a web framework. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * control service exposes operator controls through Web Request and Response without selecting a web framework.
 */


/** Creates a framework-neutral HTTP handler for an injected operator control surface. */
export function controlservice(options = {}) {
  const controls = options.controls ?? controlsurface({ adapters: options.adapters, audit: options.audit });
  const path = String(options.path ?? "/v1/control");
  if (!path.startsWith("/")) throw new TypeError("control service path must be absolute");

  async function handle(request) {
    const context = requestcontext(request, { path });
    try {
      await authorize(request, { verify: options.verify });
      const url = new URL(request.url ?? request);
      if (url.pathname !== path) return errorresponse("NOT_FOUND", "control route not found", { status: 404, requestid: context.requestid });
      if (request.method === "GET") return jsonresponse({ ...controls.describe(), requestid: context.requestid });
      if (request.method !== "POST") return errorresponse("METHOD_NOT_ALLOWED", "control route requires GET or POST", { status: 405, requestid: context.requestid });
      const input = typeof request.json === "function" ? await request.json() : {};
      const result = await controls.execute(input);
      return jsonresponse({ requestid: context.requestid, data: result }, { status: result.ok ? 200 : 409 });
    } catch (error) {
      console.error(error);
      return errorresponse(error?.code ?? "CONTROL_REQUEST_FAILED", error instanceof Error && (error as { code?: string }).code ? error.message : "control request failed", { status: error?.code === "UNAUTHORIZED" ? 401 : 400, requestid: context.requestid });
    }
  }

  return { path, controls, handle };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 12: api/webhooksignature.ts — webhook signatures use hmac sha256 and keep secrets outside serialized events. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * webhook signatures use hmac sha256 and keep secrets outside serialized events.
 */

export function webhooksig(payload, secret) { return hmacsha256(typeof payload === "string" ? payload : JSON.stringify(payload), secret); }
export function webhookverify(payload, signature, secret) { return constanttimeequal(webhooksig(payload, secret), signature); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 13: api/webhookdelivery.ts — webhook delivery tracks attempts and dead letters without choosing a queue vendor. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * webhook delivery tracks attempts and dead letters without choosing a queue vendor.
 */

/** Creates a sequential delivery queue with retryable failure handling. */
export function deliveryqueue(options = {}) {
  const maxattempts = Number(options.maxattempts ?? 3);
  const records = new Map();
  const dead = [];
  async function deliver(input = {}, handler) {
    if (typeof handler !== "function") throw new TypeError("delivery handler must be a function");
    const id = String(input.id ?? `delivery${Date.now().toString(36)}${records.size}`);
    const record = { id, status: "pending", attempts: 0, createdat: Date.now(), event: input.event, metadata: { ...(input.metadata ?? {}) } };
    records.set(id, record);
    while (record.attempts < maxattempts) {
      record.attempts += 1;
      try { record.result = await handler(input.event, input); record.status = "delivered"; record.updatedat = Date.now(); return { ...record }; }
      catch (error) { record.error = { code: String(error.code ?? "DELIVERY_FAILED"), message: String(error.message ?? error), retryable: Boolean(error.retryable) }; if (!error.retryable) break; }
    }
    record.status = "dead";
    dead.push({ ...record });
    record.updatedat = Date.now();
    return { ...record };
  }
  return { deliver, get(id) { return records.get(String(id)); }, list() { return [...records.values()].map((record) => ({ ...record })); }, deadletters() { return dead.map((record) => ({ ...record })); } };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 14: api/webhookreceiver.ts — webhook receiver validates signatures before dispatch and drops duplicate delivery ids. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * webhook receiver validates signatures before dispatch and drops duplicate delivery ids.
 */

export function webhookreceiver(options = {}) {
  if (typeof options.secret !== "string" || typeof options.handle !== "function") throw new TypeError("webhook receiver requires secret and handler");
  const deliveries = new Set();
  return {
    async receive(input = {}) {
      if (!webhookverify(input.body, input.signature, options.secret)) return { accepted: false, status: 401, reason: "invalid signature" };
      const id = input.deliveryid ?? input.eventid;
      if (id && deliveries.has(id)) return { accepted: false, status: 200, duplicate: true };
      if (id) deliveries.add(id);
      const result = await options.handle(input.event, input.body);
      return { accepted: true, status: 202, deliveryid: id, result };
    },
    deliveries() { return [...deliveries]; }
  };
}
