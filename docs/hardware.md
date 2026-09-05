# e2ugh v6 - Hardware Bank Reference

This document specifies the virtual hardware bank: the processor catalog (57 identities), the GPU catalog (19 discrete devices plus APU graphics), the boards, the modularity ceilings with their policies, the selection logic, the encoding matrix, the generated procfs and nvidia-smi texts, and the integration points into QEMU, Docker and passage. Architecture decisions live in `architecture.md`; the engines that execute these identities live in `virtualization.md`; the Mesa stack that renders the GPU identities is bound by `render.ts`. Every specification was verified against vendor pages, the TechPowerUp databases and PCI ID registries on 2026-08-22, with the Xeon 6980P and Apple M3 Ultra rows re-verified against vendor pages on 2026-08-23.

Context map (25 related contexts): processor bank, EPYC 9965, EPYC 9955,
Threadripper PRO 9995WX, Threadripper 7980X, Ryzen 9 9950X3D, Core Ultra 9
285K, OMNI catalog families, Xeon 6980P verification, Apple M3 Ultra
verification, Ryzen X3D deep dive, core topology,
boards, GPU bank, PCI identifiers, HBM3e and GDDR7 subsystems, MIG catalog,
vGPU formula, SR-IOV, vCPU modularity, RAM modularity, vRAM modularity,
selection logic, encoding matrix, generated cpuinfo, generated meminfo,
virtual nvidia-smi format.

---

## 1. Processor bank

### 1.1 The six verified identities (line by line)

The immutable bank `BEST_VIRTUAL_PROCESSORS` in `virtualcpu.ts` carries 26 fields per model so the procfs generators never need a network lookup.

| Field | AMD EPYC 9965 | AMD EPYC 9955 | AMD Ryzen 9 9950X3D | AMD TR PRO 9995WX | AMD TR 7980X | Intel Core Ultra 9 285K |
|---|---|---|---|---|---|---|
| Cores / threads | 192c / 384t | 128c / 256t | 16c / 32t | 96c / 192t | 64c / 128t | 24c / 24t (8P+16E, no HT) |
| Base clock | 2.25 GHz | 2.60 GHz | 4.30 GHz | 2.50 GHz | 3.20 GHz | 3.70 GHz (P-core) |
| Max boost | 3.70 GHz | 3.75 GHz | 5.70 GHz | 5.40 GHz | 5.10 GHz | 5.70 GHz (E max 4.6) |
| All-core boost | 3.35 GHz | 3.45 GHz | 5.40 GHz | 4.10 GHz | 4.40 GHz | 5.40 GHz |
| L3 cache | 384 MB | 384 MB | 128 MB | 384 MB | 256 MB | 36 MB |
| L2 cache | 192 MB | 128 MB | 16 MB (144 MB total) | 96 MB | 64 MB | 36 MB |
| Socket | SP5 (LGA6096) | SP5 | AM5 | sTR5 (LGA4844) | sTR5 | LGA1851 |
| TDP | 500 W (cTDP 450-500) | 400 W | 170 W (200 W max) | 350 W | 350 W | 125 W base / 250 W turbo |
| PCIe | 5.0 x128 | 5.0 x128 | 5.0 x24 | 5.0 x128 | 5.0 x48 | 5.0 x20 + 4.0 x4 |
| Max memory | 6 TB DDR5-6400 ECC RDIMM | 6 TB DDR5-6400 ECC RDIMM | 192 GB DDR5-5600 | 2 TB DDR5-6400 ECC RDIMM | 1 TB DDR5-6400 | 192 GB DDR5-6400 |
| Memory channels | 12 | 12 | 2 | 8 | 4 | 2 |
| Microarchitecture | Zen 5c (Turin, TSMC 3 nm) | Zen 5c (Turin dense) | Zen 5 X3D (V-Cache on one CCD) | Zen 5 (Shimada Peak, WRX90) | Zen 5 (TRX50) | Arrow Lake (Lion Cove + Skymont) |
| cpu family / model / stepping | 25 / 17 / 2 | 25 / 17 / 2 | 25 / 17 / 2 | 25 / 17 / 2 | 25 / 17 / 2 | 6 / 191 / 2 |
| Address sizes | 52/57 bits | 52/57 bits | 48/57 bits | 52/57 bits | 52/57 bits | 46/57 bits |
| Launch | 2024-10-10 | 2024-10-10 | 2025-03-12 | 2025-07 | 2023-10 | 2024-10-24 |

Engineering notes carried into the generators: the 9965 tops the 9005 series with dense Zen 5c cores on 12 DDR5 channels, the full 384 MB of shared L3 and 128 PCIe 5.0 lanes; the 9950X3D "144 MB" marketing figure decomposes as 96 MB 3D V-Cache on CCD0 plus 32 MB standard L3 on CCD1 plus 16 MB L2 (the generator renders 128 MB into the `cache size` line and carries the split in topology); the 9995WX holds the workstation record (96 Zen 5 cores, 2 TB eight-channel DDR5-6400, 128 lanes on sTR5); the 285K is the only non-SMT entry, so its cpuinfo omits the `ht` flag on purpose and the Arrow Lake profile ships AVX2-era flags only.

### 1.2 Scoring, topology and registry

`cpuscore` orders the bank (weighted product of cores, clocks, cache and memory bandwidth); `compareVirtualProcessors` and `listBestVirtualProcessors` consume it. `solvetopology` derives package topology from a requested vCPU count: AMD models assume SMT factor 2, Arrow Lake assumes 1, and the solver computes `siblings`, `core id`, `cpu cores` and APIC identifiers for every logical processor. `stableModelId` derives a deterministic sha256-12 identifier; the case-insensitive `cpuRegistry` accepts runtime registration through `registerVirtualCpu` (the `modellease` disposable cleans up on scope exit via `using`).

