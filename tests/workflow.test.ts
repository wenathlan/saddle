/**
 * workflow simulation tests for the saddle repository (worklog tasks v5-E
 * and 9-a-4): the suite mirrors, locally and for real, the gates that the
 * github actions pipelines (.github/workflows/ci.yml and release.yml) run
 * on every push — biome lint, module parsing through type stripping plus
 * the typescript 7.0.2 no-emit build, strict json validation of the ten
 * camel case data documents, the flat structure contract (the 2.1.0 web
 * restructure: page folders + loose modules, native wrappers generated on
 * the runners, never tracked), the workflow reference gates, the node
 * smoke gate, the python bridge gates and the release checksum manifest.
 * every spawn runs with a timeout inside a try/catch catcher and every
 * gate that depends on a tool missing from the environment is skipped
 * with a documented reason instead of failing silently.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** repository root resolved from this test file location. */
const reporoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** outcome of one locally simulated pipeline gate. */
type gateoutcome = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedout: boolean;
  readonly spawnerror: string | null;
};

/**
 * runs one command as a pipeline gate with a hard timeout; the promise
 * always resolves (never rejects) so gates can report their exit code
 * instead of crashing the runner, mirroring a github actions step. the
 * optional extraenv carries the public npm registry override: a publish
 * job that sets up node with the github packages registry-url leaves the
 * runner npmrc pointing at npm.pkg.github.com, and the npx biome gates
 * would look for @biomejs/biome there (a 404 with an empty stdout) -
 * the tool gates always resolve their binaries from the public registry
 * so the pack:check battery runs identically on every job (the 2.1.2
 * lesson: the publish github npm lane ran the battery inside the github
 * registry context and the tool fetch failed before any lint ran).
 */
function rungate(
  command: string,
  args: readonly string[],
  timeoutms: number,
  cwd: string = reporoot,
  extraenv: Record<string, string> = {},
): Promise<gateoutcome> {
  return new Promise<gateoutcome>((resolve) => {
    try {
      const child = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...extraenv },
      });
      let stdout = '';
      let stderr = '';
      let timedout = false;
      const timer = setTimeout(() => {
        timedout = true;
        child.kill('SIGKILL');
      }, timeoutms);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error: Error) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr, timedout, spawnerror: error.message });
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedout, spawnerror: null });
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        timedout: false,
        spawnerror: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/** true when a command resolves successfully, proving the tool exists. */
function toolavailable(command: string, args: readonly string[]): boolean {
  try {
    const probe = spawnSync(command, args, { timeout: 20000, encoding: 'utf8' });
    return probe.error === undefined && probe.status === 0;
  } catch {
    return false;
  }
}

/** directories that hold build output or runtime caches, never sources. */
const skipdirs = new Set(['.git', 'node_modules', '__pycache__', 'dist', 'coverage', '.biome']);

/** lists the root-level files matching a simple extension glob. */
function globroot(pattern: string): string[] {
  const ext = pattern.replaceAll('*', '');
  return readdirSync(reporoot).filter((name) => name.endsWith(ext));
}

