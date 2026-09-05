/**
 * real tests for the virtual processor bank (virtualcpu.ts).
 *
 * the suite renders actual /proc/cpuinfo and lscpu payloads from the
 * embedded data bank and verifies block counts, model names, avx-512
 * flags and the modularity validator without any mocking.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BEST_VIRTUAL_PROCESSORS,
  boards,
  cpucountlimits,
  cpuRegistry,
  findVirtualCpus,
  generateVirtualCpuinfo,
  generateVirtualLscpu,
  getVirtualCpu,
  hardwareerror,
  listVirtualCpus,
  marchFlag,
  registerVirtualCpu,
  removeVirtualCpu,
  solvetopology,
  validateCpuCount,
} from '../virtualcpu.js';

/* ------------------------------------------------------------------ */
/* processor bank                                                      */
/* ------------------------------------------------------------------ */

test('the bank embeds the top verified processors', () => {
  const models = BEST_VIRTUAL_PROCESSORS.map((spec) => spec.model);
  assert.ok(models.includes('AMD EPYC 9965'), 'bank must contain the EPYC 9965');
  assert.ok(models.includes('AMD Ryzen 9 9950X3D'), 'bank must contain the Ryzen 9950X3D');
  assert.ok(
    models.includes('AMD Threadripper PRO 9995WX'),
    'bank must contain the Threadripper PRO 9995WX',
  );
  const epyc = getVirtualCpu('AMD EPYC 9965');
  assert.equal(epyc.cores, 192);
  assert.equal(epyc.threads, 384);
  assert.equal(epyc.vendor, 'amd');
});

test('the cpuRegistry seeds from the bank with case-insensitive lookup', () => {
  assert.ok(cpuRegistry.size >= BEST_VIRTUAL_PROCESSORS.length);
  assert.deepEqual(getVirtualCpu('amd epyc 9965'), getVirtualCpu('AMD EPYC 9965'));
  assert.throws(() => getVirtualCpu('unknown model 9000'), hardwareerror);
  const ryzen = findVirtualCpus('9950x3d');
  assert.equal(ryzen.length, 1);
  assert.equal(ryzen[0]?.model, 'AMD Ryzen 9 9950X3D');
  assert.ok(listVirtualCpus().includes('AMD EPYC 9965'));
});

test('custom models register and remove through the registry', () => {
  const custom = { ...getVirtualCpu('AMD EPYC 9965'), model: 'AMD EPYC Test Custom 1' };
  const key = registerVirtualCpu(custom);
  assert.equal(key, 'amd epyc test custom 1');
  assert.equal(getVirtualCpu('AMD EPYC Test Custom 1').cores, 192);
  assert.throws(() => registerVirtualCpu(custom), hardwareerror);
  assert.equal(removeVirtualCpu('AMD EPYC Test Custom 1'), true);
  assert.equal(removeVirtualCpu('AMD EPYC Test Custom 1'), false);
});

/* ------------------------------------------------------------------ */
/* /proc/cpuinfo generation                                            */
/* ------------------------------------------------------------------ */

test('generateVirtualCpuinfo renders N processor blocks with real model data', () => {
  const text = generateVirtualCpuinfo('AMD EPYC 9965', 16);
  const blocks = text.split('\n\n');
  assert.equal(blocks.length, 16, '16 vcpus must produce 16 blocks');
  const processorlines = text.match(/^processor\t: \d+$/gm) ?? [];
  assert.equal(processorlines.length, 16);
  assert.ok(text.includes('processor\t: 0'));
  assert.ok(text.includes('processor\t: 15'));
  assert.ok(
    text.includes('AMD EPYC 9965 192-Core Processor'),
    'model name must be the real display name',
  );
  assert.ok(text.includes('vendor_id\t: AuthenticAMD'));
  assert.ok(text.includes('cache size\t: 384 MB'));
  assert.ok(text.includes('52 bits physical, 57 bits virtual'));
  assert.ok(text.includes('fpu\t\t: yes'));
  for (const block of blocks) {
    assert.ok(block.includes('model name'), 'every block carries a model name');
    assert.ok(block.includes('flags'), 'every block carries the flag set');
    assert.ok(block.includes('bogomips'), 'every block carries bogomips');
  }
});

test('generateVirtualCpuinfo exposes the full avx-512 flag set of zen 5', () => {
  const text = generateVirtualCpuinfo('AMD Ryzen 9 9950X3D', 4);
  for (const flag of [
    'avx512f',
    'avx512dq',
    'avx512cd',
    'avx512bw',
    'avx512vl',
    'avx512_bf16',
    'sha_ni',
  ]) {
    assert.ok(text.includes(flag), `flags must include ${flag}`);
  }
});

