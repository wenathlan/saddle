/**
 * real tests for the e2ugh v7 web edition (worklog tasks v6-SYNC,
 * v7-BACK and v10-SBX): the suite imports web.js (the
 * browser-pure engine port) and asserts the bank, the procfs payloads,
 * the mesa summaries and the command dispatcher (including the v10
 * persistent workspace filesystem commands); spawns web/server.js for
 * real http round trips over an explicit host and a random 30000-59999
 * port (health, spec catalogs, sandbox lifecycle with exec, static
 * assets); covers the v7 auth surface (register with the first-user
 * admin bootstrap, login, me, the generic 401, the login rate limit,
 * auth-required sandboxes) and the signed mesh register route; checks
 * the v10 sandbox workspace surface (files endpoints, quota via
 * E2UGH_SANDBOX_QUOTA_BYTES, self-contained persistence across a real
 * server restart on the same sqlite file); and checks the deployment
 * adapters (vercel.json, netlify.toml, caddyfile) stay in sync with the
 * files they publish.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bootSequence,
  clinfoSummary,
  commands,
  cpudata,
  cpuinfo,
  createSandboxState,
  dispatch,
  freeh,
  glxinfoSummary,
  gpudata,
  meminfo,
  nvidiaSmiTable,
  vulkanSummary,
} from '../web/sandbox.js';

/** repository root resolved from this test file location. */
const reporoot = join(dirname(fileURLToPath(import.meta.url)), '..');
/* the e2ugh static console lives at web since the grand merge */
const webroot = join(reporoot, 'web');

/* ------------------------------------------------------------------ */
/* sandbox.js: the browser-pure engine port                            */
/* ------------------------------------------------------------------ */

test('web bank: eight cpu models and seven gpus mirror the catalogs', () => {
  assert.equal(cpudata.length, 8);
  const epyc = cpudata.find((cpu) => cpu.model === 'AMD EPYC 9965');
  assert.ok(epyc !== undefined, 'the EPYC 9965 row must exist');
  assert.equal(epyc.cores, 192);
  assert.equal(epyc.threads, 384);
  assert.equal(gpudata.length, 7);
  const pro = gpudata.find((gpu) => gpu.id === 'rtxpro6000');
  assert.ok(pro !== undefined, 'the RTX PRO 6000 Blackwell row must exist');
  assert.equal(pro.pcidevice, '26B5', 'the corrected 26B5 pci id is the one mirrored');
  const b200 = gpudata.find((gpu) => gpu.id === 'b200');
  assert.ok(b200 !== undefined);
  assert.equal(b200.vrammib, 196608);
});

test('web render: procfs payloads match the engine byte contracts', () => {
  const info = cpuinfo('AMD EPYC 9965', 4);
  assert.equal(info.split('processor').length - 1, 4, 'four vcpu blocks render');
  assert.ok(info.includes('model name\t: AMD EPYC 9965 192-Core Processor'));
  assert.ok(info.includes('avx512f'), 'the zen 5 flag set includes avx512f');
  const mem = meminfo(128);
  assert.ok(mem.includes('MemTotal:      134086656 kB'), '128 GiB renders the engine MemTotal');
  assert.equal(mem.split('\n').filter((line) => line.includes(':')).length, 53, '53 fields');
  const free = freeh(mem);
  assert.ok(free.startsWith('        total'), 'free -h renders the header row');
  assert.ok(free.includes('128Gi'), 'free -h total agrees with the meminfo snapshot');
});

test('web render: mesa summaries and the smi adapter table', () => {
  const smi = nvidiaSmiTable('b200');
  assert.ok(smi.includes('NVIDIA-SMI 575.57.08'), 'the driver line mirrors the readme probe');
  assert.ok(smi.includes('CUDA Version: 12.9'));
  assert.ok(smi.includes('B200'), 'the requested gpu renders');
  assert.ok(clinfoSummary(8).includes('OpenCL 3.1'), 'rusticl reports opencl 3.1');
  assert.ok(vulkanSummary().includes('1.4'), 'the vulkan summary reports 1.4');
  assert.ok(glxinfoSummary().includes('llvmpipe'), 'the glxinfo summary reports llvmpipe');
  assert.ok(glxinfoSummary().includes('4.6'), 'opengl 4.6 core');
});

