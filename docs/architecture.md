# e2ugh v6 - Architecture Reference

This document defines the architecture of e2ugh v6: the design principles, the module inventory with real sizes, the v3 feature redistribution across domain modules, the test patterns, the single-bus/single-state-machine/single-metrics resolution, the design-pattern map bound to real symbols, the configuration system, the multi-mode surface, the API surface and the coding rules. Hardware catalogs live in `hardware.md`; the virtualization engines live in `virtualization.md`; the master guide with quick start and versions is `readme.md`.

Context map (26 related contexts): flat monolith, three-layer flow, module
inventory, v3 feature redistribution, test patterns, web node mesh, event
bus topology, lifecycle state machine, metrics store, design
patterns, registries, builders and factories, planner CLI, configuration
system, data file binding, multi-mode surface, module consumption (nbit),
API surface, orchestrator strategies, warm pool, memory architecture, coding
syntax, variants, open infrastructure, version pinning, CI graph.

---

## 1. Principles

| # | Principle | Concrete rule in this repository |
| --- | --- | --- |
| 1 | Library-first | TypeScript is the primary API; zero runtime dependencies; ESM; `package.json` subpaths per module; Python (`qemubridge.py`) and C++ (`libs/`) act as bridges and mirrors, not as the main surface |
| 2 | Flat monolith | Tracked files stay flat: root-first plus exactly five directories (`libs/`, `docs/`, `tests/`, `web/`, `.github/workflows/`), at most two levels, lowercase names without underscores or hyphens except the six dotted mandatory configs (`vm.config` family) |
| 3 | 20-25 related contexts per file | Every module header lists its contexts; the count is a hard band enforced in review (god-file and scatter-file anti-patterns both rejected) |
| 4 | Internal memory first | Mutable state lives in `Map`/`WeakMap` containers (`cpuRegistry`, `gpuregistry`, `engineRegistry`, `InternalMemory`, `regionledger`); no module-level mutable globals, no runtime-specific global state |
| 5 | Three-layer engine | Layer 1 interposition (`libs/virtualhardware.c`), layer 2 identity and rendering (procfs generators + Mesa stack in `render.ts`), layer 3 execution engines (Docker/QEMU/Firecracker/gVisor/Kata/CLH orchestrated by `orchestrator.ts`) |
| 6 | `node:*` built-ins first | Only `node:crypto`, `node:events`, `node:fs`, `node:child_process`, `node:http`, `node:os`, `node:path`, `node:timers/promises` and friends; no third-party import anywhere in the engine |
| 7 | Open infrastructure | Hosts are never hardcoded: `resolveHost()` derives from network interfaces or the user choice; ports default to `crypto.randomInt(30000) + 30000`; `localhost`, `127.*` and `0.0.0.0` literals appear only inside the guard that rejects them |
| 8 | One of each critical component | One event bus (`enginebus` extended by `sandboxevents`), one lifecycle machine (15 states), one metrics component (`sandboxmetrics` extending `MetricsStore`) - the merge eliminated the duplicate Meta variants (`TypedEventBus`, `SaddleEventBus`, `OtelRecorder`, `VmState`, `VmPhase`) |
| 9 | Observer contracts | English JSDoc in third person, error catcher (`try`/`catch` returning typed errors) on every fallible path, 44 px minimum touch target for any UI consumer, no emoji |
| 10 | Date-first versioning | Versions resolve to the newest primary-source-verified release; the 2026-08-23 pass corrected the kernel (7.1.9 stable / 6.18.45 longterm, never 7.2.1), OVMF (edk2-stable202605), wgpu (30.x), Spin (3.6.0 spinframework), containerd (2.3.4, no LTS seal) and WireGuard (kernel mainline, in-tree since 5.6); older ledgers become history (see section 12) |
| 11 | Module modes (nbit) | `virtualhardware.json` `moduleModes.nbit` enumerates 16 consumption modules - library, binary, desktop, mobile, cli, server, web, extension, package, orchestrator, compute, edge, wasm, container, microvm, k8s - so any target consumes the same flat root |
| 12 | Modularity via contracts, not folders | ESM factory contracts and an export barrel replace folder hierarchy (section 5) |

## 2. Flow diagram

```text
                          unmodified guest binaries
             lscpu  free  nvidia-smi  clinfo  vulkaninfo  glxinfo  CPUID
                                   |
                                   v
        +----------------------------------------------------------------+
        | layer 1 - interposition                                       |
        | libs/virtualhardware.c (LD_PRELOAD / ld.so.preload)              |
        | open family + sysinfo + uname + gethostname + inotify watcher |
        +----------------------------------------------------------------+
                                   | generated /etc/virtual/{cpuinfo,meminfo,...}
        +--------------------------+---------------------------------+
        |                          v                                  v
        |  layer 2a - identity          |  layer 2b - software GPU      |
        |  virtualcpu.ts (bank 6+OMNI)  |  render.ts: Mesa 26.2.1       |
        |  virtualmemory.ts (meminfo)   |  llvmpipe GL 4.6 / lavapipe   |
        |  virtualgpu.ts (PCI ids)      |  VK 1.4 / Rusticl CL 3.1      |
        +-------------------------------+-------------------------------+
                                        |
                                        v
        +----------------------------------------------------------------+
        | layer 3 - execution engines (orchestrator.ts)                  |
        | docker 29.7.2 | qemu 11.1.0 TCG/MTTCG | firecracker 1.16.1     |
        | gvisor 20260817 | kata 4.1.0 | cloud hypervisor 53.0           |
        | warm pool | criu 4.2.1 checkpoints | compose 5.5.0             |
        +----------------------------------------------------------------+
              ^                     |                          ^
              |   enginebus (51 typed topics, replay ledger 200)      |
              |                     v                          |
        +----------------------------------------------------------------+
        | index.ts - factory, validateSpec, InternalMemory, MetricsStore,|
        | planner (plan -> qemu argv / docker run / toml / lint), barrel |
        +----------------------------------------------------------------+
```

