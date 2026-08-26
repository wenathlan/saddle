/**
 * delivery manifests verify immutable chunks and keep PWA registration caller-owned.
 */
import { sha256 } from "../core/hash.js";

/** Creates an ordered immutable delivery manifest from verified chunk metadata. */
export function deliverymanifest(input = {}) {
  const chunks = Array.isArray(input.chunks) ? input.chunks.map(normalizechunk) : [];
  if (chunks.length === 0) throw new TypeError("delivery manifest chunks are required");
  const seen = new Set();
  for (const chunk of chunks) { if (seen.has(chunk.id)) throw new TypeError(`delivery manifest chunk id is duplicated: ${chunk.id}`); seen.add(chunk.id); }
  const ordered = chunks.sort((left, right) => left.index - right.index || left.id.localeCompare(right.id));
  for (let index = 0; index < ordered.length; index += 1) if (ordered[index].index !== index) throw new TypeError("delivery manifest chunk indexes must be contiguous");
  return Object.freeze({ version: 1, id: nonempty(input.id, "delivery manifest id"), chunks: Object.freeze(ordered), totalbytes: ordered.reduce((total, chunk) => total + chunk.sizebytes, 0), visibility: input.visibility === "private" ? "private" : "public" });
}

/** Verifies supplied chunk bytes against a manifest without executing, importing, or caching them. */
export function verifydelivery(manifest, supplied = []) {
  const expected = deliverymanifest(manifest);
  if (!Array.isArray(supplied)) throw new TypeError("delivery chunks must be an array");
  const values = new Map(supplied.map((value) => [String(value?.id ?? ""), value]));
  const results = expected.chunks.map((chunk) => {
    const suppliedchunk = values.get(chunk.id);
    if (!suppliedchunk) return Object.freeze({ id: chunk.id, state: "missing" });
    const data = tobytes(suppliedchunk.data);
    const digest = sha256(data);
    if (data.byteLength !== chunk.sizebytes || digest !== chunk.sha256) return Object.freeze({ id: chunk.id, state: "mismatch", sizebytes: data.byteLength, sha256: digest });
    return Object.freeze({ id: chunk.id, state: "verified", sizebytes: data.byteLength, sha256: digest });
  });
  return Object.freeze({ version: 1, valid: results.every((result) => result.state === "verified"), results: Object.freeze(results) });
}

/** Produces a host PWA plan that never registers a service worker or mutates browser state. */
export function pwaplan(input = {}) {
  const scope = String(input.scope ?? "");
  if (!scope.startsWith("/")) throw new TypeError("PWA scope must start with a slash");
  const serviceworker = input.capabilities?.serviceworker === true;
  const offline = input.offline === true;
  return Object.freeze({ version: 1, scope, offline, state: serviceworker ? "caller-registers" : "unsupported", update: input.update === "manual" ? "manual" : "prompt", cache: offline ? "caller-configures" : "disabled" });
}

/** Validates a caller-reported CDN capability set without contacting a CDN provider. */
export function cdncapabilities(input = {}) {
  const visibility = input.visibility === "private" ? "private" : "public";
  return Object.freeze({ version: 1, immutable: input.immutable === true, purge: input.purge === true, range: input.range === true, integrityheaders: input.integrityheaders === true, cors: input.cors === true, visibility, state: "caller-reports" });
}

const contenttypes = new Set(["application/javascript", "application/wasm", "application/octet-stream", "application/json", "text/plain"]);
function normalizechunk(input, index) { const contenttype = String(input?.contenttype ?? "application/octet-stream"); if (!contenttypes.has(contenttype)) throw new TypeError(`delivery manifest content type is unsupported: ${contenttype}`); return Object.freeze({ id: nonempty(input?.id, "delivery manifest chunk id"), index: safeindex(input?.index ?? index), sha256: digest(input?.sha256, "delivery manifest chunk sha256"), sizebytes: positive(input?.sizebytes, "delivery manifest chunk sizebytes"), contenttype }); }
function nonempty(value, name) { const output = String(value ?? ""); if (!output) throw new TypeError(`${name} is required`); return output; }
function digest(value, name) { const output = String(value ?? "").toLowerCase(); if (!/^[a-f0-9]{64}$/.test(output)) throw new TypeError(`${name} is invalid`); return output; }
function safeindex(value) { const output = Number(value); if (!Number.isSafeInteger(output) || output < 0) throw new TypeError("delivery manifest chunk index is invalid"); return output; }
function positive(value, name) { const output = Number(value); if (!Number.isSafeInteger(output) || output < 1) throw new TypeError(`${name} must be a positive safe integer`); return output; }
function tobytes(value) { if (value instanceof Uint8Array) return value; if (value instanceof ArrayBuffer) return new Uint8Array(value); throw new TypeError("delivery chunk data must be Uint8Array or ArrayBuffer"); }
