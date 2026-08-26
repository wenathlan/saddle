/**
 * proxy pool chooses healthy least used entries and never rotates blindly.
 */
export function proxypool(options = {}) {
  const entries = (options.proxies ?? []).map((proxy) => ({ ...proxy, failures: 0, uses: 0, status: "active", lastused: 0 }));
  const threshold = options.failurethreshold ?? 3;
  const recovery = options.recoverytime ?? 300000;
  function revive() { const now = Date.now(); for (const entry of entries) if (entry.status === "graveyard" && now - entry.failedat >= recovery) { entry.status = "active"; entry.failures = 0; } }
  function choose() { revive(); const available = entries.filter((entry) => entry.status === "active"); if (!available.length) throw new Error("proxy pool has no healthy entries"); const selected = [...available].sort((left, right) => left.uses - right.uses || left.lastused - right.lastused)[0]; selected.uses += 1; selected.lastused = Date.now(); return { ...selected }; }
  function report(id, result = {}) { const entry = entries.find((value) => value.id === id); if (!entry) return null; if (result.ok) { entry.failures = 0; entry.status = "active"; } else { entry.failures += 1; entry.status = entry.failures >= threshold ? "graveyard" : "active"; entry.failedat = Date.now(); } return { ...entry }; }
  return { choose, report, list() { revive(); return entries.map((entry) => ({ ...entry })); } };
}