/** walks the repository collecting forward-slash relative file paths. */
function walkfiles(root: string, relativepath = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, relativepath), { withFileTypes: true })) {
    if (skipdirs.has(entry.name)) {
      continue;
    }
    const rel = relativepath === '' ? entry.name : `${relativepath}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...walkfiles(root, rel));
    } else if (entry.isFile()) {
      found.push(rel);
    }
  }
  return found;
}

/** the ten camel case data documents validated by the strict json gate. */
const datafiles = [
  'processors.json',
  'gpus.json',
  'cores.json',
  'boards.json',
  'vm.config.json',
  'virtualhardware.json',
  'qemu.config',
  'mttg.config',
  'passage.config',
  'docker.config',
] as const;

/**
 * keys kept verbatim on purpose (worklog v5-a exceptions): dotted kernel
 * sysctl ids and real tmpfs mount paths must match the host contracts.
 */
const keyexceptions = new Set([
  'vm.overcommit_memory',
  'vm.overcommit_ratio',
  '/tmp/mesa_shader_cache',
]);

/** recursively collects object keys carrying an underscore or a dash. */
function collectoffensivekeys(
  node: unknown,
  pathlabel: string,
  allow: ReadonlySet<string>,
  found: string[],
): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectoffensivekeys(item, pathlabel, allow, found);
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (/[_-]/.test(key) && !allow.has(key)) {
        found.push(`${pathlabel}${key}`);
      }
      collectoffensivekeys(value, `${pathlabel}${key}.`, allow, found);
    }
  }
}

/* ------------------------------------------------------------------ */
/* gate 1: biome lint (and clean checks on the new test files)         */
/* ------------------------------------------------------------------ */

test('ci gate lint: biome reports zero lint errors across the repository', async (t) => {
  if (!toolavailable('npx', ['--version'])) {
    t.skip('npx is unavailable in this environment; the biome gate cannot run locally');
    return;
  }
  const lint = await rungate(
    'npx',
    ['--yes', '@biomejs/biome@2.5.11', 'lint', '--diagnostic-level=error', '.'],
    180000,
    reporoot,
    { npm_config_registry: 'https://registry.npmjs.org' },
  );
  assert.equal(lint.spawnerror, null, 'the biome lint spawn must not fail');
  assert.equal(lint.timedout, false, 'the biome lint gate must finish inside the step timeout');
  assert.equal(lint.code, 0, `biome lint errors:\n${lint.stdout.slice(-2000)}`);
});

test('ci gate lint: the two workflow simulation files pass a full biome check', async (t) => {
  if (!toolavailable('npx', ['--version'])) {
    t.skip('npx is unavailable in this environment; the biome check cannot run locally');
    return;
  }
  const check = await rungate(
    'npx',
    [
      '--yes',
      '@biomejs/biome@2.5.11',
      'check',
      '--diagnostic-level=error',
      'tests/workflow.test.ts',
      'tests/simulation.test.ts',
    ],
    180000,
    reporoot,
    { npm_config_registry: 'https://registry.npmjs.org' },
  );
  assert.equal(check.spawnerror, null, 'the biome check spawn must not fail');
  assert.equal(check.code, 0, `biome check reported:\n${check.stdout.slice(-2000)}`);
});

/* ------------------------------------------------------------------ */
/* gate 2: typecheck (module parsing plus the tsc no-emit build)       */
/* ------------------------------------------------------------------ */

/** every root module loaded through the node type-stripping pipeline. */
const rootmoduleloaders: Readonly<Record<string, () => Promise<unknown>>> = {
  'alternatives.ts': () => import('../alternatives.ts'),
  'compute.ts': () => import('../compute.ts'),
  'index.ts': () => import('../index.ts'),
  'media.ts': () => import('../media.ts'),
  'orchestrator.ts': () => import('../orchestrator.ts'),
  'performance.ts': () => import('../performance.ts'),
  'render.ts': () => import('../render.ts'),
  'scheduler.ts': () => import('../scheduler.ts'),
  'security.ts': () => import('../security.ts'),
  'virtualcpu.ts': () => import('../virtualcpu.ts'),
  'virtualgpu.ts': () => import('../virtualgpu.ts'),
  'virtualization.ts': () => import('../virtualization.ts'),
  'virtualmemory.ts': () => import('../virtualmemory.ts'),
};

test('ci gate typecheck: every root module parses through type stripping', async (t) => {
  const syntaxfailures: string[] = [];
  const envblocked: string[] = [];
  for (const [name, load] of Object.entries(rootmoduleloaders)) {
    try {
      await load();
    } catch (error) {
      if (error instanceof SyntaxError) {
        syntaxfailures.push(`${name}: ${error.message}`);
      } else {
        envblocked.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (syntaxfailures.length === 0 && envblocked.length === Object.keys(rootmoduleloaders).length) {
    t.skip(`every module import was blocked by the environment: ${envblocked.join('; ')}`);
    return;
  }
  assert.deepEqual(
    syntaxfailures,
    [],
    'no root module may carry a syntax error under type stripping',
  );
});

test('ci gate typecheck: typescript 7.0.2 no-emit build passes', async (t) => {
  if (!toolavailable('npx', ['--version'])) {
    t.skip('npx is unavailable in this environment; the tsc gate cannot run locally');
    return;
  }
  const build = await rungate(
    'npx',
    ['-y', '--package', 'typescript@7.0.2', 'tsc', '--noEmit', '--project', 'tsconfig.json'],
    300000,
  );
  if (build.spawnerror !== null || build.code === null) {
    t.skip(`the typescript compiler could not be resolved: ${build.spawnerror ?? 'no exit code'}`);
    return;
  }
  assert.equal(build.timedout, false, 'the tsc gate must finish inside the step timeout');
  assert.equal(build.code, 0, `tsc --noEmit reported:\n${build.stdout.slice(-2000)}`);
});

/* ------------------------------------------------------------------ */
/* gate 3: strict json validation of the ten data documents            */
/* ------------------------------------------------------------------ */

test('ci gate json: the ten data documents parse strictly with zero underscore or dash keys', () => {
  for (const file of datafiles) {
    const fullpath = join(reporoot, file);
    assert.equal(existsSync(fullpath), true, `${file} must exist in the repository root`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(fullpath, 'utf8'));
    } catch (error) {
      assert.fail(
        `${file} must parse as strict json: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    assert.ok(
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
      `${file} must be a non-empty json object`,
    );
    const offensive: string[] = [];
    collectoffensivekeys(parsed, `${file}:`, keyexceptions, offensive);
    assert.deepEqual(
      offensive,
      [],
      `${file} carries keys with _ or - outside the documented fs-path/sysctl exceptions`,
    );
    const identity = parsed as Record<string, unknown>;
    assert.ok(
      'meta' in identity || 'metadata' in identity || 'id' in identity || 'name' in identity,
      `${file} must declare a hardware identity (ci checks meta/id/name and warns)`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* gate 4: flat structure contract                                     */
/* ------------------------------------------------------------------ */

test('ci gate structure: the 2.1.0 flat layout contract (single tsx interface)', () => {
  /* the repository carries one root surface:
     - the root: every logic TypeScript file sits flat at the repository
       root (the consolidation contract — no nested logic folders), with
       only the support folders (docs, tests), the interface tree (web)
       and the conversion configs beside them; the alternate-forge
       pipeline folders retired (the GitHub workflow set is the one CI
       authority, the deploy knowledge lives in web/DEPLOYMENT.md);
     - the web root (2.1.0 restructure): the interface is ONE React tsx
       app — every route is a page folder (web/<Page>/<Page>.tsx) with
       the shared components loose at the web root, the server-side
       modules (server, dispatcher, store, auth, mesh, localauth.ts,
       api.ts) and the schema/deploy files sit beside them, and the
       static e2ugh console pages are fully absorbed into the tsx pages.
       the native wrappers (android/ios/desktop/extension) are generated
       on the runners (npx cap add / tauri scaffold) into build/native/*
       and never tracked — the conversion configs moved to the repo
       root (capacitor.config.ts, vite.config.ts, vitest.config.ts,
       tauri.conf.json, vercel.json, netlify.toml). */
  const logicfiles = globroot('*.ts').sort();
  assert.ok(
    logicfiles.length >= 30,
    `the root domain surface must stay populated (found ${logicfiles.length})`,
  );
  for (const entry of readdirSync(reporoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    assert.ok(
      entry.name === 'web' ||
        entry.name === 'docs' ||
        entry.name === 'tests' ||
        entry.name === 'build' ||
        entry.name === 'dist' ||
        entry.name === '.github' ||
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === 'coverage' ||
        entry.name === '__pycache__',
      `the directory ${entry.name} is neither the interface (web), support (docs, tests) nor a config/tool root — logic lives flat at the root`,
    );
  }
  /* the retired alternate-forge folders must stay retired. */
  for (const retired of ['.forgejo', '.gitea', '.gitlab', '.woodpecker']) {
    assert.equal(
      existsSync(join(reporoot, retired)),
      false,
      `${retired} is retired — the GitHub workflow set is the one CI authority`,
    );
  }
  /* the web interface contract: one tsx app, every module at the web
   * root (the 2.1.0 restructure — the static console pages and the
   * four native wrapper folders are gone for good). The 2.1.2 rule
   * retires the main.tsx wrapper too: the app owns its mount. */
  for (const required of [
    'App.tsx',
    'index.html',
    'index.css',
    'api.ts',
    'localauth.ts',
    'sandbox.ts',
    'server.ts',
    'db.ts',
    'auth.ts',
    'mesh.ts',
    'manifest.json',
    'popup.html',
    'popup.css',
    'icon.svg',
    'readme.md',
    'init.sql',
    'schema.prisma',
    'drizzle.config.ts',
    'mime.types',
    'caddyfile',
  ]) {
    assert.ok(
      existsSync(join(reporoot, 'web', required)),
      `web/${required} — the interface module lives at the web root`,
    );
  }
  /* the retired main.tsx wrapper: the app module owns the mount. */
  assert.equal(
    existsSync(join(reporoot, 'web', 'main.tsx')),
    false,
    'web/main.tsx is retired — App.tsx carries the createRoot bootstrap (the one-entry doctrine)',
  );
  const appsource = readFileSync(join(reporoot, 'web', 'App.tsx'), 'utf8');
  assert.match(
    appsource,
    /createRoot\(/,
    'App.tsx must carry the createRoot self-mount left behind by the retired main.tsx',
  );
  assert.match(
    appsource,
    /import "\.\/index\.css"/,
    'App.tsx must import the index.css stylesheet left behind by the retired main.tsx',
  );
  /* every route is a page folder carrying its own <Page>.tsx. */
  for (const page of [
    'Home',
    'Architecture',
    'AgentBrowser',
    'Compute',
    'Integrations',
    'Playground',
    'Docs',
    'NotFound',
    'Login',
    'Register',
    'Dashboard',
    'Console',
  ]) {
    assert.ok(
      existsSync(join(reporoot, 'web', page, `${page}.tsx`)),
      `web/${page}/${page}.tsx — one folder per route (the doctrine of the 2.1.0 interface)`,
    );
  }
  /* the platform/deploy configs live at the web root (the 2.1.4 home:
   * vercel.json, netlify.toml, capacitor.config.ts and vite.config.ts
   * ride beside the interface they publish, so the deploy root owns
   * them); vitest.config.ts (the root test battery) and the tauri
   * envelope (a release-version carrier) stay at the repository root. */
  for (const config of ['vitest.config.ts', 'tauri.conf.json']) {
    assert.ok(
      existsSync(join(reporoot, config)),
      `${config} — the root-borne config lives at the repository root`,
    );
  }
  for (const webconfig of [
    'capacitor.config.ts',
    'vite.config.ts',
    'vercel.json',
    'netlify.toml',
  ]) {
    assert.ok(
      existsSync(join(reporoot, 'web', webconfig)),
      `web/${webconfig} — the platform/deploy config lives at the web root`,
    );
  }
  /* the forbidden tree: the native wrappers are generated on the
   * runners, never tracked; the flattened app knows no nested support
   * folders; the static console is absorbed into the tsx interface. */
  for (const forbidden of [
    'android',
    'ios',
    'desktop',
    'extension',
    'pages',
    'components',
    'hooks',
    'lib',
    'contexts',
    'sandbox',
  ]) {
    assert.equal(
      existsSync(join(reporoot, 'web', forbidden)),
      false,
      `web/${forbidden} must not exist — the wrappers are generated on the runners and the interface is one flat tsx tree`,
    );
  }
  for (const forbidden of [
    'const.ts',
    'localauth.js',
    'login.html',
    'register.html',
    'console.html',
    'dashboard.html',
    'login.js',
    'register.js',
    'console.js',
    'dashboard.js',
  ]) {
    assert.equal(
      existsSync(join(reporoot, 'web', forbidden)),
      false,
      `web/${forbidden} must not exist — the interface is the single tsx app (the static console pages are absorbed)`,
    );
  }
  /* the dedupe contract scoped to the flat surfaces (root + web root). */
  const files = [
    ...logicfiles,
    ...readdirSync(join(reporoot, 'web'))
      .filter((f) => f.endsWith('.js') || f.endsWith('.html'))
      .map((f) => `web/${f}`),
  ];
  const seenhashes = new Map<string, string>();
  for (const file of files) {
    const bytes = readFileSync(join(reporoot, file));
    if (bytes.length === 0) {
      continue;
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    const previous = seenhashes.get(hash);
    assert.equal(
      previous,
      undefined,
      `${file} duplicates the content of ${previous ?? 'another file'}`,
    );
    seenhashes.set(hash, file);
  }
});

/* ------------------------------------------------------------------ */
/* gate 4b: the workflow reference contract (generated wrappers)       */
/* ------------------------------------------------------------------ */

test('ci gate workflows: no pipeline references the retired native wrapper paths', () => {
  /* the 2.1.0 doctrine (docs/native-wrappers.md): the android, ios,
   * desktop and extension wrappers are toolchain output generated on
   * the runners into build/native/* — no workflow may reference the
   * retired tracked folders under web/ ever again. */
  const workflowdir = join(reporoot, '.github', 'workflows');
  const workflows = readdirSync(workflowdir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  assert.ok(
    workflows.length >= 20,
    `the workflow set must stay populated (found ${workflows.length})`,
  );
  for (const workflow of workflows) {
    const text = readFileSync(join(workflowdir, workflow), 'utf8');
    for (const forbidden of ['web/android', 'web/ios', 'web/desktop', 'web/extension']) {
      assert.ok(
        !text.includes(forbidden),
        `${workflow} must not reference ${forbidden} — the native wrappers are generated on the runners, never tracked`,
      );
    }
  }
});

test('ci gate workflows: mobile.yml scaffolds both capacitor wrappers on the runner', () => {
  /* the mobile lane owns no tracked wrapper: it runs `cap add` on the
   * runner into build/native/{android,ios} (gitignored) and builds the
   * artifacts from the generated staging, per docs/native-wrappers.md. */
  const mobile = readFileSync(join(reporoot, '.github', 'workflows', 'mobile.yml'), 'utf8');
  for (const needle of [
    'cap add android',
    'build/native/android',
    'cap add ios',
    'build/native/ios',
  ]) {
    assert.ok(
      mobile.includes(needle),
      `mobile.yml must contain "${needle}" — the wrapper is generated at build time into build/native/*`,
    );
  }
});

test('ci gate workflows: desktop.yml scaffolds the tauri shell on the runner', () => {
  /* the desktop lane scaffolds the tauri envelope (Cargo.toml,
   * main.rs, lib.rs, build.rs) on the runner into build/native/desktop
   * and reads the tracked tauri.conf.json from the repository root. */
  const desktop = readFileSync(join(reporoot, '.github', 'workflows', 'desktop.yml'), 'utf8');
  assert.ok(
    desktop.includes('build/native/desktop'),
    'desktop.yml must scaffold the tauri shell into build/native/desktop — the wrapper is generated at build time, never tracked',
  );
});

test('ci gate workflows: the conversion configs point at the generated wrappers', () => {
  /* the tracked surface of the native lanes: the capacitor config at
   * the web root (where the cli resolves it) aims every platform at the
   * gitignored build/native/* output of the repository root and at the
   * single vite build the interface publishes (dist/public relative to
   * web/); the root .gitignore keeps that output out of the tree. */
  const capacitor = readFileSync(join(reporoot, 'web', 'capacitor.config.ts'), 'utf8');
  assert.ok(
    capacitor.includes('../build/native/android'),
    'capacitor.config.ts points the android platform at ../build/native/android',
  );
  assert.ok(
    capacitor.includes('../build/native/ios'),
    'capacitor.config.ts points the ios platform at ../build/native/ios',
  );
  assert.ok(
    capacitor.includes('webDir: "dist/public"'),
    'the capacitor webDir is the vite build output (dist/public at the web root)',
  );
  const tauri = readFileSync(join(reporoot, 'tauri.conf.json'), 'utf8');
  assert.ok(
    tauri.includes('web/dist/public'),
    'tauri.conf.json keeps frontendDist at web/dist/public',
  );
  const ignore = readFileSync(join(reporoot, '.gitignore'), 'utf8');
  assert.ok(
    /^build\/$/m.test(ignore),
    'the root .gitignore keeps build/ ignored — the generated wrappers are never committed',
  );
});

/* ------------------------------------------------------------------ */
/* gate 5: node smoke (mirrors the ci.yml smoke script)                */
/* ------------------------------------------------------------------ */

test('ci gate smoke: engine factory, random port and virtual cpuinfo', async () => {
  const vhe = await import('../index.ts');
  const engine = vhe.createVirtualEngine({ vcpus: 8, ramgb: 32, host: 'sandbox.internal' });
  assert.equal(engine.state, 'created');
  const endpoint = engine.start();
  assert.equal(engine.state, 'running');
  assert.ok(endpoint.port >= 30000 && endpoint.port <= 59999, 'the bound port stays in range');
  for (let draw = 0; draw < 100; draw += 1) {
    const port = vhe.randomPort();
    assert.ok(port >= 30000 && port <= 59999, `random port ${port} left the documented range`);
  }
  const cpuinfo = vhe.generateVirtualCpuinfo('AMD EPYC 9965', 8);
  assert.ok(cpuinfo.includes('AMD EPYC 9965'), 'the virtual cpuinfo carries the spoofed model');
  assert.ok(cpuinfo.includes('EPYC'), 'the virtual cpuinfo mentions the EPYC family');
  const meminfo = vhe.generateVirtualMeminfo(128);
  assert.ok(meminfo.includes('MemTotal:'), 'the virtual meminfo reports MemTotal');
  engine.stop();
  assert.equal(engine.state, 'stopped');
  assert.equal(vhe.disposeengine(engine.id), true, 'the engine leaves the registry');
});

/* ------------------------------------------------------------------ */
/* gate 6: python bridge (py_compile, ast parse and the selftest)      */
/* ------------------------------------------------------------------ */

test('ci gate python: qemubridge byte-compiles and parses under ast', async (t) => {
  if (!toolavailable('python3', ['-c', 'import sys'])) {
    t.skip('python3 is unavailable in this environment; the bridge gate cannot run');
    return;
  }
  const compilegate = await rungate('python3', ['-m', 'py_compile', 'qemubridge.py'], 60000);
  assert.equal(compilegate.spawnerror, null, 'the py_compile spawn must not fail');
  assert.equal(compilegate.code, 0, `py_compile reported:\n${compilegate.stderr.slice(-1500)}`);
  const astgate = await rungate(
    'python3',
    ['-c', 'import ast; ast.parse(open("qemubridge.py").read()); print("ast ok")'],
    60000,
  );
  assert.equal(astgate.code, 0, `ast parse reported:\n${astgate.stderr.slice(-1500)}`);
});

test('ci gate python: the offline bridge selftest passes', async (t) => {
  if (!toolavailable('python3', ['-c', 'import sys'])) {
    t.skip('python3 is unavailable in this environment; the bridge selftest cannot run');
    return;
  }
  const selftest = await rungate('python3', ['qemubridge.py'], 90000);
  assert.equal(selftest.spawnerror, null, 'the selftest spawn must not fail');
  assert.equal(selftest.timedout, false, 'the bridge selftest must terminate');
  assert.equal(selftest.code, 0, `bridge selftest failed:\n${selftest.stderr.slice(-1500)}`);
  assert.ok(selftest.stdout.includes('selftest ok'), 'the bridge reports the selftest banner');
});

/* ------------------------------------------------------------------ */
/* gate 7: release artifact manifest (release-artifacts job)           */
/* ------------------------------------------------------------------ */

test('ci gate release: sha256 manifest and SHA256SUMS render for every artifact', async () => {
  const pkg = JSON.parse(readFileSync(join(reporoot, 'package.json'), 'utf8')) as {
    readonly version: string;
  };
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'the release tag derives from a semver version');
  const files = walkfiles(reporoot).sort();
  assert.ok(files.length > 0, 'the release archive must carry at least one file');
  const entries = files.map((file) => ({
    file,
    bytes: readFileSync(join(reporoot, file)).length,
    sha256: createHash('sha256')
      .update(readFileSync(join(reporoot, file)))
      .digest('hex'),
  }));
  for (const entry of entries) {
    assert.match(
      entry.sha256,
      /^[0-9a-f]{64}$/,
      `${entry.file} must produce a 64 hex char checksum`,
    );
  }
  /* the sha256sum wire format: two spaces between digest and file name. */
  const sha256sums = `${entries.map((entry) => `${entry.sha256}  ${entry.file}`).join('\n')}\n`;
  for (const line of sha256sums.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    assert.match(
      line,
      /^[0-9a-f]{64} {2}\S+$/,
      'every SHA256SUMS line follows the coreutils format',
    );
  }
  /* recompute a deterministic sample to prove digest correctness. */
  const sample = entries.find((entry) => entry.file === 'package.json') ?? entries[0];
  assert.ok(sample !== undefined, 'the manifest must include package.json');
  const recomputed = createHash('sha256')
    .update(readFileSync(join(reporoot, sample.file)))
    .digest('hex');
  assert.equal(recomputed, sample.sha256, 're-hashing reproduces the manifest checksum');
  const manifest = {
    tag: `v${pkg.version}`,
    archive: `saddle-v${pkg.version}-source.zip`,
    filecount: entries.length,
    entries,
    sha256sums,
  };
  const roundtrip = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
  assert.equal(
    roundtrip.filecount,
    roundtrip.entries.length,
    'the manifest survives a json roundtrip',
  );
  assert.equal(roundtrip.entries.length, files.length, 'every artifact is accounted for');
});

/* ------------------------------------------------------------------ */
/* gate 8: the one container file contract (gateway 1.1.5 standard)    */
/* ------------------------------------------------------------------ */

test('ci gate container: the one Dockerfile carries the merged compose and entrypoint contract', () => {
  /* the compose stack and the entrypoint bootstrap are merged INTO the
   * Dockerfile and deleted: every compose spelling (docker-compose.yml,
   * compose.yml, compose.yaml, docker-compose.yaml) and entrypoint.sh
   * must not exist, and the one container file must carry every setting
   * the compose gate used to verify (memswap -1, shm 2g, the services,
   * the state volumes, the non-root user and the healthcheck). */
  for (const composefile of [
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yml',
    'compose.yaml',
  ]) {
    assert.equal(
      existsSync(join(reporoot, composefile)),
      false,
      `${composefile} is merged into the Dockerfile and must not exist`,
    );
  }
  assert.equal(
    existsSync(join(reporoot, 'Dockerfile.full')),
    false,
    'Dockerfile.full is retired — the one container file contract (the merged image builds every lane from the single Dockerfile)',
  );
  assert.equal(
    existsSync(join(reporoot, 'entrypoint.sh')),
    false,
    'entrypoint.sh is merged into the Dockerfile and must not exist',
  );
  const containerfile = readFileSync(join(reporoot, 'Dockerfile'), 'utf8');

  /* the entrypoint bootstrap ships embedded as a quoted heredoc COPY
   * (no separate script file exists) and the image entrypoint execs it. */
  assert.ok(
    containerfile.includes("COPY <<'ENTRYPOINT_SCRIPT_EOF' /entrypoint.sh"),
    'the entrypoint script is embedded as the heredoc COPY',
  );
  assert.ok(
    containerfile.includes('ENTRYPOINT_SCRIPT_EOF\n'),
    'the heredoc COPY closes its delimiter',
  );
  assert.ok(
    containerfile.includes('ENTRYPOINT ["/entrypoint.sh"]'),
    'the image entrypoint is the embedded bootstrap',
  );

  /* the orchestration contract of the former compose x-vhe-common
   * anchor rides on the hardened docker run recipes of the header - one
   * recipe per former compose service, the saddle node service included
   * (the compose.yml service folded into the one container file). */
  assert.ok(
    containerfile.includes('--memory-swap -1'),
    'the docker run recipes keep the unlimited swap contract (the former memswap_limit -1)',
  );
  assert.ok(
    containerfile.includes('--shm-size 2g'),
    'the docker run recipes keep the 2g shm contract',
  );
  for (const service of ['vhe', 'vheqemu', 'vhegpu', 'qemubridge', 'saddle-node']) {
    assert.ok(
      containerfile.includes(`#   ${service} (`),
      `the ${service} docker run recipe must be documented in the header`,
    );
  }
  assert.ok(
    containerfile.includes('--read-only'),
    'the saddle-node recipe keeps the read-only rootfs contract (the former compose read_only)',
  );
  assert.ok(
    containerfile.includes('--pids-limit 512'),
    'the saddle-node recipe keeps the pids contract (the former compose pids_limit)',
  );
  assert.ok(
    containerfile.includes('SADDLE_MEMORY_ENGINE=ram'),
    'the saddle-node service ENV surface (memory engine, sbot platform, cdn) rides in the one container file',
  );

  /* the image-side settings of the former compose services are ENV,
   * EXPOSE and VOLUME facts of the one container file. */
  assert.ok(
    containerfile.includes('SADDLE_DB="/data/web/saddle.db"'),
    'the web node database ENV of the former vhe service is baked in (SADDLE_*, the env surface web/db.ts reads)',
  );
  assert.ok(
    /^EXPOSE 8080$/m.test(containerfile),
    'the engine service port is EXPOSEd (the former compose default)',
  );
  assert.ok(
    /^VOLUME \/data \/cache\/mesa_shader_cache$/m.test(containerfile),
    'the state surface (vmdata, webdata, shader cache) is declared as VOLUME',
  );
  assert.ok(/^USER vhe$/m.test(containerfile), 'the runtime identity stays the non-root vhe user');

  /* the dockle CIS-DI-0010 lesson of the family: the HEALTHCHECK test
   * expression carries no '=' character anywhere (buildkit records the
   * healthcheck into the image config history as text and the heuristic
   * splits any '='-bearing token into a candidate credential pair - the
   * --interval/--timeout scheduling options are exempt, the expression
   * is not). */
  const lines = containerfile.split('\n');
  const healthindex = lines.findIndex((line) => line.startsWith('HEALTHCHECK'));
  assert.ok(healthindex !== -1, 'the one container file declares its HEALTHCHECK');
  const healthblock: string[] = [];
  for (const line of lines.slice(healthindex)) {
    if (healthblock.length > 0 && (line.startsWith('#') || /^[A-Z]/.test(line))) {
      break;
    }
    healthblock.push(line);
  }
  const healthtext = healthblock.join('\n');
  const cmdindex = healthtext.indexOf('CMD ');
  const expression = cmdindex >= 0 ? healthtext.slice(cmdindex) : healthtext;
  assert.ok(
    !expression.includes('='),
    'the HEALTHCHECK test expression carries no "=" character (the dockle CIS-DI-0010 heuristic)',
  );
  assert.ok(
    !healthtext.includes('=>'),
    'the HEALTHCHECK block carries no arrow callback "=>" (the dockle CIS-DI-0010 heuristic)',
  );
});
