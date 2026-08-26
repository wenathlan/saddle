/**
 * memory bridges materialize and clear temporary working sets.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncresult, workingset } from "../core/runtime.js";

export function localmemory(options = {}) {
  const base = options.base ?? tmpdir();
  return {
    async prepare(job) { const location = await mkdtemp(join(base, "saddlejob")); return workingset(job.id, location, join(location, "resultbin")); },
    async sync(set, bytes) { await mkdir(set.location, { recursive: true }); await writeFile(set.resultpath, bytes); return syncresult(bytes.byteLength, set.resultpath); },
    async cleanup(set) { await rm(set.location, { recursive: true, force: true }); }
  };
}
