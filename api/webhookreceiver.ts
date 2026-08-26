/**
 * webhook receiver validates signatures before dispatch and drops duplicate delivery ids.
 */
import { webhookverify } from "./webhooksignature.js";

export function webhookreceiver(options = {}) {
  if (typeof options.secret !== "string" || typeof options.handle !== "function") throw new TypeError("webhook receiver requires secret and handler");
  const deliveries = new Set();
  return {
    async receive(input = {}) {
      if (!webhookverify(input.body, input.signature, options.secret)) return { accepted: false, status: 401, reason: "invalid signature" };
      const id = input.deliveryid ?? input.eventid;
      if (id && deliveries.has(id)) return { accepted: false, status: 200, duplicate: true };
      if (id) deliveries.add(id);
      const result = await options.handle(input.event, input.body);
      return { accepted: true, status: 202, deliveryid: id, result };
    },
    deliveries() { return [...deliveries]; }
  };
}
