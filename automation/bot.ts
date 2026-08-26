/**
 * saddlebot unifies commands without owning a platform credential or scheduler.
 */
import { parsecommand } from "./commands.js";

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
