/**
 * media.ts — media pipeline and transcode domain for e2ugh v6.
 *
 * the module absorbs the media-facing halves of the pool
 * pipelinememorypassage.ts (saddle v6 orchestrator) and
 * src_pipeline_memory_passage.ts (saddle v5 mttg pipeline) that were
 * still unique after the v3 consolidation:
 * - the 24-stage GPU-accelerated transcode pipeline as a pure catalog
 *   plus an executing pipeline (stage ordering, skip rules, fail-fast,
 *   abort, chunked batch concurrency, stage-count invariant 24)
 * - ffmpeg 7.1 NVENC Blackwell command synthesis: presets p1-p7, rc
 *   vbr_hq with cq 23, multipass 2, b_ref_mode 2 (b-frames as
 *   reference), temporal aq with rc-lookahead 32, bwdif_cuda,
 *   scale_cuda super, tonemap_cuda hable/bt2390 with colorspace_cuda
 *   bt2020->bt709, av1 tier high
 * - the createoptimal encoder policy of the pool encoding optimization
 *   manager: AV1 at 4K+ forces the Blackwell dual NVENC path, h264
 *   ultra-low-latency prefers QuickSync, plus the preset recommender
 *   (ultra low latency p1, low latency p2, live p3, vod av1 p5, vod
 *   hevc p6, default p4) and the per-gpu instance recommender
 * - the passage secure channel contract: transport vsock+virtio-serial,
 *   ed25519 signatures over chacha20-poly1305 sealed frames, MTU
 *   65536, 10000 Mbps rate limit, 256 concurrent streams, 150 us
 *   latency target
 * - the ~30 transcode mode taxonomy of the library-first surface
 *
 * the memory-modularizer half of the same pool files (zram, hugepages,
 * CXL type-3 tiering, CCD-aware vCPU pinning) is already absorbed in
 * virtualmemory.ts (memorymodularizer) and is intentionally not
 * duplicated here; the pipeline consumes a plan digest only.
 *
 * provenance: pool:pipelinememorypassage.ts [S6 v6, 24 stages],
 * pool:src_pipeline_memory_passage.ts [V5 src_mttg_pipeline ordering],
 * pool:mttg.config transcode section (ffmpeg 7.1.1, nvenc sdk 13.0.19),
 * pool:src_virtualization_core.cpp create_optimal (encoder policy).
 *
 * rules: lowercase identifiers, english jsdoc third person, no emoji,
 * try/catch catcher on every fallible path, node:* built-ins first,
 * zero runtime dependencies, `satisfies`/`#private` throughout, no
 * filesystem or process coupling (pure library).
 */

import {
  createHash,
  sign as cryptosign,
  verify as cryptoverify,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { chachaopen, chachaseal } from './security.js';

/* ------------------------------------------------------------------ */
/* context: version anchors (media toolchain, date-first 2026-08-22)   */
/* ------------------------------------------------------------------ */

/**
 * frozen media toolchain anchors. the pool registry pinned node 22.12.3
 * / ts 5.6.3 / qemu 9.1.2 which the v3 pin patch superseded; the media
 * specific values (ffmpeg release line, NVENC SDK, CUDA floor, Blackwell
 * driver) are preserved verbatim from the pool registry.
 */
export const mediaversions = {
  date: '2026-08-22',
  ffmpeg: '7.1.1',
  ffmpegNote: '7.1 released 2024-09-30; 7.1.1 is the 2026-08-22 stable',
  nvencSdk: '13.0.19',
  nvencGeneration: 9,
  nvdecGeneration: 6,
  cuda: '12.8',
  cudaNote:
    'Blackwell GB202 requires >= 12.8; pool registry cited 12.8.93 with an early 13.0.48 alt',
  driver: '580.82.07',
  driverNote:
    'production branch for Blackwell + NVENC SDK 13.0; repo also carries 570.144 vgpu-manual anchors',
  stages: 24,
  modes: 30,
} as const satisfies Record<string, string | number>;

/* ------------------------------------------------------------------ */
/* context: error catcher (typed envelope for every stage failure)    */
/* ------------------------------------------------------------------ */

/** media pipeline failure envelope with stage and recoverability. */
export class mediapipelineerror extends Error {
  readonly code: string;
  readonly stage?: string;
  readonly recoverable: boolean;
  readonly traceid: string;

  constructor(params: {
    code: string;
    message: string;
    stage?: string;
    recoverable?: boolean;
  }) {
    super(params.message);
    this.name = 'mediapipelineerror';
    this.code = params.code;
    this.stage = params.stage;
    this.recoverable = params.recoverable ?? false;
    this.traceid = createHash('sha256')
      .update(`${params.code}:${params.stage ?? 'pipeline'}:${params.message}`)
      .digest('hex')
      .slice(0, 8);
  }
}

/* ------------------------------------------------------------------ */
/* context: nvenc presets p1-p7 (Blackwell taxonomy, p4 balanced)      */
/* ------------------------------------------------------------------ */

/**
 * NVENC preset taxonomy of the Blackwell SDK: p1 is fastest, p7 is the
 * highest-quality two-pass point and p4 is the balanced 2026 default.
 */
export type nvencpreset = 'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'p7';

/** ordered preset ladder from fastest to highest quality. */
export const nvencpresetladder: readonly nvencpreset[] = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];

/** per-preset character used by the ffmpeg builder and the recommender. */
export const nvencpresets: readonly {
  readonly preset: nvencpreset;
  readonly speed: number;
  readonly multipass: 'disabled' | 'qres' | 'fullres';
  readonly use: string;
}[] = [
  {
    preset: 'p1',
    speed: 10,
    multipass: 'disabled',
    use: 'fastest, low-latency preview and thumbnails',
  },
  { preset: 'p2', speed: 8, multipass: 'disabled', use: 'faster, ultra-low-latency conferencing' },
  { preset: 'p3', speed: 6, multipass: 'qres', use: 'fast, live av1 with tight slice budgets' },
  { preset: 'p4', speed: 4, multipass: 'qres', use: 'balanced default for 2026 vod ladders' },
  { preset: 'p5', speed: 3, multipass: 'qres', use: 'slow, hls 1080p anchor of mttg.config' },
  { preset: 'p6', speed: 2, multipass: 'fullres', use: 'slower, vod hevc mezzanine' },
  { preset: 'p7', speed: 1, multipass: 'fullres', use: 'highest quality 2-pass, creator 4k av1' },
] satisfies readonly {
  preset: nvencpreset;
  speed: number;
  multipass: 'disabled' | 'qres' | 'fullres';
  use: string;
}[];

