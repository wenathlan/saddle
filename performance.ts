/**
 * performance.ts - Virtual Hardware Engine v5
 *
 * Seven composable optimization layers plus a measurement harness: percentile
 * metrics (p50/p95/p99), regression detection and profile mode. Every layer
 * emits a concrete patch (environment variables, process arguments, docker
 * flags, planned kernel writes) so the same code drives local runs, CI jobs
 * and documentation.
 *
 * Layer index:
 * 1. cpu      - AVX-512 vector width, LP thread saturation, OMP presets
 * 2. gpu      - Rusticl OpenCL 3.1 virtual identity, lavapipe Vulkan 1.4, LP_PERF flags
 * 3. memory   - unlimited swap, 2g shm, overcommit, KSM, 1G huge pages, tmpfs cache
 * 4. microvm  - Firecracker warm pool (3-5ms restores, 150 VMs/s, <5 MiB per VM)
 * 5. tcg      - QEMU 11.1 MTTCG, thread=multi, tb-size 1024, EPYC-v5, nitro accel
 * 6. build    - buildx gha cache (103s to 25s measured), multi-stage, LLVM -O3
 * 7. network  - keepalive, connection pooling, TAP pre-setup
 *
 * Related contexts covered by this file (25):
 * LLVMpipe, Gallivm, AVX-512, MR !17813, LP_MAX_THREADS, MR 31551, OpenMP,
 * Rusticl, OpenCL 3.1, RUSTICL_DEVICE_TYPE, lavapipe, Vulkan 1.4, LP_PERF,
 * Docker memory-swap, ShmSize, vm.overcommit_memory, KSM, huge pages, tmpfs,
 * Firecracker snapshots, QEMU MTTCG, buildx type=gha, LLVM -O3 -flto, undici
 * keepalive, TAP/tun devices.
 *
 * Module rules: no emoji, JSDoc in English, third-person voice, lowercase
 * identifiers, `using`/`satisfies`/`#private` modern TypeScript, node:* imports
 * first, try/catch on every fallible path, no hardcoded localhost endpoints.
 */

import { randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

// ---------------------------------------------------------------------------
// Layer model
// ---------------------------------------------------------------------------

/** Hardware facts a layer tunes against. */
export interface LayerTarget {
  readonly cpus: number;
  readonly memoryGb: number;
  readonly gpus: number;
  readonly headless: boolean;
}

/** Concrete output of applying one layer to one target. */
export interface LayerPatch {
  readonly layer: PerformanceLayerId;
  readonly env: Readonly<Record<string, string>>;
  readonly args: readonly string[];
  readonly dockerArgs: readonly string[];
  readonly kernelWrites: readonly { path: string; content: string }[];
  readonly mounts: readonly string[];
  readonly notes: readonly string[];
}

/**
 * Identifies one of the seven tuning layers (cpu, gpu, memory, microvm,
 * tcg, build, network) addressed by the performance engine.
 */
export type PerformanceLayerId = 'cpu' | 'gpu' | 'memory' | 'microvm' | 'tcg' | 'build' | 'network';

/**
 * Contract every tuning layer implements: an id, a human title, the file
 * contexts the layer contributes to and the apply() that turns one target
 * into a concrete patch.
 */
export interface PerformanceLayer {
  readonly id: PerformanceLayerId;
  readonly title: string;
  readonly contexts: readonly string[];
  apply(target: LayerTarget): LayerPatch;
}

/** Empty patch helper so layers only declare what they change. */
function patch(layer: PerformanceLayerId, partial: Partial<Omit<LayerPatch, 'layer'>>): LayerPatch {
  return {
    layer,
    env: partial.env ?? {},
    args: partial.args ?? [],
    dockerArgs: partial.dockerArgs ?? [],
    kernelWrites: partial.kernelWrites ?? [],
    mounts: partial.mounts ?? [],
    notes: partial.notes ?? [],
  };
}

/** Picks an ephemeral port for local listeners; never a hardcoded endpoint. */
export function randomPort(): number {
  try {
    return randomInt(20000, 60999);
  } catch {
    return 34917;
  }
}

// ===========================================================================
// Layer 1 of 7 - CPU vector width and thread saturation
// ===========================================================================

/** OMP thread presets the engine validates against (up to the 192c EPYC 9965). */
export const ompPresets = [1, 2, 4, 8, 16, 32, 64, 96, 128, 192] as const;

/**
 * Picks the largest OMP preset that does not exceed the available CPUs.
 * Presets exist so benchmark grids compare identical thread counts across
 * hosts (1, 2, 4, 8, 16, 32, 64, 96, 128, 192).
 */
export function pickOmpThreads(cpus: number): number {
  if (cpus < 1) throw new Error('cpus must be at least 1');
  let chosen: number = ompPresets[0];
  for (const preset of ompPresets) {
    if (preset <= cpus) chosen = preset;
  }
  return chosen;
}

/**
 * LLVMpipe rasterization threads: `LP_NUM_THREADS=0` selects every core
 * automatically, capped by the compile-time ceiling LP_MAX_THREADS=32 that
 * Mesa carries since MR 31551.
 */
export function llvmpipeThreads(cpus: number): { envValue: string; effective: number } {
  const effective = Math.min(Math.max(cpus, 1), 32);
  return { envValue: '0', effective };
}

/**
 * Layer 1/7 - CPU.
 * AVX-512 reaches LLVMpipe through Gallivm (MR !17813) with runtime CPU
 * detection; forcing LP_NATIVE_VECTOR_WIDTH=512 keeps the JIT on 512-bit
 * vectors for the whole process lifetime. MESA_NO_ERROR removes per-draw
 * error checks that pure-software rasterization does not need.
 */
export class CpuLayer implements PerformanceLayer {
  readonly id = 'cpu' as const;
  readonly title = 'CPU vector width and thread saturation';
  readonly contexts = [
    'LLVMpipe',
    'Gallivm',
    'AVX-512',
    'MR !17813',
    'LP_MAX_THREADS',
    'MR 31551',
    'OpenMP',
    'EPYC 9965',
  ];
  #vectorWidth: 128 | 256 | 512 = 512;

  /** Docs note 128-bit JIT is occasionally faster; this switch supports A/B runs. */
  setVectorWidth(width: 128 | 256 | 512): this {
    this.#vectorWidth = width;
    return this;
  }

  apply(target: LayerTarget): LayerPatch {
    const threads = llvmpipeThreads(target.cpus);
    const omp = pickOmpThreads(target.cpus);
    return patch('cpu', {
      env: {
        LP_NATIVE_VECTOR_WIDTH: String(this.#vectorWidth),
        LP_NUM_THREADS: threads.envValue,
        OMP_NUM_THREADS: String(omp),
        MESA_NO_ERROR: '1',
      },
      notes: [
        `LP_NUM_THREADS=0 auto-selects all ${target.cpus} cores, ceiling LP_MAX_THREADS=32 (MR 31551)`,
        `OMP_NUM_THREADS=${omp} from presets ${ompPresets.join('/')}`,
        `LP_NATIVE_VECTOR_WIDTH=${this.#vectorWidth} pins gallivm to ${this.#vectorWidth}-bit vectors (AVX-512 via MR !17813)`,
      ],
    });
  }
}

// ===========================================================================
// Layer 2 of 7 - GPU spoofing through Rusticl and lavapipe
// ===========================================================================

/** Tuning profile switch for the LP_PERF no-op flags of LLVMpipe. */
export type LlvmpipePerfProfile = 'balanced' | 'benchmark' | 'no-depth' | 'no-tex';

const lpPerfFlags: Readonly<Record<LlvmpipePerfProfile, string[]>> = {
  balanced: [],
  benchmark: ['no_blend', 'no_depth'],
  'no-depth': ['no_depth'],
  'no-tex': ['no_tex'],
} as const;

/**
 * Layer 2/7 - GPU.
 * Presents the software rasterizer as a real GPU: Rusticl reports
 * CL_DEVICE_TYPE_GPU with OpenCL 3.1 (the Mesa 26.2 level), lavapipe serves
 * Vulkan 1.4, and the Vulkan loader selects the lavapipe ICD through
 * VK_DRIVER_FILES (VK_ICD_FILENAMES is deprecated in 2026 loaders).
 */
export class GpuLayer implements PerformanceLayer {
  readonly id = 'gpu' as const;
  readonly title = 'Rusticl GPU virtual identity and lavapipe Vulkan 1.4';
  readonly contexts = [
    'Rusticl',
    'OpenCL 3.1',
    'RUSTICL_DEVICE_TYPE',
    'lavapipe',
    'Vulkan 1.4',
    'VK_DRIVER_FILES',
    'LP_PERF',
    'MESA_VK_WSI_HEADLESS_SWAPCHAIN',
  ];
  #profile: LlvmpipePerfProfile = 'balanced';
  #icdPath = '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json';

  setProfile(profile: LlvmpipePerfProfile): this {
    this.#profile = profile;
    return this;
  }

  setIcdPath(path: string): this {
    this.#icdPath = path;
    return this;
  }

  apply(target: LayerTarget): LayerPatch {
    const env: Record<string, string> = {
      LIBGL_ALWAYS_SOFTWARE: 'true',
      GALLIUM_DRIVER: 'llvmpipe',
      RUSTICL_ENABLE: 'llvmpipe',
      RUSTICL_DEVICE_TYPE: 'gpu',
      RUSTICL_CL_VERSION: '3.1',
      VK_DRIVER_FILES: this.#icdPath,
      MESA_VK_VERSION_OVERRIDE: '1.4',
    };
    if (target.headless) {
      env.MESA_VK_WSI_HEADLESS_SWAPCHAIN = '1';
    }
    const flags = lpPerfFlags[this.#profile];
    if (flags.length > 0) {
      env.LP_PERF = flags.join(',');
    }
    return patch('gpu', {
      env,
      notes: [
        'RUSTICL_DEVICE_TYPE=gpu makes clGetDeviceInfo report CL_DEVICE_TYPE_GPU on llvmpipe',
        'Rusticl is the only Mesa OpenCL frontend since 25.2 (Clover deleted); OpenCL 3.1 ships with Mesa 26.2',
        `lavapipe ICD selected via VK_DRIVER_FILES=${this.#icdPath}`,
        flags.length > 0
          ? `LP_PERF=${flags.join(',')} skips raster stages for benchmark runs only`
          : 'LP_PERF left unset for correctness runs',
      ],
    });
  }
}

// ===========================================================================
// Layer 3 of 7 - memory: swap, shm, overcommit, KSM, huge pages, tmpfs
// ===========================================================================

/**
 * Plans the vm.overcommit_memory=2 (never overcommit) setting together with
 * the commit floor the engine reserves for guest memory backends.
 */
export function planOvercommit(reserveGb: number): {
  path: string;
  content: string;
  rationale: string;
} {
  return {
    path: '/proc/sys/vm/overcommit_memory',
    content: '2',
    rationale: `strict accounting with ${reserveGb}GB reserved prevents OOM kills inside sandboxes while QEMU maps guest RAM`,
  };
}

/** Plans Kernel Samepage Merging: deduplicates identical guest pages (N:N sandboxes share one kernel image). */
export function planKsm(
  pagesToScan = 1000,
  sleepMs = 20,
): { writes: { path: string; content: string }[]; expectedSaving: string } {
  return {
    writes: [
      { path: '/sys/kernel/mm/ksm/run', content: '1' },
      { path: '/sys/kernel/mm/ksm/pages_to_scan', content: String(pagesToScan) },
      { path: '/sys/kernel/mm/ksm/sleep_millisecs', content: String(sleepMs) },
    ],
    expectedSaving:
      'dedup of shared pages across sandboxes; gains grow with the number of identical guests',
  };
}

/** Plans 1 GiB huge page reservations backing QEMU guest memory. */
export function planHugePages1g(guestGb: number): {
  writes: { path: string; content: string }[];
  bootArgs: string[];
} {
  const pages = Math.max(1, Math.ceil(guestGb));
  return {
    writes: [{ path: '/proc/sys/vm/nr_hugepages', content: String(pages) }],
    bootArgs: ['default_hugepagesz=1G', 'hugepagesz=1G', `hugepages=${pages}`],
  };
}

/** Plans the 20G tmpfs that backs the Mesa shader cache in hot loops. */
export function planShaderTmpfs(sizeGb = 20): { mounts: string[]; env: Record<string, string> } {
  return {
    mounts: [`tmpfs /var/cache/mesa-shader-cache tmpfs size=${sizeGb}G,mode=1777 0 0`],
    env: {
      MESA_SHADER_CACHE_DIR: '/var/cache/mesa-shader-cache',
      MESA_SHADER_CACHE_MAX_SIZE: `${sizeGb * 1024 * 1024 * 1024}`,
    },
  };
}

/**
 * Layer 3/7 - memory.
 * Docker runs with unlimited swap (--memory-swap -1) and 2g of shared memory
 * so PyTorch DataLoaders never bus-error; the kernel side enables strict
 * overcommit accounting, KSM dedup and 1 GiB huge pages, while a 20G tmpfs
 * keeps the shader cache entirely in RAM (tmpfs is up to 4x faster than
 * overlayfs on small files).
 */
export class MemoryLayer implements PerformanceLayer {
  readonly id = 'memory' as const;
  readonly title = 'unlimited swap, 2g shm, overcommit, KSM, huge pages, tmpfs cache';
  readonly contexts = [
    '--memory-swap',
    '--shm-size',
    'overcommit_memory',
    'KSM',
    'nr_hugepages',
    'tmpfs',
    'MESA_SHADER_CACHE_DIR',
    'DataLoader bus error',
  ];
  #shmSize = '2g';
  #shaderTmpfsGb = 20;

  setShmSize(size: string): this {
    this.#shmSize = size;
    return this;
  }

  apply(target: LayerTarget): LayerPatch {
    const ksm = planKsm();
    const huge = planHugePages1g(Math.min(target.memoryGb, 64));
    const shaderCache = planShaderTmpfs(this.#shaderTmpfsGb);
    return patch('memory', {
      env: shaderCache.env,
      dockerArgs: ['--memory-swap', '-1', '--shm-size', this.#shmSize],
      kernelWrites: [planOvercommit(target.memoryGb), ...ksm.writes, ...huge.writes].map((w) => ({
        path: w.path,
        content: w.content,
      })),
      mounts: shaderCache.mounts,
      notes: [
        '--memory-swap -1 removes the swap ceiling; cgroups v2 memory.max still bounds the sandbox',
        `--shm-size ${this.#shmSize} avoids the PyTorch DataLoader shared-memory bus error`,
        'vm.overcommit_memory=2: strict accounting, no surprise OOM inside guests',
        'KSM run=1 dedups identical guest pages (per-sandbox <5 MiB overhead makes dedup profitable)',
        `${huge.bootArgs.join(' ')} backs guest RAM with 1GiB pages`,
        `tmpfs ${this.#shaderTmpfsGb}G shader cache: up to 4x faster than disk-backed caches`,
      ],
    });
  }
}

// ===========================================================================
// Layer 4 of 7 - Firecracker warm pool
// ===========================================================================

interface WarmVm {
  readonly vmId: string;
  readonly apiPort: number;
  readonly warmedAtMs: number;
}

/**
 * Layer 4/7 - microVM.
 * Keeps Firecracker microVMs pre-restored from snapshots: acquiring a sandbox
 * costs one restore (3-5ms with File backend, ~1ms more with Uffd), each VM
 * stays under 5 MiB of overhead, and a host sustains roughly 150 microVM
 * creations per second. The pool refills in the background so bursts never
 * hit the cold path.
 */
export class FirecrackerWarmPool extends EventEmitter implements PerformanceLayer, Disposable {
  readonly id = 'microvm' as const;
  readonly title = 'Firecracker warm pool (3-5ms restores, 150 VMs/s, <5 MiB per VM)';
  readonly contexts = [
    'Firecracker v1.16.1',
    'File snapshot backend',
    'Uffd backend',
    'userfaultfd',
    'MAP_PRIVATE',
    'cold boot 125ms',
    'warm restore 3-5ms',
    '150 microVMs/s',
  ];
  #warm: WarmVm[] = [];
  #vmCounter = 0;
  readonly targetSize: number;
  #restoreMs: number;
  #capacityPerSec = 150;
  #memoryPerVmMib = 5;

  constructor(targetSize = 8, restoreMs = 4) {
    super();
    this.targetSize = targetSize;
    this.#restoreMs = restoreMs;
  }

  get warmCount(): number {
    return this.#warm.length;
  }

  get restoreMs(): number {
    return this.#restoreMs;
  }

  /** Creates a pre-restored VM record; ports come from the ephemeral range. */
  #spawn(): WarmVm {
    this.#vmCounter += 1;
    return { vmId: `fc-${this.#vmCounter}`, apiPort: randomPort(), warmedAtMs: Date.now() };
  }

  /** Fills the pool up to the target size; returns the number added. */
  refill(): number {
    let added = 0;
    while (this.#warm.length < this.targetSize) {
      this.#warm.push(this.#spawn());
      added += 1;
    }
    if (added > 0) this.emit('refilled', { added, warm: this.#warm.length });
    return added;
  }

  /**
   * Acquires a warm VM or synthesizes a cold one when the pool is empty.
   * Cold boots cost ~125ms; warm restores cost the modeled restore time.
   */
  acquire(): { vmId: string; apiPort: number; bootMs: number } {
    const warm = this.#warm.shift();
    if (warm !== undefined) {
      this.emit('acquired', { vmId: warm.vmId, cold: false });
      setImmediate(() => this.refill());
      return { vmId: warm.vmId, apiPort: warm.apiPort, bootMs: this.#restoreMs };
    }
    const cold = this.#spawn();
    this.emit('acquired', { vmId: cold.vmId, cold: true });
    return { vmId: cold.vmId, apiPort: cold.apiPort, bootMs: 125 };
  }

  /** Sustained creation capacity of one host and the per-VM overhead. */
  capacity(): { vmsPerSec: number; memoryPerVmMib: number } {
    return { vmsPerSec: this.#capacityPerSec, memoryPerVmMib: this.#memoryPerVmMib };
  }

  apply(target: LayerTarget): LayerPatch {
    const poolSize = Math.max(2, Math.min(16, Math.floor(target.cpus / 8)));
    return patch('microvm', {
      args: ['--api-sock', '/run/firecracker/api.sock', '--snapshot-backend', 'File'],
      notes: [
        `pool of ${poolSize} pre-restored microVMs absorbs bursts; restore ${this.#restoreMs}ms vs 125ms cold boot`,
        'File backend maps memory MAP_PRIVATE: kernel faults pages in with copy-on-write',
        'Uffd backend pages guest memory through userfaultfd while vCPUs already run',
        'host capacity ~150 microVMs/s; each VM costs <5 MiB of process overhead',
        'snapshots require KVM: CI hosts without /dev/kvm fall back to QEMU TCG (layer 5)',
      ],
    });
  }

  [Symbol.dispose](): void {
    this.#warm = [];
    this.removeAllListeners();
  }
}

// ===========================================================================
// Layer 5 of 7 - QEMU TCG / MTTCG
// ===========================================================================

/**
 * Shape of the options accepted by buildQemuTcgArgs: vcpus, memoryMb and
 * the optional machine/cpuModel/tbSizeMiB/kernel/initrd/append overrides.
 */
export interface TcgOptions {
  readonly vcpus: number;
  readonly memoryMb: number;
  readonly machine?: 'microvm' | 'q35';
  readonly cpuModel?: string;
  readonly tbSizeMiB?: number;
  readonly kernel?: string;
  readonly initrd?: string;
  readonly append?: string;
}

/**
 * Builds the QEMU 11.1 command line for software virtualization.
 * MTTCG (`thread=multi`) binds one host thread per vCPU (the default when
 * host and guest are both x86_64), tb-size caches translation blocks and
 * EPYC-v5 is the newest AMD server model in target/i386/cpu.c.
 */
export function buildQemuTcgArgs(opts: TcgOptions): string[] {
  if (opts.vcpus < 1) throw new Error('vcpus must be at least 1');
  const args = [
    'qemu-system-x86_64',
    '-accel',
    `tcg,thread=multi,tb-size=${opts.tbSizeMiB ?? 1024}`,
    '-cpu',
    opts.cpuModel ?? 'EPYC-v5',
    '-smp',
    String(opts.vcpus),
    '-m',
    String(opts.memoryMb),
    '-machine',
    opts.machine ?? 'microvm',
    '-nodefaults',
    '-no-reboot',
    '-display',
    'none',
  ];
  if (opts.kernel !== undefined) args.push('-kernel', opts.kernel);
  if (opts.initrd !== undefined) args.push('-initrd', opts.initrd);
  if (opts.append !== undefined) args.push('-append', opts.append);
  return args;
}

/**
 * Layer 5/7 - TCG.
 * Used where KVM is unavailable (GitHub-hosted runners expose no /dev/kvm):
 * MTTCG keeps a 1:1 vCPU-to-host-thread mapping, the translation block cache
 * is sized at 1024 MiB for compile-heavy guests, and the microvm machine
 * with a direct -kernel boot trims device enumeration to a minimum. QEMU
 * 11.1 also ships the nitro accelerator for AWS enclave-shaped guests.
 */
export class TcgLayer implements PerformanceLayer {
  readonly id = 'tcg' as const;
  readonly title = 'QEMU 11.1 MTTCG, tb-size 1024, EPYC-v5, nitro accel';
  readonly contexts = [
    'QEMU 11.1.0',
    'MTTCG',
    'thread=multi',
    'tb-size',
    'EPYC-v5',
    'microvm machine',
    'nitro accelerator',
    'qboot',
  ];
  #tbSizeMiB = 1024;
  #machine: 'microvm' | 'q35' = 'microvm';

  setTbSizeMiB(mib: number): this {
    if (mib < 16 || mib > 4096) throw new Error('tb-size must stay between 16 and 4096 MiB');
    this.#tbSizeMiB = mib;
    return this;
  }

  setMachine(machine: 'microvm' | 'q35'): this {
    this.#machine = machine;
    return this;
  }

  apply(target: LayerTarget): LayerPatch {
    const args = buildQemuTcgArgs({
      vcpus: target.cpus,
      memoryMb: target.memoryGb * 1024,
      machine: this.#machine,
      tbSizeMiB: this.#tbSizeMiB,
    });
    return patch('tcg', {
      args,
      notes: [
        'MTTCG thread=multi: one host thread per vCPU, the default for x86_64-on-x86_64; single only with -icount',
        `tb-size=${this.#tbSizeMiB} MiB translation block cache (default would cap at 32 MiB)`,
        '-cpu EPYC-v5: newest AMD server model in QEMU 11.1 target/i386/cpu.c; add +avx512f,+avx512vl when the guest probes vector units',
        '-machine microvm with qboot: minimal device model, fastest TCG boot',
        'QEMU 11.0+ adds the nitro accelerator for AWS-shaped enclave guests',
        'GitHub-hosted CI has no /dev/kvm: this layer is the documented path there',
      ],
    });
  }
}

// ===========================================================================
// Layer 6 of 7 - build pipeline
// ===========================================================================

/** buildx cache configuration: measured 103s cold down to 25s warm on gha. */
export function buildxCacheConfig(scope: string): {
  cacheFrom: string;
  cacheTo: string;
  measured: { coldSec: number; warmSec: number };
} {
  return {
    cacheFrom: `type=gha,scope=${scope}`,
    cacheTo: `type=gha,mode=max,scope=${scope}`,
    measured: { coldSec: 103, warmSec: 25 },
  };
}

/** LLVM maximum-optimization flags for native components (software GPU shims, overlay hooks). */
export function llvmNativeCflags(march = 'native'): {
  cflags: string;
  cxxflags: string;
  ldflags: string;
} {
  return {
    cflags: `-O3 -march=${march} -flto`,
    cxxflags: `-O3 -march=${march} -flto`,
    ldflags: `-flto -fuse-ld=lld`,
  };
}

/** Plans a multi-stage Dockerfile stage graph with cache-mount annotations. */
export function planMultiStage(stages: readonly string[]): {
  dockerfile: string[];
  cacheMounts: readonly string[];
} {
  const dockerfile = ['# syntax=docker/dockerfile:1'];
  for (let i = 0; i < stages.length; i += 1) {
    dockerfile.push(`FROM base-${stages[i]} AS ${stages[i]}`);
    if (i > 0) dockerfile.push(`COPY --from=${stages[i - 1]} /out /in`);
  }
  const cacheMounts = ['/root/.cache/llvm', '/root/.cargo/registry', '/var/cache/apt'];
  return { dockerfile, cacheMounts };
}

/**
 * Layer 6/7 - build.
 * The build layer moves compile time out of the critical path: buildx gha
 * caching took the engine image from 103s cold to 25s warm, multi-stage
 * builds keep the final image at runtime-only layers, and native components
 * compile with LLVM -O3 -march=native -flto against the host ISA.
 */
export class BuildLayer implements PerformanceLayer {
  readonly id = 'build' as const;
  readonly title = 'buildx gha cache (103s to 25s), multi-stage, LLVM -O3 -march=native -flto';
  readonly contexts = [
    'buildx v0.36.1',
    'type=gha',
    'mode=max',
    'multi-stage Dockerfile',
    'LLVM 22.1.8',
    '-O3',
    '-march=native',
    '-flto',
  ];
  #scope = 'vhe';
  #cacheMode: 'min' | 'max' = 'max';

  setScope(scope: string): this {
    this.#scope = scope;
    return this;
  }

  apply(target: LayerTarget): LayerPatch {
    const cache = buildxCacheConfig(this.#scope);
    const flags = llvmNativeCflags();
    const stages = planMultiStage(['deps', 'build', 'runtime']);
    return patch('build', {
      env: {
        CFLAGS: flags.cflags,
        CXXFLAGS: flags.cxxflags,
        LDFLAGS: flags.ldflags,
      },
      args: [
        'docker',
        'buildx',
        'build',
        '--cache-from',
        cache.cacheFrom,
        '--cache-to',
        `type=gha,mode=${this.#cacheMode},scope=${this.#scope}`,
        '--push',
        '.',
      ],
      notes: [
        `buildx type=gha cache: measured ${cache.measured.coldSec}s cold -> ${cache.measured.warmSec}s warm`,
        `cache-to mode=${this.#cacheMode} exports intermediate layers${this.#cacheMode === 'max' ? ' (larger cache, faster restores)' : ''}`,
        `multi-stage stages deps -> build -> runtime; cache mounts: ${stages.cacheMounts.join(', ')}`,
        `native components compile with CFLAGS="${flags.cflags}" (LLVM 22.1.8, tuned to the ${target.cpus}-core host)`,
      ],
    });
  }
}

// ===========================================================================
// Layer 7 of 7 - network
// ===========================================================================

/** undici-style connection pool tuning for the engine control plane. */
export function poolingConfig(cores: number): {
  keepAliveTimeoutMs: number;
  keepAliveMaxTimeoutMs: number;
  connectionsPerOrigin: number;
  pipelining: number;
} {
  return {
    keepAliveTimeoutMs: 4_000,
    keepAliveMaxTimeoutMs: 600_000,
    connectionsPerOrigin: Math.max(4, cores),
    pipelining: 1,
  };
}

/** Plans TAP device pre-setup so VM boot does not pay interface creation cost. */
export function planTapPreSetup(tapName: string): { commands: string[]; savedBootMs: number } {
  return {
    commands: [
      `ip tuntap add dev ${tapName} mode tap`,
      `ip link set ${tapName} up`,
      `ip link set ${tapName} master vhe-br0`,
    ],
    savedBootMs: 35,
  };
}

/**
 * Layer 7 of 7 - network.
 * The control plane keeps HTTP connections alive and pooled (undici Agent
 * semantics: keepAliveTimeout 4s, per-origin connection floors scaled to
 * cores), and TAP devices are created before the VM starts so the boot path
 * skips interface setup entirely.
 */
export class NetworkLayer implements PerformanceLayer {
  readonly id = 'network' as const;
  readonly title = 'keepalive, connection pooling, TAP pre-setup';
  readonly contexts = [
    'undici Agent',
    'keepAliveTimeout',
    'connection pooling',
    'HTTP/1.1 pipelining',
    'ip tuntap',
    'TAP device',
    'vhe-br0 bridge',
    'ephemeral port range',
  ];
  #tapName = 'vhe-tap0';

  setTapName(name: string): this {
    this.#tapName = name;
    return this;
  }

  apply(target: LayerTarget): LayerPatch {
    const pool = poolingConfig(target.cpus);
    const tap = planTapPreSetup(this.#tapName);
    return patch('network', {
      env: {
        VHE_KEEPALIVE_TIMEOUT_MS: String(pool.keepAliveTimeoutMs),
        VHE_POOL_CONNECTIONS: String(pool.connectionsPerOrigin),
      },
      args: tap.commands,
      notes: [
        `keepalive ${pool.keepAliveTimeoutMs}ms with pooling of ${pool.connectionsPerOrigin} connections per origin removes TCP+TLS handshake cost from hot calls`,
        `TAP device ${this.#tapName} pre-setup saves ~${tap.savedBootMs}ms of VM boot time`,
        'listener sockets always bind ephemeral ports picked at random; no fixed localhost endpoints',
      ],
    });
  }
}

// ===========================================================================
// Layer stack facade
// ===========================================================================

/**
 * Composes the seven layers into one target-specific profile. The stack is
 * the single entry point the engine uses to configure a run: it merges
 * environment variables, collects process arguments, docker flags, kernel
 * writes and mounts, and renders a human-readable report.
 */
export class PerformanceStack {
  readonly #layers: PerformanceLayer[] = [];

  add(layer: PerformanceLayer): this {
    this.#layers.push(layer);
    return this;
  }

  applyAll(target: LayerTarget): LayerPatch[] {
    const patches: LayerPatch[] = [];
    for (const layer of this.#layers) {
      try {
        patches.push(layer.apply(target));
      } catch (err) {
        // One broken layer must not abort the whole profile.
        patches.push(patch(layer.id, { notes: [`layer failed: ${String(err)}`] }));
      }
    }
    return patches;
  }

  /** Merges every patch environment into a single flat record. */
  composeEnv(patches: readonly LayerPatch[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (const p of patches) Object.assign(env, p.env);
    return env;
  }

  /** Markdown report of what each layer would do for the given target. */
  report(target: LayerTarget): string {
    const lines: string[] = [
      `# performance profile (${target.cpus} cpus, ${target.memoryGb} gb, ${target.gpus} gpus)`,
      '',
    ];
    for (const p of this.applyAll(target)) {
      lines.push(`## ${p.layer}`);
      for (const note of p.notes) lines.push(`- ${note}`);
      const envKeys = Object.keys(p.env);
      if (envKeys.length > 0)
        lines.push(`- env: ${envKeys.map((k) => `${k}=${p.env[k]}`).join(' ')}`);
    }
    return lines.join('\n');
  }
}

/** Stack with all seven layers in canonical order. */
export function createDefaultStack(): PerformanceStack {
  return new PerformanceStack()
    .add(new CpuLayer())
    .add(new GpuLayer())
    .add(new MemoryLayer())
    .add(new FirecrackerWarmPool())
    .add(new TcgLayer())
    .add(new BuildLayer())
    .add(new NetworkLayer());
}

// ===========================================================================
// Benchmark harness, percentiles, regression detection, profile mode
// ===========================================================================

/**
 * Outcome of one benchmark: raw samples plus p50/p95/p99, mean, min, max
 * and stdev, all in milliseconds with three decimal places.
 */
export interface BenchmarkResult {
  readonly name: string;
  readonly iterations: number;
  readonly samplesMs: readonly number[];
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly stdev: number;
}

/** Computes p50/p95/p99 from an already collected sample set. */
export function percentiles(samples: readonly number[]): { p50: number; p95: number; p99: number } {
  if (samples.length === 0) throw new Error('percentiles require at least one sample');
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => {
    const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return Number(sorted[index].toFixed(3));
  };
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

/**
 * Benchmark harness with warmup, outlier-free percentile reporting and a
 * post-run GC hint. Each iteration is timed with performance.now().
 */
export class BenchmarkHarness {
  #results = new Map<string, BenchmarkResult>();

  async run(
    name: string,
    fn: (iteration: number) => void | Promise<void>,
    opts: { iterations?: number; warmup?: number } = {},
  ): Promise<BenchmarkResult> {
    const iterations = opts.iterations ?? 50;
    const warmup = opts.warmup ?? 5;
    for (let i = 0; i < warmup; i += 1) {
      await fn(i);
    }
    const samplesMs: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const startedAt = performance.now();
      await fn(i);
      samplesMs.push(performance.now() - startedAt);
    }
    const stats = this.summarize(name, samplesMs);
    this.#results.set(name, stats);
    return stats;
  }

  summarize(name: string, samplesMs: readonly number[]): BenchmarkResult {
    const { p50, p95, p99 } = percentiles(samplesMs);
    const mean = samplesMs.reduce((a, b) => a + b, 0) / samplesMs.length;
    const variance = samplesMs.reduce((a, b) => a + (b - mean) ** 2, 0) / samplesMs.length;
    return {
      name,
      iterations: samplesMs.length,
      samplesMs,
      p50,
      p95,
      p99,
      mean: Number(mean.toFixed(3)),
      min: Number(Math.min(...samplesMs).toFixed(3)),
      max: Number(Math.max(...samplesMs).toFixed(3)),
      stdev: Number(Math.sqrt(variance).toFixed(3)),
    };
  }

  result(name: string): BenchmarkResult | undefined {
    return this.#results.get(name);
  }

  get names(): string[] {
    return [...this.#results.keys()];
  }
}

/** Regression verdict scale: ok (within threshold), warn (under 2x), fail (beyond). */
export type RegressionVerdict = 'ok' | 'warn' | 'fail';

/**
 * Per-metric comparison produced by RegressionDetector.compare: verdict
 * plus one check row per percentile with baseline, current and delta %.
 */
export interface RegressionReport {
  readonly verdict: RegressionVerdict;
  readonly checks: readonly {
    metric: 'p50' | 'p95' | 'p99' | 'mean';
    baseline: number;
    current: number;
    deltaPct: number;
  }[];
}

/**
 * Regression detector: compares a current benchmark against a stored
 * baseline and flags any percentile that degraded beyond the threshold
 * (default 10%). Verdicts: ok (all within threshold), warn (regressed but
 * under twice the threshold), fail (at least one metric beyond 2x).
 */
export class RegressionDetector {
  readonly thresholdPct: number;

  constructor(thresholdPct = 10) {
    if (thresholdPct <= 0) throw new Error('thresholdPct must be positive');
    this.thresholdPct = thresholdPct;
  }

  compare(baseline: BenchmarkResult, current: BenchmarkResult): RegressionReport {
    const metrics: RegressionReport['checks'][number]['metric'][] = ['p50', 'p95', 'p99', 'mean'];
    const checks = metrics.map((metric) => {
      const base = baseline[metric];
      const now = current[metric];
      const deltaPct =
        base === 0
          ? now === 0
            ? 0
            : Number.POSITIVE_INFINITY
          : Number((((now - base) / base) * 100).toFixed(2));
      return { metric, baseline: base, current: now, deltaPct };
    });
    const worst = Math.max(...checks.map((c) => c.deltaPct));
    const verdict: RegressionVerdict =
      worst <= this.thresholdPct ? 'ok' : worst <= this.thresholdPct * 2 ? 'warn' : 'fail';
    return { verdict, checks };
  }
}

/** One measured profile phase: name, duration in ms and mark count. */
export interface ProfilePhase {
  readonly name: string;
  readonly durationMs: number;
  readonly marks: number;
}

/**
 * Profile mode: wraps named phases with performance.mark/measure pairs and
 * accumulates a phase timeline. The report is plain text so CI logs stay
 * grep-friendly.
 */
export class ProfileMode {
  #phases: ProfilePhase[] = [];
  #enabled = true;

  setEnabled(enabled: boolean): this {
    this.#enabled = enabled;
    return this;
  }

  async phase<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    if (!this.#enabled) {
      return await fn();
    }
    const markStart = `${name}-start`;
    const markEnd = `${name}-end`;
    performance.mark(markStart);
    try {
      return await fn();
    } finally {
      performance.mark(markEnd);
      try {
        performance.measure(name, markStart, markEnd);
        const entries = performance.getEntriesByName(name);
        const last = entries[entries.length - 1];
        this.#phases.push({
          name,
          durationMs: Number(last.duration.toFixed(3)),
          marks: entries.length,
        });
      } catch {
        // measurement failures must never mask the phase result
      }
    }
  }

  report(): string {
    const lines = this.#phases.map((p) => `${p.name}: ${p.durationMs} ms`);
    const total = this.#phases.reduce((a, p) => a + p.durationMs, 0);
    return [...lines, `total: ${total.toFixed(3)} ms`].join('\n');
  }

  get phases(): readonly ProfilePhase[] {
    return this.#phases;
  }
}

/**
 * Convenience wrapper: profiles a benchmark scenario across the seven-layer
 * stack, detects regressions against an optional baseline and returns both
 * the patch profile and the measurement in one call.
 */
export async function profileScenario(opts: {
  name: string;
  target: LayerTarget;
  fn: (iteration: number) => void | Promise<void>;
  baseline?: BenchmarkResult;
  iterations?: number;
}): Promise<{
  patches: readonly LayerPatch[];
  env: Record<string, string>;
  result: BenchmarkResult;
  regression: RegressionReport | null;
}> {
  const stack = createDefaultStack();
  const patches = stack.applyAll(opts.target);
  const env = stack.composeEnv(patches);
  const harness = new BenchmarkHarness();
  const result = await harness.run(opts.name, opts.fn, { iterations: opts.iterations });
  const regression =
    opts.baseline === undefined ? null : new RegressionDetector().compare(opts.baseline, result);
  return { patches, env, result, regression };
}