The three layers compose: a sandbox can run on Docker with the interposer only (cheapest), on QEMU TCG for CPUID-accurate identities, or on Firecracker warm pools for millisecond starts. The orchestrator selects per sandbox (section 10); the bus carries every transition (section 4).

## 2a. Data flow walkthrough (one sandbox, nine steps)

1. **Spec.** The caller hands `createVirtualEngine` (or the planner CLI reading `vm.config.toml`) a spec: vcpus, memoryGB, vramGB, host, optional port.
2. **Validation.** `validateSpec` runs the nine rule checks plus warnings (vram above ram, MIG off at 96 GB, firecracker above 64 vcpus); violations return typed errors, never throws without context.
3. **Planning.** `plan`/`defaultplan` resolve CPU model, dies, MTTG threads (`satisfies`-checked), topology product via `plantopology`; `planlint` applies the floor/ceiling checks; `plantoml` renders the human twin.
4. **Identity.** `generateVirtualCpuinfo`/`generateVirtualMeminfo` render the procfs payloads; `createvirtualgpu` resolves the PCI id and NVML env; the entrypoint installs them under `/etc/virtual/` for the interposer.
5. **Selection.** The orchestrator probes runtimes (`detectall`): KVM detector, docker socket, firecracker api socket availability; the four-rule policy picks the strategy.
6. **Provisioning.** The chosen `runtimestrategy` builds its command (`dockerrun`, `firecrackerruntime` machine-config JSON, `qemuruntime.buildcommand`, ...); ports come from `allocport`; hosts from `resolvehost`.
7. **Runtime.** The sandbox runs; `sandboxproxy` guards lifecycle (pause/resume/dispose), the health monitor samples vm/gpu/host probes, `sandboxmetrics` records through `MetricsStore` into `InternalMemory`.
8. **Events.** Every transition publishes on the single bus (`vm:phase`, `sandbox:*`, `mttg:*`, ...); the replay ledger keeps the last 200; the OTel exporter exposes Prometheus on a random port when enabled.
9. **Teardown.** `Symbol.dispose` chains (`sandboxhandle`, `modellease`, `MetricsStore` flush) unwind resources; the warm pool refills in the background; the audit JSONL gains the final entry.

## 3. Module inventory (real sizes)

Line counts are the shipped files (v2 carryover plus the v3/v5/v6 additions); every module header carries its own context list and its merge provenance.

| Module | Lines | Role | Key contexts |
| --- | --- | --- | --- |
| `orchestrator.ts` | 5462 | sandbox and VM orchestration: six runtime strategies, warm pool, RBAC, reservations, affinity, NUMA scheduler, balloon, SR-IOV GPU assignment, passage routing, MTTG queue, docker bridge, spawnqemu, health, autoscale, migration, snapshots, checkpoints, hot-reload, plugins, audit, leader election, OTel exporter | 25 |
| `scheduler.ts` | 1600 | tenant placement and QoS plane: tenant registry, QoS classes (guaranteed/burstable/besteffort/idle), the AIP-sched placement policy, PSI-fed LSTM utilization predictors, anomaly detection, the RL autoscaler and the CRDT vm.config sync (v5-C builders) | 20-25 |
| `compute.ts` | 2992 | compute plane: wasm tier (Wasmtime 48.0.0 LTS, WASI 0.2/0.3), webgpu paths (wgpu 30.x aligned), AI workload planners, Node 26 API adoption, AI-session checkpoint, post-quantum usage, NPU/Ray-vLLM/WebTransport/OPFS/WebCodecs planners | 20-25 |
| `media.ts` | 1337 | media and transcode domain: the mttg pipeline mirror (skip rules, stage ledger), codec matrix, tone-map/denoise plans, VMAF targets and the tailscale endpoint planner (v5 wave addition) | 20-25 |
| `virtualmemory.ts` | 2303 | memory tiers (DDR5-6400 51.2 GB/s/ch, HBM3e 8 TB/s, GDDR7 1792 GB/s), MIG profiles, NUMA, hugepages, KSM, ballooning, overcommit, docker flags, placement tiers, CXL devices, memorymodularizer, meminfo generation | 25 |
| `index.ts` | 1491 | engineversions ledger, engine limits, randomPort/resolveHost/buildEndpoint, specschema + validateSpec, InternalMemory, MetricsStore, enginebus (51 topics), VirtualEngine state machine, registry, factory, planner (defaultplan, qemuargv, dockerrun, plantoml, planlint), barrel | 14 sections |
| `render.ts` | 1325 | Mesa stack facts (llvmpipe/lavapipe/rusticl), Xvfb recipe, GPU virtual identity data, mesaenvbuilder presets, smiformat 89-char, renderer classes, probes | 25 |
| `security.ts` | 1449 | Landlock ABI v10, seccomp deny-by-default, eBPF LSM, cgroups v2, post-quantum TLS policy, Rfc10024 negotiator, PqcAuditTrail tamper-evident chain, CRIU SELinux relabel, layer composition with fail-closed self-check | 25 |
| `virtualcpu.ts` | 1273 | vendor identities, Zen 5/Arrow Lake flag sets, BEST_VIRTUAL_PROCESSORS, cpuRegistry, solvetopology, cpuinfo/lscpu generators, scoring, modellease (`using`) | 24 |
| `alternatives.ts` | 1218 | ten sandbox engine categories with real adapters (create/exec/snapshot/destroy/metrics), registry with aliases, comparison matrix | 25 |
| `qemubridge.py` | 1340 | async QMP bridge over unix socket: 22 observer ops fused with the v5 QEMUQMPClient uniques (hotplug pairs, batch, dirty-rate, affinity), smiadapter a100/h100 facade | 25 |
| `virtualgpu.ts` | 1136 | verified GPU bank, PCI ids (RTX PRO 6000 corrected to 10DE:26B5), vfio bind/unbind, rom dump, Looking Glass B7, vGPU formula, vendor-reset, SR-IOV DKMS, MIG density validator, NVENC tables, registergpudata normalizer | 25 |
| `performance.ts` | 1049 | seven optimization layers with LayerPatch merge, percentile harness, regression verdicts, performance.mark/measure | 25 |
| `virtualization.ts` | 1582 | qemuopts turbo argv (TDX/SEV-SNP/OVMF/io_uring/venus), six passage modes, MTTG cgroups v2 builders, EEVDF/BORE/sched_ext notes, mttggrid (MTTG_MAX 1e6, steal, multiplex), memory backend bridge, kvmcapnames, checkpoint/restore plans, CXL Type-3/ZNS/P4/TSN planners (v5-C) | 24 |
| `libs/virtualizationcore.cpp` | 4596 | C++26 TU: RAII KVM system/vm/vcpu, QmpSocket+QmpClient, dirty-log ring, mdev, VFIO container, VgpuScheduler, MigManager (7-instance/192 GB validator), SriovManager, NVENC dual engine, NvlinkC2c interconnect | 25 |
| `libs/gpumonitor.cpp` | 1543 | C++26 four-mode build: CLI smi-adapter, NVML/libcuda shim, N-API addon, forge mode (Plan/validate/qemu_argv, Mttg work-stealing mirror) | 12 hooks |
| `libs/virtualhardware.c` | 1011 | C11 LD_PRELOAD core: open-family interception, vhe_translate, inotify regeneration thread, xorshift32 drift, constructor 101 | 12 hooks |

