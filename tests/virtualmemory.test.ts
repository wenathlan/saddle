/**
 * real tests for the virtual memory module (virtualmemory.ts).
 *
 * the suite parses the generated /proc/meminfo payloads, checks the MIG
 * catalog, exercises the docker flag generator and validates the curated
 * NUMA presets; every value comes from the real module data.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildnumatopology,
  dockerMemoryFlags,
  generatememinfo128g,
  generateVirtualMeminfo,
  getmigprofile,
  MIGPROFILES,
  meminfo128gtotalkb,
  meminfoForMiB,
  memoryerror,
  memorylimits,
  memorySwap,
  type migprofileid,
  NUMATOPOLOGIES,
  pagealign,
  planhugepages,
  shmSize,
  validatememoryrequest,
} from '../virtualmemory.js';

/** extracts one numeric meminfo row in kB from a generated payload. */
function meminfovalue(text: string, key: string): number {
  // long keys leave no padding space after the colon, hence \s*.
  const match = text.match(new RegExp(`^${key}:\\s*(\\d+) kB$`, 'm'));
  assert.ok(match !== null, `meminfo must contain the ${key} row`);
  return Number(match[1]);
}

/* ------------------------------------------------------------------ */
/* /proc/meminfo generation                                            */
/* ------------------------------------------------------------------ */

test('generateVirtualMeminfo renders the full 128 GB payload in kB', () => {
  const text = generateVirtualMeminfo(128, { freefraction: 0.4, availablefraction: 0.9 });
  for (const key of [
    'MemTotal',
    'MemFree',
    'MemAvailable',
    'Buffers',
    'Cached',
    'SwapTotal',
    'SwapFree',
    'CommitLimit',
    'Committed_AS',
    'VmallocTotal',
    'Hugepagesize',
    'DirectMap4k',
    'DirectMap2M',
    'DirectMap1G',
  ]) {
    assert.ok(new RegExp(`^${key}:\\s*\\d+ kB$`, 'm').test(text), `meminfo must include ${key}`);
  }
  // the parametric generator subtracts the 131072 kB firmware carveout
  // from the physical 128 GiB total (134217728 kB), yielding 134086656 kB.
  assert.equal(meminfovalue(text, 'MemTotal'), 134086656);
  assert.equal(meminfovalue(text, 'VmallocTotal'), 34359738367);
  assert.equal(meminfovalue(text, 'Hugepagesize'), 2048);
  // at 128 GB the direct map carries 1 GiB pages.
  assert.ok(meminfovalue(text, 'DirectMap1G') > 0);
  // deterministic fractions are honored and page aligned.
  assert.equal(meminfovalue(text, 'MemFree'), pagealign(134086656 * 0.4));
  assert.equal(meminfovalue(text, 'MemAvailable'), pagealign(134086656 * 0.9));
  // huge page options flow into the report.
  const huge = generateVirtualMeminfo(64, { hugepages1g: 30 });
  assert.equal(meminfovalue(huge, 'HugePages_Total'), 30);
  assert.equal(meminfovalue(huge, 'HugePages_Free'), 30);
  assert.equal(meminfovalue(huge, 'Hugetlb'), 30 * 1048576);
});

test('generateVirtualMeminfo rejects non-positive totals', () => {
  assert.throws(() => generateVirtualMeminfo(0), memoryerror);
  assert.throws(() => generateVirtualMeminfo(-4), memoryerror);
});

test('the 128g artifact keeps the physical anchor and the carveout behavior', () => {
  assert.equal(meminfo128gtotalkb, 134217728);
  const text = generatememinfo128g({ freefraction: 0.5, availablefraction: 0.9 });
  assert.equal(meminfovalue(text, 'MemTotal'), 134086656);
});

test('meminfoForMiB renders the page-aligned one-line form', () => {
  assert.equal(meminfoForMiB(2048), 'MemTotal: 2097152 kB\n');
  assert.equal(meminfoForMiB(1), 'MemTotal: 1024 kB\n');
  assert.equal(meminfoForMiB(1.5), 'MemTotal: 1536 kB\n');
  assert.equal(meminfoForMiB(1.4), 'MemTotal: 1432 kB\n');
  assert.throws(() => meminfoForMiB(0), memoryerror);
});

test('pagealign rounds down to 4 kB boundaries', () => {
  assert.equal(pagealign(2049), 2048);
  assert.equal(pagealign(2051), 2048);
  assert.equal(pagealign(2052), 2052);
  assert.equal(pagealign(0), 0);
});

/* ------------------------------------------------------------------ */
/* MIG profiles                                                        */
/* ------------------------------------------------------------------ */

test('the MIG catalog covers the three guest-side slices of the 96 GB device', () => {
  assert.equal(MIGPROFILES.length, 3);
  const byid = new Map(MIGPROFILES.map((profile) => [profile.id, profile]));
  assert.deepEqual(byid.get('1g.24gb'), { id: '1g.24gb', slicegb: 24, maxinstances: 4 });
  assert.deepEqual(byid.get('2g.48gb'), { id: '2g.48gb', slicegb: 48, maxinstances: 2 });
  assert.deepEqual(byid.get('4g.96gb'), { id: '4g.96gb', slicegb: 96, maxinstances: 1 });
  for (const profile of MIGPROFILES) {
    assert.equal(profile.slicegb * profile.maxinstances <= 96, true);
  }
});

