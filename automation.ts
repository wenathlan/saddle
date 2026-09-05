/**
 * automation.ts — workflow, bot and surface automation contracts.
 *
 * This file is the v2.0.0 grand-merge consolidation of the former nested
 * folders of the repository (automation) into the single
 * root-level domain file of the e2ugh family standard: one optimized
 * TypeScript file per correlated domain, ordinal sections, JSDoc on every
 * block, intra-domain imports dissolved, cross-domain imports rewritten to
 * ./<domain>.js. Every capability of every source file is preserved here;
 * the pure re-export barrels (none in this domain) folded their surface into this file directly.
 */



/* ════════════════════════════════════════════════════════════════════ */
/* Section 1: automation/triggers.ts — workflow triggers normalize manual, event, schedule and retry starts without binding a forge. */
/* ════════════════════════════════════════════════════════════════════ */
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

/* ════════════════════════════════════════════════════════════════════ */
/* Section 2: automation/permissions.ts — command permissions keep bot actions explicit and platform neutral. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * command permissions keep bot actions explicit and platform neutral.
 */

/** Creates a command guard from caller supplied command and scope policies. */
export function commandguard(options = {}) {
  const policies = options.policies ?? {};
  function check(input = {}) {
    const command = String(input.command ?? "");
    const policy = policies[command] ?? { scopes: [] };
    const scopes = input.scopes ?? [];
    const missing = (policy.scopes ?? []).filter((scope) => !scopes.includes(scope));
    return { allowed: missing.length === 0, command, missing, platform: input.platform };
  }
  return { check };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 3: automation/commands.ts — command parsing keeps the bot surface serializable and platform neutral. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * command parsing keeps the bot surface serializable and platform neutral.
 */
export function parsecommand(input) {
  const tokens = tokenize(String(input ?? ""));
  const command = tokens.shift() ?? "help";
  const flags = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).toLowerCase();
    const value = tokens[index + 1]?.startsWith("--") ? true : tokens[++index] ?? true;
    flags[key] = value;
  }
  return { command: command.toLowerCase(), flags };
}

