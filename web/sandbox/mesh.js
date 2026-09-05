/**
 * mesh.js — signed node-to-node communication for the e2ugh web mesh
 * (v7-BACK).
 *
 * the mesh connects clone nodes to the main authority: requests are
 * signed with HMAC-SHA256 over `${timestamp}.${method}.${path}.${bodyhash}`,
 * protected by a 60-second anti-replay window with a 1024-entry nonce
 * cache, and may optionally encrypt payloads with AES-256-GCM using the
 * E2UGH_MESH_KEY hex secret. the module also carries the node role
 * (E2UGH_ROLE=main|clone|standalone, default standalone), the signed
 * fetch client towards E2UGH_MAIN_URL and the 60-second heartbeat
 * loop clones run against the main registry.
 *
 * contexts (8): noderole, requestsigning, antireplay, payloadcrypto,
 * meshmessages, mainclient, heartbeat, sessionforwarding.
 *
 * rules: lowercase identifiers, english jsdoc in third person, no emoji,
 * try/catch on every fallible path, node:* modules plus the global
 * fetch only, zero dependencies, no hardcoded localhost (the main url
 * always comes from the environment).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import process from 'node:process';

/* ------------------------------------------------------------------ */
/* context: noderole                                                   */
/* ------------------------------------------------------------------ */

/**
 * resolves the node role once at import time: e2ugh_role accepts the
 * values main, clone and standalone; anything else (including unset)
 * falls back to standalone so a bare `node web/server.js` boot behaves
 * as a self-contained authority.
 *
 * @returns {'main' | 'clone' | 'standalone'} the resolved role.
 */
function resolverole() {
  const value = String(process.env.E2UGH_ROLE ?? 'standalone').toLowerCase();
  if (value === 'main' || value === 'clone' || value === 'standalone') {
    return value;
  }
  return 'standalone';
}

/** the node role: main, clone or standalone. */
export const role = resolverole();

/**
 * reads the shared mesh secret from the environment.
 *
 * @returns {string} the secret or an empty string when unconfigured.
 */
export function meshsecret() {
  return String(process.env.E2UGH_MESH_SECRET ?? '');
}

/**
 * reads the main node base url (no trailing slash) from the
 * environment; never a hardcoded address.
 *
 * @returns {string} the trimmed base url or an empty string.
 */
