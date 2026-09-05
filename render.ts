/**
 * render.ts — software rendering stack and gpu identity spoofing for the
 * virtual hardware engine.
 *
 * the module pins the 100% software graphics pipeline verified against
 * primary sources on 2026-08-22:
 * - mesa 26.2.1 stable (released 2026-08-20) with the 26.3-devel mainline
 *   open since 2026-07-15; llvm 22.1.8 (2026-07-10) is the reference
 *   compiler backend and mesa 26.2 is already llvm-22 ready
 * - llvmpipe: opengl 4.6 core profile 100% (161/161 extensions tracked by
 *   mesamatrix), opengl es 3.2 100%, avx-512 selected at runtime by gallivm
 *   (mesa mr !17813), rasterizer thread ceiling lp_max_threads = 32 (mr
 *   31551 raised the previous 16; docs state "up to 32 at this time")
 * - lavapipe: vulkan 1.4 surface since mesa 25.1, khronos-conformant on the
 *   vulkan 1.3 cts (submission 2022-07-19); icd manifest
 *   /usr/share/vulkan/icd.d/lvp_icd.x86_64.json selected through
 *   vk_driver_files (vk_icd_filenames is deprecated by the vulkan loader)
 * - rusticl: opencl 3.1 with same-day spec support in mesa 26.2; sole mesa
 *   opencl frontend since clover was deleted in mesa 25.2; cl_khr_fp16 is
 *   default since mesa 25.2 so only fp64 still needs rusticl_features
 * - xvfb headless glx recipe (man xvfb(1)):
 *   "xvfb :99 -ac -screen 0 1920x1080x24 -nolisten tcp +extension glx
 *    +render -noreset"
 *
 * contexts (25): versioncatalog, llvmpipefacts, cpucapsdomain, lpperfdomain,
 * lavapipefacts, rusticlfacts, xvfbrecipe, gpuspoofdata, pciid, gpuregistry,
 * gpuprofilebuilder, mesaenvbuilder, renderenv, threadadvisor, smiformat,
 * smiadapter, rendertargets, rendererbase, llvmpiperenderer, lavapiperenderer,
 * rusticlrenderer, xvfbdisplay, rendererfactory, rendererproxy, renderprobe
 *
 * patterns: builder (mesaenvbuilder, gpuprofilebuilder), registry
 * (gpuregistry), factory (rendererfactory), proxy (rendererproxy).
 * rules: lowercase identifiers, english jsdoc, third person, no emoji,
 * try/catch catcher on every fallible path, node:* built-ins only, and no
 * hardcoded localhost address anywhere.
 *
 * domain split (v2): this module keeps the software identity stack — mesa
 * environment builders, llvmpipe/lavapipe/rusticl renderers, xvfb and the
 * virtual nvidia-smi adapter renderer. the physical gpu side (vfio passthrough, vgpu
 * slicing, MIG layouts, the verified gpu bank) lives in virtualgpu.ts, and
 * the paravirtual virtio-gpu venus path (`-device virtio-gpu-pci,venus=true`
 * with `hostmem=8g`, or `virtio-gpu-gl blob=on venus=on`) is emitted by the
 * virtualization module that owns the QEMU command line.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { cpus } from 'node:os';
import process from 'node:process';

/* ------------------------------------------------------------------ */
/* context: version catalog (verified 2026-08-22)                      */
/* ------------------------------------------------------------------ */

/** immutable version contract for the software rendering stack. */
interface versioncatalog {
  readonly mesa: string;
  readonly mesadevel: string;
  readonly llvm: string;
  readonly gl: string;
  readonly gles: string;
  readonly vulkan: string;
  readonly opencl: string;
  readonly smidriver: string;
  readonly cudaversion: string;
}

/** stack pinned from primary sources (mesa3d.org, llvm releases, docs.nvidia.com). */
const mesastack = {
  mesa: '26.2.1',
  mesadevel: '26.3-devel',
  llvm: '22.1.8',
  gl: '4.6',
  gles: '3.2',
  vulkan: '1.4',
  opencl: '3.1',
  smidriver: '575.57.08',
  cudaversion: '12.9',
} satisfies versioncatalog;

/* ------------------------------------------------------------------ */
/* context: llvmpipe capability facts                                  */
/* ------------------------------------------------------------------ */

/** llvmpipe capability snapshot (docs.mesa3d.org/drivers/llvmpipe + mesamatrix). */
interface llvmpipefacts {
  readonly glcoreprofile: string;
  readonly glcoreextensions: string;
  readonly glesprofile: string;
  readonly glesextensions: string;
  readonly avx512: string;
  readonly threadceiling: number;
  readonly threadnote: string;
}

const llvmpipe = {
  glcoreprofile: '4.6 core',
  glcoreextensions: '161/161 (100%)',
  glesprofile: '3.2',
  glesextensions: '100%',
  avx512: 'gallivm enables avx-512 at runtime (mesa mr !17813)',
  threadceiling: 32,
  threadnote:
    'lp_max_threads is a compile-time constant; mr 31551 raised 16 to 32; the docs state "up to 32 at this time"',
} satisfies llvmpipefacts;

/** valid values for gallium_override_cpu_caps (docs.mesa3d.org/envvars).
 * no avx2/avx512 value exists: avx-512 is detected at runtime by gallivm. */
