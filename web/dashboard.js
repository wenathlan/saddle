  /**
   * dashboard controller: pure vanilla, zero dependencies. user view for
   * any node (my sandboxes, bus events, account info) and the admin view
   * for the main node (overview, mesh nodes with ping, users, global
   * sandboxes, audit log). the session lives exclusively in the
   * e2ughsession cookie: no passwords or tokens are ever written to
   * localstorage (only the optional cross-origin api base, mirroring
   * login.html). every payload is rendered defensively through
   * textcontent because the backend routes ship in parallel.
   */
  (function () {
    'use strict';

    /* ---------------- api base + fetch wrapper ---------------- */

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

    /** json fetch with cookie credentials; resolves {ok, status, body}. */
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
      const response = await fetch(base + path, optionscopy);
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { ok: response.ok, status: response.status, body };
    }

    /* ---------------- tiny dom + parsing helpers ---------------- */

    /** creates an element, sets attributes and appends text/children. */
    function el(tag, attrs, children) {
      const node = document.createElement(tag);
      if (attrs) {
        for (const key of Object.keys(attrs)) {
          if (key === 'class') node.className = attrs[key];
          else if (key === 'text') node.textContent = attrs[key];
          else node.setAttribute(key, attrs[key]);
        }
      }
      if (children) for (const child of children) node.append(child);
      return node;
    }

    /** first defined value among candidate keys (case-flexible). */
    function pick(obj, keys, fallback) {
      if (obj === null || typeof obj !== 'object') return fallback;
      for (const key of keys) {
        if (obj[key] !== undefined && obj[key] !== null) return obj[key];
      }
      /* one case-insensitive pass for snake_case variants */
      const lower = {};
      for (const key of Object.keys(obj)) lower[key.toLowerCase()] = obj[key];
      for (const key of keys) {
        const hit = lower[key.toLowerCase()];
        if (hit !== undefined && hit !== null) return hit;
      }
      return fallback;
    }

    /** array out of a payload that may be a bare array or an envelope. */
    function asarray(payload, keys) {
      if (Array.isArray(payload)) return payload;
      if (payload !== null && typeof payload === 'object') {
        for (const key of keys) {
          if (Array.isArray(payload[key])) return payload[key];
        }
      }
      return [];
    }

    /** formats a date-ish value (iso string, epoch seconds or ms). */
    function fmtdate(value) {
      if (value === undefined || value === null || value === '') return '-';
      let date = null;
      if (typeof value === 'number') {
        date = new Date(value < 1e12 ? value * 1000 : value);
      } else {
        date = new Date(String(value));
      }
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
    }

    /** humanizes a duration in seconds. */
    function fmtuptime(seconds) {
      const total = Math.max(0, Math.floor(Number(seconds) || 0));
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      if (days > 0) return `${days}d ${hours}h`;
      if (hours > 0) return `${hours}h ${minutes}m`;
      return `${minutes}m ${total % 60}s`;
    }

    /** shows a panel error paragraph (or hides it when empty). */
    function panelerror(id, message) {
      const node = document.getElementById(id);
      if (!node) return;
      if (message) {
        node.textContent = message;
        node.hidden = false;
      } else {
        node.hidden = true;
      }
    }

    /* ---------------- element handles ---------------- */

    const fatal = document.getElementById('fatal');
    const fatalmessage = document.getElementById('fatalmessage');
    const rolebadge = document.getElementById('rolebadge');
    const userbadge = document.getElementById('userbadge');
    const logoutbtn = document.getElementById('logoutbtn');
    const tabuser = document.getElementById('tab-user');
    const tabadmin = document.getElementById('tab-admin');
    const paneluser = document.getElementById('panel-user');
    const paneladmin = document.getElementById('panel-admin');
    const boxskeleton = document.getElementById('boxskeleton');
    const boxlist = document.getElementById('boxlist');
    const boxempty = document.getElementById('boxempty');
    const boxerror = 'boxerror';
    const infolist = document.getElementById('infolist');
    const eventlist = document.getElementById('eventlist');
    const eventempty = document.getElementById('eventempty');
    const nodesbody = document.getElementById('nodesbody');
    const nodesempty = document.getElementById('nodesempty');
    const usersbody = document.getElementById('usersbody');
    const usersempty = document.getElementById('usersempty');
    const usersearch = document.getElementById('usersearch');
    const boxesbody = document.getElementById('boxesbody');
    const boxesempty = document.getElementById('boxesempty');
    const auditbody = document.getElementById('auditbody');
    const auditempty = document.getElementById('auditempty');

    let currentuser = null;
    let eventcursor = ''; /* ?since= value carried between polls */

    /* ---------------- fatal gate ---------------- */

    function showfatal(message) {
      fatalmessage.textContent = message;
      fatal.hidden = false;
      tabuser.disabled = true;
      tabadmin.disabled = true;
      paneluser.hidden = true;
    }

    /* ---------------- tabs ---------------- */

    function selecttab(tab) {
      const isuser = tab === tabuser;
      tabuser.setAttribute('aria-selected', isuser ? 'true' : 'false');
      tabadmin.setAttribute('aria-selected', isuser ? 'false' : 'true');
      tabuser.tabIndex = isuser ? 0 : -1;
      tabadmin.tabIndex = isuser ? -1 : 0;
      paneluser.hidden = !isuser;
      paneladmin.hidden = isuser;
      tab.focus();
    }

    tabuser.addEventListener('click', function () { selecttab(tabuser); });
    tabadmin.addEventListener('click', function () { selecttab(tabadmin); });
    document.querySelector('.tabs').addEventListener('keydown', function (event) {
      const tabs = [tabuser, tabadmin].filter(function (t) { return !t.hidden; });
      const index = tabs.indexOf(document.activeElement);
      if (index === -1) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const next = event.key === 'ArrowRight'
          ? tabs[(index + 1) % tabs.length]
          : tabs[(index - 1 + tabs.length) % tabs.length];
        selecttab(next);
      }
    });

    /* ---------------- account bootstrap ---------------- */

    /** normalizes the node role out of a /health payload. */
    function noderole(health) {
      const raw = pick(health || {}, ['role', 'nodeRole', 'node', 'mode', 'kind'], 'standalone');
      if (raw !== null && typeof raw === 'object') {
        return String(pick(raw, ['role', 'kind', 'mode'], 'standalone')).toLowerCase();
      }
      return String(raw).toLowerCase();
    }

    async function loadhealth() {
      try {
        const result = await apifetch('/api/v1/health');
        if (result.ok && result.body) {
          const role = noderole(result.body);
          rolebadge.textContent = 'node: ' + role;
          if (role === 'main' || role === 'clone') rolebadge.classList.add(role);
          return;
        }
      } catch {
        /* health is decorative; the badge simply stays neutral */
      }
      rolebadge.textContent = 'node: standalone (no api)';
    }

    async function loadme() {
      let result;
      try {
        result = await apifetch('/api/v1/auth/me');
      } catch {
        showfatal('the api is unreachable; set the api target (?api=...) or try again later.');
        return;
      }
      if (result.status === 401 || result.status === 403) {
        showfatal('this page needs a signed in session.');
        return;
      }
      if (!result.ok || !result.body || typeof result.body !== 'object') {
        showfatal('the api answered but the account payload was not understood.');
        return;
      }
      const body = result.body.user && typeof result.body.user === 'object'
        ? result.body.user
        : result.body;
      currentuser = {
        username: String(pick(body, ['username', 'name', 'user'], 'unknown')),
        role: String(pick(body, ['role'], 'user')).toLowerCase(),
        createdat: pick(body, ['createdAt', 'created_at', 'createdat', 'registeredAt'], null),
        lastloginat: pick(body, ['lastLoginAt', 'last_login_at', 'lastlogin', 'lastLogin'], null),
        id: pick(body, ['id', 'uuid'], null),
      };
      userbadge.textContent = currentuser.username + (currentuser.role === 'admin' ? ' (admin)' : '');
      const rows = [
        el('dt', { text: 'username' }), el('dd', { text: currentuser.username }),
        el('dt', { text: 'role' }), el('dd', { text: currentuser.role }),
        el('dt', { text: 'created' }), el('dd', { text: fmtdate(currentuser.createdat) }),
        el('dt', { text: 'last login' }), el('dd', { text: fmtdate(currentuser.lastloginat) }),
      ];
      if (currentuser.id) {
        rows.push(el('dt', { text: 'id' }), el('dd', { text: String(currentuser.id) }));
      }
      infolist.replaceChildren(...rows);

      /* admin tab: admin-only, always - the CODEOWNERS allowlist on the
       * server side and the local role on the static edge. */
      tabadmin.hidden = currentuser.role !== 'admin';
      paneladmin.hidden = true;
      if (currentuser.role === 'admin') {
        loadadmin();
      }
      loadsandboxes();
      loadevents();
    }

    logoutbtn.addEventListener('click', async function () {
      logoutbtn.disabled = true;
      /* clears the local browser session too (no-op on the api mode) */
      window.localauth.logout();
      try {
        await apifetch('/api/v1/auth/logout', { method: 'POST' });
      } catch {
        /* the cookie may already be gone; proceed to the login page */
      }
      window.location.assign('login.html');
    });

    /* ---------------- spec selects (shared catalog, fallback) ---------------- */

    const fallbackcpus = [
      'AMD EPYC 9965', 'AMD Ryzen 9 9950X3D', 'AMD Threadripper PRO 9995WX',
      'AMD Threadripper 7980X', 'Intel Core Ultra 9 285K', 'AMD EPYC 9955',
      'Intel Xeon 6980P', 'Apple M3 Ultra',
    ];
    const fallbackgpus = ['rtx5090', 'rtxpro6000', 'b200', 'h100', 'a100', 'rx9070xt', 'mi350x'];

    async function loadspeccatalogs() {
      let cpus = fallbackcpus;
      let gpus = fallbackgpus;
      try {
        const mod = await import('./sandbox.js');
        if (Array.isArray(mod.cpudata) && mod.cpudata.length > 0) {
          cpus = mod.cpudata.map(function (cpu) { return cpu.model; });
        }
        if (Array.isArray(mod.gpudata) && mod.gpudata.length > 0) {
          gpus = mod.gpudata.map(function (gpu) { return gpu.id; });
        }
      } catch {
        /* static mirror without the module: the fallback list applies */
      }
      const modelsel = document.getElementById('newmodel');
      const gpusel = document.getElementById('newgpu');
      modelsel.replaceChildren(...cpus.map(function (model) {
        return el('option', { value: model, text: model });
      }));
      gpusel.replaceChildren(...gpus.map(function (id) {
        return el('option', { value: id, text: id });
      }));
    }

    /* ---------------- user view: sandboxes ---------------- */

    function sandboxrow(record) {
      const spec = pick(record, ['spec'], {}) || {};
      const spectext = [
        pick(spec, ['model'], '?'),
        'x' + pick(spec, ['vcpus'], '?') + ' vcpus',
        pick(spec, ['ramgb', 'ramGb', 'ram'], '?') + ' gb',
        pick(spec, ['gpu'], '?'),
        'mig ' + pick(spec, ['mig'], 'off'),
      ].join(' / ');
      const id = String(pick(record, ['id'], ''));
      const state = String(pick(record, ['state'], '?'));
      const actions = [
        el('a', {
          class: 'btn mini', href: '/index.html?sandbox=' + encodeURIComponent(id),
          'aria-label': 'open sandbox ' + id + ' in the terminal',
        }, [document.createTextNode('open')]),
      ];
      const row = el('li', {}, [
        el('div', { class: 'rowtop' }, [
          el('span', { class: 'id', text: id.slice(0, 13) + (id.length > 13 ? '...' : '') }),
          el('span', { class: 'chip ' + state, text: state }),
          el('span', { class: 'rowactions' }, actions),
        ]),
        el('span', { class: 'specs', text: spectext }),
        el('span', {
          class: 'meta',
          text: 'created ' + fmtdate(pick(record, ['createdAt', 'createdat', 'created_at'], null)) +
            ' / expires ' + fmtdate(pick(record, ['expiresAt', 'expiresat', 'expires_at'], null)) +
            ' / execs ' + String(pick(record, ['execCount', 'execcount'], 0)),
        }),
      ]);
      return row;
    }

    async function loadsandboxes() {
      let result;
      try {
        result = await apifetch('/api/v1/sandboxes');
      } catch {
        boxskeleton.hidden = true;
        panelerror(boxerror, 'the sandbox list is unreachable right now.');
        return;
      }
      if (result.status === 401 || result.status === 403) {
        boxskeleton.hidden = true;
        panelerror(boxerror, 'the session expired; sign in again.');
        return;
      }
      boxskeleton.hidden = true;
      panelerror(boxerror, '');
      if (result.status === 404) {
        /* the list endpoint is not live on this node yet (v7 rollout) */
        boxlist.replaceChildren();
        boxempty.hidden = false;
        boxempty.textContent = 'the sandbox list is not live on this node yet; creation still works.';
        return;
      }
      const items = asarray(result.body, ['sandboxes', 'items', 'data', 'list']);
      boxempty.textContent =
        'no sandboxes yet; create one above or boot the local engine from the console.';
      if (items.length === 0) {
        boxlist.replaceChildren();
        boxempty.hidden = false;
        return;
      }
      boxempty.hidden = true;
      boxlist.replaceChildren(...items.map(sandboxrow));
    }

    /* localmode guards: the api-mode handlers below stay dormant when
     * the dashboard runs on the browser-local sandbox engine. */
    let localmode = false;

    document.getElementById('refreshbtn').addEventListener('click', function () {
      if (localmode) return;
      boxskeleton.hidden = false;
      boxlist.replaceChildren();
      boxempty.hidden = true;
      loadsandboxes();
    });

    document.getElementById('createform').addEventListener('submit', async function (event) {
      event.preventDefault();
      if (localmode) return;
      const errornode = document.getElementById('createerror');
      const button = document.getElementById('createbtn');
      errornode.hidden = true;
      button.disabled = true;
      const spec = {
        model: document.getElementById('newmodel').value,
        vcpus: Number(document.getElementById('newvcpus').value),
        ramgb: Number(document.getElementById('newram').value),
        gpu: document.getElementById('newgpu').value,
        mig: document.getElementById('newmig').value,
      };
      try {
        const result = await apifetch('/api/v1/sandboxes', {
          method: 'POST',
          body: JSON.stringify(spec),
        });
        if (result.ok) {
          loadsandboxes();
        } else {
          const message = result.body && result.body.error
            ? result.body.error.message
            : 'creation failed with status ' + result.status + '.';
          errornode.textContent = String(message);
          errornode.hidden = false;
        }
      } catch {
        errornode.textContent = 'the api is unreachable; the sandbox was not created.';
        errornode.hidden = false;
      }
      button.disabled = false;
    });

    /* ---------------- user view: bus events ---------------- */

    function eventitem(entry) {
      const topic = String(pick(entry, ['topic', 'type', 'event', 'name'], 'event'));
      const detail = pick(entry, ['detail', 'data', 'message', 'payload'], '');
      const at = pick(entry, ['at', 'ts', 'time', 'createdAt', 'created_at', 'when'], null);
      const kind = /exec/i.test(topic) ? 'exec' : (/mesh|node|ping/i.test(topic) ? 'mesh' : 'lifecycle');
      const item = el('li', { class: kind }, [
        el('span', { class: 'time', text: fmtdate(at) + ' ' }),
        el('span', { class: 'topic', text: topic }),
        el('span', { class: 'detail', text: typeof detail === 'string' ? detail : JSON.stringify(detail) }),
      ]);
      return item;
    }

    async function loadevents() {
      try {
        const query = eventcursor === '' ? '' : '?since=' + encodeURIComponent(eventcursor);
        const result = await apifetch('/api/v1/events' + query);
        if (!result.ok) return;
        const items = asarray(result.body, ['events', 'items', 'data', 'list']);
        const lastid = pick(result.body, ['lastid', 'lastId'], null);
        if (lastid !== null && lastid !== undefined) eventcursor = String(lastid);
        if (items.length === 0 && eventlist.contains(eventempty)) return;
        const nodes = items.map(function (entry) {
          const next = pick(entry, ['id', 'seq'], null);
          if (next !== null && next !== undefined) eventcursor = String(next);
          return eventitem(entry);
        });
        if (eventlist.contains(eventempty)) eventempty.remove();
        eventlist.prepend(...nodes);
        while (eventlist.children.length > 50) eventlist.lastChild.remove();
      } catch {
        /* the next poll retries silently */
      }
    }

    setInterval(function () {
      if (document.visibilityState !== 'visible' || fatal.hidden === false) return;
      if (currentuser !== null) loadevents();
    }, 10000);

    setInterval(function () {
      if (document.visibilityState !== 'visible' || fatal.hidden === false) return;
      if (currentuser !== null && !localmode) loadsandboxes();
    }, 30000);

    /* ---------------- admin view ---------------- */

    async function loadoverview() {
      try {
        const result = await apifetch('/api/v1/admin/overview');
        if (!result.ok || !result.body) {
          document.getElementById('ov-users').textContent = 'n/a';
          return;
        }
        const body = result.body.counts && typeof result.body.counts === 'object'
          ? result.body.counts
          : (result.body.overview && typeof result.body.overview === 'object'
              ? result.body.overview
              : result.body);
        const values = {
          'ov-users': pick(body, ['users', 'userCount', 'totalUsers', 'usercount'], 'n/a'),
          'ov-nodes': pick(body, ['nodes', 'nodeCount', 'totalNodes', 'nodecount'], 'n/a'),
          'ov-sandboxes': pick(body, ['sandboxes', 'sandboxCount', 'totalSandboxes'], 'n/a'),
          'ov-sessions': pick(body, ['sessions', 'sessionCount', 'totalSessions'], 'n/a'),
          'ov-events': pick(body, ['events', 'eventCount', 'totalEvents'], 'n/a'),
          'ov-uptime': fmtuptime(pick(body, ['uptime', 'uptimeSeconds', 'uptime_seconds'], 0)),
        };
        for (const id of Object.keys(values)) {
          const node = document.getElementById(id);
          node.textContent = String(values[id]);
        }
      } catch {
        document.getElementById('ov-users').textContent = 'n/a';
      }
    }

    async function meshping(url) {
      /* primary contract: POST /api/v1/mesh/ping {url} server-side through
       * the signed mesh; when the node does not expose it yet, fall back
       * to a browser-side latency probe of the node health endpoint. */
      try {
        const post = await apifetch('/api/v1/mesh/ping', {
          method: 'POST',
          body: JSON.stringify({ url }),
        });
        if (post.ok) {
          const rtt = pick(post.body || {}, ['rttMs', 'rtt', 'latencyMs', 'latency'], null);
          return rtt !== null ? 'pong ' + String(rtt) + ' ms (mesh)' : 'pong (mesh)';
        }
      } catch {
        /* fall through to the client probe */
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(function () { controller.abort(); }, 4000);
        const started = performance.now();
        await fetch(String(url).replace(/\/+$/, '') + '/api/v1/health', {
          mode: 'no-cors',
          signal: controller.signal,
        });
        clearTimeout(timer);
        return 'pong ~' + Math.max(1, Math.round(performance.now() - started)) + ' ms (client probe)';
      } catch {
        return 'unreachable';
      }
    }

    function noderow(node) {
      const url = String(pick(node, ['url', 'endpoint', 'address', 'host'], '?'));
      const region = String(pick(node, ['region', 'location', 'zone'], '-'));
      const status = String(pick(node, ['status', 'state'], '?'));
      const heartbeat = pick(node, ['lastHeartbeat', 'lastHeartbeatAt', 'lastSeen', 'last_heartbeat'], null);
      const resultcell = el('td', { class: 'wrapcell', text: '-' });
      resultcell.setAttribute('role', 'status');
      resultcell.setAttribute('aria-live', 'polite');
      const pingbtn = el('button', {
        class: 'mini', type: 'button',
        'aria-label': 'ping mesh node ' + url,
      }, [document.createTextNode('ping')]);
      pingbtn.addEventListener('click', async function () {
        pingbtn.disabled = true;
        resultcell.textContent = 'pinging...';
        resultcell.textContent = await meshping(url);
        pingbtn.disabled = false;
      });
      return el('tr', {}, [
        el('td', { class: 'wrapcell', text: url }),
        el('td', { text: region }),
        el('td', {}, [el('span', { class: 'chip ' + status, text: status })]),
        el('td', { text: fmtdate(heartbeat) }),
        el('td', {}, [pingbtn, document.createTextNode(' '), resultcell]),
      ]);
    }

    async function loadnodes() {
      try {
        const result = await apifetch('/api/v1/admin/nodes');
        if (!result.ok) {
          nodesbody.replaceChildren();
          nodesempty.hidden = false;
          panelerror('nodeserror', 'node table unavailable (status ' + result.status + ').');
          return;
        }
        panelerror('nodeserror', '');
        const items = asarray(result.body, ['nodes', 'items', 'data', 'list']);
        nodesempty.hidden = items.length > 0;
        nodesbody.replaceChildren(...items.map(noderow));
      } catch {
        panelerror('nodeserror', 'the nodes endpoint is unreachable.');
      }
    }

    let allusers = [];

    function userrow(user) {
      const username = String(pick(user, ['username', 'name', 'user'], '?'));
      const role = String(pick(user, ['role'], 'user'));
      /* account fields only: hash and salt keys are deliberately ignored */
      return el('tr', { 'data-username': username.toLowerCase() }, [
        el('td', { text: username }),
        el('td', {}, [el('span', { class: 'chip ' + role, text: role })]),
        el('td', { text: fmtdate(pick(user, ['lastLoginAt', 'last_login_at', 'lastlogin'], null)) }),
        el('td', { text: fmtdate(pick(user, ['createdAt', 'created_at', 'createdat'], null)) }),
      ]);
    }

    function paintusers() {
      const query = usersearch.value.trim().toLowerCase();
      const rows = allusers.filter(function (user) {
        const username = String(pick(user, ['username', 'name', 'user'], ''));
        return query === '' || username.toLowerCase().includes(query);
      });
      usersempty.hidden = rows.length > 0;
      usersempty.textContent = query === ''
        ? 'no users registered yet.'
        : 'no users match "' + query + '".';
      usersbody.replaceChildren(...rows.map(userrow));
    }

    usersearch.addEventListener('input', paintusers);

    async function loadusers() {
      try {
        const result = await apifetch('/api/v1/admin/users');
        if (!result.ok) {
          panelerror('userserror', 'user table unavailable (status ' + result.status + ').');
          return;
        }
        panelerror('userserror', '');
        allusers = asarray(result.body, ['users', 'items', 'data', 'list']);
        paintusers();
      } catch {
        panelerror('userserror', 'the users endpoint is unreachable.');
      }
    }

    async function loadglobalsandboxes() {
      try {
        const result = await apifetch('/api/v1/admin/sandboxes');
        if (!result.ok) {
          panelerror('boxeserror', 'sandbox table unavailable (status ' + result.status + ').');
          return;
        }
        panelerror('boxeserror', '');
        const items = asarray(result.body, ['sandboxes', 'items', 'data', 'list']);
        boxesempty.hidden = items.length > 0;
        boxesbody.replaceChildren(...items.map(function (record) {
          /* admin rows may be flat db rows or enveloped public views */
          const spec = (record.spec && typeof record.spec === 'object') ? record.spec : record;
          const owner = pick(record, ['owner', 'username', 'user', 'ownerUsername', 'userid', 'user_id'], '-');
          return el('tr', {}, [
            el('td', { class: 'wrapcell', text: String(pick(record, ['id'], '?')) }),
            el('td', { text: String(owner) }),
            el('td', {}, [el('span', {
              class: 'chip ' + String(pick(record, ['state'], '?')),
              text: String(pick(record, ['state'], '?')),
            })]),
            el('td', {
              class: 'wrapcell',
              text: [
                pick(spec, ['model'], '?'), 'x' + pick(spec, ['vcpus'], '?'),
                pick(spec, ['ramgb', 'ramGb', 'ram'], '?') + 'gb', pick(spec, ['gpu'], '?'),
              ].join(' '),
            }),
            el('td', { text: fmtdate(pick(record, ['createdAt', 'createdat', 'created_at'], null)) }),
            el('td', { text: fmtdate(pick(record, ['expiresAt', 'expiresat', 'expires_at'], null)) }),
          ]);
        }));
      } catch {
        panelerror('boxeserror', 'the sandboxes endpoint is unreachable.');
      }
    }

    async function loadaudit() {
      try {
        const result = await apifetch('/api/v1/admin/audit');
        if (!result.ok) {
          panelerror('auditerror', 'audit log unavailable (status ' + result.status + ').');
          return;
        }
        panelerror('auditerror', '');
        const items = asarray(result.body, ['entries', 'audit', 'items', 'data', 'list', 'logs']);
        auditempty.hidden = items.length > 0;
        auditbody.replaceChildren(...items.map(function (entry) {
          return el('tr', {}, [
            el('td', { text: String(pick(entry, ['action', 'type', 'event'], '?')) }),
            el('td', { text: String(pick(entry, ['username', 'actor', 'by', 'user', 'userid', 'user_id'], '-')) }),
            el('td', { class: 'wrapcell', text: String(pick(entry, ['ip', 'sourceIp', 'address'], '-')) }),
            el('td', { text: fmtdate(pick(entry, ['at', 'ts', 'time', 'createdAt', 'when'], null)) }),
          ]);
        }));
      } catch {
        panelerror('auditerror', 'the audit endpoint is unreachable.');
      }
    }

    function loadadmin() {
      loadoverview();
      loadnodes();
      loadusers();
      loadglobalsandboxes();
      loadaudit();
    }

    document.getElementById('adminrefresh').addEventListener('click', loadadmin);

    /* ---------------- local sandbox mode (static edge) ----------------
     * the browser-pure engine port (sandbox.js - the same module the
     * console runs) drives the dashboard sandbox list when no api
     * answers: create with the spec form, list, stop - exactly like the
     * console, no server involved. sandboxes live in sessionStorage so
     * they survive reloads but never persist as state anywhere else. */
    let sandboxmodule = null;
    const localstoragekey = 'e2ugh_local_sandboxes';

    function readlocalsandboxes() {
      try {
        const raw = window.sessionStorage.getItem(localstoragekey);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function writelocalsandboxes(list) {
      window.sessionStorage.setItem(localstoragekey, JSON.stringify(list));
    }

    async function setuplocalsandbox() {
      try {
        sandboxmodule = await import('./sandbox.js');
      } catch {
        sandboxmodule = null;
      }

      const form = document.getElementById('createform');
      const createbtn = document.getElementById('createbtn');
      const refreshbtn = document.getElementById('refreshbtn');
      const errorbox = document.getElementById('createerror');
      if (!form || !createbtn) return;
      localmode = true;

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        errorbox.hidden = true;
        const spec = {
          model: document.getElementById('newmodel').value,
          vcpus: Number(document.getElementById('newvcpus').value) || 8,
          ramgb: Number(document.getElementById('newram').value) || 32,
          gpu: document.getElementById('newgpu').value,
          mig: document.getElementById('newmig').value,
        };
        if (!sandboxmodule) {
          /* no engine port: keep the record anyway so the list reflects
           * what the operator provisioned. */
          const record = {
            id: 'sb-' + Math.random().toString(36).slice(2, 10),
            spec,
            createdat: new Date().toISOString(),
            state: 'running',
          };
          const list = readlocalsandboxes();
          list.unshift(record);
          writelocalsandboxes(list);
          renderlocalsandboxes();
          return;
        }
        const state = sandboxmodule.createSandboxState(spec);
        const list = readlocalsandboxes();
        list.unshift({
          id: state.id,
          spec: {
            model: state.model,
            vcpus: state.vcpus,
            ramgb: state.ramgb,
            gpu: state.gpu,
            mig: state.mig,
          },
          createdat: new Date().toISOString(),
          state: 'running',
        });
        writelocalsandboxes(list);
        renderlocalsandboxes();
      });

      refreshbtn.addEventListener('click', renderlocalsandboxes);
      renderlocalsandboxes();
    }

    function renderlocalsandboxes() {
      const list = readlocalsandboxes();
      boxskeleton.hidden = true;
      boxerror.hidden = true;
      if (list.length === 0) {
        boxlist.replaceChildren();
        boxempty.hidden = false;
        boxempty.textContent = 'no sandboxes yet; create one above or boot the local engine from the console.';
        return;
      }
      boxempty.hidden = true;
      boxlist.replaceChildren(...list.map(function (record) {
        const spectext = [
          record.spec.model,
          'x' + record.spec.vcpus + ' vcpus',
          record.spec.ramgb + ' gb',
          record.spec.gpu,
          record.spec.mig && record.spec.mig !== 'off' ? 'mig ' + record.spec.mig : '',
        ].filter(Boolean).join(' / ');
        const stopbtn = el('button', {
          type: 'button', class: 'btn mini', text: 'stop',
          'aria-label': 'stop ' + record.id,
        });
        stopbtn.addEventListener('click', function () {
          const remaining = readlocalsandboxes().filter(function (item) { return item.id !== record.id; });
          writelocalsandboxes(remaining);
          renderlocalsandboxes();
        });
        return el('li', {}, [
          el('div', { class: 'rowtop' }, [
            el('span', { class: 'id', text: record.id.slice(0, 13) + (record.id.length > 13 ? '...' : '') }),
            el('span', { class: 'chip ' + (record.state ?? 'running'), text: record.state ?? 'running' }),
            el('span', { class: 'rowactions' }, [stopbtn]),
          ]),
          el('span', { class: 'specs', text: spectext }),
          el('span', { class: 'meta', text: 'created ' + fmtdate(record.createdat) }),
        ]);
      }));
    }

    /* ---------------- boot ---------------- */

    /* static edge: when no api answers at the resolved base (github
     * pages / netlify / vercel clones), the dashboard runs on the local
     * browser session created through localauth.js: the account panel
     * renders from the local session, the api-driven panels (sandboxes,
     * events, admin) are replaced by a static-edge notice pointing at
     * the console, and logout clears the local session. the self-hosted
     * node keeps the full cookie-session dashboard. */
    async function boot() {
      const base = apibase();
      const apianswers = await window.localauth.probe(base);
      if (!apianswers) {
        const localsession = window.localauth.session();
        /* the spec catalogs feed the creation form in local mode too -
         * the browser-pure sandbox.js engine port carries the same cpu
         * and gpu banks the console uses. */
        loadspeccatalogs();
        rolebadge.textContent = 'node: static edge (no api)';
        if (!localsession) {
          showfatal('this static page has no signed-in browser session; sign in or create a local account first.');
          return;
        }
        currentuser = {
          username: localsession.user,
          role: localsession.role === 'admin' ? 'admin' : 'local',
          createdat: null,
          lastloginat: new Date(localsession.issuedat).toISOString(),
          id: null,
        };
        userbadge.textContent = localsession.user
          + (localsession.role === 'admin' ? ' (admin, local)' : ' (local)');
        const rows = [
          el('dt', { text: 'username' }), el('dd', { text: localsession.user }),
          el('dt', { text: 'role' }), el('dd', { text: localsession.role === 'admin' ? 'admin (CODEOWNERS allowlist: ' + window.localauth.adminusers.join(', ') + ')' : 'user' }),
          el('dt', { text: 'mode' }), el('dd', { text: 'local browser account (static edge; pbkdf2 in localstorage, never synced; the built-in admin seed survives storage resets)' }),
          el('dt', { text: 'signed in' }), el('dd', { text: fmtdate(new Date(localsession.issuedat).toISOString()) }),
          el('dt', { text: 'expires' }), el('dd', { text: fmtdate(new Date(localsession.expiresat).toISOString()) }),
        ];
        infolist.replaceChildren(...rows);

        /* admin tab is STRICTLY admin-only (the CODEOWNERS allowlist):
         * the html ships it hidden and only a local admin session
         * reveals it. for local admins the admin panel renders the
         * browser-local overview: the account registry this browser
         * carries, the seeded allowlist and the local sandbox count. */
        tabadmin.hidden = localsession.role !== 'admin';
        if (localsession.role === 'admin') {
          const accounts = window.localauth.available()
            ? Object.keys(JSON.parse(window.localStorage.getItem('e2ugh_local_users') ?? '{}'))
            : [];
          const localboxes = readlocalsandboxes();
          document.getElementById('ov-users').textContent = String(accounts.length);
          document.getElementById('ov-nodes').textContent = '1 (this browser)';
          document.getElementById('ov-sandboxes').textContent = String(localboxes.length);
          document.getElementById('ov-sessions').textContent = 'local';
          usersbody.replaceChildren(...accounts.map(function (name) {
            return el('tr', {}, [
              el('td', { text: name }),
              el('td', { text: window.localauth.roleof(name) }),
              el('td', { text: 'browser-local' }),
            ]);
          }));
          usersempty.hidden = accounts.length > 0;
          nodesbody.replaceChildren(
            el('tr', {}, [
              el('td', { text: 'this browser' }),
              el('td', { text: 'static edge (github pages / vercel / netlify clone)' }),
              el('td', { text: 'local' }),
              el('td', { text: 'n/a' }),
            ]),
          );
          nodesempty.hidden = true;
        }

        /* account backup controls (the static-edge accounts survive
         * partial storage clears through the IndexedDB mirror; the
         * keyfile covers a full wipe). */
        const backupinput = document.createElement('input');
        backupinput.type = 'file';
        backupinput.accept = 'application/json,.json';
        backupinput.hidden = true;
        backupinput.addEventListener('change', async function () {
          const file = backupinput.files && backupinput.files[0];
          if (!file) return;
          try {
            const imported = await window.localauth.importaccounts(file);
            window.alert(imported > 0
              ? `${imported} account(s) restored from the backup.`
              : 'no new accounts in that backup (already present or invalid).');
            window.location.reload();
          } catch (error) {
            window.alert(error && error.message ? error.message : 'import failed.');
          }
        });
        document.body.append(backupinput);
        const backupbtn = document.createElement('button');
        backupbtn.type = 'button';
        backupbtn.textContent = 'backup accounts';
        backupbtn.className = 'btn';
        backupbtn.addEventListener('click', async function () {
          const count = await window.localauth.exportaccounts();
          window.alert(count > 0
            ? `backup downloaded (${count} account(s)). keep the file safe; it restores every account after a full browser wipe.`
            : 'no accounts to back up yet.');
        });
        const restorebtn = document.createElement('button');
        restorebtn.type = 'button';
        restorebtn.textContent = 'restore accounts';
        restorebtn.className = 'btn';
        restorebtn.addEventListener('click', function () { backupinput.click(); });
        const controls = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;' }, [backupbtn, restorebtn]);
        infolist.after(controls);

        /* the browser-pure sandbox engine (the same sandbox.js port the
         * console runs) drives the local sandbox list: create, list and
         * stop work exactly like the console, no server involved. */
        await setuplocalsandbox();
        eventlist.replaceChildren(
          el('li', { class: 'empty' }, [el('span', { text: 'bus events stream from the main node api; nothing to poll on the static edge.' })]),
        );
        eventempty.hidden = true;
        return;
      }
      loadspeccatalogs();
      loadhealth();
      loadme();
    }
    boot();
  })();
