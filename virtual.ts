/**
 * virtual.ts — isolation, internal memory, storage and optional persistence contracts.
 *
 * This file is the v2.0.0 grand-merge consolidation of the former nested
 * folders of the repository (memory, storage, persistence) into the single
 * root-level domain file of the e2ugh family standard: one optimized
 * TypeScript file per correlated domain, ordinal sections, JSDoc on every
 * block, intra-domain imports dissolved, cross-domain imports rewritten to
 * ./<domain>.js. Every capability of every source file is preserved here;
 * the pure re-export barrels (storage/index.ts) folded their surface into this file directly.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { artifactmanifest, artifactnotfound, sha256, syncresult, validationerror, workingset } from "./foundation.js";

/* ════════════════════════════════════════════════════════════════════ */
/* Section 2: memory/objects.ts — memory objects and compute results are serializable contracts between storage and runtime. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * memory objects and compute results are serializable contracts between storage and runtime.
 */
export function memoryobject(options = {}) {
  const buffer = tobytes(options.buffer ?? options.data ?? new Uint8Array(0));
  return { id: options.id ?? `memory${Date.now().toString(36)}`, buffer, size: buffer.byteLength, type: options.type ?? "application/octet-stream", createdat: options.createdat ?? Date.now(), metadata: { ...(options.metadata ?? {}) } };
}

export function computeresult(options = {}) {
  return { id: options.id ?? `result${Date.now().toString(36)}`, payload: options.payload, mimetype: options.mimetype, metadata: { ...(options.metadata ?? {}) }, processingtimems: options.processingtimems ?? 0, memoryusedbytes: options.memoryusedbytes ?? 0 };
}

export function tobytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new TextEncoder().encode(JSON.stringify(value));
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 3: memory/transforms.ts — transforms annotate byte movement without pretending remote storage is physical vram. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * transforms annotate byte movement without pretending remote storage is physical vram.
 */

export function transformtocompute(value, options = {}) {
  const started = performance.now();
  const object = memoryobject({ ...options, buffer: value?.buffer ?? value });
  return { ...object, processingtimems: performance.now() - started, memoryusedbytes: object.size };
}

export function transformtostorage(value, options = {}) {
  const payload = tobytes(value?.payload ?? value?.buffer ?? value);
  return computeresult({ id: value?.id, payload, mimetype: options.mimetype ?? value?.mimetype ?? "application/octet-stream", metadata: options.metadata ?? value?.metadata, processingtimems: value?.processingtimems, memoryusedbytes: payload.byteLength });
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 4: memory/modes.ts — memory modes expose the same byte contract with different backing choices. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * memory modes expose the same byte contract with different backing choices.
 */
export function internalmemory(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, modetobytes(value)]));
  return {
    mode: "internal",
    async put(key, value) { values.set(key, modetobytes(value)); return { key, bytes: values.get(key).byteLength }; },
    async get(key) { return values.get(key) ?? null; },
    async delete(key) { values.delete(key); },
    async list() { return [...values.keys()]; }
  };
}

export function externalmemory(storage) {
  if (!storage?.put || !storage?.get) throw new TypeError("external memory requires storage adapter");
  return {
    mode: "external",
    async put(key, value) { return storage.put({ key, data: modetobytes(value) }); },
    async get(key) { try { return await storage.get(key); } catch (error) { if (error.code === "ARTIFACT_NOT_FOUND") return null; throw error; } },
    async delete(key) { return storage.delete(key); },
    async list(prefix) { return storage.list(prefix); }
  };
}

export function physicalmemory(options = {}) {
  if (!options.path) throw new TypeError("physical memory requires a path");
  return { mode: "physical", path: options.path, put: options.put, get: options.get, delete: options.delete, list: options.list };
}

export function vectorizedmemory() {
  const vectors = new Map();
  return {
    mode: "vectorized",
    async put(key, vector) { assertvector(vector); vectors.set(key, [...vector]); return { key, dimensions: vector.length }; },
    async get(key) { return vectors.get(key) ?? null; },
    async average(keys) { const selected = keys.map((key) => vectors.get(key)).filter(Boolean); if (!selected.length) return null; const size = selected[0].length; const result = Array.from({ length: size }, () => 0); for (const vector of selected) for (let index = 0; index < size; index += 1) result[index] += vector[index] / selected.length; return result; },
    async list() { return [...vectors.keys()]; }
  };
}

export function librarymemory(factory) {
  if (typeof factory !== "function") throw new TypeError("library memory requires a factory");
  return { mode: "library", async load(options) { return factory(options); } };
}

function modetobytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new TextEncoder().encode(JSON.stringify(value));
}

function assertvector(vector) {
  if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) throw new TypeError("vector must be a non empty numeric array");
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 5: memory/targets.ts — storage targets describe provider intent without importing a provider client. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * storage targets describe provider intent without importing a provider client.
 */
const types = new Set(["github", "gitlab", "forgejo", "gitea", "huggingface", "kaggle", "modelscope", "filehosting"]);

export function targetfactory(type, options = {}) {
  if (!types.has(type)) throw new TypeError(`unknown memory target: ${type}`);
  if (type === "github" || type === "gitlab" || type === "forgejo" || type === "gitea") return { type, platform: type, owner: options.owner, repo: options.repo, branch: options.branch ?? "main", path: options.path, token: options.token };
  if (type === "huggingface") return { type, space: options.space, revision: options.revision ?? "main", path: options.path, token: options.token };
  if (type === "kaggle") return { type, dataset: options.dataset, sslverification: options.sslverification ?? true, path: options.path, token: options.token };
  if (type === "modelscope") return { type, namespace: options.namespace, repo: options.repo, revision: options.revision ?? "master", path: options.path, token: options.token };
  return { type, host: options.host, path: options.path, method: options.method ?? "s3compatible", token: options.token };
}

