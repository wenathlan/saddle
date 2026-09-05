/**
 * browser.ts — browser, virtual-browser and browser-extension contracts.
 *
 * This file is the v2.0.0 grand-merge consolidation of the former nested
 * folders of the repository (browser, extension) into the single
 * root-level domain file of the e2ugh family standard: one optimized
 * TypeScript file per correlated domain, ordinal sections, JSDoc on every
 * block, intra-domain imports dissolved, cross-domain imports rewritten to
 * ./<domain>.js. Every capability of every source file is preserved here;
 * the pure re-export barrels (browser/index.ts, extension/index.ts) folded their surface into this file directly.
 */

import { executiondecision, executionrequest } from "./isolation.js";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* ════════════════════════════════════════════════════════════════════ */
/* Section 1: browser/fingerprint.ts — fingerprint profiles keep session settings coherent without modifying browser internals. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * fingerprint profiles keep session settings coherent without modifying browser internals.
 */
const profiles = Object.freeze({
  desktopwindows: { os: "windows", platform: "Win32", browser: "chrome", locale: "en-US", timezone: "America/New_York", touch: false, devicepixelratio: 1 },
  desktopmacos: { os: "macos", platform: "MacIntel", browser: "safari", locale: "en-US", timezone: "America/Los_Angeles", touch: false, devicepixelratio: 2 },
  mobileandroid: { os: "android", platform: "Linux armv8l", browser: "chrome", locale: "en-US", timezone: "America/Chicago", touch: true, devicepixelratio: 2.75 }
});