test('web dispatch: terminal commands run against the sandbox state', () => {
  const state = createSandboxState({
    model: 'AMD EPYC 9965',
    vcpus: 16,
    ramgb: 64,
    gpu: 'b200',
  });
  const lscpu = dispatch('lscpu', state);
  assert.equal(lscpu.exitCode, 0);
  assert.ok(lscpu.output.includes('x86_64'));
  const cat = dispatch('cat /proc/cpuinfo', state);
  assert.ok(cat.output.includes('AMD EPYC 9965 192-Core Processor'));
  const missing = dispatch('cat /nope', state);
  assert.equal(missing.exitCode, 1, 'unknown paths fail with exit code 1');
  const smi = dispatch('nvidia-smi', state);
  assert.ok(smi.output.includes('575.57.08'));
  assert.ok(commands.length > 0, 'the command table is exported for tab completion');
});

/* ------------------------------------------------------------------ */
/* server.js: real http round trips over /api/v1 and the static root   */
/* ------------------------------------------------------------------ */

/**
 * boots web/server.js with a throwaway sqlite file so the suite never
 * touches the repository working tree; the optional third argument
 * pins the database file so a second boot (the restart scenario) reads
 * exactly what the first one wrote.
 *
 * @param {number} port the tcp port to bind.
 * @param {Record<string, string>} [extraenv] extra environment entries.
 * @param {string} [pinneddb] an explicit database path.
 * @returns {{child: import('node:child_process').ChildProcess, base: string,
 *   dbpath: string}} the spawned server handle.
 */
function bootserver(port: number, extraenv: Record<string, string> = {}, pinneddb?: string) {
  const dbpath = pinneddb ?? join(tmpdir(), `e2ugh-web-${randomUUID()}.db`);
  const child = spawn(process.execPath, ['web/server.js', '--port', String(port)], {
    cwd: reporoot,
    env: { ...process.env, E2UGH_HOST: '127.0.0.1', E2UGH_DB: dbpath, ...extraenv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, base: `http://127.0.0.1:${port}`, dbpath };
}

/** removes the throwaway database files of one boot. */
function cleanupdb(dbpath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(`${dbpath}${suffix}`);
    } catch {
      /* the file never existed or was already removed */
    }
  }
}

/**
 * waits until the spawned server answers /api/v1/health or the deadline
 * passes; resolves to the first successful health response.
 *
 * @param {string} base the server base url.
 * @returns {Promise<Response | undefined>} the health response.
 */
async function waitforhealth(base: string): Promise<Response | undefined> {
  let health: Response | undefined;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      health = await fetch(`${base}/api/v1/health`);
      if (health.ok) {
        break;
      }
    } catch {
      /* the server has not bound the port yet; poll again */
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
  }
  return health;
}

/** extracts the e2ughsession cookie pair from one set-cookie header. */
function sessioncookie(response: Response): string {
  const raw = response.headers.get('set-cookie') ?? '';
  return raw.split(';')[0];
}

/**
 * waits until one spawned server process is fully gone (the restart
 * scenario needs the sqlite file closed before the second boot).
 *
 * @param {import('node:child_process').ChildProcess} child the server.
 * @returns {Promise<void>} resolves when the process exited or timed out.
 */