Data files: `gpus.json` 2408, `processors.json` 2217, `vm.config.json` 1910, `cores.json` 1801, `mttg.config` 1548, `boards.json` 1517, `passage.config` 1330, `qemu.config` 1061, `virtualhardware.json` 739, `docker.config` 768. Web node (`web/`, the v6 edition plus the v7 wave): `sandbox.js` 1433 is the browser-pure engine port (bank, procfs payloads, the 89-char smi table, mesa summaries, boot dmesg and the command dispatcher), `server.js` 640 serves the console plus the `/api/v1` contract (health, spec catalogs, sandbox lifecycle, exec) over `node:http`, `index.html` 646 renders the spec panel, terminal and bus timeline, adapters `vercel.json`/`netlify.toml`/`caddyfile` (static edge, api reverse proxied) and `readme.md` 120; the v7 wave completes the node with `db.js` (sqlite persistence for users, sessions and sandboxes), `auth.js` (scrypt password hashing, timing-safe verification, cookie sessions), `mesh.js` (HMAC-SHA256 signed clone-to-main calls with replay windows), the `login.html`/`register.html`/`dashboard.html` pages, `package.json`/`Dockerfile` (image `ghcr.io/wenathlan/e2ugh (main image, web/ included)`; node pinned by the root `.nvmrc`), the database definition kept flat as `schema.prisma` plus `init.sql`, and `mime.types`. Total repository: about 62,200 lines across 83 tracked files (the v2 carryover plus the v3 domains, the v5 media/test waves and the v6 web edition; the `tests/` suite alone is 3,674 lines across eleven files).

## 3a. v3 redistribution: features live in domains

The former `future.ts` (2720 lines, 55 features in ten categories) was decomposed in v3: features no longer live in a chronological catch-all but in the domain module that owns the surrounding machinery. The mapping:

| Domain module | Features absorbed |
| --- | --- |
| `scheduler.ts` | tenant registry and placement, QoS classes, the AIP-sched policy, PSI-fed LSTM utilization predictors, anomaly detection (the scheduling half of the old tenants/QoS/predictor contexts) |
| `compute.ts` | wasm tier (Wasmtime 48.0.0 LTS, WASI 0.2/0.3, WIT bindings, fuel metering, component ACL), webgpu surface (forceFallbackAdapter over lavapipe, compute pipelines, WGSL cache, matmul dispatch, wgpu 30.x alignment), AI workload planners (dataloader /dev/shm, TF/CUDA matrix, ONNX WebGPU session, LLM planner, headless Stable Diffusion, VRAM budget), Node 26 APIs (Temporal, Float16, node:sqlite, module.register, Perfetto), plus AI-session checkpoint and post-quantum usage |
| `virtualization.ts` | checkpoint/restore primitives: CRIU plans, MAP_PRIVATE snapshots, UFFD projection, dirty-page diffing, the migration state machine (next to the QEMU/Firecracker snapshot machinery they drive) |
| `security.ts` | post-quantum core: ML-KEM FIPS 203, ML-DSA, X25519MLKEM768 hybrid policy, the Rfc10024 negotiator and the PqcAuditTrail tamper-evident audit chain (next to the TLS policy they configure) |

The remaining categories of the old file were already domain-owned: kernel features sit in `security.ts`/`virtualization.ts`, hardware modules in `virtualcpu.ts`/`virtualmemory.ts`/`virtualgpu.ts`, developer experience in `index.ts`/`orchestrator.ts`. Nothing was dropped; the 55-feature inventory is preserved one-to-one under domain headers.

