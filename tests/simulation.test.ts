/**
 * simulation tests for the e2ugh engine (worklog task v5-E): the suite
 * runs the real modules end to end — a full engine and vm plane
 * lifecycle with live child processes and bus events, qemu argv built
 * from the vm.config profiles against a flag allowlist, the 24 stage
 * media pipeline over three synthetic jobs including a purposeful
 * fail-fast abort, the scheduler admission ladder with the psi lstm,
 * the reinforcement learning autoscaler, crdt convergence over three
 * replicas, the passage secure channel roundtrip with tamper
 * rejection, the compute plane canary/ebpf/chatops builders and the
 * coherence of every processor and gpu entry of the camel case specs.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chatopsdashboard, ebpfgputelemetry, wasmcanaryvalidator } from '../compute.js';
import { createVirtualEngine, disposeengine, engineeventbus, randomPort } from '../index.js';
import {
  buildffmpegcommand,
  type mediajob,
  mediapipeline,
  mediapipelineerror,
  type mediaprobe,
  passagesecurechannel,
  stagecatalog,
} from '../media.js';
import { kvmavailable, orchestrator, qemuruntime } from '../orchestrator.js';
import { buildQemuTcgArgs } from '../performance.js';
import { psilstm, rlautoscaler, tenantadmission, vmconfigcrdt } from '../scheduler.js';
import { buildqemucmd } from '../virtualization.js';

/** repository root resolved from this test file location. */
const reporoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** resolves one stage name from the live catalog by its index. */
function stagename(index: number): string {
  const entry = stagecatalog.find((stage) => stage.index === index);
  assert.ok(entry !== undefined, `the stage catalog must carry index ${index}`);
  return entry.name;
}

/** waits until the predicate holds or the timeout elapses. */
async function waituntil(predicate: () => boolean, timeoutms: number): Promise<boolean> {
  const deadline = Date.now() + timeoutms;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return predicate();
}

/* ------------------------------------------------------------------ */
/* simulation 1a: engine lifecycle with the single typed bus           */
/* ------------------------------------------------------------------ */

test('engine lifecycle walks created to running, snapshot, restore and stop on the bus', () => {
  const seen: { readonly topic: string; readonly payload: Record<string, unknown> }[] = [];
  const topics = [
    'engine:created',
    'engine:starting',
    'engine:running',
    'engine:stopped',
    'engine:error',
    'engine:statechanged',
  ] as const;
  const listeners = topics.map((topic) => (payload: Record<string, unknown>) => {
    seen.push({ topic, payload });
  });
  topics.forEach((topic, index) => {
    engineeventbus.subscribe(topic, listeners[index]);
  });
  let engineid = '';
  try {
    const engine = createVirtualEngine({
      host: 'sim.local',
      vcpus: 8,
      ramgb: 32,
      vramgb: 24,
      port: 45678,
    });
    engineid = engine.id;
    assert.equal(engine.state, 'created');
    const endpoint = engine.start();
    assert.equal(engine.state, 'running');
    assert.equal(endpoint.url, `http://sim.local:${endpoint.port}`);
    const snapshot = engine.snapshot();
    assert.equal(Object.isFrozen(snapshot), true, 'the enginesnapshot must be immutable');
    assert.equal(snapshot.state, 'running');
    assert.equal(snapshot.spec.port, 45678);
    /* restore of an engine equals re-creating it from the frozen
     * snapshot specification and booting the fresh instance. */
    const restored = createVirtualEngine({
      host: snapshot.spec.host,
      vcpus: snapshot.spec.vcpus,
      ramgb: snapshot.spec.ramgb,
      vramgb: snapshot.spec.vramgb,
      model: snapshot.spec.model,
      runtime: snapshot.spec.runtime,
      mig: snapshot.spec.mig,
      port: snapshot.spec.port,
    });
    assert.equal(restored.spec.port, snapshot.spec.port);
    assert.equal(restored.spec.vcpus, snapshot.spec.vcpus);
    const restoredendpoint = restored.start();
    assert.equal(restored.state, 'running');
    assert.equal(restoredendpoint.port, 45678);
    engine.stop();
    assert.equal(engine.state, 'stopped');
    restored.stop();
    assert.equal(restored.state, 'stopped');
    const trail = seen
      .filter((event) => event.payload.engineid === engineid)
      .map((event) => event.topic);
    assert.deepEqual(trail, [
      'engine:created',
      'engine:statechanged',
      'engine:starting',
      'engine:statechanged',
      'engine:running',
      'engine:statechanged',
      'engine:stopped',
    ]);
    const transitions = seen
      .filter(
        (event) => event.topic === 'engine:statechanged' && event.payload.engineid === engineid,
      )
      .map((event) => `${event.payload.from}>${event.payload.to}`);
    assert.deepEqual(transitions, ['created>starting', 'starting>running', 'running>stopped']);
    assert.equal(
      seen.some((event) => event.topic === 'engine:error'),
      false,
      'the healthy lifecycle never publishes engine:error',
    );
    disposeengine(restored.id);
    assert.equal(disposeengine(engineid), true);
  } finally {
    topics.forEach((topic, index) => {
      engineeventbus.unsubscribe(topic, listeners[index]);
    });
  }
});

/* ------------------------------------------------------------------ */
/* simulation 1b: vm plane lifecycle with a real child process         */
/* ------------------------------------------------------------------ */