async function waitforexit(child: import('node:child_process').ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/**
 * runs one exec round trip against a sandbox and returns the dispatcher
 * envelope.
 *
 * @param {string} base the server base url.
 * @param {string} cookie the session cookie pair.
 * @param {string} id the sandbox id.
 * @param {string} command the command line.
 * @returns {Promise<{output: string, exitCode: number}>} the exec result.
 */
async function execcommand(
  base: string,
  cookie: string,
  id: string,
  command: string,
): Promise<{ output: string; exitCode: number }> {
  const response = await fetch(`${base}/api/v1/sandboxes/${id}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ command }),
  });
  return (await response.json()) as { output: string; exitCode: number };
}

test('web server: health, specs, sandbox lifecycle, exec and static assets', async () => {
  const { child, base, dbpath } = bootserver(randomInt(30000) + 30000);
  try {
    const health = await waitforhealth(base);
    assert.ok(health !== undefined && health.ok, 'the server must answer /api/v1/health');
    const healthbody = (await health?.json()) as {
      ok: boolean;
      version: string;
      role: string;
      db: boolean;
    };
    assert.equal(healthbody.ok, true);
    assert.equal(healthbody.version, '2.0.0', 'the api reports the release envelope version');
    assert.equal(healthbody.role, 'standalone', 'a bare boot runs the standalone role');
    assert.equal(healthbody.db, true, 'the sqlite layer answers the health probe');

    const cpus = (await (await fetch(`${base}/api/v1/specs/cpus`)).json()) as {
      processors: { id: string; cores: number }[];
    };
    assert.ok(cpus.processors.length >= 57, 'the spec catalog serves processors.json');
    assert.ok(cpus.processors.some((cpu) => cpu.id === 'epyc-9965' && cpu.cores === 192));

    /* the v7 contract requires an authenticated user for sandboxes */
    const anonymous = await fetch(`${base}/api/v1/sandboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'AMD EPYC 9965', vcpus: 16, ramgb: 64, gpu: 'b200' }),
    });
    assert.equal(anonymous.status, 401, 'sandbox creation without a session answers 401');

    const registered = await fetch(`${base}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'lifecycle', password: 'lifecyclepass' }),
    });
    assert.equal(registered.status, 201);
    const cookie = sessioncookie(registered);
    assert.ok(cookie.startsWith('e2ughsession='), 'register issues the session cookie');

    const created = await fetch(`${base}/api/v1/sandboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ model: 'AMD EPYC 9965', vcpus: 16, ramgb: 64, gpu: 'b200' }),
    });
    assert.equal(created.status, 201);
    const sandbox = (await created.json()) as { id: string; state: string };
    assert.match(sandbox.id, /^[0-9a-f-]{36}$/, 'the sandbox id is a uuid');
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
    const status = (await (
      await fetch(`${base}/api/v1/sandboxes/${sandbox.id}`, { headers: { cookie } })
    ).json()) as { state: string };
    assert.equal(status.state, 'running', 'the 125 ms ramp flips created to running');

    const exec = (await (
      await fetch(`${base}/api/v1/sandboxes/${sandbox.id}/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ command: 'lscpu' }),
      })
    ).json()) as { output: string; exitCode: number };
    assert.equal(exec.exitCode, 0);
    assert.ok(exec.output.includes('x86_64'), 'exec runs the shared dispatcher');

    const destroyed = await fetch(`${base}/api/v1/sandboxes/${sandbox.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.ok(destroyed.ok, 'delete destroys the sandbox');
    const after = await fetch(`${base}/api/v1/sandboxes/${sandbox.id}`, { headers: { cookie } });
    assert.equal(after.status, 404, 'a destroyed sandbox answers 404');

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.ok((await page.text()).includes('web sandbox'), 'the console page is served');
    const script = await fetch(`${base}/sandbox.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /javascript/);
    const hardened = await fetch(`${base}/api/v1/health`);
    assert.ok(
      (hardened.headers.get('x-frame-options') ?? '') === 'DENY',
      'responses carry the frame denial header',
    );
    assert.ok(
      (hardened.headers.get('content-security-policy') ?? '').includes("default-src 'self'"),
      'responses carry the content security policy',
    );
  } finally {
    child.kill('SIGTERM');
    cleanupdb(dbpath);
  }
});

test('web auth: bootstrap admin, me, generic 401, weak register, login rate limit', async () => {
  const { child, base, dbpath } = bootserver(randomInt(30000) + 30000);
  try {
    assert.ok((await waitforhealth(base)) !== undefined, 'the server must boot');

    const weak = await fetch(`${base}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'short' }),
    });
    assert.equal(weak.status, 400, 'a short password is rejected');

    const registered = await fetch(`${base}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'operatorpass' }),
    });
    assert.equal(registered.status, 201);
    const body = (await registered.json()) as { user: { role: string; username: string } };
    assert.equal(
      body.user.role,
      'user',
      'only the CODEOWNERS allowlist bootstraps as admin; every other registration is a plain user',
    );

    /* the CODEOWNERS admins are seeded at boot with the documented
     * bootstrap password - the admin surface exists before anyone
     * registers and survives a wiped database. */
    const adminlogin = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'iakadion', password: 'cdw782FG7pjxQVw' }),
    });
    assert.equal(
      adminlogin.status,
      200,
      'the seeded CODEOWNERS admin signs in with the bootstrap password',
    );
    const adminbody = (await adminlogin.json()) as { user: { role: string; username: string } };
    assert.equal(adminbody.user.role, 'admin', 'the seeded admin carries the admin role');
    const admincookie = sessioncookie(adminlogin);

    const operatorcookie = sessioncookie(registered);

    const me = await fetch(`${base}/api/v1/auth/me`, { headers: { cookie: operatorcookie } });
    assert.equal(me.status, 200);
    const mebody = (await me.json()) as { user: { username: string } };
    assert.equal(mebody.user.username, 'operator');

    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'operatorpass' }),
    });
    assert.equal(login.status, 200, 'login with good credentials answers 200');
    assert.ok((login.headers.get('set-cookie') ?? '').startsWith('e2ughsession='));

    const wrong = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: 'not-the-password' }),
    });
    assert.equal(wrong.status, 401);
    const wrongbody = (await wrong.json()) as { error: { message: string } };
    assert.equal(wrongbody.error.message, 'invalid credentials', 'the failure message is generic');

    const denied = await fetch(`${base}/api/v1/admin/overview`, {
      headers: { cookie: operatorcookie },
    });
    assert.equal(denied.status, 403, 'a plain user cannot read the admin overview');
    const overview = await fetch(`${base}/api/v1/admin/overview`, {
      headers: { cookie: admincookie },
    });
    assert.equal(overview.status, 200, 'the seeded CODEOWNERS admin reads the overview');
    const overviewbody = (await overview.json()) as { counts: { users: number; events: number } };
    /* the four seeded CODEOWNERS admins plus the operator registration. */
    assert.equal(overviewbody.counts.users, 5);
    assert.ok(overviewbody.counts.events > 0, 'auth actions land in the events table');

    const audit = await fetch(`${base}/api/v1/admin/audit`, { headers: { cookie: admincookie } });
    assert.equal(audit.status, 200);
    const auditbody = (await audit.json()) as { audit: { action: string }[] };
    assert.ok(
      auditbody.audit.some((row) => row.action === 'register') &&
        auditbody.audit.some((row) => row.action === 'login'),
      'register and login are audited',
    );

    /* login limit is 10/min/ip; the successful login and the wrong
     * attempt above consumed two slots, so nine more failures hit the
     * ceiling and the last request of the loop answers 429 */
    const codes: number[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const blocked = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'operator', password: 'not-the-password' }),
      });
      if (blocked.status === 429) {
        assert.ok(
          Number(blocked.headers.get('retry-after') ?? '0') > 0,
          'the 429 carries retry-after seconds',
        );
      }
      codes.push(blocked.status);
    }
    assert.equal(codes[0], 401, 'the first failure is a plain 401');
    assert.equal(codes[codes.length - 1], 429, 'the tenth failure trips the rate limit');

    const events = await fetch(`${base}/api/v1/events?since=0`, {
      headers: { cookie: operatorcookie },
    });
    assert.equal(events.status, 200, 'the events poll answers for authenticated users');
    const eventsbody = (await events.json()) as { events: { topic: string }[]; lastid: number };
    assert.ok(eventsbody.events.some((event) => event.topic === 'auth.register'));
    assert.ok(eventsbody.lastid > 0);
  } finally {
    child.kill('SIGTERM');
    cleanupdb(dbpath);
  }
});

test('web mesh: register demands a valid HMAC signature and rejects replays', async () => {
  const secret = 'webtestmeshsecret';
  const { child, base, dbpath } = bootserver(randomInt(30000) + 30000, {
    E2UGH_MESH_SECRET: secret,
  });
  try {
    assert.ok((await waitforhealth(base)) !== undefined, 'the server must boot');

    const unsigned = await fetch(`${base}/api/v1/mesh/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://clone.example', region: 'eu', rolename: 'clone' }),
    });
    assert.equal(unsigned.status, 401, 'mesh register without a signature answers 401');

    const path = '/api/v1/mesh/register';
    const body = JSON.stringify({ url: 'https://clone.example', region: 'eu', rolename: 'clone' });
    const timestamp = String(Date.now());
    const digest = createHash('sha256').update(body).digest('hex');
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.POST.${path}.${digest}`)
      .digest('hex');
    const signed = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-e2ugh-timestamp': timestamp,
        'x-e2ugh-signature': signature,
      },
      body,
    });
    assert.equal(signed.status, 200, 'mesh register with a valid signature answers 200');
    const nodebody = (await signed.json()) as { nodeid: string; url: string; status: string };
    assert.match(nodebody.nodeid, /^[0-9a-f-]{36}$/, 'the registry issues a node id');
    assert.equal(nodebody.status, 'online');

    const replay = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-e2ugh-timestamp': timestamp,
        'x-e2ugh-signature': signature,
      },
      body,
    });
    assert.equal(replay.status, 401, 'a replayed signature is rejected');
    const replaybody = (await replay.json()) as { error: { code: string } };
    assert.equal(replaybody.error.code, 'mesh-replay');
  } finally {
    child.kill('SIGTERM');
    cleanupdb(dbpath);
  }
});

/* ------------------------------------------------------------------ */
/* v10-SBX: the persistent workspace filesystem (dispatcher level)      */
/* ------------------------------------------------------------------ */

/**
 * builds a quota-enforcing filesystem context for the dispatcher; the
 * contract mirrors db.js (write throws the standardized quota exceeded
 * error, the other callbacks degrade to empty results).
 *
 * @param {number} quota the quota in bytes.
 * @returns {{fs: Record<string, (...args: never[]) => unknown>, quota: number}}
 *   the dispatcher context.
 */
function quotafscontext(quota: number): {
  fs: Record<string, (...args: never[]) => unknown>;
  quota: number;
} {
  const files = new Map<string, { content: string; updatedat: string }>();
  const bytes = (text: string): number => new TextEncoder().encode(text).length;
  return {
    quota,
    fs: {
      write(path: string, content: string) {
        const text = String(content ?? '');
        let used = 0;
        for (const entry of files.values()) {
          used += bytes(entry.content);
        }
        const previous = files.has(path) ? bytes(files.get(path)?.content ?? '') : 0;
        if (used - previous + bytes(text) > quota) {
          throw Object.assign(new Error(`quota exceeded: sandbox is capped at ${quota} bytes`), {
            code: 'quota-exceeded',
          });
        }
        const updatedat = new Date().toISOString();
        files.set(path, { content: text, updatedat });
        return { path, size: bytes(text), updatedat };
      },
      read(path: string) {
        return files.get(path) ?? null;
      },
      list() {
        return [...files.entries()]
          .map(([path, entry]) => ({
            path,
            size: bytes(entry.content),
            updatedat: entry.updatedat,
          }))
          .sort((a, b) => (a.path < b.path ? -1 : 1));
      },
      del(path: string) {
        return files.delete(path);
      },
    } as unknown as Record<string, (...args: never[]) => unknown>,
  };
}

test('web files: dispatcher workspace commands, boot banner and the quota wall', () => {
  const state = createSandboxState({
    model: 'AMD EPYC 9965',
    vcpus: 8,
    ramgb: 32,
    gpu: 'b200',
  });

  /* memory fallback (no context): the browser terminal keeps working */
  assert.equal(dispatch('echo hello > /welcome.txt', state).exitCode, 0);
  const cat = dispatch('cat /welcome.txt', state);
  assert.equal(cat.exitCode, 0);
  assert.equal(cat.output, 'hello', 'cat returns exactly the stored text');
  const append = dispatch('cat /welcome.txt', state);
  assert.equal(append.output, 'hello');
  dispatch('echo world >> /welcome.txt', state);
  assert.equal(dispatch('cat /welcome.txt', state).output, 'helloworld', '>> appends verbatim');
  dispatch('touch /empty.txt', state);
  const ls = dispatch('ls', state);
  assert.equal(ls.exitCode, 0);
  assert.ok(ls.output.includes('total'), 'ls renders a block total');
  assert.ok(ls.output.includes('/welcome.txt') && ls.output.includes('/empty.txt'));
  const df = dispatch('df -h', state);
  assert.ok(df.output.startsWith('Filesystem'), 'df -h renders the header');
  assert.ok(df.output.includes('Use%'), 'df -h renders the usage column');
  assert.ok(df.output.trimEnd().endsWith('/'), 'df -h mounts the workspace at /');
  assert.ok(df.output.includes('16 MiB'), 'df -h shows the default quota');
  const stat = dispatch('stat /welcome.txt', state);
  assert.equal(stat.exitCode, 0);
  assert.ok(stat.output.includes('File: /welcome.txt'));
  assert.ok(stat.output.includes('regular file'));
  assert.equal(dispatch('pwd', state).output, '/', 'pwd is always the sandbox root');
  assert.equal(dispatch('cat ../etc/passwd', state).exitCode, 1, 'traversal is rejected');
  assert.ok(
    dispatch('echo x > ../escape', state).output.includes('path traversal'),
    'writes cannot escape the root either',
  );
  assert.ok(
    dispatch('lscpu > /f.txt', state).output.includes('only supported for echo'),
    'redirection is an echo-only feature',
  );
  const history = dispatch('history', state);
  assert.ok(history.output.includes('echo hello > /welcome.txt'), 'history replays the session');
  assert.ok(history.output.split('\n').length >= 8, 'history keeps every command of the test');
  const manpage = dispatch('man rm', state);
  assert.equal(manpage.exitCode, 0);
  assert.ok(manpage.output.includes('RM(1)'), 'man renders a short manual page');
  assert.equal(dispatch('man nosuch', state).exitCode, 1, 'unknown man topics fail');

  /* scripted context: the callbacks are honored and the quota enforced */
  const context = quotafscontext(16 * 1024 * 1024);
  const ninemib = 'x'.repeat(9 * 1024 * 1024);
  const first = dispatch(`echo ${ninemib} > /a.bin`, state, context);
  assert.equal(first.exitCode, 0, 'the first 9 MiB write fits the 16 MiB quota');
  const second = dispatch(`echo ${ninemib} > /b.bin`, state, context);
  assert.equal(second.exitCode, 1, 'the second 9 MiB write crosses the quota wall');
  assert.ok(second.output.includes('quota exceeded'), 'the failure carries the quota error');

  /* the boot banner advertises the persistent workspace */
  const boot = bootSequence('AMD EPYC 9965', 8, 32, 'b200');
  assert.ok(
    boot.some((line) =>
      line.includes('persistent workspace: 16 MiB quota, data stays with the sandbox id'),
    ),
    'the dmesg boot sequence mentions the persistent workspace',
  );
});

/* ------------------------------------------------------------------ */
/* v10-SBX: the workspace survives a real server restart (same db)      */
/* ------------------------------------------------------------------ */

test('web files: sandbox workspace is self-contained across a server restart', async () => {
  const dbfile = join(tmpdir(), `e2ugh-persist-${randomUUID()}.db`);
  const idshell = bootserver(randomInt(30000) + 30000, { E2UGH_SANDBOX_PERSIST: 'true' }, dbfile);
  let sandboxid = '';
  try {
    assert.ok((await waitforhealth(idshell.base)) !== undefined, 'the first server must boot');

    const registered = await fetch(`${idshell.base}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'persist', password: 'persistpass' }),
    });
    assert.equal(registered.status, 201);
    const cookie = sessioncookie(registered);

    const created = await fetch(`${idshell.base}/api/v1/sandboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ model: 'AMD EPYC 9965', vcpus: 8, ramgb: 32, gpu: 'b200' }),
    });
    assert.equal(created.status, 201);
    const sandbox = (await created.json()) as {
      id: string;
      usage: { files: number; bytes: number };
    };
    sandboxid = sandbox.id;
    assert.deepEqual(sandbox.usage, { files: 0, bytes: 0 }, 'a fresh id starts empty');

    assert.equal(
      (await execcommand(idshell.base, cookie, sandboxid, 'echo hello > /welcome.txt')).exitCode,
      0,
    );
    const cat = await execcommand(idshell.base, cookie, sandboxid, 'cat /welcome.txt');
    assert.equal(cat.output, 'hello', 'cat returns the stored text');
    await execcommand(idshell.base, cookie, sandboxid, 'echo world >> /welcome.txt');
    assert.equal(
      (await execcommand(idshell.base, cookie, sandboxid, 'cat /welcome.txt')).output,
      'helloworld',
      'appends land in the same file',
    );
    await execcommand(idshell.base, cookie, sandboxid, 'touch /keep.txt');
    const ls = await execcommand(idshell.base, cookie, sandboxid, 'ls');
    assert.ok(ls.output.includes('/welcome.txt') && ls.output.includes('/keep.txt'));

    const files = (await (
      await fetch(`${idshell.base}/api/v1/sandboxes/${sandboxid}/files`, { headers: { cookie } })
    ).json()) as {
      files: { path: string; size: number }[];
      usage: { files: number; bytes: number };
      quota: number;
    };
    assert.deepEqual(
      files.files.map((file) => file.path),
      ['/keep.txt', '/welcome.txt'],
    );
    assert.deepEqual(files.usage, { files: 2, bytes: 10 });
    assert.equal(files.quota, 16 * 1024 * 1024, 'health and files agree on the default quota');

    const content = (await (
      await fetch(`${idshell.base}/api/v1/sandboxes/${sandboxid}/files/welcome.txt`, {
        headers: { cookie },
      })
    ).json()) as { path: string; content: string; size: number };
    assert.equal(content.content, 'helloworld');
    assert.equal(content.size, 10);

    const missing = await fetch(`${idshell.base}/api/v1/sandboxes/${sandboxid}/files/nope.txt`, {
      headers: { cookie },
    });
    assert.equal(missing.status, 404, 'unknown paths answer 404');

    const anonymous = await fetch(`${idshell.base}/api/v1/sandboxes/${sandboxid}/files`);
    assert.equal(anonymous.status, 401, 'the files surface requires the owner session');
  } finally {
    await waitforexit(idshell.child);
  }

  /* second process, same database file: the data stays with the id */
  const second = bootserver(randomInt(30000) + 30000, {}, dbfile);
  try {
    assert.ok((await waitforhealth(second.base)) !== undefined, 'the second server must boot');

    const login = await fetch(`${second.base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'persist', password: 'persistpass' }),
    });
    assert.equal(login.status, 200, 'the user row persisted in the same db');
    const cookie = sessioncookie(login);

    const gone = await fetch(`${second.base}/api/v1/sandboxes/${sandboxid}`, {
      headers: { cookie },
    });
    assert.equal(gone.status, 404, 'the in-memory lifecycle record is gone after the restart');

    const files = (await (
      await fetch(`${second.base}/api/v1/sandboxes/${sandboxid}/files`, { headers: { cookie } })
    ).json()) as { files: { path: string }[]; usage: { files: number; bytes: number } };
    assert.deepEqual(
      files.files.map((file) => file.path),
      ['/keep.txt', '/welcome.txt'],
      'the workspace persisted with the sandbox id',
    );
    assert.deepEqual(files.usage, { files: 2, bytes: 10 });

    const content = (await (
      await fetch(`${second.base}/api/v1/sandboxes/${sandboxid}/files/welcome.txt`, {
        headers: { cookie },
      })
    ).json()) as { content: string };
    assert.equal(content.content, 'helloworld', 'the file content survived the restart');

    const removed = await fetch(`${second.base}/api/v1/sandboxes/${sandboxid}/files/keep.txt`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.equal(removed.status, 200, 'the delete file route answers 200');
    const after = (await (
      await fetch(`${second.base}/api/v1/sandboxes/${sandboxid}/files`, { headers: { cookie } })
    ).json()) as { files: { path: string }[]; usage: { files: number; bytes: number } };
    assert.deepEqual(
      after.files.map((file) => file.path),
      ['/welcome.txt'],
    );
    assert.deepEqual(after.usage, { files: 1, bytes: 10 });

    /* rm/df/stat run against a fresh sandbox in the restarted process */
    const created = await fetch(`${second.base}/api/v1/sandboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ model: 'AMD EPYC 9965', vcpus: 8, ramgb: 32, gpu: 'b200' }),
    });
    assert.equal(created.status, 201);
    const fresh = (await created.json()) as { id: string };
    await execcommand(second.base, cookie, fresh.id, 'echo temp > /scratch.txt');
    assert.equal((await execcommand(second.base, cookie, fresh.id, 'rm /scratch.txt')).exitCode, 0);
    const emptyls = await execcommand(second.base, cookie, fresh.id, 'ls');
    assert.equal(emptyls.output, '', 'rm leaves an empty workspace');
    assert.equal(
      (await execcommand(second.base, cookie, fresh.id, 'cat /scratch.txt')).exitCode,
      1,
    );
    const df = await execcommand(second.base, cookie, fresh.id, 'df -h');
    assert.ok(df.output.includes('Filesystem') && df.output.includes('Use%'));
    assert.ok(df.output.trimEnd().endsWith('/'));
    const statusview = (await (
      await fetch(`${second.base}/api/v1/sandboxes/${fresh.id}`, { headers: { cookie } })
    ).json()) as { usage: { files: number; bytes: number } };
    assert.deepEqual(statusview.usage, { files: 0, bytes: 0 }, 'usage resets after rm');
  } finally {
    second.child.kill('SIGTERM');
    cleanupdb(dbfile);
  }
});

test('web files: the configured quota rejects over-limit writes over http', async () => {
  const { child, base, dbpath } = bootserver(randomInt(30000) + 30000, {
    E2UGH_SANDBOX_QUOTA_BYTES: '24',
  });
  try {
    const health = (await await (await waitforhealth(base))?.json()) as {
      sandboxquota: number;
    };
    assert.equal(health?.sandboxquota, 24, 'health reports the configured sandboxquota');

    const registered = await fetch(`${base}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'quotauser', password: 'quotapass' }),
    });
    assert.equal(registered.status, 201);
    const cookie = sessioncookie(registered);

    const created = await fetch(`${base}/api/v1/sandboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ model: 'AMD EPYC 9965', vcpus: 8, ramgb: 32, gpu: 'b200' }),
    });
    const sandbox = (await created.json()) as { id: string };
    assert.equal(created.status, 201);

    const big = await execcommand(
      base,
      cookie,
      sandbox.id,
      'echo 0123456789012345678901234567890 > /big.txt',
    );
    assert.equal(big.exitCode, 1, 'a 30-byte write crosses the 24-byte quota');
    assert.ok(big.output.includes('quota exceeded'), 'the exec output carries the quota error');

    const fits = await execcommand(base, cookie, sandbox.id, 'echo twelve bytes > /ok.txt');
    assert.equal(fits.exitCode, 0, 'a 12-byte write fits');

    const df = await execcommand(base, cookie, sandbox.id, 'df -h');
    assert.ok(df.output.includes('24 B'), 'df -h renders the configured quota');
    assert.ok(df.output.includes('12 B'), 'df -h renders the used bytes');

    const files = (await (
      await fetch(`${base}/api/v1/sandboxes/${sandbox.id}/files`, { headers: { cookie } })
    ).json()) as { files: { path: string }[] };
    assert.deepEqual(
      files.files.map((file) => file.path),
      ['/ok.txt'],
      'the rejected write left nothing behind',
    );

    assert.equal((await execcommand(base, cookie, sandbox.id, 'rm /ok.txt')).exitCode, 0);
    const stat = await execcommand(base, cookie, sandbox.id, 'stat /ok.txt');
    assert.equal(stat.exitCode, 1, 'stat on a removed file fails');

    const purge = await fetch(`${base}/api/v1/sandboxes/${sandbox.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.equal(purge.status, 200);
    const after = (await (
      await fetch(`${base}/api/v1/sandboxes/${sandbox.id}/files`, { headers: { cookie } })
    ).json()) as { files: { path: string }[] };
    assert.deepEqual(after.files, [], 'the manual delete purges the workspace files');
  } finally {
    child.kill('SIGTERM');
    cleanupdb(dbpath);
  }
});

