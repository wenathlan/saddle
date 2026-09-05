/**
 * real tests for the media pipeline and transcode domain (v4-FIX3
 * absorption of pipelinememorypassage.ts + src_pipeline_memory_passage.ts
 * unique halves + the createoptimal encoder policy).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  backlogCount,
  p2pcontentaddress,
  partykitchannelbuilder,
  roadmapbacklog,
  statevectorsync,
  tailscaleendpointplanner,
} from '../compute.js';
import {
  buildffmpegcommand,
  createoptimal,
  defaultpassagechannel,
  type mediajob,
  mediapipeline,
  mediapipelineerror,
  nvencpresets,
  passagesecurechannel,
  probefromname,
  recommendpreset,
  stagecatalog,
  stageorderv5,
  transcodemodecatalog,
  validatestagecatalog,
} from '../media.js';

const demojob: mediajob = {
  id: 'test-job',
  inputpath: '/data/in/demo_4k_hdr10plus_interlaced.mp4',
  outputpath: '/data/out/demo_1080p_av1_p4.mp4',
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
};

test('the stage catalog carries exactly 24 ordered stages', () => {
  const check = validatestagecatalog();
  assert.equal(check.count, 24);
  assert.equal(check.ordered, true);
  assert.equal(stagecatalog[0]?.name, '01_ingest_audit');
  assert.equal(stagecatalog[23]?.name, '24_artifact_gc_finalize');
  assert.equal(stageorderv5.length, 24);
});

test('the transcode mode taxonomy counts 30 modes', () => {
  assert.equal(transcodemodecatalog.length, 30);
  const families = new Set(transcodemodecatalog.map((entry) => entry.family));
  assert.ok(families.size >= 6, `expected at least 6 mode families, got ${families.size}`);
});

test('the nvenc preset ladder walks p1..p7 with multipass grades', () => {
  assert.deepEqual(
    nvencpresets.map((entry) => entry.preset),
    ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'],
  );
  assert.equal(nvencpresets[6]?.multipass, 'fullres');
  assert.equal(recommendpreset('av1', 'quality', false), 'p5');
  assert.equal(recommendpreset('h264', 'ultralowlatency', true), 'p1');
});

test('buildffmpegcommand emits the blackwell nvenc block with p4 vbr_hq b_ref_mode 2', () => {
  const probe = probefromname(demojob.inputpath);
  const cmd = buildffmpegcommand(demojob, probe, '15_nvenc_blackwell_encode');
  const line = cmd.join(' ');
  assert.ok(line.includes('-c:v av1_nvenc'));
  assert.ok(line.includes('-preset p4'));
  assert.ok(line.includes('-rc vbr_hq'));
  assert.ok(line.includes('-multipass 2'));
  assert.ok(line.includes('-b_ref_mode 2'));
  assert.ok(line.includes('-temporal_aq 1'));
  assert.ok(line.includes('-rc-lookahead 32'));
  assert.ok(line.includes('tonemap_cuda=tonemap=hable'));
  assert.ok(line.includes('colorspace_cuda=bt2020:bt709'));
  assert.ok(line.includes('bwdif_cuda=0:-1:0'));
  assert.ok(line.includes('-tier high'), 'av1 must request tier high');
});

test('createoptimal forces nvenc for 4k av1 and qsv for low-latency h264', () => {
  const hdrprobe = probefromname(demojob.inputpath);
  const av1 = createoptimal(demojob, hdrprobe);
  assert.equal(av1.vendor, 'nvidianvenc');
  const livejob: mediajob = {
    ...demojob,
    mode: 'cbr_low_latency',
    outputprofile: { ...demojob.outputprofile, videocodec: 'h264', preset: 'p1', tonemap: false },
  };
  const live = createoptimal(livejob, probefromname('/data/in/1080p_progressive.mp4'));
  assert.equal(live.vendor, 'intelqsv');
});

test('the pipeline executes 24 stages, honors skip rules and fail-fast', () => {
  const pipe = new mediapipeline();
  const probe = probefromname(demojob.inputpath);
  const result = pipe.executejob(demojob, probe);
  assert.equal(result.success, true);
  assert.equal(result.metrics.length, 24);
  const skipped = result.metrics.filter((record) => record.skipped).map((record) => record.stage);
  assert.ok(!skipped.includes('10DeinterlaceBwdifCuda'), 'interlaced input must keep deinterlace');
  assert.ok(!skipped.includes('12TonemapBt2020Cuda'), 'hdr tonemap job must keep tonemap');
  assert.ok(skipped.includes('18SubtitleBurn'), 'no subtitle path must skip the burn');
  assert.ok(result.passageframes >= 1, 'stage 20 must seal at least one passage frame');
  const clean = pipe.executejob(demojob, probefromname('/data/in/clean_1080p.mp4'));
  assert.ok(
    clean.metrics.some((record) => record.stage === '10DeinterlaceBwdifCuda' && record.skipped),
    'progressive input must skip deinterlace',
  );
});

test('non-recoverable stage failures stop the walk', () => {
  const pipe = new mediapipeline();
  const badjob: mediajob = {
    ...demojob,
    outputprofile: { ...demojob.outputprofile, videocodec: 'av1', preset: 'p1' },
  };
  const result = pipe.executejob(badjob, probefromname('/data/in/demo.mp4'));
  assert.equal(result.success, false);
  assert.ok(result.metrics.length < 24, 'fail-fast must stop before stage 24');
  assert.ok(
    result.metrics.some((record) => record.error !== undefined),
    'the failing stage must record its error',
  );
});

test('the passage channel seals, signs and reopens at MTU 65536', () => {
  assert.equal(defaultpassagechannel.mtu, 65536);
  assert.equal(defaultpassagechannel.auth, 'ed25519');
  assert.equal(defaultpassagechannel.encryption, 'chacha20-poly1305');
  const channel = new passagesecurechannel();
  const big = 'x'.repeat(70_000);
  const frames = channel.seal(big);
  assert.ok(frames.length >= 2, 'payload above the MTU must split into frames');
  const reopened = Buffer.concat(frames.map((frame) => channel.open(frame)));
  assert.equal(reopened.length, 70_000);
  const tampered = { ...frames[0], signature: Buffer.from('0'.repeat(64), 'hex') };
  assert.throws(() => channel.open(tampered), mediapipelineerror);
});

test('portal absorption: partykit, statevector, p2p addressing and tailscale guards', () => {
  const party = new partykitchannelbuilder().room('Sandbox 42 GPU 0');
  assert.equal(party.room, 'sandbox-42-gpu-0');
  assert.ok(party.url.startsWith('wss://'));
  const a = new statevectorsync();
  const b = new statevectorsync();
  a.set('k1', 'a');
  b.set('k2', 'b');
  const roundtrip = a.roundtrip(b);
  assert.equal(roundtrip.converged, true);
  const artifact = p2pcontentaddress(new TextEncoder().encode('e2ugh artifact'));
  assert.ok(artifact.cidv1raw.startsWith('bafk'));
  assert.ok(artifact.magnet.startsWith('magnet:?xt=urn:btih:'));
  const planner = new tailscaleendpointplanner();
  assert.equal(planner.iscgnat('100.100.1.1'), true);
  assert.equal(planner.iscgnat('8.8.8.8'), false);
  assert.throws(() => planner.plan('node', '8.8.8.8'), /CGNAT/);
});

test('the v4 roadmap backlog ledger carries 13 items', () => {
  assert.equal(backlogCount(), 13);
  assert.equal(roadmapbacklog[0]?.title, 'AMX tile real support');
  assert.equal(roadmapbacklog[12]?.title, 'Nix flakes hermetic builds');
});
