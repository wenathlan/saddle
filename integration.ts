/**
 * integration.ts — replaceable forge, application, MCP and transport adapters.
 *
 * This file is the v2.0.0 grand-merge consolidation of the former nested
 * folders of the repository (adapters) into the single
 * root-level domain file of the e2ugh family standard: one optimized
 * TypeScript file per correlated domain, ordinal sections, JSDoc on every
 * block, intra-domain imports dissolved, cross-domain imports rewritten to
 * ./<domain>.js. Every capability of every source file is preserved here;
 * the pure re-export barrels (none in this domain) folded their surface into this file directly.
 */

import { jsondecode, jsonencode } from "./communication.js";
import { crawl, extractwithschema } from "./acquisition.js";

/* ════════════════════════════════════════════════════════════════════ */
/* Section 1: adapters/transport.ts — transport centralizes timeout retry and jitter without choosing a host or vendor. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * transport centralizes timeout retry and jitter without choosing a host or vendor.
 */
export function transport(options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const attempts = options.attempts ?? 3;
  const timeout = options.timeout ?? 30000;
  const retrycodes = new Set(options.retrycodes ?? [408, 409, 429, 500, 502, 503, 504]);
  async function request(url, init = {}) {
    let last;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetcher(url, { ...init, signal: init.signal ?? controller.signal });
        if (response.ok || !retrycodes.has(response.status) || attempt === attempts - 1) return response;
        last = new Error(`request failed with ${response.status}`);
      } catch (error) {
        last = error;
        if (attempt === attempts - 1) throw error;
      } finally { clearTimeout(timer); }
      await delay(backoff(options, attempt));
    }
    throw last ?? new Error("request failed");
  }
  return { request };
}

function backoff(options, attempt) { const base = options.backoff ?? 250; const jitter = options.jitter ?? 0; return base * 2 ** attempt + Math.floor(Math.random() * jitter); }
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 2: adapters/socket.ts — socket adapter keeps realtime optional and accepts a caller supplied websocket constructor. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * socket adapter keeps realtime optional and accepts a caller supplied websocket constructor.
 */