function tokenize(input) { return input.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((value) => value.replace(/^"|"$/g, "")) ?? []; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 4: automation/adapter.ts — platform adapters expose only the operations a bot needs. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * platform adapters expose only the operations a bot needs.
 */
export function platformadapter(methods) {
  const required = ["authenticate", "listrepos", "createwebhook", "executebot"];
  for (const name of required) if (typeof methods?.[name] !== "function") throw new TypeError(`platform adapter requires ${name}`);
  return methods;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 5: automation/workflowmanifest.ts — workflow manifests describe the same job surface for different forge runtimes. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * workflow manifests describe the same job surface for different forge runtimes.
 */
export const forgeprofiles = Object.freeze(["github", "forgejo", "gitea", "woodpecker", "gitlab"]);

export function workflowmanifest(options = {}) {
  if (!options.name || !options.command) throw new TypeError("workflow manifest requires name and command");
  return {
    name: options.name,
    command: options.command,
    trigger: options.trigger ?? ["manual", "dispatch"],
    inputs: options.inputs ?? {},
    platforms: options.platforms ?? forgeprofiles,
    environment: options.environment ?? {},
    artifacts: options.artifacts ?? ["results/**"],
    timeoutminutes: options.timeoutminutes ?? 30,
    publicrunner: options.publicrunner ?? true
  };
}

export function workflowinputs(manifest) { return { name: manifest.name, command: manifest.command, timeoutminutes: manifest.timeoutminutes, artifacts: manifest.artifacts.join(",") }; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 6: automation/workflowtemplates.ts — workflow templates use explicit environment names and keep provider secrets external. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * workflow templates use explicit environment names and keep provider secrets external.
 */

export function githubworkflow(manifest) {
  const input = workflowinputs(manifest);
  return `name: ${manifest.name}\non:\n  workflow_dispatch:\n    inputs:\n      jobid:\n        required: true\n        type: string\n      command:\n        required: true\n        type: string\n        default: ${manifest.command}\n  repository_dispatch:\n    types: [saddle-job]\npermissions:\n  contents: read\njobs:\n  process:\n    runs-on: ubuntu-latest\n    timeout-minutes: ${input.timeoutminutes}\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 26.7.0\n      - run: npm ci\n      - run: \${{ github.event.inputs.command || '${manifest.command}' }}\n        env:\n          SBOT_JOB_ID: \${{ github.event.inputs.jobid || github.event.client_payload.jobid }}\n      - uses: actions/upload-artifact@v4\n        with:\n          name: saddle-results\n          path: ${manifest.artifacts.join("\n            ")}\n          if-no-files-found: ignore\n`;
}

export function forgejoworkflow(manifest) { return genericworkflow(manifest, "forgejo"); }
export function giteaworkflow(manifest) { return genericworkflow(manifest, "gitea"); }
export function woodpeckerworkflow(manifest) { return `when:\n  - event: push\n  - event: manual\nsteps:\n  process:\n    image: node:26.7.0\n    commands:\n      - npm ci\n      - ${manifest.command}\n`;
}
export function gitlabworkflow(manifest) { return `stages:\n  - process\nprocess:\n  stage: process\n  image: node:26.7.0\n  script:\n    - npm ci\n    - ${manifest.command}\n  artifacts:\n    when: always\n    paths:\n${manifest.artifacts.map((item) => `      - ${item}`).join("\n")}\n`; }

function genericworkflow(manifest, name) { return `name: ${manifest.name}\non:\n  workflow_dispatch:\njobs:\n  process:\n    runs-on: ubuntu-latest\n    timeout-minutes: ${manifest.timeoutminutes}\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 26.7.0\n      - run: npm ci\n      - run: ${manifest.command}\n`;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 7: automation/workflowregistry.ts — workflow registry stores generated manifests and templates for later dispatch. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * workflow registry stores generated manifests and templates for later dispatch.
 */

export function workflowregistry() {
  const manifests = new Map();
  const renderers = { github: githubworkflow, forgejo: forgejoworkflow, gitea: giteaworkflow, woodpecker: woodpeckerworkflow, gitlab: gitlabworkflow };
  return {
    register(manifest) { manifests.set(manifest.name, manifest); return manifest; },
    get(name) { return manifests.get(name) ?? null; },
    render(name, forge) { if (!renderers[forge] || !forgeprofiles.includes(forge)) throw new TypeError(`unsupported forge: ${forge}`); const manifest = manifests.get(name); if (!manifest) throw new Error(`workflow not found: ${name}`); return renderers[forge](manifest); },
    list() { return [...manifests.values()]; }
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 8: automation/bot.ts — saddlebot unifies commands without owning a platform credential or scheduler. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * saddlebot unifies commands without owning a platform credential or scheduler.
 */

export function saddlebot(options = {}) {
  const adapters = new Map(Object.entries(options.adapters ?? {}));
  const tasks = new Map();
  const guard = options.guard;
  const keys = new Map();
  const state = { status: "stopped", startedat: undefined, commands: 0 };
  const timers = new Set();
  async function executecommand(input, context = {}) {
    const parsed = typeof input === "string" ? parsecommand(input) : input;
    state.commands += 1;
    if (parsed.command === "status") return getstatus();
    if (parsed.command === "help") return { commands: ["capture", "scrape", "review", "deploy", "memory", "test", "release", "webhook", "schedule", "publish", "artifact", "status"] };
    const platform = parsed.flags.platform ?? context.platform;
    const adapter = adapters.get(platform);
    if (!adapter) throw new Error(`no adapter registered for ${platform ?? "command"}`);
    const permission = guard?.check({ command: parsed.command, platform, scopes: context.scopes ?? [] });
    if (permission && !permission.allowed) { const error = new Error(`bot command is not authorized: ${parsed.command}`); error.code = "BOT_COMMAND_UNAUTHORIZED"; error.missing = permission.missing; throw error; }
    const key = context.idempotencykey;
    if (key && keys.has(key)) return keys.get(key);
    const result = await adapter.executebot({ command: parsed.command, flags: parsed.flags, context });
    if (key) keys.set(key, result);
    return result;
  }
  function getstatus() { return { ...state, adapters: [...adapters.keys()], tasks: [...tasks.keys()] }; }
  return {
    register(name, adapter) { adapters.set(name, adapter); return this; },
    async start() { state.status = "running"; state.startedat = Date.now(); return getstatus(); },
    async stop() { for (const timer of timers) clearTimeout(timer); timers.clear(); state.status = "stopped"; return getstatus(); },
    executecommand,
    async handlewebhook(platform, event) { const adapter = adapters.get(platform); if (!adapter) throw new Error(`no adapter registered for ${platform}`); return adapter.executebot({ command: "webhook", event }); },
    scheduletask(name, task, delay) { if (typeof task !== "function" || !Number.isFinite(delay)) throw new TypeError("schedule requires task and delay"); const timer = setTimeout(async () => { tasks.delete(name); await task(); }, delay); timers.add(timer); tasks.set(name, { name, delay, scheduledat: Date.now() }); return tasks.get(name); },
    getstatus
  };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 9: automation/n8n.ts — n8n node metadata keeps workflow automation as a packaging surface. */
/* ════════════════════════════════════════════════════════════════════ */
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

/* ════════════════════════════════════════════════════════════════════ */
/* Section 10: automation/surfacemanifest.ts — surface manifests describe repackaging targets without adding target code to the engine. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * surface manifests describe repackaging targets without adding target code to the engine.
 */
export const surfaces = Object.freeze(["application", "computer", "browser", "extension", "desktop", "mobile", "cli", "binary", "web", "internet", "libreoffice", "mcp", "vsix", "container", "n8n", "library"]);

export const surfaceformats = Object.freeze({
  library: Object.freeze(["npm", "github", "maven", "nuget", "rubygems", "oci", "tarball"]),
  application: Object.freeze(["zip", "tarball"]),
  computer: Object.freeze(["node", "bun", "deno", "singlefile"]),
  desktop: Object.freeze(["appimage", "deb", "rpm", "snap", "flatpak", "dmg", "pkg", "exe", "msi", "msix"]),
  mobile: Object.freeze(["apk", "aab", "ipa"]),
  browser: Object.freeze(["html", "pwa", "wasm"]),
  extension: Object.freeze(["crx", "xpi", "safariextz"]),
  cli: Object.freeze(["node", "bun", "deno", "singlefile", "exe", "deb", "rpm"]),
  binary: Object.freeze(["sea", "singlefile", "wasm"]),
  web: Object.freeze(["html", "pwa", "ssg", "ssr", "wasm"]),
  internet: Object.freeze(["http", "websocket", "grpc", "rest"]),
  libreoffice: Object.freeze(["oxt", "zip"]),
  mcp: Object.freeze(["stdio", "jsonrpc"]),
  vsix: Object.freeze(["vsix"]),
  container: Object.freeze(["oci", "docker"]),
  n8n: Object.freeze(["node", "json"])
});

export function surfacemanifest(options = {}) {
  const target = options.target ?? "library";
  if (!surfaces.includes(target)) throw new TypeError(`unsupported surface: ${target}`);
  return { target, name: options.name ?? "saddle", entry: options.entry ?? "dist/index.js", runtime: options.runtime ?? "caller", formats: [...(options.formats ?? surfaceformats[target] ?? [])], permissions: options.permissions ?? [], capabilities: options.capabilities ?? ["memory", "scrape", "workflow"], metadata: options.metadata ?? {} };
}

/** Creates a desktop surface manifest with caller-selected packaging formats. */
export function desktopmanifest(options = {}) { return surfacemanifest({ ...options, target: "desktop", formats: options.formats ?? surfaceformats.desktop }); }

/** Creates a mobile surface manifest with caller-selected packaging formats. */
export function mobilemanifest(options = {}) { return surfacemanifest({ ...options, target: "mobile", formats: options.formats ?? surfaceformats.mobile }); }

/** Creates a caller-owned target manifest for any supported surface. */
export function applicationmanifest(options = {}) { return surfacemanifest({ ...options, target: options.target ?? "application" }); }

/** Describes installation without performing a package or platform mutation. */
export function surfacebundle(manifest) {
  if (!manifest?.target || !surfaces.includes(manifest.target)) throw new TypeError("surface bundle requires a valid manifest");
  const install = { n8n: "n8n import", browser: "import by url", extension: "load unpacked", desktop: "caller desktop bundle", mobile: "caller mobile bundle" }[manifest.target] ?? "npm install";
  return { ...manifest, files: [...new Set([manifest.entry, ...(manifest.files ?? [])])], install };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 11: automation/surfaceadapters.ts — surface adapters define caller-owned desktop and mobile operations without selecting a vendor runtime. */
/* ════════════════════════════════════════════════════════════════════ */
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

/* ════════════════════════════════════════════════════════════════════ */
/* Section 12: automation/surfacecontrols.ts — control surfaces provide an operator contract for jobs, sessions, storage, runners, permissions, logs and artifacts. */
/* ════════════════════════════════════════════════════════════════════ */
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

/* ════════════════════════════════════════════════════════════════════ */
/* Section 13: automation/surfaceoperations.ts — operations describe bounded telemetry, retention, recovery and threat boundaries without selecting storage or telemetry vendors. */
/* ════════════════════════════════════════════════════════════════════ */
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

/* ════════════════════════════════════════════════════════════════════ */
/* Section 14: automation/surfacerequirements.ts — application surface requirements describe Mini App, DNS, and bridge needs without owning credentials or infrastructure. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * application surface requirements describe Mini App, DNS, and bridge needs without owning credentials or infrastructure.
 */

/** Creates a Mini App plan that requires caller-owned origin and validation. */
export function miniappplan(input = {}) {
  if ("token" in input || "bottoken" in input || "secret" in input) throw new TypeError("Mini App credentials must not be supplied to the library plan");
  const origin = publichttps(input.origin, "Mini App origin");
  const validation = nonempty(input.validation, "Mini App validation");
  return Object.freeze({ version: 1, origin, validation, capabilities: Object.freeze(unique(input.capabilities ?? [])), state: "caller-validates", provider: String(input.provider ?? "telegram") });
}

/** Creates a DNS and HTTPS requirement record without a registrar or DNS operation. */
export function dnsplan(input = {}) {
  const hostname = hostnamevalue(input.hostname);
  const dnssec = input.dnssec === true;
  const https = input.https === true;
  return Object.freeze({ version: 1, hostname, dnssec, https, owner: nonempty(input.owner, "DNS owner"), state: "caller-configures", operations: Object.freeze(["record", "certificate", ...(dnssec ? ["dnssec"] : [])]) });
}

/** Maps declared application surfaces without selecting a runtime vendor. */
export function applicationbridge(input = {}) {
  if (!Array.isArray(input.surfaces) || input.surfaces.length === 0) throw new TypeError("application bridge surfaces are required");
  const ids = new Set();
  const surfaces = input.surfaces.map((value) => {
    const id = nonempty(value?.id, "application bridge surface id");
    if (ids.has(id)) throw new TypeError(`application bridge surface id is duplicated: ${id}`);
    ids.add(id);
    const target = String(value.target ?? "");
    if (!targets.has(target)) throw new TypeError(`application bridge target is invalid: ${target}`);
    return Object.freeze({ id, target, capabilities: Object.freeze(unique(value.capabilities ?? [])) });
  });
  return Object.freeze({ version: 1, surfaces: Object.freeze(surfaces), state: "caller-connects" });
}

const targets = new Set(["browser", "desktop", "mobile", "extension", "miniapp"]);
function publichttps(value, name) { const output = String(value ?? ""); let url; try { url = new URL(output); } catch { throw new TypeError(`${name} is invalid`); } if (url.protocol !== "https:" || !url.hostname) throw new TypeError(`${name} must use HTTPS`); return url.toString(); }
function hostnamevalue(value) { const output = String(value ?? "").toLowerCase(); if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(output)) throw new TypeError("DNS hostname is invalid"); return output; }
function nonempty(value, name) { const output = String(value ?? ""); if (!output) throw new TypeError(`${name} is required`); return output; }
function unique(values) { if (!Array.isArray(values)) throw new TypeError("surface capabilities must be an array"); return [...new Set(values.map((value) => nonempty(value, "surface capability")))].sort(); }
