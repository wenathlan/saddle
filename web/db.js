/**
 * db.js — node:sqlite data layer for the e2ugh web node (v7-BACK).
 *
 * the whole persistence surface of a node (main or clone) lives in this
 * module: one sqlite database opened through the native node:sqlite
 * DatabaseSync driver, the embedded migrations (executeschema), prepared
 * statements memoized once per process and one small function api per
 * table. the file is created with mode 0o600 right after open because it
 * carries password hashes and session token hashes.
 *
 * contexts (11): dbopen, filemode, executeschema, users, sessions, nodes,
 * sandboxes, sandboxfiles, events, audit, counts.
 *
 * rules: lowercase identifiers, english jsdoc in third person, no emoji,
 * try/catch on every fallible path with the standardized {code,message}
 * error shape, node:* modules only, zero dependencies.
 */

import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import process from 'node:process';

/* ------------------------------------------------------------------ */
/* context: dbopen and filemode                                        */
/* ------------------------------------------------------------------ */

/**
 * resolves the database file location once at import time: the e2ugh_db
 * environment variable wins, then ./e2ugh.db relative to the current
 * working directory. the special value ":memory:" keeps the database in
 * ram (used by tests and throwaway boots).
 *
 * @returns {string} the database path handed to databasesync.
 */
function resolvedbpath() {
  try {
    const fromenv = process.env.E2UGH_DB ?? '';
    if (fromenv.length > 0) {
      return fromenv;
    }
    return resolve('./e2ugh.db');
  } catch {
    return resolve('./e2ugh.db');
  }
}

/** the database file path resolved once at module load. */
export const dbpath = resolvedbpath();

/**
 * builds the standardized database error thrown by every wrapper below.
 *
 * @param {string} code machine readable code prefixed with db-.
 * @param {string} message human readable explanation.
 * @returns {Error & {code: string}} the decorated error.
 */
