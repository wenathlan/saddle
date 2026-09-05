/**
 * real tests for the v5-C feature-audit builders (worklog task v5-C):
 * every planner added by the appendix A/B/C audit is exercised with its
 * real outputs — qemu argv, yaml manifests, p4 sources, taprio schedules,
 * ray/vllm command lines and crdt convergence — with zero mocks.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildvmcrdmanifest,
  planfederatedquota,
  plannputiles,
  planopfsstorage,
  planrayvllmcluster,
  planwebcodecspipeline,
  planwebtransportendpoint,
} from '../compute.js';
import { planfluxgitops } from '../orchestrator.js';
import { rlautoscaler, vmconfigcrdt } from '../scheduler.js';
import {
  buildp4skeleton,
  buildtsnschedule,
  plancxltype3,
  planznszones,
} from '../virtualization.js';

/* ------------------------------------------------------------------ */
/* virtualization.ts: cxl type-3, zns/fdp, p4, tsn                      */
/* ------------------------------------------------------------------ */

test('plancxltype3 emits pxb-cxl bridges, type-3 devices and hmat entries', () => {
  const plan = plancxltype3([
    { id: 'cxl-a', sizegb: 512, qosclass: 2 },
    { id: 'cxl-b', sizegb: 256, hostbridge: 2, interleaveways: 2 },
  ]);
  assert.equal(plan.totalgb, 768);
  assert.ok(plan.argv.some((arg) => arg.includes('-machine q35,cxl=on,hmat=on')));
  assert.ok(plan.argv.some((arg) => arg.startsWith('-device pxb-cxl')));
  assert.equal(plan.argv.filter((arg) => arg.startsWith('-device cxl-type3')).length, 2);
  assert.equal(plan.hmat.length, 4);
  assert.ok(plan.fmcmds.some((cmd) => cmd.startsWith('cxl create-region')));
  assert.equal(plan.windowgranularitymb, 256);
});

test('plancxltype3 rejects qos classes outside the fm-api range', () => {
  assert.throws(() => plancxltype3([{ id: 'cxl-x', sizegb: 64, qosclass: 16 }]), /qos class/);
  assert.throws(() => plancxltype3([]), /at least one/);
});

test('planznszones enforces the 4 MiB zone alignment and emits fdp handles', () => {
  const plan = planznszones([{ id: 'zns-tier0', zonecapmb: 64, zonecount: 32 }], 'fdp');
  assert.equal(plan.totalsizemb, 2048);
  assert.equal(plan.mode, 'fdp');
  assert.ok(plan.qemuargv.some((arg) => arg.includes('zoned=true,zone_size=64M')));
  assert.ok(plan.nvmecli.some((cmd) => cmd.startsWith('nvme fdp')));
  assert.ok(plan.mkfs[0].includes('zone-single'));
  assert.equal(plan.descriptorbytes, 32 * 64);
  assert.throws(
    () => planznszones([{ id: 'bad', zonecapmb: 5, zonecount: 2 }]),
    /multiple of 4 MiB/,
  );
});

test('buildp4skeleton generates a compileable p4-16 program with tables', () => {
  const plan = buildp4skeleton({
    name: 'steerprog',
    tables: [
      { name: 'v4lpm', matchkind: 'lpm', size: 4096 },
      { name: 'exactport', matchkind: 'exact' },
    ],
  });
  assert.ok(plan.source.includes('#include <core.p4>'));
  assert.ok(plan.source.includes('table v4lpm {'));
  assert.ok(plan.source.includes(': lpm;'));
  assert.ok(plan.source.includes('control ingress'));
  assert.ok(plan.source.includes('control egress'));
  assert.ok(plan.source.includes('deparser deparsermain'));
  assert.equal(plan.tables.length, 2);
  assert.ok(plan.compileargv[0].includes('p4c-bm2-ss'));
  assert.throws(() => buildp4skeleton({ name: 'Bad_Name', tables: [] }), /p4skeleton failed/);
});

test('buildtsnschedule builds a non-overlapping 802.1Qbv gate control list', () => {
  const plan = buildtsnschedule({
    cycleus: 1000,
    windows: [
      { queues: [0], durationus: 200 },
      { queues: [1], durationus: 300 },
    ],
    guardbandns: 10000,
  });
  assert.equal(plan.gcl.length, 2);
  assert.equal(plan.gcl[0].offsetns, 0);
  assert.equal(plan.gcl[1].offsetns, 200_000);
  assert.equal(plan.gcl[0].gatemask, '01');
  assert.equal(plan.gcl[1].gatemask, '02');
  assert.equal(plan.utilization, 0.5);
  assert.ok(plan.tcargv.some((line) => line.includes('taprio')));
  assert.ok(plan.tcargv.some((line) => line.includes('sched-entry S 01 200000')));
  assert.throws(
    () => buildtsnschedule({ cycleus: 100, windows: [{ queues: [0], durationus: 200 }] }),
    /overflows the cycle/,
  );
});

