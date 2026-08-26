/**
 * local storage is explicit, temporary friendly, and protected against traversal.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { artifactnotfound, validationerror } from "../core/errors.js";
import { artifactmanifest } from "../core/artifacts.js";
import { collectbytes, sha256 } from "./checksum.js";
import { storageadapter } from "./adapter.js";

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