const cpucapsdomain = ['nosse', 'sse', 'sse2', 'sse3', 'ssse3', 'sse4.1', 'avx'] as const;
type cpucaps = (typeof cpucapsdomain)[number];

/** valid stages for lp_perf selective no-ops (docs: "see the source code"). */
const lpperfdomain = [
  'no_blend',
  'no_depth',
  'no_alphatest',
  'no_tex',
  'no_linear',
  'no_mipmaps',
  'no_mip_linear',
  'tex_mem',
] as const;
type lpperfstage = (typeof lpperfdomain)[number];

/* ------------------------------------------------------------------ */
/* context: lavapipe and rusticl facts                                 */
/* ------------------------------------------------------------------ */

/** lavapipe (vulkan software) facts verified 2026-08-22. */
interface lavapipefacts {
  readonly vulkan: string;
  readonly conformance: string;
  readonly icdmanifest: string;
  readonly icdenv: string;
  readonly deprecatedicdenv: string;
  readonly extensions: string;
}

const lavapipe = {
  vulkan: '1.4',
  conformance: 'khronos-conformant on the vulkan 1.3 cts (submission 2022-07-19)',
  icdmanifest: '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json',
  icdenv: 'VK_DRIVER_FILES',
  deprecatedicdenv: 'VK_ICD_FILENAMES',
  extensions: '204/303 extensions (67.3%) in mesa 26.2',
} satisfies lavapipefacts;

/** rusticl (opencl software) facts verified 2026-08-22. */
interface rusticlfacts {
  readonly opencl: string;
  readonly clovernote: string;
  readonly fp16note: string;
  readonly features: string;
  readonly devicetype: string;
}

const rusticl = {
  opencl: '3.1',
  clovernote: 'clover was deleted in mesa 25.2; rusticl is the sole mesa opencl frontend',
  fp16note: 'cl_khr_fp16 is default since mesa 25.2 (rusticl_features=fp16 is obsolete)',
  features: 'fp64',
  devicetype: 'gpu',
} satisfies rusticlfacts;

/* ------------------------------------------------------------------ */
/* context: xvfb headless recipe                                       */
/* ------------------------------------------------------------------ */

/** default xvfb geometry documented in the project research. */
const defaultgeometry = '1920x1080x24';

/** builds the validated headless glx argv for xvfb (man xvfb(1)). */
function xvfbargs(display: string, geometry: string): readonly string[] {
  return [
    `:${display}`,
    '-ac',
    '-screen',
    '0',
    geometry,
    '-nolisten',
    'tcp',
    '+extension',
    'GLX',
    '+render',
    '-noreset',
  ];
}

/** picks a random x display number in the 90-99 range; the documented
 * example uses :99, so the random pick avoids colliding with it. */
function randomdisplay(): string {
  try {
    return String(90 + randomInt(10));
  } catch {
    return '94';
  }
}

/* ------------------------------------------------------------------ */
/* context: gpu virtual identity data (verified specs, 2026-08-22)                */
/* ------------------------------------------------------------------ */

/** gpu identity used for spoofing; every field comes from vendor pages,
 * techpowerup and the pci id databases confirmed in the project research.
 * physical passthrough identities live in virtualgpu.ts; this table only
 * feeds the software identity stack (the smi adapter and friends). */
interface gpuspoof {
  readonly name: string;
  readonly vendor: 'nvidia' | 'amd';
  readonly pcivendor: string;
  readonly pcidevice: string;
  readonly vrammib: number;
  readonly memtype: string;
  readonly bandwidthgbs: number;
  readonly tdpw: number;
  readonly arch: string;
  readonly driver: string;
  readonly cuda: string | null;
}

const gpuspoofdata = {
  rtx5090: {
    name: 'NVIDIA RTX 5090',
    vendor: 'nvidia',
    pcivendor: '10DE',
    pcidevice: '2B85',
    vrammib: 32768,
    memtype: 'GDDR7',
    bandwidthgbs: 1792,
    tdpw: 575,
    arch: 'GB202 Blackwell sm_120',
    driver: mesastack.smidriver,
    cuda: mesastack.cudaversion,
  },
  rtxpro6000: {
    name: 'NVIDIA RTX PRO 6000 Blackwell',
    vendor: 'nvidia',
    pcivendor: '10DE',
    pcidevice: '26B5',
    vrammib: 98304,
    memtype: 'GDDR7 ECC',
    bandwidthgbs: 1792,
    tdpw: 600,
    arch: 'GB202 Blackwell workstation',
    driver: mesastack.smidriver,
    cuda: mesastack.cudaversion,
  },
  b200: {
    name: 'NVIDIA B200',
    vendor: 'nvidia',
    pcivendor: '10DE',
    pcidevice: '2665',
    vrammib: 196608,
    memtype: 'HBM3e',
    bandwidthgbs: 8000,
    tdpw: 1000,
    arch: 'GB100 Blackwell dual-die',
    driver: mesastack.smidriver,
    cuda: mesastack.cudaversion,
  },
  rx9070xt: {
    name: 'AMD Radeon RX 9070 XT',
    vendor: 'amd',
    pcivendor: '1002',
    pcidevice: '748E',
    vrammib: 16384,
    memtype: 'GDDR6',
    bandwidthgbs: 640,
    tdpw: 304,
    arch: 'Navi 48 RDNA 4 gfx1201',
    driver: 'adrenalin 26.x / mesa 26.2',
    cuda: null,
  },
  mi350x: {
    name: 'AMD Instinct MI350X',
    vendor: 'amd',
    pcivendor: '1002',
    pcidevice: '75A0',
    vrammib: 294912,
    memtype: 'HBM3e',
    bandwidthgbs: 8000,
    tdpw: 1000,
    arch: 'CDNA 4 gfx950',
    driver: 'ROCm 7.x',
    cuda: null,
  },
} satisfies Record<string, gpuspoof>;

