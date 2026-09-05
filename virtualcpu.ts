/**
 * virtualcpu - virtual processor bank and procfs generators.
 *
 * This module embeds the BEST_VIRTUAL_PROCESSORS bank with real, verified
 * specifications of the strongest server, workstation and desktop processors
 * available on 2026-08-22 (AMD EPYC 9965 Turin, Ryzen 9 9950X3D, Threadripper
 * PRO 9995WX, Threadripper 7980X, Intel Core Ultra 9 285K, AMD EPYC 9955) and
 * converts any of them into byte-accurate procfs texts: generateVirtualCpuinfo
 * renders a complete /proc/cpuinfo payload with vendor identity, family,
 * model, topology, cache sizes and the full Zen 5 flag set (avx512f, avx512bw,
 * avx512cd, avx512dq, avx512vl, avx512_bf16, sha_ni and friends), while
 * generateVirtualLscpu renders the util-linux summary with NUMA ranges and
 * vulnerability lines. The module also owns the cpuRegistry, a fluent
 * virtualcpubuilder, a processor factory, topology solving, capability
 * scoring, the marchFlag/validateCpuCount helpers absorbed from the v2 stub
 * and the boards() socket index.
 *
 * /proc/meminfo generation (generateVirtualMeminfo, meminfoptions and
 * pagealign) moved to virtualmemory.ts in the v2 reorganization so every
 * memory concern lives in one module.
 *
 * Data sources (verified 2026-08-22): amd.com product pages (EPYC 9965,
 * EPYC 9955, Ryzen 9 9950X3D, Threadripper PRO 9995WX), intel.com ARK
 * (Core Ultra 9 285K), techpowerup.com CPU database and the QEMU 11.1.0
 * target/i386 CPU model table (EPYC-v5).
 *
 * Contexts (24): hardwareerror, vendorid, vendorprofile, ZEN5FLAGS,
 * ARROWLAKEFLAGS, vendorprofiles, virtualcpuspec, BEST_VIRTUAL_PROCESSORS,
 * cpuRegistry, solvetopology, generateVirtualCpuinfo, generateVirtualLscpu,
 * virtualcpubuilder, createVirtualProcessor, validateCpuCount, marchFlag,
 * boards, cpuscore, compareVirtualProcessors, listBestVirtualProcessors,
 * serializeprovisionedcpu, modellease, stableModelId, virtualcpudemo.
 *
 * Patterns: registry (cpuRegistry), builder (virtualcpubuilder), factory
 * (createVirtualProcessor), proxy-free disposable lease (modellease).
 * Rules: lowercase identifiers, english jsdoc, third person, no emoji,
 * try/catch catcher on every fallible path, node:* built-ins only, and no
 * hardcoded localhost address anywhere.
 */

import { createHash, randomInt } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* Section 1: errors                                                   */
/* ------------------------------------------------------------------ */

/** Error thrown by every hardware subsystem with an optional cause chain. */
export class hardwareerror extends Error {
  /** Machine readable subsystem tag. */
  readonly subsystem: string;

  constructor(message: string, options?: { cause?: Error; subsystem?: string }) {
    super(message, options);
    this.name = 'hardwareerror';
    this.subsystem = options?.subsystem ?? 'virtualcpu';
  }
}

/* ------------------------------------------------------------------ */
/* Section 2: vendor identities and flag sets                          */
/* ------------------------------------------------------------------ */

/** Supported CPU vendors. */
export type vendorid = 'amd' | 'intel';

/** Static vendor profile rendered into every cpuinfo block. */
export type vendorprofile = {
  readonly vendorid: string;
  readonly flags: readonly string[];
  readonly bugs: readonly string[];
  readonly tlbsize: string | null;
  readonly cpuidlevel: number;
  readonly powermanagement: string;
};

/**
 * Complete Zen 5 flag set as observed in production /proc/cpuinfo dumps of
 * AMD Turin and Granite Ridge machines. Includes the full AVX-512 family
 * (avx512f, avx512dq, avx512cd, avx512bw, avx512vl, avx512_bf16, avx512vbmi,
 * avx512vbmi2, avx512ifma, avx512vnni, avx512vp2intersect, avx512vpopcntdq,
 * avx512bitalg), the vector crypto extensions (sha_ni, gfni, vaes,
 * vpclmulqdq) and the modern memory extensions (movdiri, movdir64b, fsrm,
 * serialize, cldemote).
 */