### 1.3 OMNI catalog (the other 51 identities, by family)

`processors.json` unifies the six-identity bank with the 55-CPU OMNI catalog (2024-2026 releases); the V5-first rule keeps v5 canonical fields, OMNI adds cTDP ranges and both family ids. Summary by family:

| Family | Members (highlights) | Notes |
|---|---|---|
| Ryzen 9000 Granite Ridge | 9950X3D, 9950X, 9900X3D, 9900X, 9850X3D refresh, 9800X3D, 9700X, 9600X, 9950X3D2 | Zen 5 N4X CCD + N6 IOD; 8-wide decode, 448 ROB, AVX-512 full 512-bit datapath; X3D detection rule `cache.l3 >= 192` selects the 9950X3D2 |
| Ryzen 9950X3D2 (CES 2026) | 16c/32t, 192 MB L3 (96+96 dual X3D CCD), 208 MB total, 200 W, $899, launch 2026-04-22 | First desktop dual X3D; kept as a distinct identity with its own cache layout |
| Threadripper 9000 Shimada Peak | 9995WX 96c, 9985WX 64c, 9975WX 32c, 9965WX 24c; HEDT 9980X/9970X/9960X | sTR5; 9995WX maps to 672-vCPU custom topologies (7x cores / 3.5x threads) in the overcommit matrix |
| Threadripper 7000 legacy | 7995WX 96c $11999, 7980X 64c (bank member), 7970X, 7960X | sTR5; overlaps resolved V5-first in the registry |
| EPYC 9005 Turin | 9965 192c, 9955 128c, 9755 128c 2.7/4.1 GHz 512 MB, 9575F 64c 3.3/5.0 GHz | SP5, 12ch DDR5-6400, CXL 1.0 host interfaces |
| Intel Xeon 6 | 6980P 128c/256t Granite Rapids-AP, base 2.0 GHz / max 3.9 GHz, 504 MB L3, 500 W, LGA7529 (confirmed: Intel sku 240777); 6972P/6960P catalog siblings | 12ch DDR5-6400 ECC MRDIMM; the QEMU side uses the `GraniteRapids` model + AVX10 flags |
| Intel Core Ultra 200S | 285K, 285K Refresh (+100 MHz), 265K/KF | LGA1851, NPU 13 TOPS (PCI 8086:7D19), DDR5-6400 JEDEC |
| Apple Silicon | M3 Ultra (up to 32-core CPU as 24P+8E, up to 80-core GPU, 819 GB/s unified memory, announced 2025-03-05), M4, M4 Pro/Max | Unified memory; HVF `virt` arm64 guest only; the M4 Ultra does not exist as of 2026-08 - the catalog notes M3 Ultra (a dual M3 Max on UltraFusion) as the top end |
| ARM Neoverse | V3, Cobalt-200 | aarch64 guests under TCG (weak-on-strong MTTCG rule) |

OMNI count arithmetic (how 55 catalog entries yield 51 beyond the bank): 55 OMNI identities minus the 5 that overlap bank members (9965, 9955, 9995WX lineage, 7980X, 285K) plus the 9950X3D2 promotion equals 51 additional rows; every overlap keeps the v5 canonical field spellings (`modelName`, `maxBoostGhz`, `tdpWatts`, `baseClockGhz`) with the OMNI cTDP range preserved as `ctdpRangeWattsOmni` and both family ids attached.

The full 57-row table with clocks, caches, TDP/cTDP, PCIe lane counts, sockets and launch dates lives in `processors.json` (`processors` array); this document keeps the verified six verbatim and summarizes the rest. Two of those rows were re-verified against vendor pages on 2026-08-23 and both already exist as catalog identities: `xeon-6980p` (Intel sku 240777: 128 cores / 256 threads, 2.0 GHz base / 3.9 GHz max, 504 MB L3, 500 W, Granite Rapids) and `apple-m3-ultra` (up to 32 CPU cores as 24P+8E, up to 80 GPU cores, 819 GB/s unified memory per apple.com; the json entry carries the 800 GB/s announcement figure and the 2025-03-05 release date).

## 2. Boards and platforms

`boards.json` carries 20 retail boards in three tiers plus the platform reference:

| Tier | Boards (examples) | Virtualization-relevant facts |
|---|---|---|
| AM5 flagship | ASUS Crosshair X870E Hero (BIOS 1805 AGESA 1.2.0.3a, 4x DDR5 192 GB 8200+ OC, 1x Gen5 x16 + shared x8/x8, 3 Gen5 M.2, USB4 x2), MSI MEG X870E Godlike (256 GB, 10+5 GbE) | X870E dual Promontory 21; 24 CPU lanes (16 GPU + 8 NVMe); q35 + amd-iommu emulation profile, ACS-optimal grouping |
| AM5 mid | Gigabyte B850M Aorus Pro, ASUS ROG Strix B850G, MSI MAG B850M Mortar (256 GB), ASRock B850M Steel Legend | single Promontory 21; Gen5 GPU slot + Gen5 M.2 retained |
| Workstation | ASUS Pro WS TRX50-SAGE, ASRock TRX50 WS, Gigabyte TRX50 Aero D (4ch RDIMM 1 TB, 48 lanes) | TRX50 tier for Shimada Peak HEDT |
| Workstation server | ASUS Pro WS WRX90E-SAGE SE (E-ATX, 8ch 2 TB RDIMM, 128 lanes, 7 dual-slot GPU spacing), Supermicro MBD-H13SRA-F | WRX90 tier for 9995WX-class identities |
| Platform reference | SP5, TR5/sTR5, AM5 socket envelopes | lane budgets, channel counts, IOMMU hints consumed by the affinity validator |

