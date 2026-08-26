/**
 * workflow dispatch keeps remote execution explicit and records a stable request identity.
 */
import { idempotency } from "./idempotency.js";

export function workflowdispatch(adapter, options = {}) {
  if (typeof adapter?.dispatch !== "function") throw new TypeError("workflow adapter requires dispatch");
  const records = options.records ?? idempotency();
  return {
    async submit(spec) {
      if (!spec?.owner || !spec.repository || !spec.workflow || !spec.ref) throw new TypeError("workflow owner repository workflow and ref are required");
      const requestid = spec.requestid ?? `${spec.owner}/${spec.repository}/${spec.workflow}/${spec.ref}/${JSON.stringify(spec.inputs ?? {})}`;
      if (records.has(requestid)) return records.get(requestid);
      const response = await adapter.dispatch(spec.owner, spec.repository, spec.workflow, { ref: spec.ref, inputs: spec.inputs ?? {} });
      const record = { requestid, ...spec, response, submittedat: Date.now() };
      records.set(requestid, record);
      return record;
    },
    get(requestid) { return records.get(requestid); }
  };
}

export async function waitforrun(adapter, owner, repository, runid, options = {}) {
  if (typeof adapter?.run !== "function") throw new TypeError("workflow adapter requires run");
  const attempts = options.attempts ?? 20;
  const interval = options.interval ?? 3000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const run = await adapter.run(owner, repository, runid);
    if (["completed", "failure", "cancelled", "success"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`workflow run ${runid} did not finish within configured attempts`);
}