/** renders the canonical "vendor:device" pci id of a virtual identity profile. */
function pciid(profile: gpuspoof): string {
  return `${profile.pcivendor}:${profile.pcidevice}`;
}

/* ------------------------------------------------------------------ */
/* context: gpu profile registry (registry pattern)                    */
/* ------------------------------------------------------------------ */

/** registry of named gpu profiles; the whole engine resolves virtual identity
 * identities exclusively through this registry. */
class gpuregistry {
  #profiles = new Map<string, gpuspoof>();

  /** registers a profile under a name; returns the registry for chaining. */
  register(name: string, profile: gpuspoof): this {
    try {
      this.#profiles.set(name, profile);
      return this;
    } catch (error) {
      throw new Error(`gpu profile registration failed for ${name}: ${errormessage(error)}`);
    }
  }

  /** lists every registered profile name. */
  names(): readonly string[] {
    return [...this.#profiles.keys()];
  }

  /** resolves a profile or undefined when absent. */
  get(name: string): gpuspoof | undefined {
    return this.#profiles.get(name);
  }

  /** resolves a profile or throws with the list of known names. */
  require(name: string): gpuspoof {
    const found = this.#profiles.get(name);
    if (found === undefined) {
      throw new Error(`unknown gpu profile "${name}"; known profiles: ${this.names().join(', ')}`);
    }
    return found;
  }
}

/** default registry seeded with the five verified gpu identities. */
const defaultgpuregistry = new gpuregistry()
  .register('rtx5090', gpuspoofdata.rtx5090)
  .register('rtxpro6000', gpuspoofdata.rtxpro6000)
  .register('b200', gpuspoofdata.b200)
  .register('rx9070xt', gpuspoofdata.rx9070xt)
  .register('mi350x', gpuspoofdata.mi350x);

/* ------------------------------------------------------------------ */
/* context: gpu profile builder (builder pattern)                      */
/* ------------------------------------------------------------------ */

/** fluent builder for custom virtual identity profiles; defaults mirror the rtx 5090. */
class gpuprofilebuilder {
  #name = 'NVIDIA RTX 5090';
  #vendor: gpuspoof['vendor'] = 'nvidia';
  #pcivendor = '10DE';
  #pcidevice = '2B85';
  #vrammib = 32768;
  #memtype = 'GDDR7';
  #bandwidthgbs = 1792;
  #tdpw = 575;
  #arch = 'GB202 Blackwell sm_120';
  #driver = mesastack.smidriver;
  #cuda: string | null = mesastack.cudaversion;

  withname(name: string): this {
    this.#name = name;
    return this;
  }

  withvendor(vendor: gpuspoof['vendor']): this {
    this.#vendor = vendor;
    this.#pcivendor = vendor === 'nvidia' ? '10DE' : '1002';
    return this;
  }

  withpcidevice(device: string): this {
    this.#pcidevice = device;
    return this;
  }

  withvram(mib: number): this {
    this.#vrammib = mib;
    return this;
  }

  withmemtype(memtype: string): this {
    this.#memtype = memtype;
    return this;
  }

  withbandwidth(gbs: number): this {
    this.#bandwidthgbs = gbs;
    return this;
  }

  withtdp(w: number): this {
    this.#tdpw = w;
    return this;
  }

  witharch(arch: string): this {
    this.#arch = arch;
    return this;
  }

  withdriver(driver: string, cuda: string | null): this {
    this.#driver = driver;
    this.#cuda = cuda;
    return this;
  }

  /** validates the profile shape and freezes it into a gpuspoof. */
  build(): gpuspoof {
    if (this.#name.length === 0) {
      throw new Error('gpu profile requires a name');
    }
    if (!/^[0-9A-Fa-f]{4}$/.test(this.#pcidevice)) {
      throw new Error(`gpu profile pci device "${this.#pcidevice}" must be 4 hex digits`);
    }
    if (this.#vrammib <= 0 || this.#bandwidthgbs <= 0 || this.#tdpw <= 0) {
      throw new Error('gpu profile requires positive vram, bandwidth and tdp values');
    }
    return {
      name: this.#name,
      vendor: this.#vendor,
      pcivendor: this.#pcivendor,
      pcidevice: this.#pcidevice.toUpperCase(),
      vrammib: this.#vrammib,
      memtype: this.#memtype,
      bandwidthgbs: this.#bandwidthgbs,
      tdpw: this.#tdpw,
      arch: this.#arch,
      driver: this.#driver,
      cuda: this.#cuda,
    };
  }
}

/* ------------------------------------------------------------------ */
/* context: mesa environment builder (builder pattern)                 */
/* ------------------------------------------------------------------ */

/** fluent builder that assembles the complete validated mesa environment;
 * every variable below is documented at docs.mesa3d.org/envvars.html. */
class mesaenvbuilder {
  #vars = new Map<string, string>();
  #perf = new Set<string>();