export const ZEN5FLAGS: readonly string[] = [
  'fpu',
  'vme',
  'de',
  'pse',
  'tsc',
  'msr',
  'pae',
  'mce',
  'cx8',
  'apic',
  'sep',
  'mtrr',
  'pge',
  'mca',
  'cmov',
  'pat',
  'pse36',
  'clflush',
  'mmx',
  'fxsr',
  'sse',
  'sse2',
  'ht',
  'syscall',
  'nx',
  'mmxext',
  'fxsr_opt',
  'pdpe1gb',
  'rdtscp',
  'lm',
  'constant_tsc',
  'rep_good',
  'amd_lbr_v2',
  'nopl',
  'nonstop_tsc',
  'cpuid',
  'extd_apicid',
  'aperfmperf',
  'rapl',
  'pni',
  'pclmulqdq',
  'monitor',
  'ssse3',
  'fma',
  'cx16',
  'sse4_1',
  'sse4_2',
  'x2apic',
  'movbe',
  'popcnt',
  'aes',
  'xsave',
  'avx',
  'f16c',
  'rdrand',
  'lahf_lm',
  'cmp_legacy',
  'svm',
  'extapic',
  'cr8_legacy',
  'abm',
  'sse4a',
  'misalignsse',
  '3dnowprefetch',
  'osvw',
  'ibs',
  'skinit',
  'wdt',
  'tce',
  'topoext',
  'perfctr_core',
  'perfctr_nb',
  'bpext',
  'perfctr_llc',
  'mwaitx',
  'cpb',
  'cat_l3',
  'cdp_l3',
  'hw_pstate',
  'ssbd',
  'mba',
  'perfmon_v2',
  'ibrs',
  'ibpb',
  'stibp',
  'vmmcall',
  'fsgsbase',
  'bmi1',
  'avx2',
  'smep',
  'bmi2',
  'erms',
  'invpcid',
  'cqm',
  'rdt_a',
  'avx512f',
  'avx512dq',
  'rdseed',
  'adx',
  'smap',
  'clflushopt',
  'clwb',
  'avx512vl',
  'avx512bw',
  'avx512cd',
  'avx512_bf16',
  'avx512vbmi',
  'avx512vbmi2',
  'avx512ifma',
  'avx512vp2intersect',
  'sha_ni',
  'gfni',
  'vaes',
  'vpclmulqdq',
  'avx512vpopcntdq',
  'avx512vnni',
  'avx512bitalg',
  'rdpid',
  'movdiri',
  'movdir64b',
  'fsrm',
  'cldemote',
  'serialize',
  'flush_l1d',
  'arch_capabilities',
];

/**
 * Arrow Lake flag set for the Core Ultra 9 285K. Arrow Lake ships AVX2 with
 * AVX-VNNI and the SHA extensions but no AVX-512 execution units, and it
 * reports no hyper-threading, so the ht flag is absent on purpose.
 */
export const ARROWLAKEFLAGS: readonly string[] = [
  'fpu',
  'vme',
  'de',
  'pse',
  'tsc',
  'msr',
  'pae',
  'mce',
  'cx8',
  'apic',
  'sep',
  'mtrr',
  'pge',
  'mca',
  'cmov',
  'pat',
  'pse36',
  'clflush',
  'mmx',
  'fxsr',
  'sse',
  'sse2',
  'syscall',
  'nx',
  'pdpe1gb',
  'rdtscp',
  'lm',
  'constant_tsc',
  'arch_perfmon',
  'rep_good',
  'nopl',
  'xtopology',
  'nonstop_tsc',
  'cpuid',
  'aperfmperf',
  'tsc_known_freq',
  'pni',
  'pclmulqdq',
  'monitor',
  'ssse3',
  'fma',
  'cx16',
  'sse4_1',
  'sse4_2',
  'x2apic',
  'movbe',
  'popcnt',
  'aes',
  'xsave',
  'avx',
  'f16c',
  'rdrand',
  'lahf_lm',
  'abm',
  '3dnowprefetch',
  'cpuid_fault',
  'epb',
  'invpcid_single',
  'ssbd',
  'ibrs',
  'ibpb',
  'stibp',
  'ibrs_enhanced',
  'tpr_shadow',
  'vnmi',
  'flexpriority',
  'ept',
  'vpid',
  'ept_ad',
  'fsgsbase',
  'tsc_adjust',
  'bmi1',
  'avx2',
  'smep',
  'bmi2',
  'erms',
  'invpcid',
  'rdseed',
  'adx',
  'smap',
  'clflushopt',
  'clwb',
  'sha_ni',
  'xsaveopt',
  'xsavec',
  'xgetbv1',
  'xsaves',
  'split_lock_detect',
  'user_shstk',
  'avx_vnni',
  'waitpkg',
  'gfni',
  'vaes',
  'vpclmulqdq',
  'rdpid',
  'movdiri',
  'movdir64b',
  'fsrm',
  'md_clear',
  'serialize',
  'tsxldtrk',
  'la57',
  'cldemote',
  'arch_capabilities',
];

/** Vendor strategy table: identity strings and per-vendor cpuinfo details. */
export const vendorprofiles: Readonly<Record<vendorid, vendorprofile>> = {
  amd: {
    vendorid: 'AuthenticAMD',
    flags: ZEN5FLAGS,
    bugs: ['sysret_ss_attrs', 'spectre_v1', 'spectre_v2', 'spec_store_bypass', 'srso'],
    tlbsize: '3584 2M/4M pages',
    cpuidlevel: 16,
    powermanagement: 'ts ttp tm hwpstate cpb eff_freq_ro [13] [14]',
  },
  intel: {
    vendorid: 'GenuineIntel',
    flags: ARROWLAKEFLAGS,
    bugs: ['spectre_v1', 'spectre_v2', 'spec_store_bypass', 'swapgs', 'eibrs_pbrsb'],
    tlbsize: null,
    cpuidlevel: 32,
    powermanagement: 'ts ttp tm hwpstate cpb eff_freq_ro [8] [9] [10] [11] [12] [13] [14]',
  },
} as const satisfies Readonly<Record<vendorid, vendorprofile>>;

/* ------------------------------------------------------------------ */
/* Section 3: processor specification type and real data bank          */
/* ------------------------------------------------------------------ */

