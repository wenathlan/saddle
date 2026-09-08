/**
 * mesh.ts — signed node-to-node communication for the saddle web mesh
 * (v7-BACK).
 *
 * the mesh connects clone nodes to the main authority: requests are
 * signed with HMAC-SHA256 over `${timestamp}.${method}.${path}.${bodyhash}`,
 * protected by a 60-second anti-replay window with a 1024-entry nonce
 * cache, and may optionally encrypt payloads with AES-256-GCM using the
 * SADDLE_MESH_KEY hex secret. the module also carries the node role
 * (SADDLE_ROLE=main|clone|standalone, default standalone), the signed
 * fetch client towards SADDLE_MAIN_URL and the 60-second heartbeat
 * loop clones run against the main registry.
 *
 * contexts (9): types, noderole, requestsigning, antireplay,
 * payloadcrypto, meshmessages, mainclient, heartbeat, sessionforwarding.
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
import type { IncomingMessage } from 'node:http';
import process from 'node:process';

/* ------------------------------------------------------------------ */
/* context: types — the mesh surface contracts                         */
/* ------------------------------------------------------------------ */

/** the node role resolved from saddle_role. */
export type NodeRole = 'main' | 'clone' | 'standalone';

/** the mesh verification outcome: the ok arm or the rejection payload
 * consumed by writeerror. */
export type MeshVerdict =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

/** the mesh wire envelope {type, from, data, ts}; when the mesh key is
 * configured the data field is replaced by {enc: '<hex>'}. */
export type MeshEnvelope = {
  type: string;
  from: string;
  data: unknown;
  ts: string;
};

/** the opened mesh message produced by openmeshmessage. */
export type MeshMessage = {
  type: string;
  from: string;
  data: unknown;
  ts: string;
};

/** the main node response relayed by the signed client: status, the
 * parsed json body (null when not json) and the set-cookie relay. */
export type MainResponse = {
  status: number;
  body: unknown;
  setcookie: string[];
};

/** the announcing node description of the clone heartbeat loop. */
export type HeartbeatSelf = {
  url: string;
  region?: string;
  rolename?: string;
};

/* ------------------------------------------------------------------ */
/* context: noderole                                                   */
/* ------------------------------------------------------------------ */

/**
 * resolves the node role once at import time: saddle_role accepts the
 * values main, clone and standalone; anything else (including unset)
 * falls back to standalone so a bare `node web/server.ts` boot behaves
 * as a self-contained authority.
 *
 * @returns the resolved role.
 */
function resolverole(): NodeRole {
  const value = String(process.env.SADDLE_ROLE ?? 'standalone').toLowerCase();
  if (value === 'main' || value === 'clone' || value === 'standalone') {
    return value;
  }
  return 'standalone';
}

/** the node role: main, clone or standalone. */
export const role: NodeRole = resolverole();

/**
 * reads the shared mesh secret from the environment.
 *
 * @returns the secret or an empty string when unconfigured.
 */
export function meshsecret(): string {
  return String(process.env.SADDLE_MESH_SECRET ?? '');
}

/**
 * reads the main node base url (no trailing slash) from the
 * environment; never a hardcoded address.
 *
 * @returns the trimmed base url or an empty string.
 */