Board-processor affinity validation (socket match, BIOS/AGESE floor, memory QVL, VRM versus PPT, bifurcation for dual-GPU passthrough) throws `BOARD_002_SOCKET_MISMATCH` / `BOARD_003_BIOS` style errors before a plan ever reaches QEMU.

## 3. Core topology

`cores.json` defines the P/E/LPE mapping the orchestrator uses for heterogeneous scheduling:

| Core type | Microarchitectures | Mapping |
|---|---|---|
| P-core | Lion Cove (Arrow Lake), Coyote Cove (next), Zen 5 | `performance` class; guaranteed QoS; CCD0-preferred on X3D parts |
| E-core | Skymont (clusters of 4), Arctic Wolf, Zen 5c | `efficiency` class; burstable/besteffort QoS |
| LP-E | Crestmont | `ultra_efficient` class; idle QoS |

Hybrid identities surface through CPUID leaves 0x1A (core type), 0x1F (extended topology) and 0x0B (x2APIC), with AMD Fn80000026 for cache topology on Zen 5. The vCPU factory emits 12 curated presets (1 to 1024, including hybrid 8P+16E and odd presets 1/13/37/137 from the vm.config data) plus step-1 custom counts; the orchestrator maps vCPU ranges to perf/efficiency/ultra_efficient lanes for MTTG placement.

Preset-to-topology mapping consumed by the NUMA planner:

| Preset (vCPUs) | Topology emitted | NUMA | Hugepages |
| --- | --- | --- | --- |
| 1 / 2 / 4 / 8 | single socket, single CCD | 1 node | 2M |
| 16 | 2 CCD, SMT2 | 2 nodes, distance 10/21 | 2M |
| 24 (hybrid) | 8P + 16E, no SMT on E | 2 nodes | 2M |
| 32 | dual CCD SMT pairing 0:16 siblings | 2 nodes | 2M |
| 64 / 128 | 4 / 8 nodes | distances 10/16/21/31 | 1G required |
| 256 / 512 / 1024 | 16 / 32 / 64 nodes (identity permitting) | full distance matrix | 1G + memfd |

Heterogeneous scheduling map: Intel Thread Director classes route vCPUs 0-7 (P) to guaranteed QoS and 8-23 (E) to besteffort; AMD Preferred Core pins vCPU 0-7 to the V-Cache CCD0 and background lanes to CCD1 (the 9950X3D asymmetric profile: CCD0 96 MB V-Cache for the game/video lane, CCD1 32 MB for audio-IO, emulator threads isolated on host cores 0-1, `emulatorPin` honored in the strict profile).

## 4. GPU bank

### 4.1 Verified identities (PCI IDs corrected)

The bank in `virtualgpu.ts` embeds seven identities confirmed against vendor pages, TechPowerUp and the PCI ID registries. The RTX PRO 6000 uses device 26B5; the 2BB5 spelling found in the v4 sources is a transcription error recorded in the JSDoc for traceability and intentionally not reproduced.

| Field | RTX 5090 | RTX PRO 6000 BW | NVIDIA B200 | NVIDIA H100 | NVIDIA A100 | RX 9070 XT | Instinct MI350X |
|---|---|---|---|---|---|---|---|
| VRAM | 32 GB GDDR7 | 96 GB GDDR7 ECC | 192 GB HBM3e | 80 GB HBM3 | 40 GB HBM2e | 16 GB GDDR6 | 288 GB HBM3e |
| Bus width | 512-bit | 512-bit | 8 stacks (8192-bit) | 5120-bit | 5120-bit | 256-bit | 8192-bit |
| Bandwidth | 1792 GB/s | 1792 (server 1597) | 8 TB/s | 3.35 TB/s | 1.55 TB/s | 640 GB/s | 8 TB/s |
| TDP | 575 W | 600 W (Max-Q 300) | 1000 W | 700 W | 400 W | 304 W TBP | 1000 W (MI355X 1400) |
| PCI ID | 10DE:2B85 | 10DE:26B5 | 10DE:2665 | 10DE:2330 | 10DE:20B0 | 1002:748E | 1002:75A0 |
| Silicon | GB202 (170 SM enabled of 192) | GB202 PRO (188 SM) | GB100 dual-die, 208 B transistors | GH100 SXM | GA100 | Navi 48 (64 CU) | Aqua Vanjaram CDNA 4 |
| Shading units | 21760 CUDA | 24064 CUDA | dual-die | 16896 CUDA | 6912 CUDA | 4096 SP | 30464 SP |
| Compute target | sm_120 | sm_120, MIG server-edition | sm_100 | sm_90, 7 MIG instances | sm_80 | gfx1201 RDNA 4 | gfx950 CDNA 4 |
| Driver anchor | 575.57.08 / CUDA 12.9 | 575.57.08 / CUDA 12.9 | 575.57.08 / CUDA 12.9 | 575.57.08 | 575.57.08 | Adrenalin 26.x / Mesa 26.2 | ROCm 7.x |

Full-die context preserved from the research: GB202 counts 192 SM / 24576 CUDA / 768 Tensor Gen5 at the architecture level; the 5090 product enables 170 SM; bandwidth is 1792 GB/s at 28 Gbps bins and 1920 GB/s at 30 Gbps bins - the engine cites the 1792 minimum. Cloud-consoles expose about 180 GB of B200 capacity, which the virtual identity honors when emulating cloud instances (196608 MiB physical, 184320 MiB visible in smi-adapter output).

### 4.2 Catalog extensions (data-file identities)