  /** forces the software path: llvmpipe through the gallium loader. */
  software(): this {
    this.#vars.set('LIBGL_ALWAYS_SOFTWARE', 'true');
    this.#vars.set('GALLIUM_DRIVER', 'llvmpipe');
    return this;
  }

  /** spoofs glgetstring(gl_version); 4.6 is the llvmpipe maximum. */
  glversion(version: string = mesastack.gl): this {
    this.#vars.set('MESA_GL_VERSION_OVERRIDE', version);
    return this;
  }

  /** spoofs gl_shading_language_version (460 matches gl 4.6). */
  glslversion(version: string = '460'): this {
    this.#vars.set('MESA_GLSL_VERSION_OVERRIDE', version);
    return this;
  }

  /** spoofs the gles version reported by the software driver. */
  glesversion(version: string = mesastack.gles): this {
    this.#vars.set('MESA_GLES_VERSION_OVERRIDE', version);
    return this;
  }

  /** spoofs the vulkan apiversion; cannot exceed the driver instance version. */
  vulkanversion(version: string = mesastack.vulkan): this {
    this.#vars.set('MESA_VK_VERSION_OVERRIDE', version);
    return this;
  }

  /** sets lp_num_threads; 0 lets llvmpipe use every core up to the
   * lp_max_threads=32 ceiling, 1..32 pins an explicit thread count. */
  threads(count: number = 0): this {
    if (count < 0 || count > llvmpipe.threadceiling) {
      throw new Error(`lp_num_threads must be 0..${llvmpipe.threadceiling}`);
    }
    this.#vars.set('LP_NUM_THREADS', String(count));
    return this;
  }

  /** sets lp_native_vector_width; 512 exercises the avx-512 paths even
   * though gallivm picks avx-512 automatically at runtime. */
  vectorwidth(width: 128 | 256 | 512): this {
    this.#vars.set('LP_NATIVE_VECTOR_WIDTH', String(width));
    return this;
  }

  /** overrides reported cpu caps; avx is the highest documented value
   * (there is no avx2/avx512 entry in the envvars documentation). */
  cpucaps(caps: cpucaps): this {
    if (!(cpucapsdomain as readonly string[]).includes(caps)) {
      throw new Error(`gallium_override_cpu_caps must be one of: ${cpucapsdomain.join('|')}`);
    }
    this.#vars.set('GALLIUM_OVERRIDE_CPU_CAPS', caps);
    return this;
  }

  /** adds one lp_perf selective no-op stage (benchmarking aid). */
  perf(stage: lpperfstage): this {
    if (!(lpperfdomain as readonly string[]).includes(stage)) {
      throw new Error(`lp_perf stage must be one of: ${lpperfdomain.join(',')}`);
    }
    this.#perf.add(stage);
    return this;
  }

  /** disables gl error checking (gl_khr_no_error) to cut cpu overhead. */
  noerror(enabled: boolean = true): this {
    this.#vars.set('MESA_NO_ERROR', enabled ? '1' : '0');
    return this;
  }

  /** pins lavapipe through vk_driver_files and enables the headless wsi
   * swapchain; vk_icd_filenames is deprecated and never emitted. */
  lavapipe(icd: string = lavapipe.icdmanifest): this {
    this.#vars.set('VK_DRIVER_FILES', icd);
    this.#vars.set('MESA_VK_WSI_HEADLESS_SWAPCHAIN', '1');
    return this;
  }

  /** enables rusticl on llvmpipe with the gpu device type virtual identity, opencl
   * 3.1 and the fp64 feature (fp16 is default since mesa 25.2). */
  rusticl(): this {
    this.#vars.set('RUSTICL_ENABLE', 'llvmpipe');
    this.#vars.set('RUSTICL_DEVICE_TYPE', rusticl.devicetype);
    this.#vars.set('RUSTICL_CL_VERSION', rusticl.opencl);
    this.#vars.set('RUSTICL_FEATURES', rusticl.features);
    return this;
  }

  /** escape hatch for extra variables; caller keeps full choice. */
  set(key: string, value: string): this {
    this.#vars.set(key, value);
    return this;
  }