## 3b. Test patterns

Tests live in the `tests/` directory (one of the five allowed directories) and run with the Node built-in runner: `node --test 'tests/*.test.ts'` (153 tests across eleven files - engine, features, media, render, simulation, specs, virtualcpu, virtualgpu, virtualmemory, web, workflow - all passing on Node 24 and 26), the same runner the ci.yml smoke gate executes on Node 26.7.0. Patterns:

- `node:test` (`describe`/`it` or top-level `test`) plus `node:assert/strict`; no Jest, no third-party harness, no install step (the engine has zero runtime dependencies).
- One test file per area under test (planner and lint rules, cpuinfo/meminfo generators, MIG density validator, QEMU argv builder); assertions target public exports, never module internals.
- Doc-tests remain `@example` blocks in JSDoc (the planner asserts in `index.ts`), and every test stays deterministic: ports use the 30000-59999 random band or explicit ephemeral allocation, no network, no timing-dependent assertions.

## 3c. Web node architecture (v7)

The web node is a static edge plus one self-hosted process. Clones (Vercel and Netlify static deploys of the `web/` pages, redeployed from the `pages.yml` zip -9 bundle) ship only immutable assets: the console, the auth pages and `sandbox.js`, which runs the whole engine client-side and keeps working with no backend. The main node (`node web/server.js` behind the `caddyfile` on devthink.pro, packaged as `ghcr.io/wenathlan/e2ugh (main image, web/ included)`) owns everything stateful: `db.js` opens the sqlite file (`schema.prisma`/`init.sql` define it, kept flat per the two-level contract), `auth.js` is the auth authority - scrypt password hashing with per-user salts, timing-safe verification and server-side sessions delivered as `HttpOnly` cookies - and `mesh.js` verifies the HMAC-SHA256 signature (method, path, body digest, timestamp, bounded replay window) that every clone attaches to forwarded calls before routing. The design is deliberately anti-serverless: no function runs on the edge platforms, clones hold no secrets and no database, and unauthenticated clones receive 401 from the main node instead of any partial authority.

## 4. One bus, one state machine, one metrics store

The v2 merge inherited three orchestrator lineages that each carried an event bus, a lifecycle model and a metrics recorder. The resolution is structural, not conventional:

- **Event bus.** `enginebus` in `index.ts` owns the topic table (`enginetopics`, 51 typed topics: `engine:*`, `sandbox:*`, `vm:*`, `vcpu:*`, `vram:*`, `gpu:*`, `sriov:*`, `passage:*`, `mttg:*`, `docker:*`, `qemu:*`, `health:*`, `autoscale:*`, `numa:*`, `migration:*`, `snapshot:*`, `checkpoint:*`, `config:*`, `plugin:*`, `rbac:*`, `audit:*`, `leader:*`, `quota:*`, `preempt:*`, `node:*`, `system:*`, `otel:*`). `sandboxevents` in `orchestrator.ts` extends it and adds a replay ledger (last 200 events) plus the legacy 8-name v5 mapping onto `sandbox:*`. No subsystem constructs its own `EventEmitter`.
- **Lifecycle.** A single 15-state machine: `pending -> creating -> scheduling -> binding -> provisioning -> running -> degraded -> paused -> snapshotted -> migrating -> restoring -> draining -> stopped -> destroyed`, plus `failed`, with a complete guard map. The Meta `VmState` (11 states) and `VmPhase` (12 phases) folded in via `lifecyclefromphase()`; those types no longer exist.
- **Metrics.** `sandboxmetrics` extends the disposable `MetricsStore` of `index.ts` (write-through into the underlying `InternalMemory`, flush/restore to `.metrics.json`, `Symbol.dispose` and `asyncDispose`). The Meta `OtelRecorder` capabilities (labels, ring buffer of 10,000 points, histograms, OTLP push, Prometheus `# TYPE` export) were absorbed; `OtelPoint` and the standalone recorder class were deleted.

## 5. Modularity via ESM contracts

The barrel at the bottom of `index.ts` re-exports four modules; the remaining eight are declared as package subpaths in `package.json`:

```ts
export * from './virtualcpu.ts';
export type { migprofileid } from './virtualmemory.ts';
export * from './virtualmemory.ts';
export * from './virtualgpu.ts';
export * from './virtualization.ts';
```

Factory contracts (signatures simplified; full JSDoc in the modules):

| Contract | Symbol | Module |
| --- | --- | --- |
| Engine factory | `createVirtualEngine(options): VirtualEngine` | `index.ts` |
| Spec validation | `validateSpec<const T extends enginespec>(spec: T)` | `index.ts` |
| Processor factory | `createVirtualProcessor(model, vcpus): provisionedcpu` | `virtualcpu.ts` |
| Memory facade | `createVirtualMemory(request): virtualmemorymanager` | `virtualmemory.ts` |
| GPU factory | `createvirtualgpu(id)` | `virtualgpu.ts` |
| QEMU turbo argv | `buildqemucmd(opts: qemuopts)` | `virtualization.ts` |
| MTTG grid | `creategrid(host?, virtual?): mttggrid` with `MTTG_MAX = 1_000_000` | `virtualization.ts` |
| Orchestrator facade | `getorchestrator()` singleton with guard | `orchestrator.ts` |
| Python bridge | `SaddleQemuBridge`-class surface: connect/start_vm/monitor_hmp/query_status/stop | `qemubridge.py` |
| C++ core | `vhe::virt` namespaces vm/gpu/enc, `vhe_version()` / `vhe_nvenc_mpix()` exports | `libs/virtualizationcore.cpp` |