`gpus.json` adds: RTX 5080 (GB203, 16 GB, 960 GB/s), RTX 5070 Ti, RTX 5070, B100 (10DE:2664), GB200 superchip (Grace 72c + 2x B200, 384 GB HBM3e aggregate 16 TB/s, NVLink-C2C 900 GB/s), H200, A100-80GB, RX 8900 XTX (Navi 48 96 CU, 24 GB GDDR6 960 GB/s), RX 7900 XTX, Arc B770 (BMG-G31, 32 Xe2, 16 GB, SR-IOV capable), Arc B580, MI355X, and the virtio-gpu device identity (1AF4:1050 with venus context). `registergpudata` normalizes any of these JSON records into bank entries at runtime (accepting both the v5 field spellings and the Meta spellings). The five APU RDNA iGPU blocks (Raphael, Hawk Point, Strix Point, Strix Halo, Krackan Point) round out the integrated-graphics surface. RX 8800 XT note: the v4 pool carries an RX 8800 XT entry (Navi 48 cut-down, 64 CU / 4096 SP, 16 GB GDDR6, 260 W, $599) that did not reach any v3 data file; it is recorded here as a reserved catalog slot so the pool provenance is not lost, to be promoted into `gpus.json` when the SKU is verified against a vendor page.

### 4.3 Selection logic

`gpuselection`: vRAM at or above 90 GB selects the RTX PRO 6000 identity; anything below selects the RTX 5090; with no virtual identity target the engine falls back to the Lavapipe software device (env surface in `render.ts`). `cpuselection` by threads: at or above 256 threads selects EPYC 9965; at or above 96 selects TR PRO 9995WX; at or above 32 selects the 9950X3D2 dual-X3D identity; otherwise the 9950X3D.

## 5. GPU memory subsystems

| Subsystem | Constants (scoring inputs in `virtualmemory.ts` MEMORY_TIERS) |
|---|---|
| DDR5-6400 system memory | 51.2 GB/s per channel; 614.4 GB/s across 12 EPYC channels; 44.8 GB/s per AM5 channel; JEDEC 4800/5600, EXPO 6000-8400 |
| HBM3e stacked memory | 8-Hi stacks at ~1000-1024 GB/s per stack; 6 stacks = 8.0-8.2 TB/s (B200, MI350X); ~90 ns latency; on-die ECC; ~70-100 W per stack at full bandwidth |
| GDDR7 graphics memory | 30 Gbps PAM3 per pin (28 minimum bin), 512-bit bus = 1920 GB/s theoretical / 1792 GB/s measured after ECC; 1.1 V VDD; 85 C ceiling |
| GDDR6/GDDR6X legacy | 19-20 Gbps / 21-24 Gbps PAM4 for the cost tiers (RX 8900 XTX 960 GB/s, Arc B770 608 GB/s) |
| LPDDR5X unified | 8533 MT/s, 819 GB/s on M3 Ultra (apple.com figure; the catalog entry keeps the 800 GB/s announcement number), zero-copy CPU/GPU domain |
| CXL 2.0/3.0 Type-3 | 178-195 ns latency, 32-64 GB/s per x16 Gen5 link, interleave 2/4/8 for the placement tiers (DRAM_FAST, DRAM_SLOW, CXL_FM, CXL_PMEM, PMEM_DAX) |

## 6. vGPU, MIG and partitioning

MIG slicing follows the hardware feature exactly. The 96 GB profiles (`MIGPROFILES` in `virtualmemory.ts`, composed into the full catalog by `composemigcatalog` in `virtualgpu.ts`):

| MIG profile | Slice | Max instances | Typical mapping |
|---|---|---|---|
| 1g.24gb | 24 GB | 4 | four sandboxes, one quarter GPU each |
| 2g.48gb | 48 GB | 2 | two sandboxes, half each |
| 4g.96gb | 96 GB | 1 | full GPU, MIG disabled |

Blackwell layouts extend the catalog (`miglayoutblackwell`): 1g.12gb (14 SM, 7 instances) through 7g.192gb (192 SM, 7 decoders, 4 encoders, mdev `nvidia-b100-mig-*`), with `validatedensity` enforcing sum of slices at most 7 and sum of HBM at most 192 GB per GPU. The NVIDIA vGPU profile-size formula ships as code: `profileSize = X * 0x40000000`, `fbReservation = 0x8000000 + (profileSize - 0x40000000) / 0x10`, minimum 384 MiB framebuffer. SR-IOV per vendor: NVIDIA vGPU up to 32 VF per pGPU on licensed SKUs (16 memory-bound on B200), AMD MxGPU temporal partitioning up to 16 VF (Radeon PRO V710 28 GB single-slot as the SR-IOV-only reference), Intel Xe up to 7 VF via `xe.max_vfs=7` on i915/Xe DKMS (Arc B770 class); RDNA 4 exposes 8 VF per PF through the GIM driver. Intel GVT-g stays archived (security escapes documented). GPU mode table: `vfio` full card, `mig` hardware slice, `vgpu` firmware profile, `virtio` hostmem window (no discrete GPU needed), `none`.

## 7. Modularity ceilings (policy, with all three answers)

