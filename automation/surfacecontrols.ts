/**
 * control surfaces provide an operator contract for jobs, sessions, storage, runners, permissions, logs and artifacts.
 */

export const controlresources = Object.freeze(["jobs", "sessions", "storage", "runners", "permissions", "logs", "artifacts"]);
export const controloperations = Object.freeze(["list", "get", "create", "update", "cancel", "retry", "delete", "check"]);

/** Creates a caller-owned operator surface with resource handlers and optional audit recording. */
export function controlsurface(options = {}) {
  const adapters = { ...(options.adapters ?? {}) };
  const audit = options.audit;
  if (audit !== undefined && typeof audit !== "function") throw new TypeError("control audit must be callable");
  for (const resource of Object.keys(adapters)) if (!controlresources.includes(resource) || !adapters[resource] || typeof adapters[resource] !== "object") throw new TypeError(`unsupported control resource: ${resource}`);

  async function execute(request = {}) {
    const resource = String(request.resource ?? "");
    const operation = String(request.operation ?? "");
    if (!controlresources.includes(resource) || !controloperations.includes(operation)) throw new TypeError("control request is invalid");
    const handler = adapters[resource]?.[operation];
    const context = { requestid: String(request.requestid ?? `control${Date.now().toString(36)}`), resource, operation };
    if (typeof handler !== "function") return respond({ ok: false, code: "UNSUPPORTED_CONTROL", message: `${resource}.${operation} is not configured`, context, audit });
    try {
      const result = await handler(request.input ?? {}, context);
      return respond({ ok: true, result, context, audit });
    } catch (error) {
      return respond({ ok: false, code: String(error?.code ?? "CONTROL_FAILED"), message: String(error?.message ?? error), context, audit });
    }
  }

  return { version: 1, resources: [...controlresources], operations: [...controloperations], execute, describe: () => ({ version: 1, resources: [...controlresources], configured: Object.keys(adapters).filter((resource) => controlresources.includes(resource)) }) };
}

async function respond({ ok, result, code, message, context, audit }) {
  const response = { version: 1, ok, ...context, ...(ok ? { result } : { code, message }) };
  if (audit) try { await audit(response); } catch (error) { response.auditerror = String(error?.message ?? error); }
  return response;
}
