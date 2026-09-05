/**
 * foundation.ts — foundation errors, events, identifiers, hashing and serializable domain nouns.
 *
 * This file is the v2.0.0 grand-merge consolidation of the former nested
 * folders of the repository (core) into the single
 * root-level domain file of the saddle family standard: one optimized
 * TypeScript file per correlated domain, ordinal sections, JSDoc on every
 * block, intra-domain imports dissolved, cross-domain imports rewritten to
 * ./<domain>.js. Every capability of every source file is preserved here;
 * the pure re-export barrels (none in this domain) folded their surface into this file directly.
 */



/* ════════════════════════════════════════════════════════════════════ */
/* Section 1: core/errors.ts — typed engine errors keep recovery decisions explicit. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * typed engine errors keep recovery decisions explicit.
 */
export const errorcodes = Object.freeze({
  invalidinput: "INVALID_INPUT",
  artifactnotfound: "ARTIFACT_NOT_FOUND",
  storagefailure: "STORAGE_FAILURE",
  runnerunavailable: "RUNNER_UNAVAILABLE",
  jobfailed: "JOB_FAILED",
  sessioninvalid: "SESSION_INVALID"
});

export function saddleerror(message, options = {}) {
  const error = new Error(message, { cause: options.cause });
  error.name = "saddleerror";
  error.code = options.code ?? errorcodes.jobfailed;
  error.retryable = options.retryable ?? false;
  error.details = options.details ?? {};
  return error;
}

export function validationerror(message, details = {}) {
  return saddleerror(message, { code: errorcodes.invalidinput, details });
}

export function artifactnotfound(key) {
  return saddleerror(`artifact not found: ${key}`, { code: errorcodes.artifactnotfound, details: { key } });
}

export function runnerunavailable(jobid) {
  return saddleerror(`no runner is available for job ${jobid}`, { code: errorcodes.runnerunavailable, retryable: true, details: { jobid } });
}

export function aserror(error, jobid) {
  if (error?.name === "saddleerror") return error;
  return saddleerror(`job ${jobid} failed`, { code: errorcodes.jobfailed, cause: error, details: { jobid } });
}

/** Scrape error presets keep status, recovery and retry decisions explicit. */
export const errorcatalog = Object.freeze({
  timeout: { code: "E1001", statuscode: 504, retryable: true, recovery: "WAIT_AND_RETRY" },
  connectionrefused: { code: "E1002", statuscode: 503, retryable: true, recovery: "WAIT_AND_RETRY" },
  dns: { code: "E1003", statuscode: 503, retryable: true, recovery: "ROTATE_PROXY" },
  ratelimited: { code: "E2001", statuscode: 429, retryable: true, recovery: "WAIT_AND_RETRY" },
  forbidden: { code: "E2002", statuscode: 403, retryable: false, recovery: "REVIEW_ROBOTS_TXT" },
  notfound: { code: "E2003", statuscode: 404, retryable: false, recovery: "STOP_CRAWLING" },
  parse: { code: "E4002", statuscode: 422, retryable: false, recovery: "STOP_CRAWLING" },
  captcha: { code: "E4003", statuscode: 403, retryable: false, recovery: "REVIEW_ROBOTS_TXT" },
  session: { code: "E5001", statuscode: 401, retryable: true, recovery: "ROTATE_USER_AGENT" },
  config: { code: "E6001", statuscode: 400, retryable: false, recovery: "STOP_CRAWLING" }
});

/** Creates a stable scrape error with recovery metadata. */
export function webscrapeerror(kind, message, options = {}) { const preset = errorcatalog[kind] ?? errorcatalog.config; const error = new Error(message, { cause: options.cause }); error.name = "webscrapeerror"; error.code = options.code ?? preset.code; error.statuscode = options.statuscode ?? preset.statuscode; error.retryable = options.retryable ?? preset.retryable; error.recovery = options.recovery ?? preset.recovery; error.severity = options.severity ?? (error.statuscode >= 500 ? "high" : "medium"); error.details = options.details ?? {}; return error; }