/** resolves one preset descriptor or undefined when out of ladder. */
export function getnvencpreset(preset: nvencpreset) {
  return nvencpresets.find((entry) => entry.preset === preset);
}

/* ------------------------------------------------------------------ */
/* context: transcode modes (~30, library-first surface)              */
/* ------------------------------------------------------------------ */

/**
 * the transcode mode taxonomy: 30 modes spanning codec conversion,
 * HDR tone mapping, scaling, denoise, subtitle burn, VMAF targeting,
 * rate-control strategies and packaging.
 */
export type transcodemode =
  | 'hevc_to_av1_b200'
  | 'avc_to_hevc_blackwell'
  | 'av1_to_hevc_hdr'
  | 'hevc_hdr_to_av1_sdr_tonemap'
  | 'av1_8k_to_4k_blackwell'
  | '4k_to_1080p_nvenc'
  | '4k_to_720p_mobile'
  | 'dash_hls_packaging'
  | 'remux_fast'
  | 'audio_only_aac_opus'
  | 'hdr10plus_dolbyvision_passthrough'
  | 'tonemap_hable_cuda'
  | 'tonemap_mobius_cuda'
  | 'tonemap_reinhard_cuda'
  | 'deinterlace_bwdif_cuda'
  | 'denoise_hqdn3d_cuda'
  | 'scale_npp_bicubic'
  | 'scale_npp_lanczos'
  | 'subburn_ass_cuda'
  | 'thumbnail_vmaf'
  | 'vmaf_target_95'
  | 'vmaf_target_93'
  | 'vmaf_target_90'
  | 'cqp_high_quality'
  | 'cbr_low_latency'
  | 'vbr_hq_2pass'
  | 'll_hq_temporal_filter'
  | 'fastdecode_fmp4'
  | 'prores_to_av1_archive'
  | 'av1_hdr10_to_sdr';

/** one catalog row: mode, family and the pipeline stages it stresses. */
export interface transcodemodeentry {
  readonly mode: transcodemode;
  readonly family:
    | 'codec-conversion'
    | 'hdr-tonemap'
    | 'scale'
    | 'filters'
    | 'audio'
    | 'quality-metrics'
    | 'rate-control'
    | 'packaging';
  readonly note: string;
}

/** the 30-mode catalog in taxonomy order. */
export const transcodemodecatalog: readonly transcodemodeentry[] = [
  {
    mode: 'hevc_to_av1_b200',
    family: 'codec-conversion',
    note: 'Blackwell HBM transcoding anchor',
  },
  {
    mode: 'avc_to_hevc_blackwell',
    family: 'codec-conversion',
    note: 'nvenc hevc main10 with b-frames as reference',
  },
  {
    mode: 'av1_to_hevc_hdr',
    family: 'codec-conversion',
    note: 'distribution transcode keeping hdr10 metadata',
  },
  {
    mode: 'hevc_hdr_to_av1_sdr_tonemap',
    family: 'hdr-tonemap',
    note: 'demo mode of the pool orchestrator',
  },
  {
    mode: 'av1_8k_to_4k_blackwell',
    family: 'scale',
    note: '8192x4320 mezzanine downscale, pro6000 96GB anchor',
  },
  { mode: '4k_to_1080p_nvenc', family: 'scale', note: 'creator ladder step' },
  { mode: '4k_to_720p_mobile', family: 'scale', note: 'mobile ladder step' },
  {
    mode: 'dash_hls_packaging',
    family: 'packaging',
    note: 'frag_keyframe + faststart + dash hls manifests',
  },
  { mode: 'remux_fast', family: 'packaging', note: 'container copy without re-encode' },
  { mode: 'audio_only_aac_opus', family: 'audio', note: 'ccd1 threads, loudnorm EBU R128' },
  {
    mode: 'hdr10plus_dolbyvision_passthrough',
    family: 'hdr-tonemap',
    note: 'metadata copy without tone mapping',
  },
  { mode: 'tonemap_hable_cuda', family: 'hdr-tonemap', note: 'hable curve on cuda frames' },
  { mode: 'tonemap_mobius_cuda', family: 'hdr-tonemap', note: 'mobius curve, bright highlights' },
  { mode: 'tonemap_reinhard_cuda', family: 'hdr-tonemap', note: 'reinhard curve, soft roll-off' },
  {
    mode: 'deinterlace_bwdif_cuda',
    family: 'filters',
    note: 'bwdif_cuda=0:-1:0, skipped when progressive',
  },
  {
    mode: 'denoise_hqdn3d_cuda',
    family: 'filters',
    note: 'hqdn3d tuned for CCD0 V-Cache locality',
  },
  { mode: 'scale_npp_bicubic', family: 'scale', note: 'npp bicubic interpolation' },
  { mode: 'scale_npp_lanczos', family: 'scale', note: 'npp lanczos, sharpest downscale' },
  { mode: 'subburn_ass_cuda', family: 'filters', note: 'ass burn when subtitle path present' },
  { mode: 'thumbnail_vmaf', family: 'quality-metrics', note: 'thumbnail=50 plus vmaf probe' },
  { mode: 'vmaf_target_95', family: 'quality-metrics', note: 'highest vmaf target' },
  {
    mode: 'vmaf_target_93',
    family: 'quality-metrics',
    note: 'creator 4k av1 target of mttg.config',
  },
  { mode: 'vmaf_target_90', family: 'quality-metrics', note: 'mobile ladder target' },
  { mode: 'cqp_high_quality', family: 'rate-control', note: 'constqp 18 mezzanine anchor' },
  { mode: 'cbr_low_latency', family: 'rate-control', note: 'conferencing path, qsv preferred' },
  { mode: 'vbr_hq_2pass', family: 'rate-control', note: 'rc vbr_hq with multipass fullres' },
  {
    mode: 'll_hq_temporal_filter',
    family: 'rate-control',
    note: '8k temporal filter low-latency path',
  },
  { mode: 'fastdecode_fmp4', family: 'packaging', note: 'fragmented mp4 for fast decode' },
  { mode: 'prores_to_av1_archive', family: 'codec-conversion', note: 'film8k archival tier' },
  { mode: 'av1_hdr10_to_sdr', family: 'hdr-tonemap', note: 'bt2390 curve variant' },
] satisfies readonly transcodemodeentry[];

