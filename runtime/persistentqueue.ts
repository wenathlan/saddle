/**
 * persistent queue stores job state in a caller selected file.
 * running items return to queued when a process restores after a crash.
 */
import { readFile, writeFile } from "node:fs/promises";

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