export function mainurl(): string {
  return String(process.env.SADDLE_MAIN_URL ?? '').replace(/\/+$/, '');
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
 * @param body the exact raw body string ('' for GET).
 * @returns the hex body hash.
 */
export function bodyhash(body: string): string {
  return createHash('sha256').update(String(body)).digest('hex');
}

/**
 * signs one mesh request: HMAC-SHA256 hex over the string
 * `${timestamp}.${method}.${path}.${bodyhash}`.
 *
 * @param method the upper-case http method.
 * @param path the full request path (e.g. /api/v1/mesh/register).
 * @param body the exact raw body string ('' for GET).
 * @param secret the shared mesh secret.
 * @param timestamp the millisecond timestamp string
 *   (defaults to now).
 * @returns the hex signature.
 */
export function sign(
  method: string,
  path: string,
  body: string,
  secret: string,
  timestamp: string = String(Date.now()),
): string {
  return createHmac('sha256', String(secret))
    .update(`${timestamp}.${String(method).toUpperCase()}.${path}.${bodyhash(body)}`)
    .digest('hex');
}

/* ------------------------------------------------------------------ */
/* context: antireplay                                                 */
/* ------------------------------------------------------------------ */

/** seen signature nonces with insertion order for LRU eviction. */
const nonces = new Map<string, number>();

/**
 * records one signature in the nonce cache, evicting the oldest entry
 * past the 1024-entry ceiling.
 *
 * @param signature the verified signature hex.
 * @returns void.
 */
function recordnonce(signature: string): void {
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
 * verifies one incoming mesh request: the x-saddle-timestamp header must
 * sit inside the 60-second window, the x-saddle-signature header must
 * match the recomputed HMAC over the raw body, and the signature must
 * not have been seen before (replay protection).
 *
 * @param req the incoming request.
 * @param rawbody the exact raw request body ('' for GET).
 * @param secret the shared mesh secret.
 * @returns the verification outcome.
 */
export function verifymesh(req: IncomingMessage, rawbody: string, secret: string): MeshVerdict {
  try {
    const timestamp = req.headers?.['x-saddle-timestamp'];
    const signature = req.headers?.['x-saddle-signature'];
    if (typeof timestamp !== 'string' || typeof signature !== 'string') {
      return {
        ok: false,
        status: 401,
        code: 'mesh-unauthenticated',
        message: 'mesh requests require x-saddle-timestamp and x-saddle-signature headers',
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
 * resolves the optional SADDLE_MESH_KEY (32 bytes hex) used for payload
 * encryption between nodes.
 *
 * @returns the key or null when unset/invalid.
 */
function meshkey(): Buffer | null {
  try {
    const raw = String(process.env.SADDLE_MESH_KEY ?? '');
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
 * @param plaintext the payload to encrypt.
 * @returns the hex envelope or null when the key is
 *   not configured.
 */
export function encrypt(plaintext: string): string | null {
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
 * @param envelope the hex iv || ciphertext || tag payload.
 * @returns the utf-8 plaintext or null on any failure.
 */
export function decrypt(envelope: string): string | null {
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
 * @param type the message type (e.g. 'heartbeat').
 * @param from the sender node id or url.
 * @param data the message payload.
 * @returns the wire envelope.
 */
export function meshmessage(type: string, from: string, data: unknown): MeshEnvelope {
  const envelope: MeshEnvelope = { type, from, data, ts: new Date().toISOString() };
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
 * @param envelope the wire envelope.
 * @returns the opened message or null on tampering.
 */
export function openmeshmessage(envelope: unknown): MeshMessage | null {
  try {
    if (envelope === null || typeof envelope !== 'object') {
      return null;
    }
    const message = envelope as MeshEnvelope;
    let data: unknown = message.data;
    if (
      data !== null &&
      typeof data === 'object' &&
      typeof (data as { enc?: unknown }).enc === 'string'
    ) {
      const opened = decrypt((data as { enc: string }).enc);
      if (opened === null) {
        return null;
      }
      data = JSON.parse(opened);
    }
    return {
      type: String(message.type ?? ''),
      from: String(message.from ?? ''),
      data,
      ts: String(message.ts ?? ''),
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
 * SADDLE_MAIN_URL using the global fetch; the signature headers are
 * computed with the shared SADDLE_MESH_SECRET.
 *
 * @param path the full api path (e.g. /api/v1/auth/login).
 * @param body the json-serializable payload.
 * @returns the response status, the parsed json body and the
 *   set-cookie relay.
 * @throws when the mesh is unconfigured, the
 *   request fails or the body is not json.
 */
export async function postmain(path: string, body: unknown): Promise<MainResponse> {
  const base = mainurl();
  const secret = meshsecret();
  if (base.length === 0 || secret.length === 0) {
    throw Object.assign(
      new Error('SADDLE_MAIN_URL and SADDLE_MESH_SECRET are required for mesh forwarding'),
      { code: 'mesh-unconfigured' },
    );
  }
  const payload = JSON.stringify(body ?? {});
  const timestamp = String(Date.now());
  const signature = sign('POST', path, payload, secret, timestamp);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-saddle-timestamp': timestamp,
        'x-saddle-signature': signature,
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
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  let setcookie: string[] = [];
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
 * @param self the announcing node description.
 * @returns the heartbeat timer or null when the
 *   node is not a clone or the mesh is unconfigured.
 */
export function startheartbeat(self: HeartbeatSelf): NodeJS.Timeout | null {
  if (
    role !== 'clone' ||
    mainurl().length === 0 ||
    meshsecret().length === 0 ||
    String(self?.url ?? '').length === 0
  ) {
    return null;
  }
  const beat = async (): Promise<boolean> => {
    try {
      const registered = await postmain('/api/v1/mesh/register', self);
      if (registered.status !== 200 && registered.status !== 201) {
        return false;
      }
      const nodeid =
        registered.body !== null && typeof registered.body === 'object'
          ? String(
              (registered.body as Record<string, unknown>)?.nodeid ??
                (registered.body as Record<string, unknown>)?.id ??
                '',
            )
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
  const runbeat = async (): Promise<boolean> => {
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
 * @param action the auth action.
 * @param body the credentials payload.
 * @returns the main response verbatim.
 */
export function forwardauth(
  action: 'register' | 'login',
  body: unknown,
): Promise<MainResponse> {
  const path = action === 'register' ? '/api/v1/auth/register' : '/api/v1/auth/login';
  return postmain(path, body);
}