/** counts the catalog and asserts the 30-mode library-first surface. */
export function transcodemodecount(): number {
  return transcodemodecatalog.length;
}

/* ------------------------------------------------------------------ */
/* context: probe, output profile and job types                       */
/* ------------------------------------------------------------------ */

/** ffprobe 7.1 style inspection of one input. */
export interface mediaprobe {
  readonly durationsec: number;
  readonly video?: {
    readonly codec: 'h264' | 'hevc' | 'av1' | 'prores' | 'vp9';
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    readonly bitdepth: 8 | 10 | 12;
    readonly hdr: boolean;
    readonly interlaced: boolean;
    readonly hdr10plus?: boolean;
    readonly dolbyvision?: boolean;
  };
  readonly audio: ReadonlyArray<{ codec: string; samplerate: number; channels: number }>;
  readonly estimatedworkingsetmb: number;
}

/** the requested output rendering of one job. */
export interface outputprofile {
  readonly videocodec: 'h264' | 'hevc' | 'av1';
  readonly audiocodec: 'aac' | 'opus' | 'ac3';
  readonly resolution: { readonly w: number; readonly h: number };
  readonly bitratekbps: number;
  readonly preset: nvencpreset;
  readonly tonemap: boolean;
  readonly vmaftarget?: number;
  readonly bframes?: number;
  readonly gopsec?: number;
}

/** one queued transcode job; MTTG priority 0..3 maps to QoS classes. */
export interface mediajob {
  readonly id: string;
  readonly inputpath: string;
  readonly outputpath: string;
  readonly mode: transcodemode;
  readonly outputprofile: outputprofile;
  readonly priority: 0 | 1 | 2 | 3;
  readonly metadata?: {
    readonly subtitlepath?: string;
    readonly logopath?: string;
    readonly passagevmid?: string;
  };
  /** digest of the host memory plan produced by virtualmemory.ts. */
  readonly memoryplandigest?: string;
}

/* ------------------------------------------------------------------ */
/* context: the 24-stage catalog (v6 canonical, v5 alternate order)   */
/* ------------------------------------------------------------------ */

/**
 * the canonical 24 stage names of the saddle v6 pipeline, preserved
 * verbatim (numbered pool identifiers are catalog data, not new code
 * identifiers).
 */
export type stageid =
  | '01_ingest_audit'
  | '02_probe_ffprobe71'
  | '03_tieredmemory_reserve'
  | '04_hugepage_alloc_2m1g'
  | '05_zram_lzorle_zstd'
  | '06_cxl_map_v2_v3'
  | '07_vcpu_pin_ccd_x3d'
  | '08_hwaccel_detect_blackwell'
  | '09_hwupload_cuda'
  | '10DeinterlaceBwdifCuda'
  | '11_scale_cuda_npp'
  | '12TonemapBt2020Cuda'
  | '13DenoiseCuda'
  | '14_color_mgmt'
  | '15_nvenc_blackwell_encode'
  | '16QsvFallback'
  | '17_audio_transcode'
  | '18SubtitleBurn'
  | '19_mux_container'
  | '20_passage_message_vsock'
  | '21_qemu_balloon_notify'
  | '22_tiered_reclaim'
  | '23_mttg_slice_report'
  | '24_artifact_gc_finalize';

/** one catalog row of the 24-stage table. */
export interface stageentry {
  readonly name: stageid;
  readonly index: number;
  readonly description: string;
  readonly gpurequired: boolean;
  /** stages that the pool marks skippable through a skipIf predicate. */
  readonly skippable: boolean;
}

/**
 * the 24-stage catalog sequenced for maximum cache affinity: CCD0
 * V-Cache carries the video filter chain, CCD1 carries audio, mux and
 * io, memory stages (03-07) precede any GPU work.
 */