/* ------------------------------------------------------------------ */
/* deployment adapters stay in sync with the published files           */
/* ------------------------------------------------------------------ */

test('web adapters: vercel.json parses strictly, camelcase, no functions', () => {
  const parsed = JSON.parse(readFileSync(join(webroot, 'vercel.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  assert.equal(parsed.outputDirectory, 'web');
  assert.ok(!('functions' in parsed), 'the anti-serverless policy forbids functions');
  const offensive: string[] = [];
  const walk = (node: unknown, label: string): void => {
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (/[_-]/.test(key)) {
          offensive.push(`${label}${key}`);
        }
        walk(value, `${label}${key}.`);
      }
    }
  };
  walk(parsed, 'vercel.json:');
  assert.deepEqual(offensive, [], 'vercel.json keys must avoid underscore and dash');
});

test('web adapters: netlify.toml is valid toml with a static publish', async (t) => {
  const probe = spawnSync('python3', ['-c', 'import sys'], { timeout: 20000 });
  if (probe.error !== undefined || probe.status !== 0) {
    t.skip('python3 is unavailable in this environment; the toml gate cannot run');
    return;
  }
  const parsed = spawnSync(
    'python3',
    [
      '-c',
      'import json, tomllib; print(json.dumps(tomllib.load(open("web/netlify.toml", "rb"))))',
    ],
    { cwd: reporoot, timeout: 20000, encoding: 'utf8' },
  );
  assert.equal(parsed.status, 0, `tomllib reported: ${parsed.stderr}`);
  const document = JSON.parse(parsed.stdout) as Record<string, unknown>;
  assert.equal((document.build as Record<string, unknown>).publish, 'web');
  assert.ok(!('functions' in document), 'the anti-serverless policy forbids functions');
});

test('web adapters: caddyfile proxies the api without hardcoded hosts', () => {
  const caddy = readFileSync(join(webroot, 'caddyfile'), 'utf8');
  assert.ok(caddy.includes('reverse_proxy'), 'the api tier is reverse proxied');
  assert.ok(caddy.includes('root * web'), 'the static tier serves the web directory');
  assert.ok(caddy.includes('{$E2UGH_SITE_ADDRESS'), 'the site address comes from the environment');
  assert.ok(caddy.includes('{$E2UGH_API_UPSTREAM'), 'the upstream comes from the environment');
});

test('web docs: the web readme documents every sibling and pins the envelope version', () => {
  const webreadme = readFileSync(join(webroot, 'readme.md'), 'utf8');
  for (const sibling of [
    'index.html',
    'sandbox.js',
    'server.js',
    'vercel.json',
    'netlify.toml',
    'caddyfile',
  ]) {
    assert.ok(webreadme.includes(sibling), `web/readme.md must document ${sibling}`);
  }
  assert.ok(webreadme.includes('2.0.0'), 'the web readme pins the envelope version');
  assert.ok(webreadme.includes('/api/v1/health'), 'the run instructions cite the health route');
});