Cross-language contract: TS planners emit argv; `qemubridge.py` drives QMP; the C++ core validates KVM caps (`kvmcapnames` in `virtualization.ts` lists the eight capability checks) and computes memory backends (`buildmemorybackendargs` mirrors the C++ `MemoryFdManager`).

## 6. Design patterns mapped to real symbols

| Pattern | Symbols (all real, all shipped) |
| --- | --- |
| Registry | `cpuRegistry` (virtualcpu), `gpuregistry` (virtualgpu), `engineRegistry` + `runtimeregistry` (index/orchestrator), `regionledger` (virtualmemory) |
| Builder | `virtualcpubuilder`, `virtualgpubuilder`, `mesaenvbuilder`, `gpuprofilebuilder`, `tenantcgroupbuilder` (cgroups v2 slices), `smiadapterbuilder` |
| Factory | `createVirtualProcessor`, `createVirtualMemory`, `createvirtualgpu`, `createVirtualEngine`, `rendererfactory` |
| Strategy | `runtimestrategy` and its six implementations (dockerruntime, qemuruntime, firecrackerruntime, gvisorruntime, kataruntime, clhruntime); `memorycontroller` tier controllers (ddr5/hbm3e/gddr7) |
| Facade | `virtualmemorymanager`, the orchestrator facade (`createvm/startvm/.../dumpstate`), `virtualizationcore.cpp` `VirtualizationCore::build` pipeline |
| Proxy | `guardregion` (guarded memory region), `rendererproxy` (frozen five-key profile), `sandboxproxy` (guarded sandbox with boot timing and dispose) |
| Observer | `enginebus`/`sandboxevents`, `memorystats` (85/95/99 taps), `healthprobes` WeakMap |
| Disposable (`using`) | `modellease` (Symbol.dispose lease on registered CPUs), `MetricsStore`, `sandboxhandle` (SIGTERM to SIGKILL escalation), `startsampling` |
| Planner | `memorymodularizer` (host tier detection, zram planning, QEMU synthesis, cgroup export, JSON persistence), `plan`/`defaultplan`/`planlint` in index |
| Work-stealing grid | `mttggrid` (`creategrid`, `steal`, `spawnthreads`, `multiplex`), the TS mirror of the `Mttg` class in `libs/gpumonitor.cpp` forge mode |

Naming warning carried in every header: MTTCG (QEMU multi-threaded TCG, one host thread per vCPU) and MTTG (multi-tenant thread groups, the M:N grid) are unrelated concepts with similar acronyms and are never merged.

## 7. Configuration system

- **`vm.config` family.** One schema, three serializations: the JSON twin (`vm.config.json`, 22 profiles), the TOML human file (parsed by the planner CLI regex; a real parser can replace it without breaking the rest), and the INI-like no-extension variant used by the forge. Deterministic SHA-256 identity: the same config always yields the same VM id.
- **Six mandatory dotted configs.** `qemu.config` (machine/CPU/spoofing/MTTCG + libvirt overlay), `mttg.config` (cgroups v2 controllers, tenants, QoS, transcode; hosts the `[mttcg]` TCG section with a cross-reference note), `passage.config` (four domains: pingora gateway, passthrough modes, network binding, host playbook), `docker.config` (engine, stages, seccomp, CDI, buildx), `gpu` and `vm` twins in JSON.
- **Eleven data files.** `processors.json` (57 CPUs, cpuid reference, lscpu templates, QEMU models), `gpus.json` (19 GPUs + 5 APU blocks, smi-adapter profiles, MIG, shims), `cores.json` (core types, vCPU factory 1-1024, memory presets), `boards.json` (20 boards + platform reference), `virtualhardware.json` (master binding: modules, module modes, defaults, quick catalog, legacy catalog, guest envelope schema, resolution order, spec inventory).
- **Hot reload.** `enablehotreload()` watches the six configs and the eight JSONs, auto-creates defaults with real content when a file is missing, and validates on every write (`handleconfigreload`).

## 8. Multi-mode surface

The engine exposes about 30 operational modes; each mode is a thin consumption profile over the same flat root (the F1 template topics - desktop, web, extension, cli, mobile, multimode, packaging, deploy, librarymodes - collapsed into this table instead of being cloned into separate files):

| Mode group | Modes | Consumption |
| --- | --- | --- |
| Core | vm, gpu, passage, qemu, mttg, docker | direct module imports (the six config domains) |
| Catalog | boards, cores, processors, vcpus, vram, memory | data-file reads plus validators |
| Runtime | network, storage, security, performance, emulation, acceleration, virtualization, isolation | engine modules |
| Delivery | desktop, web, extension, cli, mobile, deploy, packaging, library | the 16 `moduleModes.nbit` targets |
| Operations | debug, benchmark, orchestration, telemetry, cache, forge, mirror, pipeline, workload, provisioning | orchestrator, metrics, registry, forge mirrors |

Per-target delivery notes (one line each, from the collapsed topic docs):

| Target | How the same library is consumed |
| --- | --- |
| desktop | EgUi lab UI over the in-process factory; every control honors the 44 px touch target |
| web | browser bundle shipped as the `web/` console (v6): `sandbox.js` mirrors the verified bank, `server.js` serves it and `/api/spec`; zero dependencies keep the graph tree-shakeable |
| extension | browser extension service worker; endpoints bind a random port, never localhost |
| cli | planner CLI: `node --experimental-strip-types index.ts` reading `vm.config.toml` |
| android | container/wasm module surface through the JVM bridge; arm64 native runner images |
| ios | wasm module surface; no native engine component required |
| deploy | the four workflows plus the compose stack documented in `readme.md` |
| packaging | npm provenance publish, GHCR multi-arch, level-9 zip with SHA-256 |
| library | the barrel import; `memoryPriority: internal` keeps everything in-process |
| server | optional `server` and `cli` optionalDependencies declared in `package.json` |
| orchestrator | the facade singleton with leader election for multi-node deployments |
| compute / edge / wasm / container / microvm / k8s | engine selection through `runtimeregistry` (compute: docker/qemu; edge: gvisor; wasm: wasmtime adapters; container: OCI twins; microvm: firecracker/CLH; k8s: kata runtimeClass translation) |