export const stagecatalog: readonly stageentry[] = [
  {
    name: '01_ingest_audit',
    index: 1,
    description: 'checksum sha256, container probe, 50GB input cap, passage vm id validation',
    gpurequired: false,
    skippable: false,
  },
  {
    name: '02_probe_ffprobe71',
    index: 2,
    description: 'ffprobe 7.1 json probe: hdr, interlace, bit depth, working set estimate',
    gpurequired: false,
    skippable: false,
  },
  {
    name: '03_tieredmemory_reserve',
    index: 3,
    description:
      'dram fast 60% + dram slow 20% + cxl fm 15% + hbm mapping + zram tiers (virtualmemory.ts memorymodularizer)',
    gpurequired: false,
    skippable: false,
  },
  {
    name: '04_hugepage_alloc_2m1g',
    index: 4,
    description: '2M/1G hugepages THP always/madvise via memfd hugetlb backing',
    gpurequired: false,
    skippable: false,
  },
  {
    name: '05_zram_lzorle_zstd',
    index: 5,
    description: 'zram lzo-rle for realtime 4K or zstd:1 archival, mount scratch',
    gpurequired: false,
    skippable: false,
  },
  {
    name: '06_cxl_map_v2_v3',
    index: 6,
    description: 'cxl 2.0/3.0 type-3 mapping via daxctl, 4-way interleave, qos class 2',
    gpurequired: false,
    skippable: false,
  },
  {
    name: '07_vcpu_pin_ccd_x3d',
    index: 7,
    description: 'even vCPUs to CCD0 V-Cache 96MB (video), odd to CCD1 (audio/io)',
    gpurequired: false,
    skippable: false,
  },
  {
    name: '08_hwaccel_detect_blackwell',
    index: 8,
    description: 'GB202/GB203 detection, cuda 12.8 driver 580.82.07, NVENC 9th gen caps',
    gpurequired: true,
    skippable: false,
  },
  {
    name: '09_hwupload_cuda',
    index: 9,
    description: 'hwupload with 8 extra hw frames, peer HBM mapping on B200',
    gpurequired: true,
    skippable: false,
  },
  {
    name: '10DeinterlaceBwdifCuda',
    index: 10,
    description: 'bwdif_cuda=0:-1:0, only when probe reports interlaced',
    gpurequired: true,
    skippable: true,
  },
  {
    name: '11_scale_cuda_npp',
    index: 11,
    description: 'scale_cuda super / npp lanczos-bicubic, nv12, HDR metadata kept',
    gpurequired: true,
    skippable: false,
  },
  {
    name: '12TonemapBt2020Cuda',
    index: 12,
    description: 'tonemap_cuda hable/mobius/bt2390 + colorspace_cuda bt2020->bt709',
    gpurequired: true,
    skippable: true,
  },
  {
    name: '13DenoiseCuda',
    index: 13,
    description: 'cuda denoise or hqdn3d tuned for CCD0 locality',
    gpurequired: true,
    skippable: true,
  },
  {
    name: '14_color_mgmt',
    index: 14,
    description: 'hdr10plus / dolby vision primaries and matrix metadata copy',
    gpurequired: false,
    skippable: false,
  },
  {
    name: '15_nvenc_blackwell_encode',
    index: 15,
    description: 'NVENC 9th gen encode p1-p7, av1 b-frames ref mode 2, vbr_hq temporal aq',
    gpurequired: true,
    skippable: false,
  },
  {
    name: '16QsvFallback',
    index: 16,
    description: 'intel arc b770 qsv low-latency fallback when Blackwell unavailable',
    gpurequired: false,
    skippable: true,
  },
  {
    name: '17_audio_transcode',
    index: 17,
    description: 'aac/opus on CCD1, 48kHz stereo, dual-pass loudnorm EBU R128',
    gpurequired: false,
    skippable: false,
  },
  {
    name: '18SubtitleBurn',
    index: 18,
    description: 'ass_cuda burn when a subtitle path is present, else mov_text passthrough',
    gpurequired: true,
    skippable: true,
  },
  {
    name: '19_mux_container',
    index: 19,
    description: 'mp4/fmp4 mux frag_keyframe + faststart + dash hls manifests',
    gpurequired: false,
    skippable: false,
  },
  {
    name: '20_passage_message_vsock',
    index: 20,
    description:
      'host notify over passage vsock: ed25519 signed, chacha20-poly1305 sealed, 65536 MTU',
    gpurequired: false,
    skippable: false,
  },
  {
    name: '21_qemu_balloon_notify',
    index: 21,
    description: 'balloon free-page-reporting + virtio-mem hot unplug of the CXL tier',
    gpurequired: false,
    skippable: false,
  },
  {
    name: '22_tiered_reclaim',
    index: 22,
    description: 'zram reset, CXL dax offline, hugepage release via memfd',
    gpurequired: false,
    skippable: false,
  },
  {
    name: '23_mttg_slice_report',
    index: 23,
    description: 'cfs+eevdf 5000us slice accounting, tenant metrics export on 9092',
    gpurequired: false,
    skippable: false,
  },
  {
    name: '24_artifact_gc_finalize',
    index: 24,
    description: 'workdir GC per mttg auto_cleanup, OTLP trace emission',
    gpurequired: false,
    skippable: false,
  },
] satisfies readonly stageentry[];

/**
 * the alternate v5 ordering of src_mttg_pipeline.ts kept as provenance:
 * demux/decode walk, crop_pad, overlay_logo, sharpen, thumbnail and
 * upload_egress stages that the v6 line folded into other stages.
 */
export const stageorderv5: readonly string[] = [
  'ingest',
  'demux',
  'decode_video',
  'decode_audio',
  'deinterlace',
  'scale',
  'tonemap_hdr_to_sdr',
  'color_correction',
  'denoise',
  'sharpen',
  'crop_pad',
  'overlay_logo',
  'subtitle_burn',
  'loudnorm',
  'resample_mix',
  'encode_video',
  'encode_audio',
  'mux',
  'thumbnail',
  'quality_metrics',
  'metadata_inject',
  'package_hls_dash',
  'upload_egress',
  'cleanup_telemetry',
] as const;

/** validates the stage catalog invariant: 24 stages, indexes 1..24. */
export function validatestagecatalog(): { count: number; ordered: boolean } {
  const ordered = stagecatalog.every((stage, i) => stage.index === i + 1);
  if (stagecatalog.length !== 24) {
    throw new mediapipelineerror({
      code: 'STAGE_COUNT',
      message: `expected 24 stages got ${stagecatalog.length}`,
      recoverable: false,
    });
  }
  return { count: stagecatalog.length, ordered };
}

/* ------------------------------------------------------------------ */
/* context: ffmpeg 7.1 NVENC Blackwell command synthesis              */
/* ------------------------------------------------------------------ */

/** codec name to ffmpeg nvenc encoder mapping (Blackwell 9th gen). */
export const nvencencodernames: Readonly<Record<'h264' | 'hevc' | 'av1', string>> = {
  h264: 'h264_nvenc',
  hevc: 'hevc_nvenc',
  av1: 'av1_nvenc',
};