test('vm plane drives a real qemu stand-in process through snapshot, restore and restart', async () => {
  const rootdir = mkdtempSync(join(tmpdir(), 'vhe-vmsim-'));
  const engine = new orchestrator({ rootdir, kvmenabled: false, nodeid: 'sim-node-e' });
  const seen: { readonly topic: string; readonly payload: Record<string, unknown> }[] = [];
  const topics = [
    'vm:created',
    'vm:started',
    'vm:stopped',
    'vm:error',
    'vm:phase',
    'snapshot:created',
    'qemu:exit',
    'qemu:versionmismatch',
  ] as const;
  const listeners = topics.map((topic) => (payload: Record<string, unknown>) => {
    seen.push({ topic, payload });
  });
  topics.forEach((topic, index) => {
    engine.events.subscribe(topic, listeners[index]);
  });
  let vmid = '';
  try {
    const created = await engine.createvm({
      name: 'sim-vm',
      vcpus: 4,
      vrammib: 4096,
      image: 'vmlinuz:rootfs',
    });
    assert.equal(created.ok, true, `createvm failed: ${created.ok ? '' : created.error?.message}`);
    vmid = created.value.id;
    assert.equal(created.value.state, 'binding');
    assert.equal(typeof created.value.vcpupins.get(0), 'object', 'vcpu pins must be allocated');

    const started = await engine.startvm(vmid);
    assert.equal(started.ok, true, `startvm failed: ${started.ok ? '' : started.error?.message}`);
    assert.equal(started.value.state, 'running');
    assert.equal(typeof started.value.qemupid, 'number', 'the vm owns a live process');

    const snapshot = await engine.createsnapshot(vmid, 'simsnap', true);
    assert.equal(
      snapshot.ok,
      true,
      `createsnapshot failed: ${snapshot.ok ? '' : snapshot.error?.message}`,
    );
    assert.equal(existsSync(snapshot.value.qcow2path), true, 'the qcow2 artifact lands on disk');
    assert.ok(snapshot.value.rampath !== undefined, 'the ram image is written on request');

    const stopped = await engine.stopvm(vmid);
    assert.equal(stopped.ok, true, `stopvm failed: ${stopped.ok ? '' : stopped.error?.message}`);

    const restored = await engine.restoresnapshot(snapshot.value.id);
    assert.equal(
      restored.ok,
      true,
      `restoresnapshot failed: ${restored.ok ? '' : restored.error?.message}`,
    );

    const restarted = await engine.startvm(vmid);
    assert.equal(
      restarted.ok,
      true,
      `restart failed: ${restarted.ok ? '' : restarted.error?.message}`,
    );
    assert.equal(restarted.value.state, 'running');

    const stoppedagain = await engine.stopvm(vmid, undefined, 'final');
    assert.equal(stoppedagain.ok, true);

    const destroyed = await engine.destroyvm(vmid);
    assert.equal(destroyed.ok, true);

    const exited = await waituntil(
      () =>
        seen.filter((event) => event.topic === 'qemu:exit' && event.payload.vmid === vmid).length >=
        2,
      8000,
    );
    assert.equal(exited, true, 'both stand-in processes report qemu:exit');

    const phases = seen
      .filter((event) => event.topic === 'vm:phase' && event.payload.vmid === vmid)
      .map((event) => event.payload.to);
    assert.deepEqual(phases, [
      'scheduling',
      'binding',
      'provisioning',
      'running',
      'snapshotted',
      'running',
      'stopped',
      'provisioning',
      'stopped',
      'provisioning',
      'running',
      'stopped',
    ]);
    const milestones = seen
      .filter(
        (event) =>
          event.topic !== 'vm:phase' &&
          event.topic !== 'qemu:versionmismatch' &&
          event.payload.vmid === vmid,
      )
      .map((event) => event.topic);
    const first = (topic: string): number => milestones.indexOf(topic);
    const second = (topic: string): number => milestones.indexOf(topic, first(topic) + 1);
    assert.ok(first('vm:created') >= 0, 'vm:created is published');
    assert.ok(
      first('vm:created') < first('vm:started') &&
        first('vm:started') < first('snapshot:created') &&
        first('snapshot:created') < first('vm:stopped') &&
        first('vm:stopped') < second('vm:started') &&
        second('vm:started') < second('vm:stopped'),
      `milestone order must be created < started < snapshot < stop < restart < final stop (got ${milestones.join(',')})`,
    );
    assert.equal(
      seen.some((event) => event.topic === 'vm:error'),
      false,
      'the vm plane must not publish vm:error during the happy path',
    );
    const qemubin = '/usr/bin/qemu-system-x86_64';
    if (!existsSync(qemubin)) {
      const mismatches = seen.filter((event) => event.topic === 'qemu:versionmismatch').length;
      assert.ok(
        mismatches >= 1,
        'an absent qemu binary surfaces the version mismatch exactly like ci',
      );
    }
  } finally {
    topics.forEach((topic, index) => {
      engine.events.unsubscribe(topic, listeners[index]);
    });
    await engine.destroyvm(vmid).catch(() => {
      /* catcher: teardown must never fail the test */
    });
    rmSync(rootdir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* simulation 2: qemu argv from the vm profile against an allowlist    */
/* ------------------------------------------------------------------ */

/** every qemu flag the engine builders are allowed to emit. */
const knownqemuflags = new Set([
  '-accel',
  '-cpu',
  '-smp',
  '-m',
  '-machine',
  '-enable-kvm',
  '-object',
  '-numa',
  '-device',
  '-netdev',
  '-monitor',
  '-qmp',
  '-vga',
  '-nographic',
  '-drive',
  '-no-reboot',
  '-nodefaults',
  '-display',
  '-kernel',
  '-initrd',
  '-append',
  '-name',
  '-uuid',
  '-daemonize',
]);

/** asserts one argv only carries allowlisted flags and the qemu binary. */
function assertknownargv(argv: readonly string[], label: string): void {
  const unknown = argv.filter((token) => token.startsWith('-') && !knownqemuflags.has(token));
  assert.deepEqual(unknown, [], `${label} must not carry unknown qemu flags`);
  assert.ok(argv[0]?.includes('qemu-system-x86_64'), `${label} must launch the qemu system binary`);
}

test('qemu argv builders carry mttcg epyc-v5 smp and mem inside the flag allowlist', async () => {
  const vmconfig = JSON.parse(readFileSync(join(reporoot, 'vm.config.json'), 'utf8')) as {
    readonly profiles: readonly {
      readonly id: string;
      readonly cpu: { readonly vcpus: number; readonly smp: string };
      readonly ramGb: number;
    }[];
  };
  const profile = vmconfig.profiles.find((candidate) => candidate.id === 'buildfarm-max');
  assert.ok(profile !== undefined, 'the buildfarm-max profile must exist in vm.config.json');
  const memorymb = profile.ramGb * 1024;

  /* performance layer: the documented ci fallback accelerator. */
  const tcg = buildQemuTcgArgs({ vcpus: profile.cpu.vcpus, memoryMb: memorymb });
  assert.equal(tcg[tcg.indexOf('-accel') + 1], 'tcg,thread=multi,tb-size=1024');
  assert.ok(tcg[tcg.indexOf('-cpu') + 1]?.startsWith('EPYC-v5'), 'tcg falls back to EPYC-v5');
  assert.equal(tcg[tcg.indexOf('-smp') + 1], String(profile.cpu.vcpus));
  assert.equal(tcg[tcg.indexOf('-m') + 1], String(memorymb));
  // biome-ignore lint/security/noSecrets: builder symbol name, not a credential
  assertknownargv(tcg, 'buildQemuTcgArgs');

  /* orchestrator sandbox plane: strategy argv over a built spec. */
  const rootdir = mkdtempSync(join(tmpdir(), 'vhe-argvsim-'));
  const engine = new orchestrator({ rootdir, kvmenabled: false, nodeid: 'argv-node' });
  try {
    const spec = engine
      .builder()
      .withimage('vmlinuz:rootfs')
      .withruntime('qemu')
      .withcpus(4)
      .withmemory(4096)
      .withhost('ci.internal')
      .build();
    const sandboxargv = new qemuruntime('q35').buildcommand(spec);
    const kvm = kvmavailable();
    const accel = sandboxargv[sandboxargv.indexOf('-accel') + 1];
    const cpu = sandboxargv[sandboxargv.indexOf('-cpu') + 1];
    if (!kvm) {
      assert.equal(accel, 'tcg,thread=multi,tb-size=1024');
      assert.ok(cpu.startsWith('EPYC-v5'), 'kvm-less hosts spoof EPYC-v5');
    } else {
      assert.equal(accel, 'kvm');
      assert.equal(cpu, 'host');
    }
    assert.equal(sandboxargv[sandboxargv.indexOf('-smp') + 1], String(spec.cpus));
    assert.equal(sandboxargv[sandboxargv.indexOf('-m') + 1], String(spec.memorymib));
    assertknownargv(sandboxargv, 'qemuruntime.buildcommand');

    /* orchestrator vm plane: the argv bound to a created vm record. */
    const created = await engine.createvm({ name: 'argv-vm', vcpus: 8, vrammib: 8192 });
    assert.equal(created.ok, true, `createvm failed: ${created.ok ? '' : created.error?.message}`);
    const vmargv = new qemuruntime('q35').buildvmcommand(created.value, []);
    const machinetoken = vmargv[vmargv.indexOf('-machine') + 1];
    assert.ok(machinetoken.startsWith('q35,'), 'the vm plane boots the q35 machine');
    if (!kvm) {
      assert.ok(
        machinetoken.includes('accel=tcg,thread=multi,tb-size=1024'),
        'the vm plane falls back to mttcg',
      );
    }
    assert.equal(vmargv[vmargv.indexOf('-smp') + 1], '8');
    assert.equal(vmargv[vmargv.indexOf('-m') + 1], '8192');
    assert.ok(vmargv.includes('-numa'), 'the vm plane pins the numa node');
    assertknownargv(vmargv, 'qemuruntime.buildvmcommand');
    await engine.destroyvm(created.value.id);
  } finally {
    rmSync(rootdir, { recursive: true, force: true });
  }

  /* virtualization turbo wrapper: the vfio ready argv. */
  const turbo = buildqemucmd({ vcpu: 8, memMB: 16384 });
  assert.equal(turbo[turbo.indexOf('-m') + 1], '16384');
  assert.ok(turbo[turbo.indexOf('-smp') + 1]?.startsWith('8,'), 'smp spells the full topology');
  assertknownargv(turbo, 'buildqemucmd');
});

/* ------------------------------------------------------------------ */
/* simulation 3: media pipeline over three synthetic jobs              */
/* ------------------------------------------------------------------ */

/** an interlaced 4k hdr probe that keeps every gpu stage eligible. */
const hdrprobe: mediaprobe = {
  durationsec: 135.2,
  video: {
    codec: 'h264',
    width: 3840,
    height: 2160,
    fps: 29.97,
    bitdepth: 10,
    hdr: true,
    interlaced: true,
  },
  audio: [{ codec: 'aac', samplerate: 48000, channels: 2 }],
  estimatedworkingsetmb: 2048,
};

/** a plain progressive sdr probe for 1080p material. */
const flatprobe: mediaprobe = {
  ...hdrprobe,
  video: {
    codec: 'h264',
    width: 1920,
    height: 1080,
    fps: 29.97,
    bitdepth: 8,
    hdr: false,
    interlaced: false,
  },
};

test('media pipeline executes three synthetic jobs honoring skip rules and fail-fast', () => {
  const healthy: mediajob = {
    id: 'sim-healthy',
    inputpath: '/data/in/scene_4k_hdr_interlaced.mp4',
    outputpath: '/data/out/scene_av1_p4.mp4',
    mode: 'hevc_hdr_to_av1_sdr_tonemap',
    outputprofile: {
      videocodec: 'av1',
      audiocodec: 'aac',
      resolution: { w: 1920, h: 1080 },
      bitratekbps: 8000,
      preset: 'p4',
      tonemap: true,
      vmaftarget: 93,
      bframes: 3,
      gopsec: 4,
    },
    priority: 1,
    memoryplandigest: 'sha256:simdigest',
  };
  const doomed: mediajob = {
    id: 'sim-doomed',
    inputpath: '/data/in/talk_1080p_progressive.mp4',
    outputpath: '/data/out/talk_av1_p1.mp4',
    mode: 'cbr_low_latency',
    outputprofile: {
      videocodec: 'av1',
      audiocodec: 'aac',
      resolution: { w: 1920, h: 1080 },
      bitratekbps: 4000,
      preset: 'p1',
      tonemap: false,
    },
    priority: 2,
  };
  const subtitled: mediajob = {
    id: 'sim-subtitled',
    inputpath: '/data/in/talk_1080p_progressive.mp4',
    outputpath: '/data/out/talk_h264_p4.mp4',
    mode: 'cbr_low_latency',
    outputprofile: {
      videocodec: 'h264',
      audiocodec: 'aac',
      resolution: { w: 1920, h: 1080 },
      bitratekbps: 6000,
      preset: 'p4',
      tonemap: false,
    },
    priority: 2,
    metadata: { subtitlepath: '/data/in/talk.srt', logopath: '/data/in/talk.png' },
  };

  const pipe = new mediapipeline({ failfast: true });
  const results = pipe.executebatch(
    [healthy, doomed, subtitled],
    [hdrprobe, flatprobe, flatprobe],
    2,
  );
  assert.equal(results.length, 3, 'the batch returns one result per job');

  const [healthyresult, doomedresult, subtitledresult] = results;
  assert.ok(
    healthyresult !== undefined && doomedresult !== undefined && subtitledresult !== undefined,
  );

  assert.equal(healthyresult.success, true, 'the healthy job finishes all 24 stages');
  assert.equal(healthyresult.metrics.length, 24);
  const skipped = healthyresult.metrics
    .filter((record) => record.skipped)
    .map((record) => record.stage);
  assert.ok(!skipped.includes(stagename(10)), 'interlaced input keeps deinterlace');
  assert.ok(!skipped.includes(stagename(12)), 'hdr tonemap stays enabled');
  assert.ok(skipped.includes(stagename(13)), 'no denoise mode skips the denoise stage');
  assert.ok(skipped.includes(stagename(18)), 'no subtitle path skips the burn stage');
  const preview = healthyresult.ffmpegpreview.join(' ');
  assert.ok(preview.includes('-preset p4'), 'the encode preview carries preset p4');
  assert.ok(preview.includes('-rc vbr_hq'), 'the encode preview carries rc vbr_hq');
  assert.ok(preview.includes('-b_ref_mode 2'), 'the encode preview carries b_ref_mode 2');
  assert.ok(preview.includes('bwdif_cuda=0:-1:0'), 'the filter chain deinterlaces on cuda');
  assert.ok(healthyresult.passageframes >= 1, 'stage 20 seals at least one passage frame');

  assert.equal(doomedresult.success, false, 'the av1 p1 job must fail');
  const failure = doomedresult.metrics.find((record) => !record.success);
  assert.ok(failure !== undefined, 'the failing stage is reported');
  assert.equal(failure.stage, stagename(15));
  assert.ok(
    failure.error !== undefined && /p1/.test(failure.error),
    'the report names the p1 rejection',
  );
  assert.ok(doomedresult.metrics.length < 24, 'fail-fast aborts the remaining stages');
  assert.ok(
    doomedresult.metrics.every((record) => record.index <= 15),
    'no record may exist beyond the aborted stage',
  );

  assert.equal(subtitledresult.success, true, 'the subtitled job completes');
  assert.equal(subtitledresult.metrics.length, 24);
  assert.ok(
    !subtitledresult.metrics
      .filter((record) => record.stage === stagename(18))
      .some((record) => record.skipped),
    'a subtitle path keeps the burn stage active',
  );

  const direct = buildffmpegcommand(healthy, hdrprobe, stagename(15));
  assert.deepEqual(
    direct.filter((token) => token === '-preset' || token === '-rc'),
    ['-preset', '-rc'],
  );
  assert.equal(direct[direct.indexOf('-preset') + 1], 'p4');
  assert.equal(direct[direct.indexOf('-rc') + 1], 'vbr_hq');
  assert.equal(direct[direct.indexOf('-b_ref_mode') + 1], '2');
  assert.equal(direct[direct.indexOf('-multipass') + 1], '2');
});

/* ------------------------------------------------------------------ */
/* simulation 4a: tenant admission under psi pressure                  */
/* ------------------------------------------------------------------ */

test('tenant admission reorders gold ahead of bronze under psi pressure', () => {
  const lstm = new psilstm(8);
  const bounded = lstm.forecast([
    [0.95, 0.9, 0.9],
    [0.97, 0.92, 0.91],
  ]);
  assert.ok(
    bounded.cpu >= 0 &&
      bounded.cpu <= 1 &&
      bounded.memory >= 0 &&
      bounded.memory <= 1 &&
      bounded.io >= 0 &&
      bounded.io <= 1,
    'psi forecasts stay inside the unit range',
  );
  const queue = new tenantadmission();
  queue.submit({ id: 'br-batch', tier: 'bronze', workloadName: 'nightly-batch' });
  queue.submit({ id: 'au-api', tier: 'gold', workloadName: 'api-server' });
  assert.equal(queue.pending, 2);
  const degraded = queue.observepressure({ cpu: 0.95, memory: 0.4, io: 0.3 });
  assert.equal(degraded, true, 'a 0.95 cpu stall crosses the 0.6 pressure threshold');
  const first = queue.admit();
  const second = queue.admit();
  assert.equal(first?.id, 'au-api', 'gold is admitted first even though bronze queued before');
  assert.equal(second?.id, 'br-batch', 'the deferred bronze request follows once gold drains');
  assert.equal(queue.admit(), undefined, 'the drained queue returns undefined');
  assert.equal(queue.pending, 0);
  const healthy = queue.observepressure(bounded);
  assert.equal(typeof healthy, 'boolean', 'the lstm forecast plugs straight into the gate');
});

test('psi lstm online training reduces the forecast error monotonically', () => {
  const net = new psilstm(8);
  const window = [
    [0.9, 0.85, 0.8],
    [0.92, 0.87, 0.83],
    [0.88, 0.9, 0.79],
    [0.95, 0.86, 0.85],
  ];
  const observed = [0.9, 0.87, 0.82];
  const losses: number[] = [];
  for (let round = 0; round < 20; round += 1) {
    net.reset();
    losses.push(net.trainstep(window, observed));
  }
  const last = losses[losses.length - 1];
  assert.ok(last !== undefined && last < losses[0], 'twenty online steps shrink the rmse');
  const drifts = losses.slice(1).map((loss, index) => loss - (losses[index] ?? 0));
  assert.ok(
    drifts.every((delta) => delta <= 1e-9),
    'the truncated gradient never increases the loss',
  );
  assert.throws(() => net.forecast([]), /at least one/, 'an empty window is rejected');
});

/* ------------------------------------------------------------------ */
/* simulation 4b: reinforcement learning autoscaler bandit             */
/* ------------------------------------------------------------------ */

test('rl autoscaler converges to the best scaling arm within twenty rounds', () => {
  const scaler = new rlautoscaler({ replicas: 4, epsilon: 0.0, decay: 0.9 });
  const target = 0.7;
  /* deterministic environment: up1 lands exactly on the setpoint. */
  const after = (arm: string): number => {
    if (arm === 'up1') {
      return target;
    }
    return arm === 'hold' ? 0.2 : 0.95;
  };
  const arms: string[] = [];
  const rewards: number[] = [];
  let cumulative = 0;
  const cumulativehistory: number[] = [];
  for (let round = 0; round < 20; round += 1) {
    const decision = scaler.decide(target, 0.7);
    arms.push(decision.arm);
    const reward = scaler.feedback(target, after(decision.arm));
    rewards.push(reward);
    cumulative += reward;
    cumulativehistory.push(cumulative);
  }
  assert.equal(arms[0], 'hold', 'the greedy bandit starts on the first zero-value arm');
  assert.ok(
    arms.slice(1).every((arm) => arm === 'up1'),
    `after one punishment every round picks up1 (got ${arms.join(',')})`,
  );
  assert.equal(rewards[0], -0.5, 'the hold arm is punished by the distance reward');
  assert.ok(
    rewards.slice(1).every((reward) => reward === 0),
    'the best arm scores a perfect 0',
  );
  for (let index = 2; index < cumulativehistory.length; index += 1) {
    assert.ok(
      (cumulativehistory[index] ?? 0) >= (cumulativehistory[index - 1] ?? 0),
      'the cumulative reward never decreases once converged',
    );
  }
  const tail = rewards.slice(-10).reduce((sum, reward) => sum + reward, 0) / 10;
  assert.ok(tail > rewards[0], 'the average reward of the last ten rounds beats round one');
  assert.equal(scaler.epsilon, 0, 'a zero epsilon bandit never explores');
  assert.equal(scaler.replicas, 23, 'nineteen up1 decisions grow 4 replicas to 23');
});

/* ------------------------------------------------------------------ */
/* simulation 4c: vm config crdt across three replicas                 */
/* ------------------------------------------------------------------ */

test('vm config crdt converges three replicas and merges stay idempotent', () => {
  const replicaA = new vmconfigcrdt('replica-a');
  const replicaB = new vmconfigcrdt('replica-b');
  const replicaC = new vmconfigcrdt('replica-c');
  replicaA.set('cpus', '16');
  replicaA.set('machine', 'q35');
  replicaB.set('cpus', '32');
  replicaB.set('boot', '20000');
  replicaC.set('memorymb', '65536');
  /* anti-entropy gossip: every replica merges every peer twice. */
  for (let round = 0; round < 2; round += 1) {
    for (const site of [replicaA, replicaB, replicaC]) {
      for (const peer of [replicaA, replicaB, replicaC]) {
        if (site !== peer) {
          site.merge(peer.snapshot());
        }
      }
    }
  }
  const docs = [replicaA, replicaB, replicaC].map((site) => site.todocument());
  assert.deepEqual(docs[0], docs[1], 'replica a and b converge');
  assert.deepEqual(docs[1], docs[2], 'replica b and c converge');
  assert.ok(['16', '32'].includes(String(docs[0]?.cpus)), 'the cpu field holds one write');
  assert.equal(docs[0]?.cpus, '32', 'the later write wins under the hybrid clock');
  assert.equal(docs[0]?.memorymb, '65536');
  assert.equal(docs[0]?.boot, '20000');
  assert.equal(docs[0]?.machine, 'q35');
  const again = replicaA.merge(replicaB.snapshot(), replicaB);
  assert.equal(again.applied, 0, 're-merging the same snapshot applies nothing');
  assert.equal(again.converged, true, 'the replicas still report convergence');
  /* merge order independence: a late joiner reaches the same document. */
  const latejoiner = new vmconfigcrdt('replica-d');
  latejoiner.merge(replicaC.snapshot());
  latejoiner.merge(replicaB.snapshot());
  latejoiner.merge(replicaA.snapshot());
  assert.deepEqual(latejoiner.todocument(), docs[0], 'merge(a, merge(b, c)) converges equally');
});

/* ------------------------------------------------------------------ */
/* simulation 5: passage secure channel roundtrip                      */
/* ------------------------------------------------------------------ */

test('passage secure channel seals, opens, splits at the mtu and rejects tampering', () => {
  const alice = new passagesecurechannel();
  const message = JSON.stringify({ vmid: 'vm-sim', op: 'migrate', phase: 'cutover' });
  const frames = alice.seal(message);
  assert.equal(frames.length, 1, 'a sub-mtu message seals into one frame');
  assert.equal(frames[0]?.truncated, false);
  const opened = alice.open(frames[0]);
  assert.equal(opened.toString('utf8'), message, 'the roundtrip restores the plaintext');

  const flipped = Buffer.from(frames[0]?.payload ?? Buffer.alloc(0));
  flipped[0] = (flipped[0] ?? 0) ^ 0xff;
  const tampered = { frame: frames[0], payload: flipped };
  assert.throws(
    () => alice.open({ ...tampered.frame, payload: tampered.payload }),
    (error: unknown) =>
      error instanceof mediapipelineerror &&
      error.code === 'PASSAGE_OPEN' &&
      /signature/i.test(error.message),
    'a flipped ciphertext byte must fail the ed25519 verification',
  );
  const reversed = Buffer.from(frames[0]?.signature ?? Buffer.alloc(0)).reverse();
  assert.throws(
    () => alice.open({ ...frames[0], signature: reversed }),
    (error: unknown) => error instanceof mediapipelineerror,
    'a swapped signature is rejected',
  );
  const bob = new passagesecurechannel();
  assert.throws(
    () => bob.open(frames[0]),
    (error: unknown) => error instanceof mediapipelineerror,
    'another channel key pair cannot open alice frames',
  );

  const big = Buffer.alloc(200000, 7);
  const split = alice.seal(big);
  assert.equal(split.length, Math.ceil(200000 / 65536), 'the message splits at the 65536 mtu');
  assert.ok(
    split.every((frame) => frame.truncated),
    'every chunk is marked truncated',
  );
  const reassembled = Buffer.concat(split.map((frame) => alice.open(frame)));
  assert.equal(reassembled.equals(big), true, 'the reassembled payload is byte identical');
});

/* ------------------------------------------------------------------ */
/* simulation 6: compute plane — canary, ebpf telemetry and chatops    */
/* ------------------------------------------------------------------ */

test('wasm canary validator promotes healthy revisions and rolls back corruption', () => {
  const validator = new wasmcanaryvalidator();
  validator.markhealthy('gpuplug', 'rev1', 'worldhash-9f');
  const goodmodule = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x02]);
  const passed = validator.validate({
    component: 'gpuplug',
    revision: 'rev2',
    bytes: goodmodule,
    worldHash: 'worldhash-9f',
    smoke: () => {
      /* healthy smoke: the module exports nothing to call */
    },
  });
  assert.equal(passed.passed, true);
  assert.ok(passed.checks.includes('magic header ok'));
  assert.ok(passed.checks.includes('smoke execution ok'));
  assert.equal(passed.rolledBackTo, null, 'a passing canary keeps the new revision');
  assert.equal(validator.healthyrevision('gpuplug'), 'rev2');

  const corrupted = Uint8Array.from(goodmodule);
  corrupted[0] = 0xde;
  const magicfailure = validator.validate({
    component: 'gpuplug',
    revision: 'rev3',
    bytes: corrupted,
    worldHash: 'worldhash-9f',
    smoke: () => {
      /* healthy smoke: the module exports nothing to call */
    },
  });
  assert.equal(magicfailure.passed, false);
  assert.ok(magicfailure.checks.includes('magic header check failed'));
  assert.equal(magicfailure.rolledBackTo, 'rev2', 'corruption rolls back to the last healthy');
  assert.equal(validator.healthyrevision('gpuplug'), 'rev2');

  const drift = validator.validate({
    component: 'gpuplug',
    revision: 'rev4',
    bytes: goodmodule,
    worldHash: 'worldhash-aa',
    smoke: () => {
      /* healthy smoke: the module exports nothing to call */
    },
  });
  assert.equal(drift.passed, false, 'a drifted world hash fails the canary');
  assert.equal(drift.rolledBackTo, 'rev2');

  const crash = validator.validate({
    component: 'gpuplug',
    revision: 'rev5',
    bytes: goodmodule,
    worldHash: 'worldhash-9f',
    smoke: () => {
      throw new Error('trap');
    },
  });
  assert.equal(crash.passed, false, 'a throwing smoke run fails the canary');
  assert.ok(crash.checks.some((check) => check.startsWith('smoke execution failed')));
  assert.equal(crash.rolledBackTo, 'rev2');
});

test('ebpf gpu telemetry builds a drm tracepoint counter program', () => {
  const telemetry = new ebpfgputelemetry()
    .registercounter('nvioctl', 0xc0)
    .registercounter('nvsched', 0xc1);
  const program = telemetry.build();
  assert.equal(program.name, 'gputelemetry.bpf.c');
  assert.equal(program.section, 'tracepoint/drm/drm_ioctl');
  // biome-ignore lint/security/noSecrets: libbpf macro section name, not a credential
  assert.ok(program.source.includes('SEC("tracepoint/drm/drm_ioctl")'));
  assert.ok(program.source.includes('__sync_fetch_and_add(&counters.nvioctl, 1);'));
  assert.ok(program.source.includes('__sync_fetch_and_add(&counters.nvsched, 1);'));
  assert.ok(program.source.includes('char LICENSE[] SEC("license") = "Dual BSD/GPL";'));
  assert.deepEqual(program.counters, ['nvioctl', 'nvsched']);
  assert.deepEqual(telemetry.listcounters(), ['nvioctl', 'nvsched']);
});

test('chatops dashboard parses /vm create into a json plan with engine bounds', () => {
  const dashboard = new chatopsdashboard();
  const plan = dashboard.vmcreate('sim-vm', 16, 64);
  const json = JSON.parse(JSON.stringify(plan)) as {
    command: string;
    action: string;
    args: Record<string, unknown>;
    confirmRequired: boolean;
  };
  assert.equal(json.command, '/vm');
  assert.equal(json.action, 'create');
  assert.equal(json.args.name, 'sim-vm');
  assert.equal(json.args.vcpus, 16);
  assert.equal(json.args.ramGb, 64);
  assert.equal(json.confirmRequired, false, 'creation is not destructive');
  const stop = dashboard.vmstop('sim-vm');
  assert.equal(stop.confirmRequired, true, 'stopping always requires confirmation');
  assert.throws(() => dashboard.vmcreate('bad', 0, 1), /1-192/);
  assert.throws(() => dashboard.vmcreate('bad', 193, 1), /1-192/);
  const spec = dashboard.dashboardspec();
  assert.equal(spec.renderer, 'webgpu-lavapipe');
  assert.equal(spec.panels.length, 3);
  assert.equal(spec.fpsTarget, 30);
});

/* ------------------------------------------------------------------ */
/* simulation 7: hardware spec coherence over processors and gpus      */
/* ------------------------------------------------------------------ */

test('hardware specs stay coherent across every processor and gpu entry', () => {
  const root = reporoot;
  const processorsdoc = JSON.parse(readFileSync(join(root, 'processors.json'), 'utf8')) as {
    readonly processors: readonly {
      readonly id: string;
      readonly cores?: number;
      readonly threads?: number;
      readonly smt?: boolean;
      readonly tdpWatts?: number;
      readonly topology?: string;
    }[];
  };
  const gpusdoc = JSON.parse(readFileSync(join(root, 'gpus.json'), 'utf8')) as {
    readonly gpus: readonly Record<string, unknown>[];
  };
  const processors = processorsdoc.processors;
  const gpus = gpusdoc.gpus;
  assert.ok(
    processors.length >= 40,
    `the processor catalog stays populated (${processors.length})`,
  );
  assert.ok(gpus.length >= 15, `the gpu catalog stays populated (${gpus.length})`);

  for (const cpu of processors) {
    const hybrid = /^(\d+)P\+(\d+)E$/.exec(cpu.topology ?? '');
    if (hybrid !== null && typeof cpu.cores === 'number' && typeof cpu.threads === 'number') {
      /* hybrid parts spell the topology explicitly: cores always add up
       * to P+E while threads are P+E without smt or 2P+E when the p
       * cores hyperthread (raptor lake); arrow lake and apple parts
       * carry no smt at all. */
      const pcores = Number(hybrid[1]);
      const ecores = Number(hybrid[2]);
      assert.equal(cpu.cores, pcores + ecores, `${cpu.id}: topology must match the core count`);
      assert.ok(
        cpu.threads === pcores + ecores || cpu.threads === pcores * 2 + ecores,
        `${cpu.id}: threads ${cpu.threads} disagree with topology ${cpu.topology}`,
      );
    } else if (typeof cpu.cores === 'number' && typeof cpu.threads === 'number') {
      /* homogeneous parts: the threads field carries the total logical
       * cpu count, so the invariant is threads = cores * (1|2). */
      assert.ok(
        cpu.threads % cpu.cores === 0,
        `${cpu.id}: threads ${cpu.threads} must be a multiple of cores ${cpu.cores}`,
      );
      const ratio = cpu.threads / cpu.cores;
      assert.ok(
        ratio === 1 || ratio === 2,
        `${cpu.id}: threads/cores ratio ${ratio} must be 1 or 2`,
      );
      if (cpu.smt === true) {
        assert.equal(ratio, 2, `${cpu.id}: smt enabled means two threads per core`);
      }
      if (cpu.smt === false) {
        assert.equal(ratio, 1, `${cpu.id}: smt disabled means one thread per core`);
      }
      assert.ok(cpu.threads >= cpu.cores, `${cpu.id}: vcpus never fall below physical cores`);
    }
    if (typeof cpu.tdpWatts === 'number') {
      assert.ok(cpu.tdpWatts > 0, `${cpu.id}: tdp must be positive (got ${cpu.tdpWatts})`);
    }
  }

  const pcipattern = /^[0-9A-Fa-f]{4}:[0-9A-Fa-f]{4}$/;
  let withpci = 0;
  for (const gpu of gpus) {
    const vram =
      (typeof gpu.vramGb === 'number' ? gpu.vramGb : undefined) ??
      (typeof gpu.vramGiB === 'number' ? gpu.vramGiB : undefined) ??
      (typeof gpu.memoryGb === 'number' ? gpu.memoryGb : undefined) ??
      (typeof gpu.memGb === 'number' ? gpu.memGb : undefined) ??
      (typeof (gpu.vram as { readonly gb?: number } | undefined)?.gb === 'number'
        ? (gpu.vram as { readonly gb: number }).gb
        : undefined);
    const id = String(gpu.id ?? 'gpu');
    assert.ok(vram !== undefined, `${id}: one vram field must exist`);
    assert.ok((vram ?? 0) > 0, `${id}: vram must be positive (got ${vram})`);
    const pciid = gpu.pciId as { vendor?: string; device?: string; full?: string } | undefined;
    let candidate: string | undefined;
    if (typeof pciid?.full === 'string') {
      candidate = pciid.full;
    } else if (typeof pciid?.vendor === 'string' && typeof pciid?.device === 'string') {
      candidate = `${pciid.vendor}:${pciid.device}`;
    } else if (Array.isArray(gpu.vfioIds) && typeof gpu.vfioIds[0] === 'string') {
      candidate = gpu.vfioIds[0];
    }
    if (candidate !== undefined) {
      withpci += 1;
      assert.match(candidate, pcipattern, `${id}: pci id ${candidate} must be vendor:device hex`);
    }
  }
  assert.ok(
    withpci >= Math.ceil(gpus.length / 2),
    `at least half the catalog must carry a pci id (got ${withpci}/${gpus.length})`,
  );
  /* the engine draws ports from the documented range the specs rely on. */
  const port = randomPort();
  assert.ok(port >= 30000 && port <= 59999);
});

/* ------------------------------------------------------------------ */
/* regression: restoresnapshot is legal from the running state          */
/* (the guard map offers running->restoring->running; the stopped path  */
/* keeps stopped->provisioning->stopped)                                */
/* ------------------------------------------------------------------ */

test('restoresnapshot accepts a live running vm through the restoring edge', async () => {
  const rootdir = mkdtempSync(join(tmpdir(), 'vhe-restore-'));
  const engine = new orchestrator({ rootdir, kvmenabled: false, nodeid: 'restore-node' });
  const created = await engine.createvm({
    name: 'regression-restore',
    image: 'e2ugh:local',
    vcpus: 2,
    rammb: 512,
  });
  assert.ok(created.ok, 'vm creation must succeed');
  const vmid = created.value.id;
  await engine.startvm(vmid);
  const snap = await engine.createsnapshot(vmid);
  assert.ok(snap.ok, 'snapshot creation must succeed');
  // before the v5 fix this threw ERR_PHASE (running -> provisioning); the
  // legal route running -> restoring -> running must now complete cleanly.
  const restored = await engine.restoresnapshot(snap.value.id);
  assert.ok(
    restored.ok,
    `restore from running must be legal: ${restored.ok ? '' : restored.error.message}`,
  );
  await engine.stopvm(vmid);
  await engine.destroyvm(vmid);
});