export function targeturi(target) {
  if (target.type === "github" || target.type === "gitlab" || target.type === "forgejo" || target.type === "gitea") return `${target.type}://${target.owner}/${target.repo}/${target.path}`;
  if (target.type === "huggingface") return `hf://${target.space}/${target.path}`;
  if (target.type === "kaggle") return `kaggle://${target.dataset}/${target.path}`;
  if (target.type === "modelscope") return `modelscope://${target.namespace}/${target.repo}/${target.path}`;
  return `${target.method}://${target.host}/${target.path}`;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 6: memory/engine.ts — memory engine loads from the first backend, persists to every backend and */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * memory engine loads from the first backend, persists to every backend and
 * bounds the hot working set without changing the default unbounded behavior.
 */

/** Creates a storage-backed memory engine with optional LRU working-set limits. */
export function memoryengine(options = {}) {
  const backends = options.backends ?? [];
  const maxentries = limit(options.maxentries, "maxentries");
  const maxbytes = limit(options.maxbytes, "maxbytes");
  const values = new Map();
  let usedbytes = 0;
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  async function load(key) {
    if (!key) throw new TypeError("memory key is required");
    if (values.has(key)) {
      hits += 1;
      return touch(key);
    }
    misses += 1;
    let last;
    for (const backend of backends) {
      try {
        const value = await backend.get(key);
        if (value == null) continue;
        const object = memoryobject({ id: key, buffer: value.data ?? value, type: value.contenttype ?? value.type, metadata: value.metadata });
        cache(key, object);
        return object;
      } catch (error) { last = error; }
    }
    if (last) throw new Error(`memory engine load failed for key "${key}": ${last.message}`, { cause: last });
    throw new Error(`memory engine load failed for key "${key}": not found`);
  }

  async function persist(key, data, options = {}) {
    if (!key) throw new TypeError("memory key is required");
    const payload = tobytes(data?.payload ?? data?.buffer ?? data);
    const object = memoryobject({ id: key, buffer: payload, type: options.mimetype ?? data?.mimetype, metadata: options.metadata ?? data?.metadata });
    for (const backend of backends) await backend.put(key, { data: object.buffer, contenttype: object.type, metadata: object.metadata });
    cache(key, object);
    return object;
  }

  function release(key) {
    const object = values.get(key);
    if (object) usedbytes -= object.buffer.byteLength;
    values.delete(key);
  }

  async function safeload(key) { try { return { success: true, data: await load(key) }; } catch (error) { return { success: false, error }; } }

  async function sync(key, options = {}) {
    const sourceindex = Number(options.sourceindex ?? 0);
    const source = backends[sourceindex];
    if (!source) throw new TypeError("memory sync source backend is missing");
    const targets = backends.filter((_backend, index) => index !== sourceindex);
    return syncbackends(source, targets, key, options);
  }

  function capabilities() { return backends.map((backend, index) => ({ index, capabilities: storagecapabilities(backend) })); }
  function stats() { return { entries: values.size, bytes: usedbytes, hits, misses, evictions, maxentries, maxbytes }; }

  return { load, persist, release, safeload, sync, capabilities, stats, transformtocompute, transformtostorage, list() { return [...values.keys()]; } };

  function cache(key, object) {
    const previous = values.get(key);
    if (previous) usedbytes -= previous.buffer.byteLength;
    values.delete(key);
    if (object.buffer.byteLength > maxbytes || maxentries === 0) return;
    values.set(key, object);
    usedbytes += object.buffer.byteLength;
    while (values.size > maxentries || usedbytes > maxbytes) {
      const oldest = values.keys().next().value;
      const evicted = values.get(oldest);
      values.delete(oldest);
      usedbytes -= evicted.buffer.byteLength;
      evictions += 1;
    }
  }

  function touch(key) {
    const object = values.get(key);
    values.delete(key);
    values.set(key, object);
    return object;
  }
}

function limit(value, name) {
  if (value === undefined) return Infinity;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return numeric;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 7: memory/planner.ts — working-set planning keeps host memory operations declarative and caller-executed. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * working-set planning keeps host memory operations declarative and caller-executed.
 */

/** Validates a serializable working-set capacity budget. */
export function workingbudget(input = {}) {
  return Object.freeze({ maxbytes: plannerlimit(input.maxbytes, "working-set maxbytes"), maxentries: plannerlimit(input.maxentries, "working-set maxentries"), maxage: optionalnonnegative(input.maxage, "working-set maxage") });
}

/** Selects bounded working-set candidates without materializing data or probing a host. */
export function workingadmission(items, options = {}) {
  if (!Array.isArray(items)) throw new TypeError("working-set items must be an array");
  const budget = workingbudget(options.budget);
  const now = Number(options.now ?? Date.now());
  if (!Number.isFinite(now) || now < 0) throw new TypeError("working-set now is invalid");
  const policy = validpolicy(options.policy ?? "lru");
  const normalized = normalizeitems(items);
  const admitted = [];
  const deferred = [];
  let usedbytes = 0;
  for (const item of rank(normalized, policy)) {
    const expired = item.expiresat !== null && item.expiresat <= now;
    const overbytes = usedbytes + item.sizebytes > budget.maxbytes;
    const overentries = admitted.length >= budget.maxentries;
    if (expired || overbytes || overentries) deferred.push(Object.freeze({ ...item, reason: expired ? "expired" : overbytes ? "bytebudget" : "entrybudget" }));
    else { admitted.push(item); usedbytes += item.sizebytes; }
  }
  return Object.freeze({ version: 1, policy, budget, usedbytes, admitted: Object.freeze(admitted), deferred: Object.freeze(deferred) });
}

/** Produces a host bridge plan that an explicit privileged adapter may execute. */
export function bridgeplan(input = {}) {
  const operation = String(input.operation ?? "");
  if (!bridgeoperations.includes(operation)) throw new TypeError("working-set bridge operation is invalid");
  const sizebytes = plannerpositive(input.sizebytes, "working-set bridge sizebytes");
  const capabilities = new Set(Array.isArray(input.capabilities) ? input.capabilities.map((value) => String(value)) : []);
  const supported = capabilities.has(operation);
  return Object.freeze({ version: 1, operation, sizebytes, state: supported ? "caller-executes" : "unsupported", preconditions: Object.freeze(supported ? ["explicit-consent", "host-adapter", "rollback-plan", "capacity-check"] : []), cleanup: Object.freeze({ required: supported, owner: "caller" }) });
}

/** Validates a materialized object record without reading storage or the local filesystem. */
export function materializationrecord(input = {}) {
  const id = String(input.id ?? "");
  const sha256 = String(input.sha256 ?? "").toLowerCase();
  if (!id) throw new TypeError("working-set materialization id is required");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError("working-set materialization sha256 is invalid");
  return Object.freeze({ version: 1, id, sha256, sizebytes: plannerpositive(input.sizebytes, "working-set materialization sizebytes"), tier: validtier(input.tier ?? "l3"), state: validstate(input.state ?? "planned"), createdat: nonnegative(input.createdat ?? Date.now(), "working-set materialization createdat") });
}

/** Tracks materialization transitions and emits caller-owned cleanup plans without deleting resources. */
export function materializationledger(input = {}) {
  const records = new Map();
  const clock = typeof input.clock === "function" ? input.clock : () => Date.now();
  function add(record) { const normalized = materializationrecord(record); if (records.has(normalized.id)) throw new TypeError(`working-set materialization id is duplicated: ${normalized.id}`); records.set(normalized.id, normalized); return normalized; }
  function transition(id, state) { const current = records.get(String(id)); if (!current) throw new TypeError("working-set materialization is unknown"); const next = validstate(state); if (!allowedtransition(current.state, next)) throw new TypeError(`working-set materialization transition is invalid: ${current.state} to ${next}`); const output = Object.freeze({ ...current, state: next, updatedat: nonnegative(clock(), "working-set materialization updatedat") }); records.set(output.id, output); return output; }
  function cleanupplan(id) { const current = records.get(String(id)); if (!current) throw new TypeError("working-set materialization is unknown"); return Object.freeze({ version: 1, id: current.id, sha256: current.sha256, state: "caller-cleans", reason: current.state === "cleaned" ? "already-cleaned" : "release-working-set" }); }
  return Object.freeze({ add, transition, cleanupplan, list: () => Object.freeze([...records.values()]) });
}

const bridgeoperations = Object.freeze(["temporaryfile", "mmap", "tmpfs", "zram", "swap"]);
const policies = new Set(["lru", "sizeaware", "ttlfirst"]);
const tiers = new Set(["l1", "l2", "l3", "l4"]);
const states = new Set(["planned", "prepared", "verified", "released", "cleaned", "failed"]);

function normalizeitems(input) {
  const ids = new Set();
  return input.map((value, index) => {
    const id = String(value?.id ?? "");
    if (!id || ids.has(id)) throw new TypeError("working-set item id must be unique");
    ids.add(id);
    return Object.freeze({ id, sizebytes: plannerpositive(value.sizebytes, "working-set item sizebytes"), priority: Number(value.priority ?? 0), lastusedat: nonnegative(value.lastusedat ?? 0, "working-set item lastusedat"), expiresat: value.expiresat === undefined ? null : nonnegative(value.expiresat, "working-set item expiresat"), index });
  });
}

function rank(items, policy) {
  return [...items].sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    if (policy === "lru" && right.lastusedat !== left.lastusedat) return right.lastusedat - left.lastusedat;
    if (policy === "sizeaware" && left.sizebytes !== right.sizebytes) return left.sizebytes - right.sizebytes;
    if (policy === "ttlfirst" && (left.expiresat ?? Infinity) !== (right.expiresat ?? Infinity)) return (left.expiresat ?? Infinity) - (right.expiresat ?? Infinity);
    return left.index - right.index;
  });
}

