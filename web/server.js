#!/usr/bin/env node
/**
 * server.js — self-hosted node api for the saddle web console (the merged e2ugh sandbox surface, v7-BACK).
 *
 * pure node:http, zero dependencies, esm. the server serves the static
 * web/ assets (content types parsed from web/mime.types at boot) and
 * exposes the /api/v1 contract: health, spec catalogs read from the
 * repository json files, in-memory sandboxes with the created ->
 * running state machine persisted to sqlite, exec through the very
 * same browser-pure dispatcher (web.js) with the persistent
 * per-sandbox workspace filesystem (sandboxfiles table, quota capped,
 * data stays with the sandbox id across restarts), the auth surface
 * (register/login/logout/me backed by scrypt and sessions in db.js),
 * the signed mesh surface (register/heartbeat/nodes verified by
 * mesh.js), the admin surface (overview/users/nodes/sandboxes/audit)
 * and the events poll for the dashboard. per the project rules there
 * is no serverless function anywhere: this file is the whole backend
 * and runs on any plain node host (docker, vps, caddy reverse proxy).
 *
 * contexts (26): httpserver, portselection, noderole, staticfiles,
 * mimetypes, contenttypes, cacheheaders, securityheaders, cors, jsonio,
 * apierrors, health, speccatalogs, specscache, authroutes, sandboxes,
 * sandboxfs, statemachine, ttlreaper, execendpoint, filesroutes,
 * meshroutes, adminroutes, eventsroute, requestlogging, gracefulshutdown.
 *
 * rules: lowercase identifiers, english jsdoc in third person, no emoji,
 * try/catch on every fallible path, standardized {error:{code,message}}
 * json failures, no hardcoded localhost address, host and port resolved
 * once at boot from argv/env with a random 30000-59999 default.
 */

import { createServer } from 'node:http';
import { accessSync, createReadStream, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sep, extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  createSandboxState,
  dispatch,
  cpudata,
  gpudata,
  migprofiles,
  getcpu,
  getcpubyid,
  getgpu,
  getmig,
} from './sandbox.js';
import store from './db.js';
import {
  burndummy,
  cachesession,
  cookieclear,
  cookiefor,
  createsession,
  destroysession,
  extracttoken,
  hashpassword,
  ratelimit,
  ratelimits,
  requireadmin,
  requireauth,
  adminusernames,
  bootstraprole,
  seedadmins,
  validatepassword,
  validateusername,
  verifypassword,
} from './auth.js';
import { forwardauth, mainurl, meshsecret, role, startheartbeat, verifymesh } from './mesh.js';

/** repository root (one level above web/) resolved from this module. */
/* the grand-merge layout: this server lives at web/server.js, the static
 * console pages sit beside it in the same directory, and the repository
 * root (specs catalogs, engine sources) is one level up. */
const rootdir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** the sandbox directory holding the static assets. */
const webdir = dirname(fileURLToPath(import.meta.url));

/** api version tag reported by /api/v1/health. */
const version = '2.0.0';

/** sandbox ttl in milliseconds (15 minutes) and sweep interval (60 s). */
const ttlms = 15 * 60 * 1000;
const sweepperiodms = 60 * 1000;

/** expired session sweep period for the main role (10 minutes). */
const sessionsweepperiodms = 10 * 60 * 1000;

/** firecracker-style bring-up delay before a sandbox reaches running. */
const startrampms = 125;

/** the session ttl mirrored from auth.js for clone-forwarded sessions. */
const sessionttlms = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* context: portselection                                              */
/* ------------------------------------------------------------------ */

/**
 * resolves the listen port once at boot: --port argument wins, then the
 * port or saddle_port environment variables, then a random port in the
 * documented 30000-59999 range.
 *
 * @returns {number} the tcp port to bind.
 */
function resolveport() {
  try {
    const argindex = process.argv.indexOf('--port');
    if (argindex !== -1 && process.argv[argindex + 1] !== undefined) {
      const parsed = Number.parseInt(process.argv[argindex + 1], 10);
      if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
        return parsed;
      }
    }
    const envport = Number.parseInt(
      process.env.PORT ?? process.env.SADDLE_PORT ?? '',
      10,
    );
    if (Number.isInteger(envport) && envport > 0 && envport < 65536) {
      return envport;
    }
    return 30000 + Math.floor(Math.random() * 30000);
  } catch {
    return 30000 + Math.floor(Math.random() * 30000);
  }
}

/** listen host: 0.0.0.0 unless saddle_host overrides; never localhost. */
const host =
  process.env.SADDLE_HOST && process.env.SADDLE_HOST.length > 0
    ? process.env.SADDLE_HOST
    : '0.0.0.0';
const port = resolveport();

/* ------------------------------------------------------------------ */
/* context: mimetypes and contenttypes                                 */
/* ------------------------------------------------------------------ */

/**
 * parses one debian mime.types document into an extension -> type map:
 * blank lines and #-comments are skipped, the first column is the media
 * type and the remaining columns are extensions. the first mapping wins
 * so the canonical entry (text/javascript for es/js/mjs) is kept when
 * an extension repeats.
 *
 * @param {string} filepath the mime.types file location.
 * @returns {Map<string, string>} the extension (with dot) -> type map.
 */
function parsemimetypes(filepath) {
  const map = new Map();
  try {
    const content = readFileSync(filepath, 'utf8');
    for (const rawline of content.split('\n')) {
      const line = rawline.trim();
      if (line.length === 0 || line.startsWith('#')) {
        continue;
      }
      const fields = line.split(/\s+/);
      const type = fields[0];
      if (type === undefined || type.length === 0) {
        continue;
      }
      for (const extension of fields.slice(1)) {
        const key = `.${extension.toLowerCase()}`;
        if (extension.length > 0 && !map.has(key)) {
          map.set(key, type);
        }
      }
    }
  } catch {
    /* an unreadable mime.types leaves the map empty; the fallback
     * application/octet-stream keeps files flowing */
  }
  return map;
}

/** the real extension -> media type table parsed once at boot. */
const mimetable = parsemimetypes(join(webdir, 'mime.types'));

/** the fallback type for extensions absent from the table. */
const fallbacktype = 'application/octet-stream';

/** extensions never served statically (database and log sidecar files). */
const denylist = new Set(['.db', '.sqlite', '.sqlite3', '.log']);

/**
 * resolves the content type for one lower-case extension.
 *
 * @param {string} extension the extension including the dot.
 * @returns {string} the media type or the octet-stream fallback.
 */
function contenttypefor(extension) {
  return mimetable.get(extension) ?? fallbacktype;
}

/** per-extension cache policy: html revalidates, assets cache an hour. */
function cachefor(extension) {
  if (extension === '.html' || extension === '.txt') {
    return 'no-cache, must-revalidate';
  }
  return 'public, max-age=3600';
}

/* ------------------------------------------------------------------ */
/* context: securityheaders and cors                                   */
/* ------------------------------------------------------------------ */

/**
 * resolves the comma separated saddle_allowed_origins list once per
 * request (cheap) so operators can change it without a restart tool.
 *
 * @returns {string[]} the allowed origin list, possibly empty.
 */
