/**
 * app registry keeps installation, scope and revocation state outside platform credentials.
 */

export const appstatuses = Object.freeze(["installed", "suspended", "revoked"]);

/** Creates a caller-owned app installation registry with explicit scopes. */
export function appregistry(options = {}) {
  const values = new Map(options.apps ? options.apps.map((app) => [app.id, normalize(app)]) : []);
  function install(input = {}) { if (!input.id || !input.name) throw new TypeError("app installation requires id and name"); const app = normalize({ ...input, status: "installed", installedat: input.installedat ?? Date.now() }); values.set(app.id, app); return { ...app, scopes: [...app.scopes] }; }
  function suspend(id) { return transition(id, "suspended"); }
  function revoke(id) { return transition(id, "revoked"); }
  function restore(id) { return transition(id, "installed"); }
  function authorize(id, required = []) { const app = requireapp(id); if (app.status !== "installed") return { allowed: false, reason: `app-${app.status}` }; const missing = required.filter((scope) => !app.scopes.includes(scope)); return { allowed: missing.length === 0, missing, appid: app.id }; }
  function get(id) { const app = values.get(String(id)); return app ? { ...app, scopes: [...app.scopes] } : null; }
  function list() { return [...values.values()].map((app) => ({ ...app, scopes: [...app.scopes] })); }
  return { install, suspend, revoke, restore, authorize, get, list };
  function requireapp(id) { const app = values.get(String(id)); if (!app) throw new Error(`app not found: ${id}`); return app; }
  function transition(id, status) { const app = requireapp(id); if (!appstatuses.includes(status)) throw new TypeError(`unsupported app status: ${status}`); app.status = status; app.updatedat = Date.now(); return get(id); }
}

function normalize(input) { return { id: String(input.id), name: String(input.name), status: input.status ?? "installed", scopes: [...new Set((input.scopes ?? []).map(String))], installedat: Number(input.installedat ?? Date.now()), updatedat: Number(input.updatedat ?? Date.now()), metadata: { ...(input.metadata ?? {}) } }; }
