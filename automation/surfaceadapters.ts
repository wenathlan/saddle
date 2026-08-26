/**
 * surface adapters define caller-owned desktop and mobile operations without selecting a vendor runtime.
 */

const profiles = Object.freeze({
  desktop: { capabilities: ["window", "file", "notification"], formats: ["appimage", "dmg", "msi"] },
  mobile: { capabilities: ["screen", "storage", "network"], formats: ["apk", "ipa"] }
});

/** Creates a transport-neutral adapter contract for a desktop or mobile surface. */
export function surfaceadapter(options = {}) {
  const target = String(options.target ?? "");
  const profile = profiles[target];
  if (!profile) throw new TypeError(`unsupported surface adapter: ${target}`);
  const operations = [...new Set(options.operations ?? ["open", "close", "invoke", "status"])]
    .map((operation) => String(operation));
  if (!operations.length || operations.some((operation) => !/^[a-z][a-z0-9]*$/.test(operation))) throw new TypeError("surface adapter operations are invalid");
  const handlers = { ...(options.handlers ?? {}) };
  for (const [operation, handler] of Object.entries(handlers)) if (typeof handler !== "function") throw new TypeError(`surface handler is not callable: ${operation}`);

  async function invoke(operation, input, context = {}) {
    const name = String(operation ?? "");
    if (!operations.includes(name)) throw new TypeError(`unsupported surface operation: ${name}`);
    const handler = handlers[name];
    if (!handler) return { target, operation: name, supported: false, result: undefined };
    try {
      return { target, operation: name, supported: true, result: await handler(input, context) };
    } catch (error) {
      return { target, operation: name, supported: true, ok: false, code: String(error?.code ?? "SURFACE_OPERATION_FAILED"), message: String(error?.message ?? error) };
    }
  }

  return {
    target,
    version: 1,
    capabilities: [...(options.capabilities ?? profile.capabilities)],
    formats: [...(options.formats ?? profile.formats)],
    operations,
    invoke,
    status: () => ({ target, ready: true, operations: [...operations], capabilities: [...(options.capabilities ?? profile.capabilities)] })
  };
}

/** Creates a desktop adapter contract with caller-owned handlers. */
export function desktopadapter(options = {}) { return surfaceadapter({ ...options, target: "desktop" }); }

/** Creates a mobile adapter contract with caller-owned handlers. */
export function mobileadapter(options = {}) { return surfaceadapter({ ...options, target: "mobile" }); }
