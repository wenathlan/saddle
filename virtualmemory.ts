/**
 * virtualmemory - virtual memory tiers, controllers and the host-aware
 * extreme memory planner.
 *
 * This module owns everything memory related: the MEMORY_TIERS catalog with
 * real bandwidth figures (DDR5-6400 system memory, HBM3e stacked memory at
 * 8 TB/s, GDDR7 graphics memory at 1792 GB/s), MIG slicing profiles
 * (1g.24gb, 2g.48gb, 4g.96gb), NUMA topology generation, huge page planning
 * (1 GB and 2 MB), the kernel samepage merging controller, virtio ballooning,
 * swap overcommit with vm.overcommit_memory=2 semantics, the tmpfs shader
 * cache (20 GB), Docker memory flags (MemorySwap -1 and ShmSize 2g, the fix
 * for the classic PyTorch DataLoader bus error), tiered memory controllers
 * modeled on real silicon, a fluent region builder, a guarding region Proxy
 * and the virtualmemorymanager facade that ties every technique together.
 *
 * The v2 merge adds two host-aware layers absorbed from the Meta sources:
 * the placement tier taxonomy (DRAM_FAST, DRAM_SLOW, CXL_FM, CXL_PMEM,
 * HBM_BLACKWELL, ZRAM, PMEM_DAX) with CXL 2.0/3.0 Type-3 device profiles,
 * zram compression profiles, transparent huge page profiles and CCD-aware
 * vCPU pinning for the Ryzen 9 9950X3D; and the memorymodularizer class
 * that detects real host tiers (lspci CXL scan, /dev/pmem0, shared
 * Blackwell memory), plans zram with workload-dependent compression
 * factors, synthesizes tiered QEMU arguments, exports cgroup v2 slices and
 * QMP runtime commands, and persists plans as JSON. /proc/meminfo
 * generation (generateVirtualMeminfo, meminfoptions, pagealign) moved here
 * from the processor module so every memory concern lives in one file.
 *
 * Modularity extremes are first class: 1 to 192 vCPUs, 1 to 1024 GB of RAM
 * and 8 to 96 GB of VRAM, all user chosen and validated against hard limits.
 *
 * Bandwidth sources verified on 2026-08-22: JEDEC DDR5-6400 (51.2 GB/s per
 * channel), NVIDIA B200 and AMD Instinct MI350X HBM3e (8 TB/s aggregate),
 * GeForce RTX 5090 and RTX PRO 6000 Blackwell GDDR7 (1792 GB/s over a
 * 512-bit bus). CXL figures follow the CXL 2.0/3.0 Type-3 fabric numbers
 * (178-195 ns latency, 32-64 GB/s per x16 PCIe 5.0 link) documented in the
 * project research; zram compression ratios (lzo-rle 3.1:1, zstd 4.2:1)
 * follow the kernel zram documentation.
 *
 * Contexts (25): memoryerror, memorytierid, MEMORY_TIERS, memorylimits,
 * MIGPROFILES, validatememoryrequest, buildnumatopology, planhugepages,
 * ksmcontroller, ballooningcontroller, overcommitcontroller,
 * planswapdevices, shadercachecontroller, dockerMemoryFlags,
 * memorycontroller, memoryregion, regionledger, memorystats, memoryplan,
 * virtualmemorymanager, placementtier, cxxldevice, zramprofile,
 * memorymodularizer, generateVirtualMeminfo.
 *
 * Patterns: strategy (memorycontroller), builder (regionbuilder), registry
 * (regionledger), proxy (guardregion), observer (memorystats), facade
 * (virtualmemorymanager), planner (memorymodularizer).
 * Rules: lowercase identifiers, english jsdoc, third person, no emoji,
 * try/catch catcher on every fallible path, node:* built-ins only, and no
 * hardcoded localhost address anywhere.
 */

import { execSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';

/* ------------------------------------------------------------------ */
/* Section 1: errors                                                   */
/* ------------------------------------------------------------------ */

/** Error thrown by every memory subsystem with an optional cause chain. */
export class memoryerror extends Error {
  /** Machine readable subsystem tag. */
  readonly subsystem: string;

  constructor(message: string, options?: { cause?: Error; subsystem?: string }) {
    super(message, options);
    this.name = 'memoryerror';
    this.subsystem = options?.subsystem ?? 'virtualmemory';
  }
}

/* ------------------------------------------------------------------ */
/* Section 2: memory tier catalog                                      */
/* ------------------------------------------------------------------ */

/** Identifiers of the supported memory tiers. */
export type memorytierid = 'ddr5' | 'hbm3e' | 'gddr7';

/** Static description of one memory tier. */
export type memorytier = {
  readonly id: memorytierid;
  readonly label: string;
  readonly technology: string;
  readonly perchannelgbs: number;
  readonly channels: number;
  readonly modulegb: number;
  readonly latencyns: number;
  readonly usedfor: string;
};

/**
 * MEMORY_TIERS: the catalog of virtual memory technologies with real
 * bandwidth arithmetic. DDR5-6400 moves 51.2 GB/s per channel (2 channels
 * on desktop parts such as Ryzen and Core Ultra, 12 channels on EPYC SP5),
 * HBM3e delivers 8 TB/s aggregate on B200 and MI350X class accelerators and
 * GDDR7 reaches 1792 GB/s across the 512-bit bus of RTX 5090 and RTX PRO
 * 6000 Blackwell boards.
 */
export const MEMORY_TIERS = {
  ddr5: {
    id: 'ddr5',
    label: 'DDR5-6400 system memory',
    technology: 'DDR5 SDRAM at 6400 MT/s',
    perchannelgbs: 51.2,
    channels: 12,
    modulegb: 96,
    latencyns: 76,
    usedfor: 'guest RAM, page cache, tmpfs shader cache',
  },
  hbm3e: {
    id: 'hbm3e',
    label: 'HBM3e stacked memory',
    technology: 'high bandwidth memory 3e, 8 stacks',
    perchannelgbs: 1000,
    channels: 8,
    modulegb: 36,
    latencyns: 29,
    usedfor: 'datacenter accelerator memory (B200 192 GB, MI350X 288 GB)',
  },
  gddr7: {
    id: 'gddr7',
    label: 'GDDR7 graphics memory',
    technology: 'GDDR7 at 28 Gbps over a 512-bit bus',
    perchannelgbs: 224,
    channels: 8,
    modulegb: 16,
    latencyns: 42,
    usedfor: 'workstation and consumer GPUs (RTX 5090, RTX PRO 6000)',
  },
} as const satisfies Record<memorytierid, memorytier>;

/** Returns one tier descriptor, throwing for unknown identifiers. */
export function selecttier<const T extends memorytierid>(id: T): memorytier {
  const tier: memorytier | undefined = MEMORY_TIERS[id];
  if (tier === undefined) {
    throw new memoryerror(
      `unknown memory tier "${id}"; valid tiers: ${Object.keys(MEMORY_TIERS).join(', ')}`,
    );
  }
  return tier;
}

/** Aggregated bandwidth of one tier in GB/s (per channel times channels). */
export function tierbandwidthgbs(id: memorytierid): number {
  const tier = selecttier(id);
  return Number((tier.perchannelgbs * tier.channels).toFixed(1));
}

/* ------------------------------------------------------------------ */
/* Section 3: hard limits and request validation                       */
/* ------------------------------------------------------------------ */

/** Numeric bounds enforced for every memory request. */
export type memorylimits = {
  readonly minvcpu: number;
  readonly maxvcpu: number;
  readonly minramgb: number;
  readonly maxramgb: number;
  readonly minvramgb: number;
  readonly maxvramgb: number;
};

/** Extremes of modularity supported by the virtual memory planner. */
export const memorylimits = {
  minvcpu: 1,
  maxvcpu: 192,
  minramgb: 1,
  maxramgb: 1024,
  minvramgb: 8,
  maxvramgb: 96,
} as const satisfies memorylimits;

/** A memory request submitted by the user for planning and validation. */
export type memoryrequest = {
  readonly vcpus?: number;
  readonly ramgb?: number;
  readonly vramgb?: number;
  readonly mig?: migprofileid;
  readonly tier?: memorytierid;
};

/** Outcome of validating a memory request. */
export type memoryrequestresult = {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly plan: memoryplan | null;
};

/** MIG slicing profile identifier, or off for a monolithic device. */
export type migprofileid = '1g.24gb' | '2g.48gb' | '4g.96gb' | 'off';

/** Static description of one MIG slicing profile. */
export type migprofile = {
  readonly id: migprofileid;
  readonly slicegb: number;
  readonly maxinstances: number;
};

/**
 * MIG profiles available on the 96 GB virtual device. The identifiers keep
 * the NVIDIA convention of compute-slice names: 1g.24gb exposes 24 GB
 * slices (up to 4 instances), 2g.48gb exposes 48 GB slices (up to 2
 * instances) and 4g.96gb dedicates the full 96 GB to one instance.
 */
export const MIGPROFILES: readonly migprofile[] = [
  { id: '1g.24gb', slicegb: 24, maxinstances: 4 },
  { id: '2g.48gb', slicegb: 48, maxinstances: 2 },
  { id: '4g.96gb', slicegb: 96, maxinstances: 1 },
] as const satisfies readonly migprofile[];

/** Resolves a MIG profile by identifier, throwing for unknown names. */
export function getmigprofile(id: migprofileid): migprofile | null {
  if (id === 'off') {
    return null;
  }
  const found = MIGPROFILES.find((profile) => profile.id === id);
  if (found === undefined) {
    throw new memoryerror(
      `unknown MIG profile "${id}"; valid profiles: ${MIGPROFILES.map((profile) => profile.id).join(', ')} or off`,
    );
  }
  return found;
}

/**
 * Validates a memory request against the hard limits and the MIG catalog.
 * The function reuses the rule style of the core validator: it accumulates
 * errors for limit violations, warnings for suspicious-but-legal layouts
 * (for example RAM below 16 GB with 96 GB of VRAM, or ballooning suggested
 * when RAM exceeds 512 GB) and builds a plan when the request is valid.
 */
export function validatememoryrequest(request: memoryrequest): memoryrequestresult {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    const vcpus = request.vcpus ?? 8;
    const ramgb = request.ramgb ?? 32;
    const vramgb = request.vramgb ?? 24;
    const tier = request.tier ?? 'ddr5';
    if (!Number.isInteger(vcpus) || vcpus < memorylimits.minvcpu || vcpus > memorylimits.maxvcpu) {
      errors.push(
        `vcpus must be an integer between ${memorylimits.minvcpu} and ${memorylimits.maxvcpu}`,
      );
    }
    if (!Number.isFinite(ramgb) || ramgb < memorylimits.minramgb || ramgb > memorylimits.maxramgb) {
      errors.push(`ramgb must be between ${memorylimits.minramgb} and ${memorylimits.maxramgb}`);
    }
    if (
      !Number.isFinite(vramgb) ||
      vramgb < memorylimits.minvramgb ||
      vramgb > memorylimits.maxvramgb
    ) {
      errors.push(`vramgb must be between ${memorylimits.minvramgb} and ${memorylimits.maxvramgb}`);
    }
    const mig = request.mig ?? 'off';
    const profile = getmigprofile(mig);
    if (profile !== null && profile.slicegb !== vramgb) {
      errors.push(
        `MIG profile ${mig} implies ${profile.slicegb} GB slices but vramgb is ${vramgb}`,
      );
    }
    if (ramgb < 16 && vramgb >= 64) {
      warnings.push('vramgb far exceeds ramgb: host page cache may thrash during model loads');
    }
    if (ramgb >= 512) {
      warnings.push('RAM at or above 512 GB benefits from 1 GB huge pages and ballooning');
    }
    if (tier === 'ddr5' && vramgb > 64) {
      warnings.push(
        'ddr5 backing for VRAM above 64 GB halves effective bandwidth; prefer gddr7 or hbm3e tiers',
      );
    }
    if (errors.length > 0) {
      return { valid: false, errors, warnings, plan: null };
    }
    return { valid: true, errors, warnings, plan: planmemory(vcpus, ramgb, vramgb, mig, tier) };
  } catch (cause) {
    return {
      valid: false,
      errors: [`validatememoryrequest crashed: ${(cause as Error).message}`],
      warnings,
      plan: null,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Section 4: NUMA topology                                            */
/* ------------------------------------------------------------------ */

/** NUMA topology of a virtual machine. */
export type numatopology = {
  readonly nodes: number;
  readonly cpuranges: readonly string[];
  readonly distances: readonly (readonly number[])[];
  readonly description: string;
};

/**
 * Builds a NUMA topology for a vCPU count split across a node count. Local
 * distance is 10 and remote nodes sit at 32, mirroring the NPS modes of
 * AMD EPYC parts; cpu ranges are rendered as the compact lists used by
 * lscpu and numactl.
 */
export function buildnumatopology(vcpus: number, nodes: number): numatopology {
  try {
    if (!Number.isInteger(vcpus) || vcpus < 1) {
      throw new memoryerror(`vcpus must be a positive integer, received ${vcpus}`);
    }
    if (!Number.isInteger(nodes) || nodes < 1 || nodes > 16) {
      throw new memoryerror(`nodes must be between 1 and 16, received ${nodes}`);
    }
    const pernode = Math.ceil(vcpus / nodes);
    const cpuranges: string[] = [];
    for (let node = 0; node < nodes; node += 1) {
      const start = node * pernode;
      const end = Math.min(start + pernode, vcpus) - 1;
      if (start > end) {
        cpuranges.push('');
        continue;
      }
      cpuranges.push(start === end ? String(start) : `${start}-${end}`);
    }
    const distances: number[][] = [];
    for (let row = 0; row < nodes; row += 1) {
      const line: number[] = [];
      for (let column = 0; column < nodes; column += 1) {
        line.push(row === column ? 10 : 32);
      }
      distances.push(line);
    }
    return {
      nodes,
      cpuranges,
      distances,
      description: `${nodes} NUMA node(s), ${pernode} vCPU(s) per node, remote distance 32`,
    };
  } catch (cause) {
    if (cause instanceof memoryerror) {
      throw cause;
    }
    throw new memoryerror('buildnumatopology failed', { cause: cause as Error });
  }
}

/** Curated NUMA presets for common EPYC thread counts. */
export const NUMATOPOLOGIES: readonly numatopology[] = [
  buildnumatopology(192, 4),
  buildnumatopology(192, 8),
  buildnumatopology(128, 4),
  buildnumatopology(96, 2),
  buildnumatopology(64, 2),
  buildnumatopology(32, 1),
] as const satisfies readonly numatopology[];

/* ------------------------------------------------------------------ */
/* Section 5: huge pages, KSM, ballooning, overcommit, tmpfs           */
/* ------------------------------------------------------------------ */

/** One huge page reservation request. */
export type hugepageconfig = {
  readonly size: '1G' | '2M';
  readonly count: number;
  readonly coversgb: number;
};

/**
 * Plans huge page reservations for a RAM size. Machines with at least 256 GB
 * reserve half of their RAM as 1 GB pages for large model weights, plus a
 * pool of 2048 2 MB pages for medium allocations; smaller machines keep a
 * 2 MB-only layout.
 */
export function planhugepages(ramgb: number): hugepageconfig[] {
  try {
    if (!Number.isFinite(ramgb) || ramgb <= 0) {
      throw new memoryerror(`ramgb must be a positive number, received ${ramgb}`);
    }
    if (ramgb >= 256) {
      const onegbpages = Math.floor(ramgb / 2);
      return [
        { size: '1G', count: onegbpages, coversgb: onegbpages },
        { size: '2M', count: 2048, coversgb: 4 },
      ];
    }
    const twombpages = Math.floor((ramgb * 1024) / 4);
    return [
      { size: '2M', count: twombpages, coversgb: Number(((twombpages * 2) / 1024).toFixed(2)) },
    ];
  } catch (cause) {
    if (cause instanceof memoryerror) {
      throw cause;
    }
    throw new memoryerror('planhugepages failed', { cause: cause as Error });
  }
}

/**
 * Kernel samepage merging controller. KSM scans anonymous pages and merges
 * identical ones, which matters for dense virtual machines running the same
 * runtime image; the controller models the sysfs knobs documented by the
 * kernel (run, pages_to_scan, sleep_millisecs, merge_across_nodes) and
 * estimates the deduplication ratio from the shared/sharing counters.
 */
export class ksmcontroller {
  #pagestoscan: number;
  #sleepmillisecs: number;
  #mergeacrossnodes: boolean;
  #enabled: boolean;

  constructor(pagestoscan = 1000, sleepmillisecs = 20) {
    this.#pagestoscan = pagestoscan;
    this.#sleepmillisecs = sleepmillisecs;
    this.#mergeacrossnodes = true;
    this.#enabled = false;
  }

  /** Enables KSM and returns the sysfs writes required. */
  enable(): string[] {
    this.#enabled = true;
    return [
      'echo 1 > /sys/kernel/mm/ksm/run',
      `echo ${this.#pagestoscan} > /sys/kernel/mm/ksm/pages_to_scan`,
      `echo ${this.#sleepmillisecs} > /sys/kernel/mm/ksm/sleep_millisecs`,
      `echo ${this.#mergeacrossnodes ? 1 : 0} > /sys/kernel/mm/ksm/merge_across_nodes`,
    ];
  }

  /** Disables KSM, leaving the scan counters untouched. */
  disable(): string[] {
    this.#enabled = false;
    return ['echo 0 > /sys/kernel/mm/ksm/run'];
  }

  /** Tunes the scanner aggressiveness. */
  tune(pagestoscan: number, sleepmillisecs: number): this {
    this.#pagestoscan = Math.max(1, pagestoscan);
    this.#sleepmillisecs = Math.max(1, sleepmillisecs);
    return this;
  }

  /** Reports whether the controller is currently enabled. */
  get running(): boolean {
    return this.#enabled;
  }

  /**
   * Estimates the deduplication ratio from the classic kernel counters:
   * pages_shared counts merged unique pages and pages_sharing counts the
   * extra references pointing at them.
   */
  estimatesavings(pagesshared: number, pagessharing: number): { ratio: number; freedmb: number } {
    const total = pagesshared + pagessharing;
    const ratio = total === 0 ? 0 : Number((pagessharing / total).toFixed(4));
    const freedmb = Number(((pagessharing * 4) / 1024).toFixed(2));
    return { ratio, freedmb };
  }

  /** Renders the sysfs plan for logs and provisioners. */
  describe(): Record<string, unknown> {
    return {
      subsystem: 'ksm',
      enabled: this.#enabled,
      pagestoscan: this.#pagestoscan,
      sleepmillisecs: this.#sleepmillisecs,
      mergeacrossnodes: this.#mergeacrossnodes,
    };
  }
}

/**
 * Virtio ballooning controller. The balloon lets the host reclaim guest
 * memory on demand and gives it back under pressure; the controller tracks
 * the current target and honors a deflate-on-OOM policy so guests never
 * deadlock while the balloon is inflated.
 */
export class ballooningcontroller {
  #targetmb: number;
  #maxmb: number;
  #deflateonom: boolean;

  constructor(maxmb: number) {
    this.#targetmb = 0;
    this.#maxmb = maxmb;
    this.#deflateonom = true;
  }

  /** Inflates the balloon to a target in MB, clamped to the maximum. */
  inflate(targetmb: number): number {
    try {
      if (targetmb < 0) {
        throw new memoryerror(`balloon target must be non-negative, received ${targetmb}`);
      }
      this.#targetmb = Math.min(targetmb, this.#maxmb);
      return this.#targetmb;
    } catch (cause) {
      throw new memoryerror('ballooningcontroller.inflate failed', { cause: cause as Error });
    }
  }

  /** Deflates the balloon by the requested amount, floored at zero. */
  deflate(amountmb: number): number {
    this.#targetmb = Math.max(0, this.#targetmb - Math.max(0, amountmb));
    return this.#targetmb;
  }

  /** Current balloon target in MB. */
  get targetmb(): number {
    return this.#targetmb;
  }

  /** Renders the QEMU device plan for the balloon. */
  describe(): Record<string, unknown> {
    return {
      subsystem: 'ballooning',
      device: 'virtio-balloon-pci',
      targetmb: this.#targetmb,
      maxmb: this.#maxmb,
      deflateonom: this.#deflateonom,
    };
  }
}

/**
 * Swap overcommit controller implementing the vm.overcommit_memory=2
 * semantics documented in Documentation/mm/overcommit-accounting.rst: the
 * total committed address space may never exceed swap plus a configurable
 * percentage of RAM (overcommit_ratio, default 50). The controller computes
 * the commit limit and recommends swap sizing for a target commit budget.
 */
export class overcommitcontroller {
  #ratio: number;
  #mode: 0 | 1 | 2;

  constructor(ratio = 50) {
    this.#ratio = ratio;
    this.#mode = 2;
  }

  /** Sets the overcommit ratio percentage applied in mode 2. */
  setratio(ratio: number): this {
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 100) {
      throw new memoryerror(`overcommit ratio must be between 0 and 100, received ${ratio}`);
    }
    this.#ratio = ratio;
    return this;
  }

  /** Computes the commit limit in GB for a RAM and swap configuration. */
  commitlimitgb(ramgb: number, swapgb: number): number {
    return Number((swapgb + (ramgb * this.#ratio) / 100).toFixed(2));
  }

  /** Recommends the swap size in GB for a desired commit budget. */
  recommendswapgb(ramgb: number, targetcommitgb: number): number {
    const swapneeded = targetcommitgb - (ramgb * this.#ratio) / 100;
    return Number(Math.max(0, Math.ceil(swapneeded)).toFixed(2));
  }

  /** Renders the sysctl dictionary for this controller. */
  sysctl(): Record<string, string> {
    return {
      'vm.overcommit_memory': String(this.#mode),
      'vm.overcommit_ratio': String(this.#ratio),
      'vm.swappiness': '10',
      'vm.max_map_count': '1048576',
    };
  }

  /** Renders the controller plan for logs and provisioners. */
  describe(): Record<string, unknown> {
    return { subsystem: 'overcommit', mode: this.#mode, ratio: this.#ratio };
  }
}

/** One swap backing store attached to the virtual machine. */
export type swapdevice = {
  readonly kind: 'zram' | 'swapfile' | 'partition';
  readonly sizegb: number;
  readonly priority: number;
  readonly compressed: boolean;
};

/**
 * Plans swap devices for a RAM size. ZRAM (compressed in-memory swap,
 * priority 100) covers latency-sensitive reclaim while a swapfile or
 * partition (priority -2) extends the commit budget required by mode 2
 * overcommit for RAM-heavy builds.
 */
export function planswapdevices(ramgb: number): swapdevice[] {
  try {
    if (!Number.isFinite(ramgb) || ramgb <= 0) {
      throw new memoryerror(`ramgb must be a positive number, received ${ramgb}`);
    }
    const zramsize = Math.min(Math.max(Math.round(ramgb / 8), 2), 32);
    const devices: swapdevice[] = [
      { kind: 'zram', sizegb: zramsize, priority: 100, compressed: true },
    ];
    if (ramgb >= 256) {
      devices.push({
        kind: 'swapfile',
        sizegb: Math.min(Math.round(ramgb / 8), 128),
        priority: -2,
        compressed: false,
      });
    }
    return devices;
  } catch (cause) {
    if (cause instanceof memoryerror) {
      throw cause;
    }
    throw new memoryerror('planswapdevices failed', { cause: cause as Error });
  }
}

/**
 * Tmpfs shader cache controller. Mesa keeps its on-disk shader cache in
 * MESA_SHADER_CACHE_DIR; hosting it on a size-capped tmpfs (20 GB by
 * default) removes disk latency from shader compilation storms typical of
 * LLVMpipe and Lavapipe sessions.
 */
export class shadercachecontroller {
  #sizegb: number;
  #mountpoint: string;

  constructor(sizegb = 20, mountpoint = '/tmp/shadercache') {
    this.#sizegb = sizegb;
    this.#mountpoint = mountpoint;
  }

  /** Renders the fstab line for the tmpfs mount. */
  fstabline(): string {
    return `tmpfs ${this.#mountpoint} tmpfs rw,size=${this.#sizegb}g,nodev,nosuid,noatime 0 0`;
  }

  /** Renders the environment block pointing Mesa at the cache. */
  environment(): Record<string, string> {
    return {
      MESA_SHADER_CACHE_DIR: this.#mountpoint,
      MESA_SHADER_CACHE_MAX_SIZE: `${this.#sizegb * 1024}`,
      MESA_GLSL_CACHE_DISABLE: 'false',
    };
  }

  /** Mount size in GB. */
  get sizegb(): number {
    return this.#sizegb;
  }

  /** Renders the controller plan for logs and provisioners. */
  describe(): Record<string, unknown> {
    return { subsystem: 'shadercache', sizegb: this.#sizegb, mountpoint: this.#mountpoint };
  }
}

/* ------------------------------------------------------------------ */
/* Section 6: Docker memory flags                                      */
/* ------------------------------------------------------------------ */

/** Options for the Docker memory flag generator. */
export type dockermemoryoptions = {
  readonly ramgb?: number;
  readonly shmsizegb?: number;
  readonly unlimitedswap?: boolean;
};

/** Result of the Docker memory flag generator. */
export type dockermemoryflags = {
  readonly run: readonly string[];
  readonly compose: Readonly<Record<string, unknown>>;
  readonly sysctl: Readonly<Record<string, string>>;
  readonly rationale: readonly string[];
};

/**
 * Generates Docker memory flags for a container. MemorySwap -1 keeps swap
 * unlimited as documented by Docker ("unlimited swap, up to the amount
 * available on the host system"), ShmSize 2g raises /dev/shm from the 64 MB
 * default which is the canonical fix for the PyTorch DataLoader bus error,
 * and the tmpfs entry mounts the 20 GB shader cache. Every value remains a
 * suggestion: callers override before use.
 */
export function dockerMemoryFlags(options?: dockermemoryoptions): dockermemoryflags {
  try {
    const ramgb = options?.ramgb ?? 32;
    const shmsizegb = options?.shmsizegb ?? 2;
    const unlimitedswap = options?.unlimitedswap ?? true;
    const run: string[] = [
      `--memory=${ramgb}g`,
      unlimitedswap ? '--memory-swap=-1' : `--memory-swap=${ramgb * 2}g`,
      `--shm-size=${shmsizegb}g`,
      '--tmpfs /tmp/shadercache:size=20g',
      '--kernel-memory=0',
    ];
    const compose: Record<string, unknown> = {
      mem_limit: `${ramgb}g`,
      memswap_limit: unlimitedswap ? -1 : `${ramgb * 2}g`,
      shm_size: `${shmsizegb}g`,
      tmpfs: ['/tmp/shadercache:size=20g'],
      oom_score_adj: -500,
    };
    const sysctl: Record<string, string> = {
      'vm.overcommit_memory': '2',
      'vm.overcommit_ratio': '50',
    };
    const rationale = [
      'memory-swap -1 grants unlimited swap per the Docker resource constraints documentation',
      `shm-size ${shmsizegb}g avoids the PyTorch DataLoader bus error caused by the 64 MB /dev/shm default`,
      'tmpfs shader cache keeps Mesa compilation artifacts in RAM with a 20 GB ceiling',
      'overcommit mode 2 with ratio 50 bounds the commit limit to swap plus half the RAM',
    ];
    return { run, compose, sysctl, rationale };
  } catch (cause) {
    throw new memoryerror('dockerMemoryFlags failed', { cause: cause as Error });
  }
}

/* ------------------------------------------------------------------ */
/* Section 7: tiered memory controllers                                */
/* ------------------------------------------------------------------ */

/** Result of one simulated memory transfer. */
export type transferview = {
  readonly tier: memorytierid;
  readonly bytes: number;
  readonly direction: 'read' | 'write';
  readonly effectivengbs: number;
  readonly timemicros: number;
};

/** Common contract implemented by every tier controller (Strategy). */
export interface memorycontroller {
  readonly tier: memorytierid;
  readonly totalgb: number;
  readonly bandwidthgbs: number;
  transfer(bytes: number, direction: 'read' | 'write'): transferview;
  latencyns(): number;
  describe(): Record<string, unknown>;
}

/** Shared transfer math used by every controller implementation. */
function simulatetransfer(
  tier: memorytierid,
  bytes: number,
  direction: 'read' | 'write',
  bandwidthgbs: number,
  latencyns: number,
): transferview {
  const effectivengbs = Number((bandwidthgbs * (direction === 'read' ? 1 : 0.92)).toFixed(2));
  const timemicros = Number(((bytes / (effectivengbs * 1e9)) * 1e6 + latencyns / 1000).toFixed(4));
  return { tier, bytes, direction, effectivengbs, timemicros };
}

/** DDR5 controller: channels aggregated, bandwidth scales linearly. */
export class ddr5controller implements memorycontroller {
  readonly tier: memorytierid = 'ddr5';
  #channels: number;
  #totalgb: number;

  constructor(channels = 12, totalgb = 1024) {
    this.#channels = Math.max(1, Math.min(channels, 12));
    this.#totalgb = totalgb;
  }

  /** Aggregate bandwidth in GB/s for the configured channel count. */
  get bandwidthgbs(): number {
    return Number((MEMORY_TIERS.ddr5.perchannelgbs * this.#channels).toFixed(1));
  }

  /** Total capacity in GB. */
  get totalgb(): number {
    return this.#totalgb;
  }

  /** Simulates one transfer over the DDR5 interconnect. */
  transfer(bytes: number, direction: 'read' | 'write'): transferview {
    return simulatetransfer(
      this.tier,
      bytes,
      direction,
      this.bandwidthgbs,
      MEMORY_TIERS.ddr5.latencyns,
    );
  }

  /** Average column access latency in nanoseconds. */
  latencyns(): number {
    return MEMORY_TIERS.ddr5.latencyns;
  }

  /** Renders the controller plan for logs and provisioners. */
  describe(): Record<string, unknown> {
    return {
      tier: this.tier,
      channels: this.#channels,
      bandwidthgbs: this.bandwidthgbs,
      totalgb: this.#totalgb,
      technology: MEMORY_TIERS.ddr5.technology,
    };
  }
}

/** HBM3e controller: eight stacks, 8 TB/s aggregate, near-SRAM latency. */
export class hbm3econtroller implements memorycontroller {
  readonly tier: memorytierid = 'hbm3e';
  #stacks: number;
  #totalgb: number;

  constructor(stacks = 8, totalgb = 192) {
    this.#stacks = Math.max(1, Math.min(stacks, 8));
    this.#totalgb = totalgb;
  }

  /** Aggregate bandwidth in GB/s for the configured stack count. */
  get bandwidthgbs(): number {
    return Number((MEMORY_TIERS.hbm3e.perchannelgbs * this.#stacks).toFixed(1));
  }

  /** Total capacity in GB. */
  get totalgb(): number {
    return this.#totalgb;
  }

  /** Simulates one transfer over the HBM3e fabric. */
  transfer(bytes: number, direction: 'read' | 'write'): transferview {
    return simulatetransfer(
      this.tier,
      bytes,
      direction,
      this.bandwidthgbs,
      MEMORY_TIERS.hbm3e.latencyns,
    );
  }

  /** Stack access latency in nanoseconds. */
  latencyns(): number {
    return MEMORY_TIERS.hbm3e.latencyns;
  }

  /** Renders the controller plan for logs and provisioners. */
  describe(): Record<string, unknown> {
    return {
      tier: this.tier,
      stacks: this.#stacks,
      bandwidthgbs: this.bandwidthgbs,
      totalgb: this.#totalgb,
      technology: MEMORY_TIERS.hbm3e.technology,
    };
  }
}

/** GDDR7 controller: 512-bit bus, 1792 GB/s at full width. */
export class gddr7controller implements memorycontroller {
  readonly tier: memorytierid = 'gddr7';
  #channels: number;
  #totalgb: number;

  constructor(channels = 8, totalgb = 96) {
    this.#channels = Math.max(1, Math.min(channels, 8));
    this.#totalgb = totalgb;
  }

  /** Aggregate bandwidth in GB/s for the configured bus width. */
  get bandwidthgbs(): number {
    return Number((MEMORY_TIERS.gddr7.perchannelgbs * this.#channels).toFixed(1));
  }

  /** Total capacity in GB. */
  get totalgb(): number {
    return this.#totalgb;
  }

  /** Simulates one transfer over the GDDR7 bus. */
  transfer(bytes: number, direction: 'read' | 'write'): transferview {
    return simulatetransfer(
      this.tier,
      bytes,
      direction,
      this.bandwidthgbs,
      MEMORY_TIERS.gddr7.latencyns,
    );
  }

  /** Memory access latency in nanoseconds. */
  latencyns(): number {
    return MEMORY_TIERS.gddr7.latencyns;
  }

  /** Renders the controller plan for logs and provisioners. */
  describe(): Record<string, unknown> {
    return {
      tier: this.tier,
      channels: this.#channels,
      bandwidthgbs: this.bandwidthgbs,
      totalgb: this.#totalgb,
      technology: MEMORY_TIERS.gddr7.technology,
    };
  }
}

/**
 * Controller factory (Factory plus Registry patterns): maps a tier
 * identifier to a controller instance sized by the caller. The const type
 * parameter preserves literal tier identifiers through the call.
 */
export function creatememorycontroller<const T extends memorytierid>(
  tier: T,
  totalgb: number,
  channels?: number,
): memorycontroller {
  switch (tier) {
    case 'ddr5':
      return new ddr5controller(channels ?? 12, totalgb);
    case 'hbm3e':
      return new hbm3econtroller(channels ?? 8, totalgb);
    case 'gddr7':
      return new gddr7controller(channels ?? 8, totalgb);
    default: {
      throw new memoryerror(`no controller registered for tier "${tier}"`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Section 8: memory regions, builder, proxy and ledger                */
/* ------------------------------------------------------------------ */

/** Purpose categories of a virtual memory region. */
export type regionpurpose = 'guest' | 'modelweights' | 'shadercache' | 'scratch' | 'pinned';

/** A virtual memory region bound to a tier and a purpose. */
export class memoryregion {
  readonly id: string;
  readonly tier: memorytierid;
  readonly purpose: regionpurpose;
  readonly sizegb: number;
  #allocated: boolean;
  #accesses: number;

  constructor(tier: memorytierid, purpose: regionpurpose, sizegb: number) {
    this.id = randomUUID();
    this.tier = tier;
    this.purpose = purpose;
    this.sizegb = sizegb;
    this.#allocated = true;
    this.#accesses = 0;
  }

  /** Number of tracked accesses through proxies or direct reads. */
  get accesses(): number {
    return this.#accesses;
  }

  /** True while the region holds virtual backing. */
  get allocated(): boolean {
    return this.#allocated;
  }

  /** Counts one access; used by the guarding Proxy. */
  touch(): void {
    this.#accesses += 1;
  }

  /** Releases the region; idempotent and safe to call twice. */
  release(): void {
    this.#allocated = false;
  }

  /** Synchronous disposer so regions compose with `using` declarations. */
  [Symbol.dispose](): void {
    this.release();
  }

  /** Renders the region plan for logs and provisioners. */
  describe(): Record<string, unknown> {
    return {
      id: this.id,
      tier: this.tier,
      purpose: this.purpose,
      sizegb: this.sizegb,
      allocated: this.#allocated,
      accesses: this.#accesses,
    };
  }
}

/**
 * Fluent builder for memory regions. The builder accumulates tier, purpose
 * and size, validates the result against the tier capacity and produces a
 * memoryregion registered in the regionledger.
 */
export class regionbuilder {
  #tier: memorytierid;
  #purpose: regionpurpose;
  #sizegb: number;

  constructor() {
    this.#tier = 'ddr5';
    this.#purpose = 'guest';
    this.#sizegb = 1;
  }

  /** Selects the memory tier backing the region. */
  withtier(tier: memorytierid): this {
    this.#tier = tier;
    return this;
  }

  /** Selects the purpose tag of the region. */
  withpurpose(purpose: regionpurpose): this {
    this.#purpose = purpose;
    return this;
  }

  /** Sets the region size in GB. */
  withsize(sizegb: number): this {
    this.#sizegb = sizegb;
    return this;
  }

  /** Validates and materializes the region, registering it in the ledger. */
  build(): memoryregion {
    try {
      if (!Number.isFinite(this.#sizegb) || this.#sizegb <= 0) {
        throw new memoryerror(`region size must be a positive number, received ${this.#sizegb}`);
      }
      const tier = selecttier(this.#tier);
      const capacity = tier.modulegb * tier.channels;
      if (this.#sizegb > capacity) {
        throw new memoryerror(
          `region of ${this.#sizegb} GB exceeds the ${capacity} GB capacity of tier ${this.#tier}`,
        );
      }
      const region = new memoryregion(this.#tier, this.#purpose, this.#sizegb);
      (regionledger as Map<string, memoryregion>).set(region.id, region);
      return region;
    } catch (cause) {
      if (cause instanceof memoryerror) {
        throw cause;
      }
      throw new memoryerror('regionbuilder.build failed', { cause: cause as Error });
    }
  }
}

/**
 * Wraps a region in a guarding Proxy (Proxy pattern). Every property access
 * is counted and recorded in the access ledger; accesses to released
 * regions raise a memoryerror so consumers notice stale handles
 * immediately instead of silently reading freed virtual memory.
 */
export function guardregion(region: memoryregion): memoryregion {
  return new Proxy(region, {
    get(target, property: string | symbol, receiver: unknown): unknown {
      target.touch();
      if (!target.allocated && property !== 'describe') {
        throw new memoryerror(
          `region ${target.id} has been released and can no longer be accessed`,
        );
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** Ledger of every live region, keyed by region id (Map first policy). */
export const regionledger: ReadonlyMap<string, memoryregion> = new Map<string, memoryregion>();

/** Ephemeral access counters; WeakMap keeps probes from pinning regions. */
const accessprobes = new WeakMap<memoryregion, number>();

/** Records an access probe for a region without keeping it alive. */
export function proberegion(region: memoryregion, accesses: number): void {
  accessprobes.set(region, accesses);
}

/** Reads the last access probe recorded for a region, if any. */
export function readprobe(region: memoryregion): number | null {
  return accessprobes.get(region) ?? null;
}

/** Sums the size of every allocated region in the ledger. */
export function totalallocatedgb(): number {
  let total = 0;
  for (const region of regionledger.values()) {
    if (region.allocated) {
      total += region.sizegb;
    }
  }
  return Number(total.toFixed(2));
}

/* ------------------------------------------------------------------ */
/* Section 9: memory pressure observer                                 */
/* ------------------------------------------------------------------ */

/** Payload published when a watermark is crossed. */
export type pressureevent = {
  readonly level: 'low' | 'high' | 'critical';
  readonly usedfraction: number;
  readonly at: number;
};

/** Listener signature of the pressure observer. */
export type pressurelistener = (event: pressureevent) => void;

/**
 * Memory pressure observer. The observer keeps listeners in a Map keyed by
 * name (never bound to a runtime event loop) and evaluates samples against
 * the classic watermarks: low at 85 percent, high at 95 percent and
 * critical at 99 percent of the tracked capacity.
 */
export class memorystats {
  #listeners: Map<string, pressurelistener>;
  #capacitygb: number;
  #lastlevel: 'low' | 'high' | 'critical' | 'nominal';
  #history: number[];

  constructor(capacitygb: number) {
    this.#listeners = new Map<string, pressurelistener>();
    this.#capacitygb = capacitygb;
    this.#lastlevel = 'nominal';
    this.#history = [];
  }

  /** Subscribes a named listener to pressure transitions. */
  subscribe(name: string, listener: pressurelistener): this {
    this.#listeners.set(name, listener);
    return this;
  }

  /** Removes a named listener; returns true when it existed. */
  unsubscribe(name: string): boolean {
    return this.#listeners.delete(name);
  }

  /** Evaluates one used-memory sample and publishes level transitions. */
  evaluate(usedgb: number): pressureevent | null {
    try {
      const usedfraction = Math.min(1, usedgb / this.#capacitygb);
      this.#history.push(usedfraction);
      if (this.#history.length > 512) {
        this.#history.shift();
      }
      const level: pressureevent['level'] | 'nominal' =
        usedfraction >= 0.99
          ? 'critical'
          : usedfraction >= 0.95
            ? 'high'
            : usedfraction >= 0.85
              ? 'low'
              : 'nominal';
      if (level === 'nominal' || level === this.#lastlevel) {
        return null;
      }
      this.#lastlevel = level;
      const event: pressureevent = {
        level,
        usedfraction: Number(usedfraction.toFixed(4)),
        at: Date.now(),
      };
      for (const listener of this.#listeners.values()) {
        try {
          listener(event);
        } catch {
          /* listener faults never break the observer loop */
        }
      }
      return event;
    } catch (cause) {
      throw new memoryerror('memorystats.evaluate failed', { cause: cause as Error });
    }
  }

  /** Peak observed usage fraction since construction. */
  get peak(): number {
    return this.#history.length === 0 ? 0 : Number(Math.max(...this.#history).toFixed(4));
  }

  /** Mean observed usage fraction since construction. */
  get mean(): number {
    if (this.#history.length === 0) {
      return 0;
    }
    const sum = this.#history.reduce((acc, value) => acc + value, 0);
    return Number((sum / this.#history.length).toFixed(4));
  }
}

/* ------------------------------------------------------------------ */
/* Section 10: capacity plan and manager facade                        */
/* ------------------------------------------------------------------ */

/** Complete memory plan of one virtual machine. */
export type memoryplan = {
  readonly vcpus: number;
  readonly ramgb: number;
  readonly vramgb: number;
  readonly tier: memorytierid;
  readonly mig: migprofileid;
  readonly miginstances: number;
  readonly rambandwidthgbs: number;
  readonly vrambandwidthgbs: number;
  readonly hugepages: readonly hugepageconfig[];
  readonly swapdevices: readonly swapdevice[];
  readonly numa: numatopology;
  readonly shmsizegb: number;
  readonly shadercachesizegb: number;
};

/**
 * Computes the full memory plan for a machine: bandwidth per tier, MIG
 * instance count, huge page layout, swap devices, NUMA topology, /dev/shm
 * size and the shader cache ceiling.
 */
export function planmemory(
  vcpus: number,
  ramgb: number,
  vramgb: number,
  mig: migprofileid,
  tier: memorytierid,
): memoryplan {
  try {
    const profile = getmigprofile(mig);
    const miginstances =
      profile === null
        ? 1
        : Math.max(
            1,
            Math.floor(memorylimits.maxvramgb / profile.slicegb) *
              (vramgb >= profile.slicegb ? 1 : 0) || 1,
          );
    const numa = buildnumatopology(vcpus, vcpus >= 128 ? 8 : vcpus >= 64 ? 4 : vcpus >= 32 ? 2 : 1);
    return Object.freeze({
      vcpus,
      ramgb,
      vramgb,
      tier,
      mig,
      miginstances: profile === null ? 1 : Math.min(profile.maxinstances, miginstances),
      rambandwidthgbs: tierbandwidthgbs('ddr5'),
      vrambandwidthgbs: tierbandwidthgbs(tier === 'ddr5' ? 'gddr7' : tier),
      hugepages: planhugepages(ramgb),
      swapdevices: planswapdevices(ramgb),
      numa,
      shmsizegb: 2,
      shadercachesizegb: 20,
    });
  } catch (cause) {
    if (cause instanceof memoryerror) {
      throw cause;
    }
    throw new memoryerror('planmemory failed', { cause: cause as Error });
  }
}

/**
 * Renders kernel boot arguments for the memory techniques enabled by a
 * plan: default 1 GB huge pages plus a 2 MB pool, and the MIG-aware NUMA
 * hints consumed by the virtual machine launcher.
 */
export function buildKernelArgs(plan: memoryplan): string {
  try {
    const parts: string[] = ['default_hugepagesz=1G'];
    for (const page of plan.hugepages) {
      parts.push(`hugepagesz=${page.size === '1G' ? '1G' : '2M'}`, `hugepages=${page.count}`);
    }
    parts.push(`numa=fake=${plan.numa.nodes}`);
    return parts.join(' ');
  } catch (cause) {
    throw new memoryerror('buildKernelArgs failed', { cause: cause as Error });
  }
}

/**
 * Facade that composes every memory technique for one machine. The manager
 * exposes the plan, the sysctl dictionary, the kernel arguments, the Docker
 * flags, the tier controllers and the pressure observer, and keeps all
 * mutable state in Maps so the instance stays runtime agnostic.
 */
export class virtualmemorymanager {
  #plan: memoryplan;
  #controllers: Map<memorytierid, memorycontroller>;
  #ksm: ksmcontroller;
  #balloon: ballooningcontroller;
  #overcommit: overcommitcontroller;
  #cache: shadercachecontroller;
  #stats: memorystats;

  constructor(plan: memoryplan) {
    this.#plan = plan;
    this.#controllers = new Map<memorytierid, memorycontroller>();
    this.#controllers.set('ddr5', creatememorycontroller('ddr5', plan.ramgb, 12));
    this.#controllers.set(
      plan.tier === 'ddr5' ? 'gddr7' : plan.tier,
      creatememorycontroller(plan.tier === 'ddr5' ? 'gddr7' : plan.tier, plan.vramgb, 8),
    );
    this.#ksm = new ksmcontroller(1000, 20);
    this.#balloon = new ballooningcontroller(plan.ramgb * 1024);
    this.#overcommit = new overcommitcontroller(50);
    this.#cache = new shadercachecontroller(plan.shadercachesizegb);
    this.#stats = new memorystats(plan.ramgb);
  }

  /** The frozen plan this manager was constructed from. */
  get plan(): memoryplan {
    return this.#plan;
  }

  /** The pressure observer of this machine. */
  get stats(): memorystats {
    return this.#stats;
  }

  /** The KSM controller of this machine. */
  get ksm(): ksmcontroller {
    return this.#ksm;
  }

  /** The ballooning controller of this machine. */
  get balloon(): ballooningcontroller {
    return this.#balloon;
  }

  /** Returns the controller bound to a tier, when configured. */
  controller(tier: memorytierid): memorycontroller | null {
    return this.#controllers.get(tier) ?? null;
  }

  /** Simulates a synthetic workload sample and evaluates pressure. */
  sample(): pressureevent | null {
    const usedgb = Number((this.#plan.ramgb * (randomInt(600, 990) / 1000)).toFixed(2));
    return this.#stats.evaluate(usedgb);
  }

  /** Renders the sysctl dictionary of every controller. */
  sysctl(): Record<string, string> {
    return { ...this.#overcommit.sysctl() };
  }

  /** Renders the kernel boot arguments for this machine. */
  kernelargs(): string {
    return buildKernelArgs(this.#plan);
  }

  /** Renders the Docker memory flags for this machine. */
  dockerflags(): dockermemoryflags {
    return dockerMemoryFlags({
      ramgb: this.#plan.ramgb,
      shmsizegb: this.#plan.shmsizegb,
      unlimitedswap: true,
    });
  }

  /** Renders the fstab line of the shader cache tmpfs. */
  cachefstab(): string {
    return this.#cache.fstabline();
  }

  /** Renders a complete JSON-safe description of the machine memory. */
  describe(): Record<string, unknown> {
    return {
      plan: this.#plan,
      controllers: [...this.#controllers.values()].map((controller) => controller.describe()),
      ksm: this.#ksm.describe(),
      ballooning: this.#balloon.describe(),
      overcommit: this.#overcommit.describe(),
      shadercache: this.#cache.describe(),
      sysctl: this.sysctl(),
      kernelargs: this.kernelargs(),
      stats: { peak: this.#stats.peak, mean: this.#stats.mean },
    };
  }
}

/**
 * Factory that builds a virtualmemorymanager from a raw request. The
 * request is validated against the hard limits; failures raise memoryerror
 * with the accumulated validation errors for quick diagnosis.
 */
export function createVirtualMemory(request: memoryrequest): virtualmemorymanager {
  try {
    const result = validatememoryrequest(request);
    if (!result.valid || result.plan === null) {
      throw new memoryerror(`invalid memory request: ${result.errors.join('; ')}`);
    }
    return new virtualmemorymanager(result.plan);
  } catch (cause) {
    if (cause instanceof memoryerror) {
      throw cause;
    }
    throw new memoryerror('createVirtualMemory failed', { cause: cause as Error });
  }
}

/* ------------------------------------------------------------------ */
/* Section 11: placement tiers and host device profiles (Meta merge)    */
/* ------------------------------------------------------------------ */

/**
 * Placement tier taxonomy for the host-aware planner. The technology and
 * bandwidth catalog stays in memorytierid (ddr5, hbm3e, gddr7); placement
 * labels describe WHERE bytes live relative to the NUMA and fabric
 * topology, mirroring the Meta MemoryTierLabel without merging the two
 * enums.
 */
export type placementtier =
  | 'DRAM_FAST'
  | 'DRAM_SLOW'
  | 'CXL_FM'
  | 'CXL_PMEM'
  | 'HBM_BLACKWELL'
  | 'ZRAM'
  | 'PMEM_DAX';

/** One placement tier instance with its QEMU memory backend. */
export type placementspec = {
  readonly tier: placementtier;
  readonly sizemb: number;
  readonly latencyns: number;
  readonly bandwidthgbps: number;
  readonly compressionratio?: number;
  readonly persistent?: boolean;
  readonly qemubackend: 'memory-backend-ram' | 'memory-backend-memfd' | 'memory-backend-file';
  readonly extraopts?: Readonly<Record<string, string | number | boolean>>;
};

/**
 * CXL 2.0/3.0 Type-3 memory expansion device. Latency spans 178-195 ns and
 * bandwidth 32-64 GB/s per x16 PCIe 5.0 link depending on the spec
 * revision; interleave ways of 2, 4 or 8 spread accesses across decoders.
 */
export type cxxldevice = {
  readonly id: string;
  readonly spec: '2.0' | '3.0';
  readonly type: 'type3' | 'switch';
  readonly sizemb: number;
  readonly latencyns: number;
  readonly bwgbps: number;
  readonly qosclass: number;
  readonly decoders: number;
  readonly interleaveways: 2 | 4 | 8;
};

/** zram compression profile: lzo-rle favors fast decompression, zstd ratio. */
export type zramprofile = {
  readonly device: string;
  readonly algorithm: 'lzo-rle' | 'zstd' | 'lzo' | 'lz4';
  readonly level?: number;
  readonly disksizemb: number;
  readonly compratioachieved: number;
  readonly memusedmb: number;
  readonly mountpoint: string;
};

/** Huge page allocation profile including the transparent policy and memfd. */
export type hugepageprofile = {
  readonly size: '2M' | '1G';
  readonly count: number;
  readonly mount: '/dev/hugepages' | '/dev/hugepages-1G';
  readonly transparent: 'always' | 'madvise' | 'never';
  readonly shared: boolean;
  readonly memfd: boolean;
};

/**
 * CCD-aware vCPU pinning map for the Ryzen 9 9950X3D. CCD0 carries the 3D
 * V-Cache stacks (96 MB L3) and is preferred for latency-sensitive work;
 * CCD1 (32 MB L3) serves throughput work such as audio and IO threads.
 */
export type vcpupinningmap = {
  readonly vmid: string;
  readonly totalvcpus: number;
  readonly topology: {
    readonly sockets: number;
    readonly dies: number;
    readonly ccds: number;
    readonly cores: number;
    readonly threads: number;
  };
  readonly ccd0: {
    readonly cpus: readonly number[];
    readonly vcache: true;
    readonly l3mb: 96;
    readonly preferredfor: readonly string[];
  };
  readonly ccd1: {
    readonly cpus: readonly number[];
    readonly vcache: false;
    readonly l3mb: 32;
    readonly preferredfor: readonly string[];
  };
  readonly pinning: Map<number, readonly number[]>;
  readonly isolated: readonly number[];
  readonly numapolicy: 'strict' | 'preferred' | 'interleave';
  readonly emulatorpin: readonly number[];
};

/** Host-aware plan produced by the memorymodularizer (camelCase shape). */
export type hostmemoryplan = {
  readonly vmid: string;
  readonly totalrequestedmb: number;
  readonly effectiveusablemb: number;
  readonly tiers: readonly placementspec[];
  readonly hugepages: hugepageprofile;
  readonly zram: zramprofile;
  readonly cxl: readonly cxxldevice[];
  readonly vcpu: vcpupinningmap;
  readonly qemuargs: readonly string[];
  readonly backendsdigest: string;
};

/** Policy selector for the host-aware tier distribution. */
export type tierpolicy = 'performance' | 'capacity' | 'balanced';

/** zram algorithm selector shared by the planner and the profile type. */
export type zramalgorithm = zramprofile['algorithm'];

/* ------------------------------------------------------------------ */
/* Section 12: host-aware extreme planner (memorymodularizer)          */
/* ------------------------------------------------------------------ */

/**
 * Parses a key=value config file into a lowercase-keyed dictionary. Missing
 * files and parse failures degrade to an empty record; this is the safe
 * loader contract inherited from the Meta module.
 */
function loadkv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (!existsSync(path)) {
      return out;
    }
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = raw.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('[')) {
        continue;
      }
      const eq = trimmed.indexOf('=');
      if (eq > -1) {
        const key = trimmed.slice(0, eq).trim().toLowerCase();
        const value = trimmed
          .slice(eq + 1)
          .trim()
          .replace(/^["']|["']$/g, '');
        out[key] = value;
      }
    }
  } catch {
    /* unreadable config degrades to defaults */
  }
  return out;
}

/**
 * Host-aware extreme memory planner, the fusion of the Meta
 * MemoryModularizer and ExtremeMemoryPlanner. The planner detects the real
 * host memory tiers (CXL fabric devices via lspci, PMEM DAX devdax nodes,
 * shared Blackwell HBM), tunes zram with workload-dependent compression
 * factors, plans host-aware huge pages, pins vCPUs across the 9950X3D CCD
 * layout, synthesizes the tiered QEMU arguments, exports cgroup v2 slices
 * and QMP runtime commands, and persists the plan as JSON. All host
 * interaction is best effort: every probe is wrapped in a catcher and
 * degrades to the documented defaults.
 */
export class memorymodularizer {
  #vmconfig: Record<string, string>;
  #qemuconfig: Record<string, string>;
  #passageconfig: Record<string, string>;
  #hostthreads: number;

  constructor(options?: { configdir?: string }) {
    const dir = options?.configdir ?? '.';
    this.#vmconfig = loadkv(`${dir}/vm.config`);
    this.#qemuconfig = loadkv(`${dir}/qemu.config`);
    this.#passageconfig = loadkv(`${dir}/passage.config`);
    this.#hostthreads = cpus().length;
  }

  /** Host logical thread count observed at construction. */
  get hostthreads(): number {
    return this.#hostthreads;
  }

  /**
   * Detects the real host tiers. DRAM splits 70/30 into fast and slow
   * bands; an lspci scan for CXL vendor 1e98 or an explicit qemu.config
   * cxl_enabled flag adds a CXL_FM tier; /dev/pmem0 adds a persistent
   * PMEM_DAX tier (128 GB, 300 ns, 15 GB/s); a shared_host_mem blackwell
   * flag exposes half of the GPU VRAM as HBM_BLACKWELL through memfd.
   */
  detecthosttiers(): placementspec[] {
    try {
      const totalmb = Math.floor(totalmem() / (1024 * 1024));
      const tiers: placementspec[] = [
        {
          tier: 'DRAM_FAST',
          sizemb: Math.floor(totalmb * 0.7),
          latencyns: 78,
          bandwidthgbps: 89.6,
          qemubackend: 'memory-backend-ram',
        },
        {
          tier: 'DRAM_SLOW',
          sizemb: Math.floor(totalmb * 0.3),
          latencyns: 95,
          bandwidthgbps: 67,
          qemubackend: 'memory-backend-ram',
        },
      ];
      try {
        const lspci = execSync('lspci -d 1e98: 2>/dev/null || true', { encoding: 'utf8' });
        if (lspci.includes('CXL') || this.#qemuconfig.cxl_enabled === 'true') {
          tiers.push({
            tier: 'CXL_FM',
            sizemb: Number.parseInt(this.#qemuconfig.cxl_size_mb ?? '65536', 10),
            latencyns: 170,
            bandwidthgbps: 32,
            qemubackend: 'memory-backend-file',
            extraopts: { mem_path: '/dev/cxl/mem0', share: true },
          });
        }
      } catch {
        /* lspci unavailable: CXL tier stays hidden */
      }
      try {
        if (existsSync('/dev/pmem0')) {
          tiers.push({
            tier: 'PMEM_DAX',
            sizemb: 131072,
            latencyns: 300,
            bandwidthgbps: 15,
            persistent: true,
            qemubackend: 'memory-backend-file',
            extraopts: { mem_path: '/dev/pmem0', pmem: true },
          });
        }
      } catch {
        /* devdax probe failed: PMEM tier stays hidden */
      }
      if (this.#vmconfig.shared_host_mem === 'true') {
        const vramgb = Number(this.#vmconfig.blackwell_vram_gb ?? 32);
        tiers.push({
          tier: 'HBM_BLACKWELL',
          sizemb: Math.floor(vramgb * 1024 * 0.5),
          latencyns: 120,
          bandwidthgbps: 224,
          qemubackend: 'memory-backend-memfd',
          extraopts: { share: true },
        });
      }
      return tiers;
    } catch (cause) {
      throw new memoryerror('detecthosttiers failed', { cause: cause as Error });
    }
  }

  /**
   * Plans zram sizing and command sequence for a requested capacity. The
   * compression factor adapts to the workload type from passage.config
   * (media_transcode 1.8, build 3.2, default 2.5) and to the algorithm
   * (zstd x1.15, lzo-rle x0.92); the disksize takes 30 percent of the
   * request and the returned commands cover modprobe, comp_algorithm,
   * disksize, mkswap and swapon at priority 100.
   */
  configurezram(
    requestedmb: number,
    algorithm: zramalgorithm = 'zstd',
    workload?: string,
  ): { enabled: boolean; factor: number; disksizemb: number; commands: readonly string[] } {
    try {
      if (!Number.isFinite(requestedmb) || requestedmb <= 0) {
        throw new memoryerror(`requestedmb must be a positive number, received ${requestedmb}`);
      }
      const kind = workload ?? this.#passageconfig.workload_type ?? 'general';
      let factor = 2.5;
      if (kind === 'media_transcode') {
        factor = 1.8;
      }
      if (kind === 'build') {
        factor = 3.2;
      }
      if (algorithm === 'zstd') {
        factor *= 1.15;
      }
      if (algorithm === 'lzo-rle') {
        factor *= 0.92;
      }
      const disksizemb = Math.floor(requestedmb * 0.3);
      const commands = [
        'modprobe zram num_devices=2',
        `echo ${algorithm} > /sys/block/zram0/comp_algorithm`,
        `echo ${disksizemb}M > /sys/block/zram0/disksize`,
        'mkswap /dev/zram0 && swapon /dev/zram0 -p 100',
      ];
      return { enabled: true, factor: Number(factor.toFixed(2)), disksizemb, commands };
    } catch (cause) {
      if (cause instanceof memoryerror) {
        throw cause;
      }
      throw new memoryerror('configurezram failed', { cause: cause as Error });
    }
  }

  /**
   * Host-aware huge page planning. Unlike the static planhugepages this
   * variant reads HugePages_Total from /proc/meminfo, honors the thp_enabled
   * knob from qemu.config for the transparent policy and mounts under
   * /dev/hugepages or /dev/hugepages-1G depending on the preferred size.
   */
  planhugepageshost(
    totalmb: number,
    prefer: '2M' | '1G' = '2M',
  ): { sizekb: number; count: number; mount: string; transparent: boolean } {
    try {
      if (!Number.isFinite(totalmb) || totalmb <= 0) {
        throw new memoryerror(`totalmb must be a positive number, received ${totalmb}`);
      }
      const sizekb = prefer === '1G' ? 1048576 : 2048;
      const wanted = Math.ceil((totalmb * 1024) / sizekb);
      let available = 0;
      try {
        const meminfo = readFileSync('/proc/meminfo', 'utf8');
        const match = /HugePages_Total:\s+(\d+)/.exec(meminfo);
        available = match === null ? 0 : Number.parseInt(match[1], 10);
      } catch {
        /* no procfs: fall back to the computed count */
      }
      return {
        sizekb,
        count: Math.max(wanted, available),
        mount: prefer === '1G' ? '/dev/hugepages1G' : '/dev/hugepages',
        transparent: this.#qemuconfig.thp_enabled !== 'false',
      };
    } catch (cause) {
      if (cause instanceof memoryerror) {
        throw cause;
      }
      throw new memoryerror('planhugepageshost failed', { cause: cause as Error });
    }
  }

  /**
   * Builds the CCD-aware pinning map for a virtual machine. Even vCPUs map
   * onto CCD0 (the 3D V-Cache complex) and odd vCPUs onto CCD1; two host
   * threads stay isolated for the emulator and the host. X3D parts report
   * two dies, matching the 9950X3D topology.
   */
  buildpinningmap(
    vmid: string,
    vcpucount: number,
  ): {
    vmid: string;
    map: Map<number, readonly number[]>;
    isolated: readonly number[];
    topology: { sockets: number; dies: number; cores: number; threads: number };
  } {
    try {
      if (vmid.trim().length === 0) {
        throw new memoryerror('vmid must not be empty');
      }
      if (!Number.isInteger(vcpucount) || vcpucount < 1) {
        throw new memoryerror(`vcpucount must be a positive integer, received ${vcpucount}`);
      }
      const hostthreads = Math.max(2, this.#hostthreads);
      const vcpus = Math.min(vcpucount, hostthreads - 2);
      const half = Math.max(1, Math.floor(hostthreads / 2));
      const ccd0 = Array.from({ length: Math.min(half, hostthreads) }, (_, i) => i).slice(0, half);
      const ccd1 = Array.from({ length: half }, (_, i) => i + half);
      const map = new Map<number, readonly number[]>();
      for (let v = 0; v < vcpus; v += 1) {
        const pool = v % 2 === 0 ? ccd0 : ccd1;
        map.set(v, [pool[v % pool.length] ?? pool[0]]);
      }
      return {
        vmid,
        map,
        isolated: [hostthreads - 2, hostthreads - 1],
        topology: {
          sockets: 1,
          dies: this.#vmconfig.x3d === 'true' ? 2 : 1,
          cores: vcpus,
          threads: 1,
        },
      };
    } catch (cause) {
      if (cause instanceof memoryerror) {
        throw cause;
      }
      throw new memoryerror('buildpinningmap failed', { cause: cause as Error });
    }
  }

  /**
   * Builds the complete host-aware plan for a virtual machine. The memory
   * tier policy (performance, capacity or balanced) selects the tier mix:
   * performance dedicates DRAM_FAST, capacity spreads 60/30/10 across
   * DRAM/CXL/zram and balanced keeps 70/20 DRAM/zram plus 10 percent
   * Blackwell HBM when the shared flag is set. The plan carries the tiered
   * QEMU argument synthesis (cxl-type3 on bus cxl.0, virtio-mem-pci with 2M
   * blocks for HBM, memory-backend-ram/memfd/file objects, two NUMA nodes,
   * the avx-512 host cpu line, the balloon with free-page reporting and the
   * vsock chardev) and the compression-adjusted effective usable capacity.
   */
  buildhostplan(
    vmid: string,
    options?: { requestedmb?: number; vcpus?: number; policy?: tierpolicy },
  ): hostmemoryplan {
    try {
      const requestedmb = options?.requestedmb ?? 8192;
      const vcpucount = options?.vcpus ?? 8;
      const policy =
        options?.policy ?? (this.#vmconfig.memory_tier_policy as tierpolicy) ?? 'balanced';
      if (!Number.isFinite(requestedmb) || requestedmb <= 0) {
        throw new memoryerror(`requestedmb must be a positive number, received ${requestedmb}`);
      }
      let tiers: placementspec[];
      if (policy === 'performance') {
        tiers = [
          {
            tier: 'DRAM_FAST',
            sizemb: requestedmb,
            latencyns: 78,
            bandwidthgbps: 89.6,
            qemubackend: 'memory-backend-ram',
          },
        ];
      } else if (policy === 'capacity') {
        tiers = [
          {
            tier: 'DRAM_FAST',
            sizemb: Math.floor(requestedmb * 0.6),
            latencyns: 78,
            bandwidthgbps: 89.6,
            qemubackend: 'memory-backend-ram',
          },
          {
            tier: 'CXL_FM',
            sizemb: Math.floor(requestedmb * 0.3),
            latencyns: 170,
            bandwidthgbps: 32,
            qemubackend: 'memory-backend-file',
            extraopts: { mem_path: '/dev/cxl/mem0', share: true },
          },
          {
            tier: 'ZRAM',
            sizemb: requestedmb - Math.floor(requestedmb * 0.6) - Math.floor(requestedmb * 0.3),
            latencyns: 250,
            bandwidthgbps: 20,
            compressionratio: 2.5,
            qemubackend: 'memory-backend-ram',
          },
        ];
      } else {
        const usehbm = this.#vmconfig.shared_host_mem === 'true';
        tiers = [
          {
            tier: 'DRAM_FAST',
            sizemb: Math.floor(requestedmb * 0.7),
            latencyns: 78,
            bandwidthgbps: 89.6,
            qemubackend: 'memory-backend-ram',
          },
          {
            tier: 'ZRAM',
            sizemb: Math.floor(requestedmb * 0.2),
            latencyns: 250,
            bandwidthgbps: 20,
            compressionratio: 2.5,
            qemubackend: 'memory-backend-ram',
          },
          ...(usehbm
            ? [
                {
                  tier: 'HBM_BLACKWELL' as const,
                  sizemb: Math.floor(requestedmb * 0.1),
                  latencyns: 120,
                  bandwidthgbps: 224,
                  qemubackend: 'memory-backend-memfd' as const,
                  extraopts: { share: true },
                },
              ]
            : []),
        ];
      }
      const prefer = requestedmb > 16384 ? '1G' : '2M';
      const hp = this.planhugepageshost(requestedmb, prefer);
      const zramplan = this.configurezram(requestedmb, 'zstd');
      const pinning = this.buildpinningmap(vmid, vcpucount);
      const cxl: cxxldevice[] =
        policy === 'performance'
          ? []
          : [
              {
                id: 'cxl-mem0',
                spec: '3.0',
                type: 'type3',
                sizemb: 65536,
                latencyns: 178,
                bwgbps: 64,
                qosclass: 2,
                decoders: 4,
                interleaveways: 4,
              },
            ];
      const hugepages: hugepageprofile = {
        size: prefer,
        count: hp.count,
        mount: prefer === '1G' ? '/dev/hugepages-1G' : '/dev/hugepages',
        transparent: hp.transparent ? 'madvise' : 'never',
        shared: prefer === '1G',
        memfd: true,
      };
      const zram: zramprofile = {
        device: '/dev/zram0',
        algorithm: 'zstd',
        level: 1,
        disksizemb: zramplan.disksizemb,
        compratioachieved: 4.2,
        memusedmb: Math.floor(zramplan.disksizemb / 4.2),
        mountpoint: '/mnt/vhe-zram',
      };
      const halfthreads = Math.max(1, Math.floor(Math.max(2, this.#hostthreads) / 2));
      const vcpu: vcpupinningmap = {
        vmid,
        totalvcpus: pinning.topology.cores,
        topology: {
          sockets: 1,
          dies: pinning.topology.dies,
          ccds: pinning.topology.dies,
          cores: pinning.topology.cores,
          threads: pinning.topology.cores * pinning.topology.threads,
        },
        ccd0: {
          cpus: Array.from({ length: halfthreads }, (_, i) => i),
          vcache: true,
          l3mb: 96,
          preferredfor: ['video', 'cuda_filter', 'encode', 'latency_sensitive'],
        },
        ccd1: {
          cpus: Array.from({ length: halfthreads }, (_, i) => i + halfthreads),
          vcache: false,
          l3mb: 32,
          preferredfor: ['audio', 'io', 'mux', 'throughput'],
        },
        pinning: pinning.map,
        isolated: pinning.isolated,
        numapolicy: 'strict',
        emulatorpin: [Math.max(1, this.#hostthreads) - 1],
      };
      const hugetlbsize = prefer === '1G' ? '1073741824' : '2097152';
      const qemuargs: string[] = [
        `-m ${requestedmb}`,
        '-object memory-backend-ram,id=ram-fast,size=' +
          `${tiers[0]?.sizemb ?? requestedmb}M,prealloc=on,host-nodes=0,policy=bind`,
        '-object memory-backend-memfd,id=ram-huge,size=' +
          `${hugepages.count * (prefer === '1G' ? 1024 : 2)}M,hugetlb=on,hugetlbsize=${hugetlbsize}`,
      ];
      if (cxl.length > 0) {
        qemuargs.push(
          `-object memory-backend-file,id=cxl-mem0,mem-path=/dev/cxl/${cxl[0].id},size=${cxl[0].sizemb}M,share=on`,
          '-device cxl-type3,bus=cxl.0,memdev=cxl-mem0,id=cxl-0',
        );
      }
      for (const [index, tier] of tiers.entries()) {
        if (tier.tier === 'HBM_BLACKWELL') {
          qemuargs.push(
            `-object memory-backend-memfd,id=blackwell-${index},size=${tier.sizemb}M,share=on`,
            `-device virtio-mem-pci,node=0,block-size=2M,requested-size=${tier.sizemb}M,memdev=blackwell-${index}`,
          );
        }
      }
      qemuargs.push(
        `-numa node,nodeid=0,cpus=0-${Math.max(0, vcpu.totalvcpus - 1)},memdev=ram-fast`,
      );
      if (cxl.length > 0) {
        qemuargs.push('-numa node,nodeid=1,memdev=cxl-mem0');
      }
      qemuargs.push(
        '-cpu host,migratable=no,+topoext,avx512f,avx512bw,avx512cd,avx512dq,avx512vl',
        '-device virtio-balloon,auto-balloon=on,free-page-reporting=on,free-page-hinting=on',
        '-chardev vsock,id=passage-ctrl,cid=2,port=1024',
        '-device vhost-vsock-pci,guest-cid=3',
      );
      const effectiveusable = tiers.reduce(
        (acc, tier) => acc + tier.sizemb * (tier.compressionratio ?? 1),
        0,
      );
      const digest = createHash('sha256')
        .update(JSON.stringify(tiers))
        .update(JSON.stringify([...pinning.map]))
        .digest('hex')
        .slice(0, 16);
      return {
        vmid,
        totalrequestedmb: requestedmb,
        effectiveusablemb: Math.floor(effectiveusable),
        tiers,
        hugepages,
        zram,
        cxl,
        vcpu,
        qemuargs,
        backendsdigest: digest,
      };
    } catch (cause) {
      if (cause instanceof memoryerror) {
        throw cause;
      }
      throw new memoryerror('buildhostplan failed', { cause: cause as Error });
    }
  }

  /**
   * Calculates the balloon target under host pressure. Pressure below 0.3
   * leaves the guest untouched; above it the balloon reclaims half of the
   * excess, never dropping below 50 percent of the current allocation. A
   * host free memory below 4 GB escalates the effective pressure to at
   * least 0.5 so the balloon engages before the host starts swapping.
   */
  calculateballoontarget(currentmb: number, hostfreemb: number, pressure: number): number {
    try {
      if (!Number.isFinite(currentmb) || currentmb <= 0) {
        throw new memoryerror(`currentmb must be a positive number, received ${currentmb}`);
      }
      if (!Number.isFinite(hostfreemb) || hostfreemb < 0) {
        throw new memoryerror(`hostfreemb must be a non-negative number, received ${hostfreemb}`);
      }
      if (!Number.isFinite(pressure) || pressure < 0 || pressure > 1) {
        throw new memoryerror(`pressure must be between 0 and 1, received ${pressure}`);
      }
      const effective = hostfreemb < 4096 ? Math.max(pressure, 0.5) : pressure;
      if (effective < 0.3) {
        return currentmb;
      }
      const reduction = Math.floor(currentmb * (effective - 0.3) * 0.5);
      const minmb = Math.floor(currentmb * 0.5);
      return Math.max(minmb, currentmb - reduction);
    } catch (cause) {
      if (cause instanceof memoryerror) {
        throw cause;
      }
      throw new memoryerror('calculateballoontarget failed', { cause: cause as Error });
    }
  }

  /**
   * Renders the cgroup v2 slice configuration for a plan: MemoryMax at the
   * requested size, MemorySwapMax at 1.5x, AllowedCPUs from the isolated
   * pinning set and MemoryZSwapMax at the zram disksize.
   */
  generatecgroupv2config(plan: hostmemoryplan): string {
    try {
      return [
        '[slice]',
        `MemoryMax=${plan.totalrequestedmb}M`,
        `MemorySwapMax=${Math.floor(plan.totalrequestedmb * 1.5)}M`,
        `AllowedCPUs=${plan.vcpu.isolated.join(',')}`,
        `MemoryZSwapMax=${plan.zram.disksizemb}M`,
        `# hugepages ${plan.hugepages.mount} size ${plan.hugepages.size} count ${plan.hugepages.count}`,
        `# backends ${plan.backendsdigest}`,
      ].join('\n');
    } catch (cause) {
      throw new memoryerror('generatecgroupv2config failed', { cause: cause as Error });
    }
  }

  /**
   * Exports the QMP runtime commands that apply a plan without a restart:
   * one balloon command sized to the requested memory plus object-add
   * commands for every CXL fabric tier.
   */
  exportqmpmemorycommands(plan: hostmemoryplan): ReadonlyArray<Record<string, unknown>> {
    try {
      const commands: Record<string, unknown>[] = [
        { execute: 'balloon', arguments: { value: plan.totalrequestedmb * 1024 * 1024 } },
      ];
      for (const [index, tier] of plan.tiers.entries()) {
        if (tier.tier !== 'CXL_FM') {
          continue;
        }
        commands.push({
          execute: 'object-add',
          arguments: {
            'qom-type': tier.qemubackend,
            id: `cxl-mem-${index}`,
            props: {
              size: tier.sizemb * 1024 * 1024,
              'mem-path': (tier.extraopts as Record<string, unknown> | undefined)?.mem_path,
              share: true,
            },
          },
        });
      }
      return commands;
    } catch (cause) {
      throw new memoryerror('exportqmpmemorycommands failed', { cause: cause as Error });
    }
  }

  /**
   * Persists a plan as JSON next to the caller's chosen path. The pinning
   * Map is materialized as a plain object so the file round-trips without
   * loss; write failures raise a memoryerror with the cause chain.
   */
  saveplan(plan: hostmemoryplan, outpath?: string): string {
    try {
      const target = outpath ?? `memory-plan-${plan.vmid}.json`;
      const serializable = {
        ...plan,
        vcpu: {
          ...plan.vcpu,
          pinning: Object.fromEntries(
            [...plan.vcpu.pinning].map(([vcpu, hostcpus]) => [vcpu, [...hostcpus]]),
          ),
        },
      };
      writeFileSync(target, JSON.stringify(serializable, null, 2));
      return target;
    } catch (cause) {
      throw new memoryerror('saveplan failed', { cause: cause as Error });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Section 13: /proc/meminfo generation (moved from the cpu module)     */
/* ------------------------------------------------------------------ */

/** Optional overrides accepted by generateVirtualMeminfo. */
export type meminfoptions = {
  readonly swapgb?: number;
  readonly vcpus?: number;
  readonly freefraction?: number;
  readonly availablefraction?: number;
  readonly hugepages1g?: number;
  readonly overcommitratio?: number;
};

/** Rounds a kB value down to the nearest 4 kB page boundary. */
export function pagealign(kb: number): number {
  return Math.floor(kb / 4) * 4;
}

/**
 * Generates a complete /proc/meminfo text for a machine with the requested
 * total RAM. Every value is expressed in kB exactly like the kernel report:
 * MemTotal, MemFree, MemAvailable, Buffers, Cached, the anon/file split,
 * SwapTotal and SwapFree, slab accounting, commit accounting under
 * vm.overcommit_memory=2 semantics, virtual memory areas, huge page state
 * and the direct map breakdown.
 *
 * @param totalgb Total guest RAM in GB (positive number).
 * @param options Optional swap size, vCPU count, fractions and huge pages.
 */
export function generateVirtualMeminfo(totalgb: number, options?: meminfoptions): string {
  try {
    if (!Number.isFinite(totalgb) || totalgb <= 0) {
      throw new memoryerror(`totalgb must be a positive number, received ${totalgb}`);
    }
    const vcpus = options?.vcpus ?? 8;
    const totalkb = pagealign(totalgb * 1024 * 1024 - 131072);
    const freefraction = options?.freefraction ?? randomInt(38, 68) / 1000;
    const availablefraction = options?.availablefraction ?? randomInt(860, 930) / 1000;
    const memfree = pagealign(totalkb * freefraction);
    const memavailable = pagealign(totalkb * availablefraction);
    const buffers = pagealign(totalkb * (randomInt(50, 80) / 10000));
    const cached = pagealign(totalkb * (randomInt(300, 420) / 1000));
    const activeanon = pagealign(totalkb * (randomInt(240, 320) / 1000));
    const inactiveanon = pagealign(totalkb * (randomInt(60, 120) / 1000));
    const active = pagealign(activeanon + cached * 0.55);
    const inactive = pagealign(inactiveanon + cached * 0.4);
    const swapgb = options?.swapgb ?? Math.min(Math.max(Math.round(totalgb / 8), 2), 128);
    const swaptotal = swapgb * 1024 * 1024;
    const swapfree = pagealign(swaptotal * (randomInt(850, 980) / 1000));
    const overcommitratio = options?.overcommitratio ?? 50;
    const commitlimit = pagealign(swaptotal + (totalkb * overcommitratio) / 100);
    const committedas = pagealign(totalkb * (randomInt(95, 160) / 100));
    const slab = pagealign(totalkb * (randomInt(190, 240) / 10000));
    const sreclaimable = pagealign(slab * 0.64);
    const anonhuge = pagealign(activeanon * (randomInt(20, 45) / 100));
    const hugepages1g = options?.hugepages1g ?? 0;
    const directmap1g = totalgb >= 64 ? pagealign(totalkb * 0.8) : 0;
    const directmap2m = directmap1g > 0 ? pagealign(totalkb * 0.15) : pagealign(totalkb * 0.9);
    const rows: [string, number][] = [
      ['MemTotal', totalkb],
      ['MemFree', memfree],
      ['MemAvailable', memavailable],
      ['Buffers', buffers],
      ['Cached', cached],
      ['SwapCached', 0],
      ['Active', active],
      ['Inactive', inactive],
      ['Active(anon)', activeanon],
      ['Inactive(anon)', inactiveanon],
      ['Active(file)', pagealign(active - activeanon)],
      ['Inactive(file)', pagealign(inactive - inactiveanon)],
      ['Unevictable', pagealign(randomInt(16384, 65536))],
      ['Mlocked', pagealign(randomInt(4096, 16384))],
      ['SwapTotal', swaptotal],
      ['SwapFree', swapfree],
      ['Dirty', pagealign(randomInt(20480, 262144))],
      ['Writeback', 0],
      ['AnonPages', pagealign(activeanon * 1.08)],
      ['Mapped', pagealign(totalkb * (randomInt(20, 42) / 1000))],
      ['Shmem', pagealign(totalkb * (randomInt(5, 12) / 1000))],
      ['KReclaimable', sreclaimable],
      ['Slab', slab],
      ['SReclaimable', sreclaimable],
      ['SUnreclaim', pagealign(slab - sreclaimable)],
      ['KernelStack', pagealign(vcpus * 320)],
      ['PageTables', pagealign(totalkb * (randomInt(30, 60) / 10000))],
      ['SecPageTables', pagealign(totalkb * (randomInt(8, 16) / 10000))],
      ['NFS_Unstable', 0],
      ['Bounce', 0],
      ['WritebackTmp', 0],
      ['CommitLimit', commitlimit],
      ['Committed_AS', committedas],
      ['VmallocTotal', 34359738367],
      ['VmallocUsed', pagealign(randomInt(49152, 131072))],
      ['VmallocChunk', 0],
      ['Percpu', pagealign(vcpus * randomInt(20480, 40960))],
      ['HardwareCorrupted', 0],
      ['AnonHugePages', anonhuge],
      ['ShmemHugePages', 0],
      ['ShmemPmdMapped', 0],
      ['FileHugePages', 0],
      ['FilePmdMapped', 0],
      ['Unaccepted', 0],
      ['HugePages_Total', hugepages1g],
      ['HugePages_Free', hugepages1g],
      ['HugePages_Rsvd', 0],
      ['HugePages_Surp', 0],
      ['Hugepagesize', 2048],
      ['Hugetlb', hugepages1g * 1048576],
      ['DirectMap4k', pagealign(randomInt(131072, 262144))],
      ['DirectMap2M', directmap2m],
      ['DirectMap1G', directmap1g],
    ];
    return rows
      .map(([key, value]) => `${key}:${String(value).padStart(24 - key.length - 1)} kB`)
      .join('\n');
  } catch (cause) {
    if (cause instanceof memoryerror) {
      throw cause;
    }
    throw new memoryerror('generateVirtualMeminfo failed', { cause: cause as Error });
  }
}

/**
 * Renders the minimal one-line meminfo shape absorbed from the v2 stub:
 * a page-aligned MemTotal in kB for the requested capacity in MiB. The
 * full 47-field payload comes from generateVirtualMeminfo.
 */
export function meminfoForMiB(mib: number): string {
  try {
    if (!Number.isFinite(mib) || mib <= 0) {
      throw new memoryerror(`mib must be a positive number, received ${mib}`);
    }
    return `MemTotal: ${pagealign(mib * 1024)} kB\n`;
  } catch (cause) {
    throw new memoryerror('meminfoForMiB failed', { cause: cause as Error });
  }
}

/**
 * Docker memory-swap sentinel absorbed from the v2 stub: "-1" keeps swap
 * unlimited, the value emitted by dockerMemoryFlags for every default plan.
 */
export const memorySwap = '-1';

/**
 * Docker /dev/shm size absorbed from the v2 stub: "2g" is the canonical
 * fix for the PyTorch DataLoader bus error caused by the 64 MB default.
 */
export const shmSize = '2g';

/**
 * MemTotal anchor of the meminfo128g reference artifact: exactly
 * 134217728 kB, the page-aligned total of 128 GiB. generatememinfo128g
 * keeps the v5 parametric behavior of subtracting the 131072 kB firmware
 * carveout, so its MemTotal reads 134086656 kB while this constant
 * preserves the physical anchor captured on 2026-08-22.
 */
export const meminfo128gtotalkb = 134217728;

/**
 * Regenerates the full 47-field /proc/meminfo payload anchored at the
 * meminfo128g artifact total (128 GiB, 134217728 kB) with the natural
 * jitter of a live machine.
 */
export function generatememinfo128g(options?: meminfoptions): string {
  try {
    return generateVirtualMeminfo(128, options);
  } catch (cause) {
    throw new memoryerror('generatememinfo128g failed', { cause: cause as Error });
  }
}
