/**
 * sandbox.js — browser-pure port of the saddle virtual hardware engine.
 *
 * this module is a lightweight rewrite of the engine generators
 * (virtualcpu.ts, virtualmemory.ts, virtualgpu.ts and render.ts) that runs
 * unchanged in the browser and in node: it imports nothing, touches no
 * node:* builtin and no dom api at module scope, and produces the exact
 * same procfs payloads, the 89-character nvidia-smi summary table, the
 * mesa software-stack summaries (rusticl opencl 3.1, lavapipe vulkan 1.4,
 * llvmpipe opengl 4.6) and the boot dmesg sequence the native engine emits.
 *
 * contexts (22): cpudata, gpudata, migprofiles, vendortables, topology,
 * cpuinfo, lscpu, pagealign, meminfo, freeh, smiformat, smitable, smilist,
 * clinfo, vulkaninfo, glxinfo, mesaenv, bootsequence, sandboxstate,
 * virtualfs, dispatcher, commands.
 *
 * rules: lowercase identifiers, english jsdoc in third person, no emoji,
 * zero dependencies, and deterministic fallbacks when crypto randomness
 * is unavailable.
 */

/* ------------------------------------------------------------------ */
/* context: shared helpers                                             */
/* ------------------------------------------------------------------ */

/** inclusive pseudo-random integer between min and max; deterministic
 * fallback when crypto randomness is unavailable. */
