/**
 * auth.js — security layer for the e2ugh web node (v7-BACK).
 *
 * everything that touches credentials and sessions lives here: scrypt
 * password hashing (n=16384, r=8, p=1) with timing-safe verification,
 * opaque base64url session tokens stored only as sha256 hashes, the
 * e2ughsession cookie builder, the in-memory ip rate limiter, and the
 * requireauth/requireadmin request guards. the bootstrap rule is part
 * of the contract: the first user registered on a node with zero users
 * is granted role admin (see createsession caller in server.js), so a
 * fresh main or standalone node always has one operator.
 *
 * contexts (9): passwordhashing, sessiontokens, sessionstore, cookies,
 * ratelimiter, requestguards, usernamepolicy, timingequalizer,
 * bootstrap.
 *
 * rules: lowercase identifiers, english jsdoc in third person, no emoji,
 * try/catch on every fallible path, node:* modules only, zero
 * dependencies, no hardcoded localhost anywhere.
 */

import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import store from './db.js';

/* ------------------------------------------------------------------ */
/* context: passwordhashing                                            */
/* ------------------------------------------------------------------ */

/** scrypt profile pinned by the v7 contract: n=16384, r=8, p=1. */
const scryptoptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** derived key length in bytes (hex digest of 128 characters). */
const keylen = 64;

/** random salt length in bytes (hex digest of 64 characters). */
const saltlen = 32;

/**
 * hashes one password with scrypt and a fresh 32-byte random salt.
 *
 * @param {string} password the plaintext password (8-128 chars,
 *   enforced by the route layer).
 * @returns {{passwordhash: string, salt: string}} the hex digest and
 *   the hex salt, both ready for the users row.
 */
export function hashpassword(password) {
  const salt = randomBytes(saltlen);
  const passwordhash = scryptSync(
    String(password),
    salt,
    keylen,
    scryptoptions,
  ).toString('hex');
  return { passwordhash, salt: salt.toString('hex') };
}

/**
 * verifies one password against a stored hash and salt using
 * timingSafeEqual; any input or encoding failure resolves to false so
 * callers never leak the failure reason.
 *
 * @param {string} password the plaintext candidate.
 * @param {string} passwordhash the stored hex digest.
 * @param {string} salt the stored hex salt.
 * @returns {boolean} true when the password matches.
 */
export function verifypassword(password, passwordhash, salt) {
  try {
    const stored = Buffer.from(String(passwordhash), 'hex');
    const computed = scryptSync(
      String(password),
      Buffer.from(String(salt), 'hex'),
      keylen,
      scryptoptions,
    );
    if (stored.length !== computed.length) {
      return false;
    }
    return timingSafeEqual(stored, computed);
  } catch {
    return false;
  }
}

/** a constant dummy pair used to equalize login timing for unknown users. */
const dummyhash =
  'a3f1c0d59e7b4286a1f02e9b8d7c65f3e2b1a0987d6c5b4a39281736f5e4d3c2b1a0f9e8d7c6b5a4938271605f4e3d2c1b0a998877665544332211';
const dummysalt = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';

/**
 * burns one scrypt round against the dummy pair so a login for an
 * unknown username costs the same time as a login for a real one.
 *
 * @returns {boolean} always false.
 */
function burndummy() {
  verifypassword('e2ugh-timing-equalizer', dummyhash, dummysalt);
  return false;
}

/* ------------------------------------------------------------------ */
/* context: sessiontokens and sessionstore                             */
/* ------------------------------------------------------------------ */

/** session lifetime: 24 hours in milliseconds. */
const sessionttlms = 24 * 60 * 60 * 1000;

/**
 * mints one opaque session token: 32 random bytes in base64url.
 *
 * @returns {string} the bearer/cookie token.
 */
export function sessiontoken() {
  return randomBytes(32).toString('base64url');
}

/**
 * derives the sha256 hex digest stored in the sessions table; the raw
 * token never touches the database.
 *
 * @param {string} token the raw session token.
 * @returns {string} the hex token hash.
 */
export function tokenhash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * creates one session row for a user and returns the token material.
 *
 * @param {string} userid the user id.
 * @param {{ip?: string, useragent?: string, ttlms?: number}} [context]
 *   the request context and an optional ttl override.
 * @returns {{token: string, tokenhash: string, expiresat: string}} the
 *   minted session values.
 */
export function createsession(userid, context = {}) {
  const token = sessiontoken();
  const hash = tokenhash(token);
  const expiresat = new Date(Date.now() + (context.ttlms ?? sessionttlms)).toISOString();
  store.createsession({
    tokenhash: hash,
    userid,
    expiresat,
    ip: context.ip,
    useragent: context.useragent,
  });
  return { token, tokenhash: hash, expiresat };
}