/* ------------------------------------------------------------------ */
/* compute.ts: npu tiles, ray+vllm, crd, federation, backlog builders  */
/* ------------------------------------------------------------------ */

test('plannputiles partitions intel amx tiles without overcommit', () => {
  const plan = plannputiles({
    vendor: 'intel',
    guests: [
      { guest: 'vm-a', tiles: 4 },
      { guest: 'vm-b', tiles: 2 },
    ],
  });
  assert.equal(plan.totaltiles, 8);
  assert.equal(plan.utilization, 0.75);
  assert.equal(plan.partitions[0].opspersec, 2100);
  assert.ok(plan.qemuflags[0].includes('+amx-tile'));
  assert.throws(
    () =>
      plannputiles({
        vendor: 'intel',
        guests: [
          { guest: 'vm-c', tiles: 6 },
          { guest: 'vm-d', tiles: 6 },
        ],
      }),
    /overcommits/,
  );
});

test('plannputiles routes amd xdna tiles through the xdna env', () => {
  const plan = plannputiles({ vendor: 'amd', guests: [{ guest: 'vm-x', tiles: 16 }] });
  assert.equal(plan.totaltiles, 32);
  assert.ok(plan.xdnaenv.some((env) => env.startsWith('XDNA_NUM_VAS=')));
  assert.equal(plan.partitions[0].kind, 'xdnaaie');
});

test('planrayvllmcluster emits ray start argv and vllm serve flags', () => {
  const plan = planrayvllmcluster({
    model: 'meta-llama/Llama-3.1-405B-Instruct',
    nodes: [
      { role: 'head', gpus: 4, cpus: 64, memorygb: 512 },
      { role: 'worker', gpus: 4, cpus: 64, memorygb: 512 },
    ],
    tensorparallel: 4,
  });
  assert.equal(plan.totalgpus, 8);
  const head = plan.nodes.find((node) => node.role === 'head');
  assert.ok(head?.rayargv.some((arg) => arg === '--head'));
  assert.ok(head?.vllmargv.some((arg) => arg === '--tensor-parallel-size=4'));
  assert.ok(head?.vllmargv.some((arg) => arg === '--kv-cache-dtype=fp8'));
  assert.throws(
    () =>
      planrayvllmcluster({
        model: 'm',
        nodes: [{ role: 'head', gpus: 3, cpus: 8, memorygb: 64 }],
        tensorparallel: 2,
      }),
    /not divisible/,
  );
});

test('buildvmcrdmanifest renders a valid CRD yaml and sample resource', () => {
  const plan = buildvmcrdmanifest();
  assert.ok(plan.crd.startsWith('apiVersion: apiextensions.k8s.io/v1'));
  assert.ok(plan.crd.includes('kind: VirtualMachine'));
  assert.ok(plan.crd.includes('openAPIV3Schema:'));
  assert.ok(plan.crd.includes('maximum: 4096'));
  assert.ok(plan.sample.includes('gpuprofile: rtxpro6000'));
  assert.equal(plan.shortnames.length, 2);
  assert.throws(() => buildvmcrdmanifest({ group: 'Bad Group' }), /dns group/);
});

test('planfederatedquota caps the fleet at 10k nodes with headroom', () => {
  const plan = planfederatedquota(
    [
      { name: 'eu-1', nodes: 250, vcpusPerNode: 192, vramgbPerNode: 1024 },
      { name: 'us-1', nodes: 250, vcpusPerNode: 192, vramgbPerNode: 1024 },
    ],
    8,
  );
  assert.equal(plan.totalnodes, 500);
  assert.equal(plan.totals.vcpu, 96_000);
  assert.equal(plan.headroom.vcpu, 9600);
  assert.equal(plan.cells.length, 1);
  assert.ok(plan.placementhints[0].startsWith('prefer cell-1'));
  assert.throws(
    () =>
      planfederatedquota(
        Array.from({ length: 41 }, (_, i) => ({
          name: `c-${i}`,
          nodes: 250,
          vcpusPerNode: 8,
          vramgbPerNode: 16,
        })),
      ),
    /10000 nodes/,
  );
});

test('planwebtransportendpoint emits quic datagram params and coop/coep', () => {
  const plan = planwebtransportendpoint({ host: 'passage.e2ugh.dev', port: 8443 });
  assert.equal(plan.url, 'https://passage.e2ugh.dev:8443/passage');
  assert.ok(plan.quicparams.some((p) => p.startsWith('max_datagram_frame_size=')));
  assert.ok(plan.headers.some((h) => h.startsWith('Cross-Origin-Embedder-Policy')));
  assert.ok(plan.browserapi[0].includes('new WebTransport'));
  assert.throws(() => planwebtransportendpoint({ port: 70000 }), /port/);
});

