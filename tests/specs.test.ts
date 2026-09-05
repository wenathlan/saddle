/**
 * real tests for the embedded JSON specification files.
 *
 * the suite loads every config artifact from disk and verifies counts,
 * critical identities, corrected pci ids, odd modularity presets and the
 * cross-reference integrity declared by virtualhardware.json.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function loadjson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;
}

/* ------------------------------------------------------------------ */
/* processors.json                                                     */
/* ------------------------------------------------------------------ */

test('processors.json carries 57+ verified processors', () => {
  const spec = loadjson('processors.json');
  const processors = spec.processors as Record<string, unknown>[];
  assert.ok(processors.length >= 57, `expected at least 57 processors, got ${processors.length}`);
});

test('processors.json pins the epyc 9965 at 192 cores and includes the xeon 6980p', () => {
  const spec = loadjson('processors.json');
  const processors = spec.processors as Record<string, unknown>[];
  const epyc = processors.find((entry) => entry.id === 'epyc-9965');
  assert.ok(epyc !== undefined, 'processors.json must contain epyc-9965');
  assert.equal(epyc.cores, 192);
  assert.equal(epyc.threads, 384);
  const xeon = processors.find((entry) => entry.id === 'xeon-6980p');
  assert.ok(xeon !== undefined, 'processors.json must contain xeon-6980p');
  assert.equal(typeof xeon.cores, 'number');
});

/* ------------------------------------------------------------------ */
/* gpus.json                                                           */
/* ------------------------------------------------------------------ */

test('gpus.json carries 19+ gpus with the corrected 26B5 pci id', () => {
  const spec = loadjson('gpus.json');
  const gpus = spec.gpus as Record<string, unknown>[];
  assert.ok(gpus.length >= 19, `expected at least 19 gpus, got ${gpus.length}`);
  const pro = gpus.find((entry) => entry.id === 'rtx-pro-6000-blackwell');
  assert.ok(pro !== undefined, 'gpus.json must contain rtx-pro-6000-blackwell');
  const pciid = pro.pciId as Record<string, string>;
  assert.equal(pciid.device, '26B5');
  assert.equal(pciid.full, '10DE:26B5');
  // no gpu entry may carry 2BB5 as its canonical pci device id; the string
  // only survives inside provenance blocks that document the correction.
  for (const gpu of gpus) {
    const canonical = gpu.pciId as Record<string, string> | undefined;
    if (canonical !== undefined) {
      assert.notEqual(
        canonical.device,
        '2BB5',
        `canonical id of ${String(gpu.id)} must not be 2BB5`,
      );
    }
  }
  const correction = JSON.stringify(pro.miniReference);
  assert.ok(correction.includes('26B5'), 'the provenance block must document the 2BB5 -> 26B5 fix');
});

test('gpus.json keeps the b200 at 192 GB and the rtx 5090 at 32 GB', () => {
  const spec = loadjson('gpus.json');
  const gpus = spec.gpus as Record<string, unknown>[];
  const b200 = gpus.find((entry) => entry.id === 'b200');
  assert.ok(b200 !== undefined);
  assert.equal((b200.vram as Record<string, unknown>).gb, 192);
  const rtx5090 = gpus.find((entry) => entry.id === 'rtx-5090');
  assert.ok(rtx5090 !== undefined);
  assert.equal((rtx5090.vram as Record<string, unknown>).gb, 32);
});

/* ------------------------------------------------------------------ */
/* cores.json                                                          */
/* ------------------------------------------------------------------ */

test('cores.json exposes the memory section with presets and huge pages', () => {
  const spec = loadjson('cores.json');
  const memory = spec.memory as Record<string, unknown>;
  for (const key of ['globalLimits', 'memoryBackends', 'ramPresets', 'hugepages']) {
    assert.ok(memory[key] !== undefined, `cores.json memory section must define ${key}`);
  }
  const limits = memory.globalLimits as Record<string, unknown>;
  assert.equal(limits.maxGb, 1024);
  const rampresets = memory.ramPresets as Record<string, Record<string, unknown>>;
  assert.equal(rampresets.tiny512?.ramMb, 512);
  // odd presets validate the 1 MiB step granularity.
  assert.equal(rampresets.odd7919?.ramMb, 7919);
  assert.equal(rampresets.odd1337?.ramMb, 1337);
});

