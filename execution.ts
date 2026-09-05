/**
 * execution.ts — runtime, runner, queue, dispatch and session execution planning.
 *
 * This file is the v2.0.0 grand-merge consolidation of the former nested
 * folders of the repository (runners, runtime) into the single
 * root-level domain file of the e2ugh family standard: one optimized
 * TypeScript file per correlated domain, ordinal sections, JSDoc on every
 * block, intra-domain imports dissolved, cross-domain imports rewritten to
 * ./<domain>.js. Every capability of every source file is preserved here;
 * the pure re-export barrels (none in this domain) folded their surface into this file directly.
 */

import { aserror, createjob, eventbus, idfactory, runnerunavailable, systemclock, validatesession } from "./foundation.js";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/* ════════════════════════════════════════════════════════════════════ */
/* Section 1: runners/inprocess.ts — the in process runner is the deterministic baseline for local execution. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * the in process runner is the deterministic baseline for local execution.
 */
export function inprocess(options = {}) {
  let available = options.status !== "offline";
  const runner = {
    id: options.id ?? "runnerlocal",
    name: options.name ?? "local in process runner",
    priority: options.priority ?? 0,
    maxconcurrent: options.maxconcurrent ?? 1,
    capabilities: options.capabilities ?? ["node", "local"]
  };
  return {
    descriptor() { return { ...runner, status: available ? "available" : "offline" }; },
    setavailable(value) { available = Boolean(value); },
    async canrun() { return available; },
    async execute(context, handler) { return handler(context); }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 2: runners/health.ts — runner health checks describe provider capacity without selecting infrastructure. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * runner health checks describe provider capacity without selecting infrastructure.
 */

/** Checks provider readiness and returns a serializable health report. */
export async function runnerhealth(provider, job = {}) {
  if (typeof provider?.descriptor !== "function" || typeof provider?.canrun !== "function") throw new TypeError("runner health requires a provider");
  const descriptor = provider.descriptor();
  try {
    const available = await provider.canrun(job);
    return { id: String(descriptor.id), status: available ? descriptor.status ?? "available" : "busy", healthy: Boolean(available), checkedat: Date.now(), capacity: { maxconcurrent: descriptor.maxconcurrent, capabilities: [...(descriptor.capabilities ?? [])] } };
  } catch (error) {
    return { id: String(descriptor.id), status: "offline", healthy: false, checkedat: Date.now(), capacity: { maxconcurrent: descriptor.maxconcurrent, capabilities: [...(descriptor.capabilities ?? [])] }, error: { code: String(error.code ?? "RUNNER_HEALTH_FAILED"), message: String(error.message ?? error) } };
  }
}

/** Checks a provider list in stable order and summarizes available capacity. */
export async function runnerhealthall(providers = [], job = {}) {
  if (!Array.isArray(providers)) throw new TypeError("runner health providers must be an array");
  const reports = [];
  for (const provider of providers) reports.push(await runnerhealth(provider, job));
  return { checkedat: Date.now(), reports, available: reports.filter((report) => report.healthy).length, total: reports.length };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 3: runners/heartbeat.ts — heartbeat manages cooperative liveness signals for long-running local or remote jobs. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * heartbeat manages cooperative liveness signals for long-running local or remote jobs.
 */

/** Creates a heartbeat controller with manual ticks and optional interval execution. */
export function heartbeat(options = {}) {
  const interval = Number(options.interval ?? 30000);
  if (!Number.isFinite(interval) || interval < 1) throw new TypeError("heartbeat interval must be positive");
  let timer;
  let sequence = 0;
  let last;
  const listeners = new Set();

  async function tick(input = {}) {
    const signal = { id: String(input.id ?? options.id ?? "job"), sequence: ++sequence, at: Date.now(), status: String(input.status ?? "running"), metadata: { ...(input.metadata ?? {}) } };
    last = signal;
    for (const listener of listeners) await listener({ ...signal, metadata: { ...signal.metadata } });
    return signal;
  }

  function on(listener) { if (typeof listener !== "function") throw new TypeError("heartbeat listener must be a function"); listeners.add(listener); return () => listeners.delete(listener); }
  function start(input = {}) { if (timer) return false; const run = () => tick(input).catch(() => undefined); timer = setInterval(run, interval); return true; }
  function stop() { if (!timer) return false; clearInterval(timer); timer = undefined; return true; }
  function status() { return { running: Boolean(timer), interval, sequence, last: last ? { ...last, metadata: { ...last.metadata } } : undefined }; }
  return { tick, on, start, stop, status };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 4: runners/chain.ts — provider chains rank caller-authorized execution candidates without dispatching remote work. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * provider chains rank caller-authorized execution candidates without dispatching remote work.
 */

/** Creates a stable provider chain over declarative capability reports. */
export function providerchain(input = {}) {
  const providers = normalizeproviders(input.providers);
  return Object.freeze({ select(request = {}) { return selectprovider(providers, request); }, dispatchplan(request = {}) { const selection = selectprovider(providers, request); return Object.freeze({ version: 1, state: "caller-dispatches", provider: selection.selected, request: normalizerequest(request), rejected: selection.rejected }); }, providers: () => providers.map((provider) => ({ ...provider, capabilities: [...provider.capabilities] })) });
}

/** Selects the first eligible provider under stable priority and returns every exclusion reason. */
export function selectprovider(providers, request = {}) {
  const normalized = normalizeproviders(providers);
  const required = normalizerequest(request);
  const rejected = [];
  const accepted = [];
  for (const provider of normalized) {
    const reasons = eligibility(provider, required);
    if (reasons.length) rejected.push(Object.freeze({ id: provider.id, reasons: Object.freeze(reasons) }));
    else accepted.push(provider);
  }
  if (accepted.length === 0) throw chainerror("PROVIDER_CHAIN_UNAVAILABLE", "provider chain has no eligible providers", { request: required, rejected });
  accepted.sort((left, right) => preferenceindex(required.preferredids, left.id) - preferenceindex(required.preferredids, right.id) || left.priority - right.priority || left.id.localeCompare(right.id));
  const selected = accepted[0];
  return Object.freeze({ version: 1, selected: describe(selected), rejected: Object.freeze(rejected), request: required });
}

/** Produces a verified runner-to-storage handoff record without writing an artifact. */
export function artifacthandoff(input = {}) {
  const key = nonempty(input.key, "artifact handoff key");
  const sha256 = digest(input.sha256, "artifact handoff sha256");
  const providerid = nonempty(input.providerid, "artifact handoff providerid");
  const retention = nonempty(input.retention, "artifact handoff retention");
  return Object.freeze({ version: 1, key, sha256, sizebytes: positive(input.sizebytes, "artifact handoff sizebytes"), providerid, retention, state: "caller-transfers" });
}

/** Creates a cancellation intent without claiming that a remote runner has stopped or cleaned up. */
export function cancellationplan(input = {}) {
  const runid = nonempty(input.runid, "provider cancellation runid");
  const providerid = nonempty(input.providerid, "provider cancellation providerid");
  const reason = nonempty(input.reason ?? "caller-requested", "provider cancellation reason");
  return Object.freeze({ version: 1, runid, providerid, reason, state: "caller-cancels", remotestate: "unknown", compensation: input.compensation === true ? "caller-evaluates" : "not-requested" });
}

/** Renders a caller-dispatches plan through an injected forge adapter without sending it. */
export async function renderdispatch(plan, adapter) {
  if (plan?.state !== "caller-dispatches") throw new TypeError("provider dispatch plan is invalid");
  if (typeof adapter?.render !== "function") throw chainerror("PROVIDER_DISPATCH_RENDER_UNAVAILABLE", "provider dispatch render adapter is required");
  return adapter.render(Object.freeze({ ...plan }));
}

function normalizeproviders(input) {
  if (!Array.isArray(input) || input.length === 0) throw new TypeError("provider chain providers must be a non-empty array");
  const ids = new Set();
  return Object.freeze(input.map((value, index) => {
    const id = nonempty(value?.id, "provider chain provider id");
    if (ids.has(id)) throw new TypeError(`provider chain provider id is duplicated: ${id}`);
    ids.add(id);
    const status = String(value.status ?? "available");
    if (!new Set(["available", "busy", "offline", "disabled"]).has(status)) throw new TypeError(`provider chain provider status is invalid: ${id}`);
    return Object.freeze({ id, priority: nonnegative(value.priority ?? index, "provider chain provider priority"), status, capabilities: Object.freeze(unique(value.capabilities ?? [], "provider chain capability")), architecture: optionalword(value.architecture, "provider chain provider architecture"), operatingSystem: optionalword(value.operatingSystem, "provider chain provider operating system"), networkpolicy: policy(value.networkpolicy ?? "caller", "provider chain network policy"), storagepolicy: policy(value.storagepolicy ?? "caller", "provider chain storage policy"), cpu: nonnegative(value.cpu ?? 0, "provider chain provider cpu"), memorybytes: nonnegative(value.memorybytes ?? 0, "provider chain provider memorybytes"), maxmilliseconds: nonnegative(value.maxmilliseconds ?? 0, "provider chain provider maxmilliseconds") });
  }).sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id)));
}

function normalizerequest(input) { return Object.freeze({ capabilities: Object.freeze(unique(input.capabilities ?? [], "provider chain requested capability")), preferredids: Object.freeze(unique(input.preferredids ?? [], "provider chain preferred id")), architecture: optionalword(input.architecture, "provider chain requested architecture"), operatingSystem: optionalword(input.operatingSystem, "provider chain requested operating system"), networkpolicy: input.networkpolicy === undefined ? null : policy(input.networkpolicy, "provider chain requested network policy"), storagepolicy: input.storagepolicy === undefined ? null : policy(input.storagepolicy, "provider chain requested storage policy"), mincpu: nonnegative(input.mincpu ?? 0, "provider chain minimum cpu"), minmemorybytes: nonnegative(input.minmemorybytes ?? 0, "provider chain minimum memorybytes"), minmilliseconds: nonnegative(input.minmilliseconds ?? 0, "provider chain minimum milliseconds") }); }
function eligibility(provider, request) { const reasons = []; if (provider.status !== "available") reasons.push(`status:${provider.status}`); for (const capability of request.capabilities) if (!provider.capabilities.includes(capability)) reasons.push(`capability:${capability}`); if (request.architecture && provider.architecture !== request.architecture) reasons.push("architecture"); if (request.operatingSystem && provider.operatingSystem !== request.operatingSystem) reasons.push("operatingSystem"); if (request.networkpolicy && provider.networkpolicy !== request.networkpolicy) reasons.push("networkpolicy"); if (request.storagepolicy && provider.storagepolicy !== request.storagepolicy) reasons.push("storagepolicy"); if (provider.cpu < request.mincpu) reasons.push("cpu"); if (provider.memorybytes < request.minmemorybytes) reasons.push("memorybytes"); if (provider.maxmilliseconds < request.minmilliseconds) reasons.push("maxmilliseconds"); return reasons; }
function describe(provider) { return Object.freeze({ id: provider.id, priority: provider.priority, capabilities: Object.freeze([...provider.capabilities]), architecture: provider.architecture, operatingSystem: provider.operatingSystem, networkpolicy: provider.networkpolicy, storagepolicy: provider.storagepolicy, cpu: provider.cpu, memorybytes: provider.memorybytes, maxmilliseconds: provider.maxmilliseconds }); }
function unique(input, name) { if (!Array.isArray(input)) throw new TypeError(`${name} values must be an array`); return [...new Set(input.map((value) => nonempty(value, name)))].sort(); }
function nonempty(value, name) { const output = String(value ?? ""); if (!output) throw new TypeError(`${name} is required`); return output; }
function optionalword(value, name) { if (value === undefined || value === null || value === "") return null; return nonempty(value, name); }
function policy(value, name) { const output = String(value); if (!new Set(["caller", "restricted", "isolated", "none"]).has(output)) throw new TypeError(`${name} is invalid`); return output; }
function preferenceindex(preferredids, id) { const index = preferredids.indexOf(id); return index === -1 ? Number.MAX_SAFE_INTEGER : index; }
function nonnegative(value, name) { const numeric = Number(value); if (!Number.isSafeInteger(numeric) || numeric < 0) throw new TypeError(`${name} must be a non-negative safe integer`); return numeric; }
function positive(value, name) { const numeric = nonnegative(value, name); if (numeric < 1) throw new TypeError(`${name} must be positive`); return numeric; }
function digest(value, name) { const output = String(value ?? "").toLowerCase(); if (!/^[a-f0-9]{64}$/.test(output)) throw new TypeError(`${name} is invalid`); return output; }
function chainerror(code, message, detail) { const error = new Error(message); error.code = code; error.detail = detail; return error; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 5: runners/scheduler.ts — scheduling uses stable priority order and selects the first available runner. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * scheduling uses stable priority order and selects the first available runner.
 */

export function scheduler(providers) {
  if (!Array.isArray(providers) || providers.length === 0) throw new TypeError("scheduler requires providers");
  const ordered = [...providers].sort((left, right) => left.descriptor().priority - right.descriptor().priority);
  return {
    async select(job) {
      for (const provider of ordered) if (provider.descriptor().status === "available" && await provider.canrun(job)) return provider;
      throw runnerunavailable(job.id);
    },
    list() { return [...ordered]; }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 6: runtime/detect.ts — runtime detection uses standard globals and keeps node specific modules outside the core. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * runtime detection uses standard globals and keeps node specific modules outside the core.
 */
export function runtimename(scope = globalThis) {
  if (scope.Deno) return "deno";
  if (scope.Bun) return "bun";
  if (scope.process?.versions?.node) return "node";
  if (scope.window?.document) return "browser";
  return "unknown";
}

export function runtimefeatures(scope = globalThis) {
  return { runtime: runtimename(scope), fetch: typeof scope.fetch === "function", streams: typeof scope.ReadableStream === "function" && typeof scope.WritableStream === "function", crypto: Boolean(scope.crypto), websocket: typeof scope.WebSocket === "function", filesystem: Boolean(scope.process?.versions?.node || scope.Deno) };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 7: runtime/engine.ts — the engine coordinates job intent, working memory, runner execution, and commit. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * the engine coordinates job intent, working memory, runner execution, and commit.
 */

export function engine(options) {
  if (!options?.storage || !options?.memory || !options?.scheduler) throw new TypeError("engine requires storage memory and scheduler");
  const events = options.events ?? eventbus();
  const ids = options.ids ?? idfactory();
  const clock = options.clock ?? systemclock();
  async function emit(job, type, data) { events.emit({ id: ids.next("event"), type, jobid: job.id, at: clock.now(), data }); }
  return {
    events,
    async run(spec, handler) {
      const job = createjob(spec, ids, clock);
      await emit(job, "jobqueued", { name: job.name });
      let set;
      let provider;
      try {
        job.status = "preparing";
        await emit(job, "jobpreparing", { status: job.status });
        provider = await options.scheduler.select(job);
        await emit(job, "runnerselected", { runnerid: provider.descriptor().id });
        set = await options.memory.prepare(job);
        job.status = "running";
        await emit(job, "jobrunning", { status: job.status, location: set.location });
        const output = await provider.execute({ job, workingset: set, signal: new AbortController().signal }, handler);
        const encoded = encodeoutput(output);
        job.status = "syncing";
        await emit(job, "jobsyncing", { status: job.status, bytes: encoded.bytes.byteLength });
        const sync = await options.memory.sync(set, encoded.bytes);
        const artifact = await options.storage.put({ key: spec.outputkey ?? `results/${job.id}${encoded.extension}`, data: encoded.bytes, contenttype: encoded.contenttype, metadata: { jobid: job.id, runnerid: provider.descriptor().id } });
        await emit(job, "storagecommitted", { key: artifact.key, sha256: artifact.sha256 });
        job.status = "completed";
        await emit(job, "jobcompleted", { status: job.status, artifactkey: artifact.key });
        return { job, output, runnerid: provider.descriptor().id, artifact, sync };
      } catch (error) {
        job.status = "failed";
        const failure = aserror(error, job.id);
        await emit(job, "jobfailed", { code: failure.code, retryable: failure.retryable, message: failure.message });
        throw failure;
      } finally {
        if (set) await options.memory.cleanup(set);
      }
    }
  };
}

function encodeoutput(output) {
  if (output instanceof Uint8Array) return { bytes: output, contenttype: "application/octet-stream", extension: ".bin" };
  if (typeof output === "string") return { bytes: new TextEncoder().encode(output), contenttype: "text/plain;charset=utf-8", extension: ".txt" };
  return { bytes: new TextEncoder().encode(JSON.stringify(output)), contenttype: "application/json", extension: ".json" };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 8: runtime/abort.ts — abort helpers unify deadlines without depending on a server framework. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * abort helpers unify deadlines without depending on a server framework.
 */
export function deadline(milliseconds, parent) {
  if (!Number.isFinite(milliseconds) || milliseconds < 1) throw new TypeError("deadline must be positive");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("deadline exceeded")), milliseconds);
  if (parent) parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
  return { signal: controller.signal, cancel() { clearTimeout(timer); controller.abort(); } };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 9: runtime/retry.ts — retry context groups transient retry policy and circuit protection for runners, */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * retry context groups transient retry policy and circuit protection for runners,
 * storage adapters and network-facing surfaces.
 */

/** Creates bounded exponential retry behavior for retryable failures. */
export function retrypolicy(options = {}) {
  const maxattempts = options.maxattempts ?? 3;
  const base = options.base ?? 1000;
  const factor = options.factor ?? 2;
  const cap = options.cap ?? 30000;
  return { async run(handler) { let last; for (let attempt = 1; attempt <= maxattempts; attempt += 1) { try { return await handler(attempt); } catch (error) { last = error; if (error?.retryable !== true || attempt === maxattempts) throw error; const wait = Math.min(cap, base * factor ** (attempt - 1)) + Math.floor(Math.random() * (options.jitter ?? 0)); options.onretry?.({ attempt, wait, error }); await delay(wait); } } throw last; } };
}

/** Creates a circuit breaker that opens after repeated handler failures. */
export function circuitbreaker(options = {}) {
  const threshold = options.failurethreshold ?? 5;
  const resettimeout = options.resettimeout ?? 60000;
  let failures = 0;
  let openedat = 0;
  let state = "closed";
  async function execute(handler) { if (state === "open") { if (Date.now() - openedat < resettimeout) throw new Error("circuit breaker is open"); state = "halfopen"; } try { const result = await handler(); failures = 0; state = "closed"; return result; } catch (error) { failures += 1; if (failures >= threshold) { state = "open"; openedat = Date.now(); } throw error; } }
  return { execute, status() { return { state, failures, openedat }; }, reset() { failures = 0; openedat = 0; state = "closed"; } };
}

/** Waits between retry attempts without introducing an external timer dependency. */
function delay(milliseconds) { return milliseconds ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve(); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 10: runtime/queue.ts — job queue groups concurrency retry timeout and idempotency at one boundary. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * job queue groups concurrency retry timeout and idempotency at one boundary.
 */

export function jobqueue(options = {}) {
  const limit = options.concurrency ?? 1;
  const attempts = options.maxattempts ?? 3;
  const retryall = options.retryall ?? false;
  const keys = options.idempotency ?? idempotency();
  const pending = [];
  let active = 0;
  let sequence = 0;
  async function drain() {
    while (active < limit && pending.length) {
      const item = pending.shift();
      active += 1;
      execute(item).then(item.resolve, item.reject).finally(() => { active -= 1; void drain(); });
    }
  }
  async function execute(item) {
    if (item.key && keys.has(item.key)) return keys.get(item.key);
    let last;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await item.handler({ id: item.id, payload: item.payload, attempt });
        if (item.key) keys.set(item.key, result);
        return result;
      } catch (error) {
        last = error;
        const retryable = retryall || error?.retryable === true || error?.code === "RUNNER_UNAVAILABLE";
        if (!retryable || attempt === attempts) throw error;
        await queuedelay((options.backoff ?? 250) * 2 ** (attempt - 1));
      }
    }
    throw last;
  }
  return {
    add(payload, handler, options = {}) {
      if (typeof handler !== "function") return Promise.reject(new TypeError("queue handler is required"));
      const id = options.id ?? `queuejob${sequence++}`;
      return new Promise((resolve, reject) => { pending.push({ id, payload, handler, key: options.key, resolve, reject }); void drain(); });
    },
    size() { return pending.length; },
    active() { return active; },
    async idle() { while (pending.length || active) await queuedelay(10); }
  };
}

function queuedelay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 11: runtime/idempotency.ts — idempotency keys prevent duplicate delivery from at least once transports. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * idempotency keys prevent duplicate delivery from at least once transports.
 */
export function idempotency() {
  const results = new Map();
  return {
    has(key) { return results.has(key); },
    get(key) { return results.get(key); },
    set(key, value) { results.set(key, value); return value; },
    delete(key) { results.delete(key); }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 12: runtime/saga.ts — saga executes compensations in reverse order when a multi step operation fails. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * saga executes compensations in reverse order when a multi step operation fails.
 */
export async function saga(steps, context = {}) {
  const completed = [];
  try {
    for (const step of steps) { const value = await step.run(context); completed.push({ step, value }); }
    return completed.map((item) => item.value);
  } catch (error) {
    for (const item of completed.reverse()) if (typeof item.step.compensate === "function") await item.step.compensate(context, item.value);
    throw error;
  }
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 13: runtime/resumable.ts — resumable runs keep remote execution state explicit and recoverable across process restarts. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * resumable runs keep remote execution state explicit and recoverable across process restarts.
 */

export const runstatuses = Object.freeze(["created", "submitted", "running", "succeeded", "failed", "cancelled"]);
const transitions = { created: ["submitted", "cancelled"], submitted: ["running", "failed", "cancelled"], running: ["succeeded", "failed", "cancelled"], succeeded: [], failed: ["submitted", "cancelled"], cancelled: [] };

/** Creates a validated run record with explicit transition history. */
export function runrecord(input = {}) {
  if (!input.requestid || !input.name) throw new TypeError("run record requires requestid and name");
  return { version: 1, requestid: String(input.requestid), name: String(input.name), status: input.status ?? "created", runid: input.runid, attempt: Number(input.attempt ?? 0), createdat: Number(input.createdat ?? Date.now()), updatedat: Number(input.updatedat ?? Date.now()), history: Array.isArray(input.history) ? input.history.map((event) => ({ ...event })) : [], metadata: { ...(input.metadata ?? {}) } };
}

/** Moves a run through a legal state transition and appends an auditable event. */
export function transitionrun(record, status, options = {}) {
  const current = runrecord(record);
  if (!runstatuses.includes(status) || !transitions[current.status]?.includes(status)) { const error = new Error(`invalid run transition: ${current.status} to ${status}`); error.code = "INVALID_RUN_TRANSITION"; throw error; }
  const event = { from: current.status, to: status, at: Number(options.at ?? Date.now()), reason: options.reason };
  return { ...current, status, runid: options.runid ?? current.runid, attempt: status === "submitted" ? current.attempt + 1 : current.attempt, updatedat: event.at, history: [...current.history, event] };
}

/** Coordinates submit, status, resume and cancel operations through an injected remote adapter. */
export function resumablerun(adapter, input = {}) {
  if (typeof adapter?.submit !== "function" || typeof adapter?.status !== "function") throw new TypeError("resumable run adapter requires submit and status");
  let record = runrecord(input);
  let compensation = { status: typeof input.compensate === "function" ? "pending" : "not-configured" };
  async function submit() { const response = await adapter.submit(input); record = transitionrun(record, "submitted", { runid: response?.runid, reason: "submitted" }); return { ...record, response }; }
  async function resume() { if (record.status === "created") await submit(); if (typeof adapter.resume === "function") await adapter.resume(record); const response = await adapter.status(record.runid); if (response?.status && response.status !== record.status && transitions[record.status]?.includes(response.status)) record = transitionrun(record, response.status, { reason: "remote-status" }); return { ...record, response }; }
  async function cancel(options = {}) {
    if (record.status === "cancelled") return { ...record, compensation };
    if (!transitions[record.status]?.includes("cancelled")) throw new Error(`invalid run transition: ${record.status} to cancelled`);
    if (typeof adapter.cancel !== "function") throw new TypeError("resumable run adapter does not support cancel");
    const response = await adapter.cancel(record.runid, options);
    record = transitionrun(record, "cancelled", { reason: options.reason ?? "cancelled" });
    const handler = options.compensate ?? input.compensate;
    if (typeof handler !== "function") compensation = { status: "not-configured" };
    else if (compensation.status === "pending") {
      try {
        compensation = { status: "succeeded", result: await handler({ run: runrecord(record), response, reason: options.reason ?? "cancelled" }) };
      } catch (error) {
        compensation = { status: "failed", error: String(error?.message ?? error) };
        record = { ...record, metadata: { ...record.metadata, compensation: compensation.status } };
        const failure = new Error("resumable run compensation failed", { cause: error });
        failure.code = "COMPENSATION_FAILED";
        throw failure;
      }
    }
    record = { ...record, metadata: { ...record.metadata, compensation: compensation.status } };
    return { ...record, response, compensation };
  }
  function get() { return runrecord(record); }
  return { submit, resume, cancel, get };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 14: runtime/workflow.ts — workflow dispatch keeps remote execution explicit and records a stable request identity. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * workflow dispatch keeps remote execution explicit and records a stable request identity.
 */

export function workflowdispatch(adapter, options = {}) {
  if (typeof adapter?.dispatch !== "function") throw new TypeError("workflow adapter requires dispatch");
  const records = options.records ?? idempotency();
  return {
    async submit(spec) {
      if (!spec?.owner || !spec.repository || !spec.workflow || !spec.ref) throw new TypeError("workflow owner repository workflow and ref are required");
      const requestid = spec.requestid ?? `${spec.owner}/${spec.repository}/${spec.workflow}/${spec.ref}/${JSON.stringify(spec.inputs ?? {})}`;
      if (records.has(requestid)) return records.get(requestid);
      const response = await adapter.dispatch(spec.owner, spec.repository, spec.workflow, { ref: spec.ref, inputs: spec.inputs ?? {} });
      const record = { requestid, ...spec, response, submittedat: Date.now() };
      records.set(requestid, record);
      return record;
    },
    get(requestid) { return records.get(requestid); }
  };
}

export async function waitforrun(adapter, owner, repository, runid, options = {}) {
  if (typeof adapter?.run !== "function") throw new TypeError("workflow adapter requires run");
  const attempts = options.attempts ?? 20;
  const interval = options.interval ?? 3000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const run = await adapter.run(owner, repository, runid);
    if (["completed", "failure", "cancelled", "success"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`workflow run ${runid} did not finish within configured attempts`);
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 15: runtime/replay.ts — replay maps validated session events to an injected browser adapter. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * replay maps validated session events to an injected browser adapter.
 */
export async function replay(session, adapter, options = {}) {
  if (!session?.events || typeof adapter?.move !== "function") throw new TypeError("replay requires session events and browser adapter");
  const speed = options.speed ?? 1;
  let previous = 0;
  let currentcontext = normalizecontext(options.initialcontext);
  let contextswitches = 0;
  for (const event of session.events) {
    const wait = Math.max(0, (event.t - previous) / speed);
    if (wait) await replaydelay(wait);
    previous = event.t;
    const eventcontext = normalizecontext(event.context ?? event);
    if (eventcontext && contextchanged(currentcontext, eventcontext)) {
      await restorecontext(adapter, eventcontext, currentcontext);
      currentcontext = eventcontext;
      contextswitches += 1;
    }
    if (event.type === "move") await adapter.move(event);
    else if (event.type === "click") await adapter.click(event);
    else if (event.type === "drag") await adapter.drag(event);
    else if (event.type === "scroll") await adapter.scroll(event);
    else if (event.type === "key") await adapter.key(event);
  }
  return { events: session.events.length, duration: previous / speed, contextswitches };
}

function normalizecontext(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("replay context must be an object");
  const context = {};
  for (const name of ["windowid", "tabid", "frameid"]) if (value[name] !== undefined) {
    if (typeof value[name] !== "string" || !value[name]) throw new TypeError(`replay ${name} must be a non-empty string`);
    context[name] = value[name];
  }
  return Object.keys(context).length ? context : undefined;
}

function contextchanged(previous, next) {
  return ["windowid", "tabid", "frameid"].some((name) => previous?.[name] !== next[name]);
}

async function restorecontext(adapter, next, previous) {
  if (typeof adapter.restorecontext === "function") {
    await adapter.restorecontext({ ...next }, previous ? { ...previous } : undefined);
    return;
  }
  const methods = [["windowid", "selectwindow"], ["tabid", "selecttab"], ["frameid", "selectframe"]];
  for (const [name, method] of methods) if (next[name] !== undefined && previous?.[name] !== next[name]) {
    if (typeof adapter[method] !== "function") {
      const error = new Error(`replay adapter cannot restore ${name}`);
      error.code = "REPLAY_CONTEXT_UNSUPPORTED";
      error.context = name;
      throw error;
    }
    await adapter[method](next[name], { ...next });
  }
}

function replaydelay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 16: runtime/worker.ts — worker bridge translates message events through an injected dispatcher without owning a worker runtime. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * worker bridge translates message events through an injected dispatcher without owning a worker runtime.
 */

/** Attaches a bounded message bridge to a caller-owned worker scope. */
export function workerbridge(options = {}) {
  const scope = options.scope ?? globalThis;
  const dispatch = options.dispatch;
  if (typeof scope.addEventListener !== "function") throw new TypeError("worker scope requires addEventListener");
  if (typeof dispatch !== "function") throw new TypeError("worker bridge requires dispatch");
  const event = String(options.event ?? "message");
  async function listener(message) {
    const input = message?.data ?? message;
    try { scope.postMessage?.({ ok: true, requestid: input?.requestid, data: await dispatch(input) }); } catch (error) { scope.postMessage?.({ ok: false, requestid: input?.requestid, error: { code: String(error?.code ?? "WORKER_DISPATCH_FAILED"), message: String(error?.message ?? error) } }); }
  }
  scope.addEventListener(event, listener);
  return { event, listener, close() { scope.removeEventListener?.(event, listener); } };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 17: runtime/persistentqueue.ts — persistent queue stores job state in a caller selected file. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * persistent queue stores job state in a caller selected file.
 * running items return to queued when a process restores after a crash.
 */

/** Creates a crash recoverable queue with idempotent item identifiers. */
export function persistentqueue(options = {}) {
  if (!options.path) throw new TypeError("persistent queue requires path");
  const maxattempts = options.maxattempts ?? 3;
  const defaultleasems = options.leasems ?? 0;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  let state = { version: 2, items: [] };
  let loaded = false;

  /** Reads the queue once and returns running jobs to the waiting state. */
  async function restore() {
    if (loaded) return state;
    try { state = JSON.parse(await readFile(options.path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const item of state.items ?? []) if (item.status === "running" && (!item.leaseexpiresat || item.leaseexpiresat <= clock())) { item.status = "queued"; item.leaseexpiresat = undefined; }
    state.version = 2;
    state.items ??= [];
    loaded = true;
    await persist();
    return state;
  }

  /** Appends a queued job and persists the new state. */
  async function enqueue(payload, metadata = {}) { await restore(); const idempotencykey = metadata.idempotencykey; const id = metadata.id ?? idempotencykey ?? `persistentjob${clock()}${state.items.length}`; const existing = state.items.find((item) => item.id === id || (idempotencykey && item.idempotencykey === idempotencykey)); if (existing) return { ...existing }; const item = { id, idempotencykey, payload, status: "queued", attempts: 0, createdat: clock(), updatedat: clock(), metadata }; state.items.push(item); await persist(); return { ...item }; }

  /** Claims the first queued job with stable ordering. */
  async function claim(claimoptions = {}) { await restore(); reclaimexpired(); const item = state.items.find((entry) => entry.status === "queued"); if (!item) return null; const leasems = claimoptions.leasems ?? defaultleasems; item.status = "running"; item.attempts += 1; item.claimedat = clock(); item.leaseexpiresat = leasems > 0 ? clock() + leasems : undefined; item.updatedat = clock(); await persist(); return { ...item }; }

  /** Renews a running item lease without changing its attempt count. */
  async function renew(id, leasems = defaultleasems) { await restore(); reclaimexpired(); const item = find(id); if (item.status !== "running") throw new Error(`persistent queue item is not running: ${id}`); if (!(leasems > 0)) throw new TypeError("lease duration must be positive"); item.leaseexpiresat = clock() + leasems; item.updatedat = clock(); await persist(); return { ...item }; }

  /** Commits a successful result. */
  async function complete(id, result) { await restore(); const item = find(id); item.status = "completed"; item.result = result; item.leaseexpiresat = undefined; item.updatedat = clock(); await persist(); return { ...item }; }

  /** Records an error and either retries or closes the item as failed. */
  async function fail(id, error) { await restore(); const item = find(id); item.error = { message: error?.message ?? String(error), code: error?.code }; item.status = item.attempts < maxattempts && error?.retryable !== false ? "queued" : "failed"; item.leaseexpiresat = undefined; item.updatedat = clock(); await persist(); return { ...item }; }

  /** Lists queue items for status and diagnostics. */
  async function list(filter) { await restore(); if (reclaimexpired()) await persist(); return state.items.filter((item) => !filter || item.status === filter).map((item) => ({ ...item })); }

  return { restore, enqueue, claim, renew, complete, fail, list };

  function find(id) { const item = state.items.find((entry) => entry.id === id); if (!item) throw new Error(`persistent queue item not found: ${id}`); return item; }
  function reclaimexpired() { let changed = false; for (const item of state.items) if (item.status === "running" && item.leaseexpiresat && item.leaseexpiresat <= clock()) { item.status = "queued"; item.leaseexpiresat = undefined; item.updatedat = clock(); changed = true; } return changed; }
  async function persist() { await writeFile(options.path, `${JSON.stringify(state, null, 2)}\n`, "utf8"); }
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 18: runtime/sessionfile.ts — file session persistence writes one validated JSON document per session. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * file session persistence writes one validated JSON document per session.
 */

export function filesessions(root) {
  return {
    async save(session) { const valid = validatesession(session); const path = join(root, `${valid.id}.json`); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(valid, null, 2)); return valid; },
    async load(id) { const value = JSON.parse(await readFile(join(root, `${id}.json`), "utf8")); return validatesession(value); }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 19: runtime/sessionstore.ts — jsonl session storage keeps append only traces independent from browser adapters. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * jsonl session storage keeps append only traces independent from browser adapters.
 */

export function sessionstore(root) {
  return {
    async append(session) { const valid = validatesession(session); await mkdir(root, { recursive: true }); await appendFile(join(root, `${valid.id}.jsonl`), `${JSON.stringify(valid)}\n`); return valid; },
    async read(id) { const text = await readFile(join(root, `${id}.jsonl`), "utf8"); return text.trim().split("\n").filter(Boolean).map((line) => validatesession(JSON.parse(line))); }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 20: runtime/compatibility.ts — compatibility contracts describe core capabilities without importing a runtime-specific adapter. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * compatibility contracts describe core capabilities without importing a runtime-specific adapter.
 */


export const corecapabilities = Object.freeze(["esm", "fetch", "streams", "textencoding", "webcrypto"]);

/** Reports the runtime capabilities expected by the transport-neutral root entry. */
export function runtimecontract(scope = globalThis) { const features = runtimefeatures(scope); return { runtime: runtimename(scope), core: true, capabilities: { esm: true, fetch: features.fetch, streams: features.streams, textencoding: typeof scope.TextEncoder === "function" && typeof scope.TextDecoder === "function", webcrypto: Boolean(scope.crypto?.subtle) }, nodeonly: { filesystem: features.filesystem, server: Boolean(scope.process?.versions?.node) } }; }

/** Returns a structured unsupported-mode error for a missing runtime capability. */
export function unsupportedruntime(feature, contract = runtimecontract()) { const error = new Error(`runtime capability is unavailable: ${feature}`); error.code = "UNSUPPORTED_RUNTIME"; error.feature = String(feature); error.runtime = contract.runtime; return error; }
