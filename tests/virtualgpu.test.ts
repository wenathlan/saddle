/**
 * real tests for the virtual gpu module (virtualgpu.ts).
 *
 * the suite checks the verified pci identity bank (including the 26B5
 * correction), the blackwell MIG density rules, the composed MIG catalog
 * and the 89-char wide virtual nvidia-smi summary table produced by the
 * smi adapter builder that lives in render.ts.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultgpuregistry, smiadapterbuilder } from '../render.js';
import {
  composemigcatalog,
  fullpciid,
  GPU_BANK,
  getgpu,
  gpuerror,
  listgpus,
  MIGLAYOUTBLACKWELL,
  pciIds,
  validatedensity,
} from '../virtualgpu.js';

/* ------------------------------------------------------------------ */
/* verified identity bank                                              */
/* ------------------------------------------------------------------ */

test('the gpu bank pins the rtx 5090 at 10DE:2B85 with 32 GB', () => {
  const rtx5090 = GPU_BANK.find((spec) => spec.id === 'rtx5090');
  assert.ok(rtx5090 !== undefined, 'bank must contain rtx5090');
  assert.equal(rtx5090.pcivendor, '10DE');
  assert.equal(rtx5090.pcidevice, '2B85');
  assert.equal(fullpciid(rtx5090), '10DE:2B85');
  assert.equal(rtx5090.vrammib, 32768);
  assert.equal(rtx5090.memtype, 'GDDR7');
});

test('the rtx pro 6000 carries the corrected 26B5 device id, never 2BB5', () => {
  const pro = GPU_BANK.find((spec) => spec.id === 'rtxpro6000');
  assert.ok(pro !== undefined, 'bank must contain rtxpro6000');
  assert.equal(pro.pcidevice, '26B5');
  assert.equal(fullpciid(pro), '10DE:26B5');
  assert.notEqual(pro.pcidevice, '2BB5');
  assert.equal(pciIds.rtxpro6000, '10DE:26B5');
  // the whole canonical id table is free of the transcription error.
  assert.ok(!JSON.stringify(pciIds).includes('2BB5'));
  for (const spec of GPU_BANK) {
    assert.ok(spec.pcidevice !== '2BB5', `canonical id of ${spec.id} must never be 2BB5`);
  }
});

test('the b200 entry exposes the 192 GB HBM3e capacity', () => {
  const b200 = GPU_BANK.find((spec) => spec.id === 'b200');
  assert.ok(b200 !== undefined, 'bank must contain b200');
  assert.equal(b200.vrammib, 196608);
  assert.equal(b200.memtype, 'HBM3e');
  assert.equal(fullpciid(b200), '10DE:2665');
});

test('the gpu registry resolves every bank id and rejects unknown ones', () => {
  const ids = listgpus();
  for (const id of ['rtx5090', 'rtxpro6000', 'b200', 'h100', 'a100', 'rx9070xt', 'mi350x']) {
    assert.ok(ids.includes(id), `registry must list ${id}`);
    assert.equal(getgpu(id).id, id);
  }
  assert.throws(() => getgpu('voodoo3'), gpuerror);
});

/* ------------------------------------------------------------------ */
/* blackwell MIG density                                               */
/* ------------------------------------------------------------------ */

test('the blackwell MIG mirror lists the eight compute-slice profiles', () => {
  assert.equal(MIGLAYOUTBLACKWELL.length, 8);
  const profiles = MIGLAYOUTBLACKWELL.map((row) => row.profile);
  assert.deepEqual(profiles, [
    '1g.12gb',
    '1g.24gb',
    '2g.24gb',
    '2g.48gb',
    '3g.48gb',
    '3g.96gb',
    '4g.96gb',
    '7g.192gb',
  ]);
  const monolithic = MIGLAYOUTBLACKWELL.find((row) => row.profile === '7g.192gb');
  assert.equal(monolithic?.computeslices, 7);
  assert.equal(monolithic?.hbmgb, 192);
  assert.equal(monolithic?.smcount, 192);
});

