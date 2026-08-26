/**
 * operations describe bounded telemetry, retention, recovery and threat boundaries without selecting storage or telemetry vendors.
 */

export const operationmetrics = Object.freeze(["latency", "retries", "queuedepth", "runnerselection", "storagebytes", "failures"]);

/** Binds the standard operational metric names to an injected metric collector. */
export function operationsmetrics(options = {}) {
  const collector = options.collector;
  if (!collector || typeof collector.count !== "function" || typeof collector.observe !== "function" || typeof collector.snapshot !== "function") throw new TypeError("operations metrics requires a collector");
  function record(name, value = 1, labels = {}) {
    if (!operationmetrics.includes(name)) throw new TypeError(`unsupported operation metric: ${name}`);
    return name === "latency" ? collector.observe(name, value, labels) : collector.count(name, value, labels);
  }
  return { names: [...operationmetrics], record, snapshot: () => collector.snapshot() };
}

/** Creates a deterministic retention policy for caller-owned records. */
export function retentionpolicy(options = {}) {
  const days = Number(options.days ?? 30);
  const maxbytes = Number(options.maxbytes ?? Number.POSITIVE_INFINITY);
  if (!Number.isFinite(days) || days < 0 || !Number.isFinite(maxbytes) || maxbytes < 0) throw new TypeError("retention policy limits are invalid");
  return { days, maxbytes, cutoff(now = Date.now()) { return Number(now) - days * 86400000; }, keeps(record, now = Date.now()) { return Number(record?.updatedat ?? record?.createdat ?? 0) >= this.cutoff(now) && Number(record?.bytes ?? 0) <= maxbytes; } };
}

/** Defines caller-owned backup and restore functions with explicit capability errors. */
export function backupplan(options = {}) {
  const backup = options.backup;
  const restore = options.restore;
  return { version: 1, backup: async (input) => execute(backup, input, "backup"), restore: async (input) => execute(restore, input, "restore") };
}

/** Records the security boundary and prevents the core from claiming threat coverage it does not own. */
export function threatmodel(options = {}) {
  const boundaries = [...new Set((options.boundaries ?? ["credentials", "network", "permissions", "persistence"]).map(String))];
  if (!boundaries.length) throw new TypeError("threat model requires boundaries");
  return { version: 1, boundaries, owner: options.owner ?? "caller", controls: [...new Set((options.controls ?? []).map(String))], disclaimer: "The caller remains responsible for deployment, credentials, service terms and abuse response." };
}

async function execute(handler, input, name) {
  if (typeof handler !== "function") { const error = new Error(`${name} handler is not configured`); error.code = "UNSUPPORTED_OPERATION"; throw error; }
  try { return await handler(input); } catch (error) { const failure = new Error(`${name} failed: ${error?.message ?? error}`, { cause: error }); failure.code = String(error?.code ?? "OPERATION_FAILED"); throw failure; }
}