  /** freezes the environment into a plain record (lp_perf joined last). */
  build(): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const [key, value] of this.#vars) {
      vars[key] = value;
    }
    if (this.#perf.size > 0) {
      vars.LP_PERF = [...this.#perf].join(',');
    }
    return vars;
  }
}

/* ------------------------------------------------------------------ */
/* context: renderenv presets + thread advisor                         */
/* ------------------------------------------------------------------ */

/** render target selector used by the factory and the presets. */
type rendertarget = 'opengl' | 'gles' | 'vulkan' | 'opencl' | 'xvfb';

/** one-call environment assembly per render target. */
function renderenv(target: rendertarget): Record<string, string> {
  const builder = new mesaenvbuilder();
  switch (target) {
    case 'opengl':
      return builder
        .software()
        .glversion()
        .glslversion()
        .threads()
        .vectorwidth(512)
        .noerror()
        .build();
    case 'gles':
      return builder.software().glesversion().threads().noerror().build();
    case 'vulkan':
      return builder.software().vulkanversion().lavapipe().build();
    case 'opencl':
      return builder.software().rusticl().build();
    case 'xvfb':
      return {};
  }
}

/** advisory thread count: one rasterizer thread per host core bounded by
 * the compile-time lp_max_threads=32 ceiling. */
function advisethreads(hostcores: number = cpus().length): number {
  return Math.max(1, Math.min(hostcores, llvmpipe.threadceiling));
}

/* ------------------------------------------------------------------ */
/* context: smi format helpers (89-char summary table)                 */
/* ------------------------------------------------------------------ */

const smiwidth = 89;
const smicolumns = [40, 24, 21] as const;
const procwidth = 75;

/** right-pad helper that never exceeds the target width. */
function smipad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

/** left-pad helper for right-aligned smi columns. */
function smipadstart(text: string, width: number): string {
  return text.length >= width
    ? text.slice(text.length - width)
    : ' '.repeat(width - text.length) + text;
}

/** full-width border line: "+" plus 87 fill characters plus "+". */
function smiborder(fill: string): string {
  return `+${fill.repeat(smiwidth - 2)}+`;
}

/** full-width content line padded to the 89-char table width. */
function smifull(content: string): string {
  return `|${smipad(content, smiwidth - 2)}|`;
}

/** three-column separator: pipes at fixed offsets 1, 42 and 67. */
function smisep(fill: string): string {
  return (
    '|' +
    fill.repeat(smicolumns[0]) +
    '+' +
    fill.repeat(smicolumns[1]) +
    '+' +
    fill.repeat(smicolumns[2]) +
    '|'
  );
}

/** three-column data row within the 89-char width. */
function smirow(left: string, mid: string, right: string): string {
  return (
    '|' +
    smipad(left, smicolumns[0]) +
    '|' +
    smipad(mid, smicolumns[1]) +
    '|' +
    smipad(right, smicolumns[2]) +
    '|'
  );
}

/** process table content line within the 75-char width. */
function procline(content: string): string {
  return `|${smipad(content, procwidth - 2)}|`;
}

/** process table bottom border. */
function procborder(): string {
  return `+${'-'.repeat(procwidth - 2)}+`;
}

const smiweekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const smimonths = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** formats the nvidia-smi timestamp "day-of-week month day hh:mm:ss year". */
function formatstamp(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return (
    `${smiweekdays[date.getDay()]} ${smimonths[date.getMonth()]} ${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())} ${date.getFullYear()}`
  );
}

/* ------------------------------------------------------------------ */
/* context: virtual nvidia-smi adapter generator                                  */
/* ------------------------------------------------------------------ */

/** process row of the nvidia-smi processes table. */
interface smiprocess {
  readonly gpu: number;
  readonly gi: number;
  readonly ci: number;
  readonly pid: number;
  readonly type: 'C' | 'G' | 'C+G';
  readonly name: string;
  readonly memorymib: number;
}

/** builds a full virtual nvidia-smi adapter report; the header pins driver
 * 575.57.08 and cuda 12.9 exactly as verified in the project research.
 * notes: perf states span p0-p12, compute modes are default or exclusive
 * process, mig is reported as n/a when disabled and fan speed may legally
 * exceed 100% per the nvidia-smi documentation. */
class smiadapterbuilder {
  readonly #profile: gpuspoof;
  readonly #index: number;
  #memusedmib = 0;
  #util = 0;
  #temperature = 41;
  #fanspeed = 30;
  #powerw: number;
  #ecc = 'N/A';
  #computemode = 'Default';
  #processes: smiprocess[] = [];

  constructor(profile: gpuspoof, index = 0) {
    this.#profile = profile;
    this.#index = index;
    this.#powerw = Math.max(10, Math.round(profile.tdpw * 0.04));
  }

  withmemused(mib: number): this {
    this.#memusedmib = mib;
    return this;
  }

  withutil(percent: number): this {
    this.#util = percent;
    return this;
  }

  withtemperature(celsius: number): this {
    this.#temperature = celsius;
    return this;
  }

  withfanspeed(percent: number): this {
    this.#fanspeed = percent;
    return this;
  }

  withpower(watts: number): this {
    this.#powerw = watts;
    return this;
  }

  withecc(text: string): this {
    this.#ecc = text;
    return this;
  }

  withcomputemode(mode: 'Default' | 'Exclusive Process'): this {
    this.#computemode = mode;
    return this;
  }

  withprocess(entry: smiprocess): this {
    this.#processes.push(entry);
    return this;
  }

  /** derives a realistic bus id from the gpu index. */
  #busid(): string {
    const bus = String(1 + this.#index).padStart(2, '0');
    return `00000000:${bus}:00.0`;
  }

