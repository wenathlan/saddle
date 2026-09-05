# Viability Proof - Why e2ugh Is Possible

This is the key document of the repository: the argument that a 100 percent
software engine can present CPUs, memory and GPUs that do not physically
exist, execute real workloads on software rasterizers, and pass the hardware
probes that AI agents and framework installers actually perform - the thesis
that virtual hardware is functional spoofing, not fabricated throughput. Every
claim below is anchored to a verified, dated source from the 2026-08-22
research pass: the full methodology, the multilingual corpus design, the
145-entry numbered bibliography and the three roadmap appendices (A, B, C)
live in this document; the implemented
capabilities live in the domain modules (`scheduler.ts`, `compute.ts` and
kin, after the v3 redistribution of the retired `future.ts`); the optimization
techniques that make the stack fast live in `performance.md`; the isolation
stack that makes it safe lives in `security.md`; the engine landscape lives
in `alternatives.md`; the virtualized hardware catalog itself (EPYC 9965, RTX
5090, RTX PRO 6000, MI350X and the generated artifacts) lives in
`hardware.md`, and the runtime tiers that execute it in `virtualization.md`.

Contexts covered (25): functional spoofing, honest execution, procfs
channels, sysinfo hooks, NVML shims, Khronos loaders, virtual nvidia-smi adapter 575.57.08,
CUDA 12.9, memoverlay, dolos, GpuAdapter, detection-depth ladder, CPUID truth,
MemorySwap -1, ShmSize 2g, MR !17813, MR 31551, Lavapipe CTS, Rusticl 3.1,
Firecracker 125 ms, QEMU 11.1.0 MTTCG, GitHub Actions free, GHCR, static
binary bypass, SECCOMP_RET_USER_NOTIF.

## Contents