## 8a. API surface (endpoint table)

The v6 observer API reference (25 sections) collapsed onto the shipped v2 symbols:

| Endpoint (observer name) | v2 symbol | Notes |
| --- | --- | --- |
| entry ts | `index.ts` barrel | re-exports four modules; eight more via package subpaths |
| error catcher | `safecall`, typed error classes | every fallible path; `traceId` style context in orchestrator errors |
| factory options | `engineoptions` | vcpus, memoryGB, vramGB, host, port override; limits from `enginelimits` (1-192 identity, 1-1024 factory, 8-96 MIG, ports 30000-59999) |
| endpoints: vm | `createvm`, `startvm`, `destroyvm`, `transitionvm` | guards from the single machine; `vm:phase` events |
| endpoints: gpu | `registergpu`, `assigngpu`, `releasegpu`, `listsriov`, `attachgpupassthrough` | reads `gpus.json` through `bootstraphardwareview` |
| endpoints: passage | `addpassageroute`, `resolvepassage`, `removepassageroute` | latency budgets per protocol (vsock 15 us, vxlan +20 us) |
| endpoints: qemu | `buildqemucmd`, `qemuargv`, `qemuruntime.buildcommand` | the three-tier argv hierarchy documented in `virtualization.ts` |
| endpoints: orchestration | `allocport` + `resolvehost` | `crypto.randomInt(30000) + 30000`; interfaces-derived host |
| endpoints: forge | forge mirrors map | GHCR/GitHub/npm mirrors cached in `InternalMemory` |
| core orchestrator | `getorchestrator()` | 25 correlated domains behind one facade |
| python bridge | `qemubridge.py` | stdlib-only QMP client; NDJSON/QMP contract shared with TS |
| cpp headers | `libs/virtualizationcore.cpp` (TU-unique) | `vhe_version()`/`vhe_nvenc_mpix()` extern C exports |
| catalog json api | data files with `$schema`/`meta` | `readConfig<T>` pattern; strict JSON validated in CI |
| observer contracts | JSDoc third person | no first person anywhere in the public surface |

## 9. Memory architecture

- **Internal priority.** `InternalMemory` (index.ts) is a `Map`-backed store with `WeakMap` side tables (`#totalslots`), used by the engine registry, the metrics store, the passage memory pipeline and the forge mirror caches. It is the default for every mode; nothing requires Redis or S3 to run.
- **Pluggable external tiers.** The memory passage pipeline (`memoryregion` builder, `regionledger`, `guardregion` proxy) accepts file/redis/s3 TTL backends when a host wants persistence; `memorypersonalization` ranges (1-1024 GB, presets, NUMA, CXL) are documented in `hardware.md` section 8.
- **Host-aware planning.** `memorymodularizer` detects real host tiers (lspci CXL scan for vendor 1e98, `/dev/pmem0` PMEM_DAX, shared Blackwell memfd), plans zram with workload-dependent compression factors, synthesizes QEMU backends (`-object memory-backend-file,hugetlb`, CXL Type-3, virtio-mem 2M blocks), exports cgroup v2 slices and QMP balloon commands, and persists the plan as JSON.

## 10. Orchestrator design

Six runtime strategies behind one `runtimestrategy` interface; selection policy (verified facts, not heuristics):

1. Sub-10 ms starts with KVM present: Firecracker warm pool (File or Uffd snapshot backend; 125 ms cold, ~4 ms restore, 150 VMs/s, under 5 MiB each).
2. KVM present, OCI-shaped untrusted workload: Kata 4.1.0 (runtime-rs) or Cloud Hypervisor 53.0 with vfio-user devices.
3. No KVM (GitHub-hosted runners): QEMU TCG with MTTCG for VM identities; Docker with the `security.ts` layers for execution; gVisor runsc where syscall interception is preferred.
4. Long-lived workers needing fast restart: CRIU 4.2.1 checkpoint/restore with SELinux relabel.

Supporting subsystems: warm pool (prewarm/acquire/release/refill/drain, MAP_PRIVATE CoW), port allocator and host resolver (never localhost), RBAC with four default roles and `assertpermission`, resource reservations with TTL 300 s, affinity rules and `selectbestnumanode`, CFS-like vCPU scheduler with `scheduletick` rebalancing (above 20% imbalance) and `rebalancenuma`, balloon controller with pressure scoring and gradual 100 MB/500 ms steps, SR-IOV GPU assignment (PF with 7 VFs on Blackwell), passage routing with latency estimates (vsock 15 us, ivshmem bounded at 50,000 Mbps), MTTG queue with dependencies/retry/preemption (guaranteed preempts up to three besteffort), docker bridge with IPAM 10.88.N.O/24, health monitoring with degraded transitions, autoscale with cooldowns, live migration with precopy stages and 50-250 ms measured downtime, qcow2 snapshots and checkpoints (criu/qemu_savevm/docker incremental), plugin system with contracts, append-only JSONL audit per tenant, bully leader election with leases, OTLP exporter with Prometheus `/metrics` on a random port, graceful drain and `dumpstate`. The full engine matrix is in `virtualization.md`.