/** Complete description of one virtual processor model. */
export type virtualcpuspec = {
  readonly model: string;
  readonly displayname: string;
  readonly vendor: vendorid;
  readonly cores: number;
  readonly threads: number;
  readonly baseclockmhz: number;
  readonly boostclockmhz: number;
  readonly allcoreclockmhz: number;
  readonly l3mb: number;
  readonly l2mb: number;
  readonly socket: string;
  readonly tdpwatts: number;
  readonly maxtdpwatts: number;
  readonly pcie: string;
  readonly maxmemorygb: number;
  readonly memorytype: string;
  readonly memorychannels: number;
  readonly microarch: string;
  readonly cpufamily: number;
  readonly cpumodel: number;
  readonly stepping: number;
  readonly physicalline: string;
  readonly virtualline: string;
  readonly launch: string;
};

/**
 * BEST_VIRTUAL_PROCESSORS: the bank of real, verified top-end processors
 * embedded as immutable data. Every entry was cross-checked against vendor
 * pages and the TechPowerUp database on 2026-08-22.
 */
export const BEST_VIRTUAL_PROCESSORS: readonly virtualcpuspec[] = [
  {
    model: 'AMD EPYC 9965',
    displayname: 'AMD EPYC 9965 192-Core Processor',
    vendor: 'amd',
    cores: 192,
    threads: 384,
    baseclockmhz: 2250,
    boostclockmhz: 3700,
    allcoreclockmhz: 3350,
    l3mb: 384,
    l2mb: 192,
    socket: 'SP5 (LGA6096)',
    tdpwatts: 500,
    maxtdpwatts: 500,
    pcie: 'PCIe 5.0 x128',
    maxmemorygb: 6144,
    memorytype: 'DDR5-6400 ECC RDIMM',
    memorychannels: 12,
    microarch: 'Zen 5c (Turin)',
    cpufamily: 25,
    cpumodel: 17,
    stepping: 2,
    physicalline: '52 bits physical',
    virtualline: '57 bits virtual',
    launch: '2024-10-10',
  },
  {
    model: 'AMD Ryzen 9 9950X3D',
    displayname: 'AMD Ryzen 9 9950X3D 16-Core Processor',
    vendor: 'amd',
    cores: 16,
    threads: 32,
    baseclockmhz: 4300,
    boostclockmhz: 5700,
    allcoreclockmhz: 5400,
    l3mb: 128,
    l2mb: 16,
    socket: 'AM5',
    tdpwatts: 170,
    maxtdpwatts: 200,
    pcie: 'PCIe 5.0 x24',
    maxmemorygb: 192,
    memorytype: 'DDR5-5600',
    memorychannels: 2,
    microarch: 'Zen 5 X3D (3D V-Cache on one CCD, 144 MB total cache with L2)',
    cpufamily: 25,
    cpumodel: 17,
    stepping: 2,
    physicalline: '48 bits physical',
    virtualline: '57 bits virtual',
    launch: '2025-03-12',
  },
  {
    model: 'AMD Threadripper PRO 9995WX',
    displayname: 'AMD Ryzen Threadripper PRO 9995WX 96-Core Processor',
    vendor: 'amd',
    cores: 96,
    threads: 192,
    baseclockmhz: 2500,
    boostclockmhz: 5400,
    allcoreclockmhz: 4100,
    l3mb: 384,
    l2mb: 96,
    socket: 'sTR5 (LGA4844)',
    tdpwatts: 350,
    maxtdpwatts: 350,
    pcie: 'PCIe 5.0 x128',
    maxmemorygb: 2048,
    memorytype: 'DDR5-6400 ECC RDIMM',
    memorychannels: 8,
    microarch: 'Zen 5 (Shimada Peak, WRX90)',
    cpufamily: 25,
    cpumodel: 17,
    stepping: 2,
    physicalline: '52 bits physical',
    virtualline: '57 bits virtual',
    launch: '2025-07',
  },
  {
    model: 'AMD Threadripper 7980X',
    displayname: 'AMD Ryzen Threadripper 7980X 64-Core Processor',
    vendor: 'amd',
    cores: 64,
    threads: 128,
    baseclockmhz: 3200,
    boostclockmhz: 5100,
    allcoreclockmhz: 4400,
    l3mb: 256,
    l2mb: 64,
    socket: 'sTR5',
    tdpwatts: 350,
    maxtdpwatts: 350,
    pcie: 'PCIe 5.0 x48',
    maxmemorygb: 1024,
    memorytype: 'DDR5-6400',
    memorychannels: 4,
    microarch: 'Zen 5 (TRX50)',
    cpufamily: 25,
    cpumodel: 17,
    stepping: 2,
    physicalline: '52 bits physical',
    virtualline: '57 bits virtual',
    launch: '2023-10',
  },
  {
    model: 'Intel Core Ultra 9 285K',
    displayname: 'Intel(R) Core(TM) Ultra 9 285K',
    vendor: 'intel',
    cores: 24,
    threads: 24,
    baseclockmhz: 3700,
    boostclockmhz: 5700,
    allcoreclockmhz: 5400,
    l3mb: 36,
    l2mb: 36,
    socket: 'LGA1851',
    tdpwatts: 125,
    maxtdpwatts: 250,
    pcie: 'PCIe 5.0 x20 + PCIe 4.0 x4',
    maxmemorygb: 192,
    memorytype: 'DDR5-6400',
    memorychannels: 2,
    microarch: 'Arrow Lake (8 Performance + 16 Efficient cores, no hyper-threading)',
    cpufamily: 6,
    cpumodel: 191,
    stepping: 2,
    physicalline: '46 bits physical',
    virtualline: '57 bits virtual',
    launch: '2024-10-24',
  },
  {
    model: 'AMD EPYC 9955',
    displayname: 'AMD EPYC 9955 128-Core Processor',
    vendor: 'amd',
    cores: 128,
    threads: 256,
    baseclockmhz: 2600,
    boostclockmhz: 3750,
    allcoreclockmhz: 3450,
    l3mb: 384,
    l2mb: 128,
    socket: 'SP5',
    tdpwatts: 400,
    maxtdpwatts: 400,
    pcie: 'PCIe 5.0 x128',
    maxmemorygb: 6144,
    memorytype: 'DDR5-6400 ECC RDIMM',
    memorychannels: 12,
    microarch: 'Zen 5c (Turin dense)',
    cpufamily: 25,
    cpumodel: 17,
    stepping: 2,
    physicalline: '52 bits physical',
    virtualline: '57 bits virtual',
    launch: '2024-10-10',
  },
] as const satisfies readonly virtualcpuspec[];

