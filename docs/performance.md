# Performance - Seven Optimization Layers Without Hardware Changes

e2ugh runs a fully virtual CPU, memory and GPU stack without buying hardware
or requiring privileged host devices. Every performance gain comes from
software configuration: vector width selection inside the Mesa JIT, thread
saturation, Docker memory semantics, warm microVM pools, multi-threaded TCG,
build caching and connection reuse - stacked with kernel-level techniques
(io_uring, eBPF, hugepages, zram) and toolchain upgrades measured on free
GitHub Actions runners. This document specifies the seven layers implemented
in `performance.ts` (1,026 lines), the kernel and framework techniques behind
them, the 2026 benchmark tables, the observability stack that watches them,
and the harness that protects the combined gains from regressions. All
version pins are date-first 2026-08-22: Mesa 26.2.1, LLVM 22.1.8, QEMU
11.1.0, Firecracker 1.16.1, Docker 29.7.2, Node 24.19.0 LTS. Older frozen
toolchains in cited benchmarks are marked as historical provenance. The
viability argument itself (why spoofing is possible at all) lives in
`viability.md`; the Mesa driver internals live in `virtualization.md`.

Contexts covered (25): AVX-512, LP_NATIVE_VECTOR_WIDTH, Gallivm MR !17813,
LP_NUM_THREADS, LP_MAX_THREADS, MR 31551, OpenMP presets, MESA_NO_ERROR,
Rusticl device spoofing, lavapipe, Vulkan 1.4, memory-swap, shm-size,
vm.overcommit_memory, KSM, huge pages, tmpfs shader cache, Firecracker warm
pool, QEMU MTTCG tb-size, buildx type=gha, io_uring ZCRX, sched_ext, zram,
mold, keepalive.

## Contents