## 11. Coding syntax

| Area | Rule (dated 2026-08-22) |
| --- | --- |
| TypeScript | 7.0.2 (Go-native port); `strict`, `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`; ES2025 target with `lib ES2025+ESNext.Disposable` |
| Erasable modern syntax | `using`/`await using` (modellease, MetricsStore, sandboxhandle), `satisfies` (`engineversions as const satisfies Record<string,string>`), const type parameters (`validateSpec<const T>`), `#private` fields and accessors, `import.meta.filename` for CLI detection |
| ESM | `"type": "module"`; relative imports carry the `.ts` extension; no CommonJS `require` |
| Tests | `node:test` + `node:assert/strict` executed with `node --test 'tests/*.test.ts'`; the dedicated `tests/` directory holds eleven test files (148 cases: 86 planner/generator originals, 24 workflow/simulation gates, 18 feature-audit builders, 4 media pipeline, 1 snapshot regression, 9 web edition), ci.yml runs them on Node 26.7.0; no Jest; doc-tests as `@example` blocks (the planner asserts live in `index.ts` planner docs) |
| C++26 | `import std;` permitted, `std::expected` as the error channel, `std::mdspan` with the p2662r3 fallback guard, `std::print`/`std::format`, `enum class`, `[[nodiscard]]` on validate/argv/topology, RAII for every fd/socket (no exceptions in happy paths) |
| C | C11 with `_GNU_SOURCE`, `dlsym(RTLD_NEXT)` resolution, xorshift32 deterministic drift, constructor priority 101 |
| Python | 3.14 floor; stdlib only (socket, json, logging); try/except logging on every operation |
| Naming | `vcpus` means QEMU virtual processors; `threads` means SMT siblings; `mttgThreads`/`virtual_threads` means the M:N grid; the three words never mix in one sentence without a qualifier |
| Anti-patterns deleted from earlier generations | README pasted into every doc; half workflows (checkout + echo); invented SKUs without sources; `any` in TypeScript; printf-based C control planes; Node 18 in setup-node |

## 12. Version pinning (date-first)

The ledger in `index.ts` (`engineversions`) is the runtime source of truth: Node 26.7.0/24.19.0, TypeScript 7.0.2, Docker 29.7.2, Compose 5.5.0, Mesa 26.2.1, QEMU 11.1.0, Firecracker 1.16.1, Kata 4.1.0, gVisor release-20260817.0, Cloud Hypervisor 53.0, CRIU 4.2.1. Conflicts from the inherited ledgers resolved by rule (old pin -> active pin, with the deciding source class):

| Component | Inherited pin | Active pin | Resolution basis |
| --- | --- | --- | --- |
| Node.js | 22.12.3 LTS / 23.11.0 | 24.19.0 LTS + 26.7.0 matrix | nodejs.org release blog (2026-08-03 / 2026-08-05) |
| TypeScript | 5.6.3 | 7.0.2 | npm registry + compiler announcement 2026-07-08 |
| Docker Engine | 27.3.1 (API 1.47) | 29.7.2 (API 1.52) | docs.docker.com 29 release notes, 2026-08-05 |
| Buildx / Compose | 0.18.1 / 2.29.7 | 0.36.1 / 5.5.0 | github release pages |
| QEMU | 9.1.2 (q35-9.1) | 11.1.0 (q35, microvm, nitro) | qemu.org 2026-08-11 announcement |
| Mesa / LLVM | 25.2.7 / 19.1.7 | 26.2.1 / 22.1.8 | docs.mesa3d.org relnotes, llvm releases |
| Firecracker | 1.13.2 | 1.16.1 | firecracker releases 2026-07-02 |
| Wasmtime | 43 / 46.0.1 | 48.0.0 LTS | bytecodealliance releases 2026-08-20 |
| Linux kernel | 7.2.1 (pin never released; mainline is 7.2) | 7.1.9 stable / 6.18.45 longterm | kernel.org, verified 2026-08-23 |
| OVMF/EDK2 | 20260213-1 (malformed tag) | edk2-stable202605 | tianocore releases (stableAAAMM format) |
| WireGuard | snapshot 1.0.20260315 (no such snapshot) | kernel mainline (in-tree since 5.6) | wireguard.com install page |
| wgpu | 24.x (early 2025) | 30.x (wgpu-info 30.0.0) | crates.io/crates/wgpu, 2026-07 |
| Spin | 3.2 (stale) | 3.6.0 (repo now spinframework/spin) | github.com/spinframework/spin releases |
| containerd | 1.7.22 / 2.1.5 | 2.3.4 (no LTS designation; 4-month minors) | containerd releases 2026-08 |
| Actions checkout | v4.2.2 | v7.0.1 | Node 24 migration forced 2026-06-02 |
| NVIDIA driver | 560.38.05 / 570.144 | 575.57.08 (CUDA 12.9) | v5 verified bank + deployment docs |

The old pins survive only inside `legacyCatalog` provenance blocks in `virtualhardware.json` (kept as history, never as active pins; the re-pin sweep confined every stale number to provenance keys).

## 13. Variants

| Variant axis | Shipped forms |
| --- | --- |
| vm.config | `vm.config.json` (machine), `vm.config.toml` (human, planner CLI input), INI-like no-extension (forge) |
| Compose | `docker-compose.yml` v2 spec; the deprecated `version:` field and alternate filenames recorded as history |
| Images | GHCR multi-arch (amd64 native build, arm64 under QEMU user emulation), distroless runtime, per-digest provenance |
| Engine identities | any-of: virtual identity-only (Docker + interposer), TCG-accurate (QEMU EPYC-v5), microvm (Firecracker), intercepted (gVisor) |
| Docs | seven reference documents; this file owns architecture, `readme.md` owns the overview; zero cloned sections (cross-references instead) |

