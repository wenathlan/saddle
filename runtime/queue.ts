/**
 * job queue groups concurrency retry timeout and idempotency at one boundary.
 */
import { idempotency } from "./idempotency.js";

export function jobqueue(options = {}) {
  const limit = options.concurrency ?? 1;
  const attempts = options.maxattempts ?? 3;
  const retryall = options.retryall ?? false;
  const keys = options.idempotency ?? idempotency();
  const pending = [];
  let active = 0;
  let sequence = 0;
  async function drain() {
    while (active < limit && pending.length) {
      const item = pending.shift();
      active += 1;
      execute(item).then(item.resolve, item.reject).finally(() => { active -= 1; void drain(); });
    }
  }
  async function execute(item) {
    if (item.key && keys.has(item.key)) return keys.get(item.key);
    let last;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await item.handler({ id: item.id, payload: item.payload, attempt });
        if (item.key) keys.set(item.key, result);
        return result;
      } catch (error) {
        last = error;
        const retryable = retryall || error?.retryable === true || error?.code === "RUNNER_UNAVAILABLE";
        if (!retryable || attempt === attempts) throw error;
        await delay((options.backoff ?? 250) * 2 ** (attempt - 1));
      }
    }
    throw last;
  }
  return {
    add(payload, handler, options = {}) {
      if (typeof handler !== "function") return Promise.reject(new TypeError("queue handler is required"));
      const id = options.id ?? `queuejob${sequence++}`;
      return new Promise((resolve, reject) => { pending.push({ id, payload, handler, key: options.key, resolve, reject }); void drain(); });
    },
    size() { return pending.length; },
    active() { return active; },
    async idle() { while (pending.length || active) await delay(10); }
  };
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