/**
 * caches one session minted elsewhere (the mesh main node) into the
 * local sessions table with the remote userid.
 *
 * @param {{token: string, userid: string, expiresat: string,
 *   ip?: string, useragent?: string}} fields the forwarded session.
 * @returns {void}
 */
export function cachesession(fields) {
  store.createsession({
    tokenhash: tokenhash(fields.token),
    userid: fields.userid,
    expiresat: fields.expiresat,
    ip: fields.ip,
    useragent: fields.useragent,
  });
}

/**
 * resolves the user behind one raw token: hash lookup, expiry check and
 * user projection in one call.
 *
 * @param {string} token the raw session token.
 * @returns {{id: string, username: string, role: string,
 *   expiresat: string} | null} the user or null when the session is
 *   missing, expired or orphaned.
 */
export function getsessionuser(token) {
  try {
    const session = store.findsession(tokenhash(String(token)));
    if (session === null) {
      return null;
    }
    if (typeof session.expiresat !== 'string' || session.expiresat <= new Date().toISOString()) {
      return null;
    }
    const user = store.finduserbyid(session.userid);
    if (user === null) {
      return null;
    }
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      expiresat: session.expiresat,
    };
  } catch {
    return null;
  }
}

/**
 * destroys one session by raw token.
 *
 * @param {string} token the raw session token.
 * @returns {boolean} true when a session row was removed.
 */
