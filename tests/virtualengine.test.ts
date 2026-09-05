/**
 * real tests for the e2ugh engine entry point (index.ts).
 *
 * the suite exercises the public surface with zero mocks: engines are
 * created, started and stopped, ports are drawn from the real crypto
 * generator and specifications are validated against the real rule table.
 */

import assert from 'node:assert/strict';
import process from 'node:process';
import { test } from 'node:test';
import {
  buildEndpoint,
  createVirtualEngine,
  disposeengine,
  engineerror,
  enginelimits,
  engineRegistry,
  type enginespec,
  engineversions,
  lastprobe,
  probeengine,
  randomPort,
  resolveHost,
  validateSpec,
} from '../index.js';

/* ------------------------------------------------------------------ */
/* engineversions                                                      */
/* ------------------------------------------------------------------ */

test('engineversions carries the critical toolchain anchors', () => {
  assert.ok(typeof engineversions === 'object');
  for (const key of [
    'nodecurrent',
    'nodelts',
    'typescript',
    'docker',
    'compose',
    'mesaa',
    'qemu',
  ] as const) {
    assert.ok(key in engineversions, `engineversions must carry ${key}`);
    assert.ok(typeof engineversions[key] === 'string' && engineversions[key].length > 0);
  }
  assert.equal(engineversions.nodecurrent, '26.7.0');
  assert.equal(engineversions.docker, '29.7.2');
  assert.equal(engineversions.qemu, '11.1.0');
  assert.equal(engineversions.typescript, '7.0.2');
});

test('enginelimits advertise the 1-192 vcpu and 30000-59999 port ranges', () => {
  assert.equal(enginelimits.minvcpu, 1);
  assert.equal(enginelimits.maxvcpu, 192);
  assert.equal(enginelimits.minport, 30000);
  assert.equal(enginelimits.maxport, 59999);
});

/* ------------------------------------------------------------------ */
/* randomPort                                                          */
/* ------------------------------------------------------------------ */

test('randomPort draws 100 samples inside the 30000-59999 range', () => {
  const samples: number[] = [];
  for (let i = 0; i < 100; i += 1) {
    const port = randomPort();
    assert.ok(Number.isInteger(port), 'port must be an integer');
    assert.ok(port >= 30000 && port <= 59999, `port ${port} outside the engine limits`);
    samples.push(port);
  }
  const distinct = new Set(samples).size;
  assert.ok(distinct >= 50, `100 crypto draws produced only ${distinct} distinct ports`);
});

test('randomPort honors valid overrides and rejects invalid ones', () => {
  assert.equal(randomPort(30000), 30000);
  assert.equal(randomPort(59999), 59999);
  assert.throws(() => randomPort(29999), engineerror);
  assert.throws(() => randomPort(60000), engineerror);
  assert.throws(() => randomPort(65535.5), engineerror);
});

/* ------------------------------------------------------------------ */
/* resolveHost / buildEndpoint                                         */
/* ------------------------------------------------------------------ */

test('resolveHost requires an explicit host and never assumes a default address', () => {
  const savedhost = process.env.virtualenginehost;
  const savedalias = process.env.vhehost;
  delete process.env.virtualenginehost;
  delete process.env.vhehost;
  try {
    assert.throws(() => resolveHost(), engineerror);
    assert.equal(resolveHost('test.local'), 'test.local');
    assert.equal(resolveHost('  test.local  '), 'test.local');
    assert.throws(() => resolveHost('   '), engineerror);
  } finally {
    if (savedhost !== undefined) process.env.virtualenginehost = savedhost;
    if (savedalias !== undefined) process.env.vhehost = savedalias;
  }
});

test('buildEndpoint combines host and random port into a concrete url', () => {
  const endpoint = buildEndpoint('test.local', 31234);
  assert.equal(endpoint.host, 'test.local');
  assert.equal(endpoint.port, 31234);
  assert.equal(endpoint.url, 'http://test.local:31234');
  const drawn = buildEndpoint('test.local');
  assert.ok(drawn.port >= 30000 && drawn.port <= 59999);
  assert.equal(drawn.url, `http://test.local:${drawn.port}`);
});

/* ------------------------------------------------------------------ */
/* validateSpec                                                        */
/* ------------------------------------------------------------------ */

const goodspec: enginespec = {
  model: 'AMD EPYC 9965',
  vcpus: 8,
  ramgb: 16,
  vramgb: 24,
  mig: '1g.24gb',
  runtime: 'qemu',
  host: 'test.local',
  port: 34567,
  metricsintervalms: 1000,
};

test('validateSpec accepts a fully valid specification', () => {
  const result = validateSpec(goodspec);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.normalized !== null);
  assert.equal(result.normalized?.port, 34567);
  assert.equal(result.normalized?.host, 'test.local');
  assert.ok(Object.isFrozen(result.normalized), 'normalized spec must be frozen');
});

