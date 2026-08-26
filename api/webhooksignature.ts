/**
 * webhook signatures use hmac sha256 and keep secrets outside serialized events.
 */
import { constanttimeequal, hmacsha256 } from "../core/hash.js";

export function webhooksig(payload, secret) { return hmacsha256(typeof payload === "string" ? payload : JSON.stringify(payload), secret); }
export function webhookverify(payload, signature, secret) { return constanttimeequal(webhooksig(payload, secret), signature); }
