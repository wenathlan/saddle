/**
 * isolation.ts — isolation contracts describe effect boundaries without
 * executing binaries, touching hosts, or calling providers.
 *
 * This file is the v2.0.0 grand-merge carrier of the former
 * isolation/contracts.ts: the browser-safe boundary contract surface of the
 * virtual domain. It stays its own root file (the one deliberate split of
 * the domain) because the web interface bundles exactly these contracts —
 * the whole file is import-free and browser-loadable, while the node-side
 * implementations of the domain live in virtual.ts.
 */
// @ts-nocheck
/**
 * isolation contracts describe effect boundaries without executing binaries, touching hosts, or calling providers.
 */

const boundaries = new Set(["gateway", "planning", "policy", "materialization", "execution", "persistence", "evidence"]);
const effects = new Set(["binary-execution", "host-bridge", "remote-dispatch", "provider-access", "local-storage", "browser-session", "database", "network"]);
const targets = new Set(["local", "remote", "provider", "browser", "storage"]);

/** Validates a bounded request for a privileged effect without performing it. */
export function executionrequest(input = {}) {
  const effect = valid(input.effect, effects, "execution effect");
  const target = valid(input.target, targets, "execution target");
  const source = digest(input.source, "execution source");
  return Object.freeze({ version: 1, id: nonempty(input.id, "execution id"), effect, target, source, budget: budget(input.budget), state: "requested" });
}

/** Evaluates a requested effect against explicit policy, approval, and adapter declarations. */
export function executiondecision(request, input = {}) {
  const normalized = executionrequest(request);
  const policy = normalizedlist(input.policy?.alloweffects);
  const policytargets = normalizedlist(input.policy?.allowtargets);
  const approval = normalizedlist(input.approval?.effects);
  const approvaltargets = normalizedlist(input.approval?.targets);
  const capabilities = normalizedlist(input.adapter?.capabilities);
  const reasons = [];
  if (!policy.includes(normalized.effect)) reasons.push("policy-effect");
  if (!policytargets.includes(normalized.target)) reasons.push("policy-target");
  if (!approval.includes(normalized.effect)) reasons.push("approval-effect");
  if (!approvaltargets.includes(normalized.target)) reasons.push("approval-target");
  if (!capabilities.includes(normalized.effect)) reasons.push("adapter-capability");
  if (!String(input.adapter?.owner ?? "")) reasons.push("adapter-owner");
  const allowed = reasons.length === 0;
  return Object.freeze({ version: 1, request: normalized, state: allowed ? "caller-delegates" : "denied", reasons: Object.freeze(reasons), adapter: allowed ? Object.freeze({ owner: String(input.adapter.owner), capabilities: Object.freeze(capabilities) }) : null, effects: Object.freeze([]) });
}

/** Renders a side-effect-free handoff and never invokes an adapter. */
export function executionhandoff(input = {}) {
  const decision = executiondecision(input.request, input.configuration);
  if (decision.state !== "caller-delegates") return Object.freeze({ version: 1, state: "execution-disabled", code: "EXECUTION_POLICY_DENIED", decision, effects: Object.freeze([]) });
  return Object.freeze({ version: 1, state: "caller-delegates", code: "CALLER_ADAPTER_REQUIRED", decision, effects: Object.freeze([]) });
}

/** Validates a serializable envelope for a unified web internal API boundary. */
export function internalenvelope(input = {}) {
  const boundary = valid(input.boundary, boundaries, "internal api boundary");
  return Object.freeze({ version: 1, boundary, requestid: nonempty(input.requestid, "internal api requestid"), payload: freezeobject(input.payload ?? {}) });
}

/** Creates pure internal API handlers for planning, policy, handoff, and evidence projections. */
export function internalapi(input = {}) {
  const configuration = freezeobject(input.configuration ?? {});
  function handle(envelope) {
    const request = internalenvelope(envelope);
    if (request.boundary === "gateway") return response(request, "accepted", { requestid: request.requestid });
    if (request.boundary === "planning") return response(request, "planned", { request: executionrequest(request.payload) });
    if (request.boundary === "policy") return response(request, "evaluated", { decision: executiondecision(request.payload.request, request.payload.configuration ?? configuration) });
    if (request.boundary === "execution") return response(request, "projected", { handoff: executionhandoff({ request: request.payload.request, configuration: request.payload.configuration ?? configuration }) });
    if (request.boundary === "materialization") return response(request, "planned", { state: "no-materialization", effects: Object.freeze([]) });
    if (request.boundary === "persistence") return response(request, "projected", { state: "ephemeral-fixture", effects: Object.freeze([]) });
    return response(request, "recorded", { receipt: Object.freeze({ version: 1, state: String(request.payload.state ?? "unknown"), effects: Object.freeze([]) }) });
  }
  return Object.freeze({ handle });
}

function response(request, state, data) { return Object.freeze({ version: 1, boundary: request.boundary, requestid: request.requestid, state, data: freezeobject(data), effects: Object.freeze([]) }); }
function budget(input = {}) { return Object.freeze({ maxbytes: positive(input.maxbytes ?? 1, "execution budget maxbytes"), maxmilliseconds: positive(input.maxmilliseconds ?? 1, "execution budget maxmilliseconds"), network: input.network === true }); }
function normalizedlist(value) { return Object.freeze([...new Set(Array.isArray(value) ? value.map((entry) => String(entry)) : [])].sort()); }
function freezeobject(value) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("internal api payload must be an object"); return Object.freeze({ ...value }); }
function valid(value, collection, name) { const output = String(value ?? ""); if (!collection.has(output)) throw new TypeError(`${name} is invalid`); return output; }
function digest(value, name) { const output = String(value ?? "").toLowerCase(); if (!/^[a-f0-9]{64}$/.test(output)) throw new TypeError(`${name} sha256 is invalid`); return output; }
function nonempty(value, name) { const output = String(value ?? ""); if (!output) throw new TypeError(`${name} is required`); return output; }
function positive(value, name) { const output = Number(value); if (!Number.isSafeInteger(output) || output < 1) throw new TypeError(`${name} must be a positive safe integer`); return output; }
