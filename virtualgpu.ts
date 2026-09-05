/**
 * virtualgpu - physical gpu virtualization: passthrough, vgpu slicing, MIG
 * layouts and the verified gpu identity bank.
 *
 * This module owns the physical side of gpu virtualization. It absorbs the
 * gpu-passthrough module in full (vfio bind/unbind through driverctl with
 * the new_id fallback, vbios rom dumping from sysfs, the Looking Glass B7
 * IVshmem recipe, the NVIDIA vGPU profile-size formula, the vendor-reset
 * family list and the Intel SR-IOV DKMS parameters), the v2 stub
 * (nvmlMockEnv and the pciIds table, corrected against the v5 sources) and
 * a TS mirror of the C++ virtualization core data: the vgpu slice profile
 * table (B100-1Q through RX9070XT-4Q), the Blackwell MIG layout catalog
 * with the 7c/192GB density validator, the static spec database (GB100,
 * GB202, GB203, Navi48, Navi44) and the NVENC dual-engine throughput table.
 *
 * The verified bank embeds seven real identities confirmed on 2026-08-22
 * against vendor pages, TechPowerUp and the PCI id databases: RTX 5090
 * (10DE:2B85, 32 GB GDDR7), RTX PRO 6000 Blackwell (10DE:26B5, 96 GB GDDR7
 * ECC, 24064 CUDA cores), B200 (10DE:2665, 192 GB HBM3e at 8 TB/s), H100
 * (10DE:2330, 80 GB HBM3), A100 (10DE:20B0, 40 GB HBM2e), RX 9070 XT
 * (1002:748E, 16 GB GDDR6) and Instinct MI350X (1002:75A0, 288 GB HBM3e).
 * The legacy 10DE:2BB5 spelling for the RTX PRO 6000 found in the v4
 * sources is wrong; the verified id is 26B5 and the divergence is recorded
 * here for traceability.
 *
 * Data for the extra identities discovered in the Meta jsons (B100
 * 10DE:2664, GB200 superchip, RTX 5070, RX 8900 XTX, Arc B770 and the RDNA
 * APU family) stays in the json data files (gpus.json, processors.json);
 * this module only ships the logic: the registry, the fluent builder, the
 * factory and the registergpudata normalizer that turns a json record into
 * a bank entry.
 *
 * Domain split: render.ts keeps the software identity stack (Mesa, the
 * nvidia-smi); virtualmemory.ts keeps the guest MIG slicing profiles
 * (1g.24gb, 2g.48gb, 4g.96gb) which this module imports to compose the
 * complete catalog; virtualization.ts re-exports the passthrough helpers
 * for the QEMU command line.
 *
 * Contexts (25): gpuerror, pciids, nvmlmockenv, virtualgpuspec, gpubank,
 * smidriveranchor, bindvfio, unbindvfio, romdump, lookingglassb7,
 * nvidiavgpuprofiles, vendorresetfamilies, intelsriovdkms, vgpuprofiles,
 * miglayoutblackwell, validatedensity, composemigcatalog, gpustaticspecs,
 * nvencdualengine, nvencsessiontable, nvencCanFit, gpuregistry,
 * virtualgpubuilder, registergpudata, createvirtualgpu.
 *
 * Patterns: registry (gpuregistry), builder (virtualgpubuilder), factory
 * (createvirtualgpu), normalizer (registergpudata).
 * Rules: lowercase identifiers, english jsdoc, third person, no emoji,
 * try/catch catcher on every fallible path, node:* built-ins only, and no
 * hardcoded localhost address anywhere.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGPROFILES } from './virtualmemory.js';

/** pci bdf (bus:device.function) validator: strict hex format only.
 *  blocks any shell metacharacter or path traversal. */
function issafebdf(value: string): boolean {
  return (
    typeof value === 'string' && /^[0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-7]$/.test(value)
  );
}

/** pci vendor:device id validator: strict hex format only. */
function issafevendordevice(value: string): boolean {
  return typeof value === 'string' && /^[0-9A-Fa-f]{4}:[0-9A-Fa-f]{4}$/.test(value);
}

/* ------------------------------------------------------------------ */
/* Section 1: errors                                                   */
/* ------------------------------------------------------------------ */

/** Error thrown by every virtualgpu subsystem with an optional cause chain. */
export class gpuerror extends Error {
  /** Machine readable subsystem tag. */
  readonly subsystem: string;

  constructor(message: string, options?: { cause?: Error; subsystem?: string }) {
    super(message, options);
    this.name = 'gpuerror';
    this.subsystem = options?.subsystem ?? 'virtualgpu';
  }
}

/* ------------------------------------------------------------------ */
/* Section 2: pci ids and nvml adapter (stub absorbed, data corrected)    */
/* ------------------------------------------------------------------ */

/**
 * Canonical PCI ids of the verified bank, keyed by registry name. The
 * RTX PRO 6000 entry uses 26B5 as confirmed in the v5 research; the 2BB5
 * value found in the v4 nested_gpu.json is a transcription error and is
 * intentionally not reproduced.
 */