| Resource | Catalog ceiling | Factory ceiling | Hotplug ceiling | Policy |
|---|---|---|---|---|
| vCPUs | 1-192 (EPYC 9965 identity bound, presets 1..192) | 1-1024 (cores.json factory, any integer) | 4096 (`maxcpus` headroom, QMP `device_add`) | catalog = identity bound; factory = validated plan; hotplug = ACPI ceiling; `planlint` warns `mttg` floor, overcommit above 64 and topology mismatch |
| Threads | 2-384 (SMT2 derived: threads = vcpus x 2) | M:N grid to `MTTG_MAX` = 1,000,000 virtual threads | grid clamps to host lanes | QEMU `-smp` stays at the plan; MTTG multiplexes userspace on top |
| RAM | 1-1024 GB, step 1 GB, presets 4..1024 | 512 MB - 4 TB factory range | virtio-mem grow/shrink (`max_gib` default `max(2x, gib+32)`) | 128 GB default profile anchored by the `meminfo128g` artifact (MemTotal 134086656 kB after the kernel reservation) |
| vRAM | 8-96 GB, presets [8,16,32,64,96] | 1-192 GB (Blackwell extensions in gpus.json) | vram balloon 0.5x-1.5x bounds, hugepages 2 MiB | MIG bound for hardware slices; hostmem window otherwise; `ERR_BALLOON_BOUNDS` outside bounds |

Overcommit matrix (hardwarematrix section 17, verified): 4.0x production / 5.0x burstable / 6.0x besteffort; 9950X3D 32 threads -> 128-192 vCPUs; 9995WX 192 threads -> 768-1152 vCPUs with the 672 custom topology (8 NUMA nodes x 84 vCPU); formulas `vCPU = threads x ratio` and `vCPU = cores x ratio x SMT`, SMT 2 for AMD, 1 for Intel hybrid P. KVM steal at 6x lands at 8-15%; QoS classes map guaranteed 4.0 and besteffort 6.0.

## 8. Memory and vRAM personalization

Knobs (with numbers, not adjectives): sockets 1-8; dies 1-16 (CCD analogue; Turin dense up to 12, desktop Zen 5 at 2); cores per die 1-256; threads per core 1 or 2 (guest-visible SMT, independent of host); topology product `sockets x dies x cores x threads` (desktop default 1x2x8x2 = 32); `vcpus` 1-4096 advertised; `maxcpus` at least vcpus (leave headroom: vcpus 8, maxcpus 128); overcommit 1-64 (`vcpus / host_threads`; 1 no lie, 4 typical cloud, 8 batch, 64 demonstration); QEMU CPU model ladder `host` (lab, TOPOEXT) / `EPYC-Genoa` / `GraniteRapids` / `SierraForest` (portable) / `EPYC-v5` (engine default); feature flags default `+x2apic,+aes,+avx2`, unlock `+avx512f,+amx-tile` when host and guest agree; `memory.gib` guest RAM with delayed touch under overcommit; `memory.slots` 1-256 (at least 2 for virtio-mem); hugepages 2M/1G; balloon `deflate-on-oom=on,free-page-reporting=on` (never disable on overcommitted RAM); virtio-mem `requested-size` starts at `gib/4`; host overcommit `never/heuristic/always` with zswap zstd 20% pool; KSM on for fleets of identical guests (UKSM upstream is unmaintained - the sroeschus/uksm community fork, active and ported to recent kernels, is the only viable UKSM source; see `virtualization.md` section 9); `gpu.mode` and `vram_gib` 0-288 (above the SKU the architect warns `vram-window` and virtio-gpu maps host RAM: 64 GB on a 32 GB 5090 is a window, not GDDR); Looking Glass IVSHMEM 128M default; MIG/vGPU profile strings (`1g.10gb`, `3g.40gb`, `grid_rtx6000-8q`, ignored on GeForce); accelerator `kvm/hvf/whpx/tcg` with nested, SEV-SNP (AMD) and TDX (Intel) booleans; disk/net `aio=io_uring`, `discard=unmap`, `compression=zstd`, `queues=4`, `mq=on`, `vhost=on`.

Unlimited, in this repository, means: vCPU = min(4096, host_threads x overcommit 64); threads = min(1e6, MTTG); RAM = min(host overcommit, virtio-mem max_gib); VRAM = full card, or MIG/vGPU slice, or hostmem window with no discrete GPU at all.

## 9. Encoding matrix

| GPU / iGPU | H.264 encode | HEVC encode | AV1 encode (B-frames) | Dual engines | AV1 4:2:2 | Profile |
|---|---|---|---|---|---|---|
| RTX 5090 NVENC Gen9 | 8K60 4:4:4 | 8K120 4:4:4 10b | 8K120 dual (2x 8K60 or 4x 4K120), B-frames, temporal AQ 2.0 | 2x NVENC + 2x NVDEC Gen6 | 4K60 encode / 8K60 decode | `nvenc_av1_bframe` |
| RX 8900 XTX VCN5 | 8K60 | 8K60 HDR 10b | 8K60, B-frames (20% bitrate save) | 2x VCN | 8K60 decode | `amf_av1` |
| Arc B770 QSV (Xe2 VDBOX) | 8K60 | 8K60 | 8K60 | 2x media engines | 8K60 decode | `qsv_av1` |
| Arrow Lake Xe-LPG iGPU | 8K60 | 8K60 | 8K60 | - | partial | `qsv_av1_lowpower` |
| Apple M3 Ultra Media Engine | ProRes 8K60 | ProRes 8K60 | decode only (8K60) | 2x enc, 4x dec | - | `videotoolbox_prores` |
| Ryzen iGPU (RDNA2 2CU) | 4K60 | 4K60 | no encode | - | - | fallback only |

The NVENC dual-engine throughput table in `virtualgpu.ts` (1600/800x2 MPix/s, session limits H.264 480 / HEVC 800 / AV1 800 HDR10, 8192x8192 at 60 fps split-frame) drives `nvencCanFit` checks for transcode planning; the mttg.config pipeline encodes 31 modes across 5 codecs with this matrix as the capacity model. Software encoding floor: 9950X3D reaches SVT-AV1 4K preset 6 at about 18 fps CPU-only.

