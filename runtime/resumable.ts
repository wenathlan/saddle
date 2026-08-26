/**
 * resumable runs keep remote execution state explicit and recoverable across process restarts.
 */

export const runstatuses = Object.freeze(["created", "submitted", "running", "succeeded", "failed", "cancelled"]);
const transitions = { created: ["submitted", "cancelled"], submitted: ["running", "failed", "cancelled"], running: ["succeeded", "failed", "cancelled"], succeeded: [], failed: ["submitted", "cancelled"], cancelled: [] };

/** Creates a validated run record with explicit transition history. */
export function runrecord(input = {}) {
  if (!input.requestid || !input.name) throw new TypeError("run record requires requestid and name");
  return { version: 1, requestid: String(input.requestid), name: String(input.name), status: input.status ?? "created", runid: input.runid, attempt: Number(input.attempt ?? 0), createdat: Number(input.createdat ?? Date.now()), updatedat: Number(input.updatedat ?? Date.now()), history: Array.isArray(input.history) ? input.history.map((event) => ({ ...event })) : [], metadata: { ...(input.metadata ?? {}) } };
}

/** Moves a run through a legal state transition and appends an auditable event. */
export function transitionrun(record, status, options = {}) {
  const current = runrecord(record);
  if (!runstatuses.includes(status) || !transitions[current.status]?.includes(status)) { const error = new Error(`invalid run transition: ${current.status} to ${status}`); error.code = "INVALID_RUN_TRANSITION"; throw error; }
  const event = { from: current.status, to: status, at: Number(options.at ?? Date.now()), reason: options.reason };
  return { ...current, status, runid: options.runid ?? current.runid, attempt: status === "submitted" ? current.attempt + 1 : current.attempt, updatedat: event.at, history: [...current.history, event] };
}

/** Coordinates submit, status, resume and cancel operations through an injected remote adapter. */
export function resumablerun(adapter, input = {}) {
  if (typeof adapter?.submit !== "function" || typeof adapter?.status !== "function") throw new TypeError("resumable run adapter requires submit and status");
  let record = runrecord(input);
  let compensation = { status: typeof input.compensate === "function" ? "pending" : "not-configured" };
  async function submit() { const response = await adapter.submit(input); record = transitionrun(record, "submitted", { runid: response?.runid, reason: "submitted" }); return { ...record, response }; }
  async function resume() { if (record.status === "created") await submit(); if (typeof adapter.resume === "function") await adapter.resume(record); const response = await adapter.status(record.runid); if (response?.status && response.status !== record.status && transitions[record.status]?.includes(response.status)) record = transitionrun(record, response.status, { reason: "remote-status" }); return { ...record, response }; }
  async function cancel(options = {}) {
    if (record.status === "cancelled") return { ...record, compensation };
    if (!transitions[record.status]?.includes("cancelled")) throw new Error(`invalid run transition: ${record.status} to cancelled`);
    if (typeof adapter.cancel !== "function") throw new TypeError("resumable run adapter does not support cancel");
    const response = await adapter.cancel(record.runid, options);
    record = transitionrun(record, "cancelled", { reason: options.reason ?? "cancelled" });
    const handler = options.compensate ?? input.compensate;
    if (typeof handler !== "function") compensation = { status: "not-configured" };
    else if (compensation.status === "pending") {
      try {
        compensation = { status: "succeeded", result: await handler({ run: runrecord(record), response, reason: options.reason ?? "cancelled" }) };
      } catch (error) {
        compensation = { status: "failed", error: String(error?.message ?? error) };
        record = { ...record, metadata: { ...record.metadata, compensation: compensation.status } };
        const failure = new Error("resumable run compensation failed", { cause: error });
        failure.code = "COMPENSATION_FAILED";
        throw failure;
      }
    }
    record = { ...record, metadata: { ...record.metadata, compensation: compensation.status } };
    return { ...record, response, compensation };
  }
  function get() { return runrecord(record); }
  return { submit, resume, cancel, get };
}