test('validateSpec rejects boundary violations with field specific errors', () => {
  const zerovcpu = validateSpec({ ...goodspec, vcpus: 0 });
  assert.equal(zerovcpu.valid, false);
  assert.ok(zerovcpu.errors.some((message) => message.startsWith('vcpus')));

  const overport = validateSpec({ ...goodspec, port: 60000 });
  assert.equal(overport.valid, false);
  assert.ok(overport.errors.some((message) => message.startsWith('port')));

  const badmig = validateSpec({ ...goodspec, mig: '9g.999gb' as enginespec['mig'] });
  assert.equal(badmig.valid, false);
  assert.ok(badmig.errors.some((message) => message.startsWith('mig')));

  const badruntime = validateSpec({ ...goodspec, runtime: 'kvm' as enginespec['runtime'] });
  assert.equal(badruntime.valid, false);
  assert.ok(badruntime.errors.some((message) => message.startsWith('runtime')));

  const emptyhost = validateSpec({ ...goodspec, host: '' });
  assert.equal(emptyhost.valid, false);
  assert.ok(emptyhost.errors.some((message) => message.startsWith('host')));
});

test('validateSpec reports a missing host as a required field error', () => {
  const { host: _omitted, ...nohost } = goodspec;
  const result = validateSpec(nohost as enginespec);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((message) => message.includes('host') && message.includes('missing')),
  );
  assert.equal(result.normalized, null);
});

test('validateSpec warns when vramgb exceeds ramgb', () => {
  const result = validateSpec({ ...goodspec, vramgb: 96, ramgb: 16 });
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((message) => message.includes('vramgb exceeds ramgb')));
});

/* ------------------------------------------------------------------ */
/* createVirtualEngine lifecycle                                       */
/* ------------------------------------------------------------------ */

test('createVirtualEngine builds a registered engine from an explicit host', () => {
  const engine = createVirtualEngine({ host: 'test.local' });
  assert.equal(engine.state, 'created');
  assert.equal(engine.spec.host, 'test.local');
  assert.equal(engine.spec.model, 'AMD EPYC 9965');
  assert.ok(engine.spec.port >= 30000 && engine.spec.port <= 59999);
  assert.ok(engineRegistry.has(engine.id), 'engine must be registered at creation');

  const endpoint = engine.start();
  assert.equal(engine.state, 'running');
  assert.equal(endpoint.host, 'test.local');
  assert.equal(endpoint.url, `http://test.local:${endpoint.port}`);
  assert.equal(engine.endpoint?.url, endpoint.url);

  const health = probeengine(engine);
  assert.equal(health.healthy, true);
  assert.equal(lastprobe(engine)?.engineid, engine.id);

  // a failed double start degrades the engine, exactly as the state machine
  // documents: the failed transition flips the state before rethrowing.
  assert.throws(() => engine.start(), engineerror, 'a running engine refuses a second start');
  assert.equal(engine.state, 'degraded');

  engine.stop();
  assert.equal(engine.state, 'stopped');
  // a stopped engine may boot again; the second start binds a fresh endpoint.
  const second = engine.start();
  assert.equal(engine.state, 'running');
  assert.ok(second.port >= 30000 && second.port <= 59999);
  engine.stop();

  assert.equal(disposeengine(engine.id), true);
  assert.equal(engineRegistry.has(engine.id), false);
});

test('createVirtualEngine rejects an invalid option set with engineerror', () => {
  assert.throws(() => createVirtualEngine({ host: 'test.local', vcpus: 0 }), engineerror);
  assert.throws(() => createVirtualEngine({ host: 'test.local', port: 70000 }), engineerror);
});

test('createVirtualEngine refuses to run without a host', () => {
  const savedhost = process.env.virtualenginehost;
  const savedalias = process.env.vhehost;
  delete process.env.virtualenginehost;
  delete process.env.vhehost;
  try {
    assert.throws(() => createVirtualEngine({}), engineerror);
  } finally {
    if (savedhost !== undefined) process.env.virtualenginehost = savedhost;
    if (savedalias !== undefined) process.env.vhehost = savedalias;
  }
});

/* ------------------------------------------------------------------ */
/* export barrel                                                       */
/* ------------------------------------------------------------------ */

test('the index barrel re-exports the v2 module surface as real functions', async () => {
  const barrel = await import('../index.ts');
  const functions = [
    'createVirtualEngine',
    'randomPort',
    'resolveHost',
    'buildEndpoint',
    'validateSpec',
    'probeengine',
    'disposeengine',
    'generateVirtualCpuinfo',
    'generateVirtualLscpu',
    'createVirtualProcessor',
    'validateCpuCount',
    'listBestVirtualProcessors',
    'generateVirtualMeminfo',
    'meminfoForMiB',
    'dockerMemoryFlags',
    'createVirtualMemory',
    'fullpciid',
    'composemigcatalog',
    'validatedensity',
    'creategrid',
    'multiplex',
    'buildqemucmd',
  ] as const;
  for (const name of functions) {
    assert.equal(typeof barrel[name], 'function', `barrel export ${name} must be a function`);
  }
  const dataexports = ['engineversions', 'enginelimits', 'specschema', 'engineRegistry'] as const;
  for (const name of dataexports) {
    assert.ok(
      barrel[name] !== undefined && barrel[name] !== null,
      `barrel export ${name} must exist`,
    );
  }
  assert.ok(Array.isArray(barrel.BEST_VIRTUAL_PROCESSORS));
  assert.ok(barrel.BEST_VIRTUAL_PROCESSORS.length >= 6);
  assert.ok(Array.isArray(barrel.GPU_BANK));
  assert.ok(barrel.GPU_BANK.length >= 7);
  assert.ok(Array.isArray(barrel.MIGPROFILES));
  assert.equal(barrel.MIGPROFILES.length, 3);
  assert.ok(barrel.engineRegistry instanceof Map);
});