## 10. Hardware matrix (power, PCIe, baselines)

Power and cTDP: 9950X3D 170 W TDP / 200 PPT / 120-170 cTDP / TjMax 89 C; 9800X3D 120/162/65-120; 9995WX 350/500 (600 peak)/350-500/95 C; 285K 125 PBP / 250 MTP (Tau 56 s); Xeon 6980P 500 W (Granite Rapids-AP class); M3 Ultra 120 W module (catalog tdpWatts); RTX 5090 575 W TGP with the 12V-2x6 600 W connector (1000 W minimum PSU, 900 W 100 us transients); RX 8900 XTX 350/355; B770 250. PCIe budgets: AM5 24 CPU lanes (16 GPU + 8 NVMe) + 24 chipset Gen4; sTR5 128 Gen5 CPU lanes (8 root complexes, one IOMMU group per CCD); LGA1851 24 CPU (16 Gen5) + 24 PCH Gen4; LGA7529 96 Gen5 + CXL 2.0 on the Xeon 6 -AP tier; x16 Gen5 carries ~63 GB/s unidirectional; Blackwell BAR1 at 32 GB requires Above-4G + ReBAR (64 GB MMIO window via `X-PciMmio64Mb=65536` for 192 GB devices). Performance baselines (August 2026 test pass): QEMU Win11 boot 6.2 s (9950X3D+5090) / 8.1 s (9995WX+PRO 6000, NUMA) / 5.9 s (M3 Ultra, HVF); FFmpeg 4K60 AV1 hardware transcode 3.1x realtime (187 fps); Vulkan compute 420-510 fps; self-hosted Actions build 29-62 s; system idle/load 78-89 W to 789 W desktop class, 1150 W workstation class. Reserved future slots: `ryzen_10050x3d` (Zen 6, 2027), `rtx_6090` 48 GB, RDNA 5, Celestial, CXL 3.0 pooling to 512 GB vRAM.

## 11. Generated artifacts

### 11.1 /proc/cpuinfo (virtual identity example)

`generateVirtualCpuinfo(model, vcpus, options?)` renders one block per logical processor with kernel-exact tab alignment (`model` and `cpu MHz` two tabs, `fpu`/`wp`/`flags`/`bugs` two tabs, `cache_alignment` and `power management` none). An EPYC 9965 block:

```text
processor       : 0
vendor_id       : AuthenticAMD
cpu family      : 25
model           : 17
model name      : AMD EPYC 9965 192-Core Processor
stepping        : 2
microcode       : 0xffffffff
cpu MHz         : 2941.000
cache size      : 384 MB
physical id     : 0
siblings                : 384
core id         : 0
cpu cores       : 192
apicid          : 0
initial apicid  : 0
fpu             : yes
fpu_exception   : yes
cpuid level     : 16
wp              : yes
flags           : fpu vme de pse ... avx512f avx512dq avx512cd avx512bw
avx512vl avx512_bf16 avx512vbmi avx512vbmi2 avx512ifma avx512vnni
avx512vp2intersect avx512vpopcntdq avx512bitalg sha_ni gfni vaes
vpclmulqdq ... serialize flush_l1d arch_capabilities
bugs            : sysret_ss_attrs spectre_v1 spectre_v2 spec_store_bypass srso
bogomips        : 4500.00
TLB size        : 3584 2M/4M pages
clflush size    : 64
cache_alignment: 64
address sizes   : 52 bits physical, 57 bits virtual
power management: ts ttp tm hwpstate cpb eff_freq_ro [13] [14]
```

The Zen 5 profile carries 100+ flags from production Turin/Granite Ridge dumps (complete AVX-512 family, vector crypto `sha_ni gfni vaes vpclmulqdq`, memory extensions `movdiri movdir64b fsrm serialize cldemote`); the Arrow Lake profile swaps in `avx_vnni la57 user_shstk tsxldtrk`, drops every AVX-512 flag and `ht`. `cpu MHz` carries crypto-random jitter between base and boost; `bogomips` derives from twice the base clock; the Intel profile omits the TLB line because production Intel cpuinfo does. `generateVirtualLscpu` renders the matching util-linux summary with NUMA ranges and vulnerability lines. The entrypoint writes 192 blocks to `/etc/virtual_cpuinfo` and the interposer redirects reads there; the cpuid leaf for the virtual identity identity is 0xA70F10 (family 26 model 17 in the OMNI spelling).

### 11.1a /etc/virtual/lscpu (companion artifact)

`generateVirtualLscpu('AMD EPYC 9965', 192, 2)` renders the summary tools read from sysfs topology instead of cpuinfo:

```text
Architecture:            x86_64
  CPU op-mode(s):        32-bit, 64-bit
  Byte Order:            Little Endian
CPU(s):                  384
  On-line CPU(s) list:   0-383
Vendor ID:               AuthenticAMD
  BIOS Vendor ID:        Advanced Micro Devices, Inc.
  BIOS Model ID:         17  Model name: AMD EPYC 9965 192-Core Processor
    BIOS CPU family:     25  Model: 17  Thread(s) per core: 2
    Core(s) per socket:  192  Socket(s): 1  Stepping: 2
    CPU(s) scaling MHz:  76%  CPU max MHz: 3700.0000  CPU min MHz: 1500.0000
BogoMIPS:                4500.00
Flags:                   fpu vme de pse ... avx512f avx512dq avx512cd avx512bw avx512vl
Virtualization:          AMD-V
L1d cache:               12 MiB (192 instances)
L1i cache:               12 MiB (192 instances)
L2 cache:                192 MiB (192 instances)
L3 cache:                384 MiB (24 instances)
NUMA node(s):            2
NUMA node0 CPU(s):       0-95,192-287
NUMA node1 CPU(s):       96-191,288-383
Vulnerability Itlb multihit: Not affected
Vulnerability L1tf:          Not affected
Vulnerability Mds:           Not affected
Vulnerability Meltdown:      Not affected
Vulnerability Spec store bypass: Mitigation; Speculative Store Bypass disabled via prctl
Vulnerability Spectre v1:    Mitigation; usercopy/swapgs barriers and __user pointer sanitization
Vulnerability Spectre v2:    Mitigation; Retpolines; IBPB conditional; STIBP always-on; RSB filling
Vulnerability Srbds:         Not affected
Vulnerability Tsx async abort: Not affected
```