  /** renders the complete report; the summary table is exactly 89 chars. */
  build(): string {
    try {
      const head =
        ' NVIDIA-SMI ' +
        mesastack.smidriver +
        ' '.repeat(13) +
        'Driver Version: ' +
        mesastack.smidriver +
        ' '.repeat(6) +
        'CUDA Version: ' +
        mesastack.cudaversion;
      const lines: string[] = [
        formatstamp(new Date()),
        smiborder('-'),
        smifull(head),
        smisep('-'),
        smirow(
          smipad(' GPU  Name', 27) + smipad('Persistence-M', 13),
          smipad(' Bus-Id          Disp.A', 24),
          ` ${smipadstart('Volatile Uncorr. ECC', 20)}`,
        ),
        smirow(
          smipad(' Fan  Temp   Perf      Pwr:Usage/Cap', 40),
          smipad('         Memory-Usage', 24),
          ` ${smipadstart('GPU-Util  Compute M.', 20)}`,
        ),
        smisep('='),
        smirow(
          smipad(`   ${this.#index}  ${this.#profile.name}`, 36) + smipad('Off', 4),
          smipad(`   ${this.#busid()}  Off`, 24),
          ` ${smipadstart(this.#ecc, 20)}`,
        ),
        smirow(
          smipad(
            ` ${this.#fanspeed}%   ${this.#temperature}C  P0   ${this.#powerw}W / ${this.#profile.tdpw}W`,
            40,
          ),
          smipadstart(`${this.#memusedmib}MiB / ${this.#profile.vrammib}MiB`, 24),
          smipadstart(`${this.#util}%`, 10) + smipad(`  ${this.#computemode}`, 11),
        ),
        smirow('', '', ''),
        smiborder('-'),
        '',
        'Processes:',
        procline(
          smipad(' GPU  GI  CI', 20) +
            smipad('PID', 7) +
            smipad('Type', 8) +
            smipad('Process name', 27) +
            smipad('GPU Memory', 11),
        ),
        procline('='.repeat(procwidth - 2)),
      ];
      if (this.#processes.length === 0) {
        lines.push(procline('  No running processes found'));
      } else {
        for (const entry of this.#processes) {
          lines.push(
            procline(
              smipad(` ${entry.gpu}   ${entry.gi}   ${entry.ci}`, 20) +
                smipad(String(entry.pid), 7) +
                smipad(entry.type, 8) +
                smipad(entry.name, 27) +
                smipad(`${entry.memorymib}MiB`, 11),
            ),
          );
        }
      }
      lines.push(procborder());
      return lines.join('\n');
    } catch (error) {
      throw new Error(`virtual nvidia-smi adapter report failed: ${errormessage(error)}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* context: run helper + error message catcher                         */
/* ------------------------------------------------------------------ */

/** result of a completed child process. */
interface runresult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** normalizes an unknown thrown value into a message string. */
function errormessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** runs a command to completion under a merged environment; every spawn
 * path is wrapped in a try/catch catcher for later tracing. */
function run(
  command: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<runresult> {
  return new Promise<runresult>((resolve, reject) => {
    try {
      const child = spawn(command, args, { env: { ...process.env, ...env } });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', (error: Error) => {
        reject(new Error(`${command} failed to spawn: ${error.message}`));
      });
      child.once('close', (code: number | null) => {
        resolve({ code: code ?? -1, stdout, stderr });
      });
    } catch (error) {
      reject(new Error(`${command} failed: ${errormessage(error)}`));
    }
  });
}

/** returns the first regex capture group of a text or null. */
function firstmatch(text: string, pattern: RegExp): string | null {
  const found = pattern.exec(text);
  return found === null ? null : (found[1] ?? '').trim() || null;
}

/* ------------------------------------------------------------------ */
/* context: renderer base class                                        */
/* ------------------------------------------------------------------ */

/** shared renderer state: environment, optional child process and a
 * trace buffer used as the embedded debugger for later tracing. */
abstract class rendererbase {
  #child: ChildProcess | null = null;
  readonly #label: string;
  readonly #vars: Record<string, string>;
  readonly #trace: string[] = [];

  protected constructor(label: string, vars: Record<string, string>) {
    this.#label = label;
    this.#vars = { ...vars };
  }

  get label(): string {
    return this.#label;
  }

  /** environment copy for the render target. */
  get env(): Record<string, string> {
    return { ...this.#vars };
  }

  /** whether the owned helper process is alive. */
  get running(): boolean {
    return this.#child !== null && this.#child.exitCode === null && !this.#child.killed;
  }

  /** accumulated trace entries (error catcher output). */
  get traces(): readonly string[] {
    return this.#trace;
  }

  /** records a trace entry; never throws. */
  protected note(message: string): void {
    this.#trace.push(`${new Date().toISOString()} ${message}`);
  }

  /** spawns a long-lived helper under the renderer environment. */
  protected launch(command: string, args: readonly string[]): ChildProcess {
    const child = spawn(command, args, {
      env: { ...process.env, ...this.#vars },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', (error: Error) => {
      this.note(`helper ${command} error: ${error.message}`);
    });
    this.#child = child;
    return child;
  }

  /** verifies the virtualized context with the target-specific info tool. */
  abstract verify(): Promise<string>;

  /** terminates the helper; escalates to SIGKILL after a grace period. */
  async stop(): Promise<void> {
    const child = this.#child;
    if (child === null || child.exitCode !== null) {
      this.#child = null;
      return;
    }
    try {
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
        }),
        sleep(2000).then(() => false),
      ]);
      if (exited === false && child.exitCode === null) {
        child.kill('SIGKILL');
      }
      this.note(`helper for ${this.#label} stopped`);
    } catch (error) {
      this.note(`stop failed for ${this.#label}: ${errormessage(error)}`);
    } finally {
      this.#child = null;
    }
  }

  /** `using` disposal hook: stops the helper without awaiting. */
  [Symbol.dispose](): void {
    try {
      void this.stop();
    } catch (error) {
      this.note(`dispose failed for ${this.#label}: ${errormessage(error)}`);
    }
  }
}

/** promise-based sleep used by the stop escalation. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* ------------------------------------------------------------------ */
/* context: llvmpipe / lavapipe / rusticl renderers                    */
/* ------------------------------------------------------------------ */

/** opengl/gles renderer backed by llvmpipe. */
class llvmpiperenderer extends rendererbase {
  constructor(env?: Record<string, string>) {
    super('llvmpipe', env === undefined ? renderenv('opengl') : env);
  }

  /** probes glxinfo -b and returns the core profile version string. */
  override async verify(): Promise<string> {
    try {
      const result = await run('glxinfo', ['-B'], this.env);
      const version = firstmatch(result.stdout, /core profile version string:\s*(.+)/);
      this.note(`glxinfo exit ${result.code}: ${version ?? 'no version line'}`);
      return version ?? '';
    } catch (error) {
      throw new Error(`llvmpipe verify failed: ${errormessage(error)}`);
    }
  }

  /** runs a workload command inside the llvmpipe environment. */
  async runworkload(command: string, args: readonly string[]): Promise<runresult> {
    return run(command, args, this.env);
  }
}

/** vulkan renderer backed by lavapipe. */
class lavapiperenderer extends rendererbase {
  constructor(env?: Record<string, string>) {
    super('lavapipe', env === undefined ? renderenv('vulkan') : env);
  }

  /** probes vulkaninfo --summary and returns the api version. */
  override async verify(): Promise<string> {
    try {
      const result = await run('vulkaninfo', ['--summary'], this.env);
      const version = firstmatch(result.stdout, /apiVersion\s*:\s*([\d.]+)/);
      this.note(`vulkaninfo exit ${result.code}: ${version ?? 'no version line'}`);
      return version ?? '';
    } catch (error) {
      throw new Error(`lavapipe verify failed: ${errormessage(error)}`);
    }
  }

  /** runs a workload command inside the lavapipe environment. */
  async runworkload(command: string, args: readonly string[]): Promise<runresult> {
    return run(command, args, this.env);
  }
}

/** opencl renderer backed by rusticl. */
class rusticlrenderer extends rendererbase {
  constructor(env?: Record<string, string>) {
    super('rusticl', env === undefined ? renderenv('opencl') : env);
  }

  /** probes clinfo and returns the reported opencl version. */
  override async verify(): Promise<string> {
    try {
      const result = await run('clinfo', [], this.env);
      const version = firstmatch(result.stdout, /OpenCL (\d+\.\d+)/);
      this.note(`clinfo exit ${result.code}: ${version ?? 'no version line'}`);
      return version ?? '';
    } catch (error) {
      throw new Error(`rusticl verify failed: ${errormessage(error)}`);
    }
  }

  /** runs a workload command inside the rusticl environment. */
  async runworkload(command: string, args: readonly string[]): Promise<runresult> {
    return run(command, args, this.env);
  }
}

/* ------------------------------------------------------------------ */
/* context: xvfb display server                                        */
/* ------------------------------------------------------------------ */

/** options for the xvfb headless display server. */
interface xvfboptions {
  readonly display?: string;
  readonly geometry?: string;
  readonly env?: Record<string, string>;
}

/** headless glx display server; the child is terminated on dispose. */
class xvfbdisplay extends rendererbase {
  readonly #displaynumber: string;
  readonly #geometry: string;

  constructor(options: xvfboptions = {}) {
    const displaynumber = options.display ?? randomdisplay();
    super('xvfb', { DISPLAY: `:${displaynumber}`, ...options.env });
    this.#displaynumber = displaynumber;
    this.#geometry = options.geometry ?? defaultgeometry;
  }

  /** display number without the leading colon (for example "94"). */
  get displaynumber(): string {
    return this.#displaynumber;
  }

  /** geometry string in the widthxheightxdepth form. */
  get geometry(): string {
    return this.#geometry;
  }

  /** boots xvfb and waits for the socket grace period. */
  async start(): Promise<void> {
    try {
      const child = this.launch('Xvfb', xvfbargs(this.#displaynumber, this.#geometry));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 600);
        child.once('exit', (code: number | null) => {
          clearTimeout(timer);
          reject(new Error(`xvfb exited early with code ${code ?? 'signal'}`));
        });
        child.once('error', (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      this.note(`xvfb serving display :${this.#displaynumber} at ${this.#geometry}`);
    } catch (error) {
      throw new Error(`xvfb start failed: ${errormessage(error)}`);
    }
  }

  /** reports the served display. */
  override async verify(): Promise<string> {
    return `display :${this.#displaynumber} geometry ${this.#geometry}`;
  }
}

/* ------------------------------------------------------------------ */
/* context: renderer factory (factory pattern)                         */
/* ------------------------------------------------------------------ */

/** creates concrete renderers per target; the preset environment can be
 * overridden per call (user choice), for example to merge an xvfb display. */
class rendererfactory {
  readonly #builders = new Map<rendertarget, (env?: Record<string, string>) => rendererbase>();

  constructor() {
    this.#builders.set('opengl', (env) => new llvmpiperenderer(env));
    this.#builders.set('gles', (env) => new llvmpiperenderer({ ...renderenv('gles'), ...env }));
    this.#builders.set('vulkan', (env) => new lavapiperenderer(env));
    this.#builders.set('opencl', (env) => new rusticlrenderer(env));
    this.#builders.set('xvfb', (env) => new xvfbdisplay({ env }));
  }

  /** registers a custom builder for a target (extensibility hook). */
  register(target: rendertarget, builder: (env?: Record<string, string>) => rendererbase): this {
    this.#builders.set(target, builder);
    return this;
  }

  /** instantiates the renderer for a target. */
  create(target: rendertarget, env?: Record<string, string>): rendererbase {
    const build = this.#builders.get(target);
    if (build === undefined) {
      throw new Error(`unknown render target "${target}"`);
    }
    return build(env);
  }
}

/* ------------------------------------------------------------------ */
/* context: renderer proxy (proxy pattern)                             */
/* ------------------------------------------------------------------ */

/** environment keys that define the virtual identity and can never be overridden. */
const frozenenvkeys = [
  'LIBGL_ALWAYS_SOFTWARE',
  'GALLIUM_DRIVER',
  'VK_DRIVER_FILES',
  'RUSTICL_ENABLE',
  'LP_NUM_THREADS',
] as const;

/** proxy that guards the renderer environment, keeps an audit trail and
 * delegates lifecycle calls to the wrapped renderer. */
class rendererproxy {
  readonly #inner: rendererbase;
  readonly #frozen: ReadonlySet<string>;
  readonly #audit: string[] = [];

  constructor(inner: rendererbase, frozen: readonly string[] = frozenenvkeys) {
    this.#inner = inner;
    this.#frozen = new Set(frozen);
  }

  get label(): string {
    return this.#inner.label;
  }

  /** environment copy; reads are recorded in the audit trail. */
  get env(): Record<string, string> {
    this.#audit.push(`read env for ${this.#inner.label}`);
    return this.#inner.env;
  }

  /** accumulated audit entries. */
  get audit(): readonly string[] {
    return this.#audit;
  }

  /** merges overrides over the renderer environment while refusing to
   * clobber the frozen virtual identity keys; returns the merged copy. */
  patchenv(overrides: Record<string, string>): Record<string, string> {
    const merged: Record<string, string> = { ...this.#inner.env };
    for (const [key, value] of Object.entries(overrides)) {
      if (this.#frozen.has(key)) {
        this.#audit.push(`refused override of ${key}`);
        continue;
      }
      merged[key] = value;
    }
    return merged;
  }

  /** delegates verification. */
  async verify(): Promise<string> {
    return this.#inner.verify();
  }

  /** delegates disposal. */
  [Symbol.dispose](): void {
    this.#inner[Symbol.dispose]();
  }
}

/* ------------------------------------------------------------------ */
/* context: render probe                                               */
/* ------------------------------------------------------------------ */

/** probe report across the three software apis. */
interface probereport {
  readonly opengl: string;
  readonly vulkan: string;
  readonly opencl: string;
  readonly notes: readonly string[];
}

/** probes glxinfo, vulkaninfo and clinfo under the given environment and
 * parses the virtualized version strings; failures degrade into notes. */
async function renderprobe(env: Record<string, string>): Promise<probereport> {
  const notes: string[] = [];
  let opengl = '';
  let vulkan = '';
  let opencl = '';
  try {
    const glx = await run('glxinfo', ['-B'], env);
    opengl = firstmatch(glx.stdout, /core profile version string:\s*(.+)/) ?? '';
    if (opengl === '') notes.push('glxinfo returned no core profile version line');
  } catch (error) {
    notes.push(`glxinfo failed: ${errormessage(error)}`);
  }
  try {
    const vk = await run('vulkaninfo', ['--summary'], env);
    vulkan = firstmatch(vk.stdout, /apiVersion\s*:\s*([\d.]+)/) ?? '';
    if (vulkan === '') notes.push('vulkaninfo returned no apiVersion line');
  } catch (error) {
    notes.push(`vulkaninfo failed: ${errormessage(error)}`);
  }
  try {
    const cl = await run('clinfo', [], env);
    opencl = firstmatch(cl.stdout, /OpenCL (\d+\.\d+)/) ?? '';
    if (opencl === '') notes.push('clinfo returned no opencl version line');
  } catch (error) {
    notes.push(`clinfo failed: ${errormessage(error)}`);
  }
  return { opengl, vulkan, opencl, notes };
}

/* ------------------------------------------------------------------ */
/* context: end-to-end demo with `using` disposal                      */
/* ------------------------------------------------------------------ */

/** boots xvfb, assembles the full software environment (opengl + vulkan +
 * opencl presets) and probes all three apis; every resource is released
 * through the `using` disposal at scope exit. */
export async function renderdemo(profilename: string = 'rtx5090'): Promise<probereport> {
  const profile = defaultgpuregistry.require(profilename);
  using display = new xvfbdisplay({ env: { VHE_GPU_PROFILE: profile.name } });
  await display.start();
  const env: Record<string, string> = {
    ...display.env,
    ...renderenv('opengl'),
    ...renderenv('vulkan'),
    ...renderenv('opencl'),
  };
  return renderprobe(env);
}

export type {
  cpucaps,
  gpuspoof,
  lpperfstage,
  probereport,
  rendertarget,
  runresult,
  smiprocess,
  xvfboptions,
};
export {
  advisethreads,
  cpucapsdomain,
  defaultgeometry,
  defaultgpuregistry,
  gpuprofilebuilder,
  gpuregistry,
  gpuspoofdata,
  lavapipe,
  llvmpipe,
  mesaenvbuilder,
  mesastack,
  pciid,
  randomdisplay,
  renderenv,
  rendererfactory,
  rendererproxy,
  renderprobe,
  run,
  rusticl,
  smiadapterbuilder,
  xvfbargs,
  xvfbdisplay,
};