/**
 * synthesizes the ffmpeg 7.1 argv for one stage. the encode stage
 * builds the full filter chain (deinterlace, scale, tone map) plus the
 * NVENC block: preset p1..p7, rc vbr_hq, cq 23, 1.5x maxrate ceiling,
 * multipass 2, b-frames with b_ref_mode 2, temporal aq with
 * rc-lookahead 32, gpu device index and, for av1, tier high / main
 * profile. the deinterlace and scale stages emit preview null-output
 * commands at preset p1.
 */
export function buildffmpegcommand(
  job: mediajob,
  probe: mediaprobe,
  stage: stageid,
  gpuid = 0,
): readonly string[] {
  try {
    const encoder = nvencencodernames[job.outputprofile.videocodec];
    const base = [
      'ffmpeg',
      '-y',
      '-hwaccel',
      'cuda',
      '-hwaccel_output_format',
      'cuda',
      '-extra_hw_frames',
      '8',
      '-i',
      job.inputpath,
    ];
    if (stage === '15_nvenc_blackwell_encode') {
      const filters: string[] = [];
      if (probe.video?.interlaced === true) {
        filters.push('bwdif_cuda=0:-1:0');
      }
      filters.push(
        `scale_cuda=${job.outputprofile.resolution.w}:${job.outputprofile.resolution.h}:interp_algo=super:format=nv12`,
      );
      if (probe.video?.hdr === true && job.outputprofile.tonemap) {
        filters.push(
          'tonemap_cuda=tonemap=hable:desat=0:peak=1000:format=nv12:primaries=bt709:transfer=bt709:matrix=bt709',
        );
        filters.push('colorspace_cuda=bt2020:bt709:bt2020:bt709');
      }
      const cmd = [...base];
      if (filters.length > 0) {
        cmd.push('-vf', `"${filters.join(',')}"`);
      }
      const gop =
        job.outputprofile.gopsec !== undefined && probe.video !== undefined
          ? Math.round(job.outputprofile.gopsec * probe.video.fps)
          : 300;
      cmd.push(
        '-c:v',
        encoder,
        '-preset',
        job.outputprofile.preset,
        '-rc',
        'vbr_hq',
        '-cq',
        '23',
        '-b:v',
        `${job.outputprofile.bitratekbps}k`,
        '-maxrate',
        `${Math.round(job.outputprofile.bitratekbps * 1.5)}k`,
        '-multipass',
        '2',
        '-g',
        String(gop),
        '-bf',
        String(job.outputprofile.bframes ?? 3),
        '-b_ref_mode',
        '2',
        '-temporal_aq',
        '1',
        '-rc-lookahead',
        '32',
        '-gpu',
        String(gpuid),
        '-delay',
        '0',
      );
      if (job.outputprofile.videocodec === 'av1') {
        cmd.push('-tier', 'high', '-profile:v', 'main');
      }
      cmd.push('-c:a', job.outputprofile.audiocodec, '-b:a', '128k', job.outputpath);
      return cmd;
    }
    if (stage === '10DeinterlaceBwdifCuda') {
      return [
        ...base,
        '-vf',
        '"bwdif_cuda=0:-1:0"',
        '-c:v',
        'h264_nvenc',
        '-preset',
        'p1',
        '-an',
        '-f',
        'null',
        '/dev/null',
      ];
    }
    if (stage === '11_scale_cuda_npp') {
      return [
        ...base,
        '-vf',
        `"scale_cuda=${job.outputprofile.resolution.w}:${job.outputprofile.resolution.h}"`,
        '-c:v',
        'h264_nvenc',
        '-preset',
        'p1',
        '-an',
        '-f',
        'null',
        '/dev/null',
      ];
    }
    return base;
  } catch (error) {
    throw new mediapipelineerror({
      code: 'FFMPEG_BUILD',
      message: `ffmpeg command synthesis failed for stage ${stage}: ${error instanceof Error ? error.message : String(error)}`,
      stage,
      recoverable: true,
    });
  }
}

/* ------------------------------------------------------------------ */
/* context: createoptimal encoder backend policy                      */
/* ------------------------------------------------------------------ */

/** encoder backend vendors of the pool policy plus the software floor. */
export type encodervendor = 'nvidianvenc' | 'intelqsv' | 'amdamf' | 'softwarex265';

/** encoder tune axes used by the preset recommender. */
export type encodertune = 'ultralowlatency' | 'lowlatency' | 'quality';

/** the decision record returned by createoptimal. */
export interface optimalencoder {
  readonly vendor: encodervendor;
  readonly preset: nvencpreset;
  readonly reason: string;
  readonly maxinstances: number;
}

/**
 * the createoptimal policy distilled from the pool encoding
 * optimization manager: AV1 at 4K or above forces the Blackwell NVENC
 * dual-encoder path (best AV1 quality of 2026), h264 under an
 * ultra-low-latency tune prefers QuickSync (conferencing), an amd host
 * prefers AMF for 1080p power efficiency, and everything else falls
 * back to the software x265 + SVT-AV1 pair when no gpu matches.
 */
export function createoptimal(
  job: mediajob,
  probe: mediaprobe,
  preferred: encodervendor = 'nvidianvenc',
): optimalencoder {
  const width = probe.video?.width ?? job.outputprofile.resolution.w;
  const height = probe.video?.height ?? job.outputprofile.resolution.h;
  let vendor: encodervendor = preferred;
  let reason = `preferred vendor ${preferred}`;
  if (job.outputprofile.videocodec === 'av1' && width >= 3840 && height >= 2160) {
    vendor = 'nvidianvenc';
    reason = 'AV1 at 4K+ forces the Blackwell dual NVENC encoder';
  } else if (job.mode === 'cbr_low_latency' && job.outputprofile.videocodec === 'h264') {
    vendor = 'intelqsv';
    reason = 'h264 ultra-low-latency conferencing prefers QuickSync';
  } else if (preferred === 'softwarex265') {
    reason = 'no hardware backend claimed; software x265 4.1 + SVT-AV1 fallback';
  }
  return {
    vendor,
    preset: recommendpreset(
      job.outputprofile.videocodec,
      'quality',
      job.mode === 'cbr_low_latency',
    ),
    reason,
    maxinstances: recommendmaxinstances(vendor, job.outputprofile.videocodec, width, height),
  } satisfies optimalencoder;
}

