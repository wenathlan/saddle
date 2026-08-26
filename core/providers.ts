/**
 * providers declare capacity while scheduling remains a runtime decision.
 */
export const runnerstatuses = Object.freeze(["available", "busy", "offline"]);

export function runnercontext(job, workingset, signal) {
  return { job, workingset, signal };
}