export function mainurl() {
  return String(process.env.E2UGH_MAIN_URL ?? '').replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ */
/* context: requestsigning                                             */
/* ------------------------------------------------------------------ */

/** the anti-replay window in milliseconds. */
const replaywindowms = 60 * 1000;

/** the nonce cache ceiling (simple LRU eviction past this size). */
const noncelimit = 1024;

/**
 * computes the sha256 hex digest of one request body.
 *
 * @param {string} body the exact raw body string ('' for GET).
 * @returns {string} the hex body hash.
 */
export function bodyhash(body) {
  return createHash('sha256').update(String(body)).digest('hex');
}

/**
 * signs one mesh request: HMAC-SHA256 hex over the string
 * `${timestamp}.${method}.${path}.${bodyhash}`.
 *
 * @param {string} method the upper-case http method.
 * @param {string} path the full request path (e.g. /api/v1/mesh/register).
 * @param {string} body the exact raw body string ('' for GET).
 * @param {string} secret the shared mesh secret.
 * @param {string} [timestamp] the millisecond timestamp string
 *   (defaults to now).
 * @returns {string} the hex signature.
 */
export function sign(method, path, body, secret, timestamp = String(Date.now())) {
  return createHmac('sha256', String(secret))
    .update(`${timestamp}.${String(method).toUpperCase()}.${path}.${bodyhash(body)}`)
    .digest('hex');
}

/* ------------------------------------------------------------------ */
/* context: antireplay                                                 */
/* ------------------------------------------------------------------ */

/** seen signature nonces with insertion order for LRU eviction. */
const nonces = new Map();

/**
 * records one signature in the nonce cache, evicting the oldest entry
 * past the 1024-entry ceiling.
 *
 * @param {string} signature the verified signature hex.
 * @returns {void}
 */
function recordnonce(signature) {
  if (nonces.has(signature)) {
    return;
  }
  nonces.set(signature, Date.now());
  while (nonces.size > noncelimit) {
    const oldest = nonces.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    nonces.delete(oldest);
  }
}

/**
 * verifies one incoming mesh request: the x-e2ugh-timestamp header must
 * sit inside the 60-second window, the x-e2ugh-signature header must
 * match the recomputed HMAC over the raw body, and the signature must
 * not have been seen before (replay protection).
 *
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @param {string} rawbody the exact raw request body ('' for GET).
 * @param {string} secret the shared mesh secret.
 * @returns {{ok: true} | {ok: false, status: number, code: string,
 *   message: string}} the verification outcome.
 */
export function verifymesh(req, rawbody, secret) {
  try {
    const timestamp = req.headers?.['x-e2ugh-timestamp'];
    const signature = req.headers?.['x-e2ugh-signature'];
    if (typeof timestamp !== 'string' || typeof signature !== 'string') {
      return {
        ok: false,
        status: 401,
        code: 'mesh-unauthenticated',
        message: 'mesh requests require x-e2ugh-timestamp and x-e2ugh-signature headers',
      };
    }
    const skew = Math.abs(Date.now() - Number.parseInt(timestamp, 10));
    if (!Number.isFinite(skew) || skew > replaywindowms) {
      return {
        ok: false,
        status: 401,
        code: 'mesh-stale-timestamp',
        message: 'mesh timestamp outside the 60 second window',
      };
    }
    const path = String(req.url ?? '/').split('?')[0];
    const expected = sign(req.method ?? 'GET', path, String(rawbody), secret, timestamp);
    const left = Buffer.from(expected, 'hex');
    const right = Buffer.from(signature, 'hex');
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      return {
        ok: false,
        status: 401,
        code: 'mesh-bad-signature',
        message: 'mesh signature mismatch',
      };
    }
    if (nonces.has(signature)) {
      return {
        ok: false,
        status: 401,
        code: 'mesh-replay',
        message: 'mesh signature was already used',
      };
    }
    recordnonce(signature);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      status: 401,
      code: 'mesh-verify-failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ------------------------------------------------------------------ */
/* context: payloadcrypto (optional AES-256-GCM)                       */
/* ------------------------------------------------------------------ */

/** the authenticated payload key length in bytes. */
const meshkeylen = 32;

/** the GCM initialization vector length in bytes. */
const ivlen = 12;

/** the GCM authentication tag length in bytes. */
const taglen = 16;

/**
 * resolves the optional E2UGH_MESH_KEY (32 bytes hex) used for payload
 * encryption between nodes.
 *
 * @returns {Buffer | null} the key or null when unset/invalid.
 */
function meshkey() {
  try {
    const raw = String(process.env.E2UGH_MESH_KEY ?? '');
    if (raw.length === 0) {
      return null;
    }
    const key = Buffer.from(raw, 'hex');
    return key.length === meshkeylen ? key : null;
  } catch {
    return null;
  }
}

/**
 * encrypts one utf-8 payload with AES-256-GCM; the output is hex
 * `iv(12) || ciphertext || tag(16)`.
 *
 * @param {string} plaintext the payload to encrypt.
 * @returns {string | null} the hex envelope or null when the key is
 *   not configured.
 */
export function encrypt(plaintext) {
  try {
    const key = meshkey();
    if (key === null) {
      return null;
    }
    const iv = randomBytes(ivlen);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(String(plaintext), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, ciphertext, tag]).toString('hex');
  } catch {
    return null;
  }
}

/**
 * decrypts one AES-256-GCM hex envelope produced by encrypt.
 *
 * @param {string} envelope the hex iv || ciphertext || tag payload.
 * @returns {string | null} the utf-8 plaintext or null on any failure.
 */
export function decrypt(envelope) {
  try {
    const key = meshkey();
    if (key === null) {
      return null;
    }
    const raw = Buffer.from(String(envelope), 'hex');
    if (raw.length <= ivlen + taglen) {
      return null;
    }
    const iv = raw.subarray(0, ivlen);
    const tag = raw.subarray(raw.length - taglen);
    const ciphertext = raw.subarray(ivlen, raw.length - taglen);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* context: meshmessages                                               */
/* ------------------------------------------------------------------ */

/**
 * builds one mesh message envelope {type, from, data, ts}; when the
 * mesh key is configured the data field is replaced by the GCM
 * envelope {enc: '<hex>'}.
 *
 * @param {string} type the message type (e.g. 'heartbeat').
 * @param {string} from the sender node id or url.
 * @param {unknown} data the message payload.
 * @returns {object} the wire envelope.
 */
export function meshmessage(type, from, data) {
  const envelope = { type, from, data, ts: new Date().toISOString() };
  const key = meshkey();
  if (key !== null) {
    const sealed = encrypt(JSON.stringify(envelope.data));
    if (sealed !== null) {
      return { ...envelope, data: { enc: sealed } };
    }
  }
  return envelope;
}

/**
 * opens one mesh message envelope produced by meshmessage, decrypting
 * the data field when needed.
 *
 * @param {object} envelope the wire envelope.
 * @returns {{type: string, from: string, data: unknown, ts: string} | null}
 *   the opened message or null on tampering.
 */
export function openmeshmessage(envelope) {
  try {
    if (envelope === null || typeof envelope !== 'object') {
      return null;
    }
    let data = envelope.data;
    if (data !== null && typeof data === 'object' && typeof data.enc === 'string') {
      const opened = decrypt(data.enc);
      if (opened === null) {
        return null;
      }
      data = JSON.parse(opened);
    }
    return {
      type: String(envelope.type ?? ''),
      from: String(envelope.from ?? ''),
      data,
      ts: String(envelope.ts ?? ''),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* context: mainclient                                                 */
/* ------------------------------------------------------------------ */

/** the signed request timeout in milliseconds. */
const requesttimeoutms = 10 * 1000;

/**
 * performs one signed POST towards the main node described by
 * E2UGH_MAIN_URL using the global fetch; the signature headers are
 * computed with the shared E2UGH_MESH_SECRET.
 *
 * @param {string} path the full api path (e.g. /api/v1/auth/login).
 * @param {unknown} body the json-serializable payload.
 * @returns {Promise<{status: number, body: unknown}>} the response
 *   status and parsed json body.
 * @throws {Error & {code: string}} when the mesh is unconfigured, the
 *   request fails or the body is not json.
 */
export async function postmain(path, body) {
  const base = mainurl();
  const secret = meshsecret();
  if (base.length === 0 || secret.length === 0) {
    throw Object.assign(
      new Error('E2UGH_MAIN_URL and E2UGH_MESH_SECRET are required for mesh forwarding'),
      { code: 'mesh-unconfigured' },
    );
  }
  const payload = JSON.stringify(body ?? {});
  const timestamp = String(Date.now());
  const signature = sign('POST', path, payload, secret, timestamp);
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-e2ugh-timestamp': timestamp,
        'x-e2ugh-signature': signature,
      },
      body: payload,
      signal: AbortSignal.timeout(requesttimeoutms),
    });
  } catch (error) {
    throw Object.assign(
      new Error(`mesh request to ${path} failed: ${error instanceof Error ? error.message : String(error)}`),
      { code: 'mesh-unreachable' },
    );
  }
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  let setcookie = [];
  try {
    setcookie =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];
  } catch {
    setcookie = [];
  }
  return { status: response.status, body: parsed, setcookie };
}

/* ------------------------------------------------------------------ */
/* context: heartbeat                                                  */
/* ------------------------------------------------------------------ */

/** the clone heartbeat period in milliseconds. */
const heartbeatperiodms = 60 * 1000;

/**
 * runs the clone registry loop: one immediate registration followed by
 * heartbeats every 60 seconds, all signed towards the main node. the
 * interval is unref'd so the process can still exit cleanly.
 *
 * @param {{url: string, region?: string, rolename?: string}} self the
 *   announcing node description.
 * @returns {NodeJS.Timeout | null} the heartbeat timer or null when the
 *   node is not a clone or the mesh is unconfigured.
 */
export function startheartbeat(self) {
  if (
    role !== 'clone' ||
    mainurl().length === 0 ||
    meshsecret().length === 0 ||
    String(self?.url ?? '').length === 0
  ) {
    return null;
  }
  const beat = async () => {
    try {
      const registered = await postmain('/api/v1/mesh/register', self);
      if (registered.status !== 200 && registered.status !== 201) {
        return false;
      }
      const nodeid =
        registered.body !== null && typeof registered.body === 'object'
          ? String(registered.body?.nodeid ?? registered.body?.id ?? '')
          : '';
      if (nodeid.length === 0) {
        return false;
      }
      const pulsed = await postmain('/api/v1/mesh/heartbeat', { nodeid });
      return pulsed.status === 200;
    } catch {
      /* the next tick retries; the clone keeps serving locally */
      return false;
    }
  };
  /* boot ladder: the immediate beat may race the main node's own boot,
   * so short retries run until the first success; afterwards the steady
   * 60 second interval keeps the registry fresh. */
  let established = false;
  const runbeat = async () => {
    const ok = await beat();
    if (ok) {
      established = true;
    }
    return ok;
  };
  runbeat();
  for (const delay of [2000, 5000, 10000, 20000]) {
    const retry = setTimeout(() => {
      if (!established) {
        runbeat();
      }
    }, delay);
    retry.unref?.();
  }
  const timer = setInterval(() => {
    runbeat();
  }, heartbeatperiodms);
  timer.unref?.();
  return timer;
}

/* ------------------------------------------------------------------ */
/* context: sessionforwarding                                          */
/* ------------------------------------------------------------------ */

/**
 * forwards one auth request (register or login) from a clone to the
 * main authority; the caller caches the returned session locally when
 * the main node accepts it.
 *
 * @param {'register' | 'login'} action the auth action.
 * @param {unknown} body the credentials payload.
 * @returns {Promise<{status: number, body: unknown}>} the main
 *   response verbatim.
 */
export function forwardauth(action, body) {
  const path = action === 'register' ? '/api/v1/auth/register' : '/api/v1/auth/login';
  return postmain(path, body);
}
