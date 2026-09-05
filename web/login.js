  /**
   * login page controller: pure vanilla, zero dependencies. posts the
   * credentials to /api/v1/auth/login, keeps the session exclusively in
   * the saddlesession cookie (nothing sensitive is ever stored in
   * localstorage) and redirects to the sanitized ?next= target or
   * dashboard.html on success.
   *
   * static edge fallback: when no api answers at the resolved base (the
   * github pages / netlify / vercel clones), the submission verifies
   * against the browser-local accounts created on register.html through
   * localauth.js - clearly labeled, never synced; the self-hosted node
   * keeps the real cookie sessions.
   *
   * when this page is deployed as a static clone (vercel/netlify) the api
   * lives on another origin: the base url resolves from the ?api= query
   * string (persisted for convenience), window.SADDLE_API or the
   * "saddle_api" localstorage key, and cross-origin requests switch to
   * credentials: "include" so the session cookie still flows.
   */
  (function () {
    'use strict';

    const form = document.getElementById('loginform');
    const usernameinput = document.getElementById('username');
    const passwordinput = document.getElementById('password');
    const submitbtn = document.getElementById('submitbtn');
    const formerror = document.getElementById('formerror');
    const apistatus = document.getElementById('apistatus');

    /** resolves the api base: ?api= wins (and persists), then the
     *  window global, then localstorage, then same origin (''). */
    function apibase() {
      try {
        const fromquery = new URLSearchParams(window.location.search).get('api');
        if (fromquery !== null && fromquery.trim() !== '') {
          const trimmed = fromquery.trim().replace(/\/+$/, '');
          window.localStorage.setItem('saddle_api', trimmed);
          return trimmed;
        }
        const preset = window.SADDLE_API || window.localStorage.getItem('saddle_api') || '';
        return String(preset).trim().replace(/\/+$/, '');
      } catch {
        return '';
      }
    }

    /** true when the api base points at a different origin. */
    function iscrossorigin(base) {
      if (base === '') return false;
      try {
        return new URL(base, window.location.href).origin !== window.location.origin;
      } catch {
        return false;
      }
    }

    /** fetch wrapper: json in, json out, credentials follow the origin. */
    async function apifetch(path, options) {
      const base = apibase();
      const optionscopy = Object.assign({ headers: {} }, options);
      if (optionscopy.body !== undefined) {
        optionscopy.headers = Object.assign(
          { 'content-type': 'application/json' },
          optionscopy.headers,
        );
      }
      optionscopy.credentials = iscrossorigin(base) ? 'include' : 'same-origin';
      return fetch(base + path, optionscopy);
    }

    let localmode = false;

    function paintstatus() {
      const base = apibase();
      if (localmode) {
        apistatus.textContent = 'accounts: local browser (static edge, no api)';
        return;
      }
      apistatus.textContent = base === ''
        ? 'api: same origin'
        : `api: ${base} (cross-origin, credentials: include)`;
    }

    /** static edge detection: probe the api once; no answer -> local mode. */
    (async function detectlocal() {
      const base = apibase();
      const apianswers = await window.localauth.probe(base);
      if (!apianswers) {
        localmode = true;
        paintstatus();
      }
    })();

    /** only same-origin page-relative targets are honored; absolute urls,
     *  protocol relative (//host), backslash (\\host), scheme (javascript:,
     *  data:), control characters and path traversal are all rejected.
     *  targets stay page-relative (no leading slash) so the redirect works
     *  both on the self-hosted node (/, /login) and inside sub-path static
     *  hosting such as github pages (/saddle/login.html). the redirect
     *  target never depends on an unvalidated user value. */
    function safenext() {
      try {
        const raw = new URLSearchParams(window.location.search).get('next');
        if (raw === null) return 'dashboard.html';
        const decoded = decodeURIComponent(raw);
        if (!/^[A-Za-z0-9._\-\/]*$/.test(decoded)) return 'dashboard.html';
        if (decoded.trim() === '') return 'dashboard.html';
        if (decoded.startsWith('//') || decoded.startsWith('/\\')) return 'dashboard.html';
        if (decoded.includes('../') || decoded.includes('/./') || decoded.startsWith('./')) return 'dashboard.html';
        return decoded.replace(/^\/+/, '');
      } catch {
        return 'dashboard.html';
      }
    }

    function showerror(message) {
      formerror.textContent = message;
      formerror.classList.add('show');
    }

    function clearerror() {
      formerror.textContent = '';
      formerror.classList.remove('show');
    }

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      clearerror();
      const username = usernameinput.value.trim();
      const password = passwordinput.value;
      if (username.length === 0 || password.length === 0) {
        usernameinput.setAttribute('aria-invalid', username.length === 0 ? 'true' : 'false');
        passwordinput.setAttribute('aria-invalid', password.length === 0 ? 'true' : 'false');
        showerror('enter both the username and the password.');
        return;
      }
      usernameinput.removeAttribute('aria-invalid');
      passwordinput.removeAttribute('aria-invalid');
      submitbtn.disabled = true;
      submitbtn.textContent = 'signing in...';

      /* static edge: no api at this base -> verify the local account */
      if (localmode) {
        try {
          await window.localauth.login(username, password);
          window.location.assign(safenext());
        } catch (error) {
          showerror(error && error.message ? error.message : 'invalid username or password.');
          submitbtn.disabled = false;
          submitbtn.textContent = 'sign in';
        }
        return;
      }

      try {
        const response = await apifetch('/api/v1/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        if (response.ok) {
          window.location.assign(safenext());
          return;
        }
        if (response.status === 404) {
          showerror('auth is not available at this api target; set ?api=<main node url> and try again.');
          return;
        }
        /* generic message on purpose: no user enumeration, no cause leak */
        showerror('invalid username or password.');
      } catch {
        showerror('the api is unreachable; check the api target or try again later.');
      }
      submitbtn.disabled = false;
      submitbtn.textContent = 'sign in';
    });

    paintstatus();
    usernameinput.focus();
  })();