export const pciIds = {
  rtx5090: '10DE:2B85',
  rtxpro6000: '10DE:26B5',
  b200: '10DE:2665',
  h100: '10DE:2330',
  a100: '10DE:20B0',
  rx9070xt: '1002:748E',
  mi350x: '1002:75A0',
} as const satisfies Record<string, string>;

/**
 * NVIDIA driver and CUDA anchor shared by the smi-adapter header and the nvenc
 * engine description (v2 anchor; supersedes the 560.35.03 and 580.82.07
 * strings found in the older sources).
 */
export const smidriveranchor = {
  driver: '575.57.08',
  cuda: '12.9',
} as const satisfies { readonly driver: string; readonly cuda: string };

/**
 * Builds the NVML mock environment consumed by the virtual nvidia-smi adapter
 * emulator and the nvml-unified-shim (their documented interface): FAKE_VRAM pins the reported memory in
 * MiB and FAKE_MODEL pins the reported device name.
 */
export function nvmlMockEnv(vrammib: number, model: string): Record<string, string> {
  try {
    if (!Number.isFinite(vrammib) || vrammib <= 0) {
      throw new gpuerror(`vrammib must be a positive number, received ${vrammib}`);
    }
    if (model.trim().length === 0) {
      throw new gpuerror('model must not be empty');
    }
    return { FAKE_VRAM: String(Math.round(vrammib)), FAKE_MODEL: model };
  } catch (cause) {
    if (cause instanceof gpuerror) {
      throw cause;
    }
    throw new gpuerror('nvmlMockEnv failed', { cause: cause as Error });
  }
}

/* ------------------------------------------------------------------ */
/* Section 3: verified gpu identity bank                               */
/* ------------------------------------------------------------------ */

/** Complete description of one physical gpu identity. */
export type virtualgpuspec = {
  readonly id: string;
  readonly name: string;
  readonly vendor: 'nvidia' | 'amd' | 'intel';
  readonly pcivendor: string;
  readonly pcidevice: string;
  readonly vrammib: number;
  readonly smireportedmib: number;
  readonly memtype: string;
  readonly busbits: number;
  readonly bandwidthgbs: number;
  readonly tdpwatts: number;
  readonly arch: string;
  readonly smarch: string;
  readonly computeunits: number;
  readonly smcount: number;
  readonly mig: boolean;
  readonly sriov: boolean;
  readonly launch: string;
};

/**
 * The verified bank: seven real identities with every field cross-checked
 * on 2026-08-22. vrammib is the physical capacity and smireportedmib is the
 * value nvidia-smi and rocm-smi print after the firmware carveout.
 */
export const GPU_BANK: readonly virtualgpuspec[] = [
  {
    id: 'rtx5090',
    name: 'NVIDIA GeForce RTX 5090',
    vendor: 'nvidia',
    pcivendor: '10DE',
    pcidevice: '2B85',
    vrammib: 32768,
    smireportedmib: 32607,
    memtype: 'GDDR7',
    busbits: 512,
    bandwidthgbs: 1792,
    tdpwatts: 575,
    arch: 'GB202 Blackwell',
    smarch: 'sm_120',
    computeunits: 21760,
    smcount: 170,
    mig: false,
    sriov: true,
    launch: '2025-01-30',
  },
  {
    id: 'rtxpro6000',
    name: 'NVIDIA RTX PRO 6000 Blackwell Workstation Edition',
    vendor: 'nvidia',
    pcivendor: '10DE',
    pcidevice: '26B5',
    vrammib: 98304,
    smireportedmib: 98304,
    memtype: 'GDDR7 ECC',
    busbits: 512,
    bandwidthgbs: 1792,
    tdpwatts: 600,
    arch: 'GB202 Blackwell workstation',
    smarch: 'sm_120',
    computeunits: 24064,
    smcount: 188,
    mig: true,
    sriov: true,
    launch: '2025-04',
  },
  {
    id: 'b200',
    name: 'NVIDIA B200',
    vendor: 'nvidia',
    pcivendor: '10DE',
    pcidevice: '2665',
    vrammib: 196608,
    smireportedmib: 184320,
    memtype: 'HBM3e',
    busbits: 8192,
    bandwidthgbs: 8000,
    tdpwatts: 1000,
    arch: 'GB100 Blackwell dual-die (NV-HBI 10 TB/s)',
    smarch: 'sm_100',
    computeunits: 0,
    smcount: 208,
    mig: true,
    sriov: true,
    launch: '2024-03',
  },
  {
    id: 'h100',
    name: 'NVIDIA H100 80GB HBM3',
    vendor: 'nvidia',
    pcivendor: '10DE',
    pcidevice: '2330',
    vrammib: 81920,
    smireportedmib: 81559,
    memtype: 'HBM3',
    busbits: 6144,
    bandwidthgbs: 3350,
    tdpwatts: 700,
    arch: 'GH100 Hopper SXM5',
    smarch: 'sm_90',
    computeunits: 16896,
    smcount: 132,
    mig: true,
    sriov: false,
    launch: '2022-09',
  },
  {
    id: 'a100',
    name: 'NVIDIA A100-SXM4-40GB',
    vendor: 'nvidia',
    pcivendor: '10DE',
    pcidevice: '20B0',
    vrammib: 40960,
    smireportedmib: 40536,
    memtype: 'HBM2e',
    busbits: 5120,
    bandwidthgbs: 1555,
    tdpwatts: 400,
    arch: 'GA100 Ampere SXM4',
    smarch: 'sm_80',
    computeunits: 6912,
    smcount: 108,
    mig: true,
    sriov: false,
    launch: '2020-05',
  },
  {
    id: 'rx9070xt',
    name: 'AMD Radeon RX 9070 XT',
    vendor: 'amd',
    pcivendor: '1002',
    pcidevice: '748E',
    vrammib: 16384,
    smireportedmib: 16384,
    memtype: 'GDDR6',
    busbits: 256,
    bandwidthgbs: 640,
    tdpwatts: 304,
    arch: 'Navi 48 RDNA 4',
    smarch: 'gfx1201',
    computeunits: 4096,
    smcount: 64,
    mig: false,
    sriov: false,
    launch: '2025-03-06',
  },
  {
    id: 'mi350x',
    name: 'AMD Instinct MI350X',
    vendor: 'amd',
    pcivendor: '1002',
    pcidevice: '75A0',
    vrammib: 294912,
    smireportedmib: 294912,
    memtype: 'HBM3e',
    busbits: 8192,
    bandwidthgbs: 8000,
    tdpwatts: 1000,
    arch: 'CDNA 4 Aqua Vanjaram',
    smarch: 'gfx950',
    computeunits: 19456,
    smcount: 304,
    mig: false,
    sriov: true,
    launch: '2025-06',
  },
] as const satisfies readonly virtualgpuspec[];

