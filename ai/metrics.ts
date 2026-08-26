/**
 * metrics keeps low-cardinality counters and durations without requiring a telemetry vendor.
 */

/** Creates an in-memory metric collector with bounded names and labels. */
export function metricstore(options = {}) {
  const maxnames = Number(options.maxnames ?? 256);
  const values = new Map();
  const durations = new Map();
  function key(name, labels = {}) { const sorted = Object.entries(labels).slice(0, 8).sort(([left], [right]) => left.localeCompare(right)); return `${String(name)}|${JSON.stringify(sorted)}`; }
  function count(name, amount = 1, labels = {}) { if (values.size >= maxnames && !values.has(key(name, labels))) throw new Error("metric cardinality limit reached"); const metric = key(name, labels); values.set(metric, (values.get(metric) ?? 0) + Number(amount)); return values.get(metric); }
  function observe(name, milliseconds, labels = {}) { const metric = key(name, labels); const list = durations.get(metric) ?? []; if (list.length < 1000) list.push(Number(milliseconds)); durations.set(metric, list); return Number(milliseconds); }
  function snapshot() { return { counters: Object.fromEntries(values), durations: Object.fromEntries([...durations].map(([name, list]) => [name, { count: list.length, total: list.reduce((sum, value) => sum + value, 0), max: Math.max(0, ...list) }])) }; }
  function reset() { values.clear(); durations.clear(); }
  return { count, observe, snapshot, reset };
}