## 14. Core concepts (from the 00/01 series)

- **Lifecycle state machine.** The 15-state machine of section 4; transitions publish on `vm:phase` and `sandbox:*`; guards reject illegal transitions (for example `stopped -> provisioning` requires drain completion).
- **Error taxonomy.** Typed error classes per subsystem (`hardwareerror` with `subsystem` tag, `memoryerror`, `gpuerror`, `engineerror`, `orchestratorerror` with `ERR_*` codes, `retryable` flag and `context`); every fallible public path carries a catcher; the process-level catcher (`unhandledRejection`/`uncaughtException` into `system:error`) is opt-in through `start()` so library consumers keep their own policy.
- **Backpressure.** Warm pool floors, MTTG queue concurrency 4 with retry 3 and anti-starvation requeue, memory `memory.high` soft throttle at 0.8x, balloon escalation when host free memory drops under 4 GB, quota table rejecting beyond-limit requests with `ERR_QUOTA_*`.
- **Capability model.** `plugincontract` with a context-scoped surface; RBAC gates management operations; the sandbox never grants more than the spec validated.
- **Support matrix.** Linux x86_64/arm64 hosts; KVM optional (TCG fallback); macOS/Windows consumers use the library modes, not the engines.

## 15. CI graph (summary)

Five workflows gate the tree: ci.yml (lint, typecheck matrix Node 24/26, the node:test suite in `tests/`, build, flat-structure md5 guard, JSON schema validation of the ten data files), publishghcr.yml (the combined container pipeline: per-arch validation legs on push - clinfo/vulkaninfo/glxinfo probes inside the image - and the four-arch GHCR publication with provenance+SBOM on release), release.yml (GHCR + npm provenance + level-9 zip with SHA-256), pages.yml (the merged web pipeline: module syntax gate, boot smoke on port 37810, html lint, the webapi auth/mesh suite with a throwaway `E2UGH_DB`, the zip -9 static bundle and the GitHub Pages deployment of the web tree) and security.yml (CodeQL C/C++/TS, dependency review, Dockle/Trivy SARIF, gitleaks, Scorecard, Biome security group, license allowlist). Full descriptions and pins are in `readme.md`; the workflows themselves are the executable contract.

## 16. Compliance checklist

Flat tree (root plus `libs/`, `docs/`, `tests/`, `web/`, `.github/workflows/` only); no `src/`; lowercase names; six dotted configs present; every module header carries contexts, provenance and sources; no emoji; no hardcoded localhost; `node:*` first; one bus, one machine, one metrics; data files parse as strict JSON with `$schema`/`meta` headers; docs exceed 40 sections across the set; every version claim dated and primary-sourced. CI enforces the machine-checkable items; review enforces the rest.

## 17. Future extensions within the flat budget

The flat contract keeps the tree shallow (root plus the five allowed directories), so growth happens inside files (new contexts join the 20-25 band or split a module in two) rather than in new directory trees. The v3 redistribution already exercised that rule: the `future.ts` catch-all split into `scheduler.ts` and `compute.ts` with the checkpoint and post-quantum cores returning to `virtualization.ts` and `security.ts`; the v6 web edition added the first delivery surface outside the engine modules (`web/`, seven files plus its test suite). Reserved slots: the F-001..F-065 roadmap items that require new runtime surfaces (CXL pooling daemons, DPU offload agents, confidential-computing attesters) land as new contexts in `virtualization.ts`/`orchestrator.ts` first; a second C++ TU only if `virtualizationcore.cpp` exceeds review size; the docs set stays at seven with appendices inside `viability.md`.

## 18. Glossary (terms used nowhere else in this set)

| Term | Meaning |
| --- | --- |
| context | a named, correlated unit of responsibility inside a file; the flat contract groups 20-25 per file |
| forge | the C++/mirror build surface (`libs/gpumonitor.cpp` forge mode, forge mirrors for GHCR/GitHub/npm) |
| guest envelope | the validated set of identities a guest may observe (schema in `virtualhardware.json`) |
| identity ceiling | the modularity bound tied to a specific virtual identity identity (for example 192 vCPUs on EPYC 9965) |
| nbit | the module-modes block enumerating the 16 consumption targets |
| observer voice | the third-person JSDoc contract: behavior described, never "I" or "we" |
| plan | the resolved artifact of the planner: model, topology, argv, docker line, toml twin, lint verdicts |
| replay ledger | the ring of the last 200 bus events available for `replay(topic, count)` |
| spec rule | one machine-checkable validation entry in `specschema` (nine rules plus warnings) |

## Sources

- Flat-structure and merge-map analysis: project worklog tasks v2-A1/v2-A3 (analyst-code/analyst-docs), preserved in `docs/viability.md`
- QEMU MTTCG design: https://www.qemu.org/docs/master/devel/multi-thread-tcg.html
- Mesa driver and envvar documentation: https://docs.mesa3d.org/drivers/llvmpipe.html, https://docs.mesa3d.org/envvars.html
- Landlock ABI versions: https://docs.kernel.org/userspace-api/landlock.html, https://landlock.io/news
- TypeScript 7 native port: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0
- Explicit Resource Management (`using`): https://github.com/tc39/proposal-explicit-resource-management
- Docker resource constraints: https://docs.docker.com/engine/containers/resource_constraints/
- GitHub runner KVM limitation: https://github.com/actions/runner-images/issues/12933
- Component versions: the `engineversions` ledger in `index.ts`, each pinned from its primary release page (see `readme.md` sources)