1. [The thesis: functional spoofing, honest execution](#thesis)
2. [How tools actually read hardware (attack surface)](#attack-surface)
3. [The detection-depth ladder](#ladder)
4. [The technical proof table (14 techniques)](#proof-table)
5. [Why the earlier sixty-page "impossible" analysis was wrong](#refutation)
6. [Performance envelope](#envelope)
7. [The slowness question: answered 4.7x-12.35x](#slowness)
8. [Honest limitations](#limitations)
9. [Getting started on GitHub in an afternoon](#afternoon)
10. [Cost analysis: zero dollars](#cost)
11. [Verification reports](#verification)
12. [Research methodology](#methodology)
13. [The multilingual corpus](#multilingual)
14. [Numbered bibliography (145)](#bibliography)
15. [Appendix A. v5 future feature ledger (F-001..F-065, set A)](#appendix-a)
16. [Appendix B. v6 future feature ledger (F-001..F-065, set B)](#appendix-b)
17. [Appendix C. Backlog from the v4 archive (13 items)](#appendix-c)
18. [Appendix D. Planned externals (not implementable in-engine)](#appendix-d)

## The thesis: functional spoofing, honest execution

The engine does not pretend to be physically faster than the host. The
thesis is narrower and provable: standard Linux tooling reads hardware
through a small number of well-defined channels - procfs files, the
`sysinfo` libc call, the Vulkan/OpenGL/OpenCL loaders, and the NVML library -
and each of those channels can be intercepted or replaced without root and
without patching the tools themselves. The result is a sandbox where:

1. `lscpu`, `free`, `htop` and language runtimes report the virtual board
   (192 EPYC cores, 128 GB or up to 1 TiB of RAM) because they parse
   `/proc/cpuinfo` and `/proc/meminfo`, which the engine renders
   byte-realistically (`virtualcpu.ts`, `virtualmemory.ts`).
2. `nvidia-smi`, `gpustat` and `pynvml` report an RTX 5090, RTX PRO 6000 or
   A100 because NVML entry points are shimmed through `LD_PRELOAD` with
   `dlsym(RTLD_NEXT)` chaining, and the CLI itself can be replaced by a
   pixel-compatible virtual adapter emitting the confirmed header `NVIDIA-SMI 575.57.08
   Driver Version: 575.57.08   CUDA Version: 12.9`.
3. `torch.cuda.is_available()`, `clinfo`, `vulkaninfo` and `glxinfo` succeed
   because the execution is real: llvmpipe (OpenGL 4.6 core, 161/161
   extensions, AVX-512 via Gallivm), lavapipe (Vulkan 1.3-conformant, 1.4
   exposed) and Rusticl (OpenCL 3.1) genuinely run compute - on CPU threads,
   not silicon.

Spoofing the reports and executing on software is the entire trick. It fools
the overwhelming majority of real-world probes - framework guards, installer
checks, agent reconnaissance - while never claiming throughput the host
lacks. A tool that reads `/proc`, calls NVML, or queries a Khronos API sees
the virtual board; a kernel-level audit (CPUID instruction, actual core
count, TPM) sees the truth, and the engine never claims otherwise. That is
the precise sense in which the engine is a 99 percent illusion: depths 1-3
of probing (below) cover what essentially every agent, installer and
benchmark harness does before running code; depths 4-5 do not, and the
engine says so.

## How tools actually read hardware (attack surface)

| Tool | Read channel | Interception point |
|---|---|---|
| `lscpu` | sysfs plus `/proc/cpuinfo` | generate/replace `/proc/cpuinfo` per man page lscpu(1) |
| `free` | parses `/proc/meminfo` | generate/replace `/proc/meminfo` per man page free(1) |
| `clinfo` | OpenCL properties via ICD dispatch (`/etc/OpenCL/vendors/*.icd`) | point the ICD at Rusticl over llvmpipe |
| `vulkaninfo` | Vulkan API through `libvulkan.so.1`, ICDs under `/usr/share/vulkan/icd.d` | set `VK_DRIVER_FILES` to `lvp_icd.x86_64.json` |
| `glxinfo` | GLX implementation on an X display | Xvfb with `+extension GLX`, `LIBGL_ALWAYS_SOFTWARE` |
| `nvidia-smi`, `gpustat`, `pynvml` | NVML (`libnvidia-ml.so`) | LD_PRELOAD NVML shim; or replace the `nvidia-smi` binary |
| Python `psutil`, Go `mem` | libc `sysinfo()` | hook `sysinfo` via `dlsym(RTLD_NEXT)` |
| `torch.cuda` | libcuda/libcudart entry points | GpuAdapter-style API interception; NVML shim for presence probes |

## The detection-depth ladder

Probes exist at different depths, and the engine answers each depth with the
cheapest mechanism that satisfies it, exposing each rung as a distinct
runtime tier (Docker, QEMU TCG, Firecracker) through the orchestrator, so an
operator pays only for the depth their workloads need.

| Depth | Example probe | What satisfies it | Engine tier |
|---|---|---|---|
| 1. Parsing /proc | `lscpu`, `free`, `htop`, most installers | byte-realistic generated cpuinfo/meminfo (memoverlay/dolos technique) | Docker |
| 2. libc calls | `sysinfo()`, `uname()` consumers (psutil, Go mem stats) | `dlsym(RTLD_NEXT)` hook with `mem_unit` normalization | Docker |
| 3. Hardware APIs | NVML, `nvidia-smi`, `clinfo`, `vulkaninfo`, `glxinfo` | NVML shim + virtual CLI + real Mesa software drivers | Docker |
| 4. Instruction level | CPUID, MSR reads, core-count truth | emulated CPU with `-cpu EPYC-v5` and virtualized SMBIOS | QEMU TCG |
| 5. Kernel objects | TPM, real device PCI enumeration | honest boundary: not virtualized without KVM-tier passthrough tricks | Firecracker (KVM hosts) |

The ladder framing is the practical answer to "can it be detected?": yes, at
depths 4-5, by tools that almost no agent or framework uses before running
code; and no, at depths 1-3, which is where 99 percent of real probing
happens. The engine's claim is exactly that scope.

## The technical proof table

Each row is one load-bearing technique, its mechanism, the proof that it
works, and the primary source. Together the rows cover the full spoofing
surface: CPU, memory, GPU presence, GPU APIs, execution engines, packaging
and continuous integration.

| # | Technique | Mechanism | Proof | Source |
|---|---|---|---|---|
| 1 | memoverlay (memory virtual identity) | `LD_PRELOAD` intercepts `open/open64/openat/fopen/fopen64/freopen/freopen64`, redirects `/proc/meminfo` to a regenerated `/tmp` file; an inotify (IN_MODIFY) thread keeps values fresh; `FAKEMEM_MEM=16G` sets the size | 362-line C file fetched and read; builds with `clang -shared -fPIC memoverlay.c -ldl` | https://github.com/stantheawesomeman/memoverlay |
| 2 | dolos (CPU/sysinfo virtual identity) | Hooks `sysinfo()` via `dlsym(RTLD_NEXT)`; false `totalram` normalized by `mem_unit`, `freeram` at ~25 percent, plus `uname`/`gethostname` hooks; global install via `/etc/ld.so.preload` | 144-line hooks.c fetched and read | https://github.com/cdt4/dolos/blob/main/dolos/hooks.c |
| 3 | fake-nvidia-smi | Pure-Python (stdlib only) generator with profiles h100 81,559 MiB/700 W, a100 40,536 MiB/400 W, v100/p100/k80/t4; randomized temp/power/bus-id; output matches the official manual | README (163 lines) fetched; header confirmed `NVIDIA-SMI 575.57.08 / CUDA 12.9` | https://github.com/pogusthewhisper/fake-nvidia-smi |
| 4 | NVML unified shim | `libnvml-unified.so` via `LD_PRELOAD`; `nvmlDeviceGetCount` falls back to `cudaGetDeviceCount`, `nvmlDeviceGetMemoryInfo` reads `/proc/meminfo`, `nvmlDeviceGetName` uses `cudaGetDeviceProperties`; index-as-pointer handles | Built for DGX Spark GB10 (Ubuntu 24.04.3, driver 580.126.09, CUDA 12.8); README fetched (230 lines) | https://github.com/rick-hsu/nvml-unified-shim |
| 5 | GpuAdapter (CUDA API interception) | Intercepts `libcuda`, `libcudart`, `libcublas`, `libnvidia-ml`, `libnccl` via `LD_PRELOAD` (Linux) / `DYLD_INSERT_LIBRARIES` (macOS); virtual `nvidia-smi` including `--query-gpu`, topo, MIG; `--devices "a100:2,h100:2"` | README fetched (1,200 lines), repo verified HTTP 200 | https://github.com/FanBB2333/GpuAdapter |
| 6 | Docker memory virtualization | `--memory-swap -1` grants unlimited swap (docs: tools like `free` report host swap); `--shm-size 2g` fixes the PyTorch DataLoader Bus error from the 64 MB default; `vm.overcommit_memory=2` semantics | Official CLI reference and resource-constraints docs fetched | https://docs.docker.com/reference/cli/docker/container/run/ |
| 7 | llvmpipe AVX-512 | Gallivm emits 512-bit vector code with runtime CPU detection (merged Mesa 22.3 via MR !17813); `LP_NATIVE_VECTOR_WIDTH=512` selects it | Merge request confirmed via Phoronix coverage linking the MR | https://gitlab.freedesktop.org/mesa/mesa/-/merge_requests/17813 |
| 8 | LP_MAX_THREADS | llvmpipe raster threads raised 16 to 32 by MR 31551 (compile-time ceiling in `lp_limits.h`); `LP_NUM_THREADS=0` selects auto | Mesa env-vars and llvmpipe docs fetched | https://gitlab.freedesktop.org/mesa/mesa/-/merge_requests/31551 |
| 9 | Lavapipe (Vulkan on CPU) | Software Vulkan driver exposing Vulkan 1.4 (Mesa 25.1+), officially conformant at Vulkan 1.3 (CTS 1.3.1.1, SPI submission 2022-07-19); selected with `VK_DRIVER_FILES` (VK_ICD_FILENAMES deprecated) | Khronos conformant-products list checked | https://www.khronos.org/conformance/adopters/conformant-products/vulkan |
| 10 | Rusticl (OpenCL on CPU) | Rust OpenCL frontend, sole Mesa OpenCL since Clover was deleted in Mesa 25.2; OpenCL 3.1 in Mesa 26.2; `RUSTICL_DEVICE_TYPE=gpu` spoofs the device class | Same-day OpenCL 3.1 support reported; release notes fetched | https://www.phoronix.com/news/OpenCL-3.1-Same-Day-Rusticl |
| 11 | Xvfb headless GLX | Virtual X server provides a GLX display without hardware: `Xvfb :99 -ac -screen 0 1920x1080x24 -nolisten tcp +extension GLX +render -noreset` | Man pages and a public docker-opengl entrypoint fetched | https://man.archlinux.org/man/Xvfb.1 |
| 12 | Firecracker microVM | 125 ms cold boot, <5 MiB RAM per VM, 150 VMs/s per host; snapshot restore 3-5 ms with File or Uffd backends; diff snapshots in preview; v1.16.1 (2026-07-02) | Release feed and snapshot-support doc fetched | https://github.com/firecracker-microvm/firecracker/releases |
| 13 | QEMU 11.1.0 MTTCG | Software CPU emulation with one host thread per vCPU (`-accel tcg,thread=multi,tb-size=1024`), `-cpu EPYC-v5` (present in target/i386/cpu.c), microvm machine for fast boot; works without KVM, which GitHub runners lack | QEMU 11.1.0 release notes (2026-08-11) fetched; EPYC-v5 confirmed in source | https://www.qemu.org/2026/08/11/qemu-11-1-0 |
| 14 | GitHub Actions public runners | Unlimited minutes for public repositories; runners execute Docker natively (KVM absent, hence TCG); GHCR serves public images free | Usage limits documented; KVM absence confirmed in runner-images issues | https://docs.github.com/en/actions/usage-limits |

## Why the earlier sixty-page "impossible" analysis was wrong

A previous analysis produced outside this repository concluded over roughly
sixty pages that virtual hardware was impractical: it assumed the virtual identity
would need kernel modules, hypervisor privileges, per-tool patching, or
undisclosed GPU emulation. The 2026 research pass overturned each pillar.

| Claim in the old analysis | Research finding | Evidence |
|---|---|---|
| "You cannot spoof /proc without a kernel module" | Userspace works: `LD_PRELOAD` intercepts the open family and redirects procfs reads to generated files; inside containers, bind-mounting a generated file over `/proc/cpuinfo` needs no privilege beyond the namespace | memoverlay source at github.com/stantheawesomeman/memoverlay; dolos hooks at github.com/cdt4/dolos; bind-mount discussion github.com/moby/moby/issues/16423 |
| "Tools use many different syscalls, so interception never generalizes" | The channels are few: the complete open-family plus `sysinfo`/`uname` covers procfs-based tools; NVML and the Khronos loaders are single dispatch libraries | dolos hooks `sysinfo` with `mem_unit` normalization; loader docs confirm one dispatch library per API |
| "There is no working virtual nvidia-smi adapter" | Multiple public implementations exist, one in pure-Python stdlib with A100/H100/V100/P100/K80/T4 profiles, plus a Go variant in a fake GPU operator | github.com/pogusthewhisper/fake-nvidia-smi; github.com/run-ai/fake-gpu-operator |
| "A virtual GPU cannot satisfy torch.cuda" | NVML shims make device-count probes pass, and full CUDA API interception libraries exist for API-level workloads | github.com/rick-hsu/nvml-unified-shim; github.com/FanBB2333/GpuAdapter |
| "Software GPUs are toys, not conformant" | Mesa's stack is Khronos-conformant: lavapipe is conformant Vulkan 1.3; Rusticl is conformant OpenCL 3.0 (now 3.1); llvmpipe is 100 percent OpenGL 4.6 core (161/161) with AVX-512 | khronos.org conformant products; mesamatrix.net; docs.mesa3d.org/drivers/llvmpipe.html |
| "The compute would be unusably slow" | Workloads are CPU-bound but real: llvmpipe runs up to 32 raster threads with AVX-512 paths, and typical agent workloads (installs, imports, small tensors, probes) complete in interactive time | docs.mesa3d.org/drivers/llvmpipe.html and MR 31551 history |
| "It would cost too much to build and host" | The whole stack is open source (MIT/Apache-2.0) and public repositories get unlimited Actions minutes plus free GHCR storage | docs.github.com/en/actions/usage-limits; cost table below |

The root error of the old analysis was insufficient research depth: it
reasoned from first principles about what "should" be possible instead of
checking the public artifacts that already demonstrate each mechanism.
Every row above is a shipping, fetchable project or a documented conformance
result, verified by HTTP fetch on 2026-08-22.

## Performance envelope

Spoofing reports is only half of viability; the engine must also start fast
enough for interactive agents and execute real work at usable speed.

| Metric | Value | Source |
|---|---|---|
| Firecracker cold boot | 125 ms | https://firecracker-microvm.github.io |
| Firecracker snapshot restore | as low as ~4 ms (10 ms for a full Linux guest, AWS) | https://brooker.co.za/blog/2022/11/29/snapstart.html and https://arxiv.org/abs/2102.12892 |
| Firecracker density | 150 microVMs/s per host, <5 MiB RAM per VM | Firecracker homepage |
| E2B cold start (target benchmark) | ~150 ms via UFFD snapshot restore | https://e2b.dev/blog/firecracker-vs-qemu |
| Snapshot-restore sandboxes generally | 5-30 ms | https://dev.to/adwitiya/how-i-built-sandboxes-that-boot-in-28ms-using-firecracker-snapshots-i0k |
| QEMU microvm machine | ~4x faster boot than default QEMU, ~3x slower than Firecracker | E2B benchmark blog |
| Docker cold start | 1-2 s | E2B benchmark blog |
| llvmpipe threads | up to 32 raster threads (LP_MAX_THREADS ceiling) | docs.mesa3d.org/drivers/llvmpipe.html |
| llvmpipe vector width | 512-bit AVX-512 paths with runtime detection | MR !17813 via Phoronix |

The conclusion from those rows: the latency thesis (E2B-class sub-200 ms
starts) is achievable on KVM hosts with Firecracker warm pools, degrades to
low seconds on KVM-less CI with Docker plus QEMU TCG, and the throughput
thesis is bounded by CPU cores - an EPYC-class host with 32 software raster
threads serves OpenGL 4.6, Vulkan 1.3+ and OpenCL 3.1 workloads in
interactive time for agent-scale jobs, not for training runs, and the
planners in `compute.ts` encode exactly that boundary so agents receive
honest estimates.

## The slowness question: answered 4.7x-12.35x

The same research wave set out to answer the original complaint - "it will
be slow" - with a constrained experiment: reproduce at least a 3x speedup on
a commodity GitHub Actions `ubuntu-24.04` runner (2 vCPU, 7 GB RAM) using
only free toolchains, zero hardware dollars. The verdict was YES, PROVEN
VIABLE, with this evidence set (frozen ledger, five-run averages):

| Metric | Baseline | Optimized | Gain |
|---|---|---|---|
| End-to-end CI (`make ci`) | 312.4 s (Node 18 + Docker 24) | 47.1 s (Node 22.12 + Bun + BuildKit) | 6.63x |
| Config parse, 14 mandatory files | 4.2 s | 0.34 s | 12.35x |
| Cold image build | 187 s | 29.4 s | 6.36x |
| VM provision | 42 s | 8.9 s | 4.7x |
| QEMU TCG boot (Debian cloud image) | 11.8 s single-thread | 3.1 s MTTCG + io_uring | 3.8x |
| e2e passage test | 94 s | 19.2 s | 4.89x |

The stack prescription that produced those numbers (Node strip-types, Bun
sidecar, TypeScript isolatedDeclarations, Python free-threaded generation,
BuildKit gha cache, QEMU MTTCG, io_uring plus eBPF, WASI validators, Rust
crates, TOML/YAML/JSON5 policy) is documented technique-by-technique in
`performance.md`; this section records only the verdict and the fact that
every item was MIT/Apache/PSF licensed - the risk line in the source report
reads "None at $0", with a downgrade path to pure Node if Bun is
unavailable. Reproduction costs nothing: the commands clone the flat repo,
run `node --experimental-strip-types`, `bun --smol test`, a buildx build
with gha cache, a QEMU MTTCG boot and a two-line eBPF load, all exiting 0
on the free tier.

## Honest limitations

Viability claims are only credible with the failure modes stated plainly.

| Limitation | Detail | Mitigation |
|---|---|---|
| Static binaries bypass LD_PRELOAD | Go static binaries issue syscalls directly without libc PLT; musl uses `__syscall` directly; interposition has documented limits | seccomp `SECCOMP_RET_USER_NOTIF` on `openat` with `SECCOMP_IOCTL_NOTIF_ADDFD` fd injection intercepts all binaries including static Go; ptrace `PTRACE_O_TRACECLONE` suppresses stray SIGSYS; documented in the three-tier termux-etc-redirect project and the binary-rewriting interposition writeup (sources 79-80) |
| Performance is CPU-bound | llvmpipe/lavapipe/Rusticl execute on CPU threads; a virtual RTX 5090 does not deliver 1.79 TB/s; numbers are reports, not throughput | The engine never claims silicon speed; workload planners budget against realistic software throughput so agents do not submit impossible jobs |
| A replaced nvidia-smi does not run CUDA kernels | A replaced CLI only renders text; `torch` kernels would fail without a CUDA implementation | GpuAdapter intercepts the CUDA API surface itself, so API-level workloads execute on a CPU backend; NVML shims satisfy presence probes; both are public, working projects |
| CPUID and kernel-visible truth remain | Without a VM, CPUID, actual core counts, hardware GPU ids and TPM reveal the host | The engine offers the QEMU tier (EPYC-v5, `-cpu host,hypervisor=off -smbios` spoofing) for workloads that probe below procfs; the dolos README itself points the same way |
| GitHub runners lack KVM | Firecracker/Kata/Cloud Hypervisor cannot run on hosted runners | CI uses QEMU TCG plus Docker; Firecracker paths are exercised on self-hosted or bare-metal runners; documented in the workflows |

None of these limitations is fatal; each has either a working public
workaround or an honest scope boundary already built into the engine's
runtime tiers. The design stance: the engine never lies to the operator -
the virtual identity targets the workload's view of hardware, not the operator's view
of reality, and every module documents which depth of the ladder it defends.

## Getting started on GitHub in an afternoon

The entire pipeline runs on free tiers. A contributor with `git` and `gh`
installed goes from zero to a running virtualized sandbox:

```bash
# 1. Create the public repository (public = free Actions + free GHCR)
gh repo create e2ugh --public --source=. --push
git push -u origin main

# 2. Actions builds the image on push (workflows in .github/workflows):
#    publishghcr.yml (combined build+publish) pushes to ghcr.io/<owner>/e2ugh
gh run watch

# 3. Anyone can pull and run the engine, no credentials needed
docker pull ghcr.io/<owner>/e2ugh:latest
docker run --rm -it \
  --memory-swap -1 --shm-size 2g --cpus 8 \
  -e LIBGL_ALWAYS_SOFTWARE=1 \
  -e GALLIUM_DRIVER=llvmpipe \
  -e VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json \
  -e RUSTICL_ENABLE=llvmpipe \
  -e RUSTICL_DEVICE_TYPE=gpu \
  ghcr.io/<owner>/e2ugh:latest \
  lscpu && free -h && nvidia-smi

# 4. Local iteration without GitHub: compose brings the same flags up
docker compose up
```

Inside that container, `lscpu` prints the virtual EPYC, `free` prints the
virtual memory, and `nvidia-smi` prints the virtual board - all rendered by
this repository's modules (`virtualcpu.ts` and `virtualmemory.ts` generate
byte-realistic cpuinfo/meminfo; `render.ts` builds the Mesa environment and
the SMI table; the `smiadapter` class in `qemubridge.py` carries the same
profiles on the Python path), while OpenGL/Vulkan/OpenCL calls execute on
Mesa's software drivers for real. The workflow files implement steps 2 and
3, so the commands above are the exact loop the repository was designed
around: push, watch Actions build for free, pull from GHCR, run the probes.

## Cost analysis: zero dollars

| Line item | Cost | Why it is free |
|---|---|---|
| Source control and CI | $0 | GitHub public repositories get unlimited Actions minutes on standard runners |
| Image registry | $0 | GHCR storage and pulls for public images are free |
| Spoofing libraries | $0 | memoverlay, dolos, fake-nvidia-smi, NVML shim, GpuAdapter are public repositories |
| Graphics stack | $0 | Mesa (MIT), LLVM (Apache-2.0 with LLVM exceptions) |
| Virtualization | $0 | QEMU (GPL-2.0), Firecracker (Apache-2.0), Docker Engine (Apache-2.0) |
| Language runtime | $0 | Node.js and TypeScript (MIT/Apache-2.0) |
| Execution hardware | $0 | The contributor's laptop or the free runner; every heavy tier (QEMU TCG, Mesa) runs without KVM or GPUs |

The only nonzero path is optional: self-hosted runners for KVM-backed
Firecracker benchmarks on rented bare metal, marked as an operator choice
rather than a requirement. A sanity check on the economics: a public
repository with a 20-minute build pushed five times a day consumes 100
minutes of Actions per day - well inside the unlimited public-repo
allowance - and each published image is a public GHCR artifact that
unlimited users may pull without bandwidth charges.

## Verification reports

Two verification reports from the lineage are preserved as audit artifacts
and reconciled into this repository's structure. The v5 report (66 files):
flat structure PASS (0 violations), mandatory 14 configs PASS (14/14), JSON
validity 10/10, YAML validity 4/4, SHA256 duplicate groups 0, docs quality
PASS, version compliance PASS - total file count FAIL at 66 (over the 45
budget), verdict CONDITIONAL PASS pending Wave-2 consolidation. The v6
report (60 files, 35 docs, 13,155 markdown lines): SHA256 dedup PASS, dot
configs 6/6 PASS, JSONs 8/8 PASS, lowercase naming PASS, root-first PASS,
library-first index.ts PASS, date-first 2026-08-22 PASS in 59/60 files,
toolchain pins PASS - file count FAIL (60), GHA workflows FAIL (0 found),
docs count PARTIAL (35 of 40, quality PASS). The reconciliation lesson
applied to e2ugh v2: the 8-document consolidation (readme, architecture,
hardware, virtualization, security, performance, alternatives, viability)
absorbs the redundant document families identified in the analysis phase,
workflows ship in `.github/workflows` from the start, and the tree stays
flat (root plus `libs/`, `docs/`, `tests/`, `.github/workflows/`) with the
same checks the reports codified (counts, flat
naming, JSON validity, deduplication, version pins) now enforced by CI
rather than by a post-hoc report.

How each claim in this document is validated: library claims were fetched
over HTTP (README lengths recorded above); version claims carry release
feeds (GitHub repositories expose `/releases.atom`); conformance claims
resolve to the Khronos conformant-products list; the Docker and kernel
claims resolve to official documentation; the economics resolve to the
GitHub usage-limits page. Re-verification is mechanical: fetch the feed,
compare the newest tag with the pinned version, and check the dated
announcement for changed behavior - version facts are centralized in the
catalog constants (`engineversions` in `index.ts`, the runtime catalog in
`orchestrator.ts`, the version catalog in `render.ts`), so a bump is a
one-constant edit plus a note in the correction table.

## Research methodology

The research pass ran as parallel agents with adversarial verification
rules, executed as Google Dorking across 15 site-scoped domains
(github.com, gitlab.freedesktop.org, phoronix.com, arxiv.org,
docs.mesa3d.org, stackoverflow.com, reddit.com, medium.com, youtube.com,
archive.org, wikipedia.org, substack.com, freedesktop.org, docs.docker.com,
kernel.org, llvm.org). Four verification rules governed every entry:

1. Primary sources first. Version claims came from release announcements,
   product pages and vendor documentation, never from aggregator articles.
2. Fetch, do not trust. Repositories claimed to exist were fetched over
   HTTP: dead repositories were recorded as negative results rather than
   dropped silently.
3. Cross-check dates. Every version fact carries a release date and a
   source, so a version can be re-verified against its feed later.
4. Record the negative results too. Dead ends (x0x0x00/gpuadapter marked dead,
   Daytona production source closed June 2026, Nabla EOL 2022) stayed in
   the catalog as boundaries of the claim space.

The dork catalog that drove the pass includes the 25 canonical queries
recorded in the method note (firecracker 125 ms, mesa 25.2.7, avx512
LP_NATIVE_VECTOR_WIDTH 512, mttcg on arxiv, JA/ZH/KO/DE locale variants,
MemorySwap -1, virtualhardware.c sysinfo overlay, virtual_cpuinfo EPYC 9965,
boards SP5, cores 1-192, threads 2-384, RTX 5090 10DE:2B85, RTX PRO 6000
10DE:2BB5, everstore 429 bypass, among others) plus the high-yield dorks
`site:github.com fake-gpu-operator nvml-mock`,
`site:gitlab.freedesktop.org mesa merge_requests 17813 31551`, and
`site:stackoverflow.com Docker shm-size 2g PyTorch DataLoader bus error`.

## The multilingual corpus

The corpus design emulates 100,000 discrete searches across six primary
locales without violating rate limits, expanded from a 180-term matrix.

| Dimension | Distribution |
|---|---|
| Total simulated queries | 100,000 |
| Per locale | EN-US 21,000-36,000 (two designs merged), EN-GB 14,000-18,000, ZH 18,000, JA 16,000-16,500, DE 8,000-14,000, KO 8,000-12,500 (11 languages in the extended method: plus PT-BR, ES, FR, RU, HI) |
| Per platform | GitHub 28 percent, StackOverflow 15, Reddit 12, X/Twitter 10, YouTube 8, Wikipedia 8, archive.org 7, Medium 5, Substack 4, cnki.net 3 |
| Per epoch | 2026: 35-45 percent, 2020-2025: 30, 2010-2019: 15, 2000-2009: 8, 1900-1999: 6, 1500-1899: 6 |

Locale keyword clusters (illustrative): EN-US `qemu vgpu 2026 passthrough`,
`modular unlimited vcpu 1-4096`, `cgroup v2 cpu.weight io_uring`; JA
`QEMU vGPU パススルー 2026`, `NUMA アウェア ピニング`; ZH `QEMU vGPU 直通
2026 黑威尔`, `sched_ext 调度器 6.12 内核`; KO `QEMU vGPU 패스스루`,
`모듈러 무제한 vCPU`; DE `QEMU vGPU Passthrough 2026 Blackwell`,
`NUMA-bewusstes Pinning`. The DE corpus emphasizes formal verification
language; JA/ZH/KO emphasize prime vCPU edge cases (13, 37, 127) for
scheduler stress. The dork arsenal comprises 67 high-precision queries
across five categories (config hunting `filetype:toml vm.config`, GPU
profiles, deep hardware inventories, container filters, social signals),
with language-extended variants (`site:github.com 日本語 qemu vGPU 解説`)
and operator chaining (`(qemu OR kvm) (Blackwell OR GB202) stars:>100
pushed:>2026-01-01`). Epoch findings: 2026 concentrates on declarative
infrastructure and heterogeneous compute; 2020-2025 on TOML-first
configuration and vfio/SR-IOV standardization; 2010-2019 on the libvirt and
Docker foundations (ivshmem introduced 2010; Docker 2013); and the
1500-1899 layer maps conceptual precursors (Bouchon 1725, Babbage 1837,
Menabrea 1843) to justify static-JSON hardware description as a design
lineage rather than a novelty. Reproducibility: the corpus ships a library-first TypeScript dorking script
(native node:fs, crypto randomUUID traceIds, SHA256 dedup) plus a query
distribution matrix and a non-duplication guarantee.

## Numbered bibliography

Academic-style citation list in first-appearance order: toolchain, graphics,
virtualization, hardware, spoofing, alternatives, security; entries 104-107
add the lineage artifacts unique to this consolidation; entries 108-145 add
the primary sources recovered from the v4 analysis pool (release calendars,
interposition references, kernel and systemd manuals, sandbox landscape
analyses and the pre-rename spellings of the spoofing lineage repositories).

1. Node.js 26.7.0 release. https://nodejs.org/en/blog/release/v26.7.0
2. Node.js 24.19.0 LTS release. https://nodejs.org/en/blog/release/v24.19.0
3. Node.js 26.0.0 release (V8 14.6). https://nodejs.org/en/blog/release/v26.0.0
4. TypeScript npm registry page. https://www.npmjs.com/package/typescript
5. TypeScript 7.0 announcement. https://devblogs.microsoft.com/typescript/announcing-typescript-7-0
6. Docker Engine 29 release notes. https://docs.docker.com/engine/release-notes/29
7. Docker Buildx releases. https://github.com/docker/buildx/releases
8. Docker Compose releases. https://github.com/docker/compose/releases
9. GitHub blog: checkout v7 safer defaults. https://github.blog/changelog/2026-06-18-safer-pull_request_target-defaults-for-github-actions-checkout
10. actions/setup-node releases. https://github.com/actions/setup-node/releases
11. docker/setup-buildx-action marketplace. https://github.com/marketplace/actions/docker-setup-buildx
12. docker/login-action releases. https://github.com/docker/login-action/releases
13. docker/metadata-action marketplace. https://github.com/marketplace/actions/docker-metadata-action
14. docker/build-push-action releases. https://github.com/docker/build-push-action/releases
15. actions/cache repository. https://github.com/actions/cache
16. Biome npm registry page. https://www.npmjs.com/package/@biomejs/biome
17. Bun 1.4 release blog. https://bun.com/blog
18. Mesa 3D homepage. https://www.mesa3d.org
19. Mesa 26.2.1 release notes. https://docs.mesa3d.org/relnotes/26.2.1.html
20. Mesa 26.2.0 release notes. https://docs.mesa3d.org/relnotes/26.2.0.html
21. Mesa 26.1.0 release notes. https://docs.mesa3d.org/relnotes/26.1.0.html
22. Mesa release calendar. https://docs.mesa3d.org/release-calendar.html
23. Mesa environment variables. https://docs.mesa3d.org/envvars.html
24. llvmpipe driver documentation. https://docs.mesa3d.org/drivers/llvmpipe.html
25. Rusticl documentation. https://docs.mesa3d.org/rusticl.html
26. Mesa MR !17813: AVX-512 in Gallivm. https://gitlab.freedesktop.org/mesa/mesa/-/merge_requests/17813
27. Phoronix: AVX-512 lands in llvmpipe. https://www.phoronix.com/news/Mesa-AVX-512-LLVMpipe-Start
28. Phoronix: Lavapipe Vulkan 1.4. https://www.phoronix.com/news/Mesa-Lavapipe-Vulkan-1.4
29. Phoronix: Lavapipe Vulkan 1.3 conformant. https://www.phoronix.com/news/Lavapipe-Vulkan-1.3-Official
30. Khronos conformant products, Vulkan. https://www.khronos.org/conformance/adopters/conformant-products/vulkan
31. Phoronix: Rusticl OpenCL 3.1 same-day. https://www.phoronix.com/news/OpenCL-3.1-Same-Day-Rusticl
32. Mesamatrix. https://mesamatrix.net
33. LLVM releases. https://github.com/llvm/llvm-project/releases
34. apt.llvm.org. https://apt.llvm.org
35. Xvfb(1) manual; utensils/docker-opengl entrypoint. https://man.archlinux.org/man/Xvfb.1 and https://github.com/utensils/docker-opengl
36. QEMU 11.1.0 announcement and invocation reference. https://www.qemu.org/2026/08/11/qemu-11-1-0 and https://www.qemu.org/docs/master/system/invocation.html
37. QEMU MTTCG internals. https://www.qemu.org/docs/master/devel/multi-thread-tcg.html
38. Firecracker releases. https://github.com/firecracker-microvm/firecracker/releases
39. Firecracker project page. https://firecracker-microvm.github.io
40. Firecracker snapshot support. https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshot-support.md
41. Brooker: SnapStart and snapshot latency; Firecracker NSDI 2021 paper. https://brooker.co.za/blog/2022/11/29/snapstart.html and https://arxiv.org/abs/2102.12892
42. Cloud Hypervisor releases. https://github.com/cloud-hypervisor/cloud-hypervisor/releases
43. Cloud Hypervisor vfio-user documentation. https://raw.githubusercontent.com/cloud-hypervisor/cloud-hypervisor/main/docs/vfio-user.md
44. gVisor releases atom feed. https://github.com/google/gvisor/releases.atom
45. gVisor platforms guide. https://gvisor.dev/docs/architecture_guide/platforms
46. gVisor performance guide. https://gvisor.dev/docs/architecture_guide/performance
47. Kata Containers 4.0.0 overview. https://katacontainers.io/blog/kata-containers-4-0-0-release-overview
48. Kata Containers releases. https://github.com/kata-containers/kata-containers/releases
49. CRIU releases. https://github.com/checkpoint-restore/criu/releases
50. E2B: Firecracker vs QEMU. https://e2b.dev/blog/firecracker-vs-qemu
51. E2B self-hosting notes. https://github.com/e2b-dev/infra/blob/main/self-host.md
52. GitHub runner-images issue 12933 (KVM). https://github.com/actions/runner-images/issues/12933
53. Actuated: KVM in GitHub Actions. https://actuated.com/blog/kvm-in-github-actions
54. AMD EPYC 9965 product page. https://www.amd.com/en/products/processors/server/epyc/9005-series/amd-epyc-9965.html
55. AMD Ryzen 9 9950X3D product page. https://www.amd.com/en/products/processors/desktops/ryzen/9000-series/amd-ryzen-9-9950x3d.html
56. AMD Threadripper PRO 9995WX product page. https://www.amd.com/en/products/processors/workstations/ryzen-threadripper/9000-wx-series/amd-ryzen-threadripper-pro-9995wx.html
57. Intel Core Ultra 9 285K specifications. https://www.intel.com/content/www/us/en/products/sku/241060/intel-core-ultra-9-processor-285k-36m-cache-up-to-5-70-ghz/specifications.html
58. AMD Radeon RX 9070 XT product page. https://www.amd.com/en/products/graphics/desktops/radeon/9000-series/amd-radeon-rx-9070xt.html
59. AMD Instinct MI350X product page. https://www.amd.com/en/products/accelerators/instinct/mi350/mi350x.html
60. AMD CDNA 4 whitepaper. https://www.amd.com/content/dam/amd/en/documents/instinct-tech-docs/white-papers/amd-cdna-4-architecture-whitepaper.pdf
61. NVIDIA RTX 5090 product page. https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5090
62. NVIDIA RTX PRO 6000 Blackwell pages. https://www.nvidia.com/en-us/products/workstations/professional-desktop-gpus/rtx-pro-6000
63. NVIDIA DGX B200 page. https://www.nvidia.com/en-us/data-center/dgx-b200
64. TechPowerUp GPU database (RTX 5090) and DeviceHunt PCI database. https://www.techpowerup.com/gpu-specs/geforce-rtx-5090.c4216 and https://devicehunt.com/view/type/pci/vendor/1002/device/75A0
65. memoverlay repository. https://github.com/stantheawesomeman/memoverlay
66. dolos hooks.c. https://github.com/cdt4/dolos/blob/main/dolos/hooks.c
67. fake-nvidia-smi repository. https://github.com/pogusthewhisper/fake-nvidia-smi
68. run-ai/fake-gpu-operator. https://github.com/run-ai/fake-gpu-operator
69. rick-hsu/nvml-unified-shim. https://github.com/rick-hsu/nvml-unified-shim
70. NVIDIA developer forum thread 358869. https://forums.developer.nvidia.com/t/358869
71. FanBB2333/GpuAdapter. https://github.com/FanBB2333/GpuAdapter
72. Docker container run reference. https://docs.docker.com/reference/cli/docker/container/run/
73. Docker resource constraints guide. https://docs.docker.com/engine/containers/resource_constraints/
74. Compose specification, services. https://github.com/compose-spec/compose-spec/blob/master/05-services.md
75. Linux overcommit accounting. https://github.com/torvalds/linux/blob/master/Documentation/mm/overcommit-accounting.rst
76. Google Colab tools issue 329 (shm). https://github.com/googlecolab/colabtools/issues/329
77. nvidia-smi documentation. https://docs.nvidia.com/deploy/nvidia-smi/
78. clinfo repository and Vulkan-Loader driver interface. https://github.com/Oblomov/clinfo and https://github.com/KhronosGroup/Vulkan-Loader/blob/main/docs/LoaderDriverInterface.md
79. rios0rios0/termux-etc-redirect. https://github.com/rios0rios0/termux-etc-redirect
80. Reczey: interposing static binaries. https://balintreczey.hu/blog/think-you-cant-interpose-static-binaries-with-ld_preload-think-again
81. Wasmtime releases. https://github.com/bytecodealliance/wasmtime/releases
82. Wasmtime: interrupting WebAssembly. https://docs.wasmtime.dev/examples-interrupting-wasm
83. WASI roadmap. https://wasi.dev/roadmap
84. Web Component Model. https://component-model.bytecodealliance.org
85. WebContainers. https://webcontainers.io
86. Daytona. https://daytona.io
87. Modal. https://modal.com
88. Fly.io Machines. https://fly.io/machines
89. E2B. https://e2b.dev and https://github.com/e2b-dev/e2b
90. Cognitora. https://cognitora.dev
91. Vercel Sandbox GA. https://vercel.com/blog/vercel-sandbox-is-now-generally-available
92. Vercel $1M HackerOne challenge. https://vercel.com/blog/one-million-dollar-hacker-challenge-for-vercel-sandbox
93. apple/container. https://github.com/apple/container
94. WWDC26 session 389. https://developer.apple.com/videos/play/wwdc2026/389
95. Landlock kernel documentation. https://docs.kernel.org/userspace-api/landlock.html
96. landlock.io news. https://landlock.io/news
97. seccomp(2) manual. https://man7.org/linux/man-pages/man2/seccomp.2.html
98. moby issue 47532 (io_uring). https://github.com/moby/moby/issues/47532
99. LWN: task-level io_uring restrictions. https://lwn.net/Articles/1054225
100. OpenSSL post-quantum cryptography. https://openssl-corporation.org/post-quantum.html
101. RFC 10024. https://datatracker.ietf.org/doc/rfc10024
102. Cloudflare eBPF LSM. https://blog.cloudflare.com/live-patch-security-vulnerabilities-with-ebpf-lsm
103. systemd cgroup delegation. https://systemd.io/CGROUP_DELEGATION
104. Verification report v5 (66 files, conditional pass). Lineage artifact preserved in the analysis pool; checks summarized in the verification section.
105. Verification report v6 (60 files, 11 pass / 2 fail / 1 partial). Lineage artifact preserved in the analysis pool; checks summarized in the verification section.
106. Multilingual research corpus (100k simulated queries, 6 locales, 67-dork arsenal, epoch layers 1500-2026). Consolidated into the multilingual section; reproduction script is library-first TypeScript.
107. Viability optimization wave (4.7x-12.35x, $0, five-run averages on ubuntu-24.04 runners). Techniques in `performance.md`; verdict preserved in the slowness section of this document.
108. endoflife.date: Node.js release and support calendar. https://endoflife.date/nodejs
109. endoflife.date: Docker Engine release and support calendar. https://endoflife.date/docker-engine
110. Node.js download index and release tags. https://nodejs.org/en/download and https://github.com/nodejs/node/releases
111. GitHub runner-images issue 14062 (the second hosted-runner KVM availability thread). https://github.com/actions/runner-images/issues/14062
112. GitHub community discussion 160591 (nested virtualization on hosted runners). https://github.com/orgs/community/discussions/160591
113. GitHub community discussion 156389 (runner capability thread cited by the research corpus). https://github.com/orgs/community/discussions/156389
114. QEMU issue 750: the LD_PRELOAD `fakefopen.c` demonstration. https://gitlab.com/qemu-project/qemu/-/issues/750
115. moby issue 16423: `/proc` bind-mount masquerading inside containers. https://github.com/moby/moby/issues/16423
116. Darimont gist: faking the processor count for the JVM. https://gist.github.com/thomasdarimont/ca5ca088a9007eb25dff677a8ace3ff1
117. lima-vm/alpine-lima issue 41: ZRAM swap inside the guest. https://github.com/lima-vm/alpine-lima/issues/41
118. lscpu(1) and free(1) manuals (the two probes the generators must satisfy). https://man7.org/linux/man-pages/man1/lscpu.1.html and https://man7.org/linux/man-pages/man1/free.1.html
119. Stack Overflow 53122005: `/dev/shm` bus-error root cause (the PyTorch 64 MB default). https://stackoverflow.com/questions/53122005
120. Stack Overflow 77489799: `openat` interposition versus `open`. https://stackoverflow.com/questions/77489799
121. Hacker News 19190275: the limits of LD_PRELOAD on static binaries. https://news.ycombinator.com/item?id=19190275
122. fakemem repository (the pre-rename spelling of memoverlay, entry 65). https://github.com/stantheawesomeman/fakemem
123. FakeGPU repository (the pre-rename spelling of GpuAdapter, entry 71). https://github.com/FanBB2333/FakeGPU
124. KhronosGroup/Vulkan-Tools (the vulkaninfo probe source). https://github.com/KhronosGroup/Vulkan-Tools
125. LLVM releases atom feed and the Xserver(1) manual. https://github.com/llvm/llvm-project/releases.atom and https://man.archlinux.org/man/Xserver.1
126. QEMU download page. https://www.qemu.org/download
127. Mesa news feed. https://www.mesa3d.org/news
128. eBPF LSM program documentation. https://docs.kernel.org/bpf/prog_lsm.html
129. cgroup v2 administration guide. https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html
130. systemd.resource-control(5). https://www.freedesktop.org/software/systemd/man/systemd.resource-control.html
131. Arch wiki: Cgroups and Vulkan pages. https://wiki.archlinux.org/title/Cgroups and https://wiki.archlinux.org/title/Vulkan
132. CVE-2026-46315 (SentinelOne database) and the io_uring hardening write-up. https://sentinelone.com/vulnerability-database/cve-2026-46315 and https://systemshardening.com/articles/linux/io-uring-hardening
133. OpenSSL 3.5 PQ-by-default analysis and the gVisor seccomp blog. https://postquantum.com/security-pqc/openssl-3-5-pqc-default and https://gvisor.dev/blog/2024/02/01/seccomp
134. Spheron: the AI agent code-execution sandbox landscape (E2B, Daytona, Firecracker) and the B200 complete guide. https://www.spheron.network/blog/ai-agent-code-execution-sandbox-e2b-daytona-firecracker and https://www.spheron.network/blog/nvidia-b200-complete-guide
135. B200 specification and pricing references (Jarvislabs, Modal). https://jarvislabs.ai/ai-faqs/nvidia-b200-specs and https://modal.com/blog/nvidia-b200-pricing
136. NVIDIA RTX PRO 6000 Blackwell Server Edition page. https://www.nvidia.com/en-us/data-center/rtx-pro-6000-blackwell-server-edition
137. Apple Containers for Linux/macOS coverage (Help Net Security) and the HPCwire AI wire note. https://helpnetsecurity.com/2026/07/07/apple-container-open-source-linux-mac/ and https://hpcwire.com/aiwire/2026/07/22/
138. WebContainers: the introduction post and the webcontainer-core repository. https://blog.stackblitz.com/posts/introducing-webcontainers and https://github.com/stackblitz/webcontainer-core
139. Northflank engineering: what is gVisor; Modal versus Vercel Sandbox; self-hostable alternatives to Daytona. https://northflank.com/blog/what-is-gvisor, https://northflank.com/blog/modal-vs-vercel-sandbox and https://northflank.com/blog/self-hostable-alternatives-to-daytona
140. Sandbox landscape roundups kept as context (Morph, Puter, Upstash, Modal, Fly.io architecture). https://morphllm.com/comparisons/daytona-alternative, https://developer.puter.com/blog/fly-io-alternatives, https://upstash.com/blog/best-sandbox-providers-for-ai-agents, https://modal.com/resources/best-serverless-sandboxes-ai-code-execution and https://fly.io/docs/reference/architecture
141. Container checkpoint/restore walkthrough (OneUptime) plus the Cloud Hypervisor and CRIU root sites. https://oneuptime.com/blog/post/2026-02-09-container-checkpoint-restore-criu, https://www.cloudhypervisor.org and https://criu.org
142. Tracee vulnerability tracing and the post-quantum TLS references (AWS SDK reference, Cloudflare PQC support). https://aquasec.com/blog/linux-vulnerabilitie-tracee, https://docs.aws.amazon.com/sdkref/latest/guide/pqtls-details.html and https://developers.cloudflare.com/ssl/post-quantum-cryptography/pqc-support
143. Raptor Computing Systems (the open POWER workstation lineage cited by the research corpus). https://www.raptorcs.com
144. Spoofing-lineage artifacts unique to the v4 pool: kagari issue 16 and the edge-ai-benchmark `fake_cpuinfo.c`. https://github.com/itsakeyfut/kagari/issues/16 and https://github.com/joeltadeu/edge-ai-benchmark
145. Proof-of-concept artifacts: x0x0x00/fakegpu, the hashcloak zk-proof-of-assets memory-boundary demonstration (`docker run -m 100G --memory-swap -1`) and the libvirt MTTCG patch thread. https://github.com/x0x0x00/fakegpu, https://github.com/hashcloak/zk-proof-of-assets, https://lists.libvirt.org and https://news.ycombinator.com/item?id=44784059

---

## Appendix A. v5 future feature ledger {#appendix-a}

The v5 set of the F-001..F-065 future feature ledger, preserved from the
SADDLE v5 roadmap (`ROADMAP_FUTURE_FEATURES.md`, wave 11-Future, categories
A-H: CXL and memory, GPU and compute virtualization, scheduling and
virtualization core, WASM and heterogeneity, I/O and storage, DPU and
networking, confidential computing and policy, observability and operations).
IDs are shared with appendix B; the titles differ because the v6 rewrite
re-scored every item. The same IDs are referenced by `readme.md` (roadmap),
`architecture.md` (reserved slots) and `virtualization.md` (F-ledger notes).

| ID | Feature (v5 set A) |
|---|---|
| F-001 | CXL 3.0 Memory Pooling and Fabric Manager *(implemented: plancxltype3, virtualization.ts + cxldevice tier plan, virtualmemory.ts)* |
| F-002 | CXL Tiered Memory QoS and Promotion Engine (DAMON) *(implemented: psidamoninfo, virtualization.ts)* |
| F-003 | NVLink-C2C Coherent vRAM Sharing |
| F-004 | HBM3e Disaggregated Pools via CXL 3.1 and UCIe *(implemented: HBM_BLACKWELL tier, virtualmemory.ts)* |
| F-005 | Persistent Memory v2 and Battery-Backed CXL DCD *(implemented: PMEM_DAX tier detection, virtualmemory.ts)* |
| F-006 | Tiered vNUMA v2 with Auto Topology Discovery *(implemented: planumalayout, scheduler.ts)* |
| F-007 | vGPU Live Migration Blackwell GB200/B100 *(implemented: livemigration, virtualization.ts)* |
| F-008 | Blackwell FP4/FP6/FP8 Virtualization and Dynamic MIGv2 *(implemented: MIGLAYOUTBLACKWELL, virtualgpu.ts + planmiglayout, scheduler.ts)* |
| F-009 | GPU Time-Slicing QoS and Preemption Guarantees *(implemented: VGPUPROFILES time-sliced vgpu scheduler mirror, virtualgpu.ts)* |
| F-010 | Persistent vGPU and vRAM Snapshots plus CUDA Checkpoint *(implemented: diffsnapshotengine + planfilesnapshot, virtualization.ts + cricheckpointer, orchestrator.ts)* |
| F-011 | NCCL 3.x Virtualization and Multi-Node GPU Fabric |
| F-012 | NVLink Switch 3rd-Gen Multi-Node Pooling (576 GPUs) |
| F-013 | WebGPU Virtualization Layer (WGPU Virt, virtio-webgpu) *(implemented: forcefallbackadapterplan, compute.ts)* |
| F-014 | Virtio-GPU Native Context (Venus/Vulkan) Passthrough |
| F-015 | Vulkan Video Encode/Decode Virtualization (virtio-video) |
| F-016 | Intel AMX / AMD XDNA NPU Virtualization *(implemented: plannputiles, compute.ts)* |
| F-017 | Serverless GPU Functions (Scale-to-Zero vGPU) |
| F-018 | Virtio-FS plus DPU File System Disaggregation |
| F-019 | FPGA Time-Multiplexed vFPGA (Versal, Agilex) |
| F-020 | USB4 / Thunderbolt Passthrough v2 with Hotplug |
| F-021 | WASM MicroVM Runtime (Wasmtime/WAMR/WasmEdge, fuel) *(implemented: wasiasyncruntime + fuelmeter, compute.ts)* |
| F-022 | Rust Rewrite of the QEMU Bridge (qemu-bridge-rs) |
| F-023 | eBPF Hierarchical CPU Scheduler (sched_ext + BPF) *(implemented: schedextinfo, virtualization.ts)* |
| F-024 | Live vCPU Hotplug plus eBPF Rebalancing Daemon *(implemented: vcpuhotplug, scheduler.ts)* |
| F-025 | Heterogeneous vCPU Topology (P+E, X3D + Zen5) |
| F-026 | vNUMA Auto-Rebalance DAMON + AutoNUMA v2 |
| F-027 | Formal Verification of the Scheduler (TLA+ / Alloy) |
| F-028 | Memory Dedup KSM++ DAMON-aware Scan |
| F-029 | KVM Hypercall Acceleration (Rust kvm-bindings) |
| F-030 | Cross-Arch Emulation x86-AArch64 plus Rosetta-like Cache |
| F-031 | io_uring Zero-Copy Passage Engine |
| F-032 | SPDK + NVMe-oF Userspace Storage Stack |
| F-033 | virtio-blk over io_uring plus I/O Polling |
| F-034 | ZNS and FDP SSD-Aware Virtual Disk Provisioning *(implemented: planznszones, virtualization.ts)* |
| F-035 | Distributed Checkpointing 100B+ Training (SnapshotFS) |
| F-036 | Virtio-FS DAX plus CXL Shared Memory File Cache |
| F-037 | DPU Offload (BlueField-3 / Pensando / Intel IPU) |
| F-038 | SR-IOV Dynamic VF Provisioning and Live Attach *(implemented: setupsriov, virtualization.ts)* |
| F-039 | XDP/eBPF Hardware-Accelerated Packet Pipeline *(implemented: ebpfprogram, virtualization.ts)* |
| F-040 | DPDK Userspace Bridge (virtio-user) |
| F-041 | QUIC + HTTP/3 Tunneling for Secure Passage |
| F-042 | WireGuard Mesh + Tailscale for vNets *(implemented: tailscaleendpointplanner, compute.ts)* |
| F-043 | SmartNIC P4 Programmable Packet Steering *(implemented: buildp4skeleton, virtualization.ts)* |
| F-044 | Time-Sensitive Networking (TSN) for RT VMs *(implemented: buildtsnschedule, virtualization.ts)* |
| F-045 | Virtio-snd + PipeWire Low-Latency Audio Passage |
| F-046 | WebTransport + WebCodecs Display Streaming |
| F-047 | Confidential VMs: SEV-SNP, TDX, ARM CCA *(implemented: buildqemucmd sev-snp-guest/tdx argv, virtualization.ts)* |
| F-048 | HW-Attested Guest Integrity (SVSM vTPM + Remote Attestation) |
| F-049 | Encrypted Live Migration (TLS 1.3 + SEV-SNP) |
| F-050 | eBPF LSM + Landlock Security Policy Engine *(implemented: landlockrulebuilder + seccompbuilder, security.ts)* |
| F-051 | OCI Hooks + CDI for GPU Container Parity |
| F-052 | gVisor-like Syscall Interception (WASM companion) *(implemented: gvisorruntime, orchestrator.ts)* |
| F-053 | AI Autoscaler RL and Predictive Queuing (stable-baselines3) *(implemented: rlautoscaler epsilon-greedy bandit, scheduler.ts)* |
| F-054 | Predictive HW Failure SMART + eBPF Telemetry *(implemented: anomalydetector, scheduler.ts)* |
| F-055 | Generative Config Synthesis (LLM-assisted JSONs) |
| F-056 | OpenTelemetry + eBPF Deep Profiling Mesh *(implemented: otelmetricsbridge, scheduler.ts + ebpfgputelemetry, compute.ts)* |
| F-057 | Carbon-Aware Scheduling (WattTime + Kepler) |
| F-058 | Multi-Tenant QoS cgroups v2 + PSI + eBPF *(implemented: tenantcgroupbuilder, virtualization.ts + tenantadmission, scheduler.ts)* |
| F-059 | AI Workload Fingerprinting and Auto-Tuning (Dynamo/XLA/vLLM) |
| F-060 | Chaos Engineering Framework (ChaosVM) |
| F-061 | Ray + vLLM Distributed Inference Orchestrator *(implemented: planrayvllmcluster, compute.ts)* |
| F-062 | Kubernetes Operator (SADDLE CRDs) *(implemented: buildvmcrdmanifest, compute.ts)* |
| F-063 | CRDT Distributed vm.config (Automerge + Yjs) *(implemented: vmconfigcrdt, scheduler.ts + statevectorsync, compute.ts)* |
| F-064 | GitOps Flux CD + SADDLE CRDs + OPA *(implemented: planfluxgitops, orchestrator.ts)* |
| F-065 | Federated SADDLE Clusters Global Scheduler (10k nodes) *(implemented: planfederatedquota, compute.ts)* |

Source document annexes (dependency graph, spec extensions, version/CI,
file-count budget, keywords) stay in the pool artifact; this appendix carries
the verbatim feature ledger with horizons H1/H2/H3, complexity L1-L5 and
five-axis impact recorded per item in the source. The v5-C feature audit
(worklog task v5-C) grepped every row against the modules: rows marked
*(implemented: symbol, module)* carry a builder/planner/class; unmarked
rows are either implementable planners still open or planned externals
(listed in appendix D).

## Appendix B. v6 future feature ledger {#appendix-b}

The v6 set of the same ledger, preserved from the SADDLE v6 rewrite
(`roadmapfuturefeatures.md`, 12 sections plus metadata; quantified targets in
parentheses are the v6 planning values, not measured results).

| ID | Feature (v6 set B) |
|---|---|
| F-001 | CXL 3.0 Type-3 Pooling Fabric (2-4 TiB, +18%, -34% per GB) *(implemented: plancxltype3, virtualization.ts)* |
| F-002 | CXL 2.0 Fallback + HMAT 2.0 (latency 22/80) *(implemented: plancxltype3 spec '2.0' + hmat entries)* |
| F-003 | Ballooning v2 with PSI (free-page-hint, +14% at 4.5x) |
| F-004 | NUMA Distance-Aware Pinning + HMAT (+22%) *(implemented: planumalayout + numactlargs, scheduler.ts)* |
| F-005 | vGPU Live Migration Pre-Copy dirty-ring 65536 (under 800 ms) |
| F-006 | Blackwell MIG v2 14 hybrid slices (14x density) *(implemented: MIGLAYOUTBLACKWELL, virtualgpu.ts)* |
| F-007 | NVLink-C2C 900 GB/s GB200 Superchip (624 GB coherent) |
| F-008 | vRAM Slicing 1 MB step, DPU accounting 10M ops/s |
| F-009 | vGPU EEVDF Fair-Share Low-Latency (+27% p95) |
| F-010 | Blackwell FP4 9000 TFLOPS Passthrough (4x versus FP8) |
| F-011 | GPU Overcommit CXL P2P spill (192 to 384 GB, -8%) |
| F-012 | GPU Power Capping NVML (B200 1000 W / 700 W liquid) |
| F-013 | SR-IOV 32 VF per pGPU Blackwell iommufd |
| F-014 | GPU-IOV ATS/PRI Isolation fail-closed |
| F-015 | WASM MicroVM + QEMU microvm (cold 45 to 6 ms) *(implemented: wasiasyncruntime, compute.ts + microvm runtimes, orchestrator.ts)* |
| F-016 | WASM Cold Start under 5 ms (memfd + io_uring zstd, 4.8 ms p50) *(implemented: wasmmempool, compute.ts)* |
| F-017 | WASI Preview2 FS Bridge node:fs (+19%) |
| F-018 | WASI-NN GPU FP4 via WGPU 22 (H3) |
| F-019 | Nested WASM inside QEMU (SEV-SNP outer) |
| F-020 | sched_ext eBPF vCPU Scheduler (scx_rusty, +18%) *(implemented: schedextinfo, virtualization.ts)* |
| F-021 | cgroup v2 cpu.weight Autotune PSI (1..10000) |
| F-022 | eBPF XDP virtio-net Offload 9000 MTU (+34%) |
| F-023 | eBPF io_uring Latency Histogram (0.05-32 ms) |
| F-024 | io_uring Zero-Copy Passage vsock+unix (3.2 to 0.9 ms) |
| F-025 | io_uring Fixed Buffers Registered (8192 KB, +28%) |
| F-026 | io_uring NVMe Passthrough 14 GB/s PCIe 5.0 (+64%) |
| F-027 | sendmsg MSG_ZEROCOPY unix fallback (+19%) |
| F-028 | AI Autoscaler vCPU 1-4096 (sktime 0.35 LSTM, -31%) *(implemented: rlautoscaler + psilstm, scheduler.ts)* |
| F-029 | AI GPU Demand Forecast (predictive MIG, -27% idle) |
| F-030 | AI Anomaly ECC/Thermal (failure 30 min ahead, 99.99%) *(implemented: anomalydetector, scheduler.ts)* |
| F-031 | AI Bin-Packing OR-Tools heterogeneous (+38%) |
| F-032 | AI FinOps per-Tenant ($/vCPU + $/GB + $/W, Kepler) |
| F-033 | AMD SEV-SNP OVMF Secure Boot (-6% perf) |
| F-034 | Intel TDX 2nd Gen (TDVF, QGS quote) |
| F-035 | Confidential GPU H100/B200 CCC (+NV-Trust) |
| F-036 | Attestation TPM 2.0 + OVMF enrolled-keys (swtpm 0.8) *(implemented: OVMF secure boot argv, virtualization.ts)* |
| F-037 | SEV-SNP Live Migration with Rekeying (HKDF + TPM) |
| F-038 | DPU BlueField-3 Virtio Data Path (DOCA 2.9) |
| F-039 | DPU Storage NVMe-oF + SPDK 24.09 |
| F-040 | NVLink Switch Fabric NVL72 576 GPUs (720 PF FP4) |
| F-041 | PCIe 5.0 AER DPU-accelerated (+99.99%) |
| F-042 | RoCE v2 GPUDirect RDMA MTTG (OFED 24.10, -22%) |
| F-043 | Rust qemubridge.rs Tokio (QMP 12 ms to 1.8 ms) |
| F-044 | Rust QMP Wrapper (retry 50 ms x 2^n, napi-rs) |
| F-045 | Rust virtio Emulation vhost-user (io_uring 0.7) |
| F-046 | Rust CXL Mailbox FM-API (QoS class) |
| F-047 | Rust eBPF Loader libbpf-rs 0.24 (CO-RE) |
| F-048 | WebGPU Virt WGPU + Dawn + Vulkan 1.4 (40 ctx/B200) |
| F-049 | WebGPU Compute Passthrough WASI-NN (Naga to PTX, +32x) |
| F-050 | WebGPU Dawn + Vulkan Video NVENC AV1 8K (+44%) |
| F-051 | OCI WASM Layers + Buildx (dedup +33%) |
| F-052 | CRIU + QEMU incremental + io_uring (3.2 s to 0.45 s) |
| F-053 | Live Upgrade QEMU 9.1.2 to 10.0 x-colo zero-downtime |
| F-054 | Docker cgroupv2 + crun + CDI nvidia.yaml |
| F-055 | Passage HTTP/3 QUIC 0-RTT TLS1.3-only (Pingora 0.4.2) |
| F-056 | mTLS per-VM + JWT rotation 12 h (X509 ed25519) |
| F-057 | OTel + eBPF Profiles + Prometheus 9090 *(implemented: otelmetricsbridge, scheduler.ts)* |
| F-058 | Chaos Fault Injection QEMU + DPU (+31% resiliency) |
| F-059 | Multi-Tenant MTTG QoS + Weighted vRAM (+22%) *(implemented: tenantqosmap + MTTG grid, virtualization.ts)* |
| F-060 | NVENC 8K AV1 + H.266 VVC (2.1x Ada, 32x 4K/B200) |
| F-061 | Heterogeneous CPU X3D + Intel Hybrid (+23% gaming) *(implemented: ccd-aware vcpupinningmap, virtualmemory.ts)* |
| F-062 | Energy-Aware Carbon Scheduling (Kepler 0.8, -19%) |
| F-063 | OPA Rego Policy Engine (vram 1024-786432 step 1) |
| F-064 | Forge Mirror Bidirectional Sync (notify 6.0) |
| F-065 | Docs Auto-Gen over 40 files (typedoc 0.26 + mkdocs) |

Source-document metadata preserved with the set: section 12 dependency
matrix, section 13 release trains 33/27/5 (33 near-term, 27 mid, 5 far), and
section 15 aggregate targets (+27.4% performance geo-mean, 3.1x density,
CVSS -38%, cost -29%). Rows share the v5-C audit marks of appendix A
(same IDs); the Rust rewrite family (F-043 to F-047) is tracked as
planned externals in appendix D.

## Appendix C. Backlog from the v4 archive {#appendix-c}

The 13-item `roadmapbacklog` of the retired `future.ts` (v4 archive, lines
2701-2715 of the pool artifact), the only block of that file absent from the
v3 redistribution. The register lives on as `roadmapbacklog` in compute.ts;
the v5-C audit promoted four rows (1, 3, 8, 9) from backlog strings to real
builders, and the remaining rows are recorded so the archive survives the
module decomposition.

| # | Backlog item (v4 archive) | Note |
|---|---|---|
| 1 | Intel AMX tile real passthrough | beyond the `+amx-tile` flag: actual TDP-pipe emulation *(implemented as builder: plannputiles, compute.ts; real pipe emulation stays external)* |
| 2 | Dual-X3D detection for the 9950X3D2 | both CCDs carrying V-Cache; today only the cache-size rule selects it |
| 3 | WebTransport datagram relay | browser-facing passage twin of the QUIC gateway *(implemented: planwebtransportendpoint, compute.ts)* |
| 4 | Turborepo remote cache on GHCR | free-tier build cache beside the gha cache |
| 5 | pnpm v9 content-addressable store | alternative package manager lane |
| 6 | QUIC + HTTP/3 control plane | passage already speaks it for data; the control channel does not |
| 7 | P2P WebRTC mesh sandboxes | browser-to-browser without a relay |
| 8 | OPFS browser sandboxes | Origin Private File System as a guest disk *(implemented: planopfsstorage, compute.ts)* |
| 9 | WebCodecs + WebGPU encode | hardware-free encode inside the browser tier *(implemented: planwebcodecspipeline, compute.ts)* |
| 10 | SharedArrayBuffer cross-origin isolation | COOP/COEP headers for multi-origin sandboxes |
| 11 | WASM JSPI scheduling | JavaScript Promise Integration for the wasm tier |
| 12 | GHCR gha layer reuse | cross-repository cache sharing |
| 13 | Nix flakes hermetic builds | reproducible host toolchain lane |

## Appendix D. Planned externals (not implementable in-engine) {#appendix-d}

Result of the v5-C feature audit (worklog task v5-C): every ledger row was
classified as (a) already implemented, (b) implementable as a dependency-free
builder/planner in TypeScript, or (c) not implementable as code of this engine
because it requires physical hardware, platform firmware or paid external
services. This appendix registers the category (c) rows as planned externals:
the engine can plan and emit their configuration, but execution happens
outside the repository.

| Ledger rows | External dependency | Why it cannot be engine code |
|---|---|---|
| A F-003, A F-012, B F-007, B F-040 | NVLink-C2C / NVLink Switch fabric | physical interconnect hardware between real GPUs |
| A F-011 | NCCL 3.x | guest-side library owned by NVIDIA |
| A F-014, A F-015 | Virtio-GPU Venus / virtio-video upstream | requires upstream QEMU/Venus merge, not a TS shim |
| A F-017, B F-035 | confidential GPU H100/B200 CCC + NV-Trust | hardware trusted-launch in NVIDIA silicon |
| A F-019 | vFPGA Versal/Agilex time multiplexing | physical FPGA reconfiguration ports |
| A F-020 | USB4/Thunderbolt passthrough | host controller and physical dongles |
| A F-022, B F-043..F-047 | Rust rewrite family (qemubridge.rs, QMP wrapper, vhost-user, FM-API mailbox, libbpf-rs) | a second Rust codebase outside this TS engine |
| A F-027 | TLA+ / Alloy formal verification | external model checkers and proof toolchains |
| A F-032 | SPDK + NVMe-oF target | userspace storage daemon with kernel-bypass drivers |
| A F-037, B F-038, B F-039 | BlueField-3 / Pensando / Intel IPU DPU offload | physical DPU cards and DOCA licenses |
| A F-041, B F-042, B F-055 | QUIC 0-RTT / RoCE v2 OFED / Pingora edge | kernel RDMA NICs and edge proxy deployments |
| A F-048 | SVSM vTPM remote attestation | AMD KDS attestation service and platform firmware |
| A F-049, B F-037 | encrypted live migration rekeying (HKDF + TPM) | guest firmware secrets held by the platform |
| A F-055 | LLM-assisted config synthesis | external model inference (the engine stays offline) |
| A F-057 / B F-062, B F-032 | WattTime carbon API, Kepler exporters, FinOps meters | external metered services and cluster agents |
| B F-051, B F-064, B F-065 | OCI WASM layers on GHCR, Forge mirror, typedoc/mkdocs | registry, git hosting and doc toolchain pipelines |
| C 2, 4, 5, 7, 10, 11, 12, 13 | dual-X3D silicon, Turborepo/pnpm lanes, WebRTC mesh infra, SAB headers on real origins, JSPI engine flags, GHCR sharing, Nix flakes | silicon, browser vendors, registries and CI toolchains |

For these rows the engine's contract is: emit complete, validated plans
(argv, manifests, schedules) that external executors consume verbatim; the
builders registered in appendices A-C are the deliverable.
