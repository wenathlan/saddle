# e2ugh v9 - Virtual Hardware Engine

**100% software, 100% free, 100% possible: virtual CPU, RAM and GPU without owning the silicon.**

e2ugh is an open source virtual hardware engine hosted at [github.com/wenathlan/e2ugh](https://github.com/wenathlan/e2ugh) (package `@wenathlan/e2ugh` 1.2.20, pins re-verified 2026-08-23) that makes any Linux container, microVM or CI runner report - and behave like - hardware it does not physically own. An unmodified `lscpu` prints an AMD EPYC 9965 with 192 cores and AVX-512. An unmodified `free -h` counts 128 GB of RAM. An unmodified `nvidia-smi` lists a B200. Unmodified `clinfo`, `vulkaninfo` and `glxinfo` find OpenCL 3.1, Vulkan 1.4 and OpenGL 4.6 devices. All of it is produced by software: a libc interception library, the Mesa CPU graphics stack, QEMU 11.1.0 MTTCG, Firecracker 1.16.1 microVMs and Docker 29.7.2 memory virtualization.

[![CI](https://github.com/wenathlan/e2ugh/actions/workflows/ci.yml/badge.svg)](https://github.com/wenathlan/e2ugh/actions/workflows/ci.yml)
[![publish ghcr](https://github.com/wenathlan/e2ugh/actions/workflows/publishghcr.yml/badge.svg)](https://github.com/wenathlan/e2ugh/actions/workflows/publishghcr.yml)
[![Web Pages](https://github.com/wenathlan/e2ugh/actions/workflows/pages.yml/badge.svg)](https://github.com/wenathlan/e2ugh/actions/workflows/pages.yml)
[![Security](https://github.com/wenathlan/e2ugh/actions/workflows/security.yml/badge.svg)](https://github.com/wenathlan/e2ugh/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)
[![npm: zero dependencies](https://img.shields.io/badge/npm-zero%20runtime%20dependencies-brightgreen)](package.json)
[![Files: flat tree](https://img.shields.io/badge/files-flat%20tree-9cf)](#repository-structure-flat-tree)

Context map (25 related contexts): tagline, badges, TL;DR proof, tool reading
surface, docker quick start, probe outputs, the one container file, date-first version
ledger, CPU catalog summary, GPU catalog summary, MIG summary, file structure,
workflows, library usage, planner CLI, operations pointers, customization
pointers, engines table, history changelog, roadmap split, dependabot,
contributing, license, sources.

---

## Security

Security fixes target the maintained `1.x` line. Vulnerability reporting follows
[SECURITY.md](SECURITY.md) (the supported line, the secrets boundary and the
supply-chain guarantees the pipelines enforce); the threat model of the spoofing
surface is documented in [docs/security.md](docs/security.md). The OSSF
Scorecard analysis of this repository runs weekly and on every main push.

## Why it is possible (TL;DR)

1. **Hardware discovery tools never touch hardware.** `lscpu` parses sysfs and `/proc/cpuinfo` (man page: "read sysfs and/or /proc/cpuinfo"), `free` parses `/proc/meminfo`, `nvidia-smi`/`pynvml`/`gpustat` talk to the NVML userspace library, `clinfo` dispatches through OpenCL ICD manifests, `vulkaninfo` enumerates ICD JSONs under `/usr/share/vulkan/icd.d`, `glxinfo` asks the X display. Interpose the file reads and the libraries, and every one of these tools reports whatever the interposer decides.
2. **Functional spoofing is a solved, documented technique.** `libs/virtualhardware.c` intercepts the complete libc file-access family (`open`, `open64`, `openat`, `fopen`, `freopen` variants), redirects procfs reads to generated profiles, hooks `sysinfo()` with `mem_unit` normalization, `uname()` and `gethostname()`, and resolves every real symbol with `dlsym(RTLD_NEXT, ...)`. The lineage follows three proven implementations: [memoverlay](https://github.com/stantheawesomeman/memoverlay), [dolos](https://github.com/cdt4/dolos) and the [nvml-unified-shim](https://github.com/rick-hsu/nvml-unified-shim) pattern.
3. **Emulation supplies what spoofing cannot reach.** CPUID, true core counts and cache topology need a real CPU context - QEMU 11.1.0 with MTTCG and the `EPYC-v5` model (confirmed in `target/i386/cpu.c` of the QEMU tree) provides one. GPU compute needs a working API - Mesa 26.2.1 provides llvmpipe (OpenGL 4.6 core, 161/161 extensions on [Mesamatrix](https://mesamatrix.net)), lavapipe (Vulkan 1.4, Khronos-conformant on the Vulkan 1.3 CTS) and Rusticl (OpenCL 3.1). Nothing is stubbed: rendering and compute genuinely execute, on the CPU.
4. **Memory is elastic, not finite.** Docker `--memory-swap=-1` means unlimited swap up to host capacity (Docker reference), `--shm-size=2g` lifts the 64 MB `/dev/shm` default that breaks PyTorch dataloaders ([googlecolab/colabtools#329](https://github.com/googlecolab/colabtools/issues/329)), `vm.overcommit_memory=2` stretches CommitLimit, zram compresses swap in memory, KSM deduplicates pages, 1 GiB hugepages back large models. A "128 GB" sandbox is an accounting decision, not a lie the kernel can expose.
5. **The performance is real.** AVX-512 executes in the llvmpipe JIT (vector width 512, Gallivm MR [!17813](https://gitlab.freedesktop.org/mesa/mesa/-/merge_requests/17813)), QEMU MTTCG runs one host thread per vCPU with a 1 GiB translation-block cache, Firecracker snapshot restores take 3-5 ms instead of 125 ms cold boots, and Buildx GHA caching takes the reference build from 103 s to 25 s. Stacked, end-to-end times drop 3-5x.

The full proof table, detection-depth ladder and refutation of the "impossible" analysis live in `docs/viability.md`.

## How the tools read hardware

| Tool | What it actually reads | What e2ugh answers |
| --- | --- | --- |
| `lscpu` | sysfs + `/proc/cpuinfo` (man7 lscpu.1) | generated `/proc/cpuinfo` with EPYC 9965 identity, 192 blocks |
| `free` | `/proc/meminfo` parse (man7 free.1) | generated 53-field `/proc/meminfo` in kB, MemTotal 134086656 kB |
| `nvidia-smi` / `pynvml` / `gpustat` | NVML (`libnvidia-ml.so.1`) | NVML shim + virtual nvidia-smi adapter (driver 575.57.08, CUDA 12.9) |
| `clinfo` | OpenCL ICD dispatch (`/etc/OpenCL/vendors/*.icd`) | Rusticl on llvmpipe, `RUSTICL_DEVICE_TYPE=gpu`, OpenCL 3.1 |
| `vulkaninfo` | Vulkan loader + ICD JSONs (`VK_DRIVER_FILES`) | lavapipe ICD `lvp_icd.x86_64.json`, Vulkan 1.4 |
| `glxinfo` | OpenGL/GLX implementation of the X display | llvmpipe on Xvfb `:99`, OpenGL 4.6 core |
| `sysinfo(2)` | kernel syscall | hooked by `virtualhardware.c`, `totalram` normalized by `mem_unit` |
| `CPUID` (raw instruction) | the silicon | QEMU `-cpu EPYC-v5,+avx512f,...` under TCG/MTTCG |

The spoofing surface threat model (what static binaries can bypass and why) is documented in `docs/security.md`.

---

## Quick start

The engine image publishes to GHCR for `linux/amd64` and `linux/arm64`. The two memory flags are the contract: unlimited swap lets the 128 GB profile lean on overcommit, and the 2 GiB `/dev/shm` keeps multiprocessing workloads away from the 64 MB Docker default.

```bash
docker run --rm -it \
  --memory-swap=-1 \
  --shm-size=2g \
  ghcr.io/wenathlan/e2ugh:latest \
  bash
```

Inside the container, unmodified system tools report the virtual machine (the full format specification and generator rules are in `docs/hardware.md`):

```console
# head -6 /proc/cpuinfo
processor       : 0
vendor_id       : AuthenticAMD
cpu family      : 25
model           : 17
model name      : AMD EPYC 9965 192-Core Processor
stepping        : 2

# grep -o 'avx512[a-z_]*' /proc/cpuinfo | sort -u
avx512_bf16
avx512bw
avx512cd
avx512dq
avx512f
avx512vl

# free -h
               total        used        free      shared  buff/cache   available
Mem:           127Gi       412Mi       126Gi        18Mi       612Mi       126Gi
Swap:            8Gi          0B         8Gi

# nvidia-smi
NVIDIA-SMI 575.57.08   Driver Version: 575.57.08   CUDA Version: 12.9
+-----------------------------------------------------------------------------------------+
| GPU  Name                 Persistence-M | Bus-Id        Disp.A | Volatile Uncorr. ECC |
|   0  B200                 On            | 00000000:07:00.0  Off |                    0 |
| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |
| N/A   34C    P0             412W / 1000W |         96MiB / 196608MiB |      0%   Default |

# clinfo -B | head -4
Platform #1: Name: rusticl, Version: OpenCL 3.1
  Device #1: llvmpipe - OpenCL 3.1 (device type: GPU)

# vulkaninfo --summary | head -8
apiVersion: 1.4.0
deviceName: llvmpipe (LLVM 22.1.8)
deviceType: CPU

# glxinfo -B | grep -E 'renderer|version'
OpenGL renderer string: llvmpipe (LLVM 22.1.8, 512 bits)
OpenGL core profile version string: 4.6 (Core Profile) Mesa 26.2.1
```

The full stack (engine sandbox, QEMU guest runner, gpu-monitor sidecar) runs with the hardened `docker run` recipes documented in the `Dockerfile` header — the compose stack and the entrypoint bootstrap are merged into the one container file (the gateway 1.1.5 standard: `docker-compose.yml` and `entrypoint.sh` are deleted), and the same memory contract (`--memory-swap -1`, `--shm-size 2g`) rides on every recipe. QEMU-specific knobs (`EPQC-v5` CPU model policy, `tb-size`, OVMF paths) live in `qemu.config`; the boot chain, engine matrix and snapshot backends are documented in `docs/virtualization.md`.

---

## Component versions (date-first, 2026-08-23)

Every version below was confirmed against a primary source (release notes, official registry or vendor page); the ledger was re-verified on 2026-08-23, which corrected the kernel, OVMF, wgpu, Spin and WireGuard rows (the earlier 7.2.1/20260213/24.x pins never existed as releases and are not cited anywhere in this repository). The rule is date-first with primary-source precedence: when an older ledger and a newer verified release disagree, the newer release wins and the old pin becomes history.

| Component | Version (date) | Primary source |
| --- | --- | --- |
| Node.js (Current) | 26.7.0 (2026-08-05, V8 14.6, Temporal, Undici 8) | nodejs.org/en/blog/release/v26.7.0 |
| Node.js (LTS) | 24.19.0 "Krypton" (2026-08-03) | nodejs.org/en/blog/release/v24.19.0 |
| npm | 12.0.2 (2026-07-29; the Node 26 default line) | registry.npmjs.org/-/package/npm |
| Python | 3.14.7 (2026-08-05; the 3.13 lane holds at 3.13.15) | endoflife.date/api/python.json, python.org/downloads |
| TypeScript | 7.0.2 (GA 2026-07-08, native Go port) | npmjs.com/package/typescript, devblogs.microsoft.com/typescript/announcing-typescript-7-0 |
| Docker Engine | 29.7.2 (2026-08-05, API 1.52) | docs.docker.com/engine/release-notes/29 |
| Docker Buildx | 0.36.1 (2026-07-29) | github.com/docker/buildx/releases |
| Biome | 2.5.11 (2026-08-27) | npmjs.com/package/@biomejs/biome |
| Mesa 3D | 26.2.1 (2026-08-20 stable; 26.3-devel open) | docs.mesa3d.org/relnotes/26.2.1.html |
| LLVM | 22.1.8 (2026-07-10) | github.com/llvm/llvm-project/releases |
| QEMU | 11.1.0 (2026-08-11, 3200 commits, 285 authors, 12 CVE fixes) | qemu.org/2026/08/11/qemu-11-1-0 |
| Firecracker | 1.16.1 (2026-07-02) | github.com/firecracker-microvm/firecracker/releases |
| gVisor | release-20260817.0 (2026-08-19) | github.com/google/gvisor/releases |
| Kata Containers | 4.1.0 (2026-08-21, runtime-rs default) | github.com/kata-containers/kata-containers/releases |
| Cloud Hypervisor | 53.0 (2026-07-12) | github.com/cloud-hypervisor/cloud-hypervisor/releases |
| CRIU | 4.2.1 (2026-07-21) | github.com/checkpoint-restore/criu/releases |
| Wasmtime | 48.0.0 (2026-08-20, LTS until 2028-08-20) | github.com/bytecodealliance/wasmtime/releases |
| wgpu (Rust WebGPU) | 30.x (wgpu-info 30.0.0, 2026-07) | crates.io/crates/wgpu |
| OpenSSL | 3.5.5 (bundled in Node 24/26, PQ defaults) | openssl-corporation.org/post-quantum.html |
| Linux kernel (reference) | 7.1.9 stable (2026-08-19); 6.18.45 longterm; mainline 7.2 since 2026-08-16 | kernel.org |
| containerd | 2.3.4 (2026-08; time-based minors, no LTS seal) | github.com/containerd/containerd/releases |
| Spin (spinframework) | 3.6.0 | github.com/spinframework/spin/releases |
| libvirt / OVMF / OVS / DPDK / WireGuard | 12.5.0 / edk2-stable202605 / 3.7.1 LTS / 26.07.0 / kernel mainline (in-tree since 5.6) | docs/virtualization.md ledger |

GitHub Actions pin ledger, re-verified against release pages on 2026-08-23 (the workflow files align to this set in the v4 correction pass): `actions/checkout@v7.0.1`, `actions/setup-node@v7.0.0`, `actions/cache@v6.1.0`, `actions/setup-python@v7.0.0`, `actions/dependency-review-action@v5.0.0`, `docker/setup-qemu-action@v4.2.0`, `docker/setup-buildx-action@v4.3.0`, `docker/login-action@v4.6.0`, `docker/metadata-action@v6.2.0`, `docker/build-push-action@v7.3.0`, `github/codeql-action@v4.37.8` (the v3 major is deprecated from December 2026). The engine embeds the same ledger in the frozen `engineversions` constant of `index.ts` so generated artifacts cite exact versions without a network round trip.

---

## Virtual hardware catalog (summary)

The data files carry 57 processor identities and 19 discrete GPUs plus 5 APU graphics blocks; the full tables, PCI IDs, bandwidth constants and generated-text walkthroughs live in `docs/hardware.md`.

| Layer | Count | Highlights |
| --- | --- | --- |
| Processors (v5 verified bank) | 6 | EPYC 9965 192c/384t SP5, EPYC 9955 128c, Threadripper PRO 9995WX 96c sTR5, Threadripper 7980X 64c, Ryzen 9 9950X3D 16c AM5, Core Ultra 9 285K 24c LGA1851 |
| Processors (OMNI catalog) | 51 more (2024-2026) | Ryzen 9000 X3D family incl. 9950X3D2 dual X3D 192 MB, Threadripper 9000 Shimada Peak, EPYC 9755/9575F, Xeon 6980P Granite Rapids, Apple M3 Ultra, ARM Neoverse V3/Cobalt-200 |
| GPUs (verified bank) | 7 | RTX 5090 (10DE:2B85), RTX PRO 6000 Blackwell (10DE:26B5), B200 (10DE:2665), H100 (10DE:2330), A100 (10DE:20B0), RX 9070 XT (1002:748E), Instinct MI350X (1002:75A0) |
| GPUs (catalog) | 12 more | RTX 5080/5070/5070 Ti, B100/GB200, H200, A100 80GB, RX 8900 XTX, RX 7900 XTX, Arc B770/B580, MI355X, virtio-gpu (1AF4:1050) |
| APU graphics | 5 RDNA iGPU blocks | Raphael/Hawk Point/Strix Point/Strix Halo/Krackan Point |
| Boards | 20 retail + platform reference | X870E/B850/Z890/TRX50/WRX90 tiers, SP5/TR5/AM5 sockets |
| MIG slicing | 11 profiles | 96 GB divides into 4 x 1g.24gb, 2 x 2g.48gb or 1 x 4g.96gb; Blackwell layouts reach 7g.192gb with 7-instance density |

Modularity ceilings, documented with all three historical answers and the chosen policy (catalog ceiling 1-192 vCPUs, factory ceiling 1-1024, hotplug ceiling 4096 with `maxcpus` headroom): see `docs/hardware.md` section 7.

---

## Repository structure (flat tree)

The CI pipeline enforces the flat contract: one concern per file with 20-25 related contexts inside, at most two directory levels (`libs/`, `docs/`, `tests/`, `web/`, `.github/workflows/`), lowercase file names, and no duplicated content between files (the md5 guard that caught the README-cloning failure of earlier generations). The table reflects the tree as `find . -type f` lists it; `scheduler.ts`, `compute.ts` and the `tests/` suite are the v3 additions (the former `future.ts` was decomposed into them).

| # | File | One-line role |
| --- | --- | --- |
| 1 | `readme.md` | this master guide |
| 2 | `package.json` | npm manifest: @wenathlan/e2ugh 1.2.20, ESM, zero runtime dependencies (ships the engine only; web is not part of the npm package) |
| 3 | `tsconfig.json` | TypeScript 7.0.2 gate (ES2025, NodeNext, strict, erasableSyntaxOnly) |
| 4 | `biome.json` | Biome 2.5.11 lint/format configuration |
| 5 | `Dockerfile` | the one container file: multi-stage image (Mesa 26.2.1, LLVM 22.1.8, QEMU 11.1.0, Node 26) with the entrypoint bootstrap embedded as a heredoc COPY and the hardened docker run recipes (engine + qemu guest + gpu sidecar, memswap -1, shm 2g) — the merged `docker-compose.yml`/`entrypoint.sh` of the compose era |
| 6 | `.gitignore` | keeps build artifacts, node_modules and local dependabot out of the tree |
| 7 | `index.ts` | library entry: factory, validation, event bus, metrics, planner, barrel |
| 8 | `orchestrator.ts` | six runtime strategies, sandbox lifecycle, warm pools, RBAC, NUMA scheduler |
| 9 | `scheduler.ts` | tenant placement, QoS classes, AIP-sched policy, PSI-LSTM predictors, anomaly detection |
| 10 | `compute.ts` | wasm 48 LTS tier, webgpu (wgpu 30.x) paths, AI workload planners, Node 26 APIs, checkpoint and PQ usage |
| 11 | `virtualcpu.ts` | processor bank, cpuinfo/lscpu renderers, topology solver, scoring |
| 12 | `virtualmemory.ts` | memory tiers, NUMA, overcommit, KSM, MIG profiles, host-aware planner |
| 13 | `virtualgpu.ts` | GPU identity bank, VFIO bind/unbind, vGPU profiles, MIG density validator |
| 14 | `virtualization.ts` | QEMU turbo argv builder, passage stack, MTTG cgroups, checkpoint/restore plans |
| 15 | `render.ts` | Mesa environment builders, GPU profiles, virtual nvidia-smi adapter rendering |
| 16 | `security.ts` | Landlock, seccomp, eBPF LSM, cgroups v2, PQ TLS policy, Rfc10024 and PqcAuditTrail |
| 17 | `performance.ts` | seven performance layers plus benchmark harness |
| 18 | `alternatives.ts` | ten categories of alternative sandbox engines with adapters |
| 19 | `qemubridge.py` | async QMP bridge client plus a100/h100 smi-adapter facade |
| 20 | `libs/virtualhardware.c` | LD_PRELOAD procfs spoofing core (memoverlay/dolos lineage) |
| 21 | `libs/gpumonitor.cpp` | C++26 GPU shim suite: smi-adapter CLI, NVML/libcuda shim, forge mode |
| 22 | `libs/virtualizationcore.cpp` | C++26 KVM/VFIO/QMP core, vGPU scheduler, MIG manager, NVENC tables |
| 23 | `processors.json` | 57-CPU registry with cpuid reference, lscpu templates, QEMU models |
| 24 | `gpus.json` | 19-GPU registry, APU blocks, smi-adapter profiles, MIG, shims |
| 25 | `cores.json` | core types (P/E/LPE), vCPU factory 1-1024, memory presets |
| 26 | `boards.json` | 20 boards, SP5/TR5/AM5 platform reference, interconnect data |
| 27 | `vm.config.json` | 22 VM profiles, CPU/memory presets, hypervisors, production example |
| 28 | `virtualhardware.json` | master schema binding the data files, module modes, defaults |
| 29 | `qemu.config` | QEMU 11.1.0 configuration, MTTCG section, spoofing hooks, libvirt overlay |
| 30 | `mttg.config` | cgroups v2 controllers, tenants, QoS classes, transcode pipeline |
| 31 | `passage.config` | gateway, passthrough modes, network binding (never localhost), playbook |
| 32 | `docker.config` | Docker 29.7.2 engine, stages, seccomp, CDI, containerd 2.3.4 reference |
| 33 | `.github/workflows/ci.yml` | lint, typecheck matrix, node --test, build, flat-structure guard, JSON schema |
| 34 | `.github/workflows/publishghcr.yml` | the combined container pipeline: per-arch validation legs on every push and the four-arch GHCR publication (amd64, arm64, ppc64le, s390x) with runtime probes, provenance and SBOM attestations on every release |
| 35 | `.github/workflows/release.yml` | GHCR + npm + level-9 source zip on tags |
| 36 | `.github/workflows/security.yml` | CodeQL, dependency review, container scans, gitleaks, Scorecard |
| 37 | `docs/architecture.md` | architecture reference: principles, module map, patterns, modes, tests |
| 38 | `docs/hardware.md` | hardware bank reference: catalogs, modularity, generated texts |
| 39 | `docs/virtualization.md` | QEMU/Firecracker/passage/MTTG stack reference |
| 40 | `docs/security.md` | the 2026 defense stack (Landlock to post-quantum) |
| 41 | `docs/performance.md` | the seven optimization layers and benchmarks in depth |
| 42 | `docs/viability.md` | the proof, research methodology, 145-entry bibliography and roadmap appendices A-C |
| 43 | `docs/alternatives.md` | ten alternative sandbox families compared against the engine |
| 43b | `docs/optimization.md` | the build-pipeline optimization roadmap (cross-compilation, prebuilt QEMU/Mesa layers, runner strategy) for the slow multi-arch grid |
| 44 | `tests/` | node:test suite executed by ci.yml with `node --test` (153 cases, including CI-gate replay and end-to-end simulation suites) |
| 45 | `web/` | the web node (v7): `index.html` terminal sandbox, `login.html`/`register.html`/`dashboard.html` auth pages, `sandbox.js` browser-pure engine port (20 commands), `localauth.js` static-edge browser accounts (login/register/dashboard keep working on github pages with no api; accounts are mirrored to IndexedDB so partial clears never lose them, the dashboard carries backup/restore keyfile buttons, and the CODEOWNERS admins iakadion + akadion are seeded automatically with the shared bootstrap password - surviving any storage reset), `server.js` self-hosted node:http API (`/api/v1` sandboxes and exec), `db.js` sqlite persistence layer, `auth.js` scrypt password hashing with cookie sessions, `mesh.js` HMAC-signed node-to-node calls, `package.json`/`Dockerfile` (image `ghcr.io/wenathlan/e2ugh`; node pinned by the root `.nvmrc`), `schema.prisma`/`init.sql` database definition kept flat per the two-level contract, `mime.types`, `vercel.json`/`netlify.toml` static deploy without functions, `caddyfile` self-host proxy for devthink.pro, `readme.md` web docs |
| 46 | `LICENSE` | full MIT text (Copyright (c) 2026 wenathlan) |

Module internals, the single-event-bus/single-state-machine/single-metrics resolution and the design-pattern map are documented in `docs/architecture.md`.

---

---

## Quantum layer (quantum.ts)

A classical quantum-simulation layer - every "qubit" is a float64 pair in
a 2^n statevector, the same virtualization doctrine as cores and gpus.
`quantum.ts` ships a statevector simulator (1-20 qubits, gates h/x/y/z/s/t
/rx/ry/rz/cnot/cz/toffoli/swap, crypto-seeded measurement), provable
canonical circuits (bellstate 50/50, ghz, grover2 finding |11> with one
iteration, grover3, deutsch discrimination, teleportation sketch), the
bb84 (1984) key exchange with intercept-resend detection (qber rises from
~0.20 to ~0.32 with eve and the flag trips) and the e91 (1991) entangled
variant with chsh, quantum-inspired randomness with the honest anu qrng
fallback note, the dna vault (goldman 2013 encoding: homopolymer runs <=3,
four redundant strands, byte-perfect roundtrip, 215 pb/g capacity planner
- 1 tb weighs 5.1e-6 grams), the 5d quartz planner (360 tb/disc,
femtosecond write plan, 13.8 billion years at room temperature), the qram
bucket-brigade model (giovannetti prl 2008) and the shor plan note (15 =
3x5 documented; beyond 15 exceeds the 20-qubit honest statevector
ceiling). Versions verified 2026-08-23: qiskit 2.5.2, quantum-circuit
(npm) 0.9.250 - the only active js simulator family, hqc selected as the
5th nist algorithm (march 2025, draft ~2026). The `quantum` terminal
command renders the summary inside any sandbox.

## Layered virtual memory (tiers.ts)

The saddle storage doctrine applied to the engine: everything is vram.
`tiers.ts` ships the four-tier model (l1 ram ~100ns, l2 vram identity,
l3 storage-as-ram via the sqlite kv lru, l4 buckets ~50us), the latency
ladder, autoscale by size (<64 mb memfs / <1 gb mmap / larger sqlite+r2),
the `memoryengine` (load iterates backends, persist writes all, the
storage==compute transform with the same bytes and the vfs magic-number
sniffer), npm-as-disk (200 mb chunks published as `.bin.js` packages on
the unlimited jsdelivr/unpkg/esm cdn farm), the github artifacts backend
(real rest via fetch), vdr 64-bit bigint addressing up to 9.22 eb with
ring-buffer demotion l1 to l3, the zram/tmpfs/swapfile bridge recipes
(zram 2-3x amplification), the sysctl drop-in and cgroups v2 slices. The
free pool catalog counts >33 tb across hf/kaggle/terabox/github/npm; the
`tiers` terminal command renders the summary inside any sandbox.

## The unlimited defaults

Sandboxes per account are uncapped (`E2UGH_MAX_SANDBOXES=0` default); the
workspace quota per sandbox (4-256 MiB) remains the database bound. The
`streaming` command and `planmodelstreaming` demonstrate any-size
workloads inside a small hot window - see web/readme.md "the unlimited
path".

## Try it in the browser

The `web/` folder ships the browser edition of the engine - the same virtual hardware surface, running client-side with zero dependencies. Start the self-hosted API and open the page:

```bash
node web/server.js          # binds a random 30000-59999 port once (PORT or --port to pin)
# then open web/index.html, pick a CPU (EPYC 9965, Ryzen 9 9950X3D, Threadripper PRO 9995WX, Xeon 6980P, M3 Ultra), slide vCPUs to 192 and RAM to 1024 GB, attach a B200, press start and type:
lscpu                        # AMD EPYC 9965 Virtual Compute Engine + AVX-512
nvidia-smi                   # the 89-column adapter table, driver 575.57.08, CUDA 12.9
clinfo                       # Rusticl OpenCL 3.1 on llvmpipe
```

The browser terminal implements twenty commands over the same byte-faithful generators the libc library serves inside containers. The `server.js` API exposes the identical dispatcher under `POST /api/v1/sandboxes/:id/exec` with a fifteen-minute sandbox TTL - the contract the saddle infrastructure (and, later, the Sedal) consumes. Deployment is static-edge only: `vercel.json` and `netlify.toml` carry no functions on purpose (no serverless lock-in), and the `caddyfile` reverse-proxies the self-hosted node process for devthink.pro.

The v7 web node turns that single-process deployment into a small mesh: one authoritative main node plus any number of static clones.

```
                       browser (any device)
                               |
              -----------------+-----------------
             |                                   |
             v static clone                     v main node
   +---------------------+   HMAC-signed    +------------------------------+
   | vercel / netlify    | -------------->  | devthink.pro (caddy, tls)    |
   | static pages:       |   mesh call      | node web/server.js           |
   | index login register| <--------------- |   + db.js   (sqlite)         |
   | dashboard sandbox.js|   json reply     |   + auth.js (scrypt, cookie) |
   +---------------------+                 |   + mesh.js (HMAC verify)    |
             |                             |   + sandbox.js dispatcher    |
             v                             +------------------------------+
   sandbox.js runs the full                       |            |
   engine client-side,                     sqlite file     signed-out clones
   zero dependencies, works                 (users,        get 401 from the
   offline too                              sessions,      auth authority
                                            sandboxes)
```

- **Static edge.** The clones ship only the immutable pages and `sandbox.js`; they are redeployed by the `pages.yml` static bundle (zip -9 with SHA-256 checksums) and never hold secrets, a database or a process. `sandbox.js` keeps working with no backend at all.
- **Auth authority stays on the main node.** `web/auth.js` hashes passwords with the node:crypto `scrypt` KDF (random salt per user, timing-safe comparison), issues random session tokens stored server-side and delivered as `HttpOnly` cookies, and only `devthink.pro` ever touches the sqlite file through `web/db.js`. A clone has no login backend by design: it forwards credentials over the mesh instead of ever seeing them stored.
- **HMAC mesh.** Every clone-to-main call is signed by `web/mesh.js` with a shared secret (HMAC-SHA256 over method, path, body digest and timestamp, replay-window bounded); the main node rejects unsigned, replayed or drifting requests with 401/403 before routing. The signature travels in a header, never as a query string.
- **Self-hosted node, no serverless.** The whole backend is one `node web/server.js` process (pure node:http, zero npm runtime dependencies), packaged as the multi-arch image `ghcr.io/wenathlan/e2ugh` (linux/amd64, linux/arm64, linux/ppc64le and linux/s390x on the max profile, registry-cached, provenance-attested) published by `publishghcr.yml` on every release:

```bash
docker run --rm -p 37810:37810 -e E2UGH_DB=/data/e2ugh.db -v e2ughdata:/data \
  ghcr.io/wenathlan/e2ugh node /engine/web/server.js --port 37810
```

## GitHub workflows

Five workflows gate the repository, all pinned to action releases verified on 2026-08-22:

- **ci.yml** (every push and pull request) - six gates: Biome 2.5.11 lint and format; `tsc --noEmit` with TypeScript 7.0.2 on a Node 24/26 matrix; the Node built-in test runner over the dedicated `tests/` suite (153 node:test cases); a build gate; the flat-structure contract (flat tree, no deep nesting, no duplicated content via md5); strict JSON schema validation of every tracked data file.
- **hardware variants** (publishghcr.yml matrix) - one dockerfile, three curated profiles baked at build time so operators pull exactly the flavor they need: `ghcr.io/wenathlan/e2ugh:latest` (max: EPYC 9965 192c/384t, 1 TiB plan, 8x B200), `:balanced` (Threadripper PRO 9995WX 96c/192t, 512 GiB, 2x B200) and `:lite` (Ryzen 9 9950X3D 16c/32t, 128 GiB, 1x RTX 5090); every profile tag also carries semver and sha suffixes, and the runtime overlay (`VHE_TOTALRAM_GB`, `VHE_CPUS`, `VHE_GPU_PROFILE` environment variables) still lets any variant report any catalog identity up to 18 TiB at run time - the baked profile is the default identity, never a ceiling.
- **publishghcr.yml** (the combined container pipeline; main, tags and releases) - per-architecture validation legs (`linux/amd64` native; `linux/arm64`, `linux/ppc64le` and `linux/s390x` under QEMU user emulation) that validate the live stack inside the built image: `clinfo` must report Rusticl OpenCL 3.1 on llvmpipe, `vulkaninfo --summary` must find lavapipe Vulkan 1.4, and Xvfb + `glxinfo` must report llvmpipe OpenGL 4.6, executed with `--memory-swap=-1 --shm-size=2g`. On releases, production builds push per-arch images by digest (the max profile ships the four-arch registry surface: amd64, arm64, ppc64le, s390x) with provenance `mode=max` and SBOM attestations before `docker buildx imagetools` assembles the per-profile manifest indexes.
- **release.yml** (version tags and releases) - three publications: the multi-arch GHCR image, the npm package with `--provenance --access public` (zero runtime dependencies), and a maximum-compression (level 9) source zip with SHA-256 checksums.
- **pages.yml** (web/ or tests/ changes on main, manual) - the web pipeline in one workflow: `node --check` on the five web modules (`server.js`, `db.js`, `auth.js`, `mesh.js`, `sandbox.js`), a boot smoke test on the pinned port 37810 (health endpoint and login page must answer 200), a python `html.parser` well-formedness lint of the four pages, the node:test webapi suite (auth and mesh coverage) with a throwaway `E2UGH_DB`, a zip -9 static bundle with SHA-256 checksums as an artifact (attached to tag releases by `release.yml`), and the GitHub Pages deployment of the whole `web/` tree (static-first, SPA fallback, `.nojekyll`) through configure-pages/upload-pages-artifact/deploy-pages. The pages are page-relative (`login.html`, `dashboard.html`) so every route resolves both on the self-hosted node and inside the `/e2ugh/` sub-path of github pages.
- **security.yml** (pushes, pull requests, weekly) - CodeQL semantic analysis for C/C++ and TypeScript, dependency review, Dockle and Trivy container scans with SARIF upload, gitleaks history scan, OSSF Scorecard, the Biome security rule group at blocking severity and an npm license allow list.

A deliberate CI fact: GitHub-hosted runners expose no `/dev/kvm` ([actions/runner-images#12933](https://github.com/actions/runner-images/issues/12933)), so QEMU-based validation runs under TCG with `thread=multi`, and Firecracker/Kata/Cloud Hypervisor paths are exercised only on self-hosted or bare-metal runners - the orchestrator detects the absence and falls back automatically.

---

## Library usage

The engine is a library first: zero runtime dependencies, ESM, TypeScript sources executed natively by Node 24+ type stripping. The barrel in `index.ts` re-exports `virtualcpu.ts`, `virtualmemory.ts`, `virtualgpu.ts` and `virtualization.ts`; `orchestrator.ts`, `scheduler.ts`, `compute.ts`, `render.ts`, `security.ts`, `performance.ts` and `alternatives.ts` are importable through the package subpaths declared in `package.json`.

```ts
import {
  createVirtualEngine,     // factory with health, snapshot, registry
  validateSpec,            // dependency-free spec validator (9 rules + warnings)
  randomPort,              // crypto.randomInt(30000) + 30000, never a default port
  generateVirtualCpuinfo,  // byte-accurate /proc/cpuinfo payload
  generateVirtualMeminfo,  // 53-field /proc/meminfo payload
  planmemory,              // swap, hugepages, KSM, overcommit, docker flags
  createVirtualProcessor,  // provisioned CPU from the verified bank
  BEST_VIRTUAL_PROCESSORS, // the immutable six-identity bank
  buildqemucmd,            // turbo QEMU 11.1.0 argv (TDX/SEV/vfio/venus)
  creategrid,              // MTTG work-stealing grid (MTTG_MAX = 1e6)
  defaultplan, plantoml, planlint,  // planner: plan -> argv/docker/toml + lint
} from '@wenathlan/e2ugh';

const engine = createVirtualEngine({
  vcpus: 16,
  memoryGB: 64,
  vramGB: 24,
  host: 'sandbox.internal',  // never a hardcoded default: the caller decides
  // port omitted -> crypto-random in 30000-59999
});

const cpuinfo = generateVirtualCpuinfo('AMD EPYC 9965', 192);
const meminfo = generateVirtualMeminfo(128);
const memplan = planmemory({ memoryGB: 128, hugepages: '1g' });
const lint = planlint(defaultplan);      // mttg floor, overcommit ceiling checks
const toml  = plantoml(defaultplan);     // human-editable vm.config output
```

The planner doubles as a CLI: `node --experimental-strip-types index.ts` reads a `vm.config.toml`, plans the topology, and emits QEMU argv, a `docker run` line and a lint report. Development commands: `npm run typecheck` (TypeScript 7.0.2 gate), `npm run lint` (Biome 2.5.11) and `node --test tests/` (see How to test below). Operational runbooks (host hardening, VFIO troubleshooting, capacity planning, incident: unbind of the only GPU) are condensed in `docs/virtualization.md` and expanded per-layer in the sibling docs.

---

## How to test

The test contract is the Node built-in runner: no Jest, no third-party harness, no install step (zero runtime dependencies).

```bash
# from a checkout (Node 24+)
npm run typecheck                 # tsc --noEmit, the TypeScript 7.0.2 gate
npm run lint                      # Biome 2.5.11
node --test 'tests/*.test.ts'      # the node:test suite (153 tests) - the glob form ci.yml uses

# from the published image (GHCR, linux/amd64 and linux/arm64)
docker run --rm --memory-swap=-1 --shm-size=2g \
  ghcr.io/wenathlan/e2ugh:latest \
  bash -lc 'lscpu | head -3; free -h; nvidia-smi | head -12; clinfo -B | head -4'
```

The `tests/` suite (Node 26.7.0 in CI, Node 24+ locally, `node:assert/strict`, 153 tests across eleven files: engine, render, specs, virtualcpu, virtualgpu, virtualmemory, media, features, plus workflow and simulation suites that replay the CI gates and the engine end to end) covers the planner and its lint rules, the `/proc/cpuinfo` and `/proc/meminfo` generators, the MIG density validator and the QEMU argv builder; the patterns are documented in `docs/architecture.md`. The docker probe above is the same surface `publishghcr.yml` validates inside the image: `clinfo` must report Rusticl OpenCL 3.1 on llvmpipe, `vulkaninfo --summary` must find lavapipe Vulkan 1.4 and `glxinfo` on Xvfb must report llvmpipe OpenGL 4.6.

---

## Ten alternative sandbox engines

`alternatives.ts` implements a common `SandboxEngine` adapter interface over ten categories of runtimes so the engine can be benchmarked or replaced without touching application code (comparison data verified 2026-08-22; full profiles in `docs/viability.md` and `docs/performance.md`):

| Engine | Version | Standout characteristic |
| --- | --- | --- |
| Wasmtime + WASI 0.2/0.3 | 48.0.0 LTS | fuel metering and epoch interruption; deterministic timeouts |
| gVisor (runsc) | release-20260817.0 | userspace kernel on systrap; typical 10-30% I/O overhead |
| Kata Containers | 4.1.0 | Rust runtime-rs default; QEMU/CLH/Firecracker/Dragonball/OpenVMM |
| Cloud Hypervisor | 53.0 | rust-vmm VMM with offloaded snapshot/restore, vfio-user |
| WebContainers (StackBlitz) | GA API | Node.js and npm entirely inside the browser sandbox |
| Daytona | current | self-hostable sandboxes in ~90 ms with MCP support |
| Modal | platform | 100k+ concurrent sandboxes, sub-second scheduling, elastic GPUs |
| Fly.io Machines | platform | global Firecracker microVM API across ~35 regions |
| E2B family (E2B/Morph/Cognitora/Vercel Sandbox) | current | E2B ~150 ms cold (UFFD restore); Vercel Sandbox GA 2026-01-30 |
| Apple Containers | 1.2.2 | Linux containers in microVMs on Apple Silicon, boot under 1 s |

---

## History (six generations, condensed)

| Generation | Era | What it was | Fate in the current tree |
| --- | --- | --- | --- |
| e2ugh reports v1-v5 (Meta AI session) | 2026-08, Portuguese | Eleven merged research reports: 1000+ multilingual searches, 23 core proofs, optimized architecture with code, 10 alternative categories, 7-layer speed table, public repo plan | Source pool for viability proofs and the history record; PT content cited, not cloned |
| E2ugh V5 | 2026-08-22 wave | Flat shielded repo (44 files, 17 numbered docs, 5 workflows, 11 configs, 5 src) built by 16 subagents in 2 waves; pinned Node 24.19/26.7 and QEMU 11.1.0 (its kernel pin was corrected by the 2026-08-23 verification: stable 7.1.9, longterm 6.18.45) | Delivered the OMNI data catalogs (55 CPUs, boards, cores); configs merged into the v2 JSON set |
| SADDLE v5 / v6 (Meta TS) | 2026-08-22 wave | `src_core_orchestrator.ts` (2080 lines) and `coreorchestrator.ts` (1283 lines): RBAC, NUMA scheduler, balloon, SR-IOV, passage protocols, quotas, preemption, leader election, OTel exporter; plus `pipelinememorypassage.ts` host-aware memory planning | Unique subsystems absorbed into `orchestrator.ts` (5238 lines) and `virtualmemory.ts`; duplicated buses/state machines/metrics collapsed into one of each |
| Virtual Hardware Engine v5 (e2ugh) | 2026-08-22, English | The 44-file public repo generation: 9 TS modules, 11 JSONs, 4 workflows, 10 English docs with ~120 cited sources | Baseline of the v2 code tree; modules renamed and extended (hardware -> virtualcpu, memory -> virtualmemory) |
| e2ugh v2 | 2026-08-22+ | The merge: 57 CPUs, 19 GPUs + APUs, one event bus (51 typed topics), one 15-state lifecycle, one metrics store | Baseline of the v3 redistribution |
| e2ugh v3-v9 (this repo) | 2026-08-23+ | The rebrand and redistribution: github.com/wenathlan/e2ugh, package 1.2.1, `future.ts` decomposed into `scheduler.ts` and `compute.ts` (checkpoint plans into `virtualization.ts`, post-quantum into `security.ts`), a `tests/` node:test suite, and the corrected version ledger (kernel 7.1.9/6.18.45, edk2-stable202605, wgpu 30.x, Spin 3.6.0, containerd 2.3.4, WireGuard via kernel mainline) | Current |

Full per-generation detail, including the verification reports for each wave, is preserved in `docs/viability.md`.

## Roadmap: implemented versus future

Implemented today and callable: the 78 features of the engine (55 from the former `future.ts` plus the 14 ledger builders and the 9 chatops/p2p/telemetry additions), redistributed across the domain modules - `scheduler.ts` carries tenant placement, QoS classes, the AIP-sched policy, PSI-fed LSTM predictors and anomaly detection; `compute.ts` carries the wasm tier (Wasmtime 48.0.0 LTS, WASI 0.2/0.3, WIT bindings, fuel metering, component ACL), the webgpu surface (forceFallbackAdapter over lavapipe, compute pipeline builder, WGSL cache, matmul dispatch, aligned with wgpu 30.x), the AI workload planners (dataloader /dev/shm, TF/CUDA matrix, ONNX WebGPU session, LLM inference planner, headless Stable Diffusion, VRAM budget) and the Node 26 APIs (Temporal scheduler, Float16 tensors, node:sqlite store, module.register hooks, Perfetto sink), with AI-session checkpoint and post-quantum usage; checkpoint/restore primitives (CRIU plans, MAP_PRIVATE snapshots, UFFD projection, dirty-page diff, migration state machine) live in `virtualization.ts`; the post-quantum core (ML-KEM FIPS 203, ML-DSA, X25519MLKEM768 hybrid policy, the Rfc10024 negotiator and the PqcAuditTrail tamper-evident chain) lives in `security.ts`; kernel features (idmapped mounts, tmpfs accelerator, io_uring deny policy, Landlock ABI v10 rulesets, cgroups v2 builder, hugepage planner) live in `security.ts` and `virtualization.ts`; hardware modules (MIG layout planner, vCPU hotplug, RAM hotplug to 1 TiB, multi-GPU composition, NUMA topology with numactl args, PCI device registry) live in `virtualcpu.ts`, `virtualmemory.ts` and `virtualgpu.ts`; developer experience (spec hot-reload bus, OTel bridge, health registry, graceful shutdown, plugin hooks) stays in `index.ts` and `orchestrator.ts`.

Future (not yet in code, tracked as the F-001..F-065 ledger with two dated sets): CXL 3.0 Type-3 pooling with QoS, NVLink-C2C 900 GB/s coherent fabrics, HBM3e disaggregated pools with UCIe, vGPU live migration on Blackwell, MIGv2 14-slice layouts, CUDA checkpoint with GDS, NVSwitch 576-GPU fabrics, sched_ext custom scheduler classes, PSI-autotuned rebalancing, io_uring vsock/unix bridges and fixed-buffer NVMe 14 GB/s paths, DPU offload (BlueField-3/Pensando/IPU), SR-IOV dynamic VF to 32 per pGPU, SEV-SNP/TDX second generation with confidential GPUs, RL autoscaler 1-4096 vCPUs, K8s operator CRDs, CRDT vm.config (Automerge/Yjs), GitOps Flux+OPA and federated 10k clusters. Both dated sets (v5 set A and v6 set B - same IDs, different content) are preserved verbatim in `docs/viability.md` appendices A and B; the 13-item backlog inherited from the v4 archive (AMX tile passthrough, dual-X3D detection, WebTransport, Turborepo on GHCR, pnpm v9, QUIC+HTTP/3 control plane, WebRTC mesh, OPFS, WebCodecs+WebGPU, cross-origin SharedArrayBuffer, WASM JSPI, GHCR gha layer reuse, Nix flakes) is preserved in appendix C of the same document.

---

## Dependabot

Dependabot configuration does not fit the flat-file budget, so the intended schedule is recorded here; copy it to `.github/dependabot.yml` (gitignored) on forks that want automated updates:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
    groups: { dev-deps: { patterns: ['*'] } }
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
  - package-ecosystem: docker
    directory: /
    schedule: { interval: weekly }
```


## Adding a virtual processor (pull request path)

The catalog is the single source of virtual identities. A brand new
processor, gpu or memory plan joins the fleet through a reviewed pull
request, never through runtime free-form input, so every identity shipped
to the clones is curated:

1. open a pr editing `web/sandbox.js` (`cpudata` / `gpudata` entries) and
   the matching root catalog file (`processors.json` or `gpus.json`) with
   the real specifications (cores, threads, clocks, caches, tdp, memory
   ceilings) and a source url;
2. the ci gates run the full suite (the specs tests assert catalog
   integrity and cross references);
3. a maintainer reviews the hardware data and merges; the next
   `pages` run ships the static bundle and the Pages deployment to every clone and the next
   release refreshes the main container.

Runtime requests pick any catalog model with any topology up to the model
thread ceiling and any memory plan up to 18 tb; the "brand new silicon"
path is the pull request above.

## Contributing

Contributions follow the repository contract: flat structure 84 tracked files (bounded by clean optimization, not a count), 20-25 related contexts per file, no duplicated content between files, English JSDoc in third person, no emoji, `node:*` built-ins first, no hardcoded hosts or ports (ports default to `crypto.randomInt(30000) + 30000`), and every hardware or version claim backed by a primary source dated in the file header. The CI gates (biome, tsc, node test runner, structure and JSON validation) run on every pull request; the security workflow adds CodeQL, container scanning and secret detection. Bug reports should include the output of the relevant probe (`lscpu`, `free -h`, `clinfo -B`, `vulkaninfo --summary`, `glxinfo -B`, `nvidia-smi`), the engine version (`engineversions` from `index.ts`), CPU, GPU, kernel, QEMU and Docker versions, and whether IOMMU groups are isolated.

## License

MIT. The canonical copy ships as `LICENSE` at the repository root; the full text is also reproduced here so the license survives single-file distribution:

```text
MIT License

Copyright (c) 2026 wenathlan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Sources

Primary sources verified on 2026-08-22 and cited across the specification files:

**Toolchain.** https://nodejs.org/en/blog/release/v26.7.0 - https://nodejs.org/en/blog/release/v24.19.0 - https://www.npmjs.com/package/typescript - https://devblogs.microsoft.com/typescript/announcing-typescript-7-0 - https://docs.docker.com/engine/release-notes/29 - https://docs.docker.com/reference/cli/docker/container/run/ - https://docs.docker.com/engine/containers/resource_constraints/ - https://github.com/docker/buildx/releases - https://www.npmjs.com/package/@biomejs/biome - https://github.com/llvm/llvm-project/releases

**Mesa and the software GPU stack.** https://www.mesa3d.org - https://docs.mesa3d.org/relnotes/26.2.1.html - https://docs.mesa3d.org/drivers/llvmpipe.html - https://docs.mesa3d.org/envvars.html - https://docs.mesa3d.org/rusticl.html - https://mesamatrix.net - https://gitlab.freedesktop.org/mesa/mesa/-/merge_requests/17813 (via https://www.phoronix.com/news/Mesa-AVX-512-LLVMpipe-Start) - Mesa MR 31551 (LP_MAX_THREADS 16 to 32) - https://www.khronos.org/conformance/adopters/conformant-products/vulkan - https://man.archlinux.org/man/Xvfb.1

**Virtualization.** https://www.qemu.org/2026/08/11/qemu-11-1-0 - https://www.qemu.org/docs/master/devel/multi-thread-tcg.html - https://www.qemu.org/docs/master/system/i386/microvm.html - https://gitlab.com/qemu-project/qemu (target/i386/cpu.c, EPYC-v5) - https://github.com/firecracker-microvm/firecracker/releases - https://firecracker-microvm.github.io - https://github.com/cloud-hypervisor/cloud-hypervisor/releases - https://github.com/google/gvisor/releases - https://gvisor.dev/docs/architecture_guide/platforms - https://github.com/kata-containers/kata-containers/releases - https://github.com/checkpoint-restore/criu/releases - https://github.com/bytecodealliance/wasmtime/releases - https://github.com/containerd/containerd/releases - https://github.com/spinframework/spin/releases - https://www.kernel.org (7.1.9 stable, 6.18.45 longterm) - https://github.com/tianocore/edk2/releases (edk2-stable202605) - https://www.wireguard.com (in-tree since 5.6) - https://e2b.dev/blog/firecracker-vs-qemu - https://github.com/actions/runner-images/issues/12933

**Hardware specifications.** https://www.amd.com/en/products/processors/server/epyc/9005-series/amd-epyc-9965.html - https://www.amd.com/en/products/processors/desktops/ryzen/9000-series/amd-ryzen-9-9950x3d.html - https://www.amd.com/en/products/processors/workstations/ryzen-threadripper/9000-wx-series/amd-ryzen-threadripper-pro-9995wx.html - https://www.intel.com/content/www/us/en/products/sku/241060/intel-core-ultra-9-processor-285k-36m-cache-up-to-5-70-ghz/specifications.html - https://www.intel.com/content/www/us/en/products/sku/240777/intel-xeon-6980p-processor-504m-cache-2-00-ghz/specifications.html (Xeon 6980P) - https://www.apple.com/mac-pro/ (M3 Ultra, announced 2025-03-05, 819 GB/s unified memory) - https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5090 - https://www.nvidia.com/en-us/products/workstations/professional-desktop-gpus/rtx-pro-6000 - https://www.nvidia.com/en-us/data-center/dgx-b200 - https://www.amd.com/en/products/graphics/desktops/radeon/9000-series/amd-radeon-rx-9070xt.html - https://www.amd.com/en/products/accelerators/instinct/mi350/mi350x.html - https://www.techpowerup.com/cpu-specs/ - https://www.techpowerup.com/gpu-specs/ - https://devicehunt.com/view/type/pci/vendor/1002/device/75A0

**Spoofing technique lineage.** https://github.com/stantheawesomeman/memoverlay - https://github.com/cdt4/dolos - https://github.com/pogusthewhisper/fake-nvidia-smi - https://github.com/rick-hsu/nvml-unified-shim - https://github.com/FanBB2333/GpuAdapter - https://github.com/run-ai/fake-gpu-operator - https://man7.org/linux/man-pages/man3/dlsym.3.html - https://github.com/googlecolab/colabtools/issues/329

**Security.** https://docs.kernel.org/userspace-api/landlock.html - https://landlock.io/news - https://man7.org/linux/man-pages/man2/seccomp.2.html - https://github.com/moby/moby/issues/47532 - https://www.kernel.org/doc/html/latest/admin-guide/mm/overcommit-accounting.html - https://openssl-corporation.org/post-quantum.html - https://datatracker.ietf.org/doc/rfc10024 - https://github.com/ossf/scorecard

**Sandbox landscape.** https://webcontainers.io - https://daytona.io - https://modal.com - https://fly.io/machines - https://e2b.dev - https://vercel.com/blog/vercel-sandbox-is-now-generally-available - https://github.com/apple/container - https://wasi.dev/roadmap
