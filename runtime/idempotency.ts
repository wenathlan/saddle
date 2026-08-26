/**
 * idempotency keys prevent duplicate delivery from at least once transports.
 */
export function idempotency() {
  const results = new Map();
  return {
    has(key) { return results.has(key); },
    get(key) { return results.get(key); },
    set(key, value) { results.set(key, value); return value; },
    delete(key) { results.delete(key); }
  };
}