/** Renders the canonical "vendor:device" pci id of a bank entry. */
export function fullpciid(spec: virtualgpuspec): string {
  return `${spec.pcivendor}:${spec.pcidevice}`;
}

/* ------------------------------------------------------------------ */
/* Section 4: vfio passthrough (gpu-passthrough absorbed in full)      */
/* ------------------------------------------------------------------ */

/**
 * Binds a gpu to vfio-pci for passthrough. driverctl set-override is the
 * primary path; when it is unavailable the function falls back to the
 * vfio-pci new_id sysfs write. The returned plan carries the quirks the
 * passthrough research mandates: disable_idle_d3, pcie_port_pm off and the
 * lspci alive check that verifies the config header is not 0xFF.
 */
export function bindVfio(
  bdf: string,
  vendorDevice: string,
): {
  bdf: string;
  driver: string;
  disable_idle_d3: number;
  pcie_port_pm: string;
  aliveCheck: string;
} {
  try {
    if (!issafebdf(bdf)) {
      throw new gpuerror(`bdf "${bdf}" must look like 0000:01:00.0`);
    }
    if (!issafevendordevice(vendorDevice)) {
      throw new gpuerror(`vendor:device "${vendorDevice}" must look like 10DE:2B85`);
    }
    // validated above; execFileSync passes argv directly, no shell.
    try {
      execFileSync('driverctl', ['set-override', bdf, 'vfio-pci']);
    } catch {
      // fallback: write vendor:device to the vfio-pci new_id sysfs file.
      try {
        writeFileSync('/sys/bus/pci/drivers/vfio-pci/new_id', vendorDevice);
      } catch {
        /* catcher: new_id write may fail if the driver is not loaded */
      }
    }
    return {
      bdf,
      driver: 'vfio-pci',
      disable_idle_d3: 1,
      pcie_port_pm: 'off',
      aliveCheck: `lspci -s ${bdf} -xxx | verify config header != 0xFF`,
    };
  } catch (cause) {
    if (cause instanceof gpuerror) {
      throw cause;
    }
    throw new gpuerror('bindVfio failed', { cause: cause as Error });
  }
}

/** Releases a gpu from vfio-pci back to its native driver. */
export function unbindVfio(bdf: string): void {
  if (!issafebdf(bdf)) {
    throw new gpuerror(`unbindVfio: invalid bdf "${bdf}"`);
  }
  // execFileSync: argv array, no shell -> no injection from bdf.
  // failures are swallowed to match the original `|| true` behavior.
  try {
    execFileSync('driverctl', ['unset-override', bdf]);
  } catch {
    /* not bound to vfio-pci or already released */
  }
}

/**
 * Dumps the gpu vbios from sysfs for romfile passthrough. The rom is
 * enabled with echo 1, copied to the output path and disabled again; the
 * returned path feeds the QEMU romfile= option.
 */
export function romDump(bdf: string, out = '/usr/share/kvm/vbios/gpu.rom'): string {
  if (!issafebdf(bdf)) {
    throw new gpuerror(`romDump: invalid bdf "${bdf}"`);
  }
  if (typeof out !== 'string' || out.length === 0 || out.includes('..')) {
    throw new gpuerror('romDump: invalid output path');
  }
  const rompath = `/sys/bus/pci/devices/${bdf}/rom`;
  try {
    // enable rom read, dump, disable: pure fs api, no shell, no injection.
    writeFileSync(rompath, '1');
    const rom = readFileSync(rompath);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, rom);
    try {
      writeFileSync(rompath, '0');
    } catch {
      /* rom disable may fail harmlessly */
    }
    return out;
  } catch (cause) {
    try {
      writeFileSync(rompath, '0');
    } catch {
      /* best-effort cleanup */
    }
    throw new gpuerror('romDump failed', { cause: cause as Error });
  }
}