function dberror(code, message) {
  // log internal technical details server-side only; the thrown error only
  // exposes the machine-readable code so no underlying driver stack trace or
  // sqlite error string can propagate to client responses (CodeQL
  // js/stack-trace-exposure). the `message` parameter is preserved on a
  // non-enumerable `internal` property for callers that need server-side
  // diagnostics without exposing anything to the network.
  if (typeof message === 'string' && message.length > 0) {
    console.error(`[db] ${code}: ${message}`);
  }
  // public messages are static, hardcoded strings keyed by code; they are
  // safe to surface in user-facing sandbox command output because they do
  // not depend on the underlying driver or stack trace.
  const publicmessages = {
    'quota-exceeded': 'quota exceeded',
    'invalid-quota': 'invalid quota',
    'db-createuser-failed': 'database error',
    'db-finduser-failed': 'database error',
    'db-writefile-failed': 'database error',
    'db-readfile-failed': 'database error',
    'db-sandbox-failed': 'database error',
    'db-session-failed': 'database error',
    'db-event-failed': 'database error',
    'db-audit-failed': 'database error',
  };
  const publicmessage = publicmessages[code] ?? code;
  const err = Object.assign(new Error(publicmessage), { code });
  Object.defineProperty(err, 'internal', {
    value: typeof message === 'string' ? message : '',
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(err, 'publicMessage', {
    value: publicmessage,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return err;
}

/**
 * opens the database, applies the pragma profile and tightens the file
 * mode to 0o600 (skipped for the in-memory database).
 *
 * @param {string} path the resolved database path.
 * @returns {import('node:sqlite').DatabaseSync} the opened database.
 */
function opendatabase(path) {
  const database = new DatabaseSync(path);
  database.exec('pragma busy_timeout = 2000;');
  if (path !== ':memory:') {
    try {
      chmodSync(path, 0o600);
    } catch {
      /* the mode is best effort on exotic filesystems */
    }
  }
  return database;
}

/**
 * resolves the per-sandbox workspace quota in bytes once per call: the
 * e2ugh_sandbox_quota_bytes environment variable wins (any positive
 * integer), otherwise the 16 mib default documented in the readme.
 *
 * @returns {number} the quota in bytes.
 */
export function sandboxquota() {
  try {
    const parsed = Number.parseInt(
      String(process.env.E2UGH_SANDBOX_QUOTA_BYTES ?? ''),
      10,
    );
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  } catch {
    /* a malformed value falls back to the default */
  }
  return 16 * 1024 * 1024;
}

/* ------------------------------------------------------------------ */
/* context: executeschema — embedded migrations                        */
/* ------------------------------------------------------------------ */

/**
 * the v7 schema plus the v10 sandboxfiles workspace table: users,
 * sessions, nodes, sandboxes (with the v10 files/bytes usage columns),
 * sandboxfiles, events and audit. every table is created with "if not
 * exists" so boots are idempotent and the same statements run against
 * any node role.
 */
const schema = `
create table if not exists users (
  id text primary key,
  username text not null unique,
  passwordhash text not null,
  salt text not null,
  role text not null default 'user',
  createdat text not null,
  lastlogin text
);
create table if not exists sessions (
  tokenhash text primary key,
  userid text not null,
  createdat text not null,
  expiresat text not null,
  ip text,
  useragent text
);
create index if not exists sessions_expiresat on sessions(expiresat);
create table if not exists nodes (
  id text primary key,
  url text not null,
  rolename text,
  region text,
  lastheartbeat text,
  status text,
  registeredat text not null,
  meta text
);
create table if not exists sandboxes (
  id text primary key,
  userid text,
  model text,
  vcpus integer,
  ramgb integer,
  gpu text,
  state text,
  createdat text,
  expiresat text,
  files integer,
  bytes integer
);
create index if not exists sandboxes_userid on sandboxes(userid);
create table if not exists sandboxfiles (
  id integer primary key autoincrement,
  sandboxid text not null,
  path text not null,
  content blob,
  size integer not null default 0,
  updatedat text not null,
  unique(sandboxid, path)
);
create index if not exists sandboxfiles_sandboxid on sandboxfiles(sandboxid);
create table if not exists events (
  id integer primary key autoincrement,
  topic text,
  payload text,
  nodeid text,
  createdat text not null
);
create index if not exists events_createdat on events(createdat);
create table if not exists audit (
  id integer primary key autoincrement,
  userid text,
  action text,
  detail text,
  ip text,
  createdat text not null
);
`;

/**
 * adds the v10 usage columns to pre-existing sandboxes tables; the
 * "duplicate column name" failure of a second boot is swallowed so the
 * migration is idempotent on any node age.
 *
 * @param {import('node:sqlite').DatabaseSync} target the database handle.
 * @returns {void}
 */
function migrateusagecolumns(target) {
  for (const column of ['files', 'bytes', 'quotabytes']) {
    try {
      target.exec(`alter table sandboxes add column ${column} integer;`);
    } catch {
      /* the column already exists; the alter is best effort */
    }
  }
}

/* ------------------------------------------------------------------ */
/* context: the connection and the prepared statement cache            */
/* ------------------------------------------------------------------ */

/** the single database connection owned by this module. */
let database = opendatabase(dbpath);

/** memoized prepared statements keyed by their sql text. */
const statements = new Map();

/**
 * returns the prepared statement for one sql text, preparing it once and
 * reusing it for the whole process lifetime.
 *
 * @param {string} sql the sql text.
 * @returns {import('node:sqlite').StatementSync} the prepared statement.
 */
function stmt(sql) {
  try {
    let prepared = statements.get(sql);
    if (prepared === undefined) {
      prepared = database.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  } catch (error) {
    throw dberror(
      'db-prepare-failed',
      `preparing "${sql.slice(0, 48)}..." failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* context: users                                                      */
/* ------------------------------------------------------------------ */

/**
 * creates one user row; the id is a fresh uuid unless the caller pins
 * one (the mesh forward path caches the main node's user rows with
 * their original ids so clone sessions resolve).
 *
 * @param {{id?: string, username: string, passwordhash: string,
 *   salt: string, role?: string, createdat?: string}} fields the user
 *   attributes.
 * @returns {{id: string, username: string, role: string,
 *   createdat: string}} the stored user projection.
 */
export function createuser(fields) {
  try {
    const id = fields.id ?? randomUUID();
    const createdat = fields.createdat ?? new Date().toISOString();
    stmt(
      'insert into users (id, username, passwordhash, salt, role, createdat, lastlogin) values (?, ?, ?, ?, ?, ?, null)',
    ).run(
      id,
      fields.username,
      fields.passwordhash,
      fields.salt,
      fields.role ?? 'user',
      createdat,
    );
    return { id, username: fields.username, role: fields.role ?? 'user', createdat };
  } catch (error) {
    throw dberror('db-createuser-failed', error instanceof Error ? error.message : String(error));
  }
}

/**
 * finds one user by username.
 *
 * @param {string} username the exact username.
 * @returns {object | null} the full row or null when absent.
 */
export function finduserbyname(username) {
  try {
    return (
      stmt('select * from users where username = ?').get(username) ?? null
    );
  } catch (error) {
    throw dberror('db-finduser-failed', error instanceof Error ? error.message : String(error));
  }
}

/**
 * finds one user by id.
 *
 * @param {string} id the user id.
 * @returns {object | null} the full row or null when absent.
 */
export function finduserbyid(id) {
  try {
    return stmt('select * from users where id = ?').get(id) ?? null;
  } catch (error) {
    throw dberror('db-finduser-failed', error instanceof Error ? error.message : String(error));
  }
}

/**
 * lists every user ordered by creation time; the route layer projects
 * out the password hash and salt columns.
 *
 * @returns {object[]} the full user rows.
 */
export function listusers() {
  try {
    return stmt('select * from users order by createdat asc').all();
  } catch (error) {
    throw dberror('db-listusers-failed', error instanceof Error ? error.message : String(error));
  }
}

/**
 * stamps the last login column with the given timestamp.
 *
 * @param {string} id the user id.
 * @param {string} isotime the iso timestamp.
 * @returns {void}
 */
export function updatelastlogin(id, isotime) {
  try {
    stmt('update users set lastlogin = ? where id = ?').run(isotime, id);
  } catch (error) {
    throw dberror('db-lastlogin-failed', error instanceof Error ? error.message : String(error));
  }
}

/* ------------------------------------------------------------------ */
/* context: sessions                                                   */
/* ------------------------------------------------------------------ */

/**
 * persists one session; only the sha256 token hash is stored, never the
 * bearer token itself.
 *
 * @param {{tokenhash: string, userid: string, expiresat: string,
 *   ip?: string, useragent?: string, createdat?: string}} fields the
 *   session attributes.
 * @returns {void}
 */
export function createsession(fields) {
  try {
    stmt(
      'insert into sessions (tokenhash, userid, createdat, expiresat, ip, useragent) values (?, ?, ?, ?, ?, ?)',
    ).run(
      fields.tokenhash,
      fields.userid,
      fields.createdat ?? new Date().toISOString(),
      fields.expiresat,
      fields.ip ?? null,
      fields.useragent ?? null,
    );
  } catch (error) {
    throw dberror('db-createsession-failed', error instanceof Error ? error.message : String(error));
  }
}

/**
 * finds one session row by token hash; expiry is enforced by the caller
 * (auth.js) so clones can forward remote sessions verbatim.
 *
 * @param {string} tokenhash the sha256 hex of the bearer token.
 * @returns {object | null} the session row or null.
 */
export function findsession(tokenhash) {
  try {
    return stmt('select * from sessions where tokenhash = ?').get(tokenhash) ?? null;
  } catch (error) {
    throw dberror('db-findsession-failed', error instanceof Error ? error.message : String(error));
  }
}

/**
 * deletes one session by token hash.
 *
 * @param {string} tokenhash the sha256 hex of the bearer token.
 * @returns {boolean} true when a row was removed.
 */
export function deletesession(tokenhash) {
  try {
    const result = stmt('delete from sessions where tokenhash = ?').run(tokenhash);
    return Number(result.changes) > 0;
  } catch (error) {
    throw dberror('db-deletesession-failed', error instanceof Error ? error.message : String(error));
  }
}

/**
 * removes every expired session (iso strings compare lexicographically).
 * the main node schedules this sweep at boot.
 *
 * @returns {number} the count of removed rows.
 */
export function cleansessions() {
  try {
    const now = new Date().toISOString();
    const result = stmt('delete from sessions where expiresat < ?').run(now);
    return Number(result.changes);
  } catch (error) {
    throw dberror('db-cleansessions-failed', error instanceof Error ? error.message : String(error));
  }
}

/* ------------------------------------------------------------------ */
/* context: nodes (the mesh registry)                                  */
/* ------------------------------------------------------------------ */

/**
 * registers or re-registers one node keyed by its url: an existing row
 * for the same url is refreshed (new heartbeat, online status) instead
 * of duplicated, so clones can re-register after a restart.
 *
 * @param {{url: string, rolename?: string, region?: string,
 *   meta?: string}} fields the node announcement.
 * @returns {{id: string, url: string, status: string}} the registry row.
 */
export function registernode(fields) {
  try {
    const now = new Date().toISOString();
    const existing =
      stmt('select id from nodes where url = ?').get(fields.url) ?? null;
    if (existing !== null) {
      stmt(
        'update nodes set rolename = ?, region = ?, lastheartbeat = ?, status = ?, meta = ? where id = ?',
      ).run(
        fields.rolename ?? 'clone',
        fields.region ?? null,
        now,
        'online',
        fields.meta ?? null,
        existing.id,
      );
      return { id: existing.id, url: fields.url, status: 'online' };
    }
    const id = randomUUID();
    stmt(
      'insert into nodes (id, url, rolename, region, lastheartbeat, status, registeredat, meta) values (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      fields.url,
      fields.rolename ?? 'clone',
      fields.region ?? null,
      now,
      'online',
      now,
      fields.meta ?? null,
    );
    return { id, url: fields.url, status: 'online' };
  } catch (error) {
    throw dberror('db-registernode-failed', error instanceof Error ? error.message : String(error));
  }
}

/**
 * stamps one node heartbeat.
 *
 * @param {string} id the node id.
 * @param {string} isotime the heartbeat timestamp.
 * @returns {boolean} true when the node id exists.
 */
export function heartbeatnode(id, isotime) {
  try {
    const result = stmt(
      'update nodes set lastheartbeat = ?, status = ? where id = ?',
    ).run(isotime, 'online', id);
    return Number(result.changes) > 0;
  } catch (error) {
    throw dberror('db-heartbeat-failed', error instanceof Error ? error.message : String(error));
  }
}

/**
 * lists every registered node ordered by registration time.
 *
 * @returns {object[]} the node rows.
 */
export function listnodes() {
  try {
    return stmt('select * from nodes order by registeredat asc').all();
  } catch (error) {
    throw dberror('db-listnodes-failed', error instanceof Error ? error.message : String(error));
  }
}

/* ------------------------------------------------------------------ */
/* context: sandboxes                                                  */
/* ------------------------------------------------------------------ */

/**
 * persists one sandbox lifecycle row mirroring the in-memory record.
 *
 * @param {{id: string, userid?: string, model?: string, vcpus?: number,
 *   ramgb?: number, gpu?: string, state: string, createdat?: string,
 *   expiresat?: string}} fields the sandbox projection.
 * @returns {void}
 */
export function createsandboxrecord(fields) {
  try {
    stmt(
      'insert into sandboxes (id, userid, model, vcpus, ramgb, gpu, state, createdat, expiresat, quotabytes) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      fields.id,
      fields.userid ?? null,
      fields.model ?? null,
      fields.vcpus ?? null,
      fields.ramgb ?? null,
      fields.gpu ?? null,
      fields.state,
      fields.createdat ?? new Date().toISOString(),
      fields.expiresat ?? null,
      fields.quotabytes ?? null,
    );
  } catch (error) {
    throw dberror(
      'db-createsandbox-failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * updates the state column of one sandbox row (running, destroyed, ...).
 *
 * @param {string} id the sandbox id.
 * @param {string} state the new state.
 * @returns {void}
 */
export function updatesandboxstate(id, state) {
  try {
    stmt('update sandboxes set state = ? where id = ?').run(state, id);
  } catch (error) {
    throw dberror(
      'db-updatesandbox-failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * lists every sandbox row, newest first.
 *
 * @param {number} limit the row cap.
 * @returns {object[]} the sandbox rows.
 */
export function listsandboxes(limit = 200) {
  try {
    return stmt('select * from sandboxes order by createdat desc limit ?').all(limit);
  } catch (error) {
    throw dberror(
      'db-listsandboxes-failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * lists the sandbox rows owned by one user, newest first.
 *
 * @param {string} userid the owner id.
 * @param {number} limit the row cap.
 * @returns {object[]} the sandbox rows.
 */
export function listsandboxesbyuser(userid, limit = 200) {
  try {
    return stmt(
      'select * from sandboxes where userid = ? order by createdat desc limit ?',
    ).all(userid, limit);
  } catch (error) {
    throw dberror(
      'db-listsandboxes-failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * finds one sandbox row by id; the files surface resolves ownership
 * through this lookup even when the in-memory record is gone (expired
 * sandbox or restarted process).
 *
 * @param {string} id the sandbox id.
 * @returns {object | null} the sandbox row or null.
 */
export function findsandboxbyid(id) {
  try {
    return stmt('select * from sandboxes where id = ?').get(id) ?? null;
  } catch (error) {
    throw dberror(
      'db-findsandbox-failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * stamps the workspace usage counters of one sandbox row.
 *
 * @param {string} id the sandbox id.
 * @param {number} files the file count.
 * @param {number} bytes the total content bytes.
 * @returns {void}
 */
export function updatesandboxusage(id, files, bytes) {
  try {
    stmt('update sandboxes set files = ?, bytes = ? where id = ?').run(
      Number(files) || 0,
      Number(bytes) || 0,
      id,
    );
  } catch (error) {
    throw dberror(
      'db-updatesandboxusage-failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/* ------------------------------------------------------------------ */
/* context: sandboxfiles — the persistent workspace                     */
/* ------------------------------------------------------------------ */

/**
 * decodes one stored content cell (node:sqlite may hand back a
 * uint8array for blob columns) into a utf8 string.
 *
 * @param {unknown} value the stored cell.
 * @returns {string} the decoded text.
 */
function decodecontent(value) {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8');
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

/**
 * writes (or overwrites) one workspace file; the sandbox quota caps the
 * summed size of every file of the sandbox and an over-quota write
 * throws the standardized "quota exceeded" error without touching the
 * stored rows.
 *
 * @param {string} sandboxid the sandbox id.
 * @param {string} path the normalized absolute path.
 * @param {string} content the file text.
 * @returns {{path: string, size: number, updatedat: string}} the write receipt.
 */
export function writefile(sandboxid, path, content, customquota) {
  try {
    const text = content === null || content === undefined ? '' : String(content);
    const size = Buffer.byteLength(text, 'utf8');
    const nodemax = sandboxquota();
    // per sandbox quota chosen at creation (4-256 MiB), always capped by
    // the node level maximum so a single id can never exceed the operator
    // budget; omitting it keeps the node default.
    const quota = customquota === undefined ? nodemax : Math.min(nodemax, Math.max(4 * 1024 * 1024, Number(customquota)));
    const existingrow = stmt(
      'select size from sandboxfiles where sandboxid = ? and path = ?',
    ).get(sandboxid, path);
    const previous = existingrow === undefined ? 0 : Number(existingrow.size) || 0;
    const usage = sandboxusage(sandboxid);
    if (usage.bytes - previous + size > quota) {
      throw dberror(
        'quota-exceeded',
        `quota exceeded: sandbox ${sandboxid} is capped at ${quota} bytes (usage ${usage.bytes - previous + size} bytes)`,
      );
    }
    const updatedat = new Date().toISOString();
    stmt(
      'insert into sandboxfiles (sandboxid, path, content, size, updatedat) values (?, ?, ?, ?, ?) ' +
        'on conflict(sandboxid, path) do update set content = excluded.content, size = excluded.size, updatedat = excluded.updatedat',
    ).run(sandboxid, path, text, size, updatedat);
    return { path, size, updatedat };
  } catch (error) {
    if (error instanceof Error && error.code === 'quota-exceeded') {
      throw error;
    }
    throw dberror(
      'db-writefile-failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * reads one workspace file.
 *
 * @param {string} sandboxid the sandbox id.
 * @param {string} path the normalized absolute path.
 * @returns {{path: string, content: string, size: number, updatedat: string} | null}
 *   the file document or null when absent.
 */
export function readfile(sandboxid, path) {
  try {
    const row = stmt(
      'select path, content, size, updatedat from sandboxfiles where sandboxid = ? and path = ?',
    ).get(sandboxid, path);
    if (row === undefined) {
      return null;
    }
    const content = decodecontent(row.content);
    return {
      path: String(row.path),
      content,
      size: Number(row.size) || Buffer.byteLength(content, 'utf8'),
      updatedat: String(row.updatedat),
    };
  } catch (error) {
    throw dberror(
      'db-readfile-failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * lists every workspace file of one sandbox ordered by path; contents
 * stay out of the projection.
 *
 * @param {string} sandboxid the sandbox id.
 * @returns {{path: string, size: number, updatedat: string}[]} the file rows.
 */
export function listfiles(sandboxid) {
  try {
    return stmt(
      'select path, size, updatedat from sandboxfiles where sandboxid = ? order by path asc',
    )
      .all(sandboxid)
      .map((row) => ({
        path: String(row.path),
        size: Number(row.size) || 0,
        updatedat: String(row.updatedat),
      }));
  } catch (error) {
    throw dberror(
      'db-listfiles-failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * deletes one workspace file.
 *
 * @param {string} sandboxid the sandbox id.
 * @param {string} path the normalized absolute path.
 * @returns {boolean} true when a row was removed.
 */
export function deletefile(sandboxid, path) {
  try {
    const result = stmt(
      'delete from sandboxfiles where sandboxid = ? and path = ?',
    ).run(sandboxid, path);
    return Number(result.changes) > 0;
  } catch (error) {
    throw dberror(
      'db-deletefile-failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * removes every workspace file of one sandbox; the purge path of the
 * delete endpoint calls this so a destroyed sandbox leaves nothing
 * behind.
 *
 * @param {string} sandboxid the sandbox id.
 * @returns {number} the count of removed rows.
 */
export function deletesandboxfiles(sandboxid) {
  try {
    const result = stmt('delete from sandboxfiles where sandboxid = ?').run(sandboxid);
    return Number(result.changes);
  } catch (error) {
    throw dberror(
      'db-deletesandboxfiles-failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * sums the workspace usage of one sandbox.
 *
 * @param {string} sandboxid the sandbox id.
 * @returns {{files: number, bytes: number}} the usage counters.
 */
export function sandboxusage(sandboxid) {
  try {
    const row = stmt(
      'select count(*) as files, coalesce(sum(size), 0) as bytes from sandboxfiles where sandboxid = ?',
    ).get(sandboxid);
    return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
  } catch (error) {
    throw dberror(
      'db-sandboxusage-failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/* ------------------------------------------------------------------ */
/* context: events (the durable local bus)                             */
/* ------------------------------------------------------------------ */

/**
 * appends one event row; the payload is stored as a json string.
 *
 * @param {{topic: string, payload?: unknown, nodeid?: string,
 *   createdat?: string}} fields the event envelope.
 * @returns {number} the inserted event id.
 */
export function addevent(fields) {
  try {
    let payload = null;
    if (fields.payload !== undefined) {
      payload = typeof fields.payload === 'string' ? fields.payload : JSON.stringify(fields.payload);
    }
    const result = stmt(
      'insert into events (topic, payload, nodeid, createdat) values (?, ?, ?, ?)',
    ).run(fields.topic, payload, fields.nodeid ?? null, fields.createdat ?? new Date().toISOString());
    return Number(result.lastInsertRowid);
  } catch (error) {
    throw dberror('db-addevent-failed', error instanceof Error ? error.message : String(error));
  }
}

/**
 * lists the events with id greater than the cursor, oldest first, so
 * the dashboard can poll /api/v1/events?since=<lastid>.
 *
 * @param {number} since the exclusive id cursor.
 * @param {number} limit the row cap.
 * @returns {object[]} the event rows.
 */
export function listevents(since = 0, limit = 100) {
  try {
    return stmt('select * from events where id > ? order by id asc limit ?').all(since, limit);
  } catch (error) {
    throw dberror('db-listevents-failed', error instanceof Error ? error.message : String(error));
  }
}

/* ------------------------------------------------------------------ */
/* context: audit                                                      */
/* ------------------------------------------------------------------ */

/**
 * appends one audit row (register, login, logout, sandbox lifecycle,
 * mesh registration).
 *
 * @param {{userid?: string, action: string, detail?: string,
 *   ip?: string, createdat?: string}} fields the audit envelope.
 * @returns {number} the inserted audit id.
 */
export function addaudit(fields) {
  try {
    const result = stmt(
      'insert into audit (userid, action, detail, ip, createdat) values (?, ?, ?, ?, ?)',
    ).run(
      fields.userid ?? null,
      fields.action,
      fields.detail ?? null,
      fields.ip ?? null,
      fields.createdat ?? new Date().toISOString(),
    );
    return Number(result.lastInsertRowid);
  } catch (error) {
    throw dberror('db-addaudit-failed', error instanceof Error ? error.message : String(error));
  }
}

/**
 * lists the audit trail, newest first.
 *
 * @param {number} limit the row cap.
 * @returns {object[]} the audit rows.
 */
export function listaudit(limit = 200) {
  try {
    return stmt('select * from audit order by id desc limit ?').all(limit);
  } catch (error) {
    throw dberror('db-listaudit-failed', error instanceof Error ? error.message : String(error));
  }
}

/* ------------------------------------------------------------------ */
/* context: counts and health                                          */
/* ------------------------------------------------------------------ */

/**
 * counts one table with a bound fallback of zero on any failure.
 *
 * @param {string} table one of users, sessions, nodes, sandboxes, events.
 * @returns {number} the row count.
 */
function count(table) {
  const allowed = new Set(['users', 'sessions', 'nodes', 'sandboxes', 'events', 'audit']);
  if (!allowed.has(table)) {
    throw dberror('db-count-failed', `refusing to count unknown table "${table}"`);
  }
  const row = stmt(`select count(*) as total from ${table}`).get();
  return Number(row?.total ?? 0);
}

/**
 * the overview counts consumed by get /api/v1/admin/overview.
 *
 * @returns {{users: number, sessions: number, nodes: number,
 *   sandboxes: number, events: number, audit: number}} the counts.
 */
export function counts() {
  try {
    return {
      users: count('users'),
      sessions: count('sessions'),
      nodes: count('nodes'),
      sandboxes: count('sandboxes'),
      events: count('events'),
      audit: count('audit'),
    };
  } catch (error) {
    throw dberror('db-counts-failed', error instanceof Error ? error.message : String(error));
  }
}

/**
 * runs the cheapest possible query so /api/v1/health can report whether
 * the database connection answers.
 *
 * @returns {boolean} true when the round trip succeeds.
 */
export function healthcheck() {
  try {
    return stmt('select 1 as ok').get()?.ok === 1;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* context: the singleton                                              */
/* ------------------------------------------------------------------ */

/**
 * applies the embedded schema migrations; exported for tools and tests
 * that want to reset or verify the schema explicitly.
 *
 * @param {import('node:sqlite').DatabaseSync} [target] an optional
 *   database handle (defaults to the module connection).
 * @returns {void}
 */
export function executeschema(target = database) {
  try {
    target.exec(schema);
    migrateusagecolumns(target);
  } catch (error) {
    throw dberror('db-schema-failed', error instanceof Error ? error.message : String(error));
  }
}

/** the store singleton: every api function plus close and dispose. */
const store = {
  dbpath,
  createuser,
  finduserbyname,
  finduserbyid,
  listusers,
  updatelastlogin,
  createsession,
  findsession,
  deletesession,
  cleansessions,
  registernode,
  heartbeatnode,
  listnodes,
  createsandboxrecord,
  updatesandboxstate,
  updatesandboxusage,
  findsandboxbyid,
  listsandboxes,
  listsandboxesbyuser,
  writefile,
  readfile,
  listfiles,
  deletefile,
  deletesandboxfiles,
  sandboxusage,
  sandboxquota,
  addevent,
  listevents,
  addaudit,
  listaudit,
  counts,
  healthcheck,
  executeschema,
  /** closes the connection (idempotent). */
  close() {
    try {
      database.close();
    } catch {
      /* closing twice or after dispose is a no-op */
    }
  },
  /** explicit resource management: `using` support for node >= 24. */
  [Symbol.dispose]() {
    this.close();
  },
};

/* the schema runs at import time so the very first request finds the
 * tables in place; a failure here is fatal by design (bad path, locked
 * file) and surfaces as a boot error instead of a runtime 500. */
executeschema();

export default store;