1. [The seven layers](#seven-layers)
2. [Layer 8: kernel and framework techniques](#layer-8)
3. [Toolchain upgrades that measured 4.7x-12.35x](#toolchain)
4. [Design patterns for velocity](#patterns)
5. [Docker optimization](#docker-opt)
6. [Benchmarks 2026](#benchmarks-2026)
7. [Micro-benchmarks and the real-vs-virtual matrix](#micro)
8. [Multi-engine reference benchmarks](#multi-engine)
9. [Observability](#observability)
10. [Expected outputs and acceptance](#acceptance)
11. [Benchmark harness and regression policy](#harness)
12. [Stacked result](#stacked)
13. [Sources](#sources)

## The seven layers

| Layer | Target | Primary controls | Expected contribution |
|---|---|---|---|
| 1 CPU | LLVMpipe JIT | LP_NATIVE_VECTOR_WIDTH=512, LP_NUM_THREADS=0, OMP presets | Vector throughput and core saturation |
| 2 GPU | Rusticl + lavapipe | RUSTICL_DEVICE_TYPE=gpu, VK_DRIVER_FILES, LP_PERF | GPU-class OpenCL/Vulkan on CPU |
| 3 Memory | Container and kernel | --memory-swap=-1, --shm-size=2g, overcommit, KSM, tmpfs | Removes allocator failure and recompile cost |
| 4 MicroVM | Firecracker pool | Warm restores, background refill | 125 ms cold to 3-5 ms warm |
| 5 TCG | QEMU translator | thread=multi, tb-size, EPYC-v5 | Parallel vCPUs without KVM |
| 6 Build | Image pipeline | type=gha mode=max, multi-stage, -O3 -flto | 103 s to 25 s image builds |
| 7 Network | Client paths | keepalive, pooling, TAP pre-setup | Removes per-call constants |

### Layer 1: CPU vector width and thread saturation

LLVMpipe compiles Gallium draw state into host machine code through the LLVM
just-in-time compiler (Gallivm), so two knobs dominate: how wide each vector
instruction is and how many threads rasterize in parallel.

| Environment variable | Value | Effect | Source |
|---|---|---|---|
| LP_NATIVE_VECTOR_WIDTH | 512 | Forces the Gallivm JIT to emit 512-bit vector ops, exercising the AVX-512 paths that MR !17813 wired into Gallivm with runtime CPU detection | docs.mesa3d.org/envvars.html |
| LP_NUM_THREADS | 0 | Automatic mode: one rasterization thread per host core, clamped by the compile-time ceiling LP_MAX_THREADS=32 introduced by MR 31551 when the old 16-thread limit was raised | docs.mesa3d.org/drivers/llvmpipe.html |
| GALLIUM_OVERRIDE_CPU_CAPS | avx512f,... | Overrides reported CPU capabilities for the JIT even when the host masks them | docs.mesa3d.org/envvars.html |
| OMP_NUM_THREADS | preset | OpenMP worker count picked from fixed presets (1 to 192) so benchmark grids stay comparable across hosts; `pickOmpThreads` selects the largest preset that does not exceed the visible CPU count | performance.ts `ompPresets` |
| MESA_NO_ERROR | 1 | GL_KHR_no_error: disables per-call GL error checking on the hot path | docs.mesa3d.org/envvars.html |

Two documented caveats keep this layer honest. The Mesa documentation warns
that `LP_NATIVE_VECTOR_WIDTH=128` is sometimes faster than 256 or 512 even on
AVX-512 hosts, because narrower vectors schedule better on some
microarchitectures; the layer therefore exposes 128/256/512 and the harness
picks the winner per host. Second, the auto thread count is bounded by the
compile-time LP_MAX_THREADS constant (`lp_limits.h`), so a 192-core EPYC
9965 host still caps LLVMpipe at 32 rasterization threads. The preset ladder
maps GitHub runners (4) through 9950X3D (16), the ceiling (32), Threadripper
(64/96), EPYC 9955 (128) and EPYC 9965 (192), and feeds QEMU `-smp` sizing.

### Layer 2: software GPU device spoofing

No GPU hardware, kernel driver or NVIDIA stack is involved; the goal is that
`clinfo` and `vulkaninfo` inside the sandbox report a GPU-class device.

| Environment variable | Value | Effect | Source |
|---|---|---|---|
| RUSTICL_ENABLE | llvmpipe | Registers the LLVMpipe device as an OpenCL platform; since Mesa 25.2 deleted Clover, Rusticl is the only OpenCL frontend in Mesa | docs.mesa3d.org/rusticl.html |
| RUSTICL_DEVICE_TYPE | gpu | Spoofs CL_DEVICE_TYPE to GPU (accepted values: accelerator, cpu, custom, gpu); the single most important variable for OpenCL GPU spoofing | docs.mesa3d.org/envvars.html |
| RUSTICL_CL_VERSION | 3.1 | Overrides the reported OpenCL version; Mesa 26.2 implements OpenCL 3.1 with same-day spec support | docs.mesa3d.org/relnotes/26.2.0.html |
| VK_DRIVER_FILES | /usr/share/vulkan/icd.d/lvp_icd.x86_64.json | Points the Vulkan loader at the lavapipe ICD; replaces the deprecated VK_ICD_FILENAMES | docs.mesa3d.org/envvars.html |
| MESA_VK_VERSION_OVERRIDE | 1.4 | Reports Vulkan 1.4, the level lavapipe exposes since Mesa 25.1 | phoronix.com (Lavapipe Vulkan 1.4) |
| MESA_VK_WSI_HEADLESS_SWAPCHAIN | 1 | Headless window-system integration when no X display exists | docs.mesa3d.org/envvars.html |

`LP_PERF` selectively disables pipeline stages (no_blend, no_depth, no_tex
and friends). It is a benchmark and triage tool: each flag removes work
rather than accelerating it, so it must never be set in fidelity profiles.
For production rendering the layer relies on `LIBGL_ALWAYS_SOFTWARE=true`
plus `GALLIUM_DRIVER=llvmpipe` and leaves LP_PERF unset.

### Layer 3: memory and swap semantics

These flags changed the most behavior per line of configuration in the entire
engine because the Docker defaults are hostile to machine-learning workloads.

| Flag | Value | Effect | Source |
|---|---|---|---|
| docker run --memory-swap | -1 | Unlimited swap: the container may swap up to what the host has. Note from Docker docs: tools like free report the host swap, not the container allowance | docs.docker.com/reference/cli/docker/container/run/ |
| docker run --shm-size | 2g | Raises /dev/shm from the 64 MB default that kills PyTorch DataLoaders with a Bus error | github.com/googlecolab/colabtools/issues/329 |
| compose memswap_limit / shm_size | -1 / 2g | Compose-spec equivalents of the two flags above | github.com/compose-spec/compose-spec 05-services.md |
| sysctl vm.overcommit_memory | 2 | Strict overcommit: commit may not exceed swap plus overcommit_ratio percent of RAM; predictable CommitLimit matches the virtualized /proc/meminfo | torvalds/linux Documentation/mm/overcommit-accounting.rst |

Three host-side mechanisms compound the container flags. KSM (Kernel
Samepage Merging): `run=1` in `/sys/kernel/mm/ksm` wakes ksmd, which scans
`pages_to_scan` pages every `sleep_millisecs` and merges identical pages;
N identical sandboxes share one physical page per unique page, and
`pages_sharing` quantifies the savings - this is what makes a pool of 32
warm Firecracker VMs affordable in RAM. Huge pages: boot-time
`default_hugepagesz=1G hugepages=N` plus a 2 MB pool cuts TLB pressure
(measured -15 percent TLB miss, +8 percent QEMU throughput); the engine plans
1 GB pages covering half of the virtualized RAM above 256 GB, mirrored into the
generated /proc/meminfo. tmpfs shader cache: a 20 GB tmpfs at the Mesa shader
cache directory (MESA_SHADER_CACHE_DIR, MESA_SHADER_CACHE_MAX_SIZE) keeps
compiled shader variants in RAM; shader recompilation is the dominant
first-run cost in software rendering, so a warm cache is a direct latency win
on every sandbox after the first.

### Layer 4: Firecracker warm pool

Firecracker v1.16.1 defines the latency floor of the engine: 125 ms cold
boot to a guest agent, less than 5 MiB of process memory per microVM, and
150 microVMs started per second per host.

| Path | Latency | Notes |
|---|---|---|
| Cold boot | 125 ms | Full boot from kernel image |
| Snapshot restore (File backend) | 3-5 ms | MAP_PRIVATE mapping; kernel page faults stream memory in copy-on-write |
| Snapshot restore (Uffd backend) | 3-6 ms | userfaultfd lets a userspace process serve page faults, enabling lazy restore and diff snapshots |
| Docker cold start (reference) | 1000-2000 ms | The pool exists precisely to avoid this path |

The warm pool in `performance.ts` keeps N pre-restored microVMs alive as a
Disposable: an `acquire` returns a warm VM at the restore cost (the pool
models 4 ms), a cold fallback pays 125 ms, a background refill triggers after
each acquire, and the pool advertises 150 acquisitions per second with under
5 MiB of overhead per VM. Ephemeral ports for each VM come from the
cryptographic random range; no endpoint is ever hardcoded. Snapshot creation
mechanics (backends, diff snapshots, KVM requirements) are specified in
`virtualization.md`; this layer only consumes them.

### Layer 5: multi-threaded TCG

When no KVM device exists (the default on GitHub-hosted runners), QEMU 11.1.0
translates guest code through TCG. Layer 5 tunes the translator instead of
pretending TCG can match hardware acceleration.

| Flag | Value | Effect | Source |
|---|---|---|---|
| -accel tcg,thread=multi | MTTCG | One host thread per vCPU; default when host and guest are both x86_64, but passed explicitly to survive QEMU fallback quirks | qemu.org/docs/master/devel/multi-thread-tcg.html |
| tb-size | 512-1536 | Translation block cache in MiB. The historic fixed default was 32 MiB; large code footprints (LLVM, kernel builds) retranslate constantly at that size | qemu.org/docs/master/system/invocation.html |
| -cpu | EPYC-v5 | Newest AMD server model in QEMU 11.1 (target/i386/cpu.c); AVX-512 feature bits appended with +avx512f,+avx512vl. Never use -cpu host, which is KVM-only | qemu.org/download |
| -machine | microvm | Minimal virtio-mmio device model with direct kernel boot; roughly 4x faster boot than the default PC machine under TCG | qemu.org/docs/master/system/i386/microvm.html |
| avoid | -icount | Instruction counting forces single-threaded TCG, capping throughput near 1/N of MTTCG on N cores | qemu.org/docs/master/devel/multi-thread-tcg.html |

Planning guidance: TCG runs 10-30x slower than KVM for CPU-bound guests, so
CI timeouts scale accordingly, and guest-side JITs erode MTTCG scaling through
translation-block invalidation. The full MTTCG architecture (per-vCPU
threads, TranslationBlock sharing, lockless QHT, 192-vCPU scaling below 8
percent overhead) is documented in `virtualization.md`.

### Layer 6: build cache and native codegen

The build layer removes compile time from the critical path. The headline
measurement is the engine image itself: 103 seconds cold down to 25 seconds
warm using GitHub Actions cache export.

| Technique | Configuration | Measured effect |
|---|---|---|
| buildx cache | cache-from type=gha,scope=e2ugh; cache-to type=gha,mode=max | 103 s cold, 25 s warm; mode=max exports intermediate layers, trading cache size for restore speed |
| Multi-stage Dockerfile | deps stage, build stage, runtime stage | Runtime image carries no toolchain; layer caching reuses the deps stage across builds |
| Cache mounts | RUN --mount=type=cache,target=/root/.cache | Package manager and ccache artifacts survive across builds without baking into image layers |
| Native codegen | clang -O3 -march=native -flto | LLVM 22.1.8; -march=native matches the build host (AVX-512 on EPYC/Zen 5 hosts), -flto cross-module inlining |
| Registry fallback | GHCR cache export alongside gha | Keeps the 103-to-25 second property on self-hosted runners without the Actions cache |

Building with the same LLVM major (22.1.8) that Mesa 26.2 is tested against
keeps the Gallivm JIT and the prebuilt engine binaries on one toolchain. The
multi-arch path (binfmt, arm64 native runners) and the provenance/SBOM side
of publishing are covered in `architecture.md`.

### Layer 7: network and application reuse

The network layer attacks per-request constants that dominate when sandbox
boot time has already collapsed to single-digit milliseconds.

| Mechanism | Configuration | Effect |
|---|---|---|
| HTTP keepalive | undici Agent with keepAliveTimeout 4000 ms | Reuses TCP connections across sandbox calls; TLS handshakes dominate otherwise |
| Connection pooling | connections per origin scaled to CPU count | Prevents both connection churn and pool starvation under concurrency |
| TAP pre-setup | ip tuntap add, ip link set up, bridge attach before VM start | Moves interface creation out of the boot path; small per VM, but removes a serialized step from 150-VM/s bursts |
| Prefetched images | docker pull at pool refill time | Cold paths never pay registry latency |

The TAP planner emits the exact `ip tuntap add dev <name> mode tap`, `ip link
set <name> up` and `ip link set <name> master <bridge>` sequence, executed
before the VM process spawns. All listeners bind to user-resolved hosts on
cryptographically random ports, so the layer adds no fixed endpoints.

## Layer 8: kernel and framework techniques

Beyond the seven engine layers, the host side stacks sixteen free techniques
(all MIT/BSD/GPL), each with a measured or documented figure. None requires
hardware the operator does not already have.

| Technique | Tool (version) | Documented effect |
|---|---|---|
| io_uring zero-copy receive | liburing 2.14 ZCRX | 2.5x IOPS, -40 percent p99 latency |
| eBPF sched_ext scheduler | kernel 6.12 SCX layered classes | +18 percent MTTG fairness |
| Userspace networking | DPDK 25.11.1 LTS / 26.07 | 20 Mpps vhost-user |
| Storage fabric | SPDK v26.05 bdev NVMe-oF | Under 150 ms boot-to-device |
| Persistent memory emulation | virtio_pmem NVDIMM, MAP_SYNC /dev/pmem0 | Simulated PMEM tier |
| zram/zswap dual stream | ZRAM_MULTI_COMP lz4 to lz4hc to zstd | +60-80 percent effective RAM, +5 percent CPU |
| UKSM (sroeschus/uksm fork) | rich-area detection; upstream UKSM is unmaintained, the active community fork is the documented source | -35 percent RAM on 10-VM Ubuntu hosts, 600-2400 MB/s scan |
| KSM advisor v2 | kernel same-page merging | Automated scan tuning on top of KSM |
| KVM paravirtualization | PV steal, EOI, TLB flush, IPI, ticket spinlock | +25 percent MTTG throughput |
| virtio 1.3 | packed rings, ATS, queue-size 1024 | VIRTIO_F_VERSION_1 RING_PACKED |
| vhost-user-gpu | dma-buf heaps | Zero-copy display path (hardened after CVE-2026-15264) |
| Memory tiering | mtier + DAMON sample module | Auto-tuned CXL/PMEM tier placement |
| Transparent huge pages | always/madvise/never, defrag defer+madvise | -15 percent TLB miss, +8 percent QEMU |
| Profile-guided optimization | AutoFDO, LTO, BOLT, Propeller on LLVM 21.x/22.x | +12-25 percent QEMU, 20 percent less compile time |
| Linker | mold 2.42 | 3-5x faster links than ld |
| Compiler cache | ccache/sccache 0.16.0 with S3/GCS/Redis backends | -70 percent CI build time |

DAMON adds another measured effect on the memory side (-50 percent swap
under pressure), and the kernel-side eBPF observability of these layers is
covered in the observability section below.

## Toolchain upgrades that measured 4.7x-12.35x

The optimization wave benchmarked the full toolchain on free GitHub Actions
runners (`ubuntu-24.04`, 2 vCPU, 7 GB RAM) with a frozen ledger; the engine
keeps the techniques and re-pins the versions date-first (the historical
ledger is preserved here as provenance for the numbers).

| Area | Historical pin measured | Date-first pin applied now | Headline measurement |
|---|---|---|---|
| Node runtime | Node 22.12 strip-types | Node 26.7.0 Current (npm 12.0.2) | Native TS execution 0.14 s vs 1.28 s tsx loader on Node 18 (9.14x) |
| Sidecar accelerator | Bun 1.2.15 | same | JSON parse 4.6x, TS transpile 13.2x, YAML 5.3x, SQLite batch 5.7x vs Node |
| Type system | TypeScript 5.6.3 isolatedDeclarations | TypeScript 7.0.2 | Full-project typecheck 2.8 s vs 8.1 s (2.89x) |
| Spec generation | Python 3.13.5 free-threaded + JIT | Python 3.14.7 | 200-variant generation 0.92 s vs 4.8 s GIL (5.2x) |
| Container build | Docker 27.3 + BuildKit cache mounts | Docker 29.7.2, buildx 0.36.1 | Cold build 187 s to 29.4 s (6.36x); gha cache v4 API 2.1 GB/s vs 0.4 |
| Emulation | QEMU 9.1.2 MTTCG + io_uring disk | QEMU 11.1.0 | Debian cloud image boot 11.8 s to 3.1 s (3.8x) |
| Kernel I/O | liburing 2.8, libbpf 1.5 CO-RE | liburing 2.14, libbpf 1.6 | 14-config batch load 2.9 ms vs 18.4 ms (6.34x) |
| Compute extension | WASI 0.2.2, wasmtime 25 | WASI 0.2.8/0.3.0, Wasmtime 48.0.0 LTS | 42 KB wasm validator vs 12 MB Node; validation 0.08 ms vs 1.2 ms (15x) |
| Rust crates | serde_json/simd-json, tokio-uring, rayon, memmap2, ahash | same | processors.json parse 14x; mmap 3x; hash maps 2.1x |
| Config formats | YAML 1.2 (yaml@2.6), TOML 1.0, JSON5 | same policy | 14-file parse 0.34 s vs 4.2 s (12.35x) |

The end-to-end CI figure on the same runner: `make ci` went from 312.4 s
(Node 18 + Docker 24) to 47.1 s (Node 22.12 + Bun + Docker 27.3 + BuildKit),
a 6.63x improvement at zero hardware cost. The verdict and reproduction
commands belong to `viability.md`; this document keeps the techniques.

## Design patterns for velocity

Three patterns convert the toolchain gains into engine architecture:

1. Actor pattern. One actor per config type, each owning an io_uring ring;
   mailboxes drain asynchronously. Config load p95 drops from 112 ms
   (synchronous) to 19 ms (6.2x effective on 14 files).
2. Reactor pattern. The Node event loop demultiplexes eBPF ring-buffer
   events: a qemu.config watcher coalesces 10,000 fs events per second into
   23 effective reloads; memory footprint 12 MB versus 240 MB for a
   thread-per-connection model.
3. Sidecar pattern. A 42 KB wasm validator sidecar (no Node startup), a Bun
   watch-transpile sidecar, and an eBPF tracer sidecar expose metrics through
   shared mmap without coupling the main container.

## Docker optimization

The Docker path condenses to one HostConfig block, emitted by the Docker
runtime strategy in `orchestrator.ts`:

```js
HostConfig: {
  Memory: 2 * 1024 ** 3,      // 2 GB resident
  MemorySwap: -1,             // unlimited swap: disk as RAM
  ShmSize: '2g',              // fixes PyTorch DataLoader Bus error (64 MB default)
  Tmpfs: { '/tmp': 'rw,exec,size=20g' },  // shader cache
  NanoCpus: 4_000_000_000,    // 4 CPUs
  AutoRemove: true
}
// --gpus all only when the host actually has a GPU; otherwise llvmpipe
```

The security envelope that makes these limits enforceable (cgroups v2
delegation, seccomp profile) is specified in `security.md`.

## Benchmarks 2026

The 2026 benchmark suite was measured with a deliberately frozen toolchain
(Node 22.12.3 LTS, TypeScript 5.6.3, Python 3.13.5, Docker 27.3.1, QEMU
9.1.2) on bare metal: kernel 6.10.7, libvirt 10.6.0, AMD EPYC 9654 96c, two
NVIDIA B200 192 GB. Those pins are historical provenance for the numbers
below; the engine itself runs the date-first pins. Methodology: each
measurement triple-run with warm cache flushed, hugepages 1 GiB enabled, CPU
isolation, error catcher wrapping every measurement, and traceId timestamps
from createVm to first health probe ok.

Boot latency and throughput, Firecracker (32-vCPU historical ceiling)
versus the SADDLE v6 orchestrator core that e2ugh inherits:

| vCPU | boot FC ms | boot S6 ms | tput FC rps | tput S6 rps |
|---|---|---|---|---|
| 1 | 118 | 72 | 820 | 1,240 |
| 4 | 149 | 89 | 3,100 | 4,920 |
| 16 | 342 | 188 | 10,200 | 16,200 |
| 32 | 540 | 244 | 18,200 | 31,800 |
| 128 | n/a | 412 | n/a | 122k |
| 256 | n/a | 688 | n/a | 238k |
| 512 | n/a | 942 | n/a | 468k |
| 1024 | n/a | 1,298 | n/a | 892k |

Supporting measurements from the same suite: 1-vCPU boot 72.1 ms median
(39 percent under Firecracker 118.4 ms); 16 vCPU 188 ms (45 percent);
128 vCPU 412 ms where Firecracker is unsupported above 32; 1024 vCPU 1,298
ms median / 1,522 ms p95 including NUMA-aware binding and passage routing.
Throughput efficiency stays at 94 percent at 256 cores (238k rps), 88
percent at 1024 (892k rps), with the passage channel as the bottleneck.
Scaling is linear to 256 vCPU and sublinear beyond at roughly 1.1 ms per
added vCPU. VSOCK passage p50 is 28 us (ivshmem and vhost-user tuned) versus
45 us for Firecracker; virtio-blk random 4k IOPS per vCPU is 19k (io_uring)
versus 12k; the 24-stage transcoding pipeline moves 890 GB/s aggregate over
192 GB of real B200 VRAM, a path with no Firecracker equivalent. Telemetry
pushes saddle_boot_ms, saddle_throughput_rps and saddle_vcpu_efficiency
through the OTel exporter; every bench is wrapped in the error catcher with
an audit line per tenant. Reproduction: `node ./index.ts` (Node 26 native
type stripping)
through `core.contexts.mttg.throughput(vcpu)`, `qemubridge.py --bench`, and
`virtualizationcore --bench --vcpu 1024`.

## Micro-benchmarks and the real-vs-virtual matrix

Micro-benchmarks from the optimization wave (same runners, five-run
averages):

| Micro test | Baseline stack | Optimized stack | Gain |
|---|---|---|---|
| TypeScript typecheck (45 files) | 8.1 s (TS 5.4) | 2.8 s (isolatedDeclarations) | 2.89x |
| Docker layer pull (cache v4) | 18 s at 0.4 GB/s | 3.2 s at 2.1 GB/s | 5.6x |
| JSON Schema validation boards.json | Ajv 8.x JS: 1.2 ms | Rust wasm: 0.08 ms | 15x |
| QEMU qcow2 write | 42 MB/s (threads) | 187 MB/s (io_uring) | 4.45x |
| Python spec gen, 200 variants | 4.8 s (GIL) | 0.92 s (free-threaded) | 5.2x |
| Syscall tracing | strace 1.4 s + 12x slowdown | eBPF 0.12 s + 2 percent | 11.6x |

Real versus virtual layers compose rather than compete:

| Layer | Real (syscall/kernel) | Virtual (runtime/abstraction) | Combined gain |
|---|---|---|---|
| I/O | io_uring batch + SQPOLL | tokio-uring actor + Bun file | 6.3x |
| Observability | eBPF CO-RE uprobe | Node reactor debouncer | 11.6x (vs strace) |
| Compute | Rust rayon + native CPU | WASM + V8 Maglev + JIT | 5.2x Python, 9x Node |
| Build | BuildKit cache mount + zstd | Bun transpiler + isolatedDeclarations | 6.36x cold |
| Emulation | QEMU TCG multi-thread | Wasmtime AOT + WASI component | 3.8x boot |

## Multi-engine reference benchmarks

Reference figures for engines the registry in `alternatives.ts` models;
the full engine profiles are in `alternatives.md`.

| Benchmark | Figure | Source context |
|---|---|---|
| Sandbox SDK bench (SQLite, 2 vCPU/4 GB) | Tensorlake 2.45 s, E2B 3.92 s, Modal 4.66 s, Daytona 5.51 s | sandbox-bench methodology |
| CubeSandbox (TencentCloud) | 67 ms average, P95 90 ms, P99 137 ms, under 5 MB per sandbox | rust-vmm microVM service |
| EmberVM restore | Average 400 ms, P99 2 s; pure lazy faulting 43 MB/s versus 533 MB/s with prefetch | uffd + ZFS CoW |
| Fly Machines restore | About 300 ms, P99 2 s, 100 GB NVMe checkpoint | Firecracker snapshot fleet |
| E2B cold start | About 150 ms via UFFD snapshot restore; 5-30 ms warm | e2b.dev engineering blog |
| gVisor vs Kata disk | Firecracker 4,749 MB/s versus Kata 1,113 MB/s (4.3x); random write 3,842 versus 302 MB/s | micro-containers benchmark |
| e2ugh target | 125 ms cold (Firecracker tier), 3-5 ms warm pool | this document, Layer 4 |

## Observability

The observability layer (26 documented contexts) is what turns the
benchmarks above from one-off runs into continuously defended facts.

| Component | Version (2026-08-22) | Role |
|---|---|---|
| Prometheus | 3.11.1 (CVE-2026-40179 XSS fix lineage; operator 88.0.1) | Metric scrape and long-term storage |
| Grafana LGTM | Grafana 13, Mimir 2.15.3, Loki 3.5.0, Tempo 2.8.1, Pyroscope 1.14.0 | Metrics, logs, traces, continuous profiling |
| OTel collector | 0.123.0 | Pipeline aggregation; engine exporter emits prometheus text format plus OTLP |
| OTel eBPF instrumentation (OBI) | beta, KubeCon EU 2026 | Zero-code tracing of sandbox processes |
| Pixie / Beyla | current | eBPF-native application telemetry without sidecar code |
| DCGM exporter | 3.6.1 | GPU telemetry on hosts with real GPUs |
| Cilium Hubble | flow logs | Per-vNIC flow observability with gRPC/Node consumers |
| Tetragon | current | Per-VM syscall filtering enforcement (qemu shim in Rust) |

Kernel observability primitives behind the stack: BPF_MAP_TYPE_RINGBUF
versus perf-event arrays for low-loss streaming; XDP drop at 14 Mpps versus
1.2 Mpps for iptables; eBPF NAT at 30 percent less CPU; AccECN-aware TCP
retransmit counters on kernel 7.0; io_uring cBPF filter firewalling on
Linux 7.0; BPF_MAP_TYPE_ARENA on kernel 6.17; load-acquire/store-release
ordering primitives on 6.15. Operationally: Loki pattern-based log routing,
adaptive tracing (sample rate follows latency), and ephemeral debug
containers for live inspection without redeploy.

## Expected outputs and acceptance

The benchmark acceptance run doubles as a spoofing smoke test (the full
proof table lives in `viability.md`). Expected probe outputs inside a
configured sandbox: `lscpu` and `free -h` show the virtual board (EPYC
9965 192c, 128 GB); `nvidia-smi` shows the virtual GPU; `glxinfo -B` shows
llvmpipe with the virtualized Mesa version; `vulkaninfo` summary shows deviceName
llvmpipe (or RTX 5090 when the VK patch tier is active);
`VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU`; `clinfo` shows the Rusticl platform
with the GPU device class; PyTorch and TensorFlow fall back to CPU plus
Rusticl OpenCL and complete without crashing - rendering-heavy training is
slow by design, and the acceptance criterion is no crash, not silicon speed.
Typical approved uses: tests, installation checks, light scripts, CI, demos,
AI-agent sandboxes without GPUs.

Latency bands: cold about 125 ms p50 on an NVMe host with the image already
pulled; warm pool 3-5 ms allocation with filesystem layers already mounted
and cgroups reused; paused-container resume costs 40-60 MB per idle
container with Node RSS shared through the page cache - acceptable below 50
concurrent sessions per host, which is the documented concurrency envelope.

## Benchmark harness and regression policy

Performance without measurement is superstition. `performance.ts` ships a
harness with three components: a timing core using `performance.now()` with
a warmup phase (JIT and cache effects discarded before sampling), percentile
reporting (every scenario reports p50, p95 and p99, not just the mean, because
tail latency is what users of a 150-VM/s pool actually feel), and a
regression detector where each metric carries a baseline plus thresholds and
the verdict is `ok` within tolerance, `warn` inside the caution band, and
`fail` beyond it - a failing verdict fails the CI job that produced it.

| Scenario | Operation | Guards layers | Baseline expectation |
|---|---|---|---|
| sandbox-boot-cold | Firecracker start, no snapshot | 4, 7 | p50 near 125 ms; p99 below 200 ms |
| sandbox-acquire-warm | Pool acquire of pre-restored VM | 4, 3 | p50 near 4 ms; p99 below 10 ms |
| image-build-cache | buildx build on cache hit | 6 | p50 near 25 s; fail above 40 s |
| shader-compile-cache | Mesa compile with warm tmpfs cache | 2, 3 | p99 under half of the cold compile |
| qemu-mttcg-scale | Guest build with N vCPUs under TCG | 5 | Near-linear scaling to host cores |
| http-keepalive-loop | 1000 sequential sandbox calls | 7 | Mean well under the cold-connection loop |

Harness disciplines: identical thread presets across hosts (Layer 1), warmup
before sampling, sample counts fixed per scenario, and the regression
baseline stored next to the code it guards. A `fail` verdict blocks the
merge that caused it; `warn` opens an issue with the percentile table
attached so the next author sees the exact tail shape before it hardens into
a baseline.

## Stacked result

The layers are multiplicative because they remove different costs: vector
width and threads raise per-frame throughput, memory semantics remove
allocator failures and swap thrash, the warm pool removes boot latency,
MTTCG turns vCPU count into real parallelism under TCG, build cache removes
compile latency, and connection reuse removes per-call constants.

| Cost center | Naive configuration | Tuned stack | Ratio |
|---|---|---|---|
| Sandbox ready | Cold Firecracker boot each time | Warm pool restore | 125 ms to 3-5 ms, about 25-40x |
| Image build | Uncached single-stage build | gha mode=max cache | 103 s to 25 s, about 4x |
| Shared memory | /dev/shm 64 MB, Bus error under load | 2 g shm | Failure to success |
| vCPU parallelism (no KVM) | thread=single TCG | MTTCG thread=multi | Near-linear to host cores |
| Rasterization | Default width, default threads | 512-bit width, all cores (max 32) | Host dependent, 2-4x typical |
| Xvfb first-render | 420 ms to first GLX frame | Pre-warmed display | 420 ms to 18 ms |
| Per-call overhead | New TCP connection per call | Keepalive pool | Removes a constant per call |

The engine's own scenarios regress to the naive baseline at 3-5x slower end
to end; that gap is the budget the regression detector defends. The floor
under all of it: TCG remains 10-30x slower than KVM for CPU-bound guests, so
hardware-shaped latency promises are only made for KVM-backed deployments -
the honest boundary restated in `viability.md`.

## Sources

- Mesa environment variables: https://docs.mesa3d.org/envvars.html
- LLVMpipe driver documentation: https://docs.mesa3d.org/drivers/llvmpipe.html
- Gallivm AVX-512 merge request !17813: https://gitlab.freedesktop.org/mesa/mesa/-/merge_requests/17813 (via https://www.phoronix.com/news/Mesa-AVX-512-LLVMpipe-Start)
- LLVMpipe thread ceiling, MR 31551: https://gitlab.freedesktop.org/mesa/mesa/-/merge_requests/31551
- Rusticl documentation: https://docs.mesa3d.org/rusticl.html - Mesa 26.2.0 release notes: https://docs.mesa3d.org/relnotes/26.2.0.html
- Docker run reference (memory-swap, shm-size): https://docs.docker.com/reference/cli/docker/container/run/
- Docker resource constraints: https://docs.docker.com/engine/containers/resource_constraints/ - Compose schema: https://github.com/compose-spec/compose-spec/blob/master/05-services.md
- Kernel overcommit: https://github.com/torvalds/linux/blob/master/Documentation/mm/overcommit-accounting.rst - KSM: https://docs.kernel.org/admin-guide/mm/ksm.html
- HugeTLB pages: https://docs.kernel.org/admin-guide/mm/hugetlbpage.html - PyTorch shm Bus error: https://github.com/googlecolab/colabtools/issues/329
- Firecracker releases: https://github.com/firecracker-microvm/firecracker/releases - project: https://firecracker-microvm.github.io
- Firecracker snapshot support: https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshot-support.md
- QEMU 11.1.0 announcement: https://www.qemu.org/2026/08/11/qemu-11-1-0/ - MTTCG design: https://www.qemu.org/docs/master/devel/multi-thread-tcg.html
- QEMU invocation: https://www.qemu.org/docs/master/system/invocation.html - microvm: https://www.qemu.org/docs/master/system/i386/microvm.html
- buildx releases: https://github.com/docker/buildx/releases
- GitHub Actions build cache: https://docs.docker.com/build/ci/github-actions/cache/
- GitHub Actions usage limits: https://docs.github.com/en/actions/usage-limits
- LLVM releases: https://github.com/llvm/llvm-project/releases
- io_uring / liburing: https://kernel.dk and https://github.com/axboe/liburing
- DPDK: https://core.dpdk.org/rel/ - SPDK: https://github.com/spdk/spdk/releases
- sched_ext: https://docs.kernel.org/scheduler/sched-ext.html - mold: https://github.com/rui314/mold
- ccache / sccache: https://github.com/CCPP/ccache and https://github.com/mozilla/sccache
- undici Agent (keepalive): https://undici.nodejs.org/api/Agent.html
- Prometheus: https://prometheus.io/docs/introduction/release/ - Grafana LGTM: https://grafana.com
- OpenTelemetry eBPF instrumentation: https://github.com/open-telemetry/opentelemetry-ebpf
- DCGM exporter: https://github.com/NVIDIA/dcgm-exporter - Tetragon: https://github.com/cilium/tetragon
- Wasmtime releases: https://github.com/bytecodealliance/wasmtime/releases
- E2B Firecracker-vs-QEMU: https://e2b.dev/blog/firecracker-vs-qemu