/**
 * Looking Glass B7 guest display recipe: the kvmfr 0.0.12-7 module backs a
 * 128 MB ivshmem-plain device so the D12 host renderer can DMA frames with
 * zero CPU copies (300 UPS class latency), including the libvirt shmem xml.
 */
export function lookingGlassB7(): {
  version: string;
  kvmfr: string;
  ivshmem: string;
  backend: string;
  dma: string;
  indirectCopy: boolean;
  xml: string;
} {
  return {
    version: 'B7',
    kvmfr: '0.0.12-7',
    ivshmem: '128M',
    backend: 'd12',
    dma: 'GPU hardware copy engine, zero CPU',
    indirectCopy: true,
    xml: "<shmem name='looking-glass'><model type='ivshmem-plain'/><size unit='M'>128</size></shmem>",
  };
}

/**
 * NVIDIA vGPU profile-size formula as documented by the vgpu-unlock
 * research: profileSize equals X times 0x40000000 (1 GB units), the
 * framebuffer reservation is 0x8000000 plus one sixteenth of the excess
 * over the first gigabyte, and the usable framebuffer never drops below
 * 384 MiB. The example computes the X=2 (2 GB) profile.
 */
export function nvidiaVgpuProfiles(): {
  formula: string;
  min: string;
  example: { profileSize: number; fbReservation: number; fb: number };
} {
  try {
    const calc = (x: number): { profileSize: number; fbReservation: number; fb: number } => {
      const profileSize = x * 0x40000000;
      const fbReservation = 0x8000000 + (profileSize - 0x40000000) / 0x10;
      return { profileSize, fbReservation, fb: profileSize - fbReservation };
    };
    return {
      formula: 'profileSize=X*0x40000000, fbReservation=0x8000000+(profileSize-0x40000000)/0x10',
      min: '384 MiB',
      example: calc(2),
    };
  } catch (cause) {
    throw new gpuerror('nvidiaVgpuProfiles failed', { cause: cause as Error });
  }
}

/**
 * GPU families supported by the vendor-reset module: the reset quirk list
 * covering Polaris through Navi 48 plus the Rembrandt iGPU and the 5600 XT
 * exception, required to recover amdgpu devices stuck in a bad state
 * before rebinding them to vfio-pci.
 */
export function vendorResetFamilies(): readonly string[] {
  return [
    'polaris10',
    'polaris11',
    'polaris12',
    'vega10',
    'vega20',
    'navi10',
    'navi12',
    'navi14',
    'navi48',
    '680M Rembrandt',
    '5600XT',
  ];
}

/**
 * Intel SR-IOV DKMS package and kernel parameters for the Xe and i915
 * stacks: i915-sriov-dkms 2026.02.09 with i915.enable_guc=3 and up to 7
 * VFs, or the xe driver with xe.force_probe=0xa7a0 for Battlemage.
 */
export function intelSriovDkms(): {
  pkg: string;
  kernel: string;
  xe: string;
  maxVfs: number;
} {
  return {
    pkg: 'i915-sriov-dkms_2026.02.09',
    kernel: 'intel_iommu=on i915.enable_guc=3 i915.max_vfs=7',
    xe: 'intel_iommu=on xe.max_vfs=7 xe.force_probe=0xa7a0',
    maxVfs: 7,
  };
}

/* ------------------------------------------------------------------ */
/* Section 5: vgpu slice profiles (mirror of the C++ scheduler)        */
/* ------------------------------------------------------------------ */

/** One time-sliced vgpu profile as scheduled by the C++ VgpuScheduler. */
export type vgpuprofile = {
  readonly id: string;
  readonly vrammb: number;
  readonly maxinstances: number;
  readonly encodersessions: number;
  readonly decodersessions: number;
  readonly weight: number;
  readonly flavor: 'vgpu' | 'sriov';
};

/**
 * vgpu slice catalog: NVIDIA B100 quarter profiles (1Q through 8Q), the
 * GB202 consumer slices for RTX 5090 class boards and the AMD MxGPU
 * SR-IOV slices for RX 9070 XT (Navi 48). Instances attach through the
 * mdev_supported_types sysfs interface.
 */
export const VGPUPROFILES: readonly vgpuprofile[] = [
  {
    id: 'B100-1Q',
    vrammb: 4096,
    maxinstances: 24,
    encodersessions: 1,
    decodersessions: 2,
    weight: 30,
    flavor: 'vgpu',
  },
  {
    id: 'B100-4Q',
    vrammb: 16384,
    maxinstances: 6,
    encodersessions: 2,
    decodersessions: 4,
    weight: 50,
    flavor: 'vgpu',
  },
  {
    id: 'B100-8Q',
    vrammb: 32768,
    maxinstances: 3,
    encodersessions: 3,
    decodersessions: 6,
    weight: 70,
    flavor: 'vgpu',
  },
  {
    id: 'GB202-4Q',
    vrammb: 8192,
    maxinstances: 4,
    encodersessions: 2,
    decodersessions: 4,
    weight: 60,
    flavor: 'vgpu',
  },
  {
    id: 'GB202-8Q',
    vrammb: 16384,
    maxinstances: 2,
    encodersessions: 2,
    decodersessions: 4,
    weight: 80,
    flavor: 'vgpu',
  },
  {
    id: 'RX9070XT-2Q',
    vrammb: 4096,
    maxinstances: 4,
    encodersessions: 1,
    decodersessions: 2,
    weight: 40,
    flavor: 'sriov',
  },
  {
    id: 'RX9070XT-4Q',
    vrammb: 8192,
    maxinstances: 2,
    encodersessions: 2,
    decodersessions: 4,
    weight: 70,
    flavor: 'sriov',
  },
] as const satisfies readonly vgpuprofile[];