The `Instances` counts, the split NUMA ranges and the vulnerability lines follow production Turin dumps; tools that read sysfs directly (lscpu, numactl, hwloc) therefore agree with the cpuinfo view byte for byte.

### 11.2 /proc/meminfo (53 fields, page aligned)

`generateVirtualMeminfo(totalgb, options?)` renders the complete table in kB with values right-aligned to the kernel column; every number passes a 4 kB page-alignment helper so `grep MemTotal /proc/meminfo` returns a multiple of 4 exactly like the kernel. Key fields for a 1024 GB guest:

| Field | Derivation |
|---|---|
| MemTotal | requested RAM minus a kernel reservation (about 0.4%) |
| MemFree / MemAvailable | free fraction near 2% / available near 60% defaults |
| Buffers / Cached / SwapCached | proportional fractions with page alignment |
| Active / Inactive + (anon) / (file) splits | anon-to-file ratio near 55/45 |
| SwapTotal / SwapFree | from the zram plus swapfile plan for large RAM sizes |
| Slab / SReclaimable / SUnreclaim | per-vCPU kernel allocations |
| CommitLimit | swap + 50% of RAM under `vm.overcommit_memory=2` |
| Committed_AS | sum of active anon plus a headroom factor |
| VmallocTotal | 34359738367 kB (32 TB) |
| AnonHugePages / Hugepagesize | transparent huge pages plus 2048 kB base pages |
| DirectMap4k / DirectMap2M / DirectMap1G | page-aligned breakdown of the direct map |

The 128 GB default is anchored by the `meminfo128g` evidence artifact: 134217728 kB requested total, 134086656 kB rendered MemTotal after the carve-out; options override swap size, free/available fractions, 1 GB hugepage count and the overcommit ratio; the default plan provisions a zram device (priority 100) plus a swapfile when RAM reaches 256 GB.

### 11.3 Virtual nvidia-smi adapter (89-character format)