function plannerlimit(value, name) { return value === undefined ? Infinity : nonnegative(value, name); }
function plannerpositive(value, name) { const numeric = nonnegative(value, name); if (numeric < 1) throw new TypeError(`${name} must be plannerpositive`); return numeric; }
function nonnegative(value, name) { const numeric = Number(value); if (!Number.isSafeInteger(numeric) || numeric < 0) throw new TypeError(`${name} must be a non-negative safe integer`); return numeric; }
function optionalnonnegative(value, name) { return value === undefined ? null : nonnegative(value, name); }
function validpolicy(value) { if (!policies.has(value)) throw new TypeError("working-set policy is invalid"); return value; }
function validtier(value) { if (!tiers.has(value)) throw new TypeError("working-set tier is invalid"); return value; }
function validstate(value) { if (!states.has(value)) throw new TypeError("working-set materialization state is invalid"); return value; }
function allowedtransition(current, next) { if (next === "failed") return current !== "cleaned"; return new Set(["planned:prepared", "prepared:verified", "verified:released", "released:cleaned"]).has(`${current}:${next}`); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 8: memory/bridge.ts — memory bridges materialize and clear temporary working sets. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * memory bridges materialize and clear temporary working sets.
 */

export function localmemory(options = {}) {
  const base = options.base ?? tmpdir();
  return {
    async prepare(job) { const location = await mkdtemp(join(base, "saddlejob")); return workingset(job.id, location, join(location, "resultbin")); },
    async sync(set, bytes) { await mkdir(set.location, { recursive: true }); await writeFile(set.resultpath, bytes); return syncresult(bytes.byteLength, set.resultpath); },
    async cleanup(set) { await rm(set.location, { recursive: true, force: true }); }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 9: storage/adapter.ts — storage adapters keep remote services out of the engine core. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * storage adapters keep remote services out of the engine core.
 */
export function storageadapter(methods) {
  const required = ["put", "get", "head", "delete", "list"];
  for (const name of required) if (typeof methods?.[name] !== "function") throw new TypeError(`storage adapter requires ${name}`);
  return methods;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 10: storage/memory.ts — memory storage keeps bytes in a bounded process-local map for browser workers, Deno, Bun and tests. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * memory storage keeps bytes in a bounded process-local map for browser workers, Deno, Bun and tests.
 */


/** Creates a transport-neutral in-memory storage adapter with optional capacity limits. */
export function memorystorage(options = {}) {
  const values = new Map();
  const maxbytes = options.maxbytes === undefined ? Number.POSITIVE_INFINITY : Number(options.maxbytes);
  if ((!Number.isFinite(maxbytes) && maxbytes !== Number.POSITIVE_INFINITY) || maxbytes < 0) throw new TypeError("memory storage maxbytes is invalid");
  let usedbytes = 0;

  function manifest(key, data, input = {}) { return artifactmanifest({ key, sizebytes: data.byteLength, sha256: sha256(data), contenttype: input.contenttype ?? "application/octet-stream", createdat: input.createdat ?? Date.now(), metadata: input.metadata }); }
  function copy(value) { return new Uint8Array(value); }
  function ensurecapacity(previous, next) { if (usedbytes - previous + next > maxbytes) { const error = new Error("memory storage capacity exceeded"); error.code = "STORAGE_CAPACITY"; throw error; } }

  return storageadapter({
    async put(input = {}) { const key = String(input.key ?? ""); if (!key) throw new TypeError("memory storage key is required"); const data = copy(input.data ?? new Uint8Array()); const previous = values.get(key)?.data?.byteLength ?? 0; ensurecapacity(previous, data.byteLength); const item = { data, manifest: manifest(key, data, input) }; values.set(key, item); usedbytes += data.byteLength - previous; return { ...item.manifest }; },
    async get(key) { const item = values.get(String(key)); if (!item) { const error = new Error(`artifact not found: ${key}`); error.code = "ARTIFACT_NOT_FOUND"; throw error; } return copy(item.data); },
    async head(key) { const item = values.get(String(key)); return item ? { ...item.manifest } : null; },
    async delete(key) { const value = values.get(String(key)); if (!value) return false; values.delete(String(key)); usedbytes -= value.data.byteLength; return true; },
    async list(prefix = "") { return [...values].filter(([key]) => key.startsWith(String(prefix))).map(([, value]) => ({ ...value.manifest })); },
    usage() { return { usedbytes, maxbytes }; }
  });
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 11: storage/cache.ts — tiered cache keeps a bounded hot tier and an optional persistent cold tier with stale-while-revalidate. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * tiered cache keeps a bounded hot tier and an optional persistent cold tier with stale-while-revalidate.
 */

/** Creates a cache with caller supplied encode, decode, clock and persistent storage policies. */
export function tieredcache(options = {}) {
  const hot = new Map();
  const maxentries = Number(options.maxentries ?? 256);
  const ttl = Number(options.ttl ?? 300000);
  const stale = Number(options.stale ?? ttl);
  const now = options.now ?? (() => Date.now());
  const cold = options.storage;
  const encode = options.encode ?? ((value) => new TextEncoder().encode(JSON.stringify(value)));
  const decode = options.decode ?? ((bytes) => JSON.parse(new TextDecoder().decode(bytes)));
  const stats = { hits: 0, misses: 0, stalehits: 0, evictions: 0, revalidations: 0 };

  function readhot(key) {
    const item = hot.get(key);
    if (!item) return null;
    const current = now();
    if (current <= item.expires) { stats.hits += 1; return { value: item.value, fresh: true }; }
    if (current <= item.stale) { stats.stalehits += 1; return { value: item.value, fresh: false }; }
    hot.delete(key);
    return null;
  }

  function writehot(key, value, options = {}) {
    if (hot.size >= maxentries && !hot.has(key)) { hot.delete(hot.keys().next().value); stats.evictions += 1; }
    const current = now();
    hot.set(key, { value, expires: current + Number(options.ttl ?? ttl), stale: current + Number(options.stale ?? stale) });
    return value;
  }

  async function get(key, options = {}) {
    const hotvalue = readhot(key);
    if (hotvalue?.fresh || (hotvalue && options.allowstale !== false)) return hotvalue.value;
    if (!cold) { stats.misses += 1; return null; }
    try { const value = decode(await cold.get(key)); writehot(key, value, options); return value; } catch { stats.misses += 1; return null; }
  }

  async function set(key, value, valueoptions = {}) { writehot(key, value, valueoptions); if (cold) await cold.put({ key, data: encode(value), contenttype: "application/json" }); return value; }
  async function getorload(key, loader, options = {}) {
    if (typeof loader !== "function") throw new TypeError("cache loader must be a function");
    const current = readhot(key);
    if (current?.fresh) return current.value;
    if (current && options.allowstale !== false) { stats.revalidations += 1; Promise.resolve(loader()).then((value) => set(key, value, options)).catch(() => undefined); return current.value; }
    const value = await loader();
    return set(key, value, options);
  }
  async function remove(key) { hot.delete(key); await cold?.delete?.(key); }
  function clear() { hot.clear(); }
  function inspect() { return { ...stats, hotentries: hot.size, maxentries, ttl, stale }; }
  return { get, set, getorload, delete: remove, clear, inspect };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 12: storage/checksum.ts — byte collection and hashing are grouped because every storage adapter uses them. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * byte collection and hashing are grouped because every storage adapter uses them.
 */

export { sha256 };

export async function collectbytes(input) {
  if (input instanceof Uint8Array) return input;
  const chunks = [];
  let size = 0;
  for await (const chunk of input) { chunks.push(chunk); size += chunk.byteLength; }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 13: storage/content.ts — content addressed storage deduplicates immutable bytes while keeping logical references separate. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * content addressed storage deduplicates immutable bytes while keeping logical references separate.
 */


/** Creates a content-addressed view over a caller supplied storage adapter. */
export function contentstorage(storage, options = {}) {
  const objectprefix = options.objectprefix ?? "objects";
  const refprefix = options.refprefix ?? "refs";
  const encode = options.encode ?? ((value) => new TextEncoder().encode(JSON.stringify(value)));
  const decode = options.decode ?? ((bytes) => JSON.parse(new TextDecoder().decode(bytes)));
  if (typeof storage?.put !== "function" || typeof storage?.get !== "function" || typeof storage?.head !== "function") throw new TypeError("content storage requires put, get and head");

  async function put(input = {}) {
    const data = await collectbytes(input.data);
    const digest = sha256(data);
    const objectkey = `${objectprefix}/${digest}`;
    if (!(await storage.head(objectkey))) await storage.put({ key: objectkey, data, contenttype: input.contenttype, metadata: { ...(input.metadata ?? {}), immutable: "true", sha256: digest } });
    const reference = { version: 1, key: String(input.key), objectkey, sha256: digest, sizebytes: data.byteLength, contenttype: input.contenttype ?? "application/octet-stream", metadata: { ...(input.metadata ?? {}) } };
    await storage.put({ key: `${refprefix}/${input.key}`, data: encode(reference), contenttype: "application/json" });
    return reference;
  }

  async function get(key) {
    const reference = decode(await storage.get(`${refprefix}/${key}`));
    return storage.get(reference.objectkey);
  }

  async function head(key) {
    try { return decode(await storage.get(`${refprefix}/${key}`)); } catch { return null; }
  }

  async function remove(key) {
    const reference = await head(key);
    if (!reference) return false;
    await storage.delete?.(`${refprefix}/${key}`);
    return true;
  }

  return { put, get, head, delete: remove, capabilities: { immutableobjects: true, dedupe: true, references: true } };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 14: storage/sync.ts — storage synchronization compares versioned manifests and keeps conflict policy explicit. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * storage synchronization compares versioned manifests and keeps conflict policy explicit.
 */


/** Describes capabilities exposed by a storage adapter without forcing optional methods. */
export function storagecapabilities(storage) {
  return Object.freeze({ range: typeof storage?.getrange === "function", conditional: typeof storage?.putifmatch === "function", metadata: typeof storage?.head === "function", delete: typeof storage?.delete === "function" });
}

/** Creates a comparable object manifest from bytes and caller metadata. */
export async function objectmanifest(key, data, options = {}) {
  const bytes = await collectbytes(data);
  return { version: 1, key: String(key), sizebytes: bytes.byteLength, sha256: sha256(bytes), updatedat: Number(options.updatedat ?? Date.now()), etag: options.etag ?? sha256(bytes), metadata: { ...(options.metadata ?? {}) } };
}

/** Compares two manifests and classifies an update or conflict. */
export function comparemanifests(local, remote) {
  if (!local && !remote) return { state: "empty" };
  if (!local) return { state: "remoteonly", remote };
  if (!remote) return { state: "localonly", local };
  if (local.sha256 === remote.sha256) return { state: "identical", local, remote };
  if (local.updatedat > remote.updatedat) return { state: "localnewer", local, remote };
  if (remote.updatedat > local.updatedat) return { state: "remotenewer", local, remote };
  return { state: "conflict", local, remote };
}

/** Synchronizes one logical object between two adapters with explicit conflict handling. */
export async function syncobject(source, target, key, options = {}) {
  if (typeof source?.head !== "function" || typeof source?.get !== "function" || typeof target?.head !== "function" || typeof target?.put !== "function") throw new TypeError("sync requires source and target head, get and put");
  const sourcehead = await source.head(key);
  const targethead = await target.head(key);
  const comparison = comparemanifests(normalizemanifest(sourcehead, key), normalizemanifest(targethead, key));
  if (["empty", "identical"].includes(comparison.state)) return { key: String(key), state: comparison.state, manifest: comparison.local ?? comparison.remote };
  if (comparison.state === "conflict" && typeof options.resolve !== "function") { const error = new Error(`storage conflict for key: ${key}`); error.code = "STORAGE_CONFLICT"; error.retryable = false; throw error; }
  if (comparison.state === "conflict") { const choice = await options.resolve(comparison); if (!["source", "target"].includes(choice)) throw new TypeError("sync conflict resolver must return source or target"); if (choice === "target") return { key: String(key), state: "kepttarget", manifest: comparison.remote }; }
  const data = await source.get(key);
  const manifest = await objectmanifest(key, data, { updatedat: comparison.local?.updatedat ?? Date.now(), metadata: sourcehead?.metadata });
  await target.put({ key: String(key), data, contenttype: sourcehead?.contenttype, metadata: { ...(sourcehead?.metadata ?? {}), sha256: manifest.sha256, updatedat: String(manifest.updatedat) } });
  return { key: String(key), state: comparison.state === "conflict" ? "resolvedsource" : "copied", manifest };
}

/** Synchronizes one object to multiple backends and returns each outcome. */
export async function syncbackends(source, targets = [], key, options = {}) {
  if (!Array.isArray(targets)) throw new TypeError("sync targets must be an array");
  const results = [];
  for (const target of targets) {
    try { results.push(await syncobject(source, target, key, options)); }
    catch (error) { results.push({ key: String(key), state: "failed", code: error.code ?? "STORAGE_SYNC_FAILED", message: error.message }); if (options.stoponerror) break; }
  }
  return results;
}

function normalizemanifest(value, key) { return value ? { ...value, key: String(value.key ?? key), sha256: value.sha256 ?? value.etag, updatedat: Number(value.updatedat ?? 0) } : null; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 15: storage/chunked.ts — chunked storage keeps large payloads split without forcing a database blob. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * chunked storage keeps large payloads split without forcing a database blob.
 */

export function chunkedstorage(storage, options = {}) {
  const chunkbytes = options.chunkbytes;
  if (!Number.isInteger(chunkbytes) || chunkbytes < 1) throw new TypeError("chunkbytes must be a positive integer");
  return {
    async put(input) {
      const data = await collectbytes(input.data);
      const chunks = [];
      for (let offset = 0; offset < data.byteLength; offset += chunkbytes) {
        const index = chunks.length;
        const key = `${input.key}/chunk${String(index).padStart(8, "0")}`;
        const part = data.slice(offset, Math.min(offset + chunkbytes, data.byteLength));
        const manifest = await storage.put({ key, data: part, contenttype: input.contenttype, metadata: { parent: input.key, index: String(index) } });
        chunks.push({ key, sizebytes: part.byteLength, sha256: manifest.sha256 });
      }
      const manifest = { version: 1, key: input.key, sizebytes: data.byteLength, chunks, chunkbytes, sha256: sha256(data), contenttype: input.contenttype ?? "application/octet-stream", status: "complete", completed: chunks.length, updatedat: Date.now(), metadata: { ...(input.metadata ?? {}) } };
      await storage.put({ key: `${input.key}/manifest`, data: new TextEncoder().encode(JSON.stringify(manifest)), contenttype: "application/json" });
      return manifest;
    },
    async get(key) {
      const raw = await storage.get(`${key}/manifest`);
      const manifest = JSON.parse(new TextDecoder().decode(raw));
      const parts = await Promise.all(manifest.chunks.map((chunk) => storage.get(chunk.key)));
      const output = new Uint8Array(manifest.sizebytes);
      let offset = 0;
      for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
      return output;
    },
    async getrange(key, start = 0, end) {
      const manifest = await this.head(key);
      if (!manifest) throw new Error(`chunk manifest not found: ${key}`);
      const from = Math.max(0, Number(start));
      const to = Math.min(manifest.sizebytes, end === undefined ? manifest.sizebytes : Number(end));
      if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) throw new TypeError("chunk range is invalid");
      if (from === to) return new Uint8Array();
      const first = Math.floor(from / manifest.chunkbytes);
      const last = Math.ceil(to / manifest.chunkbytes) - 1;
      const parts = await Promise.all(manifest.chunks.slice(first, last + 1).map((chunk) => storage.get(chunk.key)));
      const output = new Uint8Array(to - from);
      let offset = 0;
      for (let index = 0; index < parts.length; index += 1) {
        const chunkstart = (first + index) * manifest.chunkbytes;
        const begin = Math.max(from, chunkstart);
        const finish = Math.min(to, chunkstart + parts[index].byteLength);
        output.set(parts[index].slice(begin - chunkstart, finish - chunkstart), offset);
        offset += finish - begin;
      }
      return output;
    },
    async head(key) { const raw = await storage.get(`${key}/manifest`).catch(() => null); return raw ? JSON.parse(new TextDecoder().decode(raw)) : null; },
    async delete(key) { const manifest = await this.head(key); if (!manifest) return; for (const chunk of manifest.chunks) await storage.delete(chunk.key); await storage.delete(`${key}/manifest`); },
    async list(prefix) { return storage.list(prefix); }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 16: storage/local.ts — local storage is explicit, temporary friendly, and protected against traversal. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * local storage is explicit, temporary friendly, and protected against traversal.
 */

export function localstorage(root) {
  const base = resolve(root);
  function safepath(key) {
    const normalized = String(key ?? "").replaceAll("\\", "/");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw validationerror("storage key is not safe", { key });
    const path = resolve(base, normalized);
    if (path !== base && !path.startsWith(`${base}${sep}`)) throw validationerror("storage key escapes adapter root", { key });
    return path;
  }
  function manifest(key, data, contenttype, metadata) {
    return artifactmanifest({ key, sizebytes: data.byteLength, sha256: sha256(data), contenttype, createdat: Date.now(), metadata });
  }
  async function walk(directory, keys) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) { const path = join(directory, entry.name); if (entry.isDirectory()) await walk(path, keys); else keys.push(relative(base, path).split(sep).join("/")); }
  }
  return storageadapter({
    async put(input) { const path = safepath(input.key); const data = await collectbytes(input.data); await mkdir(dirname(path), { recursive: true }); await writeFile(path, data); return manifest(input.key, data, input.contenttype ?? "application/octet-stream", input.metadata); },
    async get(key) { try { return await readFile(safepath(key)); } catch (error) { if (error.code === "ENOENT") throw artifactnotfound(key); throw error; } },
    async head(key) { try { const data = await this.get(key); const file = await stat(safepath(key)); return manifest(key, data, "application/octet-stream", { mtime: String(file.mtimeMs) }); } catch (error) { if (error.name === "saddleerror" && error.code === "ARTIFACT_NOT_FOUND") return null; throw error; } },
    async delete(key) { try { await rm(safepath(key)); } catch (error) { if (error.code !== "ENOENT") throw error; } },
    async list(prefix = "") { const keys = []; await walk(safepath(prefix || "."), keys); return Promise.all(keys.map((key) => this.head(key))); }
  });
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 17: storage/pool.ts — storage pools combine caller-owned adapters without selecting a provider or creating background work. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * storage pools combine caller-owned adapters without selecting a provider or creating background work.
 */

/** Creates a deterministic pool over explicit caller-owned storage adapters. */
export function storagepool(options = {}) {
  const members = normalizemembers(options.members);
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const metrics = { reads: 0, writes: 0, hits: 0, misses: 0, mismatches: 0, bytes: 0, attempts: 0, elapsedms: 0 };

  async function read(key, options = {}) {
    const normalizedkey = requiredkey(key);
    const expectedsha = optionalsha(options.sha256);
    const attempts = [];
    const startedat = Number(clock());
    const selected = selectable(members, options.memberids);
    const budget = operationbudget(options.budget, selected.length);
    metrics.reads += 1;
    for (const member of selected.slice(0, budget.maxattempts)) {
      if (options.signal?.aborted) throw poolerror("STORAGE_POOL_ABORTED", "storage pool read was aborted", { key: normalizedkey, attempts });
      if (elapsed(clock, startedat) > budget.maxmilliseconds) throw poolerror("STORAGE_POOL_TIME_BUDGET", "storage pool read time budget was exceeded", { key: normalizedkey, attempts });
      try {
        metrics.attempts += 1;
        const manifest = await optionalhead(member.storage, normalizedkey);
        const raw = await member.storage.get(normalizedkey);
        const data = await collectbytes(raw?.data ?? raw);
        if (data.byteLength > budget.maxbytes) throw poolerror("STORAGE_POOL_BYTE_BUDGET", "storage pool read byte budget was exceeded", { key: normalizedkey, memberid: member.id, maxbytes: budget.maxbytes, sizebytes: data.byteLength });
        const actualsha = sha256(data);
        const requiredsha = expectedsha ?? manifest?.sha256;
        if (requiredsha && actualsha !== requiredsha) {
          metrics.mismatches += 1;
          throw poolerror("STORAGE_POOL_DIGEST_MISMATCH", "storage pool read digest did not match", { key: normalizedkey, memberid: member.id, expectedsha: requiredsha, actualsha });
        }
        metrics.hits += 1;
        metrics.bytes += data.byteLength;
        metrics.elapsedms += elapsed(clock, startedat);
        return Object.freeze({ version: 1, key: normalizedkey, memberid: member.id, data, sha256: actualsha, verified: Boolean(requiredsha), manifest: manifest ?? null, attempts: Object.freeze(attempts), budget, readat: Number(clock()) });
      } catch (error) { attempts.push(attempt(member.id, error)); }
    }
    metrics.misses += 1;
    metrics.elapsedms += elapsed(clock, startedat);
    throw poolerror("STORAGE_POOL_READ_FAILED", "storage pool could not read a verified object", { key: normalizedkey, attempts });
  }

  async function put(input = {}, options = {}) {
    const key = requiredkey(input.key);
    const data = await collectbytes(input.data);
    const digest = sha256(data);
    const selected = writeselection(selectable(members, options.memberids), options.mode);
    const budget = operationbudget(options.budget, selected.length);
    if (data.byteLength > budget.maxbytes) throw poolerror("STORAGE_POOL_BYTE_BUDGET", "storage pool write byte budget was exceeded", { key, maxbytes: budget.maxbytes, sizebytes: data.byteLength });
    const quorum = positiveinteger(options.quorum ?? 1, "storage pool quorum");
    if (quorum > selected.length) throw new RangeError("storage pool quorum exceeds selected members");
    const results = [];
    metrics.writes += 1;
    const startedat = Number(clock());
    for (const member of selected.slice(0, budget.maxattempts)) {
      if (options.signal?.aborted) { results.push({ memberid: member.id, state: "skipped", code: "STORAGE_POOL_ABORTED" }); break; }
      if (elapsed(clock, startedat) > budget.maxmilliseconds) { results.push({ memberid: member.id, state: "skipped", code: "STORAGE_POOL_TIME_BUDGET" }); break; }
      try {
        metrics.attempts += 1;
        const manifest = await member.storage.put({ ...input, key, data: new Uint8Array(data), metadata: { ...(input.metadata ?? {}), sha256: digest } });
        if (manifest?.sha256 && manifest.sha256 !== digest) throw poolerror("STORAGE_POOL_DIGEST_MISMATCH", "storage pool write digest did not match", { key, memberid: member.id, expectedsha: digest, actualsha: manifest.sha256 });
        results.push({ memberid: member.id, state: "written", manifest: manifest ?? null });
      } catch (error) { results.push({ memberid: member.id, state: "failed", code: error?.code ?? "STORAGE_POOL_WRITE_FAILED", message: String(error?.message ?? error) }); }
    }
    const written = results.filter((result) => result.state === "written");
    metrics.bytes += data.byteLength * written.length;
    metrics.elapsedms += elapsed(clock, startedat);
    const output = Object.freeze({ version: 1, key, sha256: digest, sizebytes: data.byteLength, mode: options.mode ?? "fanout", quorum, state: written.length === selected.length ? "complete" : "partial", results: Object.freeze(results), written: written.length, budget, writtenat: Number(clock()) });
    if (written.length < quorum) throw poolerror("STORAGE_POOL_QUORUM_FAILED", "storage pool write quorum was not met", output);
    return output;
  }

  async function readrange(key, start, end, options = {}) {
    const normalizedkey = requiredkey(key);
    const range = validrange(start, end);
    const expectedsha = optionalsha(options.sha256);
    const attempts = [];
    const selected = selectable(members, options.memberids);
    const budget = operationbudget(options.budget, selected.length);
    const startedat = Number(clock());
    metrics.reads += 1;
    for (const member of selected.slice(0, budget.maxattempts)) {
      if (options.signal?.aborted) throw poolerror("STORAGE_POOL_ABORTED", "storage pool range read was aborted", { key: normalizedkey, range, attempts });
      if (elapsed(clock, startedat) > budget.maxmilliseconds) throw poolerror("STORAGE_POOL_TIME_BUDGET", "storage pool range read time budget was exceeded", { key: normalizedkey, range, attempts });
      if (typeof member.storage.getrange !== "function") { attempts.push({ memberid: member.id, code: "STORAGE_POOL_RANGE_UNSUPPORTED", message: "storage pool member does not support range reads" }); continue; }
      try {
        metrics.attempts += 1;
        const data = await collectbytes(await member.storage.getrange(normalizedkey, range.start, range.end));
        if (data.byteLength !== range.end - range.start) throw poolerror("STORAGE_POOL_RANGE_SIZE", "storage pool range result size did not match", { key: normalizedkey, range, memberid: member.id, sizebytes: data.byteLength });
        const actualsha = sha256(data);
        if (expectedsha && actualsha !== expectedsha) throw poolerror("STORAGE_POOL_DIGEST_MISMATCH", "storage pool range digest did not match", { key: normalizedkey, range, memberid: member.id, expectedsha, actualsha });
        metrics.hits += 1;
        metrics.bytes += data.byteLength;
        metrics.elapsedms += elapsed(clock, startedat);
        return Object.freeze({ version: 1, key: normalizedkey, range, memberid: member.id, data, sha256: actualsha, verified: Boolean(expectedsha), attempts: Object.freeze(attempts), budget, readat: Number(clock()) });
      } catch (error) { attempts.push(attempt(member.id, error)); }
    }
    metrics.misses += 1;
    metrics.elapsedms += elapsed(clock, startedat);
    throw poolerror("STORAGE_POOL_RANGE_FAILED", "storage pool could not read the requested range", { key: normalizedkey, range, attempts });
  }

  function repairplan(key, options = {}) {
    const normalizedkey = requiredkey(key);
    const sourceid = String(options.sourceid ?? "");
    if (!members.some((member) => member.id === sourceid)) throw new TypeError("storage pool repair source member is unknown");
    return Object.freeze({ version: 1, key: normalizedkey, sourceid, sha256: optionalsha(options.sha256), targets: selectable(members, options.memberids).filter((member) => member.id !== sourceid).map((member) => member.id), action: "caller-executes" });
  }

  function restoreplan(key, options = {}) {
    const normalizedkey = requiredkey(key);
    const selected = selectable(members, options.memberids);
    const evidence = new Map((options.replicas ?? []).map((value) => [String(value?.memberid ?? ""), value?.verified === true]));
    const candidates = selected.map((member) => ({ memberid: member.id, verified: evidence.get(member.id) === true })).sort((left, right) => Number(right.verified) - Number(left.verified) || left.memberid.localeCompare(right.memberid));
    return Object.freeze({ version: 1, key: normalizedkey, sha256: optionalsha(options.sha256), action: "caller-restores", candidates: Object.freeze(candidates) });
  }

  return Object.freeze({ read, readrange, put, repairplan, restoreplan, members: () => members.map(describe), capabilities: () => members.map((member) => ({ id: member.id, priority: member.priority, capabilities: storagecapabilities(member.storage) })), metrics: () => ({ ...metrics }) });
}

function normalizemembers(input) {
  if (!Array.isArray(input) || input.length === 0) throw new TypeError("storage pool members must be a non-empty array");
  const ids = new Set();
  const members = input.map((value, index) => {
    const id = String(value?.id ?? "");
    if (!id) throw new TypeError("storage pool member id is required");
    if (ids.has(id)) throw new TypeError(`storage pool member id is duplicated: ${id}`);
    ids.add(id);
    if (typeof value?.storage?.get !== "function" || typeof value?.storage?.put !== "function") throw new TypeError(`storage pool member requires get and put: ${id}`);
    const priority = Number(value.priority ?? index);
    if (!Number.isFinite(priority)) throw new TypeError(`storage pool member priority is invalid: ${id}`);
    return Object.freeze({ id, storage: value.storage, priority });
  });
  return Object.freeze(members.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id)));
}

function selectable(members, ids) {
  if (ids === undefined) return members;
  if (!Array.isArray(ids) || ids.length === 0) throw new TypeError("storage pool memberids must be a non-empty array");
  const expected = new Set(ids.map((id) => String(id)));
  const selected = members.filter((member) => expected.has(member.id));
  if (selected.length !== expected.size) throw new TypeError("storage pool memberids include an unknown member");
  return selected;
}

function writeselection(members, mode = "fanout") {
  const normalized = String(mode);
  if (!new Set(["primary", "mirror", "fanout"]).has(normalized)) throw new TypeError("storage pool write mode is invalid");
  return normalized === "primary" ? members.slice(0, 1) : members;
}

async function optionalhead(storage, key) { return typeof storage.head === "function" ? await storage.head(key) : null; }
function describe(member) { return Object.freeze({ id: member.id, priority: member.priority }); }
function requiredkey(value) { const key = String(value ?? ""); if (!key) throw new TypeError("storage pool key is required"); return key; }
function optionalsha(value) { if (value === undefined || value === null) return null; const digest = String(value); if (!/^[a-f0-9]{64}$/i.test(digest)) throw new TypeError("storage pool sha256 is invalid"); return digest.toLowerCase(); }
function positiveinteger(value, name) { const numeric = Number(value); if (!Number.isInteger(numeric) || numeric < 1) throw new TypeError(`${name} must be a positive integer`); return numeric; }
function operationbudget(input = {}, fallbackattempts) { const budget = input ?? {}; return Object.freeze({ maxattempts: positiveinteger(budget.maxattempts ?? fallbackattempts, "storage pool budget maxattempts"), maxbytes: nonnegativebudget(budget.maxbytes, "storage pool budget maxbytes"), maxmilliseconds: nonnegativebudget(budget.maxmilliseconds, "storage pool budget maxmilliseconds") }); }
function nonnegativebudget(value, name) { if (value === undefined) return Infinity; const numeric = Number(value); if (!Number.isSafeInteger(numeric) || numeric < 0) throw new TypeError(`${name} must be a non-negative safe integer`); return numeric; }
function elapsed(clock, startedat) { return Math.max(0, Number(clock()) - startedat); }
function validrange(start, end) { const from = nonnegativebudget(start, "storage pool range start"); const to = nonnegativebudget(end, "storage pool range end"); if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new TypeError("storage pool range is invalid"); return Object.freeze({ start: from, end: to }); }
function attempt(memberid, error) { return { memberid, code: error?.code ?? "STORAGE_POOL_READ_FAILED", message: String(error?.message ?? error) }; }
function poolerror(code, message, detail) { const error = new Error(message); error.code = code; error.detail = detail; return error; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 18: storage/s3compatible.ts — s3 compatible storage stays open by accepting a caller supplied signer. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * s3 compatible storage stays open by accepting a caller supplied signer.
 * List operations use the S3 ListObjectsV2 contract without owning credentials.
 */

/** Creates an S3-compatible adapter with signed CRUD and paginated listing. */
export function s3compatible(options = {}) {
  if (!options.endpoint || !options.bucket || typeof options.sign !== "function") throw new TypeError("s3 compatible storage requires endpoint bucket and sign");
  const endpoint = new URL(options.endpoint);
  const fetcher = options.fetcher ?? fetch;

  async function request(method, key, body, query = {}) {
    const signed = await options.sign({ method, endpoint, bucket: options.bucket, key, query, body });
    const url = new URL(signed.url, endpoint);
    if (!url.search && Object.keys(query).length) for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
    const response = await fetcher(url, { method, headers: signed.headers, body });
    if (!response.ok) throw new Error(`storage request failed with ${response.status}`);
    return response;
  }

  return storageadapter({
    async put(input) { const data = await (input.data instanceof Uint8Array ? input.data : await collectbytes(input.data)); await request("PUT", input.key, data); return { key: input.key, sizebytes: data.byteLength, sha256: await sha256(data), contenttype: input.contenttype ?? "application/octet-stream", createdat: Date.now(), metadata: { ...(input.metadata ?? {}) } }; },
    async get(key) { const response = await request("GET", key); return new Uint8Array(await response.arrayBuffer()); },
    async head(key) { try { const response = await request("HEAD", key); return { key, sizebytes: Number(response.headers.get("content-length") ?? 0), sha256: response.headers.get("etag") ?? "", contenttype: response.headers.get("content-type") ?? "application/octet-stream", createdat: Date.now(), metadata: {} }; } catch { return null; } },
    async delete(key) { await request("DELETE", key); },
    async list(prefix = "", listoptions = {}) {
      const maxkeys = Math.max(1, Math.min(1000, Number(listoptions.maxkeys ?? options.maxkeys ?? 1000)));
      const maxpages = Math.max(1, Number(listoptions.maxpages ?? options.maxpages ?? 100));
      const entries = [];
      let continuation = listoptions.continuationToken;
      for (let page = 0; page < maxpages; page += 1) {
        const query = { "list-type": "2", prefix, "max-keys": maxkeys };
        if (continuation) query["continuation-token"] = continuation;
        const response = await request("GET", "", undefined, query);
        const parsed = parseListXml(await response.text());
        entries.push(...parsed.entries);
        if (!parsed.truncated || !parsed.nextToken) return entries;
        if (parsed.nextToken === continuation) throw new Error("s3 list continuation token did not advance");
        continuation = parsed.nextToken;
      }
      return entries;
    },
  });
}

function parseListXml(xml) {
  const entries = [];
  for (const block of xml.match(/<Contents\b[\s\S]*?<\/Contents>/gi) ?? []) {
    const key = xmlvalue(block, "Key");
    if (!key) continue;
    const etag = xmlvalue(block, "ETag");
    entries.push({ key, sizebytes: Number(xmlvalue(block, "Size") ?? 0), sha256: etag?.replace(/^"|"$/g, "") ?? "", contenttype: "application/octet-stream", createdat: Date.now(), metadata: { etag, lastmodified: xmlvalue(block, "LastModified"), storageclass: xmlvalue(block, "StorageClass") } });
  }
  const truncated = xmlvalue(xml, "IsTruncated") === "true";
  return { entries, truncated, nextToken: xmlvalue(xml, "NextContinuationToken") };
}

function xmlvalue(xml, name) { const match = String(xml).match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i")); return match ? decodexml(match[1].trim()) : undefined; }
function decodexml(value) { return String(value).replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'"); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 19: storage/githubcontents.ts — github contents storage maps artifacts to repository files through an injected token. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * github contents storage maps artifacts to repository files through an injected token.
 */

export function githubcontents(options = {}) {
  if (!options.baseurl || !options.owner || !options.repo || typeof options.token !== "function") throw new TypeError("github contents requires baseurl owner repo and token");
  const fetcher = options.fetcher ?? fetch;
  async function request(method, key, body) { const token = await options.token(); const response = await fetcher(new URL(`/repos/${options.owner}/${options.repo}/contents/${key}`, options.baseurl), { method, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); if (!response.ok) throw new Error(`github contents request failed with ${response.status}`); return response; }
  return storageadapter({
    async put(input) { const data = await collectbytes(input.data); let sha; try { sha = (await (await request("GET", input.key)).json()).sha; } catch {} const response = await request("PUT", input.key, { message: input.message ?? `saddle write ${input.key}`, content: Buffer.from(data).toString("base64"), branch: options.branch ?? "main", sha }); const result = await response.json(); return { key: input.key, sizebytes: data.byteLength, sha256: sha256(data), contenttype: input.contenttype ?? "application/octet-stream", createdat: Date.now(), metadata: { url: result.content?.download_url, commit: result.commit?.sha, ...(input.metadata ?? {}) } }; },
    async get(key) { const result = await (await request("GET", key)).json(); return new Uint8Array(Buffer.from(result.content.replaceAll("\n", ""), "base64")); },
    async head(key) { try { const result = await (await request("GET", key)).json(); return { key, sizebytes: result.size, sha256: result.sha ?? "", contenttype: "application/octet-stream", createdat: Date.now(), metadata: { url: result.download_url } }; } catch { return null; } },
    async delete(key) { const result = await (await request("GET", key)).json(); await request("DELETE", key, { message: `saddle delete ${key}`, sha: result.sha, branch: options.branch ?? "main" }); },
    async list(prefix = "") { const result = await (await request("GET", prefix)).json(); return (Array.isArray(result) ? result : []).filter((item) => item.type === "file").map((item) => ({ key: item.path, sizebytes: item.size, sha256: item.sha, contenttype: "application/octet-stream", createdat: Date.now(), metadata: { url: item.download_url } })); }
  });
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 20: storage/filehosting.ts — file hosting adapter accepts a caller supplied request function for s3compatible or webdav. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * file hosting adapter accepts a caller supplied request function for s3compatible or webdav.
 */

export function filehosting(options = {}) {
  if (!options.host || typeof options.request !== "function") throw new TypeError("file hosting requires host and request");
  const method = options.method ?? "s3compatible";
  return storageadapter({
    async put(input) { const data = await collectbytes(input.data); await options.request({ method: method === "webdav" ? "PUT" : "put", url: new URL(input.key, options.host).href, data, headers: { "content-type": input.contenttype ?? "application/octet-stream" } }); return { key: input.key, sizebytes: data.byteLength, sha256: sha256(data), contenttype: input.contenttype ?? "application/octet-stream", createdat: Date.now(), metadata: input.metadata ?? {} }; },
    async get(key) { const result = await options.request({ method: method === "webdav" ? "GET" : "get", url: new URL(key, options.host).href }); return result.data ?? result; },
    async head(key) { try { const result = await options.request({ method: "head", url: new URL(key, options.host).href }); return { key, sizebytes: Number(result.headers?.["content-length"] ?? 0), sha256: result.headers?.etag ?? "", contenttype: result.headers?.["content-type"] ?? "application/octet-stream", createdat: Date.now(), metadata: {} }; } catch { return null; } },
    async delete(key) { await options.request({ method: method === "webdav" ? "DELETE" : "delete", url: new URL(key, options.host).href }); },
    async list(prefix = "") { const result = await options.request({ method: method === "webdav" ? "PROPFIND" : "list", url: new URL(prefix, options.host).href }); return result.items ?? []; }
  });
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 21: persistence/schema.ts — the schema descriptor is neutral so prisma drizzle mysql2 or another driver can map it. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * the schema descriptor is neutral so prisma drizzle mysql2 or another driver can map it.
 */
export const schemadefinition = Object.freeze({
  jobs: { id: "text primary key", name: "text", status: "text", priority: "integer", input: "json", outputkey: "text", createdat: "integer", updatedat: "integer" },
  events: { id: "text primary key", jobid: "text", type: "text", at: "integer", data: "json" },
  sessions: { id: "text primary key", version: "integer", agentname: "text", originurl: "text", seed: "text", status: "text", startedat: "integer", finishedat: "integer", events: "json" },
  artifacts: { key: "text primary key", sizebytes: "bigint", sha256: "text", contenttype: "text", createdat: "integer", metadata: "json" },
  chunks: { id: "text primary key", artifactkey: "text", index: "integer", offset: "bigint", sizebytes: "integer", sha256: "text", storagekey: "text" }
  ,queueitems: { id: "text primary key", status: "text", attempts: "integer", payload: "json", result: "json", error: "json", createdat: "bigint", updatedat: "bigint" }
});

export function schemasql(options = {}) {
  const dialect = options.dialect ?? "mysql";
  const json = dialect === "postgres" ? "jsonb" : "json";
  const bigint = dialect === "sqlite" ? "integer" : "bigint";
  return [
    `create table if not exists jobs (id text primary key, name text not null, status text not null, priority integer not null, input ${json}, outputkey text, createdat ${bigint} not null, updatedat ${bigint} not null)`,
    `create table if not exists events (id text primary key, jobid text not null, type text not null, at ${bigint} not null, data ${json} not null)`,
    `create table if not exists sessions (id text primary key, version integer not null, agentname text not null, originurl text not null, seed text not null, status text not null, startedat ${bigint} not null, finishedat ${bigint}, events ${json} not null)`,
    `create table if not exists artifacts (key text primary key, sizebytes ${bigint} not null, sha256 text not null, contenttype text not null, createdat ${bigint} not null, metadata ${json} not null)`,
    `create table if not exists chunks (id text primary key, artifactkey text not null, chunkindex integer not null, byteoffset ${bigint} not null, sizebytes integer not null, sha256 text not null, storagekey text not null)`
    ,`create table if not exists queueitems (id text primary key, status text not null, attempts integer not null, payload ${json} not null, result ${json}, error ${json}, createdat ${bigint} not null, updatedat ${bigint} not null)`
  ];
}

export function prismaschema() {
  return `model job { id String @id name String status String priority Int input Json? outputkey String? createdat BigInt updatedat BigInt }\nmodel event { id String @id jobid String type String at BigInt data Json }\nmodel session { id String @id version Int agentname String originurl String seed String status String startedat BigInt finishedat BigInt? events Json }\nmodel artifact { key String @id sizebytes BigInt sha256 String contenttype String createdat BigInt metadata Json }\nmodel chunk { id String @id artifactkey String chunkindex Int byteoffset BigInt sizebytes Int sha256 String storagekey String }`;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 22: persistence/adapter.ts — persistence adapters keep database and remote state outside the runtime core. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * persistence adapters keep database and remote state outside the runtime core.
 */
export function persistenceadapter(methods) {
  const required = ["savejob", "getjob", "updatejob", "listjobs", "saveevent", "listevents", "savesession", "readsession", "saveartifact", "getartifact", "savechunk", "getchunks"];
  for (const name of required) if (typeof methods?.[name] !== "function") throw new TypeError(`persistence adapter requires ${name}`);
  return methods;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 23: persistence/memory.ts — memory persistence is the local baseline for tests and offline operation. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * memory persistence is the local baseline for tests and offline operation.
 */

export function memorypersistence() {
  const jobs = new Map();
  const events = new Map();
  const sessions = new Map();
  const artifacts = new Map();
  const chunks = new Map();
  return persistenceadapter({
    async savejob(job) { jobs.set(job.id, structuredClone(job)); return jobs.get(job.id); },
    async getjob(id) { return jobs.get(id) ? structuredClone(jobs.get(id)) : null; },
    async updatejob(id, patch) { const current = jobs.get(id); if (!current) return null; const next = { ...current, ...patch, updatedat: Date.now() }; jobs.set(id, next); return structuredClone(next); },
    async listjobs(filter = {}) { return [...jobs.values()].filter((job) => Object.entries(filter).every(([key, value]) => job[key] === value)).map((job) => structuredClone(job)); },
    async saveevent(event) { const list = events.get(event.jobid) ?? []; list.push(structuredClone(event)); events.set(event.jobid, list); return event; },
    async listevents(jobid) { return (events.get(jobid) ?? []).map((event) => structuredClone(event)); },
    async savesession(session) { sessions.set(session.id, structuredClone(session)); return structuredClone(session); },
    async readsession(id) { return sessions.get(id) ? structuredClone(sessions.get(id)) : null; },
    async saveartifact(artifact) { artifacts.set(artifact.key, structuredClone(artifact)); return structuredClone(artifact); },
    async getartifact(key) { return artifacts.get(key) ? structuredClone(artifacts.get(key)) : null; },
    async savechunk(chunk) { chunks.set(chunk.id, structuredClone(chunk)); return structuredClone(chunk); },
    async getchunks(artifactkey) { return [...chunks.values()].filter((chunk) => chunk.artifactkey === artifactkey).sort((left, right) => left.index - right.index).map((chunk) => structuredClone(chunk)); }
  });
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 24: persistence/sql.ts — sql persistence keeps query execution injected for mysql2 drizzle or another sql client. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * sql persistence keeps query execution injected for mysql2 drizzle or another sql client.
 */

export function sqlpersistence(options = {}) {
  if (typeof options.query !== "function") throw new TypeError("sql persistence requires query");
  const table = options.table ?? { jobs: "jobs", events: "events", sessions: "sessions", artifacts: "artifacts", chunks: "chunks" };
  async function one(statement, values = []) { const result = await options.query(statement, values); return result?.rows?.[0] ?? result?.[0]?.[0] ?? result?.[0] ?? null; }
  async function many(statement, values = []) { const result = await options.query(statement, values); return result?.rows ?? result?.[0] ?? result ?? []; }
  return persistenceadapter({
    async savejob(job) { await options.query(`insert into ${table.jobs} (id,name,status,priority,input,outputkey,createdat,updatedat) values (?,?,?,?,?,?,?,?)`, [job.id, job.name, job.status, job.priority, JSON.stringify(job.input ?? null), job.outputkey ?? null, job.createdat, job.updatedat ?? job.createdat]); return job; },
    async getjob(id) { const row = await one(`select * from ${table.jobs} where id = ?`, [id]); return row ? normalizejob(row) : null; },
    async updatejob(id, patch) { const current = await this.getjob(id); if (!current) return null; const next = { ...current, ...patch, updatedat: Date.now() }; await options.query(`update ${table.jobs} set status = ?, priority = ?, input = ?, outputkey = ?, updatedat = ? where id = ?`, [next.status, next.priority, JSON.stringify(next.input ?? null), next.outputkey ?? null, next.updatedat, id]); return next; },
    async listjobs(filter = {}) { const rows = await many(`select * from ${table.jobs} order by createdat desc`, []); return rows.map(normalizejob).filter((job) => Object.entries(filter).every(([key, value]) => job[key] === value)); },
    async saveevent(event) { await options.query(`insert into ${table.events} (id,jobid,type,at,data) values (?,?,?,?,?)`, [event.id, event.jobid, event.type, event.at, JSON.stringify(event.data ?? {})]); return event; },
    async listevents(jobid) { return (await many(`select * from ${table.events} where jobid = ? order by at asc`, [jobid])).map((row) => ({ ...row, data: parsejson(row.data) })); },
    async savesession(session) { await options.query(`insert into ${table.sessions} (id,version,agentname,originurl,seed,status,startedat,finishedat,events) values (?,?,?,?,?,?,?,?,?)`, [session.id, session.version, session.agentname, session.originurl, session.seed, session.status, session.startedat, session.finishedat ?? null, JSON.stringify(session.events ?? [])]); return session; },
    async readsession(id) { const row = await one(`select * from ${table.sessions} where id = ?`, [id]); return row ? { ...row, events: parsejson(row.events) } : null; },
    async saveartifact(artifact) { await options.query(`insert into ${table.artifacts} (key,sizebytes,sha256,contenttype,createdat,metadata) values (?,?,?,?,?,?)`, [artifact.key, artifact.sizebytes, artifact.sha256, artifact.contenttype, artifact.createdat, JSON.stringify(artifact.metadata ?? {})]); return artifact; },
    async getartifact(key) { const row = await one(`select * from ${table.artifacts} where key = ?`, [key]); return row ? { ...row, metadata: parsejson(row.metadata) } : null; },
    async savechunk(chunk) { await options.query(`insert into ${table.chunks} (id,artifactkey,chunkindex,byteoffset,sizebytes,sha256,storagekey) values (?,?,?,?,?,?,?)`, [chunk.id, chunk.artifactkey, chunk.index, chunk.offset, chunk.sizebytes, chunk.sha256, chunk.storagekey]); return chunk; },
    async getchunks(artifactkey) { return (await many(`select * from ${table.chunks} where artifactkey = ? order by chunkindex asc`, [artifactkey])).map((row) => ({ ...row, index: row.index ?? row.chunkindex, offset: row.offset ?? row.byteoffset })); }
  });
}

export function mysql2persistence(pool, options = {}) { if (typeof pool?.execute !== "function") throw new TypeError("mysql2 pool requires execute"); return sqlpersistence({ ...options, query: async (statement, values) => pool.execute(statement, values) }); }

function normalizejob(row) { return { ...row, input: parsejson(row.input) }; }
function parsejson(value) { if (value == null || typeof value === "object") return value; try { return JSON.parse(value); } catch { return value; } }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 25: persistence/drizzle.ts — drizzle persistence accepts a small repository object generated by the caller's schema. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * drizzle persistence accepts a small repository object generated by the caller's schema.
 */

export function drizzlepersistence(repository) {
  const required = ["savejob", "getjob", "updatejob", "listjobs", "saveevent", "listevents", "savesession", "readsession", "saveartifact", "getartifact", "savechunk", "getchunks"];
  for (const name of required) if (typeof repository?.[name] !== "function") throw new TypeError(`drizzle repository requires ${name}`);
  return persistenceadapter(repository);
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 26: persistence/prisma.ts — prisma persistence maps model delegates through an explicit model configuration. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * prisma persistence maps model delegates through an explicit model configuration.
 */

export function prismapersistence(client, options = {}) {
  const models = { jobs: options.jobs ?? client?.job, events: options.events ?? client?.event, sessions: options.sessions ?? client?.session, artifacts: options.artifacts ?? client?.artifact, chunks: options.chunks ?? client?.chunk };
  for (const [name, model] of Object.entries(models)) if (!model) throw new TypeError(`prisma model is missing: ${name}`);
  return persistenceadapter({
    async savejob(job) { return models.jobs.upsert({ where: { id: job.id }, create: job, update: job }); },
    async getjob(id) { return models.jobs.findUnique({ where: { id } }); },
    async updatejob(id, patch) { return models.jobs.update({ where: { id }, data: { ...patch, updatedat: Date.now() } }); },
    async listjobs(filter = {}) { return models.jobs.findMany({ where: filter, orderBy: { createdat: "desc" } }); },
    async saveevent(event) { return models.events.create({ data: event }); },
    async listevents(jobid) { return models.events.findMany({ where: { jobid }, orderBy: { at: "asc" } }); },
    async savesession(session) { return models.sessions.upsert({ where: { id: session.id }, create: session, update: session }); },
    async readsession(id) { return models.sessions.findUnique({ where: { id } }); },
    async saveartifact(artifact) { return models.artifacts.upsert({ where: { key: artifact.key }, create: artifact, update: artifact }); },
    async getartifact(key) { return models.artifacts.findUnique({ where: { key } }); },
    async savechunk(chunk) { return models.chunks.upsert({ where: { id: chunk.id }, create: chunk, update: chunk }); },
    async getchunks(artifactkey) { return models.chunks.findMany({ where: { artifactkey }, orderBy: { index: "asc" } }); }
  });
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 27: persistence/migrations.ts — migration plans stay neutral so Prisma, Drizzle, MySQL2, Turso, and another SQL driver can map them. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * migration plans stay neutral so Prisma, Drizzle, MySQL2, Turso, and another SQL driver can map them.
 */
export const migrationlist = Object.freeze([
  { version: 1, name: "baseoperational", tables: ["jobs", "events", "sessions", "artifacts", "chunks"] },
  { version: 2, name: "persistentqueue", tables: ["queueitems"] },
  { version: 3, name: "webhookdeliveries", tables: ["webhookdeliveries"] }
]);

/** Returns pending migration statements for a dialect. */
export function migrationplan(options: { current?: number, dialect?: string } = {}) { const current = options.current ?? 0; const dialect = options.dialect ?? "mysql"; return migrationlist.filter((migration) => migration.version > current).map((migration) => ({ ...migration, statements: migration.version === 2 ? [`create table if not exists queueitems (id text primary key, status text not null, attempts integer not null, payload json not null, result json, error json, createdat bigint not null, updatedat bigint not null)`] : migration.version === 3 ? [`create table if not exists webhookdeliveries (id text primary key, event text not null, receivedat bigint not null, processedat bigint, payload json not null)`] : [], dialect })); }

/** Returns the latest schema version. */
export function latestmigration() { return migrationlist.at(-1)?.version ?? 0; }
