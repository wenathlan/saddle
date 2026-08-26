/**
 * webhook delivery tracks attempts and dead letters without choosing a queue vendor.
 */

/** Creates a sequential delivery queue with retryable failure handling. */
export function deliveryqueue(options = {}) {
  const maxattempts = Number(options.maxattempts ?? 3);
  const records = new Map();
  const dead = [];
  async function deliver(input = {}, handler) {
    if (typeof handler !== "function") throw new TypeError("delivery handler must be a function");
    const id = String(input.id ?? `delivery${Date.now().toString(36)}${records.size}`);
    const record = { id, status: "pending", attempts: 0, createdat: Date.now(), event: input.event, metadata: { ...(input.metadata ?? {}) } };
    records.set(id, record);
    while (record.attempts < maxattempts) {
      record.attempts += 1;
      try { record.result = await handler(input.event, input); record.status = "delivered"; record.updatedat = Date.now(); return { ...record }; }
      catch (error) { record.error = { code: String(error.code ?? "DELIVERY_FAILED"), message: String(error.message ?? error), retryable: Boolean(error.retryable) }; if (!error.retryable) break; }
    }
    record.status = "dead";
    dead.push({ ...record });
    record.updatedat = Date.now();
    return { ...record };
  }
  return { deliver, get(id) { return records.get(String(id)); }, list() { return [...records.values()].map((record) => ({ ...record })); }, deadletters() { return dead.map((record) => ({ ...record })); } };
}