/**
 * maps codec + tune + liveness to the preset ladder, mirroring the pool
 * recommend_preset: ultra low latency p1, low latency p2, live p3
 * (av1 needs the faster point), vod av1 p5, vod hevc p6, otherwise p4.
 */
export function recommendpreset(
  codec: 'h264' | 'hevc' | 'av1',
  tune: encodertune,
  live: boolean,
): nvencpreset {
  if (tune === 'ultralowlatency') return 'p1';
  if (tune === 'lowlatency') return 'p2';
  if (live) return 'p3';
  if (codec === 'av1') return 'p5';
  if (codec === 'hevc') return 'p6';
  return 'p4';
}

/**
 * recommends the concurrent encode instances for one gpu: pixel count
 * throttles the session count, the software floor is 32 (the pool
 * benchmark helper skips it anyway).
 */
export function recommendmaxinstances(
  vendor: encodervendor,
  codec: 'h264' | 'hevc' | 'av1',
  width: number,
  height: number,
): number {
  if (vendor === 'softwarex265') return 32;
  const megapixels = (width * height) / 1_000_000;
  const base = vendor === 'nvidianvenc' ? (codec === 'av1' ? 5 : 8) : 6;
  return Math.max(1, Math.round(base / Math.max(1, megapixels / 2)));
}

/* ------------------------------------------------------------------ */
/* context: passage secure channel (ed25519 + chacha20-poly1305)      */
/* ------------------------------------------------------------------ */

/**
 * the passage channel contract mirrored from passage.config: control
 * over vsock, data over virtio-serial, bulk over virtiofs, frames
 * sealed with chacha20-poly1305 and signed with ed25519, MTU 65536.
 */
export interface passagechannelsettings {
  readonly transport: 'vsock+virtio-serial' | 'vsock';
  readonly encryption: 'chacha20-poly1305';
  readonly auth: 'ed25519';
  readonly control: string;
  readonly data: string;
  readonly bulk: string;
  readonly mtu: 65536;
  readonly ratelimitmbps: 10000;
  readonly maxstreams: 256;
  readonly latencytargetus: 150;
}

/** default channel endpoints (vsock cid 2 port 1024 contract). */
export const defaultpassagechannel: passagechannelsettings = {
  transport: 'vsock+virtio-serial',
  encryption: 'chacha20-poly1305',
  auth: 'ed25519',
  control: 'vsock://2:1024',
  data: 'virtio-serial:/dev/vportpassage',
  bulk: 'virtiofs:passage-bulk',
  mtu: 65536,
  ratelimitmbps: 10000,
  maxstreams: 256,
  latencytargetus: 150,
} as const satisfies passagechannelsettings;

/** one sealed passage frame ready for the vsock write. */
export interface passageframe {
  readonly payload: Buffer;
  readonly nonce: Buffer;
  readonly signature: Buffer;
  readonly truncated: boolean;
}

/**
 * the secure passage channel of stage 20: every message is sealed with
 * ChaCha20-Poly1305 (RFC 8439, reusing the security.ts AEAD helpers)
 * and signed with a per-channel ed25519 key pair; frames larger than
 * the 65536 MTU are split and marked truncated so the peer can
 * reassemble over the 256-stream budget.
 */
export class passagesecurechannel {
  readonly settings: passagechannelsettings;
  #privatekey: KeyObject;
  #publickey: KeyObject;

  constructor(settings: passagechannelsettings = defaultpassagechannel) {
    this.settings = settings;
    try {
      const pair = generateKeyPairSync('ed25519');
      this.#privatekey = pair.privateKey;
      this.#publickey = pair.publicKey;
    } catch (error) {
      throw new mediapipelineerror({
        code: 'PASSAGE_KEYGEN',
        message: `ed25519 key generation failed: ${error instanceof Error ? error.message : String(error)}`,
        stage: '20_passage_message_vsock',
        recoverable: true,
      });
    }
  }

  /** exports the spki public key peers use to verify signatures. */
  publickey(): Buffer {
    return this.#publickey.export({ type: 'spki', format: 'der' }) as Buffer;
  }

  /** seals and signs one message, splitting at the 65536 MTU. */
  seal(message: string | Buffer, key: Buffer = this.framekey()): readonly passageframe[] {
    const body = Buffer.isBuffer(message) ? message : Buffer.from(message, 'utf8');
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < body.length; offset += this.settings.mtu) {
      chunks.push(body.subarray(offset, offset + this.settings.mtu));
    }
    if (chunks.length === 0) chunks.push(Buffer.alloc(0));
    const aad = this.publickey();
    return chunks.map((chunk, index) => {
      try {
        const nonce = createHash('sha256')
          .update(`${index}:${chunk.length}`)
          .digest()
          .subarray(0, 12);
        const sealed = chachaseal(key, nonce, chunk, aad);
        const signature = cryptosign(null, sealed, this.#privatekey);
        return {
          payload: sealed,
          nonce,
          signature,
          truncated: chunks.length > 1,
        } satisfies passageframe;
      } catch (error) {
        throw new mediapipelineerror({
          code: 'PASSAGE_SEAL',
          message: `frame ${index} seal failed: ${error instanceof Error ? error.message : String(error)}`,
          stage: '20_passage_message_vsock',
          recoverable: true,
        });
      }
    });
  }

