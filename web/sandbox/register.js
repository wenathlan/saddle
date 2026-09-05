  /**
   * register page controller: pure vanilla, zero dependencies. validates
   * the username charset (3-32 of [a-z0-9.-], lowercased as the visitor
   * types), scores the password strength from length plus character
   * classes, requires the confirmation to match, then posts to
   * /api/v1/auth/register. on success the backend sets the e2ughsession
   * cookie and the page moves straight to the dashboard.
   *
   * static edge fallback: when no api answers at the resolved base (the
   * github pages / netlify / vercel clones), the submission creates a
   * browser-local account through localauth.js (pbkdf2-hashed in
   * localstorage, clearly labeled, never synced) so account creation
   * works on hosting without a server; the self-hosted node keeps the
   * real cookie sessions.
   *
   * the api base resolution mirrors login.html: ?api= query string
   * (persisted), window.E2UGH_API, the "e2ugh_api" localstorage key or
   * same origin; cross-origin targets switch to credentials: "include".
   */
  (function () {
    'use strict';

    const usernamere = /^[a-z0-9.-]{3,32}$/;

    const form = document.getElementById('registerform');
    const usernameinput = document.getElementById('username');
    const passwordinput = document.getElementById('password');
    const password2input = document.getElementById('password2');
    const password2hint = document.getElementById('password2hint');
    const submitbtn = document.getElementById('submitbtn');
    const formerror = document.getElementById('formerror');
    const apistatus = document.getElementById('apistatus');
    const meter = document.getElementById('meter');
    const meterlabel = document.getElementById('meterlabel');
    const rulelen = document.getElementById('rule-len');
    const rulecharset = document.getElementById('rule-charset');
    const rulepwlen = document.getElementById('rule-pw-len');
    const rulepwclass = document.getElementById('rule-pw-class');
    const usernamehint = document.getElementById('usernamehint');

    /** resolves the api base exactly like login.html. */
    function apibase() {
      try {
        const fromquery = new URLSearchParams(window.location.search).get('api');
        if (fromquery !== null && fromquery.trim() !== '') {
          const trimmed = fromquery.trim().replace(/\/+$/, '');
          window.localStorage.setItem('e2ugh_api', trimmed);
          return trimmed;
        }
        const preset = window.E2UGH_API || window.localStorage.getItem('e2ugh_api') || '';
        return String(preset).trim().replace(/\/+$/, '');
      } catch {
        return '';
      }
    }

    function iscrossorigin(base) {
      if (base === '') return false;
      try {
        return new URL(base, window.location.href).origin !== window.location.origin;
      } catch {
        return false;
      }
    }

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

    /** strength score 0-4: length gates, character classes add. */
    function strength(password) {
      if (password.length === 0) return 0;
      if (password.length < 8) return 1;
      let classes = 0;
      if (/[a-z]/.test(password)) classes += 1;
      if (/[A-Z]/.test(password)) classes += 1;
      if (/[0-9]/.test(password)) classes += 1;
      if (/[^a-zA-Z0-9]/.test(password)) classes += 1;
      if (password.length >= 12 && classes >= 3) return 4;
      if (classes >= 3 || (password.length >= 11 && classes >= 2)) return 3;
      if (classes === 2 || password.length >= 10) return 2;
      return 1;
    }

    const strengthnames = ['-', 'weak', 'fair', 'good', 'strong'];

    function paintmeter() {
      const score = strength(passwordinput.value);
      const segments = meter.querySelectorAll('span');
      segments.forEach(function (segment, index) {
        segment.className = index < score ? 'on-' + score : '';
      });
      meterlabel.textContent = 'strength: ' + strengthnames[score];
      rulepwlen.classList.toggle('ok', passwordinput.value.length >= 8);
      rulepwclass.classList.toggle(
        'ok',
        (/[a-z]/.test(passwordinput.value) ? 1 : 0) +
          (/[A-Z]/.test(passwordinput.value) ? 1 : 0) +
          (/[0-9]/.test(passwordinput.value) ? 1 : 0) +
          (/[^a-zA-Z0-9]/.test(passwordinput.value) ? 1 : 0) >=
          2,
      );
      paintconfirm();
    }

    function paintusername() {
      const value = usernameinput.value;
      rulelen.classList.toggle('ok', value.length >= 3 && value.length <= 32);
      const charsetok = usernamere.test(value);
      rulecharset.classList.toggle('ok', charsetok && value.length > 0);
      usernamehint.classList.toggle('bad', value.length > 0 && !charsetok);
      usernamehint.classList.toggle('ok', charsetok);
    }

    function paintconfirm() {
      const a = passwordinput.value;
      const b = password2input.value;
      if (b.length === 0) {
        password2hint.textContent = '\u00a0';
        password2hint.className = 'hint';
        return;
      }
      const match = a === b;
      password2hint.textContent = match ? 'passwords match.' : 'passwords do not match.';
      password2hint.className = 'hint ' + (match ? 'ok' : 'bad');
    }

    /* auto-lowercase the username while typing */
    usernameinput.addEventListener('input', function () {
      const lowered = usernameinput.value.toLowerCase();
      if (lowered !== usernameinput.value) {
        const position = usernameinput.selectionStart - (usernameinput.value.length - lowered.length);
        usernameinput.value = lowered;
        try {
          usernameinput.setSelectionRange(position, position);
        } catch {
          /* selection restore is cosmetic */
        }
      }
      paintusername();
    });

    passwordinput.addEventListener('input', paintmeter);
    password2input.addEventListener('input', paintconfirm);

    function showerror(message) {
      formerror.textContent = message;
      formerror.classList.add('show');
    }

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      formerror.classList.remove('show');

      const username = usernameinput.value;
      const password = passwordinput.value;
      const confirmation = password2input.value;

      let valid = true;
      if (!usernamere.test(username)) {
        usernameinput.setAttribute('aria-invalid', 'true');
        valid = false;
      } else {
        usernameinput.removeAttribute('aria-invalid');
      }
      if (password.length < 8) {
        passwordinput.setAttribute('aria-invalid', 'true');
        valid = false;
      } else {
        passwordinput.removeAttribute('aria-invalid');
      }
      if (password !== confirmation) {
        password2input.setAttribute('aria-invalid', 'true');
        valid = false;
      } else {
        password2input.removeAttribute('aria-invalid');
      }
      if (!valid) {
        showerror('fix the highlighted fields and try again.');
        return;
      }

      submitbtn.disabled = true;
      submitbtn.textContent = 'creating...';

      /* static edge: no api at this base -> browser-local account */
      if (localmode) {
        try {
          await window.localauth.register(username, password);
          window.location.assign('dashboard.html');
        } catch (error) {
          showerror(error && error.message ? error.message : 'local registration failed.');
          submitbtn.disabled = false;
          submitbtn.textContent = 'create account';
        }
        return;
      }

      try {
        const response = await apifetch('/api/v1/auth/register', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        if (response.ok) {
          window.location.assign('dashboard.html');
          return;
        }
        if (response.status === 404) {
          showerror('registration is not available at this api target; set ?api=<main node url> and try again.');
          return;
        }
        let message = 'registration failed; try again.';
        if (response.status === 400 || response.status === 409 || response.status === 429) {
          try {
            const payload = await response.json();
            if (payload && payload.error && typeof payload.error.message === 'string') {
              message = payload.error.message;
            }
          } catch {
            /* keep the generic message */
          }
        }
        showerror(message);
      } catch {
        showerror('the api is unreachable; check the api target or try again later.');
      }
      submitbtn.disabled = false;
      submitbtn.textContent = 'create account';
    });

    paintstatus();
    paintmeter();
    paintusername();
    usernameinput.focus();
  })();