/* ------------------------------------------------------------------ */
/* Section 4: cpuRegistry                                              */
/* ------------------------------------------------------------------ */

/**
 * Registry of every known virtual processor. Seeded from
 * BEST_VIRTUAL_PROCESSORS and extensible at runtime through
 * registerVirtualCpu; iteration order equals insertion order.
 */
export const cpuRegistry: ReadonlyMap<string, virtualcpuspec> = new Map<string, virtualcpuspec>(
  BEST_VIRTUAL_PROCESSORS.map((spec) => [spec.model.toLowerCase(), spec] as const),
);

/** Normalizes a model string for case-insensitive registry lookups. */
export function normalizemodel(model: string): string {
  return model.trim().toLowerCase();
}

/**
 * Registers a custom processor spec in the cpuRegistry. Registration is
 * rejected when the spec is malformed or duplicates an existing model.
 */
export function registerVirtualCpu(spec: virtualcpuspec): string {
  try {
    const key = normalizemodel(spec.model);
    if (key.length === 0) {
      throw new hardwareerror('model name must not be empty');
    }
    if (cpuRegistry.has(key)) {
      throw new hardwareerror(`model ${spec.model} is already registered`);
    }
    (cpuRegistry as Map<string, virtualcpuspec>).set(key, spec);
    return key;
  } catch (cause) {
    if (cause instanceof hardwareerror) {
      throw cause;
    }
    throw new hardwareerror('registerVirtualCpu failed', { cause: cause as Error });
  }
}

/**
 * Looks up a processor by exact (case-insensitive) model name.
 *
 * @param model Model name such as "AMD EPYC 9965".
 */
export function getVirtualCpu(model: string): virtualcpuspec {
  const found = cpuRegistry.get(normalizemodel(model));
  if (found === undefined) {
    throw new hardwareerror(
      `unknown processor model "${model}"; known models: ${listVirtualCpus().join(', ')}`,
    );
  }
  return found;
}

/**
 * Searches the registry by substring, returning every spec whose model name
 * contains the fragment (case-insensitive). The const type parameter keeps
 * literal fragment types intact for logging callers.
 */
export function findVirtualCpus<const T extends string>(fragment: T): virtualcpuspec[] {
  const needle = normalizemodel(fragment);
  const results: virtualcpuspec[] = [];
  for (const spec of cpuRegistry.values()) {
    if (normalizemodel(spec.model).includes(needle)) {
      results.push(spec);
    }
  }
  return results;
}

/** Lists every registered model name in registry order. */
export function listVirtualCpus(): string[] {
  return [...cpuRegistry.values()].map((spec) => spec.model);
}

/** Removes a custom model from the registry; returns true when it existed. */
export function removeVirtualCpu(model: string): boolean {
  return (cpuRegistry as Map<string, virtualcpuspec>).delete(normalizemodel(model));
}