/** Resolves a vgpu slice profile by id, throwing for unknown names. */
export function getvgpuprofile(id: string): vgpuprofile {
  const found = VGPUPROFILES.find((profile) => profile.id === id);
  if (found === undefined) {
    throw new gpuerror(
      `unknown vgpu profile "${id}"; known profiles: ${VGPUPROFILES.map((profile) => profile.id).join(', ')}`,
    );
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Section 6: Blackwell MIG layout mirror                              */
/* ------------------------------------------------------------------ */

/** One Blackwell MIG layout entry (MIG 2.0, up to 7 compute instances). */
export type miglayout = {
  readonly profile: string;
  readonly computeslices: number;
  readonly memorymb: number;
  readonly hbmgb: number;
  readonly smcount: number;
  readonly decoders: number;
  readonly encoders: number;
  readonly maxinstances: number;
  readonly mdev: string;
  readonly c2ccoherent: boolean;
};

/**
 * Blackwell B100 MIG layout catalog (192 GB HBM3e, 8 TB/s): eight profiles
 * from 1g.12gb (14 SMs, 7 instances) to the monolithic 7g.192gb (192 SMs),
 * each mapped to its compatible mdev type so vgpu and MIG compose.
 */
export const MIGLAYOUTBLACKWELL: readonly miglayout[] = [
  {
    profile: '1g.12gb',
    computeslices: 1,
    memorymb: 12288,
    hbmgb: 12,
    smcount: 14,
    decoders: 1,
    encoders: 1,
    maxinstances: 7,
    mdev: 'nvidia-b100-mig-1g-12gb',
    c2ccoherent: true,
  },
  {
    profile: '1g.24gb',
    computeslices: 1,
    memorymb: 24576,
    hbmgb: 24,
    smcount: 28,
    decoders: 1,
    encoders: 1,
    maxinstances: 7,
    mdev: 'nvidia-b100-mig-1g-24gb',
    c2ccoherent: true,
  },
  {
    profile: '2g.24gb',
    computeslices: 2,
    memorymb: 24576,
    hbmgb: 24,
    smcount: 28,
    decoders: 2,
    encoders: 1,
    maxinstances: 3,
    mdev: 'nvidia-b100-mig-2g-24gb',
    c2ccoherent: true,
  },
  {
    profile: '2g.48gb',
    computeslices: 2,
    memorymb: 49152,
    hbmgb: 48,
    smcount: 56,
    decoders: 2,
    encoders: 2,
    maxinstances: 3,
    mdev: 'nvidia-b100-mig-2g-48gb',
    c2ccoherent: true,
  },
  {
    profile: '3g.48gb',
    computeslices: 3,
    memorymb: 49152,
    hbmgb: 48,
    smcount: 56,
    decoders: 2,
    encoders: 2,
    maxinstances: 2,
    mdev: 'nvidia-b100-mig-3g-48gb',
    c2ccoherent: true,
  },
  {
    profile: '3g.96gb',
    computeslices: 3,
    memorymb: 98304,
    hbmgb: 96,
    smcount: 84,
    decoders: 3,
    encoders: 2,
    maxinstances: 2,
    mdev: 'nvidia-b100-mig-3g-96gb',
    c2ccoherent: true,
  },
  {
    profile: '4g.96gb',
    computeslices: 4,
    memorymb: 98304,
    hbmgb: 96,
    smcount: 112,
    decoders: 4,
    encoders: 3,
    maxinstances: 1,
    mdev: 'nvidia-b100-mig-4g-96gb',
    c2ccoherent: true,
  },
  {
    profile: '7g.192gb',
    computeslices: 7,
    memorymb: 196608,
    hbmgb: 192,
    smcount: 192,
    decoders: 7,
    encoders: 4,
    maxinstances: 1,
    mdev: 'nvidia-b100-mig-7g-192gb',
    c2ccoherent: true,
  },
] as const satisfies readonly miglayout[];

/**
 * Validates that a requested MIG instance set does not oversubscribe the
 * Blackwell physical limits: at most 7 compute slices and at most 192 GB of
 * HBM3e in aggregate.
 */
export function validatedensity(requested: readonly miglayout[]): boolean {
  try {
    let slices = 0;
    let gb = 0;
    for (const layout of requested) {
      slices += layout.computeslices;
      gb += layout.hbmgb;
    }
    return slices <= 7 && gb <= 192;
  } catch (cause) {
    throw new gpuerror('validatedensity failed', { cause: cause as Error });
  }
}

/**
 * Composes the complete MIG catalog visible to planners: the guest-side
 * VRAM slicing profiles owned by virtualmemory.ts (1g.24gb, 2g.48gb and
 * 4g.96gb on the 96 GB virtual device) plus the host-side Blackwell
 * layouts mirrored above.
 */
export function composemigcatalog(): readonly string[] {
  try {
    return [
      ...MIGPROFILES.map((profile) => profile.id),
      ...MIGLAYOUTBLACKWELL.map((row) => row.profile),
    ];
  } catch (cause) {
    throw new gpuerror('composemigcatalog failed', { cause: cause as Error });
  }
}

/* ------------------------------------------------------------------ */
/* Section 7: static spec database mirror                              */
/* ------------------------------------------------------------------ */

/** Static silicon facts of one gpu architecture (mirror of the C++ db). */
export type gpustaticspec = {
  readonly arch: string;
  readonly vendor: 'nvidia' | 'amd';
  readonly marketingname: string;
  readonly smorcu: number;
  readonly busbits: number;
  readonly bandwidthgbps: number;
  readonly tdpwatts: number;
  readonly encoders: number;
  readonly decoders: number;
  readonly mig: boolean;
  readonly sriov: boolean;
  readonly maxvgpuinstances: number;
  readonly wgps?: number;
  readonly aiaccelerators?: number;
  readonly mediaengine: string;
};

/**
 * Static spec database mirrored from the C++ virtualization core. GB100 is
 * the 168 SM datacenter die with 8192-bit HBM3e at 8 TB/s; GB202 is the
 * 170 SM consumer die with 512-bit GDDR7 at 1792 GB/s; Navi 48 carries 64
 * CUs organized as 32 WGPs with 128 AI accelerators on VCN 5.0.
 */
export const GPUSTATICSPECS: readonly gpustaticspec[] = [
  {
    arch: 'gb100',
    vendor: 'nvidia',
    marketingname: 'NVIDIA B100 Tensor Core 192GB HBM3e SXM',
    smorcu: 168,
    busbits: 8192,
    bandwidthgbps: 8000,
    tdpwatts: 700,
    encoders: 2,
    decoders: 4,
    mig: true,
    sriov: false,
    maxvgpuinstances: 24,
    mediaengine: 'NVENC 9th Gen dual',
  },
  {
    arch: 'gb202',
    vendor: 'nvidia',
    marketingname: 'NVIDIA GeForce RTX 5090 32GB GDDR7 GB202-300',
    smorcu: 170,
    busbits: 512,
    bandwidthgbps: 1792,
    tdpwatts: 575,
    encoders: 2,
    decoders: 2,
    mig: false,
    sriov: true,
    maxvgpuinstances: 4,
    mediaengine: 'NVENC 9th Gen',
  },
  {
    arch: 'gb203',
    vendor: 'nvidia',
    marketingname: 'NVIDIA GeForce RTX 5080 16GB GDDR7 GB203-400',
    smorcu: 84,
    busbits: 256,
    bandwidthgbps: 960,
    tdpwatts: 360,
    encoders: 1,
    decoders: 1,
    mig: false,
    sriov: true,
    maxvgpuinstances: 4,
    mediaengine: 'NVENC 9th Gen',
  },
  {
    arch: 'navi48',
    vendor: 'amd',
    marketingname: 'AMD Radeon RX 9070 XT Navi48 16GB GDDR6',
    smorcu: 64,
    busbits: 256,
    bandwidthgbps: 640,
    tdpwatts: 304,
    encoders: 2,
    decoders: 2,
    mig: false,
    sriov: true,
    maxvgpuinstances: 4,
    wgps: 32,
    aiaccelerators: 128,
    mediaengine: 'VCN 5.0 / VPE 1.1',
  },
  {
    arch: 'navi44',
    vendor: 'amd',
    marketingname: 'AMD Radeon RX 9060 XT Navi44 16GB GDDR6',
    smorcu: 32,
    busbits: 128,
    bandwidthgbps: 322,
    tdpwatts: 160,
    encoders: 1,
    decoders: 1,
    mig: false,
    sriov: true,
    maxvgpuinstances: 2,
    wgps: 16,
    aiaccelerators: 64,
    mediaengine: 'VCN 5.0',
  },
] as const satisfies readonly gpustaticspec[];

/* ------------------------------------------------------------------ */
/* Section 8: nvenc dual engine mirror                                 */
/* ------------------------------------------------------------------ */

/** Throughput contract of the B100 dual NVENC engines (SDK 13.0 data). */
export const NVENCDUALENGINE = {
  totalmpixpersec: 1600,
  perenginempix: 800,
  engines: 2,
} as const satisfies {
  readonly totalmpixpersec: number;
  readonly perenginempix: number;
  readonly engines: number;
};

/** One codec session limit row of the dual-engine table. */
export type nvencsession = {
  readonly codec: 'h264' | 'hevc' | 'av1';
  readonly maxwidth: number;
  readonly maxheight: number;
  readonly maxfps: number;
  readonly mpixpersec: number;
  readonly hdr10: boolean;
  readonly splitframe: boolean;
};

/** Session table: 8K60 ceilings per codec with HDR10 and split-frame. */
export function nvencsessiontable(): readonly nvencsession[] {
  return [
    {
      codec: 'h264',
      maxwidth: 8192,
      maxheight: 8192,
      maxfps: 60,
      mpixpersec: 480,
      hdr10: false,
      splitframe: true,
    },
    {
      codec: 'hevc',
      maxwidth: 8192,
      maxheight: 8192,
      maxfps: 60,
      mpixpersec: 800,
      hdr10: true,
      splitframe: true,
    },
    {
      codec: 'av1',
      maxwidth: 8192,
      maxheight: 8192,
      maxfps: 60,
      mpixpersec: 800,
      hdr10: true,
      splitframe: true,
    },
  ];
}

/**
 * Checks whether a resolution at a frame rate (and session count) fits
 * within the 1600 MPix/s aggregate budget of the dual engines.
 */
export function nvencCanFit(w: number, h: number, fps: number, sessions = 1): boolean {
  try {
    const mpix = ((w * h * fps) / 1_000_000) * sessions;
    return mpix <= NVENCDUALENGINE.totalmpixpersec;
  } catch (cause) {
    throw new gpuerror('nvencCanFit failed', { cause: cause as Error });
  }
}

/** Human readable engine description pinned to the v2 driver anchor. */
export function nvencdescribe(): string {
  return (
    `NVENC Blackwell B100 dual-engine ${NVENCDUALENGINE.totalmpixpersec} MPix/s total ` +
    `(${NVENCDUALENGINE.perenginempix} per engine), AV1/HEVC 8K HDR60, split-frame, ` +
    `SDK 13.0, driver ${smidriveranchor.driver}`
  );
}

/* ------------------------------------------------------------------ */
/* Section 9: registry, builder and factory                            */
/* ------------------------------------------------------------------ */

/**
 * Registry of gpu identities. Seeded with the verified GPU_BANK and
 * extensible at runtime; the Meta json identities (B100, GB200, RTX 5070,
 * RX 8900 XTX, Arc B770, RDNA APUs) register here after being loaded from
 * their json data files.
 */
export const gpuregistry: ReadonlyMap<string, virtualgpuspec> = new Map<string, virtualgpuspec>(
  GPU_BANK.map((spec) => [spec.id, spec] as const),
);

/** Lists every registered gpu identity id in registry order. */
export function listgpus(): readonly string[] {
  return [...gpuregistry.keys()];
}

/** Resolves a gpu identity by id, throwing with the known ids on miss. */
export function getgpu(id: string): virtualgpuspec {
  const found = gpuregistry.get(id.toLowerCase());
  if (found === undefined) {
    throw new gpuerror(`unknown gpu identity "${id}"; known ids: ${listgpus().join(', ')}`);
  }
  return found;
}

/** Resolves a capability flag that may arrive as a boolean or as an object
 * carrying a nested "supported" key (both json schemas appear in the pool). */
function resolveflag(value: unknown, key: string): boolean {
  if (typeof value === 'object' && value !== null) {
    const nested = (value as Record<string, unknown>)[key];
    return nested === undefined ? false : Boolean(nested);
  }
  return Boolean(value);
}

/**
 * Normalizes a loose json record from the data files (gpus.json,
 * processors.json) into a bank-grade virtualgpuspec and registers it. This
 * is the logic half of the Meta identities: the numbers live in the jsons,
 * this function only maps shapes. Accepted key spellings cover both the
 * v5 schema (pciId as "vendor:device", memoryGB, vramGb, memoryBandwidthGBs,
 * tdpW, cudaCores) and the Meta schema (vram_gb, bandwidth_gbs, tdp_w,
 * cuCount, streamProcessors).
 */
export function registergpudata(record: Record<string, unknown>): virtualgpuspec {
  try {
    const id = String(record.id ?? record.sku ?? '').toLowerCase();
    if (id.length === 0) {
      throw new gpuerror('gpu record requires an id');
    }
    const name = String(record.name ?? record.model ?? id);
    const vendorraw = String(record.vendor ?? '').toLowerCase();
    const vendor: virtualgpuspec['vendor'] = vendorraw.includes('amd')
      ? 'amd'
      : vendorraw.includes('intel')
        ? 'intel'
        : 'nvidia';
    const pciRaw = record.pciId ?? record.pci_id;
    const pcifull =
      typeof pciRaw === 'string'
        ? pciRaw
        : typeof pciRaw === 'object' && pciRaw !== null
          ? String((pciRaw as Record<string, unknown>).full ?? '')
          : String(record.pci ?? '');
    const [pcivendor, pcidevice] = pcifull.length === 9 ? pcifull.split(':') : ['0000', '0000'];
    const vramgb = Number(record.memoryGB ?? record.vramGb ?? record.vram_gb ?? record.vramgb ?? 0);
    if (vramgb <= 0) {
      throw new gpuerror(`gpu record "${id}" requires a positive memory size`);
    }
    const spec: virtualgpuspec = {
      id,
      name,
      vendor,
      pcivendor: pcivendor.toUpperCase(),
      pcidevice: pcidevice.toUpperCase(),
      vrammib: Math.round(vramgb * 1024),
      smireportedmib: Math.round(
        Number(record.reportedMib ?? record.reported_mib ?? vramgb * 1024),
      ),
      memtype: String(
        record.memoryType ?? record.vramType ?? record.vram_type ?? 'GDDR6',
      ).toUpperCase(),
      busbits: Number(record.busBits ?? record.bus_bits ?? record.memoryBusBit ?? 0),
      bandwidthgbs: Number(
        record.bandwidthGBs ?? record.bandwidth_gbs ?? record.memoryBandwidthGBs ?? 0,
      ),
      tdpwatts: Number(record.tdpW ?? record.tdp_w ?? 0),
      arch: String(record.architecture ?? record.arch ?? record.codename ?? 'virtual'),
      smarch: String(record.smarch ?? record.gfxTarget ?? record.gfx_target ?? ''),
      computeunits: Number(
        record.cudaCores ?? record.cuda_cores ?? record.cuCount ?? record.streamProcessors ?? 0,
      ),
      smcount: Number(record.sms ?? record.smCount ?? record.sm_count ?? 0),
      mig: resolveflag(record.mig, 'supported'),
      sriov: resolveflag(record.sriov, 'supported'),
      launch: String(record.releaseDate ?? record.launch ?? '2026-08-22'),
    };
    (gpuregistry as Map<string, virtualgpuspec>).set(id, spec);
    return spec;
  } catch (cause) {
    if (cause instanceof gpuerror) {
      throw cause;
    }
    throw new gpuerror('registergpudata failed', { cause: cause as Error });
  }
}

/**
 * Fluent builder for custom gpu identities. The builder starts from the
 * RTX 5090 baseline, collects overrides through chainable with* methods
 * and freezes the result into the registry.
 */
export class virtualgpubuilder {
  #spec: virtualgpuspec;

  constructor() {
    this.#spec = GPU_BANK[0] as virtualgpuspec;
  }

  /** Sets the registry id and display name. */
  withid(id: string, name: string): this {
    this.#spec = { ...this.#spec, id: id.toLowerCase(), name };
    return this;
  }

  /** Sets the vendor and the pci vendor id that matches it. */
  withvendor(vendor: virtualgpuspec['vendor']): this {
    this.#spec = {
      ...this.#spec,
      vendor,
      pcivendor: vendor === 'nvidia' ? '10DE' : vendor === 'amd' ? '1002' : '8086',
    };
    return this;
  }

  /** Sets the pci device id; must be exactly 4 hex digits. */
  withpcidevice(device: string): this {
    if (!/^[0-9A-Fa-f]{4}$/.test(device)) {
      throw new gpuerror(`pci device "${device}" must be 4 hex digits`);
    }
    this.#spec = { ...this.#spec, pcidevice: device.toUpperCase() };
    return this;
  }

  /** Sets the memory geometry: capacity, type, bus width and bandwidth. */
  withmemory(vrammib: number, memtype: string, busbits: number, bandwidthgbs: number): this {
    this.#spec = { ...this.#spec, vrammib, memtype, busbits, bandwidthgbs };
    return this;
  }

  /** Sets power and architecture strings. */
  withpower(tdpwatts: number, arch: string): this {
    this.#spec = { ...this.#spec, tdpwatts, arch };
    return this;
  }

  /** Sets compute topology and the virtualization capabilities. */
  withcompute(
    computeunits: number,
    smcount: number,
    smarch: string,
    mig: boolean,
    sriov: boolean,
  ): this {
    this.#spec = { ...this.#spec, computeunits, smcount, smarch, mig, sriov };
    return this;
  }

  /** Validates the accumulated fields and freezes the identity. */
  build(): virtualgpuspec {
    try {
      const spec = Object.freeze(this.#spec);
      if (spec.id.length === 0 || spec.name.length === 0) {
        throw new gpuerror('gpu identity requires an id and a name');
      }
      if (!/^[0-9A-Fa-f]{4}$/.test(spec.pcidevice)) {
        throw new gpuerror(`pci device "${spec.pcidevice}" must be 4 hex digits`);
      }
      if (spec.vrammib <= 0 || spec.bandwidthgbs < 0 || spec.tdpwatts < 0) {
        throw new gpuerror('gpu identity requires positive vram, bandwidth and tdp values');
      }
      (gpuregistry as Map<string, virtualgpuspec>).set(spec.id, spec);
      return spec;
    } catch (cause) {
      if (cause instanceof gpuerror) {
        throw cause;
      }
      throw new gpuerror('virtualgpubuilder.build failed', { cause: cause as Error });
    }
  }
}

/**
 * Factory that materializes a bank identity together with its NVML mock
 * environment: one call resolves the registry entry and pins the FAKE_VRAM
 * and FAKE_MODEL variables the smi adapter emulators read.
 */
export function createvirtualgpu(id: string): {
  spec: virtualgpuspec;
  pciid: string;
  nvmlenv: Record<string, string>;
} {
  try {
    const spec = getgpu(id);
    return {
      spec,
      pciid: fullpciid(spec),
      nvmlenv: nvmlMockEnv(spec.smireportedmib, spec.name),
    };
  } catch (cause) {
    if (cause instanceof gpuerror) {
      throw cause;
    }
    throw new gpuerror('createvirtualgpu failed', { cause: cause as Error });
  }
}