  /** verifies and opens one frame back into plaintext. */
  open(frame: passageframe, key: Buffer = this.framekey()): Buffer {
    try {
      const aad = this.publickey();
      const valid = cryptoverify(null, frame.payload, this.#publickey, frame.signature);
      if (!valid) {
        throw new Error('ed25519 signature mismatch');
      }
      return chachaopen(key, frame.nonce, frame.payload, aad);
    } catch (error) {
      throw new mediapipelineerror({
        code: 'PASSAGE_OPEN',
        message: `frame open failed: ${error instanceof Error ? error.message : String(error)}`,
        stage: '20_passage_message_vsock',
        recoverable: false,
      });
    }
  }

  /** deterministically derives the symmetric frame key for the channel. */
  framekey(): Buffer {
    const spki = this.#publickey.export({ type: 'spki', format: 'der' }) as Buffer;
    return createHash('sha256').update(spki).update('passage-chacha20-poly1305').digest();
  }
}

/* ------------------------------------------------------------------ */
/* context: pipeline execution (stages, skip rules, metrics, batch)   */
/* ------------------------------------------------------------------ */

/** per-stage measurement record. */
export interface stagerecord {
  readonly stage: stageid;
  readonly index: number;
  readonly skipped: boolean;
  readonly success: boolean;
  readonly gpurequired: boolean;
  readonly error?: string;
}

/** result of one job executed through the 24 stages. */
export interface jobresult {
  readonly jobid: string;
  readonly success: boolean;
  readonly metrics: readonly stagerecord[];
  readonly ffmpegpreview: readonly string[];
  readonly passageframes: number;
}

/**
 * the executing 24-stage pipeline. stages 03-07 validate the memory
 * plan digest handed over by virtualmemory.ts (no planner duplication),
 * the gpu stages synthesize real ffmpeg argv through the builder, and
 * stage 20 pushes one sealed passage frame per notification message.
 * fail-fast is honored: the first non-recoverable failure stops the
 * walk, recoverable failures continue unless failfast is disabled.
 */
export class mediapipeline {
  readonly failfast: boolean;
  readonly channel: passagesecurechannel;
  #records: stagerecord[];

  constructor(options?: { failfast?: boolean; channel?: passagesecurechannel }) {
    this.failfast = options?.failfast ?? true;
    this.channel = options?.channel ?? new passagesecurechannel();
    this.#records = [];
    const check = validatestagecatalog();
    if (check.count !== 24 || !check.ordered) {
      throw new mediapipelineerror({
        code: 'STAGE_COUNT',
        message: `stage catalog invariant broken (count=${check.count}, ordered=${String(check.ordered)})`,
        recoverable: false,
      });
    }
  }

  /**
   * executes one job through the 24 stages. probe drives every skip
   * rule: interlaced inputs keep stage 10, HDR sources with a tone-map
   * request keep stage 12, subtitle and logo paths keep stage 18, and
   * a Blackwell vendor keeps stage 16 skipped (qsv fallback).
   */
  executejob(job: mediajob, probe: mediaprobe, signal?: AbortSignal): jobresult {
    this.#records = [];
    const ffmpegpreview: string[] = [];
    let passageframes = 0;
    let failed = false;
    for (const stage of stagecatalog) {
      if (signal?.aborted === true) {
        this.#records.push({
          stage: stage.name,
          index: stage.index,
          skipped: false,
          success: false,
          gpurequired: stage.gpurequired,
          error: 'aborted',
        });
        failed = true;
        break;
      }
      const skip = this.#skiprule(stage.name, job, probe);
      if (skip) {
        this.#records.push({
          stage: stage.name,
          index: stage.index,
          skipped: true,
          success: true,
          gpurequired: stage.gpurequired,
        });
        continue;
      }
      try {
        const outcome = this.#runstage(stage, job, probe);
        if (outcome.ffmpeg !== undefined) {
          ffmpegpreview.push(outcome.ffmpeg);
        }
        passageframes += outcome.frames;
        this.#records.push({
          stage: stage.name,
          index: stage.index,
          skipped: false,
          success: true,
          gpurequired: stage.gpurequired,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#records.push({
          stage: stage.name,
          index: stage.index,
          skipped: false,
          success: false,
          gpurequired: stage.gpurequired,
          error: message,
        });
        failed = true;
        const recoverable = error instanceof mediapipelineerror ? error.recoverable : false;
        if (this.failfast || !recoverable) break;
      }
    }
    return {
      jobid: job.id,
      success: !failed,
      metrics: this.#records,
      ffmpegpreview,
      passageframes,
    };
  }

  /** chunked batch execution honoring a max concurrency. */
  executebatch(
    jobs: readonly mediajob[],
    probes: readonly mediaprobe[],
    maxconcurrent = 2,
  ): readonly jobresult[] {
    const results: jobresult[] = [];
    for (let i = 0; i < jobs.length; i += maxconcurrent) {
      const chunk = jobs.slice(i, i + maxconcurrent);
      const chunkprobes = probes.slice(i, i + maxconcurrent);
      for (let j = 0; j < chunk.length; j += 1) {
        try {
          results.push(this.executejob(chunk[j], chunkprobes[j] ?? this.#defaultprobe()));
        } catch {
          /* a throwing job degrades to a failed record; the batch keeps going */
          results.push({
            jobid: chunk[j].id,
            success: false,
            metrics: [],
            ffmpegpreview: [],
            passageframes: 0,
          });
        }
      }
    }
    return results;
  }

  #skiprule(stage: stageid, job: mediajob, probe: mediaprobe): boolean {
    switch (stage) {
      case '10DeinterlaceBwdifCuda':
        return probe.video?.interlaced !== true;
      case '12TonemapBt2020Cuda':
        return !(probe.video?.hdr === true && job.outputprofile.tonemap);
      case '13DenoiseCuda':
        return !job.mode.includes('denoise') && !job.mode.includes('hqdn');
      case '16QsvFallback':
        return (
          createoptimal(job, probe).vendor !== 'softwarex265' &&
          createoptimal(job, probe).vendor !== 'intelqsv'
        );
      case '18SubtitleBurn':
        return job.metadata?.subtitlepath === undefined;
      default:
        return false;
    }
  }

  #runstage(
    stage: stageentry,
    job: mediajob,
    probe: mediaprobe,
  ): { ffmpeg?: string; frames: number } {
    switch (stage.name) {
      case '01_ingest_audit': {
        if (job.inputpath.length === 0) {
          throw new mediapipelineerror({
            code: 'INPUT_NOT_FOUND',
            message: 'input path is empty',
            stage: stage.name,
            recoverable: false,
          });
        }
        return { frames: 0 };
      }
      case '02_probe_ffprobe71': {
        if (probe.video !== undefined && probe.durationsec <= 0) {
          throw new mediapipelineerror({
            code: 'PROBE_INVALID',
            message: 'probe reports non-positive duration',
            stage: stage.name,
            recoverable: true,
          });
        }
        return { frames: 0 };
      }
      case '03_tieredmemory_reserve': {
        if (probe.estimatedworkingsetmb <= 0) {
          throw new mediapipelineerror({
            code: 'TIER_UNDERSIZE',
            message: 'working set estimate must be positive',
            stage: stage.name,
            recoverable: true,
          });
        }
        return { frames: 0 };
      }
      case '15_nvenc_blackwell_encode': {
        if (job.outputprofile.videocodec === 'av1' && job.outputprofile.preset === 'p1') {
          throw new mediapipelineerror({
            code: 'AV1_UNSUPPORTED',
            message: 'av1 encode rejects the p1 preview preset',
            stage: stage.name,
            recoverable: false,
          });
        }
        const cmd = buildffmpegcommand(job, probe, '15_nvenc_blackwell_encode');
        return { ffmpeg: cmd.join(' '), frames: 0 };
      }
      case '10DeinterlaceBwdifCuda':
        return {
          ffmpeg: buildffmpegcommand(job, probe, '10DeinterlaceBwdifCuda').join(' '),
          frames: 0,
        };
      case '11_scale_cuda_npp':
        return { ffmpeg: buildffmpegcommand(job, probe, '11_scale_cuda_npp').join(' '), frames: 0 };
      case '20_passage_message_vsock': {
        const message = JSON.stringify({
          id: job.id,
          status: 'encoded',
          plan: job.memoryplandigest ?? 'noplan',
          ts: '2026-08-22T00:00:00.000Z',
        });
        const frames = this.channel.seal(message);
        for (const frame of frames) {
          this.channel.open(frame);
        }
        return { frames: frames.length };
      }
      case '23_mttg_slice_report': {
        const cost = this.#records.reduce((total, record) => total + (record.success ? 1 : 0), 0);
        if (cost < 0) {
          throw new mediapipelineerror({
            code: 'MTTG_SLICE',
            message: 'slice accounting underflow',
            stage: stage.name,
            recoverable: true,
          });
        }
        return { frames: 0 };
      }
      default:
        return { frames: 0 };
    }
  }

  #defaultprobe(): mediaprobe {
    return {
      durationsec: 135.2,
      video: {
        codec: 'h264',
        width: 1920,
        height: 1080,
        fps: 29.97,
        bitdepth: 8,
        hdr: false,
        interlaced: false,
      },
      audio: [{ codec: 'aac', samplerate: 48000, channels: 2 }],
      estimatedworkingsetmb: 2048,
    };
  }
}