test('planopfsstorage lays out guest buckets inside the quota', () => {
  const plan = planopfsstorage(
    [
      { guest: 'alpine-1', sizemb: 256 },
      { guest: 'alpine-2', sizemb: 512 },
    ],
    1024,
  );
  assert.equal(plan.totalsizemb, 768);
  assert.equal(plan.fits, true);
  assert.ok(plan.buckets[0].handle.startsWith('/guests/alpine-1/'));
  assert.ok(plan.browserapi.some((line) => line.includes('createSyncAccessHandle')));
  assert.equal(planopfsstorage([{ guest: 'fat', sizemb: 2048 }], 1024).fits, false);
});

test('planwebcodecspipeline configures avc encode over the webgpu canvas', () => {
  const plan = planwebcodecspipeline({ codec: 'avc', width: 1920, height: 1080, fps: 60 });
  assert.equal(plan.codec, 'avc1.640034');
  assert.ok(plan.bitratembps > 0);
  assert.equal(plan.stages.length, 4);
  const encode = plan.stages.find((stage) => stage.name === 'encode');
  assert.ok(encode?.config.some((line) => line.includes('latencyMode: "realtime"')));
  assert.ok(plan.videoencoderinit.startsWith('new VideoEncoder'));
  assert.throws(() => planwebcodecspipeline({ fps: 0 }), /fps/);
});

/* ------------------------------------------------------------------ */
/* scheduler.ts: rl autoscaler bandit + vm.config crdt                  */
/* ------------------------------------------------------------------ */

test('rlautoscaler learns the hold arm and decays epsilon', () => {
  const scaler = new rlautoscaler({ replicas: 4, epsilon: 0.0, decay: 0.9 });
  for (let round = 0; round < 50; round += 1) {
    const decision = scaler.decide(0.7, 0.7);
    scaler.feedback(0.7, 0.7);
    assert.ok(['hold', 'up1', 'up2', 'down1'].includes(decision.arm));
  }
  /* with epsilon 0 the greedy arm (hold, all-zero estimates, first wins) sticks */
  const greedy = scaler.decide(0.7, 0.7);
  assert.equal(greedy.arm, 'hold');
  assert.equal(greedy.replicas, 4);
  assert.equal(scaler.epsilon, 0);
  scaler.feedback(0.7, 0.7); /* consumes the pending decision */
  assert.throws(() => scaler.feedback(0.7, 0.7), /no decision/);
});

test('rlautoscaler rewards track the distance to the target load', () => {
  const scaler = new rlautoscaler({ epsilon: 0 });
  scaler.decide(0.5, 0.9);
  const reward = scaler.feedback(0.5, 0.4);
  assert.equal(reward, -0.1);
  const before = scaler.epsilon;
  scaler.decide(0.5, 0.5);
  scaler.feedback(0.5, 0.5);
  assert.ok(scaler.epsilon <= before);
  assert.throws(() => scaler.decide(2, 0.5), /target load/);
});

test('vmconfigcrdt converges concurrent edits without a coordinator', () => {
  const siteA = new vmconfigcrdt('node-a');
  const siteB = new vmconfigcrdt('node-b');
  siteA.set('cpus', '16');
  siteA.set('memorymb', '32768');
  siteB.set('cpus', '32'); /* same ms + same counter -> site id breaks the tie */
  /* delta exchange both ways, then verify convergence with a re-merge */
  siteA.merge(siteB.snapshot());
  siteB.merge(siteA.snapshot());
  const a = siteA.merge(siteB.snapshot(), siteB);
  const b = siteB.merge(siteA.snapshot(), siteA);
  assert.equal(a.converged, true);
  assert.equal(b.converged, true);
  assert.equal(siteA.todocument().cpus, '32');
  assert.equal(siteB.todocument().cpus, '32');
  assert.equal(siteA.todocument().memorymb, '32768');
  /* idempotence: re-merging the same snapshot changes nothing */
  const again = siteA.merge(siteB.snapshot(), siteB);
  assert.equal(again.applied, 0);
  assert.equal(again.converged, true);
});

test('vmconfigcrdt validates keys and site ids', () => {
  const doc = new vmconfigcrdt('node-a');
  assert.throws(() => doc.set('Bad-Key', '1'), /vmconfigcrdt.set failed/);
  assert.throws(() => new vmconfigcrdt('Node-9'), /site id/);
});

/* ------------------------------------------------------------------ */
/* orchestrator.ts: flux gitops layout                                  */
/* ------------------------------------------------------------------ */

test('planfluxgitops lays out overlays per cluster with bootstrap argv', () => {
  const plan = planfluxgitops({ clusters: ['staging', 'prod'] });
  assert.deepEqual(plan.branches, ['main', 'staging']);
  assert.equal(plan.kustomizations.length, 4);
  const overlay = plan.kustomizations.find((k) => k.path === 'apps/overlays/prod');
  assert.ok(overlay?.yaml.includes('kind: Kustomization'));
  assert.ok(plan.bootstrapargv.some((arg) => arg.includes('flux bootstrap github')));
  assert.ok(plan.bootstrapargv.some((arg) => arg.includes('--prune=true')));
  assert.equal(plan.syncpolicy.interval, '1m');
  assert.throws(() => planfluxgitops({ clusters: ['staging', 'staging'] }), /duplicate/);
});