function allowedorigins() {
  try {
    return String(process.env.SADDLE_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
}

/**
 * computes the security header set applied to every response: the
 * locked-down content security policy (connect-src gains the main url
 * on clone nodes), nosniff, DENY framing, the strict referrer policy,
 * the empty permissions policy and HSTS on https requests.
 *
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @returns {Record<string, string>} the header map.
 */
function securityheaders(req) {
  const forwarded = req?.headers?.['x-forwarded-proto'];
  const ishttps = forwarded === 'https';
  const connectextra = role === 'clone' && mainurl().length > 0 ? ` ${mainurl()}` : '';
  const headers = {
    'content-security-policy':
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';` +
      ` connect-src 'self'${connectextra}; img-src 'self'; object-src 'none';` +
      ` base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=()',
  };
  if (ishttps) {
    headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

/**
 * computes the cors header set: public mode answers access-control-
 * allow-origin * (health and the spec catalogs), credentials mode
 * echoes the origin and allows credentials only for origins listed in
 * saddle_allowed_origins.
 *
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @param {'public' | 'credentials'} mode the cors mode.
 * @returns {Record<string, string>} the header map.
 */
function corsheaders(req, mode) {
  if (mode === 'credentials') {
    const origin = req?.headers?.origin;
    const headers = {
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers':
        'content-type, authorization, x-saddle-timestamp, x-saddle-signature',
      vary: 'Origin',
    };
    if (typeof origin === 'string' && allowedorigins().includes(origin)) {
      headers['access-control-allow-origin'] = origin;
      headers['access-control-allow-credentials'] = 'true';
    }
    return headers;
  }
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

/**
 * merges the security and cors header sets for one request.
 *
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @param {'public' | 'credentials'} [mode] the cors mode (defaults to
 *   credentials for the authed surface).
 * @returns {Record<string, string>} the merged header map.
 */
function respondheaders(req, mode = 'credentials') {
  return { ...securityheaders(req), ...corsheaders(req, mode) };
}

/* ------------------------------------------------------------------ */
/* context: jsonio and apierrors                                       */
/* ------------------------------------------------------------------ */

/**
 * writes a json response with the given header set (security + cors
 * computed by the caller plus optional extras like set-cookie and
 * retry-after).
 *
 * @param {import('node:http').ServerResponse} res the outgoing response.
 * @param {number} status http status code.
 * @param {unknown} payload json-serializable payload.
 * @param {Record<string, string>} [headers] the extra headers.
 */
function writejson(res, status, payload, headers = {}) {
  try {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(body);
  } catch {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({ error: { code: 'internal', message: 'response serialization failed' } }),
    );
  }
}

/**
 * extracts a safe, stack-trace-free message from a thrown value.
 * `String(error)` on an Error object includes the full stack trace, which
 * must never reach a client response; this helper returns only the message
 * property (no stack) or a generic fallback for non-error throws.
 */
function safemsg(error) {
  // log internal technical details server-side only; the returned string is a
  // generic, stack-trace-free message so no tainted information reaches
  // client responses (CodeQL js/stack-trace-exposure). errors thrown from the
  // data layer carry a non-enumerable `publicMessage` (static, hardcoded per
  // code) which is the only safe, untainted string returned to the network.
  // the underlying driver error is logged with its stack to stderr.
  if (error instanceof Error) {
    const internal = /** @type {{ internal?: string }} */ (error).internal;
    console.error(
      `[server] ${error.message}${internal ? ` :: ${internal}` : ''}\n${error.stack ?? ''}`,
    );
    const publicmsg = /** @type {{ publicMessage?: string }} */ (error).publicMessage;
    if (typeof publicmsg === 'string' && publicmsg.length > 0) {
      return publicmsg;
    }
  } else if (typeof error === 'string' && error.length > 0) {
    console.error(`[server] non-error throw: ${error}`);
  }
  return 'unexpected error';
}

/**
 * writes the standardized error payload {error:{code,message}}.
 *
 * @param {import('node:http').ServerResponse} res the outgoing response.
 * @param {number} status http status code.
 * @param {string} code machine readable error code.
 * @param {string} message human readable explanation.
 * @param {Record<string, string>} [headers] the extra headers.
 */
function writeerror(res, status, code, message, headers = {}) {
  // for server errors (5xx) never expose internal details or stack traces
  // to the client; the code is machine-readable, the message becomes generic.
  const safeMessage = status >= 500
    ? 'an internal error occurred; please try again later'
    : String(message ?? '');
  writejson(res, status, { error: { code, message: safeMessage } }, headers);
}

/**
 * extracts the client ip for audit rows and rate limit buckets.
 *
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @returns {string} the remote address or unknown.
 */
function clientip(req) {
  try {
    return req.socket?.remoteAddress ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * extracts the user agent header bounded to 256 characters.
 *
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @returns {string | undefined} the trimmed user agent.
 */
function clientuseragent(req) {
  try {
    const value = req.headers?.['user-agent'];
    return typeof value === 'string' ? value.slice(0, 256) : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* context: speccatalogs and specscache                                */
/* ------------------------------------------------------------------ */

/** catalog map: /api/v1/specs/<key> reads the mapped repository file. */
const speccatalogs = {
  cpus: 'processors.json',
  gpus: 'gpus.json',
  memory: 'cores.json',
};

/** memoization cache: catalog key to parsed json document. */
const specscache = new Map();

/**
 * reads and caches one spec catalog; files are parsed once per process
 * lifetime and served from the map afterwards.
 *
 * @param {string} key one of cpus, gpus, memory.
 * @returns {Promise<unknown>} the parsed json document.
 */
async function getspeccatalog(key) {
  if (specscache.has(key)) {
    return specscache.get(key);
  }
  const filename = speccatalogs[key];
  if (filename === undefined) {
    throw new Error(
      `unknown spec catalog "${key}"; valid catalogs: ${Object.keys(speccatalogs).join(', ')}`,
    );
  }
  const document = JSON.parse(await readFile(join(rootdir, filename), 'utf8'));
  specscache.set(key, document);
  return document;
}

/* ------------------------------------------------------------------ */
/* context: sandboxfs — the persistent workspace bindings               */
/* ------------------------------------------------------------------ */

/**
 * resolves whether expired sandbox workspaces are explicitly retained
 * (saddle_sandbox_persist=true); the default behavior already keeps the
 * files because the sandbox is self-contained, the flag only records
 * the operator's intent in the expiry event.
 *
 * @returns {boolean} true when the retention flag is set.
 */
function workspacepersist() {
  try {
    return String(process.env.SADDLE_SANDBOX_PERSIST ?? '') === 'true';
  } catch {
    return false;
  }
}

/**
 * builds the dispatcher filesystem context of one sandbox id: the four
 * callbacks bound to the sqlite workspace table with the quota check
 * inside write and defensive degradation on the read paths. a fresh id
 * always starts empty (new uuid, no seeding); the files written through
 * this context live in the database file of the node, so they survive
 * process restarts and stay addressable by the sandbox id.
 *
 * @param {string} id the sandbox id.
 * @returns {{quota: number, fs: {write: Function, read: Function,
 *   list: Function, del: Function}}} the dispatcher context.
 */
function sandboxfscontext(id, quotabytes) {
  return {
    quota: quotabytes ?? store.sandboxquota(),
    fs: {
      write(path, content) {
        return store.writefile(id, path, content, quotabytes);
      },
      read(path) {
        try {
          return store.readfile(id, path);
        } catch {
          return null;
        }
      },
      list() {
        try {
          return store.listfiles(id);
        } catch {
          return [];
        }
      },
      del(path) {
        try {
          return store.deletefile(id, path);
        } catch {
          return false;
        }
      },
    },
  };
}

/**
 * refreshes the usage counters of one sandbox in memory and in the
 * sandboxes row; failures never break the exec response.
 *
 * @param {object} record the stored sandbox record.
 * @returns {void}
 */
function refreshusage(record) {
  try {
    const usage = store.sandboxusage(record.id);
    record.usage = usage;
    store.updatesandboxusage(record.id, usage.files, usage.bytes);
  } catch {
    /* usage bookkeeping is best effort */
  }
}

/* ------------------------------------------------------------------ */
/* context: sandboxes, statemachine and ttlreaper                      */
/* ------------------------------------------------------------------ */

/**
 * in-memory sandbox store: id -> record. the record carries the api
 * lifecycle fields plus the private engine state consumed by dispatch
 * and the owning userid persisted in the sandboxes table.
 */
const sandboxes = new Map();

/**
 * creates a sandbox record: id, the created -> running state machine with
 * the 125 ms firecracker ramp, the resolved spec, the owning user and
 * the dispatcher state built by createsandboxstate. the row is mirrored
 * into the sqlite sandboxes table. malformed requests throw errors
 * carrying status and code fields consumed by the route handler.
 *
 * @param {{model?: string, vcpus?: number, ramgb?: number, gpu?: string,
 *   mig?: string, quotamb?: number}} body the creation request; the cpu
 *   model comes from the reviewed catalog, quotamb picks the persistent
 *   workspace quota (4-256 MiB).
 * @param {{id: string}} user the authenticated owner.
 * @returns {object} the stored sandbox record.
 */
function createsandbox(body, user) {
  // no per-user sandbox cap by design: the project is open source and the
  // shelf grows with the account; the workspace quota per sandbox already
  // bounds the database, and operators who want a cap set SADDLE_MAX_SANDBOXES
  // (0 or unset means unlimited - the default).
  const configuredcap = Math.max(0, Number(process.env.SADDLE_MAX_SANDBOXES ?? '0') || 0);
  if (configuredcap > 0) {
    const mine = store.listsandboxesbyuser(user.id, 1000).filter(
      (row) => row.state !== 'destroyed',
    );
    if (mine.length >= configuredcap) {
      throw Object.assign(
        new Error(`sandbox limit reached for this account (${configuredcap}); delete one to create another`),
        { code: 'sandbox-limit', status: 429 },
      );
    }
  }
  // user chosen persistent workspace quota, 4-256 MiB, capped by the node
  // maximum inside db.writefile; omitted falls back to the node default.
  let quotabytes;
  if (body.quotamb !== undefined) {
    const mb = Number(body.quotamb);
    if (!Number.isFinite(mb) || mb < 4 || mb > 256) {
      throw Object.assign(new Error('quotamb must be between 4 and 256'), {
        code: 'invalid-quota',
        status: 400,
      });
    }
    quotabytes = Math.round(mb * 1024 * 1024);
  }
  // the reviewed catalog is the only source of processor identity: users
  // pick any listed model; brand new processors join through a pull
  // request (readme section), never through runtime free-form input.
  // catalog lookup accepts both the display name (AMD EPYC 9965) and the
  // catalog id (epyc-9965) so /specs/cpus consumers can echo ids back.
  const cpu = getcpu(body.model ?? cpudata[0].model) ?? getcpubyid(body.model ?? '');
  if (cpu === undefined) {
    throw Object.assign(
      new Error(
        `unknown cpu model "${body.model}"; valid models: ${cpudata.map((entry) => entry.model).join(', ')} (new processors join the catalog by pull request)`,
      ),
      { code: 'unknown-model', status: 400 },
    );
  }
  const gpu = getgpu(body.gpu ?? gpudata[0].id);
  if (gpu === undefined) {
    throw Object.assign(
      new Error(
        `unknown gpu "${body.gpu}"; valid gpus: ${gpudata.map((entry) => entry.id).join(', ')}`,
      ),
      { code: 'unknown-gpu', status: 400 },
    );
  }
  // vcpu ceiling follows the chosen catalog identity (its own thread
  // count); the web caller picks any model and any topology up to it.
  const vcpumax = cpu.threads;
  const vcpus = body.vcpus === undefined ? 8 : Number(body.vcpus);
  if (!Number.isInteger(vcpus) || vcpus < 1 || vcpus > vcpumax) {
    throw Object.assign(
      new Error(`vcpus must be an integer between 1 and ${vcpumax}`),
      { code: 'invalid-vcpus', status: 400 },
    );
  }
  if (vcpus > cpu.threads) {
    throw Object.assign(
      new Error(
        `model ${cpu.model} exposes at most ${cpu.threads} threads; ${vcpus} were requested`,
      ),
      { code: 'invalid-vcpus', status: 400 },
    );
  }
  // user defined virtual memory: the identity accepts any plan from 1 gb
  // up to 18 tb (the spoofing layer reports exactly this number; real
  // execution is bounded by the host overcommit policy as documented in
  // web/readme.md bottleneck analysis).
  const ramgb = body.ramgb === undefined ? 32 : Number(body.ramgb);
  if (!Number.isFinite(ramgb) || ramgb < 1 || ramgb > 18432) {
    throw Object.assign(new Error('ramgb must be between 1 and 18432'), {
      code: 'invalid-ram',
      status: 400,
    });
  }
  const mig = body.mig === undefined || body.mig === '' ? 'off' : String(body.mig);
  if (mig !== 'off' && getmig(mig) === null) {
    throw Object.assign(
      new Error(
        `unknown mig profile "${mig}"; valid profiles: ${migprofiles.map((entry) => entry.id).join(', ')} or off`,
      ),
      { code: 'invalid-mig', status: 400 },
    );
  }
  const id = randomUUID();
  const engine = createSandboxState({ model: cpu.model, vcpus, ramgb, gpu: gpu.id, mig, id });
  const now = Date.now();
  const record = {
    id,
    userid: user.id,
    state: 'created',
    spec: { model: cpu.model, vcpus, ramgb, gpu: gpu.id, mig },
    createdat: now,
    startedat: null,
    expiresat: now + ttlms,
    execcount: 0,
    lastcommand: null,
    usage: { files: 0, bytes: 0 },
    engine,
    fscontext: sandboxfscontext(id, quotabytes),
  };
  sandboxes.set(id, record);
  store.createsandboxrecord({
    id,
    userid: user.id,
    model: cpu.model,
    vcpus,
    ramgb,
    gpu: gpu.id,
    state: 'created',
    createdat: new Date(now).toISOString(),
    expiresat: new Date(now + ttlms).toISOString(),
    quotabytes: quotabytes ?? null,
  });
  store.addevent({ topic: 'sandbox.created', payload: { id, userid: user.id, model: cpu.model } });
  const ramp = setTimeout(() => {
    try {
      if (record.state === 'created') {
        record.state = 'running';
        record.startedat = Date.now();
      }
    } catch {
      /* state flip is best effort */
    }
  }, startrampms);
  ramp.unref?.();
  return record;
}

/**
 * destroys one sandbox in memory and in the sqlite mirror, purging its
 * workspace files with it (the manual delete is the purge path); the
 * lifecycle event is emitted for the dashboard poll.
 *
 * @param {object} record the stored sandbox record.
 * @returns {void}
 */
function destroysandbox(record) {
  record.state = 'destroyed';
  sandboxes.delete(record.id);
  try {
    store.updatesandboxstate(record.id, 'destroyed');
    store.deletesandboxfiles(record.id);
    store.addevent({ topic: 'sandbox.destroyed', payload: { id: record.id } });
  } catch {
    /* the memory state machine stays authoritative */
  }
}

/**
 * expires one sandbox past its ttl: the in-memory record drops and the
 * row flips to expired, but the workspace files are kept by design so
 * the container stays self-contained (the data lives with the sandbox
 * id until a manual delete purges it).
 *
 * @param {object} record the stored sandbox record.
 * @returns {void}
 */
function expiresandbox(record) {
  record.state = 'expired';
  sandboxes.delete(record.id);
  try {
    store.updatesandboxstate(record.id, 'expired');
    store.addevent({
      topic: 'sandbox.expired',
      payload: { id: record.id, fileskept: true, persist: workspacepersist() },
    });
  } catch {
    /* the memory state machine stays authoritative */
  }
}

/**
 * projects the public view of a sandbox record (the engine state stays
 * private to the process).
 *
 * @param {object} record the stored sandbox record.
 * @returns {object} the json-safe status document.
 */
function publicview(record) {
  return {
    id: record.id,
    state: record.state,
    model: record.spec.model,
    vcpus: record.spec.vcpus,
    ramgb: record.spec.ramgb,
    gpu: record.spec.gpu,
    mig: record.spec.mig,
    spec: record.spec,
    createdAt: new Date(record.createdat).toISOString(),
    startedAt: record.startedat === null ? null : new Date(record.startedat).toISOString(),
    expiresAt: new Date(record.expiresat).toISOString(),
    ttlSeconds: Math.max(0, Math.round((record.expiresat - Date.now()) / 1000)),
    execCount: record.execcount,
    lastCommand: record.lastcommand,
    usage: record.usage ?? { files: 0, bytes: 0 },
  };
}

/**
 * ttl reaper: destroys sandboxes past their expiry every sweep period
 * (mirroring the state into sqlite); the interval is unref'd so the
 * process can exit cleanly.
 *
 * @returns {NodeJS.Timeout} the sweep timer.
 */
function startreaper() {
  const timer = setInterval(() => {
    try {
      const now = Date.now();
      for (const [, record] of sandboxes) {
        if (record.expiresat <= now) {
          expiresandbox(record);
        }
      }
    } catch {
      /* the sweep never crashes the server */
    }
  }, sweepperiodms);
  timer.unref?.();
  return timer;
}

/**
 * resolves whether one user may touch one sandbox record: the owner or
 * any admin.
 *
 * @param {object} record the stored sandbox record.
 * @param {object} user the authenticated user.
 * @returns {boolean} the verdict.
 */
function ownssandbox(record, user) {
  return record.userid === user.id || user.role === 'admin';
}

/* ------------------------------------------------------------------ */
/* context: bodyreader                                                 */
/* ------------------------------------------------------------------ */

/**
 * reads the raw request body bounded to 64 kb; mesh verification needs
 * the exact bytes so the json parsing lives one layer above.
 *
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @returns {Promise<Buffer>} the raw body, empty when absent.
 */
function readrawbody(req) {
  return new Promise((resolvebody, rejectbody) => {
    try {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65536) {
          // deliver the 413 before tearing the socket down: pause the
          // stream, remove the data listener and let the response writer
          // flush first, so the client reads a real status line instead
          // of a connection reset.
          req.pause();
          req.removeAllListeners('data');
          req.removeAllListeners('end');
          rejectbody(
            Object.assign(new Error('request body exceeds 64 kb'), {
              code: 'payload-too-large',
              status: 413,
            }),
          );
          setImmediate(() => {
            req.destroy();
          });
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolvebody(Buffer.concat(chunks)));
      req.on('error', (error) => rejectbody(error));
    } catch (error) {
      rejectbody(error);
    }
  });
}

/**
 * reads and parses a json request body bounded to 64 kb.
 *
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @returns {Promise<unknown>} the parsed body or {} when absent.
 */
async function readbody(req) {
  const raw = await readrawbody(req);
  if (raw.length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('request body is not valid json'), {
      code: 'invalid-json',
      status: 400,
    });
  }
}

/* ------------------------------------------------------------------ */
/* context: staticfiles                                                */
/* ------------------------------------------------------------------ */

/**
 * serves one static file from web/ with traversal protection, streaming,
 * the real mime.types content types and the shared security headers.
 *
 * @param {string} urlpath the decoded url path.
 * @param {import('node:http').ServerResponse} res the outgoing response.
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @returns {void}
 */
/** backend sources never served to the edge: the api modules, the schema
 * files and the database artifacts stay inside the container even when a
 * static host mirrors this folder (defense in depth with the denylist). */
const staticdenyfiles = new Set([
  'server.js',
  'db.js',
  'auth.js',
  'mesh.js',
  'index.js',
  'init.sql',
  'schema.prisma',
  'drizzle.config.ts',
  'package.json',
  'package-lock.json',
  'caddyfile',
  'netlify.toml',
]);

function servestatic(urlpath, res, req) {
  const headers = securityheaders(req);
  try {
    const relative = urlpath === '/' ? 'console.html' : urlpath.replace(/^\/+/, '');
    // extensionless page routes: /login, /register and /dashboard map to
    // their html files so the deploy matrix (netlify vercel caddy) can use
    // clean urls while the file layout stays flat.
    const pagemap = {
      login: 'login.html',
      register: 'register.html',
      dashboard: 'dashboard.html',
    };
    const mapped = pagemap[relative] ?? relative;
    const safepath = normalize(join(webdir, mapped));
    if (!safepath.startsWith(webdir)) {
      res.writeHead(403, {
        'content-type': 'text/plain; charset=utf-8',
        ...headers,
      });
      res.end('forbidden');
      return;
    }
    const extension = extname(safepath).toLowerCase();
    const basename = safepath.split(sep).pop() ?? '';
    if (denylist.has(extension) || staticdenyfiles.has(basename)) {
      res.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
        ...headers,
      });
      res.end('not found');
      return;
    }
    // existence check before 200: a missing asset answers a real 404
    // instead of a 200 with an error body (the stream error path stays
    // as the race fallback).
    try {
      accessSync(safepath);
    } catch {
      res.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
        ...headers,
      });
      res.end('not found');
      return;
    }
    const type = contenttypefor(extension);
    const stream = createReadStream(safepath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(404, {
          'content-type': 'text/plain; charset=utf-8',
          ...headers,
        });
      }
      res.end('not found');
    });
    res.writeHead(200, {
      'content-type': type,
      'cache-control': cachefor(extension),
      ...headers,
    });
    stream.pipe(res);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', ...headers });
    res.end('internal server error');
  }
}

/* ------------------------------------------------------------------ */
/* context: authroutes                                                 */
/* ------------------------------------------------------------------ */

/**
 * handles the auth surface: register (first user of an empty node is
 * promoted to admin - the documented bootstrap), login with the generic
 * invalid credentials failure, logout and me. clone nodes forward
 * register and login to the main authority and cache the returned
 * session locally.
 *
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @param {import('node:http').ServerResponse} res the outgoing response.
 * @param {string} path the api-relative path.
 * @param {string[]} segments the path segments.
 * @returns {Promise<boolean>} true when the request was handled.
 */
async function handleauth(req, res, path, segments) {
  if (segments[0] !== 'auth') {
    return false;
  }
  const headers = respondheaders(req, 'credentials');
  const ip = clientip(req);
  const useragent = clientuseragent(req);

  /* POST /auth/register */
  if (req.method === 'POST' && path === '/auth/register') {
    const limit = ratelimit(`register:${ip}`, ratelimits.register.limit, ratelimits.register.windowms);
    if (!limit.allowed) {
      writeerror(res, 429, 'rate-limited', `too many registrations; retry in ${limit.retryafter} s`, {
        ...headers,
        'retry-after': String(limit.retryafter),
      });
      return true;
    }
    try {
      const body = await readbody(req);
      if (body === null || typeof body !== 'object') {
        writeerror(res, 400, 'invalid-body', 'request body must be a json object', headers);
        return true;
      }
      const usernamecheck = validateusername(body.username);
      if (!usernamecheck.ok) {
        writeerror(res, 400, usernamecheck.code, usernamecheck.message, headers);
        return true;
      }
      const passwordcheck = validatepassword(body.password);
      if (!passwordcheck.ok) {
        writeerror(res, 400, passwordcheck.code, passwordcheck.message, headers);
        return true;
      }
      if (role === 'clone' && mainurl().length > 0 && meshsecret().length > 0) {
        const forwarded = await forwardauth('register', body);
        await cacheforwarded(forwarded, req, headers, res);
        return true;
      }
      const existing = store.finduserbyname(String(body.username));
      if (existing !== null) {
        writeerror(res, 409, 'username-taken', 'username is already registered', headers);
        return true;
      }
      const { passwordhash, salt } = hashpassword(String(body.password));
      const userrole = bootstraprole(String(body.username));
      const user = store.createuser({
        username: String(body.username),
        passwordhash,
        salt,
        role: userrole,
      });
      const session = createsession(user.id, { ip, useragent });
      store.addaudit({ userid: user.id, action: 'register', detail: `role ${userrole}`, ip });
      store.addevent({ topic: 'auth.register', payload: { userid: user.id, username: user.username } });
      writejson(
        res,
        201,
        { user: { id: user.id, username: user.username, role: user.role, createdAt: user.createdat } },
        { ...headers, 'set-cookie': cookiefor(session.token, req) },
      );
    } catch (error) {
      writeerror(
        res,
        error?.status ?? 500,
        error?.code ?? 'register-failed',
        safemsg(error),
        headers,
      );
    }
    return true;
  }

  /* POST /auth/login */
  if (req.method === 'POST' && path === '/auth/login') {
    const limit = ratelimit(`login:${ip}`, ratelimits.login.limit, ratelimits.login.windowms);
    if (!limit.allowed) {
      writeerror(res, 429, 'rate-limited', `too many login attempts; retry in ${limit.retryafter} s`, {
        ...headers,
        'retry-after': String(limit.retryafter),
      });
      return true;
    }
    try {
      const body = await readbody(req);
      if (body === null || typeof body !== 'object') {
        writeerror(res, 400, 'invalid-body', 'request body must be a json object', headers);
        return true;
      }
      if (role === 'clone' && mainurl().length > 0 && meshsecret().length > 0) {
        const forwarded = await forwardauth('login', body);
        await cacheforwarded(forwarded, req, headers, res);
        return true;
      }
      const user = store.finduserbyname(String(body.username ?? ''));
      let valid = false;
      if (user === null) {
        valid = burndummy();
      } else {
        valid = verifypassword(
          String(body.password ?? ''),
          String(user.passwordhash),
          String(user.salt),
        );
      }
      if (user === null || !valid) {
        store.addaudit({ action: 'login-failed', detail: String(body.username ?? ''), ip });
        writeerror(res, 401, 'invalid-credentials', 'invalid credentials', headers);
        return true;
      }
      const now = new Date().toISOString();
      store.updatelastlogin(user.id, now);
      const session = createsession(user.id, { ip, useragent });
      store.addaudit({ userid: user.id, action: 'login', ip });
      store.addevent({ topic: 'auth.login', payload: { userid: user.id, username: user.username } });
      writejson(
        res,
        200,
        { user: { id: user.id, username: user.username, role: user.role } },
        { ...headers, 'set-cookie': cookiefor(session.token, req) },
      );
    } catch (error) {
      writeerror(
        res,
        error?.status ?? 500,
        error?.code ?? 'login-failed',
        safemsg(error),
        headers,
      );
    }
    return true;
  }

  /* POST /auth/logout */
  if (req.method === 'POST' && path === '/auth/logout') {
    try {
      const token = extracttoken(req);
      let userid = null;
      if (token !== null) {
        const user = requireauth(req);
        userid = user?.id ?? null;
        destroysession(token);
      }
      store.addaudit({ userid, action: 'logout', ip });
      writejson(res, 200, { ok: true }, { ...headers, 'set-cookie': cookieclear() });
    } catch (error) {
      writeerror(
        res,
        500,
        'logout-failed',
        safemsg(error),
        headers,
      );
    }
    return true;
  }

  /* GET /auth/me */
  if (req.method === 'GET' && path === '/auth/me') {
    const user = requireauth(req);
    if (user === null) {
      writeerror(res, 401, 'unauthorized', 'authentication required', headers);
      return true;
    }
    writejson(res, 200, { user }, headers);
    return true;
  }

  writeerror(res, 404, 'not-found', `no auth route for ${req.method} ${path}`, headers);
  return true;
}

/**
 * relays one forwarded auth response (clone mode): the main node's
 * set-cookie is re-issued to the caller and the session row is cached
 * locally with the remote userid so requireauth works on the clone.
 *
 * @param {{status: number, body: unknown, setcookie: string[]}} forwarded
 *   the main node response.
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @param {Record<string, string>} headers the prepared headers.
 * @param {import('node:http').ServerResponse} res the outgoing response.
 * @returns {Promise<void>} resolves when the response is written.
 */
async function cacheforwarded(forwarded, req, headers, res) {
  const ip = clientip(req);
  const useragent = clientuseragent(req);
  const cookie = forwarded.setcookie.find((entry) => entry.startsWith('saddlesession='));
  const user =
    forwarded.body !== null && typeof forwarded.body === 'object'
      ? forwarded.body?.user
      : null;
  if (
    forwarded.status >= 200 &&
    forwarded.status < 300 &&
    typeof cookie === 'string' &&
    user !== null &&
    typeof user === 'object'
  ) {
    const token = cookie.split(';')[0].slice('saddlesession='.length);
    /* cache the remote user row (best effort) so requireauth resolves
     * sessions minted by the main authority on the clone too */
    try {
      if (store.finduserbyid(String(user.id)) === null) {
        store.createuser({
          id: String(user.id),
          username: String(user.username),
          passwordhash: 'mesh-forwarded',
          salt: 'mesh-forwarded',
          role: typeof user.role === 'string' ? user.role : 'user',
          createdat: typeof user.createdAt === 'string' ? user.createdAt : undefined,
        });
      }
    } catch {
      /* the row may already exist under a race; the session below still
       * resolves through the main node's next forward */
    }
    cachesession({
      token,
      userid: String(user.id),
      expiresat: new Date(Date.now() + sessionttlms).toISOString(),
      ip,
      useragent,
    });
    writejson(res, forwarded.status, forwarded.body, { ...headers, 'set-cookie': cookie });
    return;
  }
  writeerror(
    res,
    forwarded.status >= 400 ? forwarded.status : 502,
    forwarded.body?.error?.code ?? 'mesh-forward-failed',
    forwarded.body?.error?.message ?? 'the main node rejected the request',
    headers,
  );
}

/* ------------------------------------------------------------------ */
/* context: meshroutes                                                 */
/* ------------------------------------------------------------------ */

/**
 * handles the signed mesh surface: clone registration, heartbeats and
 * the node listing served by the main/standalone authority. every
 * request must carry the x-saddle-timestamp and x-saddle-signature
 * headers verified by mesh.js.
 *
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @param {import('node:http').ServerResponse} res the outgoing response.
 * @param {string} path the api-relative path.
 * @param {string[]} segments the path segments.
 * @returns {Promise<boolean>} true when the request was handled.
 */
async function handlemesh(req, res, path, segments) {
  if (segments[0] !== 'mesh') {
    return false;
  }
  const headers = respondheaders(req, 'credentials');
  const secret = meshsecret();
  if (secret.length === 0) {
    writeerror(res, 401, 'mesh-unconfigured', 'SADDLE_MESH_SECRET is not configured on this node', headers);
    return true;
  }
  let raw = '';
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    raw = (await readrawbody(req)).toString('utf8');
  }
  const verdict = verifymesh(req, raw, secret);
  if (!verdict.ok) {
    writeerror(res, verdict.status, verdict.code, verdict.message, headers);
    return true;
  }

  /* POST /mesh/register */
  if (req.method === 'POST' && path === '/mesh/register') {
    try {
      const body = raw.length === 0 ? {} : JSON.parse(raw);
      const url = String(body?.url ?? '').trim();
      if (url.length === 0) {
        writeerror(res, 400, 'invalid-body', 'url is required', headers);
        return true;
      }
      const node = store.registernode({
        url,
        region: typeof body?.region === 'string' ? body.region : undefined,
        rolename: typeof body?.rolename === 'string' ? body.rolename : undefined,
        meta: body?.meta === undefined ? undefined : JSON.stringify(body.meta),
      });
      store.addaudit({ action: 'mesh-register', detail: url, ip: clientip(req) });
      store.addevent({ topic: 'mesh.register', payload: { nodeid: node.id, url } });
      writejson(res, 200, { nodeid: node.id, url: node.url, status: node.status }, headers);
    } catch {
      writeerror(res, 400, 'invalid-json', 'request body is not valid json', headers);
    }
    return true;
  }

  /* POST /mesh/heartbeat */
  if (req.method === 'POST' && path === '/mesh/heartbeat') {
    try {
      const body = raw.length === 0 ? {} : JSON.parse(raw);
      const nodeid = String(body?.nodeid ?? '');
      if (nodeid.length === 0) {
        writeerror(res, 400, 'invalid-body', 'nodeid is required', headers);
        return true;
      }
      const alive = store.heartbeatnode(nodeid, new Date().toISOString());
      if (!alive) {
        writeerror(res, 404, 'node-not-found', `no node with id ${nodeid}`, headers);
        return true;
      }
      writejson(res, 200, { ok: true, nodeid }, headers);
    } catch {
      writeerror(res, 400, 'invalid-json', 'request body is not valid json', headers);
    }
    return true;
  }

  /* GET /mesh/nodes — the main (or standalone) authority lists nodes */
  if (req.method === 'GET' && path === '/mesh/nodes') {
    if (role === 'clone') {
      writeerror(res, 403, 'mesh-nodes-main-only', 'the node listing is served by the main node', headers);
      return true;
    }
    writejson(res, 200, { nodes: store.listnodes() }, headers);
    return true;
  }

  writeerror(res, 404, 'not-found', `no mesh route for ${req.method} ${path}`, headers);
  return true;
}

/* ------------------------------------------------------------------ */
/* context: adminroutes                                                */
/* ------------------------------------------------------------------ */

/**
 * handles the admin surface: overview counts, users, nodes, sandboxes
 * and the audit trail. access requires an authenticated admin user; on
 * clone nodes the surface answers 403 pointing at the main authority.
 *
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @param {import('node:http').ServerResponse} res the outgoing response.
 * @param {string} path the api-relative path.
 * @param {string[]} segments the path segments.
 * @returns {boolean} true when the request was handled.
 */
function handleadmin(req, res, path, segments) {
  if (segments[0] !== 'admin') {
    return false;
  }
  const headers = respondheaders(req, 'credentials');
  const user = requireauth(req);
  if (user === null) {
    writeerror(res, 401, 'unauthorized', 'authentication required', headers);
    return true;
  }
  if (user.role !== 'admin') {
    writeerror(res, 403, 'forbidden', 'admin role required', headers);
    return true;
  }
  if (role === 'clone') {
    writeerror(res, 403, 'admin-main-only', 'the admin api is served by the main node', headers);
    return true;
  }
  if (req.method !== 'GET') {
    writeerror(res, 405, 'method-not-allowed', 'admin routes accept GET only', headers);
    return true;
  }

  try {
    if (path === '/admin/overview') {
      const counts = store.counts();
      writejson(
        res,
        200,
        {
          counts: {
            users: counts.users,
            nodes: counts.nodes,
            sandboxes: counts.sandboxes,
            sessions: counts.sessions,
            events: counts.events,
          },
          uptime: Math.round(process.uptime()),
          role,
          version,
        },
        headers,
      );
      return true;
    }
    if (path === '/admin/users') {
      const users = store.listusers().map((row) => ({
        id: row.id,
        username: row.username,
        role: row.role,
        createdat: row.createdat,
        lastlogin: row.lastlogin,
      }));
      writejson(res, 200, { users }, headers);
      return true;
    }
    if (path === '/admin/nodes') {
      writejson(res, 200, { nodes: store.listnodes() }, headers);
      return true;
    }
    if (path === '/admin/sandboxes') {
      writejson(res, 200, { sandboxes: store.listsandboxes() }, headers);
      return true;
    }
    if (path === '/admin/audit') {
      writejson(res, 200, { audit: store.listaudit() }, headers);
      return true;
    }
  } catch (error) {
    writeerror(
      res,
      500,
      'admin-query-failed',
      safemsg(error),
      headers,
    );
    return true;
  }

  writeerror(res, 404, 'not-found', `no admin route for ${req.method} ${path}`, headers);
  return true;
}

/* ------------------------------------------------------------------ */
/* context: eventsroute                                                */
/* ------------------------------------------------------------------ */

/**
 * handles GET /api/v1/events?since=<id>: the dashboard poll over the
 * durable events table (auth, sandbox and mesh topics).
 *
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @param {import('node:http').ServerResponse} res the outgoing response.
 * @param {URL} url the parsed request url.
 * @returns {boolean} true when the request was handled.
 */
function handleevents(req, res, url) {
  const headers = respondheaders(req, 'credentials');
  /** resolves whether a sandbox id belongs to the caller (event scoping). */
  const minehas = (candidate) => {
    try {
      const row = store.findsandboxbyid(candidate);
      return row !== undefined && row.userid === user?.id;
    } catch {
      return false;
    }
  };
  const user = requireauth(req);
  if (user === null) {
    writeerror(res, 401, 'unauthorized', 'authentication required', headers);
    return true;
  }
  if (req.method !== 'GET') {
    writeerror(res, 405, 'method-not-allowed', 'events accepts GET only', headers);
    return true;
  }
  try {
    const since = Math.max(0, Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0);
    const isadmin = user.role === 'admin';
    const rows = store.listevents(since, 100);
    // cross-tenant privacy: regular users only see events whose payload
    // references their own user id (auth topics) or their sandbox ids; the
    // admin role keeps the global stream for the management dashboard.
    const events = [];
    for (const row of rows) {
      const payload = parsetolerant(row.payload);
      if (isadmin === false) {
        const owns =
          payload?.userid === user.id ||
          (typeof payload?.id === 'string' && minehas(payload.id));
        if (owns === false) continue;
      }
      events.push({
        id: row.id,
        topic: row.topic,
        payload,
        nodeid: row.nodeid,
        createdAt: row.createdat,
      });
    }
    const lastid = events.length > 0 ? events[events.length - 1].id : since;
    writejson(res, 200, { events, lastid }, headers);
  } catch (error) {
    writeerror(
      res,
      500,
      'events-query-failed',
      safemsg(error),
      headers,
    );
  }
  return true;
}

/**
 * parses one json payload string, tolerating null and plain strings.
 *
 * @param {string | null} value the stored payload.
 * @returns {unknown} the parsed value or the raw string.
 */
function parsetolerant(value) {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/* ------------------------------------------------------------------ */
/* context: routing and api endpoints                                  */
/* ------------------------------------------------------------------ */

/**
 * executes one command against a sandbox record and updates the counters;
 * shared by the exec route.
 *
 * @param {object} record the sandbox record.
 * @param {unknown} body the parsed request body.
 * @param {import('node:http').ServerResponse} res the outgoing response.
 * @param {Record<string, string>} headers the prepared headers.
 * @returns {void}
 */
function execcommand(record, body, res, headers) {
  const command = String(body?.command ?? '');
  if (command.trim().length === 0) {
    writeerror(res, 400, 'invalid-command', 'command must be a non-empty string', headers);
    return;
  }
  const head = command.trim().split(/\s+/)[0];
  const mutatesworkspace =
    head === 'touch' || head === 'rm' || (head === 'echo' && /\s(>>|>)\s*\S/.test(command));
  const started = performance.now();
  const result = dispatch(command, record.engine, record.fscontext);
  const durationms = Math.max(0, Math.round((performance.now() - started) * 1000) / 1000);
  record.execcount += 1;
  record.lastcommand = command;
  if (mutatesworkspace) {
    refreshusage(record);
  }
  writejson(
    res,
    200,
    {
      output: result.output,
      exitCode: result.exitCode,
      durationMs: durationms,
    },
    headers,
  );
}

/**
 * handles one /api/v1 request.
 *
 * @param {import('node:http').IncomingMessage} req the incoming request.
 * @param {import('node:http').ServerResponse} res the outgoing response.
 * @param {URL} url the parsed request url.
 * @returns {Promise<void>} resolves when the response is written.
 */
async function handleapi(req, res, url) {
  const path = url.pathname.replace(/^\/api\/v1/, '') || '/';
  const segments = path.split('/').filter((segment) => segment.length > 0);

  if (req.method === 'OPTIONS') {
    const origin = req.headers?.origin;
    const credentialed = typeof origin === 'string' && allowedorigins().includes(origin);
    res.writeHead(204, {
      ...securityheaders(req),
      ...corsheaders(req, credentialed ? 'credentials' : 'public'),
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }

  /* GET /health — public */
  if (req.method === 'GET' && path === '/health') {
    writejson(
      res,
      200,
      {
        ok: true,
        version,
        uptime: Math.round(process.uptime()),
        role,
        db: store.healthcheck(),
        sandboxquota: store.sandboxquota(),
      },
      respondheaders(req, 'public'),
    );
    return;
  }

  /* GET /specs/cpus | /specs/gpus | /specs/memory — public */
  if (req.method === 'GET' && segments[0] === 'specs' && segments.length === 2) {
    const headers = respondheaders(req, 'public');
    try {
      const document = await getspeccatalog(segments[1]);
      writejson(res, 200, document, headers);
    } catch (error) {
      writeerror(res, 404, 'unknown-catalog', safemsg(error), headers);
    }
    return;
  }

  /* /auth/* */
  if (await handleauth(req, res, path, segments)) {
    return;
  }

  /* /mesh/* */
  if (await handlemesh(req, res, path, segments)) {
    return;
  }

  /* /admin/* */
  if (handleadmin(req, res, path, segments)) {
    return;
  }

  /* GET /events?since= */
  if (segments[0] === 'events') {
    handleevents(req, res, url);
    return;
  }

  /* POST /sandboxes — requires an authenticated user */
  if (req.method === 'POST' && path === '/sandboxes') {
    const headers = respondheaders(req, 'credentials');
    const user = requireauth(req);
    if (user === null) {
      writeerror(res, 401, 'unauthorized', 'authentication required', headers);
      return;
    }
    try {
      const body = await readbody(req);
      if (body === null || typeof body !== 'object') {
        writeerror(res, 400, 'invalid-body', 'request body must be a json object', headers);
        return;
      }
      const record = createsandbox(body, user);
      store.addaudit({
        userid: user.id,
        action: 'sandbox-create',
        detail: record.id,
        ip: clientip(req),
      });
      writejson(res, 201, publicview(record), headers);
    } catch (error) {
      writeerror(
        res,
        error?.status ?? 400,
        error?.code ?? 'invalid-request',
        safemsg(error),
        headers,
      );
    }
    return;
  }

  /* GET /sandboxes - the caller container shelf: every sandbox row of the
     authenticated user, live and expired alike, with workspace usage so
     the dashboard can offer "take your container back" on any id whose
     files survived (expired keeps files by design until manual delete). */
  if (segments[0] === 'sandboxes' && segments.length === 1 && req.method === 'GET') {
    const headers = respondheaders(req, 'credentials');
    const user = requireauth(req);
    if (user === null) {
      writeerror(res, 401, 'unauthorized', 'authentication required', headers);
      return;
    }
    try {
      const rows = store.listsandboxesbyuser(user.id);
      const shelf = rows.map((row) => {
        const live = sandboxes.get(row.id);
        let usage = { files: 0, bytes: 0 };
        try {
          usage = store.sandboxusage(row.id);
        } catch {
          /* empty workspace */
        }
        return {
          id: row.id,
          state: live === undefined ? row.state : live.state,
          model: row.model,
          vcpus: row.vcpus,
          ramgb: row.ramgb,
          gpu: row.gpu,
          createdAt: row.createdat,
          expiresAt: row.expiresat,
          files: usage.files,
          bytes: usage.bytes,
          resumable: usage.files > 0,
        };
      });
      writejson(res, 200, { sandboxes: shelf }, headers);
    } catch (error) {
      writeerror(res, 500, 'shelf-failed', safemsg(error), headers);
    }
    return;
  }

  /* GET /sandboxes/:id | DELETE /sandboxes/:id */
  if (segments[0] === 'sandboxes' && segments.length === 2) {
    const headers = respondheaders(req, 'credentials');
    const user = requireauth(req);
    if (user === null) {
      writeerror(res, 401, 'unauthorized', 'authentication required', headers);
      return;
    }
    const record = sandboxes.get(segments[1]);
    if (record === undefined) {
      // expired (or post-restart) sandboxes live on as db rows with their
      // workspace files; a DELETE here is the manual purge the shelf
      // promises - no resume round trip required.
      if (req.method === 'DELETE') {
        try {
          const row = store.findsandboxbyid(String(segments[1] ?? ''));
          if (row == null || row.userid !== user.id) {
            writeerror(res, 404, 'sandbox-not-found', `no sandbox with id ${segments[1]}`, headers);
            return;
          }
          store.updatesandboxstate(segments[1], 'destroyed');
          store.deletesandboxfiles(segments[1]);
          store.addaudit({
            userid: user.id,
            action: 'sandbox-delete',
            detail: segments[1],
            ip: clientip(req),
          });
          writejson(res, 200, { id: segments[1], state: 'destroyed', purged: true }, headers);
          return;
        } catch (error) {
          writeerror(res, 500, 'sandbox-purge-failed', safemsg(error), headers);
          return;
        }
      }
      writeerror(res, 404, 'sandbox-not-found', `no sandbox with id ${segments[1]}`, headers);
      return;
    }
    if (!ownssandbox(record, user)) {
      writeerror(res, 403, 'sandbox-forbidden', 'sandbox belongs to another user', headers);
      return;
    }
    if (req.method === 'GET') {
      writejson(res, 200, publicview(record), headers);
      return;
    }
    if (req.method === 'DELETE') {
      destroysandbox(record);
      store.addaudit({
        userid: user.id,
        action: 'sandbox-delete',
        detail: record.id,
        ip: clientip(req),
      });
      writejson(res, 200, { id: segments[1], state: 'destroyed' }, headers);
      return;
    }
    writeerror(res, 405, 'method-not-allowed', `method ${req.method} not allowed on /sandboxes/:id`, headers);
    return;
  }

  /* POST /sandboxes/:id/resume - take the container back: rebuilds the
     in-memory engine from the stored spec row, restores the persistent
     workspace binding and renews the ttl; files never left the id. */
  if (segments[0] === 'sandboxes' && segments.length === 3 && segments[2] === 'resume' && req.method === 'POST') {
    const headers = respondheaders(req, 'credentials');
    const user = requireauth(req);
    if (user === null) {
      writeerror(res, 401, 'unauthorized', 'authentication required', headers);
      return;
    }
    const id = decodeURIComponent(segments[1] ?? '');
    try {
      const row = store.findsandboxbyid(id);
      if (row == null || row.userid !== user.id) {
        writeerror(res, 404, 'not-found', 'sandbox not found for this user', headers);
        return;
      }
      if (sandboxes.has(id)) {
        writejson(res, 200, publicview(sandboxes.get(id)), headers);
        return;
      }
      const engine = createSandboxState({
        model: row.model,
        vcpus: row.vcpus,
        ramgb: row.ramgb,
        gpu: row.gpu,
        mig: 'off',
        id,
      });
      const now = Date.now();
      const record = {
        id,
        userid: user.id,
        state: 'running',
        spec: { model: row.model, vcpus: row.vcpus, ramgb: row.ramgb, gpu: row.gpu, mig: 'off' },
        createdat: Date.parse(row.createdat) || now,
        startedat: now,
        expiresat: now + ttlms,
        execcount: 0,
        lastcommand: null,
        usage: store.sandboxusage(id),
        engine,
        fscontext: sandboxfscontext(id, row.quotabytes ?? undefined),
      };
      sandboxes.set(id, record);
      store.updatesandboxstate(id, 'running');
      store.addaudit({ userid: user.id, action: 'sandbox-resume', detail: id, ip: clientip(req) });
      store.addevent({ topic: 'sandbox.resumed', payload: { id } });
      writejson(res, 200, publicview(record), headers);
    } catch (error) {
      writeerror(res, 500, 'resume-failed', safemsg(error), headers);
    }
    return;
  }

  /* POST /sandboxes/:id/exec */
  if (segments[0] === 'sandboxes' && segments.length === 3 && segments[2] === 'exec') {
    const headers = respondheaders(req, 'credentials');
    const user = requireauth(req);
    if (user === null) {
      writeerror(res, 401, 'unauthorized', 'authentication required', headers);
      return;
    }
    const record = sandboxes.get(segments[1]);
    if (record === undefined) {
      writeerror(res, 404, 'sandbox-not-found', `no sandbox with id ${segments[1]}`, headers);
      return;
    }
    if (!ownssandbox(record, user)) {
      writeerror(res, 403, 'sandbox-forbidden', 'sandbox belongs to another user', headers);
      return;
    }
    if (req.method !== 'POST') {
      writeerror(res, 405, 'method-not-allowed', 'exec accepts POST only', headers);
      return;
    }
    try {
      const body = await readbody(req);
      execcommand(record, body, res, headers);
    } catch (error) {
      writeerror(
        res,
        error?.status ?? 500,
        error?.code ?? 'exec-failed',
        safemsg(error),
        headers,
      );
    }
    return;
  }

  /* ---------------------------------------------------------------- */
  /* context: filesroutes — the persistent workspace surface           */
  /* GET /sandboxes/:id/files       list the workspace of one sandbox  */
  /* GET /sandboxes/:id/files/<path> read one stored file              */
  /* DELETE /sandboxes/:id/files/<path> remove one stored file         */
  /* ownership resolves through the in-memory record when present and  */
  /* falls back to the sandboxes row, so the files of an expired or    */
  /* restarted sandbox stay addressable by the owner (self-contained). */
  /* ---------------------------------------------------------------- */
  if (segments[0] === 'sandboxes' && segments.length >= 3 && segments[2] === 'files') {
    const headers = respondheaders(req, 'credentials');
    const user = requireauth(req);
    if (user === null) {
      writeerror(res, 401, 'unauthorized', 'authentication required', headers);
      return;
    }
    const id = segments[1];
    const record = sandboxes.get(id);
    let known = record !== undefined;
    let ownerok = false;
    if (record !== undefined) {
      ownerok = ownssandbox(record, user);
    } else {
      try {
        const row = store.findsandboxbyid(id);
        known = row !== null;
        ownerok = known && (row.userid === user.id || user.role === 'admin');
      } catch {
        known = false;
        ownerok = false;
      }
    }
    if (!known) {
      writeerror(res, 404, 'sandbox-not-found', `no sandbox with id ${id}`, headers);
      return;
    }
    if (!ownerok) {
      writeerror(res, 403, 'sandbox-forbidden', 'sandbox belongs to another user', headers);
      return;
    }
    try {
      if (segments.length === 3) {
        if (req.method !== 'GET') {
          writeerror(res, 405, 'method-not-allowed', 'the files listing accepts GET only', headers);
          return;
        }
        const files = store.listfiles(id);
        const usage = store.sandboxusage(id);
        if (record !== undefined) {
          record.usage = usage;
        }
        writejson(
          res,
          200,
          { files, usage, quota: store.sandboxquota() },
          headers,
        );
        return;
      }
      let filepath = '';
      try {
        filepath = decodeURIComponent(segments.slice(3).join('/'));
      } catch {
        filepath = segments.slice(3).join('/');
      }
      if (filepath.length > 0 && !filepath.startsWith('/')) {
        filepath = `/${filepath}`;
      }
      if (req.method === 'GET') {
        const file = store.readfile(id, filepath);
        if (file === null) {
          writeerror(res, 404, 'file-not-found', `no file ${filepath} in sandbox ${id}`, headers);
          return;
        }
        writejson(res, 200, file, headers);
        return;
      }
      if (req.method === 'DELETE') {
        const removed = store.deletefile(id, filepath);
        if (!removed) {
          writeerror(res, 404, 'file-not-found', `no file ${filepath} in sandbox ${id}`, headers);
          return;
        }
        const usage = store.sandboxusage(id);
        if (record !== undefined) {
          record.usage = usage;
        }
        try {
          store.updatesandboxusage(id, usage.files, usage.bytes);
        } catch {
          /* usage bookkeeping is best effort */
        }
        writejson(res, 200, { ok: true, path: filepath }, headers);
        return;
      }
      writeerror(res, 405, 'method-not-allowed', `method ${req.method} not allowed on sandbox files`, headers);
    } catch (error) {
      writeerror(
        res,
        500,
        'files-query-failed',
        safemsg(error),
        headers,
      );
    }
    return;
  }

  writeerror(
    res,
    404,
    'not-found',
    `no api route for ${req.method} ${path}`,
    respondheaders(req, 'public'),
  );
}

/* ------------------------------------------------------------------ */
/* context: httpserver, requestlogging and gracefulshutdown            */
/* ------------------------------------------------------------------ */

/** the http server: static files plus the /api/v1 router. */
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'saddle.internal'}`);
  if (url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')) {
    handleapi(req, res, url).catch((error) => {
      writeerror(res, 500, 'internal', safemsg(error));
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeerror(res, 405, 'method-not-allowed', 'static assets accept GET only');
    return;
  }
  // malformed percent sequences (/%zz) must answer 400, never crash the
  // process: a failed decode is a client error, not a server shutdown.
  let decodedpath;
  try {
    decodedpath = decodeURIComponent(url.pathname);
  } catch {
    writeerror(res, 400, 'bad-path', 'malformed percent-encoding in path');
    return;
  }
  servestatic(decodedpath, res, req);
});

/* graceful shutdown on sigint/sigterm: stops accepting, flushes, closes
 * the database and exits. */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try {
      server.close(() => {
        store.close();
        process.exit(0);
      });
      setTimeout(() => {
        store.close();
        process.exit(0);
      }, 1500).unref();
    } catch {
      process.exit(0);
    }
  });
}