test('getmigprofile resolves ids and treats off as no slicing', () => {
  assert.equal(getmigprofile('off'), null);
  assert.equal(getmigprofile('2g.48gb')?.maxinstances, 2);
  assert.throws(() => getmigprofile('8g.12gb' as migprofileid), memoryerror);
});

/* ------------------------------------------------------------------ */
/* docker memory flags                                                 */
/* ------------------------------------------------------------------ */

test('dockerMemoryFlags emits the canonical unlimited-swap plan', () => {
  const flags = dockerMemoryFlags();
  assert.deepEqual(flags.run, [
    '--memory=32g',
    '--memory-swap=-1',
    '--shm-size=2g',
    '--tmpfs /tmp/shadercache:size=20g',
    '--kernel-memory=0',
  ]);
  assert.equal(flags.compose.mem_limit, '32g');
  assert.equal(flags.compose.memswap_limit, -1);
  assert.equal(flags.compose.shm_size, '2g');
  assert.deepEqual(flags.compose.tmpfs, ['/tmp/shadercache:size=20g']);
  assert.deepEqual(flags.sysctl, { 'vm.overcommit_memory': '2', 'vm.overcommit_ratio': '50' });
  assert.ok(flags.rationale.length >= 3);
});

test('dockerMemoryFlags honors custom capacity and bounded swap', () => {
  const flags = dockerMemoryFlags({ ramgb: 64, shmsizegb: 4, unlimitedswap: false });
  assert.ok(flags.run.includes('--memory=64g'));
  assert.ok(flags.run.includes('--memory-swap=128g'));
  assert.ok(flags.run.includes('--shm-size=4g'));
  assert.equal(flags.compose.memswap_limit, '128g');
});

test('the module pins the docker swap and shm sentinels', () => {
  assert.equal(memorySwap, '-1');
  assert.equal(shmSize, '2g');
});

/* ------------------------------------------------------------------ */
/* limits, request validation and huge pages                           */
/* ------------------------------------------------------------------ */

test('memorylimits mirrors the 1-192 vcpu and 1-1024 GB RAM extremes', () => {
  assert.deepEqual(
    { ...memorylimits },
    {
      minvcpu: 1,
      maxvcpu: 192,
      minramgb: 1,
      maxramgb: 1024,
      minvramgb: 8,
      maxvramgb: 96,
    },
  );
});

test('validatememoryrequest accepts a coherent request and builds a plan', () => {
  const result = validatememoryrequest({ vcpus: 16, ramgb: 128, vramgb: 24, mig: '1g.24gb' });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.plan !== null);
});

test('validatememoryrequest rejects limit violations and MIG mismatches', () => {
  const badvcpu = validatememoryrequest({ vcpus: 500, ramgb: 32, vramgb: 24 });
  assert.equal(badvcpu.valid, false);
  assert.ok(badvcpu.errors.some((message) => message.startsWith('vcpus')));
  const mismatch = validatememoryrequest({ ramgb: 32, vramgb: 24, mig: '4g.96gb' });
  assert.equal(mismatch.valid, false);
  assert.ok(mismatch.errors.some((message) => message.includes('MIG profile')));
  assert.equal(mismatch.plan, null);
});

test('planhugepages splits large machines into 1G and 2M pools', () => {
  const large = planhugepages(512);
  assert.deepEqual(large, [
    { size: '1G', count: 256, coversgb: 256 },
    { size: '2M', count: 2048, coversgb: 4 },
  ]);
  const small = planhugepages(64);
  assert.equal(small.length, 1);
  assert.equal(small[0]?.size, '2M');
  assert.equal(small[0]?.count, 16384);
  assert.throws(() => planhugepages(0), memoryerror);
});

/* ------------------------------------------------------------------ */
/* NUMA presets                                                        */
/* ------------------------------------------------------------------ */

test('buildnumatopology renders cpu ranges with the 10/32 distance matrix', () => {
  const topo = buildnumatopology(16, 2);
  assert.equal(topo.nodes, 2);
  assert.deepEqual(topo.cpuranges, ['0-7', '8-15']);
  assert.deepEqual(topo.distances, [
    [10, 32],
    [32, 10],
  ]);
  assert.ok(topo.description.length > 0);
  assert.throws(() => buildnumatopology(16, 0), memoryerror);
  assert.throws(() => buildnumatopology(16, 17), memoryerror);
});

test('NUMATOPOLOGIES curates the common EPYC thread counts', () => {
  const expected = [
    [192, 4],
    [192, 8],
    [128, 4],
    [96, 2],
    [64, 2],
    [32, 1],
  ];
  assert.equal(NUMATOPOLOGIES.length, expected.length);
  NUMATOPOLOGIES.forEach((topo, index) => {
    const [vcpus, nodes] = expected[index] ?? [0, 0];
    assert.equal(topo.nodes, nodes, `preset ${index} must have ${nodes} nodes`);
    assert.equal(topo.cpuranges.length, nodes);
    // the highest cpu index of the last range reveals the preset thread count.
    const last = topo.cpuranges[topo.cpuranges.length - 1] ?? '0';
    const highest = Number(last.split('-').at(-1));
    assert.equal(highest, vcpus - 1, `preset ${index} must cover ${vcpus} vcpus`);
    for (const row of topo.distances) {
      assert.equal(row.length, nodes);
      for (const distance of row) {
        assert.ok(distance === 10 || distance === 32);
      }
    }
  });
});
