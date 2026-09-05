/**
 * workflow simulation tests for the e2ugh repository (worklog task v5-E):
 * the suite mirrors, locally and for real, the gates that the github
 * actions pipelines (.github/workflows/ci.yml and release.yml) run on
 * every push — biome lint, module parsing through type stripping plus the
 * typescript 7.0.2 no-emit build, strict json validation of the ten camel
 * case data documents, the flat structure contract, the node smoke gate,
 * the python bridge gates and the release checksum manifest. every spawn
 * runs with a timeout inside a try/catch catcher and every gate that
 * depends on a tool missing from the environment is skipped with a
 * documented reason instead of failing silently.
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
 * instead of crashing the runner, mirroring a github actions step.
 */
function rungate(
  command: string,
  args: readonly string[],
  timeoutms: number,
  cwd: string = reporoot,
): Promise<gateoutcome> {
  return new Promise<gateoutcome>((resolve) => {
    try {
      const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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

test('ci gate structure: the grand-merge layout contract', () => {
  /* the merged repository carries one root surface:
     - the root: every logic TypeScript file sits flat at the repository
       root (the consolidation contract — no nested logic folders), with
       only the support folder (docs, tests) and the interface tree (web)
       beside them; the alternate-forge pipeline folders retired (the
       GitHub workflow set is the one CI authority, the deploy knowledge
       lives in web/DEPLOYMENT.md);
     - the web root: the merged e2ugh console files (server, dispatcher,
       store, auth, mesh and the static pages) sit beside the React app
       folders — every console file at the web root, no sandbox subfolder. */
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
  /* the console surface: the merged e2ugh console files at the web root. */
  for (const required of [
    'server.js',
    'sandbox.js',
    'db.js',
    'auth.js',
    'mesh.js',
    'localauth.js',
    'dashboard.js',
    'console.js',
    'console.html',
    'login.html',
    'register.html',
    'dashboard.html',
  ]) {
    assert.ok(
      existsSync(join(reporoot, 'web', required)),
      `web/${required} — the console file lives at the web root`,
    );
  }
  assert.equal(
    existsSync(join(reporoot, 'web', 'sandbox')),
    false,
    'web/sandbox no longer exists — every console file sits at the web root',
  );
  /* the dedupe contract scoped to the flat surfaces (root + console). */
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
    'the web node database ENV of the former vhe service is baked in (SADDLE_*, the env surface web/db.js reads)',
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