function rnd(min, max) {
  try {
    const span = max - min + 1;
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      const buf = new Uint32Array(1);
      globalThis.crypto.getRandomValues(buf);
      return min + (buf[0] % span);
    }
  } catch {
    /* falls through to math.random */
  }
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** right-pad helper that never exceeds the target width. */
function pad(text, width) {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

/** left-pad helper for right-aligned columns. */
function padstart(text, width) {
  return text.length >= width
    ? text.slice(text.length - width)
    : ' '.repeat(width - text.length) + text;
}

/**
 * formats one byte count with binary units (512 B, 4 KiB, 16 MiB, 1.5 GiB);
 * whole numbers drop the decimal so the default quota reads "16 MiB".
 *
 * @param {number} bytes the byte count.
 * @returns {string} the human readable size.
 */
function humanbytes(bytes) {
  const value = Math.max(0, Math.round(bytes));
  const unit = (size, suffix) => {
    const scaled = value / size;
    const rounded = Math.round(scaled * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${suffix}`;
  };
  if (value >= 1024 * 1024 * 1024) {
    return unit(1024 * 1024 * 1024, 'GiB');
  }
  if (value >= 1024 * 1024) {
    return unit(1024 * 1024, 'MiB');
  }
  if (value >= 1024) {
    return unit(1024, 'KiB');
  }
  return `${value} B`;
}

/** lowercases a model string for case-insensitive lookups. */
function normalizemodel(model) {
  return String(model ?? '').trim().toLowerCase();
}

/** generates a random uuid-shaped hex token with a prefix. */
function token(prefix) {
  const raw =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '')
      : Array.from({ length: 32 }, () => '0123456789abcdef'[rnd(0, 15)]).join('');
  return `${prefix}${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}`;
}

/* ------------------------------------------------------------------ */
/* context: cpudata — the processor bank (specs verified 2026-08-22)   */
/* ------------------------------------------------------------------ */

/**
 * cpudata carries the six engine-bank processors (amd epyc 9965, ryzen 9
 * 9950x3d, threadripper pro 9995wx, threadripper 7980x, core ultra 9
 * 285k, epyc 9955) plus the two web showcase additions intel xeon 6980p
 * granite rapids and apple m3 ultra. every field mirrors the vendor pages
 * and the techpowerup database as pinned by best_virtual_processors.
 */
export const cpudata = [
  {
    model: 'AMD EPYC 9965',
    displayname: 'AMD EPYC 9965 192-Core Processor',
    vendor: 'amd',
    arch: 'x86_64',
    cores: 192,
    threads: 384,
    baseclockmhz: 2250,
    boostclockmhz: 3700,
    allcoreclockmhz: 3350,
    l3mb: 384,
    l2mb: 192,
    socket: 'SP5 (LGA6096)',
    tdpwatts: 500,
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
    arch: 'x86_64',
    cores: 16,
    threads: 32,
    baseclockmhz: 4300,
    boostclockmhz: 5700,
    allcoreclockmhz: 5400,
    l3mb: 128,
    l2mb: 16,
    socket: 'AM5',
    tdpwatts: 170,
    pcie: 'PCIe 5.0 x24',
    maxmemorygb: 192,
    memorytype: 'DDR5-5600',
    memorychannels: 2,
    microarch: 'Zen 5 X3D (3D V-Cache on one CCD)',
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
    arch: 'x86_64',
    cores: 96,
    threads: 192,
    baseclockmhz: 2500,
    boostclockmhz: 5400,
    allcoreclockmhz: 4100,
    l3mb: 384,
    l2mb: 96,
    socket: 'sTR5 (LGA4844)',
    tdpwatts: 350,
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
    arch: 'x86_64',
    cores: 64,
    threads: 128,
    baseclockmhz: 3200,
    boostclockmhz: 5100,
    allcoreclockmhz: 4400,
    l3mb: 256,
    l2mb: 64,
    socket: 'sTR5',
    tdpwatts: 350,
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
    arch: 'x86_64',
    cores: 24,
    threads: 24,
    baseclockmhz: 3700,
    boostclockmhz: 5700,
    allcoreclockmhz: 5400,
    l3mb: 36,
    l2mb: 36,
    socket: 'LGA1851',
    tdpwatts: 125,
    pcie: 'PCIe 5.0 x20 + PCIe 4.0 x4',
    maxmemorygb: 192,
    memorytype: 'DDR5-6400',
    memorychannels: 2,
    microarch: 'Arrow Lake (8P + 16E, no hyper-threading)',
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
    arch: 'x86_64',
    cores: 128,
    threads: 256,
    baseclockmhz: 2600,
    boostclockmhz: 3750,
    allcoreclockmhz: 3450,
    l3mb: 384,
    l2mb: 128,
    socket: 'SP5',
    tdpwatts: 400,
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
  {
    model: 'Intel Xeon 6980P',
    displayname: 'Intel(R) Xeon(R) Platinum 6980P',
    vendor: 'intel',
    arch: 'x86_64',
    cores: 128,
    threads: 256,
    baseclockmhz: 2200,
    boostclockmhz: 3900,
    allcoreclockmhz: 3300,
    l3mb: 504,
    l2mb: 128,
    socket: 'LGA4710',
    tdpwatts: 350,
    pcie: 'PCIe 5.0 x128 + CXL 2.0 x16',
    maxmemorygb: 6144,
    memorytype: 'DDR5-6400 / MRDIMM-8800',
    memorychannels: 12,
    microarch: 'Granite Rapids (Intel 3)',
    cpufamily: 6,
    cpumodel: 173,
    stepping: 2,
    physicalline: '46 bits physical',
    virtualline: '57 bits virtual',
    launch: '2025-02',
  },
  {
    model: 'Apple M3 Ultra',
    displayname: 'Apple M3 Ultra (24P + 8E, 32-core CPU)',
    vendor: 'apple',
    arch: 'arm64',
    cores: 32,
    threads: 32,
    baseclockmhz: 1000,
    boostclockmhz: 4050,
    allcoreclockmhz: 3400,
    l3mb: 96,
    l2mb: 96,
    socket: 'soldered (UltraFusion interconnect)',
    tdpwatts: 140,
    pcie: 'PCIe 4.0 x8 + Thunderbolt 5 x2',
    maxmemorygb: 512,
    memorytype: 'LPDDR5 unified 819 GB/s',
    memorychannels: 16,
    microarch: 'Everest (3nm, two M3 Max dies fused)',
    cpufamily: 0,
    cpumodel: 0,
    stepping: 0,
    physicalline: '44 bits physical',
    virtualline: '48 bits virtual',
    launch: '2025-03',
  },
];

/** resolves a processor spec by model name, case-insensitive; returns
 * undefined for unknown models so callers can shape friendly errors. */
export function getcpu(model) {
  const needle = normalizemodel(model);
  return cpudata.find((spec) => normalizemodel(spec.model) === needle);
}

/**
 * resolves a catalog entry by its slug id (epyc-9965) as served by the
 * /api/v1/specs/cpus endpoint; returns undefined for unknown ids.
 * @param {string} id the catalog id.
 * @returns {object | undefined} the matching cpu entry.
 */
export function getcpubyid(id) {
  const key = String(id).toLowerCase().replace(/\s+/g, '-');
  const strip = (name) =>
    name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/^(amd|intel|apple|nvidia)-/, '');
  return cpudata.find((entry) => {
    const slug = entry.model.toLowerCase().replace(/\s+/g, '-');
    return slug === key || slug.endsWith(key) || strip(entry.model) === strip(key);
  });
}

/* ------------------------------------------------------------------ */
/* context: vendortables — flag sets and identity strings              */
/* ------------------------------------------------------------------ */

/** zen 5 flag set exactly as generatevirtualcpuinfo renders it (avx-512
 * family, sha_ni, gfni and friends). */
const zen5flags = [
  'fpu', 'vme', 'de', 'pse', 'tsc', 'msr', 'pae', 'mce', 'cx8', 'apic',
  'sep', 'mtrr', 'pge', 'mca', 'cmov', 'pat', 'pse36', 'clflush', 'mmx',
  'fxsr', 'sse', 'sse2', 'ht', 'syscall', 'nx', 'mmxext', 'fxsr_opt',
  'pdpe1gb', 'rdtscp', 'lm', 'constant_tsc', 'rep_good', 'amd_lbr_v2',
  'nopl', 'nonstop_tsc', 'cpuid', 'extd_apicid', 'aperfmperf', 'rapl',
  'pclmulqdq', 'monitor', 'ssse3', 'fma', 'cx16', 'sse4_1', 'sse4_2',
  'x2apic', 'movbe', 'popcnt', 'aes', 'xsave', 'avx', 'f16c', 'rdrand',
  'lahf_lm', 'cmp_legacy', 'svm', 'extapic', 'cr8_legacy', 'abm', 'sse4a',
  'misalignsse', '3dnowprefetch', 'osvw', 'ibs', 'skinit', 'wdt', 'tce',
  'topoext', 'perfctr_core', 'perfctr_nb', 'bpext', 'perfctr_llc',
  'mwaitx', 'cpb', 'cat_l3', 'cdp_l3', 'hw_pstate', 'ssbd', 'mba',
  'perfmon_v2', 'ibrs', 'ibpb', 'stibp', 'vmmcall', 'fsgsbase', 'bmi1',
  'avx2', 'smep', 'bmi2', 'erms', 'invpcid', 'cqm', 'rdt_a', 'avx512f',
  'avx512dq', 'rdseed', 'adx', 'smap', 'clflushopt', 'clwb', 'avx512vl',
  'avx512bw', 'avx512cd', 'avx512_bf16', 'avx512vbmi', 'avx512vbmi2',
  'avx512ifma', 'avx512vp2intersect', 'sha_ni', 'gfni', 'vaes',
  'vpclmulqdq', 'avx512vpopcntdq', 'avx512vnni', 'avx512bitalg', 'rdpid',
  'movdiri', 'movdir64b', 'fsrm', 'cldemote', 'serialize', 'flush_l1d',
  'arch_capabilities',
];

/** arrow lake / granite rapids flag set: avx2 with avx_vnni and no avx-512
 * execution units; the ht flag is appended per model because arrow lake
 * ships without hyper-threading while xeon 6 keeps it. */
const intelflags = [
  'fpu', 'vme', 'de', 'pse', 'tsc', 'msr', 'pae', 'mce', 'cx8', 'apic',
  'sep', 'mtrr', 'pge', 'mca', 'cmov', 'pat', 'pse36', 'clflush', 'mmx',
  'fxsr', 'sse', 'sse2', 'syscall', 'nx', 'pdpe1gb', 'rdtscp', 'lm',
  'constant_tsc', 'arch_perfmon', 'rep_good', 'nopl', 'xtopology',
  'nonstop_tsc', 'cpuid', 'aperfmperf', 'tsc_known_freq', 'pclmulqdq',
  'monitor', 'ssse3', 'fma', 'cx16', 'sse4_1', 'sse4_2', 'x2apic', 'movbe',
  'popcnt', 'aes', 'xsave', 'avx', 'f16c', 'rdrand', 'lahf_lm', 'abm',
  '3dnowprefetch', 'cpuid_fault', 'epb', 'invpcid_single', 'ssbd', 'ibrs',
  'ibpb', 'stibp', 'ibrs_enhanced', 'tpr_shadow', 'vnmi', 'flexpriority',
  'ept', 'vpid', 'ept_ad', 'fsgsbase', 'tsc_adjust', 'bmi1', 'avx2',
  'smep', 'bmi2', 'erms', 'invpcid', 'rdseed', 'adx', 'smap',
  'clflushopt', 'clwb', 'sha_ni', 'xsaveopt', 'xsavec', 'xgetbv1',
  'xsaves', 'split_lock_detect', 'user_shstk', 'avx_vnni', 'waitpkg',
  'gfni', 'vaes', 'vpclmulqdq', 'rdpid', 'movdiri', 'movdir64b', 'fsrm',
  'md_clear', 'serialize', 'tsxldtrk', 'la57', 'cldemote',
  'arch_capabilities',
];

/** arm64 feature line rendered for apple silicon cpuinfo blocks. */
const armfeatures = [
  'fp', 'asimd', 'aes', 'pmull', 'sha1', 'sha2', 'sha3', 'sha512', 'crc32',
  'atomics', 'fphp', 'asimdhp', 'cpuid', 'asimdrdm', 'jscvt', 'fcma',
  'lrcpc', 'dcpop', 'sm3', 'sm4', 'asimddp', 'uscat', 'ilrcpc', 'flagm',
  'ssbs', 'sb', 'paca', 'pacg', 'dcpodp', 'flagm2', 'frint', 'ecs', 'wfxt',
  'bti',
];

/** vendor identity table consumed by cpuinfo and lscpu. */
const vendortables = {
  amd: {
    vendorid: 'AuthenticAMD',
    flags: zen5flags,
    bugs: 'sysret_ss_attrs spectre_v1 spectre_v2 spec_store_bypass srso',
    tlbsize: '3584 2M/4M pages',
    cpuidlevel: 16,
    powermanagement: 'ts ttp tm hwpstate cpb eff_freq_ro [13] [14]',
  },
  intel: {
    vendorid: 'GenuineIntel',
    flags: intelflags,
    bugs: 'spectre_v1 spectre_v2 spec_store_bypass swapgs eibrs_pbrsb',
    tlbsize: null,
    cpuidlevel: 32,
    powermanagement:
      'ts ttp tm hwpstate cpb eff_freq_ro [8] [9] [10] [11] [12] [13] [14]',
  },
  apple: {
    vendorid: 'Apple',
    flags: armfeatures,
    bugs: '',
    tlbsize: null,
    cpuidlevel: 0,
    powermanagement: '',
  },
};

/* ------------------------------------------------------------------ */
/* context: topology                                                   */
/* ------------------------------------------------------------------ */

/**
 * solves the package topology for a vcpu count against a spec; mirrors
 * solvetopology from virtualcpu.ts (smt parts round core counts up,
 * heterogeneous parts report one thread per core and the count is clamped
 * to the model thread ceiling).
 */
export function solvetopology(spec, vcpus) {
  const threadspercore = Math.max(1, Math.round(spec.threads / spec.cores));
  const count = Math.max(1, Math.min(Math.round(vcpus) || 1, spec.threads));
  return {
    vcpus: count,
    threadspercore,
    coresonline: Math.ceil(count / threadspercore),
    siblings: count,
    sockets: 1,
    fullypopulated: count === spec.threads,
  };
}

/* ------------------------------------------------------------------ */
/* context: cpuinfo — /proc/cpuinfo generation                         */
/* ------------------------------------------------------------------ */

/** per-key tab alignment the kernel uses on x86 cpuinfo lines. */
const keytabs = {
  processor: '\t', vendor_id: '\t', 'cpu family': '\t', model: '\t\t',
  'model name': '\t', stepping: '\t', microcode: '\t', 'cpu MHz': '\t\t',
  'cache size': '\t', 'physical id': '\t', siblings: '\t', 'core id': '\t\t',
  'cpu cores': '\t', apicid: '\t\t', 'initial apicid': '\t', fpu: '\t\t',
  fpu_exception: '\t', 'cpuid level': '\t', wp: '\t\t', flags: '\t\t',
  bugs: '\t\t', bogomips: '\t', 'TLB size': '\t', 'clflush size': '\t',
  cache_alignment: '', 'address sizes': '\t', 'power management': '',
};

/** renders one cpuinfo line exactly as procfs does: key, tabs, colon, value. */
function line(key, value) {
  const tabs = keytabs[key] ?? '\t';
  return `${key}${tabs}: ${value}`;
}

/**
 * generates a complete /proc/cpuinfo text for a bank model with an
 * arbitrary vcpu count; x86_64 models render the full zen 5 / intel flag
 * set per logical processor and the apple model renders the arm64 cpuinfo
 * block shape instead.
 *
 * @param {string} model model name present in cpudata.
 * @param {number} vcpus number of logical processors to render.
 * @returns {string} the full procfs payload.
 */


export function cpuinfo(model, vcpus) {
  const spec = getcpu(model);
  if (spec === undefined) {
    throw new Error(
      `unknown processor model "${model}"; known models: ${cpudata.map((entry) => entry.model).join(', ')}`,
    );
  }
  const topology = solvetopology(spec, vcpus);
  const table = vendortables[spec.vendor];
  const blocks = [];
  for (let processor = 0; processor < topology.vcpus; processor += 1) {
    if (spec.vendor === 'apple') {
      blocks.push(
        [
          `processor\t: ${processor}`,
          'BogoMIPS\t: 48.00',
          `Features\t: ${table.flags.join(' ')}`,
          'CPU implementer\t: 0x41',
          'CPU architecture: 8',
          'CPU variant\t: 0x2',
          'CPU part\t: 0x612',
          `CPU revision\t: ${processor % 2 === 0 ? 0 : 3}`,
          '',
          `MIDR_EL1\t: 0x0000000041026${processor % 2 === 0 ? '00' : '03'}`,
          'Revidr_EL1\t: 0x00000000',
          `CPU affinity\t: ${processor}`,
        ].join('\n'),
      );
      continue;
    }
    const currentmhz = rnd(
      Math.round(spec.baseclockmhz),
      Math.round(spec.boostclockmhz) + 1,
    );
    const bogomips = (spec.baseclockmhz * 2 + rnd(-40, 41) / 100).toFixed(2);
    const coreid = Math.floor(processor / topology.threadspercore);
    const flags =
      spec.vendor === 'intel' && topology.threadspercore === 2
        ? `${table.flags.join(' ')} ht`
        : table.flags.join(' ');
    const rows = [
      line('processor', processor),
      line('vendor_id', table.vendorid),
      line('cpu family', spec.cpufamily),
      line('model', spec.cpumodel),
      line('model name', spec.displayname),
      line('stepping', spec.stepping),
      line('microcode', '0xffffffff'),
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
      line('cpuid level', table.cpuidlevel),
      line('wp', 'yes'),
      line('flags', flags),
      line('bugs', table.bugs),
      line('bogomips', bogomips),
    ];
    if (table.tlbsize !== null) {
      rows.push(line('TLB size', table.tlbsize));
    }
    rows.push(
      line('clflush size', 64),
      line('cache_alignment', 64),
      line('address sizes', `${spec.physicalline}, ${spec.virtualline}`),
      line('power management', table.powermanagement),
    );
    blocks.push(rows.join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * generates the util-linux lscpu summary for a bank model with numa node
 * ranges and vulnerability lines, mirroring generatevirtuallscpu.
 *
 * @param {string} model model name present in cpudata.
 * @param {number} vcpus logical processor count.
 * @param {number} [numanodes=1] number of numa nodes to spread over.
 * @returns {string} the lscpu text block.
 */
export function lscpu(model, vcpus, numanodes = 1) {
  const spec = getcpu(model);
  if (spec === undefined) {
    throw new Error(`unknown processor model "${model}"`);
  }
  const topology = solvetopology(spec, vcpus);
  const corespersocket = Math.ceil(topology.coresonline / numanodes) * numanodes;
  const rows = [
    ['Architecture:', spec.arch === 'arm64' ? 'aarch64' : 'x86_64'],
    ['CPU op-mode(s):', '32-bit, 64-bit'],
    ['Byte Order:', 'Little Endian'],
    ['Address sizes:', `${spec.physicalline}, ${spec.virtualline}`],
    ['CPU(s):', String(topology.vcpus)],
    ['On-line CPU(s) list:', topology.vcpus === 1 ? '0' : `0-${topology.vcpus - 1}`],
  ];
  if (spec.vendor === 'apple') {
    rows.push(
      ['Vendor ID:', 'Apple'],
      ['Model name:', spec.displayname],
      ['Thread(s) per core:', '1'],
      ['Core(s) per socket:', String(topology.coresonline)],
      ['Socket(s):', '1'],
      ['Cluster(s)-wide:', '24 performance + 8 efficiency cores'],
      ['Frequency boost:', 'enabled'],
      ['CPU max MHz:', `${spec.boostclockmhz}.0000`],
      ['CPU min MHz:', '600.0000'],
    );
  } else {
    rows.push(
      ['Vendor ID:', vendortables[spec.vendor].vendorid],
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
    );
  }
  rows.push(['NUMA node(s):', String(numanodes)]);
  const pernode = Math.ceil(topology.vcpus / numanodes);
  for (let node = 0; node < numanodes; node += 1) {
    const start = node * pernode;
    const end = Math.min(start + pernode, topology.vcpus) - 1;
    rows.push([`NUMA node${node} CPU(s):`, start === end ? String(start) : `${start}-${end}`]);
  }
  if (spec.vendor !== 'apple') {
    rows.push(
      ['Vulnerability Itlb multihit:', 'Not affected'],
      ['Vulnerability L1tf:', 'Not affected'],
      ['Vulnerability Mds:', 'Not affected'],
      ['Vulnerability Meltdown:', 'Not affected'],
      [
        'Vulnerability Spectre v1:',
        'Mitigation; usercopy/swapgs barriers and __user pointer sanitization',
      ],
      [
        'Vulnerability Spectre v2:',
        spec.vendor === 'amd' ? 'Mitigation; Retpolines, IBPB' : 'Mitigation; Enhanced IBRS',
      ],
    );
  }
  return rows.map(([key, value]) => `${key.padEnd(28)}${value}`).join('\n');
}

/* ------------------------------------------------------------------ */
/* context: gpudata and migprofiles                                    */
/* ------------------------------------------------------------------ */

/**
 * gpudata mirrors the verified gpu_bank: seven real identities with
 * vrammib (physical capacity) and smireportedmib (the value after the
 * firmware carveout) cross-checked on 2026-08-22.
 */
export const gpudata = [
  {
    id: 'rtx5090', name: 'NVIDIA GeForce RTX 5090', vendor: 'nvidia',
    pcivendor: '10DE', pcidevice: '2B85', vrammib: 32768,
    smireportedmib: 32607, memtype: 'GDDR7', busbits: 512,
    bandwidthgbs: 1792, tdpwatts: 575, arch: 'GB202 Blackwell',
    smarch: 'sm_120', smcount: 170, mig: false, driver: '575.57.08',
    cuda: '12.9',
  },
  {
    id: 'rtxpro6000', name: 'NVIDIA RTX PRO 6000 Blackwell', vendor: 'nvidia',
    pcivendor: '10DE', pcidevice: '26B5', vrammib: 98304,
    smireportedmib: 98304, memtype: 'GDDR7 ECC', busbits: 512,
    bandwidthgbs: 1792, tdpwatts: 600, arch: 'GB202 Blackwell workstation',
    smarch: 'sm_120', smcount: 188, mig: true, driver: '575.57.08',
    cuda: '12.9',
  },
  {
    id: 'b200', name: 'NVIDIA B200', vendor: 'nvidia',
    pcivendor: '10DE', pcidevice: '2665', vrammib: 196608,
    smireportedmib: 184320, memtype: 'HBM3e', busbits: 8192,
    bandwidthgbs: 8000, tdpwatts: 1000, arch: 'GB100 Blackwell dual-die',
    smarch: 'sm_100', smcount: 208, mig: true, driver: '575.57.08',
    cuda: '12.9',
  },
  {
    id: 'h100', name: 'NVIDIA H100 80GB HBM3', vendor: 'nvidia',
    pcivendor: '10DE', pcidevice: '2330', vrammib: 81920,
    smireportedmib: 81559, memtype: 'HBM3', busbits: 6144,
    bandwidthgbs: 3350, tdpwatts: 700, arch: 'GH100 Hopper SXM5',
    smarch: 'sm_90', smcount: 132, mig: true, driver: '575.57.08',
    cuda: '12.9',
  },
  {
    id: 'a100', name: 'NVIDIA A100-SXM4-40GB', vendor: 'nvidia',
    pcivendor: '10DE', pcidevice: '20B0', vrammib: 40960,
    smireportedmib: 40536, memtype: 'HBM2e', busbits: 5120,
    bandwidthgbs: 1555, tdpwatts: 400, arch: 'GA100 Ampere SXM4',
    smarch: 'sm_80', smcount: 108, mig: true, driver: '575.57.08',
    cuda: '12.9',
  },
  {
    id: 'rx9070xt', name: 'AMD Radeon RX 9070 XT', vendor: 'amd',
    pcivendor: '1002', pcidevice: '748E', vrammib: 16384,
    smireportedmib: 16384, memtype: 'GDDR6', busbits: 256,
    bandwidthgbs: 640, tdpwatts: 304, arch: 'Navi 48 RDNA 4',
    smarch: 'gfx1201', smcount: 64, mig: false,
    driver: 'mesa 26.2.1 / rusticl', cuda: null,
  },
  {
    id: 'mi350x', name: 'AMD Instinct MI350X', vendor: 'amd',
    pcivendor: '1002', pcidevice: '75A0', vrammib: 294912,
    smireportedmib: 294912, memtype: 'HBM3e', busbits: 8192,
    bandwidthgbs: 8000, tdpwatts: 1000, arch: 'CDNA 4 Aqua Vanjaram',
    smarch: 'gfx950', smcount: 304, mig: false, driver: 'rocm 7.x',
    cuda: null,
  },
];

/** resolves a gpu spec by id or name, case-insensitive. */
export function getgpu(gpu) {
  const needle = normalizemodel(gpu);
  return gpudata.find(
    (spec) =>
      normalizemodel(spec.id) === needle || normalizemodel(spec.name) === needle,
  );
}

/**
 * migprofiles mirrors the mig catalog of the 96 gb-class virtual device:
 * 1g.24gb exposes 24 gb slices (4 instances), 2g.48gb 48 gb slices (2
 * instances) and 4g.96gb dedicates the full device to one instance.
 */
export const migprofiles = [
  { id: '1g.24gb', slicegb: 24, maxinstances: 4 },
  { id: '2g.48gb', slicegb: 48, maxinstances: 2 },
  { id: '4g.96gb', slicegb: 96, maxinstances: 1 },
];

/** resolves a mig profile by id; null for 'off' and unknown names. */
export function getmig(id) {
  if (id === 'off' || id === undefined || id === null || id === '') {
    return null;
  }
  return migprofiles.find((profile) => profile.id === id) ?? null;
}

/* ------------------------------------------------------------------ */
/* context: meminfo and free — /proc/meminfo generation                */
/* ------------------------------------------------------------------ */

/** rounds a kb value down to the nearest 4 kb page boundary. */
export function pagealign(kb) {
  return Math.floor(kb / 4) * 4;
}

/**
 * generates a complete /proc/meminfo text for the requested total ram in
 * gb, mirroring generatevirtualmeminfo: memtotal, memfree, memavailable,
 * buffers, cached, the anon/file split, swap, slab, commit accounting
 * under vm.overcommit_memory=2 semantics and the direct map breakdown.
 *
 * @param {number} ramgb total guest ram in gb (positive number).
 * @param {{swapgb?: number, vcpus?: number, freefraction?: number,
 *   availablefraction?: number}} [options] optional overrides.
 * @returns {string} the full meminfo payload.
 */
export function meminfo(ramgb, options = {}) {
  if (!Number.isFinite(ramgb) || ramgb <= 0) {
    throw new Error(`ramgb must be a positive number, received ${ramgb}`);
  }
  const vcpus = options.vcpus ?? 8;
  const totalkb = pagealign(ramgb * 1024 * 1024 - 131072);
  const freefraction = options.freefraction ?? rnd(38, 68) / 1000;
  const availablefraction = options.availablefraction ?? rnd(860, 930) / 1000;
  const memfree = pagealign(totalkb * freefraction);
  const memavailable = pagealign(totalkb * availablefraction);
  const buffers = pagealign(totalkb * (rnd(50, 80) / 10000));
  const cached = pagealign(totalkb * (rnd(300, 420) / 1000));
  const activeanon = pagealign(totalkb * (rnd(240, 320) / 1000));
  const inactiveanon = pagealign(totalkb * (rnd(60, 120) / 1000));
  const active = pagealign(activeanon + cached * 0.55);
  const inactive = pagealign(inactiveanon + cached * 0.4);
  const swapgb = options.swapgb ?? Math.min(Math.max(Math.round(ramgb / 8), 2), 128);
  const swaptotal = swapgb * 1024 * 1024;
  const swapfree = pagealign(swaptotal * (rnd(850, 980) / 1000));
  const commitlimit = pagealign(swaptotal + (totalkb * 50) / 100);
  const committedas = pagealign(totalkb * (rnd(95, 160) / 100));
  const slab = pagealign(totalkb * (rnd(190, 240) / 10000));
  const sreclaimable = pagealign(slab * 0.64);
  const anonhuge = pagealign(activeanon * (rnd(20, 45) / 100));
  const directmap1g = ramgb >= 64 ? pagealign(totalkb * 0.8) : 0;
  const directmap2m =
    directmap1g > 0 ? pagealign(totalkb * 0.15) : pagealign(totalkb * 0.9);
  const rows = [
    ['MemTotal', totalkb], ['MemFree', memfree],
    ['MemAvailable', memavailable], ['Buffers', buffers], ['Cached', cached],
    ['SwapCached', 0], ['Active', active], ['Inactive', inactive],
    ['Active(anon)', activeanon], ['Inactive(anon)', inactiveanon],
    ['Active(file)', pagealign(active - activeanon)],
    ['Inactive(file)', pagealign(inactive - inactiveanon)],
    ['Unevictable', pagealign(rnd(16384, 65536))],
    ['Mlocked', pagealign(rnd(4096, 16384))],
    ['SwapTotal', swaptotal], ['SwapFree', swapfree],
    ['Dirty', pagealign(rnd(20480, 262144))], ['Writeback', 0],
    ['AnonPages', pagealign(activeanon * 1.08)],
    ['Mapped', pagealign(totalkb * (rnd(20, 42) / 1000))],
    ['Shmem', pagealign(totalkb * (rnd(5, 12) / 1000))],
    ['KReclaimable', sreclaimable], ['Slab', slab],
    ['SReclaimable', sreclaimable],
    ['SUnreclaim', pagealign(slab - sreclaimable)],
    ['KernelStack', pagealign(vcpus * 320)],
    ['PageTables', pagealign(totalkb * (rnd(30, 60) / 10000))],
    ['SecPageTables', pagealign(totalkb * (rnd(8, 16) / 10000))],
    ['NFS_Unstable', 0], ['Bounce', 0], ['WritebackTmp', 0],
    ['CommitLimit', commitlimit], ['Committed_AS', committedas],
    ['VmallocTotal', 34359738367],
    ['VmallocUsed', pagealign(rnd(49152, 131072))], ['VmallocChunk', 0],
    ['Percpu', pagealign(vcpus * rnd(20480, 40960))],
    ['HardwareCorrupted', 0], ['AnonHugePages', anonhuge],
    ['ShmemHugePages', 0], ['ShmemPmdMapped', 0], ['FileHugePages', 0],
    ['FilePmdMapped', 0], ['Unaccepted', 0], ['HugePages_Total', 0],
    ['HugePages_Free', 0], ['HugePages_Rsvd', 0], ['HugePages_Surp', 0],
    ['Hugepagesize', 2048], ['Hugetlb', 0],
    ['DirectMap4k', pagealign(rnd(131072, 262144))],
    ['DirectMap2M', directmap2m], ['DirectMap1G', directmap1g],
  ];
  return rows
    .map(([key, value]) => `${key}:${String(value).padStart(24 - key.length - 1)} kB`)
    .join('\n');
}

/** converts a kb value to the largest human unit for free -h. */
function human(kb) {
  if (kb >= 1024 * 1024) {
    const gb = kb / (1024 * 1024);
    return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)}Gi`;
  }
  if (kb >= 1024) {
    return `${(kb / 1024).toFixed(1)}Mi`;
  }
  return `${Math.round(kb)}Ki`;
}

/**
 * renders the free -h table derived from a memoized meminfo snapshot so
 * cat /proc/meminfo and free -h always agree inside one sandbox.
 *
 * @param {string} meminfotext a payload previously returned by meminfo().
 * @returns {string} the free -h table.
 */
export function freeh(meminfotext) {
  const map = {};
  for (const row of meminfotext.split('\n')) {
    const match = /^([A-Za-z_()]+):\s*(\d+)\skB$/.exec(row);
    if (match !== null) {
      map[match[1]] = Number(match[2]);
    }
  }
  const total = map.MemTotal ?? 0;
  const freekb = map.MemFree ?? 0;
  const buffers = map.Buffers ?? 0;
  const cached = (map.Cached ?? 0) + (map.SReclaimable ?? 0);
  const available = map.MemAvailable ?? 0;
  const used = Math.max(0, total - freekb - buffers - cached);
  const swap = map.SwapTotal ?? 0;
  const swapfreekb = map.SwapFree ?? 0;
  const swapused = swap - swapfreekb;
  const w = (text) => padstart(String(text), 13);
  return [
    `${w('total')}${w('used')}${w('free')}${w('shared')}${w('buff/cache')}${w('available')}`,
    ['Mem:', w(human(total)), w(human(used)), w(human(freekb)),
      w(human(map.Shmem ?? 0)), w(human(buffers + cached)), w(human(available))].join(''),
    ['Swap:', w(human(swap)), w(human(swapused)), w(human(swapfreekb))].join(''),
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* context: smiformat — the exact 89-char summary table                */
/* ------------------------------------------------------------------ */

const smiwidth = 89;
const smicolumns = [40, 24, 21];
const procwidth = 75;
const smidriver = '575.57.08';
const cudaversion = '12.9';
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** formats the nvidia-smi timestamp "weekday month day hh:mm:ss year". */
function formatstamp(date) {
  const two = (value) => String(value).padStart(2, '0');
  return `${weekdays[date.getDay()]} ${months[date.getMonth()]} ${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())} ${date.getFullYear()}`;
}

/** full-width border line: "+" plus 87 fill characters plus "+". */
function smiborder(fill) {
  return `+${fill.repeat(smiwidth - 2)}+`;
}

/** full-width content line padded to the 89-char table width. */
function smifull(content) {
  return `|${pad(content, smiwidth - 2)}|`;
}

/** three-column separator: pipes at fixed offsets 1, 42 and 67. */
function smisep(fill) {
  return `|${fill.repeat(smicolumns[0])}+${fill.repeat(smicolumns[1])}+${fill.repeat(smicolumns[2])}|`;
}

/** three-column data row within the 89-char width. */
function smirow(left, mid, right) {
  return `|${pad(left, smicolumns[0])}|${pad(mid, smicolumns[1])}|${pad(right, smicolumns[2])}|`;
}

/** process table content line within the 75-char width. */
function procline(content) {
  return `|${pad(content, procwidth - 2)}|`;
}

/**
 * renders the complete virtual nvidia-smi adapter report; the summary
 * table is exactly 89 characters wide and the header pins driver
 * 575.57.08 and cuda 12.9 exactly as the native smiadapterbuilder does.
 * when a mig profile is active the memory column reflects the slice size
 * and a mig line joins the table.
 *
 * @param {string} gpu gpu id or name present in gpudata.
 * @param {string} [migprofile='off'] one of 1g.24gb, 2g.48gb, 4g.96gb or off.
 * @returns {string} the full report text.
 */
export function nvidiaSmiTable(gpu, migprofile = 'off') {
  const spec = getgpu(gpu);
  if (spec === undefined) {
    throw new Error(
      `unknown gpu "${gpu}"; known gpus: ${gpudata.map((entry) => entry.id).join(', ')}`,
    );
  }
  const mig = getmig(migprofile);
  const vrammib = mig !== null ? mig.slicegb * 1024 : spec.smireportedmib;
  const memusedmib = rnd(0, 24);
  const util = rnd(0, 3);
  const temperature = rnd(38, 47);
  const fanspeed = rnd(24, 38);
  const powerw = Math.max(10, Math.round(spec.tdpwatts * 0.04));
  const head = ` NVIDIA-SMI ${smidriver} ${' '.repeat(13)}Driver Version: ${smidriver}${' '.repeat(6)}CUDA Version: ${cudaversion}`;
  const lines = [
    formatstamp(new Date()),
    smiborder('-'),
    smifull(head),
    smisep('-'),
    smirow(
      `${pad(' GPU  Name', 27)}${pad('Persistence-M', 13)}`,
      pad(' Bus-Id          Disp.A', 24),
      ` ${padstart('Volatile Uncorr. ECC', 20)}`,
    ),
    smirow(
      pad(' Fan  Temp   Perf      Pwr:Usage/Cap', 40),
      pad('         Memory-Usage', 24),
      ` ${padstart('GPU-Util  Compute M.', 20)}`,
    ),
    smisep('='),
    smirow(
      `${pad(`   0  ${spec.name}`, 36)}${pad('Off', 4)}`,
      pad('   00000000:01:00.0  Off', 24),
      ` ${padstart('N/A', 20)}`,
    ),
    smirow(
      pad(` ${fanspeed}%   ${temperature}C  P0    ${powerw}W / ${spec.tdpwatts}W`, 40),
      padstart(`${memusedmib}MiB / ${vrammib}MiB`, 24),
      `${padstart(`${util}%`, 10)}${pad('  Default', 11)}`,
    ),
  ];
  if (mig !== null) {
    lines.push(
      smifull(
        ` MIG: enabled, profile ${mig.id}, ${mig.maxinstances} instance(s) of ${mig.slicegb} GB`,
      ),
    );
  }
  lines.push(
    smirow('', '', ''),
    smiborder('-'),
    '',
    'Processes:',
    procline(
      `${pad(' GPU  GI  CI', 20)}${pad('PID', 7)}${pad('Type', 8)}${pad('Process name', 27)}${pad('GPU Memory', 11)}`,
    ),
    procline('='.repeat(procwidth - 2)),
  );
  if (mig !== null) {
    for (let instance = 0; instance < mig.maxinstances; instance += 1) {
      lines.push(
        procline(
          `${pad(` 0    ${instance}    0`, 20)}${pad(String(1200 + instance), 7)}${pad('MIG', 8)}${pad('mig-worker', 27)}${pad(`${rnd(0, 512)}MiB`, 11)}`,
        ),
      );
    }
  } else {
    lines.push(procline('  No running processes found'));
  }
  lines.push(`+${'-'.repeat(procwidth - 2)}+`);
  return lines.join('\n');
}

/**
 * renders the nvidia-smi -l device listing; with an active mig profile
 * the mig device lines follow the parent gpu line.
 *
 * @param {string} gpu gpu id or name present in gpudata.
 * @param {string} [migprofile='off'] mig profile id or off.
 * @returns {string} the -l listing.
 */
export function nvidiaSmiList(gpu, migprofile = 'off') {
  const spec = getgpu(gpu);
  if (spec === undefined) {
    throw new Error(`unknown gpu "${gpu}"`);
  }
  const mig = getmig(migprofile);
  const lines = [`GPU 0: ${spec.name} (UUID: ${token('GPU-')})`];
  if (mig !== null) {
    for (let instance = 0; instance < mig.maxinstances; instance += 1) {
      lines.push(`  MIG ${mig.id}     Device  ${instance}: (UUID: ${token('MIG-')})`);
    }
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* context: mesa stack summaries                                       */
/* ------------------------------------------------------------------ */

/** the software rendering stack pinned from primary sources. */
const mesastack = {
  mesa: '26.2.1', llvm: '22.1.8', gl: '4.6', gles: '3.2', vulkan: '1.4',
  opencl: '3.1',
};

/**
 * renders the clinfo summary for the rusticl platform on llvmpipe: opencl
 * 3.1 (same-day spec support in mesa 26.2), fp16 default since 25.2 and
 * fp64 through rusticl_features.
 *
 * @param {number} [vcpus=8] vcpu count reported as compute units.
 * @returns {string} the clinfo summary block.
 */
export function clinfoSummary(vcpus = 8) {
  const units = Math.max(1, Math.min(vcpus, 32));
  return [
    'Number of platforms                               1',
    '  Platform Name                                   rusticl',
    '  Platform Vendor                                 Mesa/X.org',
    '  Platform Version                                OpenCL 3.1',
    '  Platform Profile                                FULL_PROFILE',
    '  Platform Extensions                             cl_khr_fp64 cl_khr_fp16 cl_khr_icd cl_khr_command_buffer',
    'Number of devices                                 1',
    '  Device Name                                     llvmpipe (CPU)',
    '  Device Vendor                                   Mesa/X.org',
    '  Device Vendor ID                                0x10005 (Mesa)',
    '  Device Version                                  OpenCL 3.1',
    '  Device Type                                     GPU',
    `  Max compute units                               ${units}`,
    '  Max work item dimensions                        3',
    '  Max work group size                             1024',
    '  Preferred vector width char/int/float           16/16/16',
    '  Max clock frequency                             3700MHz',
    '  Address bits                                    64',
    '  Half precision support                          cl_khr_fp16 (default since mesa 25.2)',
    '  Double precision support                        cl_khr_fp64 (rusticl_features=fp64)',
    '  Device available                                Yes',
    '  Compiler available                              Yes',
    '  SPIR versions                                   1.2',
  ].join('\n');
}

/**
 * renders the vulkaninfo --summary block for lavapipe: vulkan 1.4 surface
 * since mesa 25.1, khronos-conformant on the vulkan 1.3 cts, selected
 * through vk_driver_files (vk_icd_filenames is deprecated).
 *
 * @returns {string} the vulkan summary block.
 */
export function vulkanSummary() {
  return [
    '==========',
    'VULKANINFO',
    '==========',
    '',
    'Instance Extensions: count=10',
    'VK_KHR_surface                            : extension revision 25',
    'VK_KHR_get_physical_device_properties2    : extension revision 2',
    'VK_EXT_headless_surface                   : extension revision 1',
    '',
    'API Version: 1.4.313',
    '',
    'GPU0:',
    '    apiVersion        = 1.4.313',
    '    driverVersion     = 26.2.1',
    '    vendorID          = 0x10005',
    '    deviceID          = 0x0000',
    '    deviceType        = CPU',
    '    deviceName        = llvmpipe (CPU (x86_64))',
    '    driverName        = mesa_llvmpipe',
    `    driverInfo        = Mesa ${mesastack.mesa} (LLVM ${mesastack.llvm})`,
    '    conformantVersion = 1.3.0.0',
    '',
    'Device Extensions: count=204',
    'VK_KHR_8bit_storage VK_KHR_16bit_storage VK_KHR_shader_float16_int8',
    'VK_KHR_spirv_1_4 VK_KHR_storage_buffer_storage_class',
  ].join('\n');
}

/**
 * renders the glxinfo header block for llvmpipe: opengl 4.6 core profile
 * 100% (161/161 extensions tracked by mesamatrix) and the llvmpipe
 * renderer string with the llvm version.
 *
 * @returns {string} the glxinfo block.
 */
export function glxinfoSummary() {
  return [
    'name of display: :0',
    'display: :0  screen: 0',
    'direct rendering: Yes',
    'server glx vendor string: SGI',
    'client glx vendor string: Mesa Project and SGI',
    'OpenGL vendor string: Mesa',
    `OpenGL renderer string: llvmpipe (LLVM ${mesastack.llvm}, 256 bits)`,
    `OpenGL core profile version string: ${mesastack.gl} (Core Profile) Mesa ${mesastack.mesa}`,
    'OpenGL core profile shading language version string: 4.60',
    '',
    'OpenGL core profile context flags: (none)',
    'OpenGL core profile profile mask: core profile',
    '',
    'OpenGL core profile extensions: 161',
    `OpenGL version string: ${mesastack.gl} (Compatibility Profile) Mesa ${mesastack.mesa}`,
    'OpenGL shading language version string: 4.60',
    'OpenGL context flags: (none)',
    '',
    'Extended renderer info (GLX_MESA_query_renderer):',
    '    Vendor: Mesa/X.org (0x1002)',
    `    Device: llvmpipe (LLVM ${mesastack.llvm}, 256 bits) (0xffffffff)`,
    `    Version: ${mesastack.mesa}`,
    '    Accelerated: no',
    '    Video memory: 32768MB',
    '    Unified memory: yes',
    '    Texture from pixmap: yes',
  ].join('\n');
}

/**
 * assembles the validated mesa environment exactly as mesaenvbuilder +
 * renderenv('opengl') do: llvmpipe forced, gl 4.6, glsl 460, vector width
 * 512 to exercise the avx-512 paths, lavapipe through vk_driver_files and
 * rusticl opencl 3.1 with the fp64 feature.
 *
 * @param {number} [vcpus=8] vcpu count used for lp_num_threads (0 uses
 *   every core up to the lp_max_threads=32 ceiling).
 * @returns {Record<string, string>} the environment record.
 */
export function mesaenv(vcpus = 8) {
  const threads = vcpus <= 0 ? 0 : Math.min(vcpus, 32);
  return {
    LIBGL_ALWAYS_SOFTWARE: 'true',
    GALLIUM_DRIVER: 'llvmpipe',
    MESA_GL_VERSION_OVERRIDE: mesastack.gl,
    MESA_GLSL_VERSION_OVERRIDE: '460',
    MESA_GLES_VERSION_OVERRIDE: mesastack.gles,
    MESA_VK_VERSION_OVERRIDE: mesastack.vulkan,
    LP_NUM_THREADS: String(threads),
    LP_NATIVE_VECTOR_WIDTH: '512',
    MESA_NO_ERROR: '1',
    VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json',
    MESA_VK_WSI_HEADLESS_SWAPCHAIN: '1',
    RUSTICL_ENABLE: 'llvmpipe',
    RUSTICL_DEVICE_TYPE: 'gpu',
    RUSTICL_CL_VERSION: mesastack.opencl,
    RUSTICL_FEATURES: 'fp64',
  };
}

/* ------------------------------------------------------------------ */
/* context: bootsequence — dmesg-style boot lines                      */
/* ------------------------------------------------------------------ */

/**
 * renders the firecracker-style boot log for a sandbox: kernel banner,
 * 125 ms microvm bring-up, memory sizing, vcpu online lines, the mesa
 * software stack bring-up and the virtual gpu identity binding. every
 * line carries the kernel [    0.000000] timestamp style.
 *
 * @param {string} model cpu model name present in cpudata.
 * @param {number} vcpus logical processor count.
 * @param {number} [ramgb=32] guest ram in gb.
 * @param {string} [gpu='rtx5090'] gpu id present in gpudata.
 * @param {number} [quota=16777216] persistent workspace quota in bytes.
 * @returns {string[]} ordered dmesg lines.
 */
export function bootSequence(model, vcpus, ramgb = 32, gpu = 'rtx5090', quota = 16 * 1024 * 1024) {
  const spec = getcpu(model) ?? cpudata[0];
  const gpuspec = getgpu(gpu) ?? gpudata[0];
  const topology = solvetopology(spec, vcpus);
  const arch = spec.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const stamp = (seconds) => `[${seconds.toFixed(6).padStart(12)}]`;
  const onlinetime = 0.039 + 0.00042 * topology.vcpus;
  return [
    `${stamp(0)} Linux version 6.12.0-saddle (root@saddle) (gcc 15.1.0, ld 2.44) #1 SMP PREEMPT_DYNAMIC ${arch}`,
    `${stamp(0.000049)} Command line: root=/dev/vda rw console=ttyS0 reboot=k panic=1 pci=off i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd`,
    `${stamp(0.004201)} BIOS-provided physical RAM map (virtio-mem + memfd hugetlb backend)`,
    `${stamp(0.008913)} Memory: ${pagealign(ramgb * 1024 * 1024 - 131072)}K available (${ramgb} GB guest plan, 4 kB pages)`,
    `${stamp(0.012451)} firecracker: microvm vm_state=Running boot_time=125ms vmm=fc v1.16.1`,
    `${stamp(0.02133)} virtio_blk virtio1: [vda] 8589934592 512-byte logical blocks (8.6 GB)`,
    `${stamp(0.038774)} smpboot: ${topology.coresonline} cores, ${topology.vcpus} threads online (${spec.model})`,
    `${stamp(0.039001)} cpu cpu0: ${spec.microarch}, boost ${spec.boostclockmhz} MHz, l3 ${spec.l3mb} MB`,
    `${stamp(onlinetime)} smp: brought up ${topology.vcpus} cpus, cpu mask 0-${topology.vcpus - 1}`,
    `${stamp(onlinetime + 0.0148)} NUMA: ${Math.max(1, Math.round(topology.vcpus / 64))} node(s), interleave enabled`,
    `${stamp(onlinetime + 0.0283)} hugepage: 2048 kB pages reserved, thp=always`,
    `${stamp(onlinetime + 0.0422)} docker: engine 29.7.2 ready, containerd 2.3.1, memswap=-1 shm=2g`,
    `${stamp(onlinetime + 0.0551)} qemu-system-${arch}: bridge 11.1.0 attached (qmp unix:/run/saddle/qemu-0.sock)`,
    `${stamp(onlinetime + 0.0784)} mesa ${mesastack.mesa}: llvmpipe rasterizer, lp_num_threads=${Math.min(topology.vcpus, 32)}, lp_max_threads=32`,
    `${stamp(onlinetime + 0.0789)} llvmpipe: avx-512 vector width 512 selected by gallivm (llvm ${mesastack.llvm})`,
    `${stamp(onlinetime + 0.0812)} lavapipe: vulkan ${mesastack.vulkan}, icd lvp_icd.${arch}.json, wsi headless`,
    `${stamp(onlinetime + 0.0837)} rusticl: opencl ${mesastack.opencl} on llvmpipe, features fp64 (fp16 default since 25.2)`,
    `${stamp(onlinetime + 0.091)} virtualgpu: identity ${gpuspec.name} [${gpuspec.pcivendor}:${gpuspec.pcidevice}] ${gpuspec.memtype} ${gpuspec.vrammib / 1024} GB`,
    `${stamp(onlinetime + 0.0922)} nvml shim: FAKE_MODEL="${gpuspec.name}" FAKE_VRAM=${gpuspec.smireportedmib} (fake-nvidia-smi adapter ready)`,
    `${stamp(onlinetime + 0.1045)} saddle: virtual hardware engine v2.0.0, sandbox created -> running`,
    `${stamp(onlinetime + 0.1047)} saddle: persistent workspace: ${humanbytes(quota)} quota, data stays with the sandbox id`,
    `${stamp(onlinetime + 0.1046)} Freeing unused kernel image memory`,
  ];
}

/* ------------------------------------------------------------------ */
/* context: sandboxstate and dispatcher                                */
/* ------------------------------------------------------------------ */

/**
 * creates the state object shared by the browser terminal and the api
 * exec endpoint: resolved specs, a stable hostname, the boot timestamp and
 * a memoized meminfo snapshot so memory reports stay consistent within
 * one sandbox session.
 *
 * @param {{model: string, vcpus: number, ramgb: number, gpu: string,
 *   mig?: string, id?: string}} spec the sandbox specification.
 * @returns {object} the sandbox state consumed by dispatch.
 */
export function createSandboxState(spec) {
  // the reviewed catalog is the only source of processor identity; ram
  // accepts any user chosen plan up to the 18 tb virtual ceiling.
  const cpu = getcpu(spec.model) ?? cpudata[0];
  const gpu = getgpu(spec.gpu) ?? gpudata[0];
  const topology = solvetopology(cpu, spec.vcpus ?? 8);
  const ramgb = Math.max(1, Math.min(Math.round(spec.ramgb ?? 32), 18432));
  const id = spec.id ?? token('sb-');
  return {
    model: cpu.model,
    cpuspec: cpu,
    gpuspec: gpu,
    vcpus: topology.vcpus,
    ramgb,
    gpu: gpu.id,
    mig: getmig(spec.mig) === null ? 'off' : spec.mig,
    id,
    hostname: `saddle-${id.replace(/^sb-/, '').slice(0, 8)}`,
    boottime: Date.now(),
    kernel: cpu.arch === 'arm64' ? '6.12.0-saddle-aarch64' : '6.12.0-saddle',
    memsnapshot: meminfo(ramgb, { vcpus: topology.vcpus }),
    history: [],
    files: new Map(),
  };
}

/** the supported command list, reused by help and the terminal. */
export const commands = [
  'help', 'lscpu', 'cat /proc/cpuinfo', 'cat /proc/meminfo', 'free -h',
  'nvidia-smi', 'nvidia-smi -L', 'clinfo', 'vulkaninfo --summary',
  'glxinfo', 'uname -a', 'ls /etc/virtual', 'env', 'docker --version',
  'qemu-system-x86_64 --version', 'uptime', 'whoami', 'neofetch', 'clear',
  'echo', 'echo <text> > <file>', 'echo <text> >> <file>', 'touch <file>',
  'cat <file>', 'ls', 'rm <file>', 'df -h', 'stat <file>', 'pwd',
  'history', 'streaming', 'man <command>',
];

/** renders the help text with every supported command. */
function helpText() {
  const rows = [
    ['help', 'this command list'],
    ['lscpu', 'virtual processor topology summary'],
    ['cat /proc/cpuinfo', 'full procfs cpuinfo payload'],
    ['cat /proc/meminfo', 'full procfs meminfo payload'],
    ['free -h', 'human readable memory table'],
    ['nvidia-smi', 'virtual gpu adapter report (89-char table)'],
    ['nvidia-smi -L', 'virtual gpu device listing'],
    ['clinfo', 'rusticl opencl 3.1 summary on llvmpipe'],
    ['vulkaninfo --summary', 'lavapipe vulkan 1.4 summary'],
    ['glxinfo', 'llvmpipe opengl 4.6 summary'],
    ['uname -a', 'kernel and architecture line'],
    ['ls /etc/virtual', 'virtual hardware definition files'],
    ['env', 'mesa llvmpipe environment variables'],
    ['docker --version', 'docker engine version'],
    ['qemu-system-x86_64 --version', 'qemu bridge version'],
    ['uptime', 'sandbox uptime and load average'],
    ['whoami', 'current user'],
    ['neofetch', 'saddle ascii logo and sandbox specs'],
    ['clear', 'clear the terminal'],
    ['echo <text>', 'print text'],
    ['echo <text> > <file>', 'write text to a workspace file'],
    ['echo <text> >> <file>', 'append text to a workspace file'],
    ['touch <file>', 'create an empty workspace file'],
    ['cat <file>', 'print a persistent workspace file'],
    ['ls', 'list the workspace root with sizes and dates'],
    ['rm <file>', 'delete one workspace file'],
    ['df -h', 'workspace quota usage as a filesystem table'],
    ['stat <file>', 'size and timestamps of one workspace file'],
    ['pwd', 'print the working directory (always /)'],
    ['history', 'streaming', 'the last 50 commands of this session'],
    ['man <command>', 'short manual for one command'],
  ];
  return rows.map(([name, about]) => `  ${pad(name, 32)}${about}`).join('\n');
}

/** renders the neofetch block: the saddle ascii logo beside sandbox specs. */
function neofetch(state) {
  const cpu = state.cpuspec;
  const gpu = state.gpuspec;
  const logo = [
    '      ``-://////:-``          ',
    '    ./+++++++++++++/-.        ',
    '   -+++++++++++++++++++-`     ',
    '  ./+++ saddle sandbox ++/.    ',
    '  -+++++++++++++++++++++-`    ',
    '   `-:/+++++++++++++/-.       ',
    '      .-://////:-.            ',
    '                              ',
  ];
  const uptime = Math.max(1, Math.round((Date.now() - state.boottime) / 1000));
  const mins = Math.floor(uptime / 60);
  const hours = Math.floor(mins / 60);
  const uptimeText = hours > 0 ? `${hours} hour(s), ${mins % 60} min` : `${mins} min`;
  const total = pagealign(state.ramgb * 1024 * 1024 - 131072);
  const mig = getmig(state.mig);
  const info = [
    `root@${state.hostname}`,
    '-----------------',
    'OS: saddle linux (virtual hardware engine v2.0.0)',
    'Host: firecracker microvm (125 ms boot)',
    `Kernel: ${state.kernel}`,
    `Uptime: ${uptimeText}`,
    'Packages: 412 (dpkg), 8 (snap)',
    'Shell: bash 5.2.37',
    `CPU: ${cpu.displayname} (${state.vcpus}) @ ${cpu.boostclockmhz}.00MHz`,
    `GPU: ${gpu.name} [${gpu.pcivendor}:${gpu.pcidevice}]`,
    `Memory: ${human(Math.round(total * 0.31))} / ${human(total)}`,
    `vRAM: ${gpu.memtype} ${gpu.vrammib / 1024} GB${mig !== null ? ` (MIG ${mig.id})` : ''}`,
    'Renderer: llvmpipe (LLVM 22.1.8) / lavapipe 1.4 / rusticl 3.1',
  ];
  const rows = Math.max(logo.length, info.length);
  const out = [];
  for (let index = 0; index < rows; index += 1) {
    out.push(`${(logo[index] ?? '').padEnd(30)}${info[index] ?? ''}`);
  }
  return out.join('\n');
}

/** renders the uptime line with a load average derived from the vcpus. */
function uptimeLine(state) {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - state.boottime) / 1000));
  const now = new Date();
  const mins = Math.max(1, Math.round(totalSeconds / 60));
  const load = (decay) =>
    (Math.random() * state.vcpus * 0.18 * Math.exp(-decay / 30)).toFixed(2);
  return ` ${now.toTimeString().slice(0, 8)} up ${mins} min,  1 user,  load average: ${load(1)}, ${load(5)}, ${load(15)}`;
}

/** renders the env listing: the mesa stack plus the sandbox variables. */
function envText(state) {
  const mig = getmig(state.mig);
  const entries = {
    ...mesaenv(state.vcpus),
    FAKE_MODEL: state.gpuspec.name,
    FAKE_VRAM: String(mig !== null ? mig.slicegb * 1024 : state.gpuspec.smireportedmib),
    SADDLE_VERSION: '2.0.0',
    SADDLE_SANDBOX: state.id,
    SADDLE_STATE: 'running',
    SADDLE_CPU: state.model,
    SADDLE_GPU: state.gpu,
    SADDLE_MIG: state.mig,
    HOSTNAME: state.hostname,
    TERM: 'xterm-256color',
    SHELL: '/bin/bash',
    USER: 'root',
    HOME: '/root',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
  };
  return Object.keys(entries)
    .sort()
    .map((key) => `${key}=${entries[key]}`)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* context: virtualfs — the persistent workspace filesystem            */
/* ------------------------------------------------------------------ */

/** the default workspace quota mirrored from the api contract. */
const defaultquota = 16 * 1024 * 1024;

/** the per-session history cap shown by the history command. */
const historycap = 50;

/**
 * normalizes one workspace path: the working directory is always the
 * sandbox root, so relative names gain the leading slash, duplicated
 * slashes collapse, trailing slashes drop and any traversal attempt
 * ("..") or oversized path is rejected.
 *
 * @param {string} input the raw path typed by the user.
 * @returns {{ok: true, path: string} | {ok: false, error: string}} the verdict.
 */
function normalizepath(input) {
  const raw = String(input ?? '').trim();
  if (raw.length === 0) {
    return { ok: false, error: 'empty path' };
  }
  if (raw.includes('..')) {
    return { ok: false, error: 'path traversal is not allowed' };
  }
  let path = raw.replace(/\/+/, '/');
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  if (path.length > 128) {
    return { ok: false, error: 'path is too long (max 128 characters)' };
  }
  return { ok: true, path };
}

/**
 * builds the fallback filesystem for contexts without callbacks (the
 * browser terminal): a per-state map that lives exactly as long as the
 * sandbox session and mirrors the {write, read, list, del} contract.
 *
 * @param {object} state a state built by createsandboxstate.
 * @returns {{write: Function, read: Function, list: Function, del: Function}}
 *   the in-memory filesystem adapter.
 */
function memoryfs(state) {
  return {
    write(path, content) {
      const text = content === null || content === undefined ? '' : String(content);
      const size = new TextEncoder().encode(text).length;
      const updatedat = new Date().toISOString();
      state.files.set(path, { content: text, size, updatedat });
      return { path, size, updatedat };
    },
    read(path) {
      const entry = state.files.get(path);
      return entry === undefined ? null : { path, ...entry };
    },
    list() {
      return [...state.files.entries()]
        .map(([path, entry]) => ({ path, size: entry.size, updatedat: entry.updatedat }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
    },
    del(path) {
      return state.files.delete(path);
    },
  };
}

/**
 * renders one ls row in the long listing style with size and date.
 *
 * @param {{path: string, size: number, updatedat: string}} file the file row.
 * @returns {string} the formatted line.
 */
function lsrow(file) {
  const when = String(file.updatedat ?? '').slice(0, 16).replace('T', ' ');
  return `-rw-r--r-- 1 root root ${padstart(String(file.size), 9)} ${when} ${file.path}`;
}

/** the short manual pages served by the man command. */
const manualpages = {
  streaming: 'streaming: shows the streaming memory plan - any workload size runs inside a small hot window (mmap layers, evict after last consumer)',
  quantum: 'quantum: quantum layer summary - simulator, bb84, grover, dna vault, optical planner',
  tiers: 'tiers: shows the layered virtual memory - l1 ram to l4 buckets, the free pool and the npm-as-disk farm',
  touch: 'touch <file> - create an empty file in the persistent workspace (or refresh its timestamp)',
  echo: 'echo <text> - print text; echo <text> > <file> writes and echo <text> >> <file> appends (stored verbatim, no implicit newline)',
  cat: 'cat <file> - print one persistent workspace file (also /proc/cpuinfo and /proc/meminfo)',
  ls: 'ls [path] - list the persistent workspace root with sizes and dates; ls /etc/virtual keeps the hardware table',
  rm: 'rm <file> - delete one persistent workspace file',
  df: 'df [-h] - workspace quota usage as a filesystem table; the quota is fixed per sandbox id',
  stat: 'stat <file> - size and timestamps of one persistent workspace file',
  pwd: 'pwd - print the working directory; the sandbox is always rooted at /',
  history: 'history - the last 50 commands typed in this session',
  man: 'man <command> - this short manual',
};

/**
 * dispatches one shell command against a sandbox state; the return shape
 * matches the api exec contract {output, exitCode}. the optional context
 * carries the persistent filesystem callbacks {write, read, list, del}
 * bound to the sandbox id by the api host; without a context the same
 * commands run on the per-session in-memory workspace so the browser
 * terminal keeps working unchanged.
 *
 * @param {string} command the raw command line typed by the user.
 * @param {object} state a state built by createsandboxstate.
 * @param {{fs?: {write: Function, read: Function, list: Function,
 *   del: Function}, quota?: number}} [context] the optional filesystem
 *   context provided by the api host.
 * @returns {{output: string, exitCode: number, clear?: boolean}} the result.
 */
export function dispatch(command, state, context) {
  const raw = String(command ?? '').trim();
  if (raw.length === 0) {
    return { output: '', exitCode: 0 };
  }
  try {
    if (!Array.isArray(state.history)) {
      state.history = [];
    }
    state.history.push(raw);
    if (state.history.length > historycap) {
      state.history.splice(0, state.history.length - historycap);
    }
  } catch {
    /* history is best effort; a frozen state must not break exec */
  }
  const fs = context?.fs ?? memoryfs(state);
  const argv = raw.split(/\s+/);
  const head = argv[0];
  const rest = argv.slice(1).join(' ');
  try {
    /* echo is the one command with output redirection: the text is
     * stored verbatim ("echo a > f" then "echo b >> f" yields "ab") */
    const redirect = /^(.*?)\s*(>>|>)\s*([^>\s]+)\s*$/.exec(raw);
    if (redirect !== null) {
      const commandpart = redirect[1].trim();
      const redirhead = commandpart.split(/\s+/)[0];
      if (redirhead !== 'echo') {
        return {
          output: `bash: output redirection is only supported for echo (got ${redirhead})`,
          exitCode: 1,
        };
      }
      const text = commandpart.slice(redirhead.length).trim();
      const norm = normalizepath(redirect[3]);
      if (!norm.ok) {
        return { output: `bash: echo: ${redirect[3]}: ${norm.error}`, exitCode: 1 };
      }
      try {
        if (redirect[2] === '>>') {
          const existing = fs.read(norm.path);
          fs.write(norm.path, `${existing === null ? '' : existing.content}${text}`);
        } else {
          fs.write(norm.path, text);
        }
        return { output: '', exitCode: 0 };
      } catch (writeerror) {
        return {
          output: `bash: echo: ${writeerror instanceof Error ? writeerror.message : String(writeerror)}`,
          exitCode: 1,
        };
      }
    }
    switch (head) {
      case 'help':
        return { output: `saddle sandbox commands:\n${helpText()}`, exitCode: 0 };
      case 'lscpu':
        return { output: lscpu(state.model, state.vcpus, 1), exitCode: 0 };
      case 'cat': {
        if (argv[1] === '/proc/cpuinfo') {
          return { output: cpuinfo(state.model, state.vcpus), exitCode: 0 };
        }
        if (argv[1] === '/proc/meminfo') {
          return { output: state.memsnapshot, exitCode: 0 };
        }
        if (argv[1] === undefined) {
          return { output: 'cat: missing file operand', exitCode: 1 };
        }
        const catnorm = normalizepath(argv[1]);
        if (!catnorm.ok) {
          return { output: `cat: ${argv[1]}: ${catnorm.error}`, exitCode: 1 };
        }
        const catfile = fs.read(catnorm.path);
        if (catfile === null) {
          return {
            output: `cat: ${argv[1]}: No such file or directory`,
            exitCode: 1,
          };
        }
        return { output: catfile.content, exitCode: 0 };
      }
      case 'free':
        return { output: freeh(state.memsnapshot), exitCode: 0 };
      case 'nvidia-smi':
        if (argv[1] === '-L') {
          return { output: nvidiaSmiList(state.gpu, state.mig), exitCode: 0 };
        }
        return { output: nvidiaSmiTable(state.gpu, state.mig), exitCode: 0 };
      case 'clinfo':
        return { output: clinfoSummary(state.vcpus), exitCode: 0 };
      case 'vulkaninfo':
        return { output: vulkanSummary(), exitCode: 0 };
      case 'glxinfo':
        return { output: glxinfoSummary(), exitCode: 0 };
      case 'uname':
        return {
          output: `Linux ${state.hostname} ${state.kernel} #1 SMP PREEMPT_DYNAMIC ${state.cpuspec.arch === 'arm64' ? 'aarch64' : 'x86_64'} GNU/Linux`,
          exitCode: 0,
        };
      case 'ls': {
        const target = argv[1] ?? '/';
        if (target === '/etc/virtual') {
          return {
            output: [
              'boards.json    cores.json    gpus.json',
              'processors.json    virtualhardware.json    vm.config.json',
              'cpuinfo    meminfo    lscpu    nvidia-smi',
            ].join('\n'),
            exitCode: 0,
          };
        }
        const lsnorm = normalizepath(target);
        if (!lsnorm.ok) {
          return { output: `ls: ${target}: ${lsnorm.error}`, exitCode: 2 };
        }
        const rows = fs.list().filter(
          (entry) => lsnorm.path === '/' || entry.path === lsnorm.path,
        );
        if (rows.length === 0) {
          if (lsnorm.path !== '/') {
            return {
              output: `ls: cannot access '${target}': No such file or directory`,
              exitCode: 2,
            };
          }
          return { output: '', exitCode: 0 };
        }
        const blocks = Math.max(1, Math.ceil(rows.reduce((sum, row) => sum + row.size, 0) / 1024));
        return {
          output: [`total ${blocks}`, ...rows.map(lsrow)].join('\n'),
          exitCode: 0,
        };
      }
      case 'env':
        return { output: envText(state), exitCode: 0 };
      case 'docker':
        return { output: 'Docker version 29.7.2, build 5ea4c1f', exitCode: 0 };
      case 'qemu-system-x86_64':
        return {
          output: [
            'QEMU emulator version 11.1.0 (saddle bridge)',
            'Copyright (c) 2003-2026 Fabrice Bellard and the QEMU Project developers',
          ].join('\n'),
          exitCode: 0,
        };
      case 'uptime':
        return { output: uptimeLine(state), exitCode: 0 };
      case 'whoami':
        return { output: 'root', exitCode: 0 };
      case 'neofetch':
        return { output: neofetch(state), exitCode: 0 };
      case 'echo':
        return { output: rest, exitCode: 0 };
      case 'touch': {
        if (argv[1] === undefined) {
          return { output: 'touch: missing file operand', exitCode: 1 };
        }
        const touchnorm = normalizepath(argv[1]);
        if (!touchnorm.ok) {
          return { output: `touch: ${argv[1]}: ${touchnorm.error}`, exitCode: 1 };
        }
        try {
          const existing = fs.read(touchnorm.path);
          fs.write(touchnorm.path, existing === null ? '' : existing.content);
          return { output: '', exitCode: 0 };
        } catch (toucherror) {
          return {
            output: `touch: ${toucherror instanceof Error ? toucherror.message : String(toucherror)}`,
            exitCode: 1,
          };
        }
      }
      case 'rm': {
        if (argv[1] === undefined) {
          return { output: 'rm: missing operand', exitCode: 1 };
        }
        const rmnorm = normalizepath(argv[1]);
        if (!rmnorm.ok) {
          return { output: `rm: ${argv[1]}: ${rmnorm.error}`, exitCode: 1 };
        }
        try {
          const removed = fs.del(rmnorm.path);
          if (!removed) {
            return {
              output: `rm: cannot remove '${argv[1]}': No such file or directory`,
              exitCode: 1,
            };
          }
          return { output: '', exitCode: 0 };
        } catch (rmerror) {
          return {
            output: `rm: ${rmerror instanceof Error ? rmerror.message : String(rmerror)}`,
            exitCode: 1,
          };
        }
      }
      case 'quantum':
        return { output: quantumdemo(), exitCode: 0 };
      case 'tiers':
        return { output: tiersdemo(), exitCode: 0 };
      case 'streaming':
        return { output: streamingdemo(), exitCode: 0 };
      case 'df': {
        const rows = fs.list();
        const used = rows.reduce((sum, row) => sum + row.size, 0);
        const quota = Number(context?.quota ?? defaultquota);
        const avail = Math.max(0, quota - used);
        const percent = quota > 0 ? Math.min(100, Math.floor((used / quota) * 100)) : 0;
        const col = (text, width) => padstart(String(text), width);
        return {
          output: [
            `Filesystem ${col('Size', 10)}${col('Used', 10)}${col('Avail', 10)}${col('Use%', 6)} Mounted on`,
            `${pad(state.id, 11)}${col(humanbytes(quota), 10)}${col(humanbytes(used), 10)}${col(humanbytes(avail), 10)}${col(`${percent}%`, 6)} /`,
          ].join('\n'),
          exitCode: 0,
        };
      }
      case 'stat': {
        if (argv[1] === undefined) {
          return { output: 'stat: missing operand', exitCode: 1 };
        }
        const statnorm = normalizepath(argv[1]);
        if (!statnorm.ok) {
          return { output: `stat: ${argv[1]}: ${statnorm.error}`, exitCode: 1 };
        }
        const file = fs.read(statnorm.path);
        if (file === null) {
          return {
            output: `stat: cannot stat '${argv[1]}': No such file or directory`,
            exitCode: 1,
          };
        }
        return {
          output: [
            `  File: ${file.path ?? statnorm.path}`,
            `  Size: ${padstart(String(file.size), 10)}\tBlocks: ${padstart(String(Math.ceil(file.size / 512)), 6)}          IO Block: 4096   regular file`,
            `Device: saddle/virtual\tInode: ${padstart(String(state.files instanceof Map ? state.files.size + 1 : 1), 12)}   Links: 1`,
            `Modify: ${file.updatedat}`,
          ].join('\n'),
          exitCode: 0,
        };
      }
      case 'pwd':
        return { output: '/', exitCode: 0 };
      case 'history': {
        const lines = (Array.isArray(state.history) ? state.history : [])
          .map((entry, index) => `${padstart(String(index + 1), 5)}  ${entry}`);
        return { output: lines.join('\n'), exitCode: 0 };
      }
      case 'man': {
        const topic = argv[1];
        if (topic === undefined) {
          return { output: 'What manual page do you want?', exitCode: 1 };
        }
        const page = manualpages[topic];
        if (page === undefined) {
          return { output: `man: no manual for ${topic} (try: ${Object.keys(manualpages).join(', ')})`, exitCode: 1 };
        }
        return { output: `${topic.toUpperCase()}(1)\n\n  ${page}`, exitCode: 0 };
      }
      case 'clear':
        return { output: '', exitCode: 0, clear: true };
      default:
        return {
          output: `bash: ${head}: command not found (try "help")`,
          exitCode: 127,
        };
    }
  } catch (error) {
    return {
      output: `bash: ${head}: engine error: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
    };
  }
}

/**
 * renders the streaming plan for a workload larger than any host: the
 * demo the terminal shows for "how does a 1.5 tb model run here" - layers
 * stream through a fixed window, the workload size is unbounded.
 * @param {number} totalbytes workload size in bytes.
 * @param {number} windowbytes hot-set budget in bytes.
 * @returns {string} the plan summary lines.
 */

/**
 * renders the layered virtual memory architecture: everything is vram and
 * the only physical layer is the free pool (github, npm cdn and friends -
 * the saddle storage doctrine applied to this engine).
 * @returns {string} the tier summary lines.
 */

/**
 * renders the quantum layer summary: a classical statevector simulator
 * (1-20 qubits), the bb84/e91 key exchange, grover search, dna and 5d
 * optical storage planners - every "quantum" capability is software.
 * @returns {string} the quantum summary lines.
 */
export function quantumdemo() {
  return [
    'saddle quantum layer (100 percent classical simulation)',
    '  simulator   statevector, float64 interleaved re/im, 1-20 qubits',
    '  gates       h x y z s t rx ry rz cnot cz toffoli swap',
    '  algorithms  bellstate, ghz, grover2 (provable), grover3, deutsch, teleport',
    '  protocols   bb84 (1984) with intercept-resend detection, e91 (1991) + chsh',
    '  randomness  quantum-inspired (csprng) with honest anu qrng fallback note',
    '  storage     dna vault (goldman 2013, 215 pb/g, 4 strands, roundtrip proven)',
    '              5d quartz planner (360 tb/disc, 13.8 billion years at room)',
    '              qram bucket-brigade model (giovannetti prl 2008)',
    '  engine: import { quantumsim, runbb84, dnavaultencode } from ./quantum',
  ].join('\n');
}

export function tiersdemo() {
  const ladder = ['ram ~100ns', 'zram ~500ns', 'tmpfs ~1us', 'mmap ~5us', 'sqlite ~10us', 'r2 ~50us'];
  return [
    'saddle tiered virtual memory (everything is vram)',
    '  l1 ram      working set, ephemeral            ~100 ns',
    '  l2 vram     compute-bound identity layer       spoofed',
    '  l3 storage  repos as ram (sqlite kv, lru)     ~10 us',
    '  l4 buckets  hf 10tb + kaggle 20tb + terabox   ~50 us',
    '  physical    github artifacts + ghcr + npm cdn (the only disks)',
    `  ladder      ${ladder.join(' | ')}`,
    '  autoscale   <64mb memfs / <1gb mmap / larger sqlite+r2',
    '  pool        >33 tb free across accounts (see tiers.ts FREEPOOL)',
    '  npm-as-disk 200 mb chunks as .bin.js packages on the cdn farm',
    '  vdr         64-bit bigint addressing up to 9.22 eb',
    '  engine: import { creatiersengine } from the package (./tiers)',
  ].join('\n');
}

export function streamingdemo(totalbytes = 1649267441664, windowbytes = 4 * 1024 * 1024 * 1024) {
  const layerbytes = 512 * 1024 * 1024;
  const count = Math.ceil(totalbytes / layerbytes);
  const batches = Math.ceil(count / Math.max(1, Math.floor(windowbytes / layerbytes)));
  const fmt = (b) => (b >= 1024 ** 4 ? (b / 1024 ** 4).toFixed(2) + ' TB' : (b / 1024 ** 3).toFixed(1) + ' GB');
  return [
    'saddle streaming memory plan',
    `  workload:  ${fmt(totalbytes)} decomposed into ${count} layers of ${layerbytes / 1024 ** 2} MiB`,
    `  window:    ${fmt(windowbytes)} hot-set budget (peak resident)`,
    `  batches:   ${batches} load/run/evict passes over the weights`,
    '  technique: mmap + page cache streams each layer on demand; eviction',
    '             after the last consumer keeps the resident set inside the',
    '             window - the workload size is unbounded, only the window',
    '             is fixed. this is how engines run models larger than ram.',
  ].join('\n');
}