export function socketadapter(options = {}) {
  const websocket = options.websocket ?? globalThis.WebSocket;
  if (!websocket) throw new Error("websocket implementation is required");
  return {
    connect(url, protocols) {
      if (!url) throw new TypeError("socket url is required");
      const socket = new websocket(url, protocols);
      return { socket, send(value) { socket.send(typeof value === "string" ? value : JSON.stringify(value)); }, close(code, reason) { socket.close(code, reason); } };
    }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 3: adapters/github.ts — github adapter uses caller supplied credentials and base url configuration. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * github adapter uses caller supplied credentials and base url configuration.
 */

export function githubadapter(options = {}) {
  if (!options.baseurl || typeof options.token !== "function") throw new TypeError("github adapter requires baseurl and token function");
  const client = transport({ fetcher: options.fetcher, attempts: options.attempts, timeout: options.timeout });
  async function call(path, init = {}) {
    const token = await options.token();
    const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": options.apiversion ?? "2022-11-28", ...(init.headers ?? {}) };
    return client.request(new URL(path, options.baseurl), { ...init, headers });
  }
  return {
    async health() { const response = await call("/rate_limit"); return { ok: response.ok, status: response.status }; },
    async dispatch(owner, repository, workflow, input = {}) { const response = await call(`/repos/${owner}/${repository}/actions/workflows/${workflow}/dispatches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: input.ref ?? "main", inputs: input.inputs ?? {} }) }); return { accepted: response.status === 204, status: response.status }; },
    async run(owner, repository, runid) { const response = await call(`/repos/${owner}/${repository}/actions/runs/${runid}`); return response.json(); }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 4: adapters/gitlab.ts — gitlab adapter keeps project addressing and token ownership outside the package. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * gitlab adapter keeps project addressing and token ownership outside the package.
 */

export function gitlabadapter(options = {}) {
  const project = encodeURIComponent(options.project ?? "");
  const base = forgeadapter({ ...options, kind: "gitlab" });
  return { ...base, async dispatch(spec) { return base.dispatch({ ...spec, path: spec.path ?? `/api/v4/projects/${project}/pipeline` }); } };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 5: adapters/forge.ts — forge adapter defines the common dispatch and artifact surface for compatible forges. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * forge adapter defines the common dispatch and artifact surface for compatible forges.
 */

export function forgeadapter(options = {}) {
  if (!options.baseurl || typeof options.token !== "function") throw new TypeError("forge adapter requires baseurl and token function");
  const client = transport({ fetcher: options.fetcher, attempts: options.attempts, timeout: options.timeout });
  async function call(path, init = {}) { const token = await options.token(); return client.request(new URL(path, options.baseurl), { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.headers ?? {}) } }); }
  return {
    kind: options.kind ?? "forge",
    async health(path = "/") { const response = await call(path); return { ok: response.ok, status: response.status }; },
    async dispatch(spec) { if (!spec?.path || !spec.ref) throw new TypeError("forge dispatch requires path and ref"); const response = await call(spec.path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: spec.ref, inputs: spec.inputs ?? {} }) }); return { accepted: response.ok, status: response.status, body: response.json ? await response.json() : undefined }; },
    async upload(spec) { if (!spec?.path || !spec.data) throw new TypeError("forge upload requires path and data"); const response = await call(spec.path, { method: "PUT", headers: { "content-type": spec.contenttype ?? "application/octet-stream" }, body: spec.data }); return { accepted: response.ok, status: response.status }; }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 6: adapters/forgejo.ts — forgejo and gitea can reuse the open forge contract with a caller supplied base url. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * forgejo and gitea can reuse the open forge contract with a caller supplied base url.
 */

export function forgejoadapter(options = {}) { return forgeadapter({ ...options, kind: "forgejo" }); }
export function giteaadapter(options = {}) { return forgeadapter({ ...options, kind: "gitea" }); }
export function codebergadapter(options = {}) { return forgeadapter({ ...options, kind: "codeberg" }); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 7: adapters/huggingface.ts — hugging face storage remains an explicit adapter with caller supplied repository path. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * hugging face storage remains an explicit adapter with caller supplied repository path.
 */

export function huggingfaceadapter(options = {}) { return forgeadapter({ ...options, kind: "huggingface" }); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 8: adapters/apps.ts — app registry keeps installation, scope and revocation state outside platform credentials. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * app registry keeps installation, scope and revocation state outside platform credentials.
 */

export const appstatuses = Object.freeze(["installed", "suspended", "revoked"]);

/** Creates a caller-owned app installation registry with explicit scopes. */
export function appregistry(options = {}) {
  const values = new Map(options.apps ? options.apps.map((app) => [app.id, normalize(app)]) : []);
  function install(input = {}) { if (!input.id || !input.name) throw new TypeError("app installation requires id and name"); const app = normalize({ ...input, status: "installed", installedat: input.installedat ?? Date.now() }); values.set(app.id, app); return { ...app, scopes: [...app.scopes] }; }
  function suspend(id) { return transition(id, "suspended"); }
  function revoke(id) { return transition(id, "revoked"); }
  function restore(id) { return transition(id, "installed"); }
  function authorize(id, required = []) { const app = requireapp(id); if (app.status !== "installed") return { allowed: false, reason: `app-${app.status}` }; const missing = required.filter((scope) => !app.scopes.includes(scope)); return { allowed: missing.length === 0, missing, appid: app.id }; }
  function get(id) { const app = values.get(String(id)); return app ? { ...app, scopes: [...app.scopes] } : null; }
  function list() { return [...values.values()].map((app) => ({ ...app, scopes: [...app.scopes] })); }
  return { install, suspend, revoke, restore, authorize, get, list };
  function requireapp(id) { const app = values.get(String(id)); if (!app) throw new Error(`app not found: ${id}`); return app; }
  function transition(id, status) { const app = requireapp(id); if (!appstatuses.includes(status)) throw new TypeError(`unsupported app status: ${status}`); app.status = status; app.updatedat = Date.now(); return get(id); }
}

function normalize(input) { return { id: String(input.id), name: String(input.name), status: input.status ?? "installed", scopes: [...new Set((input.scopes ?? []).map(String))], installedat: Number(input.installedat ?? Date.now()), updatedat: Number(input.updatedat ?? Date.now()), metadata: { ...(input.metadata ?? {}) } }; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 9: adapters/mcptransport.ts — mcp transport keeps JSON RPC framing separate from the tool server. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * mcp transport keeps JSON RPC framing separate from the tool server.
 */

/** Creates JSONL and HTTP handlers for the transport agnostic MCP server. */
export function mcptransport(server) {
  if (typeof server?.handle !== "function") throw new TypeError("mcp transport requires server");
  return {
    async handleline(line) { const request = jsondecode(line); return jsonencode(await server.handle(request)); },
    async *stream(lines) { for await (const line of lines) if (String(line).trim()) yield await this.handleline(line); },
    async handlehttp(request) { const body = await request.text(); const response = await server.handle(jsondecode(body)); return new Response(jsonencode(response), { status: 200, headers: { "content-type": "application/json" } }); }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 10: adapters/mcpserver.ts — mcp server implements a small JSON RPC tool surface and remains transport agnostic. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * mcp server implements a small JSON RPC tool surface and remains transport agnostic.
 */

export function mcpserver(options = {}) {
  if (typeof options.scrape !== "function") throw new TypeError("mcp server requires scrape");
  const tools = {
    scrape: async (input) => options.scrape(input.url, input),
    crawl: async (input) => crawl(input.url, { ...input, scrape: (url) => options.scrape(url, input) }),
    batch: async (input) => ({ results: await Promise.all((input.urls ?? []).map((url) => options.scrape(url, input))) }),
    extract: async (input) => extractwithschema(input.html, input.schema, input.url),
    serialize: async (input) => jsonencode(input.value),
    ...(options.browser ? browsertools(options.browser) : {}),
    ...(options.tools ?? {})
  };
  return {
    listtools() { return Object.keys(tools).map((name) => ({ name, description: `saddle ${name} tool` })); },
    async handle(request) {
      if (request.method === "tools/list") return { jsonrpc: "2.0", id: request.id, result: { tools: this.listtools() } };
      if (request.method === "tools/call") { const handler = tools[request.params?.name]; if (!handler) return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "tool not found" } }; try { return { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(await handler(request.params.arguments ?? {})) }] } }; } catch (error) { return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error.message } }; } }
      return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } };
    }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 11: adapters/mcpbrowser.ts — browser MCP tools expose snapshots and actions only through an injected browser adapter. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * browser MCP tools expose snapshots and actions only through an injected browser adapter.
 */

/** Creates optional browser tools for an MCP server without selecting Playwright or another vendor. */
export function browsertools(browser) {
  if (typeof browser?.snapshot !== "function" || typeof browser?.action !== "function") throw new TypeError("browser MCP tools require snapshot and action");
  return {
    browser_snapshot: async (input = {}) => browser.snapshot(input),
    browser_action: async (input = {}) => browser.action(input)
  };
}