test('validatedensity enforces 7 slices and 192 GB physical limits', () => {
  const one = MIGLAYOUTBLACKWELL.find((row) => row.profile === '1g.12gb');
  const three = MIGLAYOUTBLACKWELL.find((row) => row.profile === '3g.48gb');
  const four = MIGLAYOUTBLACKWELL.find((row) => row.profile === '4g.96gb');
  const seven = MIGLAYOUTBLACKWELL.find((row) => row.profile === '7g.192gb');
  assert.ok(one !== undefined && three !== undefined && four !== undefined && seven !== undefined);
  // seven 1g slices saturate the device legally.
  assert.equal(validatedensity(Array.from({ length: 7 }, () => one)), true);
  // eight 1g slices exceed the 7-slice ceiling.
  assert.equal(validatedensity(Array.from({ length: 8 }, () => one)), false);
  // two 3g.48gb layouts fit inside both ceilings.
  assert.equal(validatedensity([three, three]), true);
  // two 4g.96gb layouts double-book both the slices and the memory.
  assert.equal(validatedensity([four, four]), false);
  // the monolithic profile leaves room for nothing else.
  assert.equal(validatedensity([seven, one]), false);
  assert.equal(validatedensity([seven]), true);
});

test('composemigcatalog merges the guest slices with the blackwell layouts', () => {
  const catalog = composemigcatalog();
  assert.equal(catalog.length, 11);
  assert.deepEqual(catalog.slice(0, 3), ['1g.24gb', '2g.48gb', '4g.96gb']);
  for (const id of ['1g.12gb', '2g.24gb', '3g.48gb', '3g.96gb', '7g.192gb']) {
    assert.ok(catalog.includes(id), `catalog must include ${id}`);
  }
});

/* ------------------------------------------------------------------ */
/* virtual nvidia-smi adapter table                                    */
/* ------------------------------------------------------------------ */

test('the smi adapter renders the 89-char wide summary table', () => {
  const profile = defaultgpuregistry.require('rtx5090');
  const report = new smiadapterbuilder(profile)
    .withmemused(4096)
    .withutil(37)
    .withtemperature(55)
    .withfanspeed(40)
    .build();
  const lines = report.split('\n');
  assert.ok(lines.length > 10);

  // the summary table opens and closes with "+" + 87 dashes + "+" borders.
  const summaryborder = `+${'-'.repeat(87)}+`;
  assert.equal(lines[1], summaryborder, 'summary table must open with the 89-char border');
  assert.equal(lines[10], summaryborder, 'summary table must close with the 89-char border');
  // every summary line between index 1 and 10 is exactly 89 chars wide;
  // the data rows are fenced with pipes while 1 and 10 are the borders.
  for (let i = 1; i <= 10; i += 1) {
    assert.equal(lines[i]?.length, 89, `summary line ${i} must be 89 chars`);
    if (i !== 1 && i !== 10) {
      assert.ok((lines[i]?.startsWith('|') ?? false) && (lines[i]?.endsWith('|') ?? false));
    }
  }

  // the process table is the narrower 75-char layout.
  const processborder = `+${'-'.repeat(73)}+`;
  assert.ok(lines.includes(processborder), 'process table must close with the 75-char border');
  const processrows = lines.filter((line) => line.startsWith('|') && line.length === 75);
  assert.ok(processrows.length >= 2);

  // the header pins the verified driver and cuda anchors.
  assert.ok(report.includes('NVIDIA-SMI 575.57.08'));
  assert.ok(report.includes('Driver Version: 575.57.08'));
  assert.ok(report.includes('CUDA Version: 12.9'));
  assert.ok(report.includes('NVIDIA RTX 5090'));
  assert.ok(report.includes('4096MiB / 32768MiB'));
  assert.ok(report.includes('No running processes found'));
});
