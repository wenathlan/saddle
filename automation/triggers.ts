/**
 * workflow triggers normalize manual, event, schedule and retry starts without binding a forge.
 */

export const triggernames = Object.freeze(["manual", "dispatch", "webhook", "schedule", "retry", "heartbeat"]);

/** Validates and normalizes a trigger declaration. */
export function workflowtriggers(value = ["manual"]) {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.some((name) => !triggernames.includes(name))) throw new TypeError("workflow trigger is unsupported");
  return [...new Set(list)];
}

/** Matches a workflow trigger against an incoming event without executing it. */
export function triggermatch(manifest, event = {}) {
  const triggers = workflowtriggers(manifest?.trigger);
  const type = String(event.type ?? "manual");
  if (!triggers.includes(type)) return { matched: false, type, reason: "trigger-not-declared" };
  if (type === "schedule" && event.at !== undefined && Number(event.at) > Date.now()) return { matched: false, type, reason: "not-due" };
  const validation = validateworkflowinputs(manifest, event.inputs ?? {});
  if (!validation.valid) return { matched: false, type, reason: "invalid-inputs", errors: validation.errors };
  return { matched: true, type, inputs: validation.values, requestid: event.requestid ?? `${manifest.name}/${type}/${stablevalue(event)}` };
}

/** Validates and normalizes caller-supplied workflow inputs against a manifest schema. */
export function validateworkflowinputs(manifest, values = {}) {
  const schema = manifest?.inputs ?? {};
  const source = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  const errors = [];
  const normalized = {};
  for (const name of Object.keys(source)) if (!Object.hasOwn(schema, name)) errors.push({ name, reason: "unknown-input" });
  for (const [name, declaration] of Object.entries(schema)) {
    const rule = typeof declaration === "string" ? { type: declaration } : declaration ?? {};
    let value = source[name];
    if (value === undefined && rule.default !== undefined) value = rule.default;
    if (value === undefined) {
      if (rule.required) errors.push({ name, reason: "required" });
      continue;
    }
    const converted = convertinput(value, rule.type ?? "string");
    if (converted.error) { errors.push({ name, reason: converted.error }); continue; }
    if (Array.isArray(rule.choices) && !rule.choices.includes(converted.value)) { errors.push({ name, reason: "choice" }); continue; }
    normalized[name] = converted.value;
  }
  return { valid: errors.length === 0, values: normalized, errors };
}

/** Keeps trigger declarations and produces deterministic matching results. */
export function triggerregistry() {
  const values = new Map();
  function register(manifest) { if (!manifest?.name) throw new TypeError("trigger manifest requires name"); const normalized = { ...manifest, trigger: workflowtriggers(manifest.trigger) }; values.set(normalized.name, normalized); return normalized; }
  function get(name) { return values.get(name); }
  function match(name, event) { const manifest = get(name); if (!manifest) throw new Error(`workflow not found: ${name}`); return triggermatch(manifest, event); }
  function list() { return [...values.values()].map((manifest) => ({ ...manifest, trigger: [...manifest.trigger] })); }
  return { register, get, match, list };
}

function convertinput(value, type) {
  if (type === "string") return { value: String(value) };
  if (type === "number") { const number = typeof value === "number" ? value : Number(value); return Number.isFinite(number) ? { value: number } : { error: "number" }; }
  if (type === "boolean") { if (value === true || value === "true") return { value: true }; if (value === false || value === "false") return { value: false }; return { error: "boolean" }; }
  if (type === "json") { try { return { value: typeof value === "string" ? JSON.parse(value) : value }; } catch { return { error: "json" }; } }
  return { error: "type" };
}

function stablevalue(value) {
  if (Array.isArray(value)) return `[${value.map(stablevalue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stablevalue(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