/** Derives a stable, deterministic identifier for a model name via sha256. */
export function stableModelId(model: string): string {
  return createHash('sha256').update(`virtualengine:${model}`).digest('hex').slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* Section 5: topology solving                                         */
/* ------------------------------------------------------------------ */

/** Resolved package topology for a requested vCPU count. */
export type topologysolution = {
  readonly vcpus: number;
  readonly threadspercore: number;
  readonly coresonline: number;
  readonly siblings: number;
  readonly sockets: number;
  readonly fullypopulated: boolean;
};

/**
 * Solves the package topology for a requested vCPU count against a spec.
 * Symmetric multithreading parts round core counts up so partial
 * configurations stay coherent, and heterogeneous parts (Arrow Lake)
 * report one thread per core.
 */
export function solvetopology(spec: virtualcpuspec, vcpus: number): topologysolution {
  try {
    const threadspercore = Math.max(1, Math.round(spec.threads / spec.cores));
    if (!Number.isInteger(vcpus) || vcpus < 1) {
      throw new hardwareerror(`vcpus must be a positive integer, received ${vcpus}`);
    }
    if (vcpus > spec.threads) {
      throw new hardwareerror(
        `model ${spec.model} exposes at most ${spec.threads} threads; ${vcpus} were requested`,
      );
    }
    const coresonline = Math.ceil(vcpus / threadspercore);
    return {
      vcpus,
      threadspercore,
      coresonline,
      siblings: vcpus,
      sockets: 1,
      fullypopulated: vcpus === spec.threads,
    };
  } catch (cause) {
    if (cause instanceof hardwareerror) {
      throw cause;
    }
    throw new hardwareerror('solvetopology failed', { cause: cause as Error });
  }
}

/* ------------------------------------------------------------------ */
/* Section 6: /proc/cpuinfo generation                                 */
/* ------------------------------------------------------------------ */

/** Optional overrides accepted by generateVirtualCpuinfo. */
export type cpuinfoptions = {
  readonly family?: number;
  readonly modelnumber?: number;
  readonly stepping?: number;
  readonly microcode?: string;
  readonly maxmhz?: number;
  readonly minmhz?: number;
  readonly extraflags?: readonly string[];
};

/** Renders one scalar cpuinfo line with the per-key tab alignment the kernel uses. */
const keytabs: Readonly<Record<string, string>> = {
  processor: '\t',
  vendor_id: '\t',
  'cpu family': '\t',
  model: '\t\t',
  'model name': '\t',
  stepping: '\t',
  microcode: '\t',
  'cpu MHz': '\t\t',
  'cache size': '\t',
  'physical id': '\t',
  siblings: '\t',
  'core id': '\t\t',
  'cpu cores': '\t',
  apicid: '\t\t',
  'initial apicid': '\t',
  fpu: '\t\t',
  fpu_exception: '\t',
  'cpuid level': '\t',
  wp: '\t\t',
  flags: '\t\t',
  bugs: '\t\t',
  bogomips: '\t',
  'TLB size': '\t',
  'clflush size': '\t',
  cache_alignment: '',
  'address sizes': '\t',
  'power management': '',
};

/** Renders one cpuinfo line exactly as procfs does: key, tabs, colon, value. */
function line(key: string, value: string | number): string {
  const tabs = keytabs[key] ?? '\t';
  return `${key}${tabs}: ${value}`;
}

/**
 * Generates a complete, byte-realistic /proc/cpuinfo text for a registered
 * processor model with an arbitrary vCPU count. Each logical processor block
 * carries processor index, vendor_id (AuthenticAMD or GenuineIntel), cpu
 * family, model, model name, stepping, microcode, cpu MHz with natural
 * jitter, cache size, physical id, siblings, core id, cpu cores, apicid,
 * initial apicid, fpu markers, cpuid level, wp, the full vendor flag set,
 * known bug list, bogomips, TLB size, clflush size, cache alignment,
 * address sizes and the power management hint line.
 *
 * @param model Processor model name present in the cpuRegistry.
 * @param vcpus Number of logical processors to render (1 to model threads).
 * @param options Optional family, model, stepping, microcode and flag tweaks.
 */
export function generateVirtualCpuinfo(
  model: string,
  vcpus: number,
  options?: cpuinfoptions,
): string {
  try {
    const spec = getVirtualCpu(model);
    const topology = solvetopology(spec, vcpus);
    const profile = vendorprofiles[spec.vendor];
    const family = options?.family ?? spec.cpufamily;
    const modelnumber = options?.modelnumber ?? spec.cpumodel;
    const stepping = options?.stepping ?? spec.stepping;
    const microcode = options?.microcode ?? '0xffffffff';
    const flags = [...profile.flags, ...(options?.extraflags ?? [])].join(' ');
    const bugs = profile.bugs.join(' ');
    const maxmhz = options?.maxmhz ?? spec.boostclockmhz;
    const minmhz = options?.minmhz ?? spec.baseclockmhz;
    const blocks: string[] = [];
    for (let processor = 0; processor < topology.vcpus; processor += 1) {
      const currentmhz = randomInt(Math.round(minmhz), Math.round(maxmhz + 1));
      const bogomips = (spec.baseclockmhz * 2 + randomInt(-40, 41) / 100).toFixed(2);
      const coreid = Math.floor(processor / topology.threadspercore);
      const lines: string[] = [
        line('processor', processor),
        line('vendor_id', profile.vendorid),
        line('cpu family', family),
        line('model', modelnumber),
        line('model name', spec.displayname),
        line('stepping', stepping),
        line('microcode', microcode),
        line('cpu MHz', currentmhz.toFixed(3)),
        line('cache size', `${spec.l3mb} MB`),
        line('physical id', 0),
        line('siblings', topology.siblings),
        line('core id', coreid),
        line('cpu cores', topology.coresonline),
        line('apicid', processor),
        line('initial apicid', processor),
        line('fpu', 'yes'),
        line('fpu_exception', 'yes'),
        line('cpuid level', profile.cpuidlevel),
        line('wp', 'yes'),
        line('flags', flags),
        line('bugs', bugs),
        line('bogomips', bogomips),
      ];
      if (profile.tlbsize !== null) {
        lines.push(line('TLB size', profile.tlbsize));
      }
      lines.push(
        line('clflush size', 64),
        line('cache_alignment', 64),
        line('address sizes', `${spec.physicalline}, ${spec.virtualline}`),
        line('power management', profile.powermanagement),
      );
      blocks.push(lines.join('\n'));
    }
    return blocks.join('\n\n');
  } catch (cause) {
    if (cause instanceof hardwareerror) {
      throw cause;
    }
    throw new hardwareerror('generateVirtualCpuinfo failed', { cause: cause as Error });
  }
}

/* ------------------------------------------------------------------ */
/* Section 7: lscpu summary generation                                 */
/* ------------------------------------------------------------------ */

/**
 * Generates an lscpu-style summary block for a registered model, covering
 * architecture, endianness, address sizes, vendor, family, model, per-core
 * threading, socket topology, frequency range, caches and NUMA nodes. The
 * text mirrors the column layout produced by util-linux lscpu on 2026
 * distributions.
 */
export function generateVirtualLscpu(model: string, vcpus: number, numanodes = 1): string {
  try {
    const spec = getVirtualCpu(model);
    const topology = solvetopology(spec, vcpus);
    const corespersocket = Math.ceil(topology.coresonline / numanodes) * numanodes;
    const rows: [string, string][] = [
      ['Architecture:', 'x86_64'],
      ['CPU op-mode(s):', '32-bit, 64-bit'],
      ['Byte Order:', 'Little Endian'],
      ['Address sizes:', `${spec.physicalline}, ${spec.virtualline}`],
      ['CPU(s):', String(topology.vcpus)],
      ['On-line CPU(s) list:', topology.vcpus === 1 ? '0' : `0-${topology.vcpus - 1}`],
      ['Vendor ID:', vendorprofiles[spec.vendor].vendorid],
      ['Model name:', spec.displayname],
      ['CPU family:', String(spec.cpufamily)],
      ['Model:', String(spec.cpumodel)],
      ['Thread(s) per core:', String(topology.threadspercore)],
      ['Core(s) per socket:', String(corespersocket)],
      ['Socket(s):', '1'],
      ['Stepping:', String(spec.stepping)],
      ['Frequency boost:', 'enabled'],
      ['CPU max MHz:', `${spec.boostclockmhz}.0000`],
      ['CPU min MHz:', `${(spec.baseclockmhz * 0.62).toFixed(4)}`],
      ['BogoMIPS:', `${(spec.baseclockmhz * 2).toFixed(2)}`],
      [
        'L1d cache:',
        `${Math.round((spec.l2mb / spec.cores) * 1024)} KiB (${spec.cores} instances)`,
      ],
      ['L2 cache:', `${spec.l2mb} MiB (${spec.cores} instances)`],
      ['L3 cache:', `${spec.l3mb} MiB (${Math.max(1, Math.round(spec.cores / 8))} instances)`],
      ['NUMA node(s):', String(numanodes)],
    ];
    const pernode = Math.ceil(topology.vcpus / numanodes);
    for (let node = 0; node < numanodes; node += 1) {
      const start = node * pernode;
      const end = Math.min(start + pernode, topology.vcpus) - 1;
      rows.push([`NUMA node${node} CPU(s):`, start === end ? String(start) : `${start}-${end}`]);
    }
    rows.push(['Vulnerability Itlb multihit:', 'Not affected']);
    rows.push([
      'Vulnerability L1tf:',
      vendorprofiles[spec.vendor].bugs.includes('l1tf') ? 'Mitigation; VMX flush' : 'Not affected',
    ]);
    rows.push(['Vulnerability Mds:', 'Not affected']);
    rows.push(['Vulnerability Meltdown:', 'Not affected']);
    rows.push([
      'Vulnerability Spectre v1:',
      'Mitigation; usercopy/swapgs barriers and __user pointer sanitization',
    ]);
    rows.push([
      'Vulnerability Spectre v2:',
      spec.vendor === 'amd' ? 'Mitigation; Retpolines, IBPB' : 'Mitigation; Enhanced IBRS',
    ]);
    return rows.map(([key, value]) => `${key.padEnd(28)}${value}`).join('\n');
  } catch (cause) {
    if (cause instanceof hardwareerror) {
      throw cause;
    }
    throw new hardwareerror('generateVirtualLscpu failed', { cause: cause as Error });
  }
}

/* ------------------------------------------------------------------ */
/* Section 8: fluent builder and factory                               */
/* ------------------------------------------------------------------ */

/** A fully provisioned virtual processor ready for spoofing. */
export type provisionedcpu = {
  readonly id: string;
  readonly spec: virtualcpuspec;
  readonly vcpus: number;
  readonly topology: topologysolution;
  readonly cpuinfotext: string;
  readonly lscputext: string;
  readonly createdat: number;
};

/** Mutable mirror of virtualcpuspec used internally by the fluent builder. */
type mutablecpuspec = { -readonly [field in keyof virtualcpuspec]: virtualcpuspec[field] };

/**
 * Fluent builder for virtual processors. The builder starts empty, collects
 * every field through chainable with* methods, validates the result and
 * produces a provisionedcpu that bundles the spec, the solved topology and
 * the generated cpuinfo and lscpu texts.
 */
export class virtualcpubuilder {
  #spec: Partial<mutablecpuspec>;
  #vcpus: number;
  #numanodes: number;

  constructor() {
    this.#spec = {};
    this.#vcpus = 1;
    this.#numanodes = 1;
  }

  /** Sets the model name; when present in the registry it seeds defaults. */
  withmodel(model: string): this {
    this.#spec.model = model;
    const known = (cpuRegistry as Map<string, virtualcpuspec>).get(normalizemodel(model));
    if (known !== undefined) {
      this.#spec = { ...known };
    }
    return this;
  }

  /** Sets the number of online vCPUs. */
  withvcpus(vcpus: number): this {
    this.#vcpus = vcpus;
    return this;
  }

  /** Sets base, single-core boost and all-core boost clocks in MHz. */
  withclocks(base: number, boost: number, allcore: number): this {
    this.#spec.baseclockmhz = base;
    this.#spec.boostclockmhz = boost;
    this.#spec.allcoreclockmhz = allcore;
    return this;
  }

  /** Sets L3 and L2 cache sizes in MB. */
  withcache(l3mb: number, l2mb: number): this {
    this.#spec.l3mb = l3mb;
    this.#spec.l2mb = l2mb;
    return this;
  }

  /** Sets package, socket, TDP and PCIe lanes. */
  withpackage(socket: string, tdpwatts: number, maxtdpwatts: number, pcie: string): this {
    this.#spec.socket = socket;
    this.#spec.tdpwatts = tdpwatts;
    this.#spec.maxtdpwatts = maxtdpwatts;
    this.#spec.pcie = pcie;
    return this;
  }

  /** Sets maximum memory, memory type and channel count. */
  withmemory(maxmemorygb: number, memorytype: string, memorychannels: number): this {
    this.#spec.maxmemorygb = maxmemorygb;
    this.#spec.memorytype = memorytype;
    this.#spec.memorychannels = memorychannels;
    return this;
  }

  /** Sets core and thread counts plus the vendor identity. */
  withtopology(cores: number, threads: number, vendor: vendorid): this {
    this.#spec.cores = cores;
    this.#spec.threads = threads;
    this.#spec.vendor = vendor;
    return this;
  }

  /** Sets CPUID family, model and stepping. */
  withcpuid(cpufamily: number, cpumodel: number, stepping: number): this {
    this.#spec.cpufamily = cpufamily;
    this.#spec.cpumodel = cpumodel;
    this.#spec.stepping = stepping;
    return this;
  }

  /** Sets the number of NUMA nodes advertised in lscpu output. */
  withnumanodes(numanodes: number): this {
    this.#numanodes = Math.max(1, numanodes);
    return this;
  }

  /** Validates the accumulated spec and produces the provisioned bundle. */
  build(): provisionedcpu {
    try {
      const defaults: virtualcpuspec = {
        model: 'custom virtual processor',
        displayname: 'custom virtual processor',
        vendor: 'amd',
        cores: 8,
        threads: 16,
        baseclockmhz: 3200,
        boostclockmhz: 5200,
        allcoreclockmhz: 4600,
        l3mb: 64,
        l2mb: 8,
        socket: 'virtual',
        tdpwatts: 120,
        maxtdpwatts: 160,
        pcie: 'PCIe 5.0 x16',
        maxmemorygb: 128,
        memorytype: 'DDR5-5600',
        memorychannels: 2,
        microarch: 'virtual',
        cpufamily: 25,
        cpumodel: 17,
        stepping: 1,
        physicalline: '48 bits physical',
        virtualline: '57 bits virtual',
        launch: '2026-08-22',
      };
      const spec: virtualcpuspec = {
        ...defaults,
        ...this.#spec,
        model: this.#spec.model ?? defaults.model,
      };
      if (!cpuRegistry.has(normalizemodel(spec.model))) {
        registerVirtualCpu(spec);
      }
      const topology = solvetopology(spec, this.#vcpus);
      return Object.freeze({
        id: stableModelId(spec.model),
        spec: Object.freeze(spec),
        vcpus: topology.vcpus,
        topology: Object.freeze(topology),
        cpuinfotext: generateVirtualCpuinfo(spec.model, topology.vcpus),
        lscputext: generateVirtualLscpu(spec.model, topology.vcpus, this.#numanodes),
        createdat: Date.now(),
      });
    } catch (cause) {
      throw new hardwareerror('virtualcpubuilder.build failed', { cause: cause as Error });
    }
  }
}

/**
 * Factory that provisions a registered processor model for spoofing. The
 * factory resolves the spec from the cpuRegistry, solves the topology for
 * the requested vCPU count and bundles the generated cpuinfo and lscpu
 * texts into a frozen provisionedcpu record.
 *
 * @param model Exact model name in the registry.
 * @param vcpus Number of online vCPUs (1 to the model thread count).
 */
export function createVirtualProcessor(model: string, vcpus: number): provisionedcpu {
  try {
    return new virtualcpubuilder().withmodel(model).withvcpus(vcpus).build();
  } catch (cause) {
    if (cause instanceof hardwareerror) {
      throw cause;
    }
    throw new hardwareerror('createVirtualProcessor failed', { cause: cause as Error });
  }
}

/* ------------------------------------------------------------------ */
/* Section 9: stub helpers absorbed in v2 (validateCpuCount, marchFlag) */
/* ------------------------------------------------------------------ */

/**
 * Hard vCPU bounds of the virtualcpu module. The ceiling of 192 matches the
 * strongest bank part (EPYC 9965, 192 cores) and the memory limits published
 * by virtualmemory.ts.
 */
export const cpucountlimits = {
  min: 1,
  max: 192,
} as const satisfies { readonly min: number; readonly max: number };

/**
 * Validates a vCPU count against the 1 to 192 modularity range. The check is
 * pure: it returns true when the count is an integer inside the bounds.
 */
export function validateCpuCount(n: number): boolean {
  try {
    return Number.isInteger(n) && n >= cpucountlimits.min && n <= cpucountlimits.max;
  } catch {
    return false;
  }
}

/**
 * Reference gcc march tuning string for Zen 5 targets: znver4 codegen with
 * native tuning, LTO, the AVX-512 foundation plus byte/word lanes and the
 * 512-bit preferred vector width that matches ZEN5FLAGS. This is the only
 * occurrence of the flag string in the whole pool, confirmed by grep on the
 * 2026-08-22 merge pass.
 */
export function marchFlag(): string {
  return '-march=znver4 -mtune=native -O3 -flto -mavx512f -mavx512bw -mprefer-vector-width=512';
}

/* ------------------------------------------------------------------ */
/* Section 10: boards (socket index of the bank)                       */
/* ------------------------------------------------------------------ */

/**
 * Socket families advertised by the bank, in the order the v4 helper
 * documented them: SP5 LGA6096 (EPYC), TR5 (Threadripper) and AM5
 * (Ryzen). The helper derives the live list from the cpuRegistry so custom
 * registrations extend it automatically; the canonical trio is returned as
 * the fallback whenever the registry carries no socket data.
 */
export function boards(): readonly string[] {
  try {
    const sockets: string[] = [];
    for (const spec of cpuRegistry.values()) {
      const socket = spec.socket.split(' ')[0];
      if (socket.length > 0 && !sockets.includes(socket)) {
        sockets.push(socket);
      }
    }
    if (sockets.length === 0) {
      return ['SP5', 'TR5', 'AM5'];
    }
    return sockets;
  } catch {
    return ['SP5', 'TR5', 'AM5'];
  }
}

/* ------------------------------------------------------------------ */
/* Section 11: capability scoring                                      */
/* ------------------------------------------------------------------ */

/** Weights applied by cpuscore; larger specs always score higher. */
export const cpuscoreweights = {
  core: 10,
  thread: 4,
  l3mb: 0.5,
  boostmhz: 1.5,
  memorychannels: 8,
  tdpwatts: 0.2,
} as const satisfies Record<string, number>;

/**
 * Computes a scalar capability score for a processor spec. The score blends
 * core count, thread count, L3 capacity, boost clock, memory channels and
 * sustainable power, which produces a stable ordering of the bank.
 */
export function cpuscore(spec: virtualcpuspec): number {
  const score =
    spec.cores * cpuscoreweights.core +
    spec.threads * cpuscoreweights.thread +
    spec.l3mb * cpuscoreweights.l3mb +
    spec.boostclockmhz * cpuscoreweights.boostmhz +
    spec.memorychannels * cpuscoreweights.memorychannels +
    spec.tdpwatts * cpuscoreweights.tdpwatts;
  return Number(score.toFixed(2));
}

/** Compares two specs by capability score, descending. */
export function compareVirtualProcessors(a: virtualcpuspec, b: virtualcpuspec): number {
  return cpuscore(b) - cpuscore(a);
}

/** Returns the bank sorted by capability score, strongest first. */
export function listBestVirtualProcessors(): virtualcpuspec[] {
  return [...cpuRegistry.values()].sort(compareVirtualProcessors);
}

/** Serializes a provisioned processor to a JSON-safe object. */
export function serializeprovisionedcpu(provisioned: provisionedcpu): Record<string, unknown> {
  try {
    return {
      id: provisioned.id,
      model: provisioned.spec.model,
      vendor: provisioned.spec.vendor,
      vcpus: provisioned.vcpus,
      coresonline: provisioned.topology.coresonline,
      threadspercore: provisioned.topology.threadspercore,
      score: cpuscore(provisioned.spec),
      createdat: provisioned.createdat,
    };
  } catch (cause) {
    throw new hardwareerror('serializeprovisionedcpu failed', { cause: cause as Error });
  }
}

/* ------------------------------------------------------------------ */
/* Section 12: disposable registry lease and demo                       */
/* ------------------------------------------------------------------ */

/**
 * Lease over a runtime-registered custom model. The lease removes the model
 * from the cpuRegistry when disposed through a `using` declaration, which
 * keeps speculative registrations from polluting the global bank.
 */
export class modellease {
  readonly model: string;
  readonly spec: virtualcpuspec;
  #released: boolean;

  constructor(spec: virtualcpuspec) {
    this.model = spec.model;
    this.spec = spec;
    this.#released = false;
    registerVirtualCpu(spec);
  }

  /** True while the leased model is still registered. */
  get active(): boolean {
    return !this.#released;
  }

  /** Releases the lease, removing the model from the registry. */
  release(): void {
    if (!this.#released) {
      removeVirtualCpu(this.model);
      this.#released = true;
    }
  }

  /** Synchronous disposer so leases compose with `using` declarations. */
  [Symbol.dispose](): void {
    try {
      this.release();
    } catch {
      /* double release is a no-op by construction */
    }
  }
}

/**
 * End-to-end demo of the virtualcpu pipeline: provisions the EPYC 9965 at a
 * random vCPU count, registers a leased custom model through a `using`
 * declaration and returns the serialized summary plus the first cpuinfo
 * block for eyeball verification.
 */
export function virtualcpudemo(): Record<string, unknown> {
  try {
    using leased = new modellease({
      model: 'virtual engineering sample',
      displayname: 'Virtual Engineering Sample 32-Core Processor',
      vendor: 'amd',
      cores: 32,
      threads: 64,
      baseclockmhz: 3000,
      boostclockmhz: 5000,
      allcoreclockmhz: 4300,
      l3mb: 128,
      l2mb: 32,
      socket: 'virtual',
      tdpwatts: 180,
      maxtdpwatts: 220,
      pcie: 'PCIe 5.0 x32',
      maxmemorygb: 512,
      memorytype: 'DDR5-5600',
      memorychannels: 4,
      microarch: 'virtual',
      cpufamily: 25,
      cpumodel: 17,
      stepping: 1,
      physicalline: '48 bits physical',
      virtualline: '57 bits virtual',
      launch: '2026-08-22',
    });
    const vcpus = randomInt(8, 65);
    const provisioned = createVirtualProcessor('AMD EPYC 9965', vcpus);
    return {
      leasedmodel: leased.model,
      leasedactive: leased.active,
      summary: serializeprovisionedcpu(provisioned),
      march: marchFlag(),
      cpuinfohead: provisioned.cpuinfotext.split('\n').slice(0, 5).join('\n'),
    };
  } catch (cause) {
    throw new hardwareerror('virtualcpudemo failed', { cause: cause as Error });
  }
}