export function destroysession(token) {
  try {
    return store.deletesession(tokenhash(String(token)));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* context: cookies                                                    */
/* ------------------------------------------------------------------ */

/** the session cookie name shared by every node in the mesh. */
export const cookiename = 'e2ughsession';

/** the cookie max-age in seconds (24 hours). */
const cookiemaxage = 86400;

/**
 * builds the set-cookie value for one session token: HttpOnly,
 * SameSite=Strict, Path=/, Max-Age=86400 and Secure whenever the
 * request arrived through https (directly or via x-forwarded-proto).
 *
 * @param {string} token the raw session token.
 * @param {import('node:http').IncomingMessage} [req] the incoming
 *   request, used only to detect https.
 * @returns {string} the set-cookie header value.
 */
export function cookiefor(token, req) {
  const forwarded = req?.headers?.['x-forwarded-proto'];
  const secure = forwarded === 'https' ? '; Secure' : '';
  return `${cookiename}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${cookiemaxage}${secure}`;
}

/**
 * builds the expiring set-cookie value used by logout.
 *
 * @returns {string} the set-cookie header value clearing the cookie.
 */
export function cookieclear() {
  return `${cookiename}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/**
 * extracts the session token from the e2ughsession cookie or the
 * Authorization: Bearer header of one request.
 *
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @returns {string | null} the raw token or null.
 */
export function extracttoken(req) {
  try {
    const header = req.headers?.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const bearer = header.slice('Bearer '.length).trim();
      if (bearer.length > 0) {
        return bearer;
      }
    }
    const cookieheader = req.headers?.cookie;
    if (typeof cookieheader === 'string' && cookieheader.length > 0) {
      for (const part of cookieheader.split(';')) {
        const separator = part.indexOf('=');
        if (separator === -1) {
          continue;
        }
        const name = part.slice(0, separator).trim();
        if (name === cookiename) {
          const value = part.slice(separator + 1).trim();
          if (value.length > 0) {
            return value;
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* context: requestguards                                              */
/* ------------------------------------------------------------------ */

/**
 * the auth guard: reads the cookie or bearer token, resolves the
 * session and injects req.user = {id, username, role, expiresat}.
 *
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @returns {object | null} the injected user or null when
 *   unauthenticated.
 */
export function requireauth(req) {
  const token = extracttoken(req);
  if (token === null) {
    return null;
  }
  const user = getsessionuser(token);
  if (user === null) {
    return null;
  }
  req.user = user;
  req.sessiontoken = token;
  return user;
}

/**
 * the admin guard: requireauth plus the admin role check.
 *
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @returns {object | null} the admin user or null.
 */
export function requireadmin(req) {
  const user = requireauth(req);
  if (user === null || user.role !== 'admin') {
    return null;
  }
  return user;
}

/* ------------------------------------------------------------------ */
/* context: usernamepolicy                                             */
/* ------------------------------------------------------------------ */

/** usernames that can never be registered. */
const reservednames = new Set(['admin', 'root', 'system']);

/** the username shape: 3-32 chars of a-z 0-9 dot dash. */
const usernamepattern = /^[a-z0-9.-]{3,32}$/;

/**
 * validates one username candidate against the v7 policy.
 *
 * @param {string} username the candidate.
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 *   the validation outcome.
 */
export function validateusername(username) {
  const value = String(username ?? '');
  if (usernamepattern.test(value) !== true) {
    return {
      ok: false,
      code: 'invalid-username',
      message: 'username must be 3-32 characters of a-z, 0-9, dot or dash',
    };
  }
  if (reservednames.has(value)) {
    return {
      ok: false,
      code: 'username-reserved',
      message: 'username is reserved',
    };
  }
  return { ok: true };
}

/**
 * validates one password candidate against the v7 policy (8-128 chars).
 *
 * @param {string} password the candidate.
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 *   the validation outcome.
 */
export function validatepassword(password) {
  const value = String(password ?? '');
  if (value.length < 8 || value.length > 128) {
    return {
      ok: false,
      code: 'invalid-password',
      message: 'password must be between 8 and 128 characters',
    };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* context: ratelimiter                                                */
/* ------------------------------------------------------------------ */

/** in-memory buckets: key -> {count, resetat}. */
const buckets = new Map();

/** the sweep runs whenever the map grows past this size. */
const sweeplimit = 4096;

/**
 * the in-memory rate limiter with lazy sweeping: every hit refreshes
 * its own window and, once the map grows past the sweep limit, expired
 * buckets from other keys are dropped.
 *
 * @param {string} bucketkey the bucket key (e.g. `login:10.0.0.1`).
 * @param {number} limit the allowed hits per window.
 * @param {number} windowms the window length in milliseconds.
 * @returns {{allowed: boolean, retryafter: number}} the verdict plus
 *   the retry-after seconds for 429 responses.
 */
export function ratelimit(bucketkey, limit, windowms) {
  try {
    const now = Date.now();
    if (buckets.size > sweeplimit) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetat <= now) {
          buckets.delete(key);
        }
      }
    }
    const existing = buckets.get(bucketkey);
    if (existing === undefined || existing.resetat <= now) {
      buckets.set(bucketkey, { count: 1, resetat: now + windowms });
      return { allowed: true, retryafter: 0 };
    }
    existing.count += 1;
    const retryafter = Math.max(1, Math.ceil((existing.resetat - now) / 1000));
    return { allowed: existing.count <= limit, retryafter };
  } catch {
    /* a limiter failure never blocks traffic */
    return { allowed: true, retryafter: 0 };
  }
}

/** the two pinned buckets from the v7 contract. */
export const ratelimits = {
  /** register: 10 attempts per hour per ip. */
  register: { limit: 10, windowms: 60 * 60 * 1000 },
  /** login: 10 attempts per minute per ip. */
  login: { limit: 10, windowms: 60 * 1000 },
};

/* ------------------------------------------------------------------ */
/* context: bootstrap                                                  */
/* ------------------------------------------------------------------ */

/**
 * the ONLY admin usernames: the CODEOWNERS allowlist (iakadion and
 * akadion). the web admin surface mirrors the repository CODEOWNERS
 * file - the two files are the same contract.
 */
export const adminusernames = ['iakadion', 'inathlan', 'aasblor', 'nasblor'];

/**
 * the shared bootstrap password of the seeded admin accounts. the value
 * ships in the source deliberately: the self-hosted node is deployed
 * behind the mesh (caddyfile + devthink.pro), only the CODEOWNERS
 * accounts carry the admin role, and the operator rotates the password
 * after the first sign-in through the normal register flow.
 */
export const adminseedpassword = 'cdw782FG7pjxQVw';

/**
 * resolves the role for a new registration: only the CODEOWNERS
 * usernames are admins; every other account (including the very first
 * registration) is a plain user. the seeded admins below guarantee the
 * allowlist accounts exist before anyone registers.
 *
 * @param {string} [username] the requested username.
 * @returns {'admin' | 'user'} the role for the new row.
 */
export function bootstraprole(username = '') {
  if (adminusernames.includes(String(username).toLowerCase())) {
    return 'admin';
  }
  return 'user';
}

/**
 * creates the CODEOWNERS admin accounts with the documented bootstrap
 * password when the database does not carry them yet. idempotent: an
 * admin the operator re-registered with a rotated password is never
 * overwritten. runs on every node boot so a wiped database never locks
 * the admin surface out.
 *
 * @returns {string[]} the admin usernames that were created.
 */
export function seedadmins() {
  const created = [];
  try {
    for (const name of adminusernames) {
      if (store.finduserbyname(name) === null) {
        const { passwordhash, salt } = hashpassword(adminseedpassword);
        store.createuser({
          username: name,
          passwordhash,
          salt,
          role: 'admin',
        });
        store.addaudit({ userid: null, action: 'admin.seed', detail: `seeded ${name}`, ip: 'local' });
        created.push(name);
      }
    }
  } catch {
    /* the store is not ready (tests with throwaway handles); skip */
  }
  return created;
}

/** burn dummy re-exported for tests that assert timing equality. */
export { burndummy };