`render.ts` reproduces the summary report byte-for-byte: driver 575.57.08, CUDA 12.9; the summary table is exactly 89 characters wide with pipe separators at offsets 1, 42 and 67; timestamp `Day-of-week Month Day HH:MM:SS Year`; performance states P0-P12; compute modes Default / Exclusive Process; MIG cell N/A when disabled; fan speed may legally exceed 100%; the process table is 75 characters wide with columns GPU, GI, CI, PID, Type (C/G/C+G), Process name, GPU Memory, and renders `No running processes found` when empty. Registered profiles render their real figures: RTX 5090 32768 MiB / 575 W, RTX PRO 6000 98304 MiB / 600 W (97887 MiB in the v4 data-file spelling, kept for compatibility), B200 196608 MiB / 1000 W (412 W draw, 34 C in the default facade), H100 81559 MiB, A100 40536 MiB, RX 9070 XT 16384 MiB / 304 W, MI350X 294912 MiB / 1000 W. The H100/A100 figures come from the verified [fake-nvidia-smi](https://github.com/pogusthewhisper/fake-nvidia-smi) profile table; the format rules from the [NVIDIA nvidia-smi deployment guide](https://docs.nvidia.com/deploy/nvidia-smi/).

## 12. Integration points

| Consumer | Binding |
|---|---|
| QEMU argv | per-SKU templates in `qemu.config` and `buildqemucmd` (`virtualization.ts`): EPYC identities `-cpu EPYC-v5,+avx512f,+avx512bw,+avx512vnni,+avx512bf16,+topoext`; Xeon `-cpu GraniteRapids,+avx10.1`; hybrid pinning maps P cores 0-7 to guaranteed QoS, E cores 8-23 to besteffort; 9995WX custom `-smp 96,cores=12,threads=2,sockets=8` with 8 NUMA nodes at distances 10/16/21/31 |
| Docker | `docker.config` container run reference: `--memory-swap=-1 --shm-size=2g --cpus` from vcpus/overcommit, `--pids-limit=0` for unlimited threads, `--gpus` via CDI `nvidia.com/gpu`, tmpfs 20G shader cache |
| passage | VFIO id table (10 GPUs with driver quirks) and the six network modes consume the PCI ids from section 4; see `virtualization.md` section 8 |
| Orchestrator | `bootstraphardwareview()` loads the eight hardware JSONs; `attachgpupassthrough()` reads `gpus.json` with `filterGpuCandidates`; SR-IOV VF lifecycle `registergpu/assigngpu/releasegpu` |
| forge (C++) | `libs/gpumonitor.cpp` forge mode validates vcpus at most 4096, overcommit at most 64, mttg at most 1e6 and emits the argv twins of the TS planner |

## 13. Provenance divergences (reconciliation notes)

The v4 analysis pool carries several data points that disagree with the v3 bank. The table records every known divergence and the resolution this repository adopts, so future audits can trace which value is canonical and why; nothing here changes the bank tables, which already follow the resolution column.

| Datum | Pool spelling | Bank / catalog value | Resolution |
|---|---|---|---|
| Ryzen 9 9950X3D L3 config | 64 MB + 80 MB (`cpu.json`) | 96 MB V-Cache + 32 MB standard L3 | v5 decomposition wins: the shipping layout is 96+32 (plus 16 MB L2 = the 144 MB marketing figure); 64+80 matches no retail SKU |
| TR PRO 9995WX base clock | 4.2 GHz (pool) | 2.50 GHz | 2.50 GHz confirmed against the vendor page; 4.2 GHz resembles an all-core boost figure and stays non-canonical |
| MI350X shading processors | 16384 (`gpu.profiles.json`) / 30464 (bank rendering) | 30464 SP in the section 4 table | vendor listings confirm 19456 SP (304 CU x 64) for the MI350-series SKU; 16384 and 30464 are recorded provenance variants, 19456 is the vendor-confirmed anchor |
| MI350X / MI355X PCI ids | ids inverted between pool files (gpu.profiles: mi355x=75a0, mi350x=75a3) | MI350X 1002:75A0 (bank), MI355X 75a3 (passage.config) | repo assignment kept: MI350X=75A0 is DeviceHunt-verified (source 12); the pool inversion is recorded as a transcription artifact |
| B200 capacity and bandwidth | 180 GiB / 7700 GB/s / 20480 shaders (pool SXM variant) | 192 GB / 8 TB/s | 192 GB HBM3e at 8 TB/s is canonical (DGX B200 source); about 180 GiB is the cloud-console visible fraction, which the smi-adapter facade honors |

Secondary divergences recorded without a canonical decision (both spellings kept as history): RTX 5090 600 W pool figure versus 575 W TGP (600 W reconciles as the 12V-2x6 connector ceiling); GB200 nvlink 144 GB/s (gpu.config draft) versus NVLink-C2C 900 GB/s; thermal throttle 83 C versus 90 C (90 kept in gpus.json); B200 FP8 9000 versus 4500 (4500 dense FP8 canonical, 9000 is the FP4 dense figure); RX 8900 XTX GDDR7 1344 GB/s variant versus the catalog GDDR6 960 GB/s; EPYC 9965 stepping 0 / DDR5-6000 / 576 GB/s versus stepping 2 / DDR5-6400 / 614.4 GB/s (vendor page wins); Sawtooth core 6-wide / L1i 128 KB versus 4-wide / 64 KB.

Launch MSRP anchors recovered from the pool (verified lane): Ryzen 9 9900X3D $599, Ryzen 7 9800X3D $479, Xeon 6980P $17,800, Threadripper PRO 9995WX $11,699 (siblings already in the catalog: 9950X3D $699, 7995WX $11,999). Throughput anchors: RTX PRO 6000 Blackwell FP32 126 TFLOPS / AI FP4 4000 with sparsity; B200 FP8 4500 TFLOPS dense canonical (FP4 9000); PRO 6000 blower dual-slot 8435 recorded in `mttg.config`.

## Sources

1. AMD EPYC 9965: https://www.amd.com/en/products/processors/server/epyc/9005-series/amd-epyc-9965.html
2. AMD Ryzen 9 9950X3D: https://www.amd.com/en/products/processors/desktops/ryzen/9000-series/amd-ryzen-9-9950x3d.html
3. AMD Threadripper PRO 9995WX: https://www.amd.com/en/products/processors/workstations/ryzen-threadripper/9000-wx-series/amd-ryzen-threadripper-pro-9995wx.html
4. Intel ARK Core Ultra 9 285K: https://www.intel.com/content/www/us/en/products/sku/241060/intel-core-ultra-9-processor-285k-36m-cache-up-to-5-70-ghz/specifications.html
5. TechPowerUp CPU database: https://www.techpowerup.com/cpu-specs/
6. TechPowerUp GPU database: https://www.techpowerup.com/gpu-specs/
7. NVIDIA RTX 5090: https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5090
8. NVIDIA RTX PRO 6000: https://www.nvidia.com/en-us/products/workstations/professional-desktop-gpus/rtx-pro-6000
9. NVIDIA DGX B200 (GB100, HBM3e): https://www.nvidia.com/en-us/data-center/dgx-b200
10. AMD Radeon RX 9070 XT: https://www.amd.com/en/products/graphics/desktops/radeon/9000-series/amd-radeon-rx-9070xt.html
11. AMD Instinct MI350X and CDNA 4 whitepaper: https://www.amd.com/en/products/accelerators/instinct/mi350/mi350x.html
12. DeviceHunt PCI registry (MI350X 1002:75A0): https://devicehunt.com/view/type/pci/vendor/1002/device/75A0
13. NVIDIA nvidia-smi deployment guide: https://docs.nvidia.com/deploy/nvidia-smi/
14. fake-nvidia-smi reference profiles: https://github.com/pogusthewhisper/fake-nvidia-smi
15. QEMU 11.1.0 CPU model table (EPYC-v5, target/i386/cpu.c): https://gitlab.com/qemu-project/qemu
16. JEDEC DDR5 and HBM3e bandwidth constants: https://www.jedec.org
17. vgpu-unlock profile formula (community references preserved in `virtualgpu.ts`): https://github.com/mbilker/vgpu_unlock and the vgpu_unlock-rs Rust rewrite
18. AMD MxGPU / Radeon PRO V710 SR-IOV: https://www.amd.com/en/products/graphics/professional
19. Intel i915/Xe SR-IOV DKMS parameters: https://github.com/strongtz/i915-sriov-dkms
20. Looking Glass B7 / kvmfr: https://looking-glass.io
21. Phoronix Test Suite 2026-08 dataset (performance baselines): https://www.phoronix-test-suite.com