/** Converts unknown failures into the stable scrape taxonomy. */
export function classifyerror(error) { if (error?.name === "webscrapeerror") return error; const message = String(error?.message ?? error); if (/timeout|aborted/i.test(message)) return webscrapeerror("timeout", message, { cause: error }); if (/dns|enotfound/i.test(message)) return webscrapeerror("dns", message, { cause: error }); return webscrapeerror("config", message, { cause: error }); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 2: core/events.ts — append only events are the small protocol shared by adapters. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * append only events are the small protocol shared by adapters.
 */
export const eventtypes = Object.freeze([
  "jobqueued",
  "jobpreparing",
  "runnerselected",
  "jobrunning",
  "jobsyncing",
  "storagecommitted",
  "jobcompleted",
  "jobfailed"
]);

export function eventbus() {
  const recorded = [];
  return {
    emit(event) { recorded.push(Object.freeze({ ...event })); },
    all() { return [...recorded]; }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 3: core/ids.ts — injectable time and id factories make every engine path reproducible. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * injectable time and id factories make every engine path reproducible.
 */
export function systemclock() {
  return { now: () => Date.now() };
}

export function idfactory(randomuuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
  return {
    next(prefix) {
      const suffix = randomuuid?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      return `${prefix}${suffix}`;
    }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 4: core/hash.ts — hash helpers use standard JavaScript primitives so transport-neutral modules do not require node:crypto. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * hash helpers use standard JavaScript primitives so transport-neutral modules do not require node:crypto.
 */

const constants = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

/** Returns a SHA-256 hexadecimal digest for bytes or text. */
export function sha256(value) { return tohex(hashbytes(value)); }

/** Returns an HMAC-SHA-256 hexadecimal digest for bytes or text. */
export function hmacsha256(value, secret) {
  let key = tobytes(secret);
  if (key.length > 64) key = hashbytes(key);
  const padded = new Uint8Array(64);
  padded.set(key);
  const outer = new Uint8Array(64);
  const inner = new Uint8Array(64);
  for (let index = 0; index < 64; index += 1) { outer[index] = padded[index] ^ 0x5c; inner[index] = padded[index] ^ 0x36; }
  return sha256(concat(outer, hashbytes(concat(inner, tobytes(value)))));
}

/** Compares hexadecimal values without early exit based on content. */
export function constanttimeequal(left, right) { const a = String(left ?? ""); const b = String(right ?? ""); let difference = a.length ^ b.length; const length = Math.max(a.length, b.length); for (let index = 0; index < length; index += 1) difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0); return difference === 0; }

function hashbytes(value) {
  const input = tobytes(value);
  const bitlength = BigInt(input.length) * 8n;
  const length = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(length);
  padded.set(input);
  padded[input.length] = 0x80;
  const inputview = new DataView(padded.buffer);
  inputview.setUint32(length - 8, Number((bitlength >> 32n) & 0xffffffffn));
  inputview.setUint32(length - 4, Number(bitlength & 0xffffffffn));
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = inputview.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const sigma0 = smallright(words[index - 15], 7) ^ smallright(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const sigma1 = smallright(words[index - 2], 17) ^ smallright(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (sigma1 + words[index - 7] + sigma0 + words[index - 16]) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const choose = (e & f) ^ (~e & g);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const first = (h + (smallright(e, 6) ^ smallright(e, 11) ^ smallright(e, 25)) + choose + constants[index] + words[index]) >>> 0;
      const second = ((smallright(a, 2) ^ smallright(a, 13) ^ smallright(a, 22)) + majority) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + first) >>> 0, c, b, a, (first + second) >>> 0];
    }
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0; state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0; state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
  }
  const output = new Uint8Array(32);
  const view = new DataView(output.buffer);
  state.forEach((word, index) => view.setUint32(index * 4, word));
  return output;
}

function tobytes(value) { if (value instanceof Uint8Array) return value; if (value instanceof ArrayBuffer) return new Uint8Array(value); return new TextEncoder().encode(String(value ?? "")); }
function concat(left, right) { const result = new Uint8Array(left.length + right.length); result.set(left); result.set(right, left.length); return result; }
function smallright(value, amount) { return (value >>> amount) | (value << (32 - amount)); }
function tohex(value) { return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 5: core/artifacts.ts — artifacts are serializable manifests with content checksums. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * artifacts are serializable manifests with content checksums.
 */
export function artifactmanifest(input) {
  return {
    key: input.key,
    sizebytes: input.sizebytes,
    sha256: input.sha256,
    contenttype: input.contenttype,
    createdat: input.createdat,
    metadata: { ...(input.metadata ?? {}) }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 6: core/jobs.ts — job creation is kept small and side effect free. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * job creation is kept small and side effect free.
 */

export const jobstatuses = Object.freeze(["queued", "preparing", "running", "syncing", "completed", "failed", "cancelled"]);

export function createjob(spec, ids, clock) {
  if (!spec?.name || !spec.name.trim()) throw validationerror("job name cannot be empty");
  return {
    id: ids.next("job"),
    name: spec.name,
    input: spec.input,
    priority: spec.priority ?? 0,
    outputkey: spec.outputkey,
    metadata: { ...(spec.metadata ?? {}) },
    status: "queued",
    createdat: clock.now()
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 7: core/providers.ts — providers declare capacity while scheduling remains a runtime decision. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * providers declare capacity while scheduling remains a runtime decision.
 */
export const runnerstatuses = Object.freeze(["available", "busy", "offline"]);

export function runnercontext(job, workingset, signal) {
  return { job, workingset, signal };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 8: core/runtime.ts — runtime records describe temporary process space without claiming physical vram. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * runtime records describe temporary process space without claiming physical vram.
 */
export function workingset(jobid, location, resultpath, createdat = Date.now()) {
  return { jobid, location, resultpath, createdat };
}

export function syncresult(bytes, location) {
  return { bytes, location };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 9: core/sessions.ts — session logs are versioned and validated before any replay adapter sees them. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * session logs are versioned and validated before any replay adapter sees them.
 */

const sessioneventtypes = new Set(["move", "click", "drag", "scroll", "key"]);

export function validatesession(value) {
  if (!value || typeof value !== "object") throw validationerror("session must be an object");
  if (value.version !== 1 || typeof value.id !== "string" || typeof value.agentname !== "string" || typeof value.originurl !== "string" || typeof value.seed !== "string") throw validationerror("session header is invalid");
  if (!Array.isArray(value.events)) throw validationerror("session events must be an array");
  if (!["created", "recording", "closed"].includes(value.status)) throw validationerror("session status is invalid");
  if (!Number.isFinite(value.startedat) || value.startedat < 0) throw validationerror("session startedat is invalid");
  return {
    version: 1,
    id: value.id,
    agentname: value.agentname,
    originurl: value.originurl,
    seed: value.seed,
    status: value.status,
    startedat: value.startedat,
    finishedat: Number.isFinite(value.finishedat) ? value.finishedat : undefined,
    events: value.events.map((event, index) => validateevent(event, index))
  };
}

function validateevent(value, index) {
  if (!value || typeof value !== "object" || !Number.isFinite(value.t) || value.t < 0 || !sessioneventtypes.has(value.type)) throw validationerror(`session event ${index} is invalid`);
  for (const name of ["x", "y", "tx", "ty", "dx", "dy"]) if (value[name] !== undefined && !Number.isFinite(value[name])) throw validationerror(`session event ${index} ${name} is invalid`);
  if (value.key !== undefined && typeof value.key !== "string") throw validationerror(`session event ${index} key is invalid`);
  if (value.target !== undefined && typeof value.target !== "string") throw validationerror(`session event ${index} target is invalid`);
  if (value.button !== undefined && !["left", "right"].includes(value.button)) throw validationerror(`session event ${index} button is invalid`);
  const context = validatecontext(value.context ?? value, index);
  return context ? { ...value, context } : { ...value };
}

function validatecontext(value, index) {
  if (value.context !== undefined && (value.context === null || typeof value.context !== "object" || Array.isArray(value.context))) throw validationerror(`session event ${index} context is invalid`);
  const source = value.context ?? value;
  const context = {};
  for (const name of ["windowid", "tabid", "frameid"]) if (source[name] !== undefined) {
    if (typeof source[name] !== "string" || !source[name]) throw validationerror(`session event ${index} ${name} is invalid`);
    context[name] = source[name];
  }
  return Object.keys(context).length ? context : undefined;
}