test('generateVirtualCpuinfo renders an intel model with genuine intel identity', () => {
  const text = generateVirtualCpuinfo('Intel Core Ultra 9 285K', 3);
  assert.equal(text.split('\n\n').length, 3);
  assert.ok(text.includes('vendor_id\t: GenuineIntel'));
  assert.ok(text.includes('Intel(R) Core(TM) Ultra 9 285K'));
  assert.ok(text.includes('cpu family\t: 6'));
});

test('generateVirtualCpuinfo rejects unknown models and out-of-range counts', () => {
  assert.throws(() => generateVirtualCpuinfo('no such cpu', 4), hardwareerror);
  assert.throws(() => generateVirtualCpuinfo('AMD EPYC 9965', 0), hardwareerror);
  assert.throws(() => generateVirtualCpuinfo('AMD EPYC 9965', 385), hardwareerror);
});

/* ------------------------------------------------------------------ */
/* lscpu generation                                                    */
/* ------------------------------------------------------------------ */

test('generateVirtualLscpu emits the util-linux field layout', () => {
  const text = generateVirtualLscpu('AMD EPYC 9965', 32);
  for (const field of [
    'Architecture:',
    'CPU op-mode(s):',
    'Byte Order:',
    'Address sizes:',
    'CPU(s):',
    'On-line CPU(s) list:',
    'Vendor ID:',
    'Model name:',
    'CPU family:',
    'Thread(s) per core:',
    'Core(s) per socket:',
    'Socket(s):',
    'CPU max MHz:',
    'CPU min MHz:',
    'L3 cache:',
    'NUMA node(s):',
    'Vulnerability Spectre v2:',
  ]) {
    assert.ok(text.includes(field), `lscpu output must include ${field}`);
  }
  assert.ok(/CPU\(s\):\s+32\b/.test(text), 'lscpu must report the requested 32 cpus');
  assert.ok(/On-line CPU\(s\) list:\s+0-31/.test(text));
  assert.ok(text.includes('AuthenticAMD'));
  assert.ok(text.includes('AMD EPYC 9965 192-Core Processor'));
});

test('generateVirtualLscpu splits vcpus across the requested numa nodes', () => {
  const text = generateVirtualLscpu('AMD EPYC 9965', 16, 2);
  assert.ok(/NUMA node\(s\):\s+2/.test(text));
  assert.ok(/NUMA node0 CPU\(s\):\s+0-7/.test(text));
  assert.ok(/NUMA node1 CPU\(s\):\s+8-15/.test(text));
});

/* ------------------------------------------------------------------ */
/* topology, modularity and helpers                                    */
/* ------------------------------------------------------------------ */

test('solvetopology maps vcpus onto the physical package', () => {
  const topo = solvetopology(getVirtualCpu('AMD EPYC 9965'), 16);
  assert.equal(topo.vcpus, 16);
  assert.equal(topo.threadspercore, 2);
  assert.equal(topo.coresonline, 8);
  assert.equal(topo.sockets, 1);
  assert.equal(topo.fullypopulated, false);
  const full = solvetopology(getVirtualCpu('AMD Ryzen 9 9950X3D'), 32);
  assert.equal(full.fullypopulated, true);
});

test('validateCpuCount enforces the 1-192 modularity range', () => {
  assert.equal(validateCpuCount(1), true);
  assert.equal(validateCpuCount(192), true);
  assert.equal(validateCpuCount(64), true);
  assert.equal(validateCpuCount(0), false);
  assert.equal(validateCpuCount(193), false);
  assert.equal(validateCpuCount(-8), false);
  assert.equal(validateCpuCount(16.5), false);
  assert.equal(validateCpuCount(Number.NaN), false);
  assert.deepEqual({ ...cpucountlimits }, { min: 1, max: 192 });
});

test('marchFlag pins the znver4 avx-512 tuning string', () => {
  const flag = marchFlag();
  assert.ok(flag.includes('-march=znver4'));
  assert.ok(flag.includes('-mavx512f'));
  assert.ok(flag.includes('-mavx512bw'));
  assert.ok(flag.includes('-mprefer-vector-width=512'));
});

test('boards lists the sp5, str5 and am5 socket families', () => {
  const list = boards();
  for (const socket of ['SP5', 'sTR5', 'AM5']) {
    assert.ok(
      list.some((entry) => entry === socket || entry.startsWith(`${socket} `)),
      `boards must include the ${socket} socket family`,
    );
  }
});