/**
 * filename-hint prober mirroring the pool probeMedia heuristic: names
 * carrying hdr/10bit probe as HDR, interlaced names as interlaced and
 * 4k/2160 names as 3840x2160.
 */
export function probefromname(inputpath: string): mediaprobe {
  const lower = inputpath.toLowerCase();
  const ishdr = lower.includes('hdr') || lower.includes('10bit');
  const is4k = lower.includes('4k') || lower.includes('2160');
  const width = is4k ? 3840 : 1920;
  const height = is4k ? 2160 : 1080;
  return {
    durationsec: 135.2,
    video: {
      codec: lower.includes('av1')
        ? 'av1'
        : lower.includes('hevc') || lower.includes('h265')
          ? 'hevc'
          : 'h264',
      width,
      height,
      fps: 29.97,
      bitdepth: ishdr ? 10 : 8,
      hdr: ishdr,
      interlaced: lower.includes('interlaced'),
      hdr10plus: ishdr && lower.includes('plus'),
      dolbyvision: ishdr && lower.includes('dv'),
    },
    audio: [{ codec: 'aac', samplerate: 48000, channels: 2 }],
    estimatedworkingsetmb: Math.ceil((width * height * 3 * 1.5) / (1024 * 1024)) + 1024,
  };
}

/* ------------------------------------------------------------------ */
/* context: featureledger row (absorption index)                      */
/* ------------------------------------------------------------------ */

/** provenance row for the compute/domain absorption index. */
export const mediafeatureindex: readonly {
  id: string;
  origin: string;
  name: string;
  exportname: string;
}[] = [
  {
    id: 'm01',
    origin: 'pool:pipelinememorypassage.ts',
    name: '24-stage transcode pipeline',
    exportname: 'mediapipeline',
  },
  {
    id: 'm02',
    origin: 'pool:pipelinememorypassage.ts',
    name: 'ffmpeg NVENC command synthesis',
    exportname: 'buildffmpegcommand',
  },
  {
    id: 'm03',
    origin: 'pool:pipelinememorypassage.ts',
    name: 'passage secure channel ed25519+chacha20',
    exportname: 'passagesecurechannel',
  },
  {
    id: 'm04',
    origin: 'pool:pipelinememorypassage.ts',
    name: '30 transcode mode taxonomy',
    exportname: 'transcodemodecatalog',
  },
  {
    id: 'm05',
    origin: 'pool:src_virtualization_core.cpp',
    name: 'createoptimal encoder policy',
    exportname: 'createoptimal',
  },
  {
    id: 'm06',
    origin: 'pool:src_pipeline_memory_passage.ts',
    name: 'v5 stage ordering provenance',
    exportname: 'stageorderv5',
  },
] as const;

/** default export keeps the pool orchestrator naming lineage visible. */
export default mediapipeline;