export function fingerprintprofile(name = "desktopwindows", overrides = {}) { return { ...(profiles[name] ?? profiles.desktopwindows), ...overrides, name }; }
export function fingerprintvalidate(profile) { return Boolean(profile?.os && profile?.platform && profile?.browser && profile?.locale && profile?.timezone && typeof profile.touch === "boolean"); }
export function fingerprintfor(sessionid, options = {}) { const names = options.profiles ?? Object.keys(profiles); const index = [...String(sessionid)].reduce((sum, value) => sum + value.charCodeAt(0), 0) % names.length; return fingerprintprofile(names[index], options.overrides); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 2: browser/session.ts — browser sessions bind one fingerprint to one proxy and one event recorder. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * browser sessions bind one fingerprint to one proxy and one event recorder.
 */

export function browsersession(options = {}) {
  const id = options.id ?? `browsersession${Date.now().toString(36)}`;
  const fingerprint = options.fingerprint ?? fingerprintfor(id, options);
  if (!fingerprintvalidate(fingerprint)) throw new TypeError("browser fingerprint is incoherent");
  const events = [];
  return {
    id,
    fingerprint,
    proxy: options.proxy,
    record(event) { if (!event || !Number.isFinite(event.t) || event.t < 0 || typeof event.type !== "string") throw new TypeError("browser event is invalid"); events.push({ ...event }); return event; },
    events() { return events.map((event) => ({ ...event })); },
    manifest() { return { id, fingerprint: { ...fingerprint }, proxy: options.proxy?.id ?? options.proxy, eventcount: events.length }; }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 3: browser/actions.ts — browser actions normalize adapter outcomes and preserve failure metadata for agents and replay. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * browser actions normalize adapter outcomes and preserve failure metadata for agents and replay.
 */

export const browseractions = Object.freeze(["navigate", "click", "type", "fill", "key", "scroll", "upload", "screenshot", "snapshot"]);

/** Creates a stable action result independent of the underlying browser vendor. */
export function actionresult(action, options = {}) {
  if (!browseractions.includes(action)) throw new TypeError(`unsupported browser action: ${action}`);
  return { version: 1, action, ok: true, startedat: Number(options.startedat ?? Date.now()), finishedat: Number(options.finishedat ?? Date.now()), tabid: options.tabid === undefined ? undefined : String(options.tabid), frameid: options.frameid === undefined ? undefined : String(options.frameid), snapshotid: options.snapshotid, value: options.value, metadata: options.metadata ?? {} };
}

/** Creates a stable action failure without leaking adapter internals or credentials. */
export function actionfailure(action, error, options = {}) {
  if (!action || typeof action !== "string") throw new TypeError("browser action failure requires an action name");
  return { version: 1, action, ok: false, code: String(options.code ?? error?.code ?? "BROWSER_ACTION_FAILED"), message: String(error?.message ?? error ?? "browser action failed"), retryable: Boolean(options.retryable ?? error?.retryable), tabid: options.tabid === undefined ? undefined : String(options.tabid), frameid: options.frameid === undefined ? undefined : String(options.frameid), snapshotid: options.snapshotid, metadata: options.metadata ?? {} };
}

/** Executes a bounded list of actions through an injected adapter and keeps per-action outcomes. */
export async function actionbatch(adapter, actions = [], options = {}) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("browser action batch requires an adapter");
  if (!Array.isArray(actions) || actions.length > (options.maxactions ?? 100)) throw new TypeError("browser action batch is invalid or too large");
  const results = [];
  for (const item of actions) {
    const action = String(item?.action ?? "");
    const method = adapter[action];
    if (typeof method !== "function") { results.push(actionfailure(action, new Error(`browser adapter does not support ${action}`), { code: "UNSUPPORTED_ACTION" })); continue; }
    const startedat = Date.now();
    try { const value = await method(item.options ?? item.value); results.push(actionresult(action, { ...item, startedat, finishedat: Date.now(), value })); }
    catch (error) { results.push(actionfailure(action, error, { ...item, tabid: item.tabid, frameid: item.frameid, snapshotid: item.snapshotid })); if (options.stoponerror) break; }
  }
  return results;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 4: browser/context.ts — browser context tracks tabs and frames without owning a browser implementation. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * browser context tracks tabs and frames without owning a browser implementation.
 */

/** Creates a serializable browser context registry for an injected browser adapter. */
export function browsercontext(options = {}) {
  const sessionid = String(options.sessionid ?? `context${Date.now().toString(36)}`);
  const tabs = new Map();
  let activeid = options.activeid === undefined ? undefined : String(options.activeid);

  function opentab(input = {}) {
    const id = String(input.id ?? `tab${tabs.size + 1}`);
    const tab = { id, url: String(input.url ?? "about:blank"), title: String(input.title ?? ""), active: Boolean(input.active), frames: new Map() };
    tabs.set(id, tab);
    if (tab.active || activeid === undefined) { activeid = id; tab.active = true; }
    return describetab(tab);
  }

  function closetab(id) {
    const key = String(id);
    if (!tabs.delete(key)) return false;
    if (activeid === key) activeid = tabs.keys().next().value;
    if (activeid && tabs.has(activeid)) tabs.get(activeid).active = true;
    return true;
  }

  function setactive(id) {
    const key = String(id);
    const tab = tabs.get(key);
    if (!tab) throw new Error(`unknown browser tab: ${key}`);
    for (const item of tabs.values()) item.active = false;
    tab.active = true;
    activeid = key;
    return describetab(tab);
  }

  function openframe(tabid, input = {}) {
    const tab = requiretab(tabid);
    const id = String(input.id ?? `frame${tab.frames.size + 1}`);
    tab.frames.set(id, { id, url: String(input.url ?? tab.url), parentid: input.parentid === undefined ? undefined : String(input.parentid), name: String(input.name ?? "") });
    return { ...tab.frames.get(id) };
  }

  function closeframe(tabid, frameid) { return Boolean(requiretab(tabid).frames.delete(String(frameid))); }
  function activetab() { return activeid === undefined ? undefined : describetab(requiretab(activeid)); }
  function describe() { return { sessionid, activeid, tabs: [...tabs.values()].map(describetab) }; }

  return { sessionid, opentab, closetab, setactive, openframe, closeframe, activetab, describe };

  function requiretab(id) { const tab = tabs.get(String(id)); if (!tab) throw new Error(`unknown browser tab: ${id}`); return tab; }
  function describetab(tab) { return { id: tab.id, url: tab.url, title: tab.title, active: tab.active, frames: [...tab.frames.values()].map((frame) => ({ ...frame })) }; }
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 5: browser/snapshot.ts — browser snapshots turn page state into bounded serializable data with stable references. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * browser snapshots turn page state into bounded serializable data with stable references.
 */

/** Creates a validated page snapshot for browser, MCP and extension adapters. */
export function pagesnapshot(input = {}) {
  if (!input || typeof input !== "object") throw new TypeError("page snapshot must be an object");
  const snapshot = {
    version: 1,
    snapshotid: String(input.snapshotid ?? `snapshot${Date.now().toString(36)}`),
    tabid: input.tabid === undefined ? undefined : String(input.tabid),
    frameid: input.frameid === undefined ? undefined : String(input.frameid),
    url: String(input.url ?? ""),
    title: String(input.title ?? ""),
    text: String(input.text ?? "").slice(0, input.maxtext ?? 100000),
    elements: normalizeelements(input.elements)
  };
  if (!snapshot.snapshotid || !snapshot.url) throw new TypeError("page snapshot requires snapshotid and url");
  return snapshot;
}

/** Creates an element reference bound to a snapshot and browser context. */
export function snapshotref(snapshot, input = {}) {
  const current = pagesnapshot(snapshot);
  const ref = String(input.ref ?? "");
  if (!current.elements.some((element) => element.ref === ref)) throw new TypeError(`snapshot reference not found: ${ref}`);
  return { version: 1, snapshotid: current.snapshotid, tabid: current.tabid, frameid: current.frameid, ref };
}

/** Throws a stable error when an action uses a reference from a previous page state. */
export function assertfreshsnapshot(snapshot, reference) {
  const current = pagesnapshot(snapshot);
  if (!reference || reference.snapshotid !== current.snapshotid || (reference.tabid !== undefined && reference.tabid !== current.tabid) || (reference.frameid !== undefined && reference.frameid !== current.frameid)) {
    const error = new Error("browser snapshot is stale");
    error.code = "STALE_SNAPSHOT";
    error.retryable = true;
    throw error;
  }
  return true;
}

/** Computes additions, removals and changed labels between two page snapshots (the page-side diff of the former browser/snapshot.ts; the extension-protocol diff of the same name lives in the protocol section below). */
export function pagesnapshotdiff(previous, current) {
  const before = pagesnapshot(previous);
  const after = pagesnapshot(current);
  const oldmap = new Map(before.elements.map((element) => [element.ref, element]));
  const newmap = new Map(after.elements.map((element) => [element.ref, element]));
  const added = after.elements.filter((element) => !oldmap.has(element.ref));
  const removed = before.elements.filter((element) => !newmap.has(element.ref));
  const changed = after.elements.filter((element) => oldmap.has(element.ref) && JSON.stringify(oldmap.get(element.ref)) !== JSON.stringify(element));
  return { from: before.snapshotid, to: after.snapshotid, added, removed, changed };
}

/** Projects a page snapshot into a byte-bounded, allowlisted browser context. */
export function projectcontext(snapshot, options = {}) {
  const current = pagesnapshot(snapshot);
  const maxbytes = normalizebudget(options.maxbytes ?? 32768);
  const allowed = normalizefields(options.fields ?? options.allowlist);
  const context = { snapshotid: current.snapshotid };
  const truncated = [];
  for (const field of allowed) {
    if (field === "snapshotid") continue;
    const value = current[field];
    if (value === undefined) continue;
    if (field === "elements") {
      const elements = [];
      for (const element of value) {
        if (fitscontext(context, field, [...elements, element], maxbytes)) elements.push(element);
        else { truncated.push("elements"); break; }
      }
      if (fitscontext(context, field, elements, maxbytes)) context[field] = elements;
      else truncated.push("elements");
      continue;
    }
    if (fitscontext(context, field, value, maxbytes)) { context[field] = value; continue; }
    if (typeof value === "string") context[field] = clipcontextstring(context, field, value, maxbytes);
    else truncated.push(field);
    if (typeof value === "string" && context[field].length < value.length) truncated.push(field);
  }
  const bytes = contextbytes(context);
  if (bytes > maxbytes) throw new RangeError("browser context budget is smaller than stable snapshot identity");
  return { version: 1, snapshotid: current.snapshotid, context, fields: Object.keys(context), bytes, maxbytes, truncated: [...new Set(truncated)] };
}

function normalizeelements(elements) {
  if (!Array.isArray(elements)) return [];
  return elements.slice(0, 500).map((element, index) => ({ ref: String(element?.ref ?? `e${index + 1}`), role: String(element?.role ?? "generic"), name: String(element?.name ?? "").trim().slice(0, 200), value: element?.value === undefined ? undefined : String(element.value).slice(0, 500), disabled: Boolean(element?.disabled) }));
}

const snapshotfields = Object.freeze(["snapshotid", "tabid", "frameid", "url", "title", "text", "elements"]);

function normalizefields(fields) {
  if (fields === undefined) return [...snapshotfields];
  if (!Array.isArray(fields) || fields.length === 0) throw new TypeError("browser context fields must be a non-empty array");
  const normalized = [...new Set(fields.map((field) => String(field)))];
  if (normalized.some((field) => !snapshotfields.includes(field))) throw new TypeError("browser context field is not allowlisted");
  return normalized;
}

function normalizebudget(value) { const normalized = Number(value); if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new RangeError("browser context maxbytes must be a positive safe integer"); return normalized; }

function contextbytes(value) { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }

function fitscontext(context, field, value, maxbytes) { return contextbytes({ ...context, [field]: value }) <= maxbytes; }

function clipcontextstring(context, field, value, maxbytes) {
  let low = 0;
  let high = value.length;
  let result = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = value.slice(0, middle);
    if (fitscontext(context, field, candidate, maxbytes)) { result = candidate; low = middle + 1; } else high = middle - 1;
  }
  return result;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 6: browser/recorder.ts — browser recorder captures action and snapshot boundaries for deterministic replay. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * browser recorder captures action and snapshot boundaries for deterministic replay.
 * The optional event limit keeps long sessions bounded without owning persistence.
 */

/** Creates a recorder that links actions to snapshots and optionally bounds events. */
export function actionrecorder(options = {}) {
  const startedat = Number(options.startedat ?? Date.now());
  const maxevents = limit(options.maxevents);
  const events = [];
  let lastsnapshotid;
  let dropped = 0;

  function snapshot(value) {
    lastsnapshotid = value?.snapshotid;
    add({ type: "snapshot", t: Date.now() - startedat, snapshotid: lastsnapshotid, tabid: value?.tabid, frameid: value?.frameid, context: recordercontext(value) });
    return value;
  }

  function action(input = {}) {
    const context = recordercontext(input.context ?? input);
    const event = { type: "action", t: Date.now() - startedat, action: String(input.action), snapshotid: input.snapshotid ?? lastsnapshotid, tabid: input.tabid, frameid: input.frameid, windowid: input.windowid, context, payload: clonevalue(input.payload ?? {}) };
    add(event);
    return clonevalue(event);
  }

  function list() { return events.map(clonevalue); }
  function manifest() { return { version: 1, startedat, eventcount: events.length, dropped, lastsnapshotid, events: list() }; }
  function exportjson() { return JSON.stringify(manifest()); }
  function clear() { events.length = 0; dropped = 0; lastsnapshotid = undefined; }

  return { snapshot, action, list, manifest, exportjson, clear };

  function add(event) {
    events.push(event);
    while (events.length > maxevents) { events.shift(); dropped += 1; }
  }
}

function limit(value) {
  if (value === undefined) return Infinity;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) throw new TypeError("maxevents must be a non-negative integer");
  return numeric;
}

function clonevalue(value) {
  if (Array.isArray(value)) return value.map(clonevalue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clonevalue(item)]));
  return value;
}

function recordercontext(value = {}) {
  const context = {};
  for (const name of ["windowid", "tabid", "frameid"]) if (value[name] !== undefined) context[name] = String(value[name]);
  return Object.keys(context).length ? context : undefined;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 7: browser/agent.ts — browser agent delegates browser actions to an injected runtime adapter. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * browser agent delegates browser actions to an injected runtime adapter.
 */
export function browseragent(adapter) {
  const required = ["navigate", "click", "type", "screenshot", "html", "text", "title", "scrolltobottom", "executecommands"];
  for (const name of required) if (typeof adapter?.[name] !== "function") throw new TypeError(`browser adapter requires ${name}`);
  const optional = (name) => (...args) => { if (typeof adapter[name] !== "function") throw new Error(`browser adapter does not support ${name}`); return adapter[name](...args); };
  return { navigate: (options) => adapter.navigate(options), click: (target) => adapter.click(target), type: (value) => adapter.type(value), screenshot: (options) => adapter.screenshot(options), html: () => adapter.html(), text: () => adapter.text(), title: () => adapter.title(), scrolltobottom: (options) => adapter.scrolltobottom(options), executecommands: (commands) => adapter.executecommands(commands), fill: optional("fill"), key: optional("key"), upload: optional("upload"), snapshot: optional("snapshot"), tabs: optional("tabs"), frames: optional("frames") };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 8: browser/virtual.ts */
/* ════════════════════════════════════════════════════════════════════ */
// @ts-nocheck
/**
 * virtual browser contracts select remote browser capabilities without launching a browser or touching user state.
 */


const engines = new Set(["chromium", "gecko", "webkit", "custom"]);
const displays = new Set(["webrtc", "cdp", "webdriver", "remote-display", "custom"]);
const storages = new Set(["ephemeral", "caller-managed"]);
const receipts = new Set(["declared", "observed", "completed", "unknown"]);
const distributions = Object.freeze({
  chromium: new Set(["chromium", "chrome", "edge", "brave", "vivaldi", "opera", "ungoogled-chromium"]),
  gecko: new Set(["firefox", "tor-browser"]),
  webkit: new Set(["safari"]),
  custom: new Set(["saddle-browser", "custom"])
});

/** Creates a data-only request for a remote, adapter-owned browser session. */
export function virtualbrowserrequest(input = {}) {
  const engine = valid(input.engine, engines, "browser engine");
  const distribution = nonempty(input.distribution, "browser distribution");
  if (!distributions[engine].has(distribution)) throw new TypeError("browser distribution does not match engine");
  const display = valid(input.display ?? "webrtc", displays, "browser display transport");
  const storage = valid(input.storage ?? "ephemeral", storages, "browser storage policy");
  const execution = executionrequest({
    id: input.id,
    effect: "browser-session",
    target: "remote",
    source: input.source,
    budget: input.budget
  });
  return Object.freeze({
    version: 1,
    state: "requested",
    id: execution.id,
    engine,
    distribution,
    display,
    storage,
    execution,
    localaccess: Object.freeze({ browser: false, filesystem: false, storage: false, process: false }),
    effects: Object.freeze([])
  });
}

/** Evaluates a virtual browser request without contacting a runtime or provider. */
export function virtualbrowserdecision(input, configuration = {}) {
  const request = normalizerequest(input);
  const base = executiondecision(request.execution, configuration);
  const adapter = configuration.adapter ?? {};
  const supportedengines = list(adapter.engines);
  const supporteddistributions = list(adapter.distributions);
  const reasons = [...base.reasons];
  if (!supportedengines.includes(request.engine)) reasons.push("adapter-engine");
  if (!supporteddistributions.includes(request.distribution)) reasons.push("adapter-distribution");
  const allowed = reasons.length === 0;
  return Object.freeze({
    version: 1,
    request,
    state: allowed ? "caller-delegates" : "denied",
    reasons: Object.freeze([...new Set(reasons)].sort()),
    adapter: allowed ? Object.freeze({ owner: String(adapter.owner), engines: Object.freeze(supportedengines), distributions: Object.freeze(supporteddistributions) }) : null,
    effects: Object.freeze([])
  });
}

/** Projects an adapter handoff without launching a browser or transferring user state. */
export function virtualbrowserhandoff(input = {}) {
  const decision = virtualbrowserdecision(input.request, input.configuration);
  if (decision.state !== "caller-delegates") return Object.freeze({ version: 1, state: "browser-disabled", code: "VIRTUAL_BROWSER_POLICY_DENIED", decision, effects: Object.freeze([]) });
  return Object.freeze({ version: 1, state: "caller-delegates", code: "REMOTE_BROWSER_ADAPTER_REQUIRED", decision, effects: Object.freeze([]) });
}

/** Records declared or observed remote-browser capabilities without asserting isolation or trust. */
export function virtualbrowserreceipt(input = {}) {
  const request = normalizerequest(input.request ?? input);
  const state = valid(input.state ?? "declared", receipts, "browser receipt state");
  const adapterid = nonempty(input.adapterid, "browser adapter id");
  const image = nonempty(input.image, "browser image reference");
  return Object.freeze({
    version: 1,
    state,
    request,
    adapterid,
    image,
    capabilities: Object.freeze(list(input.capabilities)),
    effects: Object.freeze([])
  });
}

function list(value) { return [...new Set(Array.isArray(value) ? value.map((entry) => String(entry)) : [])].sort(); }
function normalizerequest(input) {
  if (input?.execution?.effect === "browser-session") return virtualbrowserrequest({ id: input.id, source: input.execution.source, engine: input.engine, distribution: input.distribution, display: input.display, storage: input.storage, budget: input.execution.budget });
  return virtualbrowserrequest(input);
}
function valid(value, collection, name) { const output = String(value ?? ""); if (!collection.has(output)) throw new TypeError(`${name} is invalid`); return output; }
function nonempty(value, name) { const output = String(value ?? ""); if (!output) throw new TypeError(`${name} is required`); return output; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 9: browser/playwright.ts — browser playwright adapter keeps the optional Node browser provider outside the transport-neutral surface. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * browser playwright adapter keeps the optional Node browser provider outside the transport-neutral surface.
 */

/** Creates a caller-owned Playwright browser session when the optional peer is installed. */
export async function createplaywrightsession(options = {}) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch (error) {
    const missing = new Error("optional peer dependency 'playwright' is required for the Playwright adapter", { cause: error });
    missing.code = "OPTIONAL_DEPENDENCY_MISSING";
    throw missing;
  }
  const browsername = options.browser ?? "chromium";
  const browsertype = playwright[browsername];
  if (!browsertype || typeof browsertype.launch !== "function") throw new TypeError(`unsupported Playwright browser: ${browsername}`);
  const browser = await browsertype.launch({ headless: options.headless ?? true, ...(options.launch ?? {}) });
  const context = await browser.newContext(options.context ?? {});
  const page = await context.newPage();
  return { browser, context, page, close: () => browser.close() };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 10: extension/permissions.ts — extension permission policies keep the browser capability boundary explicit and caller-owned. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * extension permission policies keep the browser capability boundary explicit and caller-owned.
 */

export const extensionpermissions = Object.freeze(["activeTab", "scripting", "storage"]);

/** Creates a minimal permission policy without requesting broad host access. */
export function permissionpolicy(options = {}) {
  const requested = [...new Set((options.requested ?? extensionpermissions).map(String))];
  const optional = [...new Set((options.optional ?? []).map(String))];
  const unknown = requested.concat(optional).filter((permission) => !extensionpermissions.includes(permission));
  if (unknown.length) throw new TypeError(`unsupported extension permission: ${unknown[0]}`);
  return { version: 1, requested, optional, hostpermissions: [], allows(permission) { return requested.includes(String(permission)); }, missing(permissions = []) { return [...new Set(permissions.map(String))].filter((permission) => !requested.includes(permission)); } };
}

/** Requests an optional capability through an injected browser permission function. */
export async function requestpermission(policy, permission, request) {
  const name = String(permission ?? "");
  if (!policy?.optional?.includes(name)) throw new TypeError(`permission is not optional: ${name}`);
  if (typeof request !== "function") throw new TypeError("permission request function is required");
  try { return { permission: name, granted: Boolean(await request(name)) }; } catch (error) { return { permission: name, granted: false, code: String(error?.code ?? "PERMISSION_REQUEST_FAILED"), message: String(error?.message ?? error) }; }
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 11: extension/protocol.ts — extension protocol defines serializable commands, responses, errors and page snapshots. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * extension protocol defines serializable commands, responses, errors and page snapshots.
 */

export const protocolversion = 1;
export const extensioncommands = Object.freeze(["snapshot", "readpage", "pagefacts", "clickref", "fillref"]);

/** Creates a compact identifier without embedding a host, port or credential. */
export function createid(prefix = "msg", source) {
  const generator = source ?? (() => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random().toString(16).slice(2)}`);
  const value = generator().replaceAll("-", "");
  return `${prefix}${value}`;
}

/** Creates a versioned command for the extension message bus. */
export function createcommand(command, payload = {}, options = {}) {
  if (!extensioncommands.includes(command)) throw new TypeError(`unsupported extension command: ${command}`);
  return createmessage("command", { ...options, command, payload });
}

/** Creates a serializable message envelope. */
export function createmessage(type, options = {}) {
  if (!["command", "response", "error", "event"].includes(type)) throw new TypeError(`unsupported extension message type: ${type}`);
  const message = { version: protocolversion, type, id: options.id ?? createid(type) };
  if (options.requestid) message.requestid = options.requestid;
  if (options.command) message.command = options.command;
  if (options.payload !== undefined) message.payload = options.payload;
  if (options.error) message.error = options.error;
  assertserializable(message);
  return message;
}

/** Creates a correlated successful response. */
export function createresponse(request, payload = {}) {
  assertmessage(request);
  return createmessage("response", { requestid: request.id, payload });
}

/** Creates a correlated error response with stable error fields. */
export function createerror(request, error, options = {}) {
  const requestid = request?.id ?? options.requestid;
  const failure = { code: options.code ?? error?.code ?? "extension_error", message: String(error?.message ?? error ?? "extension request failed"), retryable: Boolean(options.retryable ?? error?.retryable) };
  return createmessage("error", { requestid, error: failure });
}

/** Validates a message before a privileged context handles it. */
export function assertmessage(message) {
  if (!message || typeof message !== "object") throw new TypeError("extension message must be an object");
  if (message.version !== protocolversion) throw new TypeError(`unsupported extension protocol version: ${message.version}`);
  if (typeof message.type !== "string" || typeof message.id !== "string") throw new TypeError("extension message requires type and id");
  if (message.type === "command" && !extensioncommands.includes(message.command)) throw new TypeError(`unsupported extension command: ${message.command}`);
  if (message.payload !== undefined && (!message.payload || typeof message.payload !== "object" || Array.isArray(message.payload))) throw new TypeError("extension payload must be an object");
  return message;
}

/** Creates a structured page snapshot with stable element references. */
export function createsnapshot(input = {}) {
  const snapshot = {
    version: protocolversion,
    snapshotid: String(input.snapshotid ?? createid("snap")),
    createdat: Number(input.createdat ?? Date.now()),
    windowid: input.windowid === undefined ? undefined : String(input.windowid),
    tabid: input.tabid === undefined ? undefined : String(input.tabid),
    frameid: input.frameid === undefined ? undefined : String(input.frameid),
    url: String(input.url ?? ""),
    title: String(input.title ?? ""),
    text: String(input.text ?? ""),
    elements: Array.isArray(input.elements) ? input.elements.map((element) => ({ ref: String(element.ref), role: String(element.role ?? "generic"), name: String(element.name ?? ""), value: element.value === undefined ? undefined : String(element.value), disabled: Boolean(element.disabled) })) : []
  };
  assertserializable(snapshot);
  return snapshot;
}

/** Returns whether a reference still belongs to the current page snapshot. */
export function isfreshsnapshot(snapshotid, currentid) { return Boolean(snapshotid && currentid && snapshotid === currentid); }

/** Computes bounded additions, removals and changed elements between extension snapshots. */
export function snapshotdiff(previous, current) {
  const before = createsnapshot(previous);
  const after = createsnapshot(current);
  const oldmap = new Map(before.elements.map((element) => [element.ref, element]));
  const newmap = new Map(after.elements.map((element) => [element.ref, element]));
  return {
    from: before.snapshotid,
    to: after.snapshotid,
    contextchanged: before.windowid !== after.windowid || before.tabid !== after.tabid || before.frameid !== after.frameid,
    added: after.elements.filter((element) => !oldmap.has(element.ref)),
    removed: before.elements.filter((element) => !newmap.has(element.ref)),
    changed: after.elements.filter((element) => oldmap.has(element.ref) && JSON.stringify(oldmap.get(element.ref)) !== JSON.stringify(element))
  };
}

function assertserializable(value) {
  try { JSON.stringify(value); } catch (error) { throw new TypeError(`extension message is not serializable: ${error.message}`); }
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 12: extension/content.ts — content bridge runs in the isolated world and exposes bounded page facts and user initiated actions. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * content bridge runs in the isolated world and exposes bounded page facts and user initiated actions.
 * It stays classic JavaScript because Chrome injects programmatic content scripts as files.
 */

(function installglobalbridge(global) {
  const installedkey = "__saddlecontentbridge";
  const protocolversion = 1;
  const commands = ["snapshot", "readpage", "pagefacts", "clickref", "fillref"];
  const pagechannelname = "saddle.pagefacts.v1";

  function createbridge(documentref, now = () => Date.now(), options = {}) {
    let snapshotid = null;
    let sequence = 0;
    const references = new Map();
    const pagechannel = options.pagechannel ?? (typeof global.addEventListener === "function" && typeof global.postMessage === "function" ? createpagechannel(global, now, options.timeout) : null);

    function snapshotpage() {
      const nextid = `snap${++sequence}${now()}`;
      const elements = [];
      references.clear();
      const candidates = documentref.querySelectorAll?.("a,button,input,textarea,select,[role]") ?? [];
      for (const element of Array.from(candidates).slice(0, 100)) {
        if (!visible(element)) continue;
        const ref = `e${elements.length + 1}`;
        references.set(ref, { element, snapshotid: nextid });
        elements.push({ ref, role: roleof(element), name: nameof(element) });
      }
      snapshotid = nextid;
      return { version: protocolversion, snapshotid, createdat: now(), url: String(documentref.location?.href ?? ""), title: String(documentref.title ?? ""), text: String(documentref.body?.innerText ?? "").slice(0, 100000), elements };
    }

    function readpage() {
      const page = snapshotpage();
      return { version: page.version, snapshotid: page.snapshotid, url: page.url, title: page.title, text: page.text };
    }

    function resolve(ref, requestedid) {
      if (requestedid !== snapshotid) throw failure("stale_snapshot", "page snapshot is stale");
      const entry = references.get(String(ref));
      if (!entry || entry.snapshotid !== snapshotid) throw failure("unknown_reference", `unknown page reference: ${ref}`);
      return entry.element;
    }

    function handle(request) {
      if (request?.version !== protocolversion || request.type !== "command" || !commands.includes(request.command)) throw failure("invalid_message", "invalid content command");
      const payload = request.payload ?? {};
      if (request.command === "snapshot") return snapshotpage();
      if (request.command === "readpage") return readpage();
      if (request.command === "pagefacts") {
        if (!pagechannel) throw failure("page_bridge_unavailable", "page bridge is not available");
        return pagechannel.readpage();
      }
      const element = resolve(payload.ref, payload.snapshotid);
      if (request.command === "clickref") { element.click?.(); return { ref: payload.ref, clicked: true, snapshotid }; }
      if (!isfillable(element)) throw failure("not_fillable", `element is not fillable: ${payload.ref}`);
      setvalue(element, payload.value);
      return { ref: payload.ref, filled: true, snapshotid };
    }

    return { handle, snapshotpage, readpage, pagechannel };
  }

  function createpagechannel(globalref = global, now = () => Date.now(), timeout = 1500) {
    if (typeof globalref.addEventListener !== "function" || typeof globalref.postMessage !== "function") throw new TypeError("page channel requires window messaging APIs");
    if (!Number.isSafeInteger(timeout) || timeout < 1) throw new TypeError("page channel timeout must be a positive safe integer");
    const pending = new Map();
    let sequence = 0;
    const token = `token${now()}${Math.random().toString(16).slice(2)}`;

    function listener(event) {
      const response = event?.data;
      if (event?.source && event.source !== globalref) return;
      if (response?.channel !== pagechannelname || response.type !== "response" || response.token !== token) return;
      const request = pending.get(response.requestid);
      if (!request) return;
      pending.delete(response.requestid);
      globalref.clearTimeout?.(request.timer);
      request.resolve(response.payload ?? {});
    }

    function readpage() {
      const requestid = `page${now()}${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = globalref.setTimeout(() => {
          pending.delete(requestid);
          const error = new Error("page bridge response timed out");
          error.code = "page_bridge_timeout";
          reject(error);
        }, timeout);
        pending.set(requestid, { resolve, timer });
        globalref.postMessage({ channel: pagechannelname, version: 1, type: "request", requestid, token }, "*");
      });
    }

    globalref.addEventListener("message", listener);
    return { readpage, dispose() { globalref.removeEventListener?.("message", listener); for (const request of pending.values()) globalref.clearTimeout?.(request.timer); pending.clear(); } };
  }

  function install(runtime = global.chrome?.runtime, documentref = global.document) {
    if (!runtime?.onMessage || !documentref) throw new TypeError("content bridge requires runtime and document");
    if (global[installedkey]) return global[installedkey];
    const bridge = createbridge(documentref);
    const listener = (message, sender, sendresponse) => {
      Promise.resolve().then(() => bridge.handle(message)).then((payload) => sendresponse({ version: protocolversion, type: "response", id: `resp${Date.now()}`, requestid: message?.id, payload })).catch((error) => sendresponse({ version: protocolversion, type: "error", id: `err${Date.now()}`, requestid: message?.id, error: { code: error.code ?? "content_error", message: error.message } }));
      return true;
    };
    runtime.onMessage.addListener(listener);
    global[installedkey] = { bridge, listener, dispose() { runtime.onMessage.removeListener?.(listener); delete global[installedkey]; } };
    return global[installedkey];
  }

  function visible(element) {
    const style = global.getComputedStyle?.(element);
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    return typeof element.getClientRects !== "function" || element.getClientRects().length > 0;
  }

  function roleof(element) { return String(element.getAttribute?.("role") || element.tagName || "generic").toLowerCase(); }
  function nameof(element) { return String(element.getAttribute?.("aria-label") || element.innerText || element.textContent || element.getAttribute?.("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 200); }
  function isfillable(element) { return ["INPUT", "TEXTAREA"].includes(String(element.tagName).toUpperCase()); }
  function setvalue(element, value) { element.value = String(value ?? ""); element.dispatchEvent?.(new Event("input", { bubbles: true })); element.dispatchEvent?.(new Event("change", { bubbles: true })); }
  function failure(code, message) { const error = new Error(message); error.code = code; return error; }

  global.saddlecontent = { createbridge, createpagechannel, install };
  if (global.chrome?.runtime?.onMessage && global.document) install();
})(globalThis);

/* ════════════════════════════════════════════════════════════════════ */
/* Section 13: extension/popup.ts — popup sends user initiated read commands through the service worker. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * popup sends user initiated read commands through the service worker.
 * The DOM bootstrap of the former extension/popup.ts runs only when a
 * document exists (the popup page of the built extension); importing the
 * merged module from Node never touches the DOM.
 */

if (typeof document !== "undefined") {
const status = document.querySelector("#status");
const output = document.querySelector("#output");

for (const button of document.querySelectorAll("[data-command]")) button.addEventListener("click", () => request(button.dataset.command));

async function request(command) {
  try {
    status.textContent = "Reading active tab…";
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("no active tab");
    const response = await chrome.runtime.sendMessage(createcommand(command, { tabid: tab.id }));
    if (response?.type === "error") throw new Error(response.error?.message ?? "extension request failed");
    output.textContent = JSON.stringify(response?.payload ?? response, null, 2);
    status.textContent = "Complete.";
  } catch (error) {
    status.textContent = "Request failed.";
    output.textContent = String(error.message ?? error);
  }
}
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 14: extension/pagebridge.ts — page bridge exposes bounded, read-only page facts to the isolated content world. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * page bridge exposes bounded, read-only page facts to the isolated content world.
 * It never executes page supplied commands and never forwards extension credentials.
 */

(function installpagebridge(global) {
  const channel = "saddle.pagefacts.v1";
  const installedkey = "__saddlepagebridge";

  function createpagebridge(globalref = global) {
    function readpage() {
      const documentref = globalref.document;
      return {
        url: String(documentref?.location?.href ?? ""),
        title: String(documentref?.title ?? "").slice(0, 500),
        text: String(documentref?.body?.innerText ?? "").slice(0, 100000)
      };
    }

    function listener(event) {
      const request = event?.data;
      if (event?.source && event.source !== globalref) return;
      if (request?.channel !== channel || request.type !== "request" || typeof request.requestid !== "string" || typeof request.token !== "string") return;
      globalref.postMessage({ channel, version: 1, type: "response", requestid: request.requestid, token: request.token, payload: readpage() }, "*");
    }

    return { channel, listener, readpage };
  }

  function install(globalref = global) {
    if (typeof globalref?.addEventListener !== "function" || !globalref.document) throw new TypeError("page bridge requires a window and document");
    if (globalref[installedkey]) return globalref[installedkey];
    const bridge = createpagebridge(globalref);
    globalref.addEventListener("message", bridge.listener);
    globalref[installedkey] = { ...bridge, dispose() { globalref.removeEventListener?.("message", bridge.listener); delete globalref[installedkey]; } };
    return globalref[installedkey];
  }

  global.saddlepagebridge = { channel, createpagebridge, install };
  if (global.document && typeof global.addEventListener === "function") install(global);
})(globalThis);

/* ════════════════════════════════════════════════════════════════════ */
/* Section 15: extension/worker.ts — worker binds the generic extension router to the Manifest V3 runtime APIs. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * worker binds the generic extension router to the Manifest V3 runtime APIs.
 */


/** Installs the service worker listeners against a caller supplied Chrome API object. */
export function startworker(chromeapi = globalThis.chrome) {
  if (!chromeapi?.runtime?.onMessage || !chromeapi?.tabs || !chromeapi?.scripting) throw new TypeError("extension worker requires runtime tabs and scripting APIs");
  const router = createworkerrouter({ tabs: chromeapi.tabs, scripting: chromeapi.scripting, storage: chromeapi.storage?.session });
  const listener = (message, sender, sendresponse) => {
    router.handle(message, sender).then(sendresponse).catch((error) => sendresponse(createerror(message, error)));
    return true;
  };
  const startup = () => router.rehydrate().catch(() => undefined);
  chromeapi.runtime.onMessage.addListener(listener);
  chromeapi.runtime.onStartup?.addListener(startup);
  return { router, dispose() { chromeapi.runtime.onMessage.removeListener?.(listener); chromeapi.runtime.onStartup?.removeListener?.(startup); } };
}

if (globalThis.chrome?.runtime?.onMessage) startworker();

/* ════════════════════════════════════════════════════════════════════ */
/* Section 16: extension/serviceworker.ts — service worker router forwards user initiated commands to the active tab and persists resumable state. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * service worker router forwards user initiated commands to the active tab and persists resumable state.
 */


/** Creates a browser independent router around Chrome tabs, scripting and storage APIs. */
export function createworkerrouter(options = {}) {
  const tabs = options.tabs;
  const scripting = options.scripting;
  const storage = options.storage;
  const contentfile = options.contentfile ?? "content.js";
  const statekey = options.statekey ?? "saddleextensionstate";
  const maxpending = options.maxpending ?? 32;
  if (typeof tabs?.sendMessage !== "function") throw new TypeError("extension router requires tabs.sendMessage");
  if (!Number.isSafeInteger(maxpending) || maxpending < 1) throw new TypeError("extension router maxpending must be a positive safe integer");

  async function ensurecontent(tabid) {
    if (!Number.isInteger(tabid)) throw new TypeError("extension command requires a tab id");
    if (typeof scripting?.executeScript !== "function") throw new TypeError("extension router requires scripting.executeScript");
    await scripting.executeScript({ target: { tabId: tabid }, files: [contentfile] });
  }

  async function readstate() {
    if (typeof storage?.get !== "function") return {};
    const result = await storage.get(statekey);
    return result?.[statekey] ?? {};
  }

  async function savestate(value) {
    if (typeof storage?.set === "function") await storage.set({ [statekey]: value });
  }

  async function pendingstate() {
    const value = await readstate();
    return { ...value, pending: Array.isArray(value.pending) ? value.pending.filter(validpending) : [] };
  }

  async function enqueue(request, sender) {
    const state = await pendingstate();
    const record = pendingrecord(request, sender);
    const pending = state.pending.filter((item) => item.requestid !== record.requestid);
    if (pending.length >= maxpending && !state.pending.some((item) => item.requestid === record.requestid)) throw extensionerror("PENDING_LIMIT", "extension pending command limit reached");
    pending.push(record);
    await savestate({ ...state, pending });
    return record;
  }

  async function complete(requestid, patch = {}) {
    const state = await pendingstate();
    await savestate({ ...state, ...patch, pending: state.pending.filter((item) => item.requestid !== requestid) });
  }

  async function markfailure(requestid, error) {
    const state = await pendingstate();
    const pending = state.pending.map((item) => item.requestid === requestid ? { ...item, attempts: item.attempts + 1, lasterror: { code: String(error?.code ?? "extension_error"), message: String(error?.message ?? error) }, updatedat: Date.now() } : item);
    await savestate({ ...state, pending });
  }

  async function dispatch(request, sender = {}) {
    const tabid = request.payload?.tabid ?? sender.tab?.id;
    await ensurecontent(tabid);
    const response = await tabs.sendMessage(tabid, request);
    return decorate(response, sender, tabid);
  }

  async function handle(message, sender = {}) {
    const request = assertmessage(message);
    if (request.type !== "command") throw new TypeError("extension router accepts commands only");
    const tabid = request.payload?.tabid ?? sender.tab?.id;
    await enqueue(request, { ...sender, tab: { ...sender.tab, id: tabid } });
    try {
      const response = await dispatch(request, { ...sender, tab: { ...sender.tab, id: tabid } });
    await complete(request.id, response?.type === "response" && response.payload?.snapshotid ? { tabid, snapshotid: response.payload.snapshotid, frameid: response.payload.frameid, windowid: response.payload.windowid, updatedat: Date.now() } : { updatedat: Date.now() });
      return response;
    } catch (error) {
      await markfailure(request.id, error);
      throw error;
    }
  }

  async function rehydrate() { return pendingstate(); }

  async function resume(requestid, sender = {}) {
    const state = await pendingstate();
    const pending = state.pending.find((item) => item.requestid === requestid);
    if (!pending) throw extensionerror("PENDING_NOT_FOUND", `pending command not found: ${requestid}`);
    const tabid = pending.tabid ?? sender.tab?.id;
    const response = await dispatch(pending.message, { ...sender, frameId: pending.frameid ?? sender.frameId, tab: { ...sender.tab, id: tabid, windowId: pending.windowid ?? sender.tab?.windowId } });
    await complete(requestid, response?.type === "response" && response.payload?.snapshotid ? { tabid, snapshotid: response.payload.snapshotid, frameid: response.payload.frameid, windowid: response.payload.windowid, updatedat: Date.now() } : { updatedat: Date.now() });
    return response;
  }

  async function cancel(requestid) { const state = await pendingstate(); await savestate({ ...state, pending: state.pending.filter((item) => item.requestid !== requestid) }); }

  return { ensurecontent, readstate, savestate, rehydrate, enqueue, resume, cancel, handle };
}

function pendingrecord(request, sender = {}) { return { requestid: request.id, command: request.command, message: request, tabid: request.payload?.tabid ?? sender.tab?.id, frameid: request.payload?.frameid ?? sender.frameId, windowid: request.payload?.windowid ?? sender.tab?.windowId, attempts: 0, createdat: Date.now(), updatedat: Date.now() }; }

function decorate(response, sender, tabid) {
  if (response?.type !== "response" || !response.payload || typeof response.payload !== "object" || !response.payload.snapshotid) return response;
  const payload = { ...response.payload, tabid: response.payload.tabid ?? (tabid === undefined ? undefined : String(tabid)), frameid: response.payload.frameid ?? (sender.frameId === undefined ? undefined : String(sender.frameId)), windowid: response.payload.windowid ?? (sender.tab?.windowId === undefined ? undefined : String(sender.tab.windowId)) };
  return { ...response, payload };
}

function validpending(value) { return Boolean(value && typeof value === "object" && typeof value.requestid === "string" && value.message && value.message.type === "command" && Number.isSafeInteger(value.attempts) && value.attempts >= 0); }

function extensionerror(code, message) { const error = new Error(message); error.code = code; return error; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 17: extension/build.ts — extension build adapter creates a versioned, unpacked Manifest V3 artifact for release packaging. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * extension build adapter creates a versioned, unpacked Manifest V3 artifact for release packaging.
 */


/* dist/browser.js resolves the repository root as its parent directory; the
   source browser.ts sits at the repository root itself. */
const modulepath = resolve(dirname(fileURLToPath(import.meta.url)));
const rootpath = basename(modulepath) === "dist" ? resolve(modulepath, "..") : modulepath;
const extensionassets = resolve(rootpath, "web", "extension");
const entries = [
  "manifest.json",
  "worker.js",
  "serviceworker.js",
  "content.js",
  "pagebridge.js",
  "popup.js",
  "popup.html",
  "popup.css",
  "protocol.js",
  "permissions.js",
  "icons/icon32.png",
  "icons/icon64.png",
  "icons/icon128.png",
];

function parsearguments(argumentslist) {
  const options = {};
  for (let index = 0; index < argumentslist.length; index += 1) {
    const argument = argumentslist[index];
    if (argument === "--version") options.version = argumentslist[++index];
    else if (argument === "--output") options.output = argumentslist[++index];
    else
      throw new TypeError(`unsupported extension build argument: ${argument}`);
  }
  return options;
}

function validversion(version) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(version ?? ""));
}

/**
 * Extracts the consolidated section of one extension entry from the merged
 * browser.ts source. The grand merge folded the seven former extension
 * scripts into ordinal sections of this file; the build emits each section
 * under its stable browser `.js` filename exactly the way the former
 * per-file sources were emitted.
 */
async function extensionsectionsourcetext(entry) {
  const section = entry.replace(/\.js$/, "");
  const browserts = resolve(rootpath, "browser.ts");
  const text = await readFile(browserts, "utf8");
  const pattern = new RegExp(
    `\\/\\* Section \\d+: extension\\/${section}\\.ts[^\\n]*\\*\\/\\n\\/\\*[\\u2550 ]*\\*\\/\\n([\\s\\S]*?)\\n(?=\\/\\*[\\u2550 ]*\\*\\/\\n\\/\\* Section \\d+:|$)`,
  );
  const match = text.match(pattern);
  if (!match) throw new TypeError(`extension section not found: ${section}`);
  return match[1];
}

/** Resolves a static interface asset of the extension from web/extension. */
async function resolveasset(entry) {
  return resolve(extensionassets, entry);
}

/** Builds the extension into an isolated directory and returns its manifest. */
export async function buildextension(options = {}) {
  const packagefile = JSON.parse(
    await readFile(resolve(rootpath, "package.json"), "utf8"),
  );
  const version = String(options.version ?? packagefile.version);
  if (!validversion(version))
    throw new TypeError(`invalid extension version: ${version}`);
  const output = resolve(process.cwd(), options.output ?? "build/extension");
  await rm(output, { force: true, recursive: true });
  await mkdir(output, { recursive: true });
  const manifest = JSON.parse(
    await readFile(resolve(extensionassets, "manifest.json"), "utf8"),
  );
  manifest.version = version;
  for (const entry of entries) {
    const destination = resolve(output, entry);
    await mkdir(dirname(destination), { recursive: true });
    if (entry === "manifest.json")
      await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`);
    else if (/\.js$/.test(entry)) {
      await writeFile(destination, `${await extensionsectionsourcetext(entry)}\n`);
    } else {
      const source = await resolveasset(entry);
      await cp(source, destination);
    }
  }
  return { output, manifest };
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  buildextension(parsearguments(process.argv.slice(2)))
    .then(({ output }) => {
      console.log(`extension artifact: ${output}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
