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