startreaper();

/* the main authority sweeps expired sessions every 10 minutes. */
if (role === 'main') {
  const sweeper = setInterval(() => {
    try {
      store.cleansessions();
    } catch {
      /* the sweep never crashes the server */
    }
  }, sessionsweepperiodms);
  sweeper.unref?.();
}

/* clone nodes announce themselves to the main registry every 60 s. */
if (role === 'clone') {
  startheartbeat({
    url: String(process.env.SADDLE_NODE_URL ?? ''),
    region: String(process.env.SADDLE_REGION ?? ''),
    rolename: 'clone',
  });
}

/* seed the CODEOWNERS admin accounts (idempotent) so a fresh or wiped
 * database always carries the admin allowlist with the documented
 * bootstrap password; only the CODEOWNERS accounts (iakadion, inathlan,
 * aasblor, nasblor) are admins. */
const seededadmins = seedadmins();
if (seededadmins.length > 0) {
  process.stdout.write(`admin seed: ${seededadmins.join(', ')} (CODEOWNERS allowlist)\n`);
}

server.listen(port, host, () => {
  process.stdout.write(
    [
      `saddle web sandbox api v${version} (self-hosted node, zero deps, no serverless functions)`,
      `role: ${role}${role === 'clone' && mainurl().length > 0 ? ` -> main ${mainurl()}` : ''}`,
      `listening on ${host}:${port} (random default range 30000-59999; override with --port or PORT)`,
      `static root: ${webdir} (content types: ${mimetable.size} extensions from web/mime.types)`,
      `db: ${store.dbpath} (node:sqlite, mode 0o600)`,
      'endpoints: GET /api/v1/health | GET /api/v1/sandboxes (shelf) | POST /api/v1/sandboxes/:id/resume |',
      '  POST /api/v1/auth/register | POST /api/v1/auth/login | POST /api/v1/auth/logout |',
      '  GET /api/v1/auth/me | POST /api/v1/sandboxes (auth) | GET /api/v1/sandboxes/:id |',
      '  POST /api/v1/sandboxes/:id/exec | DELETE /api/v1/sandboxes/:id | GET /api/v1/events?since=',
      '  GET /api/v1/sandboxes/:id/files | GET/DELETE /api/v1/sandboxes/:id/files/<path> |',
      '  POST /api/v1/mesh/register | POST /api/v1/mesh/heartbeat | GET /api/v1/mesh/nodes (signed) |',
      '  GET /api/v1/admin/{overview,users,nodes,sandboxes,audit} (admin)',
      `sandbox ttl: ${ttlms / 60000} min, sweep every ${sweepperiodms / 1000} s`,
      `sandbox workspace: persistent per sandbox id, ${store.sandboxquota()} byte quota (SADDLE_SANDBOX_QUOTA_BYTES, default 16 MiB)`,
      `sandbox expiry keeps workspace files (self-contained); manual DELETE purges them${workspacepersist() ? ' [SADDLE_SANDBOX_PERSIST=true]' : ''}`,
    ].join('\n') + '\n',
  );
});

export { server, sandboxes, createsandbox, handleapi };
