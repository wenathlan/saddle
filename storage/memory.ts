/**
 * memory storage keeps bytes in a bounded process-local map for browser workers, Deno, Bun and tests.
 */

import { artifactmanifest } from "../core/artifacts.js";
import { sha256 } from "./checksum.js";
import { storageadapter } from "./adapter.js";

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
