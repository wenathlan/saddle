/**
 * job creation is kept small and side effect free.
 */
import { validationerror } from "../core/errors.js";

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