test('cores.json curates vcpu modularity presets from 1 to 192', () => {
  const spec = loadjson('cores.json');
  const modularity = spec.modularity as Record<string, unknown>;
  const presets = modularity.presets as number[];
  assert.deepEqual(presets, [1, 2, 4, 8, 16, 32, 64, 96, 128, 192]);
  assert.equal(modularity.minCores, 1);
  assert.equal(modularity.maxCores, 192);
});

/* ------------------------------------------------------------------ */
/* boards.json                                                         */
/* ------------------------------------------------------------------ */

test('boards.json covers the sp5, str5 and am5 socket families', () => {
  const spec = loadjson('boards.json');
  const boards = spec.boards as Record<string, unknown>[];
  assert.ok(boards.length >= 20, `expected at least 20 boards, got ${boards.length}`);
  const sockets = boards.map((board) => String(board.socket));
  for (const family of ['SP5', 'sTR5', 'AM5']) {
    assert.ok(
      sockets.some((socket) => socket === family || socket.startsWith(`${family} `)),
      `boards.json must cover the ${family} socket family`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* qemu.config / mttg.config                                           */
/* ------------------------------------------------------------------ */

test('qemu.config documents the mttcg section and the 11.1.0 reference', () => {
  const spec = loadjson('qemu.config');
  const qemu = spec.qemu as Record<string, unknown>;
  const mttcg = qemu.mttcg as Record<string, unknown> | undefined;
  assert.ok(mttcg !== undefined, 'qemu.config must carry the mttcg section');
  const flags = mttcg?.accelFlags as string[];
  assert.ok(flags.includes('--accel tcg,thread=multi'));
  assert.ok(JSON.stringify(spec).includes('11.1.0'), 'qemu.config must cite QEMU 11.1.0');
});

test('mttg.config bounds the cgroup cpu.weight knob at 1-10000', () => {
  const spec = loadjson('mttg.config');
  const mttg = spec.mttg as Record<string, unknown>;
  const cgroups = mttg.cgroups as Record<string, unknown>;
  const cpu = cgroups.cpu as Record<string, unknown>;
  const weight = cpu.weight as Record<string, unknown>;
  assert.equal(weight.min, 1);
  assert.equal(weight.max, 10000);
  assert.equal(weight.default, 100);
  assert.equal(weight.range, '1-10000');
  // the mttcg accelerator section stays a distinct concept inside the file.
  const mttcg = spec.mttcg as Record<string, unknown>;
  const summary = mttcg.summary as Record<string, unknown>;
  assert.ok(String(summary.oneLine).includes('1 vCPU = 1 host pthread'));
  const flags = mttcg.recommendedFlagsMatrix as Record<string, string>;
  assert.ok(flags.dev?.includes('thread=multi'));
});

/* ------------------------------------------------------------------ */
/* passage.config / docker.config                                      */
/* ------------------------------------------------------------------ */

test('passage.config catalogs the passthrough modes and cites six network modes', () => {
  const spec = loadjson('passage.config');
  const modes = spec.passthroughModes as Record<string, unknown>;
  const overview = modes.modeOverview as Record<string, unknown>[];
  assert.ok(overview.length >= 6, `expected at least 6 passthrough modes, got ${overview.length}`);
  const ids = overview.map((mode) => String(mode.id));
  for (const id of ['vfio', 'mdev', 'mig', 'vgpu']) {
    assert.ok(ids.includes(id), `passage.config must document the ${id} mode`);
  }
  // the network binding points at the six vm.config.json network modes
  // (v5-D renamed the keys; the v6-SYNC pass aligned the value citation).
  const binding = spec.networkBinding as Record<string, unknown>;
  const ref = String(binding.vmNetworkModesRef);
  for (const mode of [
    'direct',
    'bridge',
    'nat',
    'overlayVxlan',
    'zeroTrust',
    'latencyOptimization',
  ]) {
    assert.ok(ref.includes(mode), `network modes reference must cite ${mode}`);
  }
});

test('vm.config.json really defines the six network modes cited by passage.config', () => {
  const spec = loadjson('vm.config.json');
  const example = spec.productionExample as Record<string, unknown>;
  const vm = example.vm as Record<string, unknown>;
  const network = vm.network as Record<string, unknown>;
  const passage = network.passage as Record<string, unknown>;
  const modes = passage.modes as Record<string, unknown>;
  assert.deepEqual(Object.keys(modes), [
    'direct',
    'bridge',
    'nat',
    'overlayVxlan',
    'zeroTrust',
    'latencyOptimization',
  ]);
});

test('docker.config pins the 29.7.2 engine version', () => {
  const spec = loadjson('docker.config');
  const engine = spec.engine as Record<string, unknown>;
  assert.equal(engine.dockerVersion, '29.7.2');
});

/* ------------------------------------------------------------------ */
/* vm.config.json                                                      */
/* ------------------------------------------------------------------ */

test('vm.config.json ships the 22 vm profiles', () => {
  const spec = loadjson('vm.config.json');
  const profiles = spec.profiles as Record<string, unknown>[];
  assert.equal(profiles.length, 22, `expected exactly 22 profiles, got ${profiles.length}`);
});

test('vm.config.json keeps the odd vcpu presets 1, 13, 37 and 137', () => {
  const spec = loadjson('vm.config.json');
  const presets = spec.cpuPresets as Record<string, Record<string, unknown>>;
  assert.equal(presets.tiny1?.vcpu, 1);
  assert.equal(presets.odd13?.vcpu, 13);
  assert.equal(presets.odd37?.vcpu, 37);
  assert.equal(presets.odd137?.vcpu, 137);
});

/* ------------------------------------------------------------------ */
/* virtualhardware.json cross references                               */
/* ------------------------------------------------------------------ */

test('virtualhardware.json declares cross-reference integrity lists', () => {
  const spec = loadjson('virtualhardware.json');
  const integrity = spec.crossReferenceIntegrity as Record<string, unknown>;
  for (const key of ['cpuIds', 'gpuIds', 'boardIds', 'vmProfileIds', 'consistencyChecks']) {
    const value = integrity[key];
    assert.ok(Array.isArray(value) && value.length > 0, `crossReferenceIntegrity must list ${key}`);
  }
  const inventory = spec.specFileInventory as Record<string, unknown>[];
  assert.ok(inventory.length >= 11, `expected at least 11 spec files, got ${inventory.length}`);
});

test('every cross-referenced gpu id exists in gpus.json', () => {
  const hardware = loadjson('virtualhardware.json');
  const gpuspec = loadjson('gpus.json');
  const integrity = hardware.crossReferenceIntegrity as Record<string, unknown>;
  const gpuids = integrity.gpuIds as string[];
  const known = new Set((gpuspec.gpus as Record<string, unknown>[]).map((gpu) => String(gpu.id)));
  for (const id of gpuids) {
    assert.ok(known.has(id), `cross-referenced gpu ${id} must exist in gpus.json`);
  }
});

test('every cross-referenced cpu id exists in processors.json', () => {
  const hardware = loadjson('virtualhardware.json');
  const cpuspec = loadjson('processors.json');
  const integrity = hardware.crossReferenceIntegrity as Record<string, unknown>;
  const cpuids = integrity.cpuIds as string[];
  const known = new Set(
    (cpuspec.processors as Record<string, unknown>[]).map((cpu) => String(cpu.id)),
  );
  for (const id of cpuids) {
    assert.ok(known.has(id), `cross-referenced cpu ${id} must exist in processors.json`);
  }
});
