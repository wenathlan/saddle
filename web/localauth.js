  /**
   * browser-local account fallback for the static edge (github pages,
   * netlify, vercel clones, file://): when no api backend answers at the
   * resolved base, the auth pages switch to local browser accounts so the
   * full interface still works on hosting without a server. local
   * accounts live ONLY in this browser (localstorage, pbkdf2-hashed
   * passwords through webcrypto); they never sync to the main node and
   * never hold real authority - the self-hosted node keeps the real
   * scrypt/cookie sessions (see web/readme.md, static-first design).
   *
   * the module is shared by login.js, register.js and dashboard.js and
   * exposes:
   *   localauth.probe(base)   - promise<boolean>, true when the api answers
   *   localauth.available()   - local accounts exist
   *   localauth.register(u,p)- creates a local account (throws on conflict)
   *   localauth.login(u,p)    - verifies and opens a local session
   *   localauth.session()     - the open local session or null
   *   localauth.logout()      - closes the local session
   *
   * built-in admins: the CODEOWNERS accounts (iakadion, inathlan,
   * aasblor, nasblor) are
   * seeded as local admin accounts with a documented bootstrap password
   * the first time localauth loads. clearing the browser storage never
   * locks the interface out: the seed is re-applied whenever the store
   * is missing the admin entries, so "the account never comes back"
   * cannot happen on the static edge (vercel / netlify / github pages).
   * only the CODEOWNERS accounts are admins - every other locally
   * created account is a plain user.
   */
  window.localauth = (function () {
    'use strict';

    const userskey = 'saddle_local_users';
    const sessionkey = 'saddle_local_session';
    const iterations = 150000;

    /* the ONLY admin usernames: the CODEOWNERS list. mirror changes to
     * .github CODEOWNERS here (the two files are the same contract). */
    const adminusers = ['iakadion', 'inathlan', 'aasblor', 'nasblor'];

    /* bootstrap credentials for the seeded admins: the CODEOWNERS
     * shared password, kept in lockstep with the self-hosted node
     * (web/auth.js adminseedpassword) and the database seed. only the
     * CODEOWNERS accounts (iakadion, inathlan, aasblor, nasblor) carry
     * the admin role anywhere. */
    const adminseedpassword = 'cdw782FG7pjxQVw';

    function readusers() {
      try {
        const raw = window.localStorage.getItem(userskey);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    /** re-seeds the built-in admin accounts whenever the store is
     *  missing them (first visit, cleared storage, private mode). the
     *  seed is idempotent: an admin the operator re-registered with a
     *  custom password is never overwritten. */
    async function ensureadminseed() {
      const users = readusers();
      let changed = false;
      for (const name of adminusers) {
        if (!Object.prototype.hasOwnProperty.call(users, name)) {
          const salt = randomsalt();
          const password = adminseedpassword;
          users[name] = {
            salt,
            hash: await derive(password, salt),
            iterations,
            algorithm: 'pbkdf2-sha256',
            createdat: new Date().toISOString(),
            role: 'admin',
            seeded: true,
          };
          changed = true;
        }
      }
      if (changed) writeusers(users);
    }

    function writeusers(map) {
      window.localStorage.setItem(userskey, JSON.stringify(map));
      mirrorusers(map);
    }

    /* ---------------- persistence: the IndexedDB mirror ----------------
     * user accounts live in localStorage AND in an IndexedDB store; the
     * mirror is repaired in both directions on load, so a tool that
     * clears only one of them (or a partial eviction) never loses the
     * accounts - "the account never comes back" cannot happen. the
     * mirror also powers the explicit backup file: accounts can be
     * exported to a json keyfile and re-imported after a full wipe. */
    const idbname = 'saddle-auth';
    const idbstore = 'accounts';

    function openidb() {
      return new Promise((resolve) => {
        try {
          if (!window.indexedDB) {
            resolve(null);
            return;
          }
          const request = window.indexedDB.open(idbname, 1);
          request.onupgradeneeded = function () {
            request.result.createObjectStore(idbstore);
          };
          request.onsuccess = function () { resolve(request.result); };
          request.onerror = function () { resolve(null); };
        } catch {
          resolve(null);
        }
      });
    }

    function idbread(db) {
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(idbstore, 'readonly');
          const get = tx.objectStore(idbstore).get('users');
          get.onsuccess = function () { resolve(get.result ?? null); };
          get.onerror = function () { resolve(null); };
        } catch {
          resolve(null);
        }
      });
    }

    function idbwrite(db, map) {
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(idbstore, 'readwrite');
          tx.objectStore(idbstore).put(map, 'users');
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch {
          resolve(false);
        }
      });
    }

    /** mirrors the account map into IndexedDB (fire and forget). */
    async function mirrorusers(map) {
      const db = await openidb();
      if (db) await idbwrite(db, map);
    }

    /** restores localStorage from the IndexedDB mirror when the primary
     *  store lost the accounts (partial clear). */
    async function restorefrommirror() {
      try {
        const raw = window.localStorage.getItem(userskey);
        if (raw !== null && Object.keys(JSON.parse(raw)).length > 0) {
          return; /* primary store still carries accounts */
        }
      } catch {
        /* fall through to the mirror */
      }
      const db = await openidb();
      if (!db) return;
      const mirrored = await idbread(db);
      if (mirrored && typeof mirrored === 'object' && Object.keys(mirrored).length > 0) {
        window.localStorage.setItem(userskey, JSON.stringify(mirrored));
      }
    }

    /** exports every account (salt + hash only, never plaintext
     *  passwords) as a downloadable backup keyfile. */
    async function exportaccounts() {
      const map = readusers();
      const payload = {
        format: 'saddle-local-accounts/1',
        exportedat: new Date().toISOString(),
        accounts: map,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'saddle-accounts-backup.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      return Object.keys(map).length;
    }

    /** imports accounts from a backup keyfile (merges; the seed and
     *  operator-owned entries are never overwritten). */
    async function importaccounts(file) {
      const text = await file.text();
      const payload = JSON.parse(text);
      if (!payload || payload.format !== 'saddle-local-accounts/1' || typeof payload.accounts !== 'object') {
        throw new Error('not a saddle accounts backup file.');
      }
      const users = readusers();
      let imported = 0;
      for (const [name, record] of Object.entries(payload.accounts)) {
        if (!/^[a-z0-9.-]{3,32}$/.test(name)) continue;
        if (!record || typeof record.salt !== 'string' || typeof record.hash !== 'string') continue;
        if (Object.prototype.hasOwnProperty.call(users, name)) continue;
        users[name] = record;
        imported += 1;
      }
      writeusers(users);
      return imported;
    }

    function randomsalt() {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    function tohex(buffer) {
      return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
    }

    /** pbkdf2-sha256 hash of the password with the account salt. */
    async function derive(password, salt) {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'],
      );
      const bits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: encoder.encode(salt),
          iterations,
          hash: 'SHA-256',
        },
        key,
        256,
      );
      return tohex(bits);
    }

    /** constant-time-ish string compare (length-safe). */
    function safecompare(a, b) {
      if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
      let diff = 0;
      for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
      return diff === 0;
    }

    /** probes the api health endpoint with a short timeout. */
    async function probe(base) {
      try {
        const url = (base ? base.replace(/\/+$/, '') : '') + '/api/v1/health';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) return false;
        const body = await response.json();
        return body && body.ok === true;
      } catch {
        return false;
      }
    }

    async function register(username, password) {
      const users = readusers();
      if (Object.prototype.hasOwnProperty.call(users, username)) {
        throw new Error('that username is already registered on this browser.');
      }
      const salt = randomsalt();
      const hash = await derive(password, salt);
      users[username] = {
        salt,
        hash,
        iterations,
        algorithm: 'pbkdf2-sha256',
        createdat: new Date().toISOString(),
        role: roleof(username),
      };
      writeusers(users);
      opensession(username);
      return true;
    }

    async function login(username, password) {
      const users = readusers();
      const account = users[username];
      if (!account) throw new Error('no local account for that username on this browser.');
      const hash = await derive(password, account.salt);
      if (!safecompare(hash, account.hash)) throw new Error('wrong password.');
      opensession(username);
      return true;
    }

    function opensession(username) {
      const session = {
        user: username,
        mode: 'local',
        role: roleof(username),
        issuedat: Date.now(),
        expiresat: Date.now() + 12 * 60 * 60 * 1000,
      };
      window.localStorage.setItem(sessionkey, JSON.stringify(session));
    }

    function session() {
      try {
        const raw = window.localStorage.getItem(sessionkey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.mode !== 'local' || typeof parsed.user !== 'string') return null;
        if (typeof parsed.expiresat !== 'number' || parsed.expiresat < Date.now()) {
          window.localStorage.removeItem(sessionkey);
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    }

    function logout() {
      window.localStorage.removeItem(sessionkey);
    }

    function available() {
      return Object.keys(readusers()).length > 0;
    }

    /** the role of an account: 'admin' only for the CODEOWNERS names. */
    function roleof(username) {
      return adminusers.indexOf(String(username).toLowerCase()) !== -1
        ? 'admin'
        : 'user';
    }

    /** boot order: restore from the mirror first (so the seed sees the
     * accounts that survived a partial clear), then re-seed the admin
     * allowlist when missing. */
    (async function boot() {
      await restorefrommirror();
      await ensureadminseed();
    })();

    return {
      probe, register, login, session, logout, available, roleof,
      exportaccounts, importaccounts,
      adminusers: adminusers.slice(),
    };
  })();
