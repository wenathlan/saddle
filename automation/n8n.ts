/**
 * n8n node metadata keeps workflow automation as a packaging surface.
 */
export function n8nnode(options = {}) {
  const triggers = normalize(options.triggers ?? n8ntriggers);
  const actions = normalize(options.actions ?? n8nactions);
  return { name: options.name ?? "saddle", displayname: options.displayname ?? "Saddle", description: options.description ?? "Saddle engine operation", version: 1, inputs: options.inputs ?? ["main"], outputs: options.outputs ?? ["main"], triggers, actions, properties: options.properties ?? [{ displayname: "trigger", name: "trigger", type: "options", options: triggers.map((value) => ({ name: value, value })) }, { displayname: "command", name: "command", type: "options", options: actions.map((value) => ({ name: value, value })), default: "status" }] };
}

export const n8ntriggers = Object.freeze(["manual", "dispatch", "webhook", "schedule", "retry", "heartbeat"]);
export const n8nactions = Object.freeze(["status", "scrape", "crawl", "extract", "batch", "browser", "memory", "sync"]);

/** Matches an incoming event against the trigger declarations of a node. */
export function n8nmatch(node, event = {}) { const type = String(event.type ?? "manual"); return { matched: Boolean(node?.triggers?.includes(type)), type, requestid: event.requestid ?? `${node?.name ?? "saddle"}/${type}` }; }

/** Executes a declared n8n action through a caller-owned handler. */
export async function n8nexecute(node, input, handler) {
  if (typeof handler !== "function") throw new TypeError("n8n handler is required");
  const action = String(input?.action ?? input?.command ?? "status");
  if (!node?.actions?.includes(action)) throw new TypeError(`unsupported n8n action: ${action}`);
  try { return await handler({ node, input: { ...(input ?? {}), action } }); } catch (error) { const failure = new Error(`n8n action failed: ${error?.message ?? error}`, { cause: error }); failure.code = String(error?.code ?? "N8N_ACTION_FAILED"); throw failure; }
}

function normalize(values) { const list = Array.isArray(values) ? values : [values]; if (!list.length || list.some((value) => typeof value !== "string" || !value)) throw new TypeError("n8n declarations are invalid"); return [...new Set(list)]; }
