# Alternatives - Ten Categories, Thirteen Engines, 105 Variants

The `alternatives.ts` module (1,218 lines, 29 exports) models the competitive
landscape of sandbox execution engines. Ten categories cover thirteen
concrete engines, every one wired through a real adapter implementing the
shared `SandboxEngine` interface (`create`/`exec`/`snapshot`/`destroy`/
`metrics`), so a host can swap execution backends without touching call
sites. Beyond the registry, this document consolidates the 105-variant
taxonomy (microVMM backends, Kata derivatives, secure runtimes, OCI engines,
hypervisor primitives, GPU mediation, compositional stacks, network and
storage derivations) and the open-source research landscape that produced it.
All versions and figures were confirmed on 2026-08-22 against primary
sources (release feeds, official docs, vendor blogs). Engine internals for
the runtimes e2ugh itself orchestrates (QEMU 11.1.0, Firecracker 1.16.1,
Cloud Hypervisor v53.0, Kata 4.1.0, gVisor) are specified in
`virtualization.md`; this document is about choosing among engines, not
re-describing them. Spoofing techniques belong to `viability.md`; benchmark
methodology to `performance.md`.

Contexts covered (25): SandboxEngine contract, EngineRegistry aliases,
selectEngine criteria, Wasmtime 48.0.0 fuel metering, gVisor systrap, Kata
4.1.0 runtime-rs, Cloud Hypervisor v53.0 offloaded snapshots, WebContainers,
Daytona MCP, Modal elastic GPUs, Fly Machines snapshot resume, E2B family,
Vercel Sandbox $1M challenge, Apple Containers 1.2.2, CubeSandbox, EmberVM,
five-lens variant scoring, security posture tiers, compositional stacks,
SR-IOV vendor VFIO, passt, virtiofs DAX, open-sandbox-router, forge mirrors,
disruptive tiers.

## Contents

1. [How the adapters are wired](#wiring)
2. [The ten categories](#categories)
3. [Engines documented beyond the registry](#beyond)
4. [Comparison matrix (13 engines)](#matrix)
5. [Choosing with selectEngine](#selecting)
6. [Variants and derivations: 105 variants](#variants)
7. [Security posture tiers](#tiers)
8. [Disruptive matrix](#disruptive)
9. [Open-source research landscape](#landscape)
10. [Forge mirrors](#forge)
11. [Sources](#sources)

## How the adapters are wired

Three code artifacts matter when reading this document:

| Artifact | Role |
|---|---|
| `SandboxEngine` interface | The five-method contract every adapter implements; `SandboxCapabilities` declares isolation class, snapshotting, network egress, GPU, self-hosting, and KVM requirements |
| `BaseEngine` abstract class | Consolidates lifecycle bookkeeping: a `#sandboxes` Map, per-engine `coldBootMs` and `execOverheadRatio` constants, and the `SandboxEngineError` type thrown on unknown sandboxes or missing capabilities |
| `EngineRegistry` + `createDefaultEngineRegistry()` | Factory registry with alias resolution (`runsc` -> gvisor, `ch` -> cloud-hypervisor, `wasm` -> wasmtime, `vercel` -> vercel-sandbox, `tupper` -> apple-containers); unknown ids raise a suggestion error listing the closest known engine |

The registry loads thirteen engines: wasmtime, gvisor, kata,
cloud-hypervisor, webcontainers, daytona, modal, fly-machines, e2b, morph,
cognitora, vercel-sandbox, and apple-containers. `comparisonMatrix` carries
the verified row data, `renderComparisonTable()` prints it as markdown for
CI logs, and `selectEngine(criteria)` scores the matrix by boot latency,
isolation, snapshot, GPU, and self-hosting needs, returning a ranked top
three.

## The ten categories

### 1. Wasmtime v48.0.0 LTS (wasm runtime)

How it works. Wasmtime executes WebAssembly components inside a sandbox with
no ambient authority by default: a component may only use the WASI interfaces
explicitly granted to it. Two interruption mechanisms bound runaway guests -
fuel metering (a deterministic per-instruction budget, 50 million in the
engine's canonical profile) and epoch interruption (a coarse wall-clock
deadline checked at callback points, roughly 10 percent overhead, 180 seconds
canonical). WASI 0.3.0 (ratified 2026-06-11) added native async calls to the
component model, and the v48 line (released 2026-08-20; libraries keep the
multiple-of-twelve line for long support) carries it alongside WASI 0.2.8.
The adapter models `setFuelBudget`, `setEpochDeadline`, the interrupt
policy, and a `runCommand` shape mirroring `wasmtime serve`.

| Attribute | Wasmtime v48.0.0 | e2ugh |
|---|---|---|
| Boot / instantiation | ~3 ms component instantiation | 125 ms (Firecracker) to 1-2 s (Docker cold) |
| Isolation | wasm sandbox, deny-by-default components | container + microVM hybrid with virtualized hardware views |
| License | Apache-2.0 WITH LLVM-exception | open-source repository over an MIT/Apache-2.0 stack |
| Self-host | yes, embeddable library | yes, self-hosted by design |

Choose Wasmtime when the workload is already a wasm component or compiles to
one, when millisecond instantiation beats POSIX compatibility, and when
deterministic resource budgets are mandatory (fuel is exact, unlike
wall-clock cgroup limits). Choose e2ugh when the workload runs unmodified
Python/Node/CUDA-flavored code, expects a full `/proc` with forged CPU and
memory views, or needs the Mesa software GPU APIs that wasm sandboxes do not
expose.

### 2. gVisor release-20260817.0 (user-space kernel)

How it works. gVisor's `runsc` is an OCI runtime that implements the Linux
kernel surface in userspace: the Sentry intercepts guest syscalls and
services them itself instead of forwarding them to the host kernel. The
default systrap platform delivers syscalls through SECCOMP_RET_TRAP/SIGSYS
(faster than ptrace on most workloads; ptrace and KVM platforms also exist),
and DirectFS lets the Sentry hand selected filesystem operations to the host
to cut I/O costs. The measured cost is 10-30 percent on I/O-heavy workloads,
up to 2x on syscall-bound ones; io_uring is disabled by default (the policy
alignment with `security.md` is exact).

| Attribute | gVisor release-20260817.0 | e2ugh |
|---|---|---|
| Boot | ~35 ms sandbox start | 125 ms-2 s depending on runtime tier |
| Isolation | Sentry syscall interception (systrap) | container/microVM with virtualized devices |
| Overhead | 10-30 percent I/O; up to 2x syscall-bound | spoofing is report-level; execution is native CPU |
| Self-host | yes, OCI runtime (`docker --runtime runsc`) | yes |

Choose gVisor for defense in depth for unmodified Linux binaries inside
standard OCI images at near-native CPU speed with plain Docker/Kubernetes
tooling. Choose e2ugh when hardware spoofing is the actual product
requirement, or when the syscall tax on I/O-heavy agents is unacceptable.

### 3. Kata Containers 4.1.0 (microVM container runtime)

How it works. Kata runs each container inside a lightweight VM, combining
Kubernetes/CRI compatibility with hardware isolation. Version 4.0.0 (GA July
2026) made runtime-rs, the Rust runtime, the default and deprecated the Go
runtime (bugfix/security only until a removal not earlier than 5.0.0,
planned Q1 2028); 4.1.0 (2026-08-21) added OpenVMM support in runtime-rs,
Cloud Hypervisor VM templates, configurable nested virtualization, NVSwitch
passthrough via IOMMUFD, and a rootless+seccomp baseline for QEMU. Supported
hypervisors: QEMU, Cloud Hypervisor, Firecracker, Dragonball, OpenVMM.

| Attribute | Kata 4.1.0 | e2ugh |
|---|---|---|
| Boot | ~240 ms per pod VM (template-assisted) | 125 ms-2 s |
| Isolation | hardware-isolated microVM per container | container/microVM hybrid |
| KVM required | yes (`/dev/kvm`), absent on hosted runners | no (TCG fallback tier) |
| Self-host | yes, Kubernetes CRI | yes |

Choose Kata when the deployment is Kubernetes-first and each pod must be
hardware-isolated while keeping the CRI workflow. Choose e2ugh when the
target is a single-agent sandbox service with virtual hardware views, or
when KVM is unavailable - Kata, like Firecracker, requires `/dev/kvm`, which
GitHub-hosted runners do not expose.

### 4. Cloud Hypervisor v53.0 (rust-vmm VMM)

How it works. Cloud Hypervisor is a virtual machine monitor built from
rust-vmm crates, speaking KVM on Linux and MSHV on Windows/Hyper-V, with
CPU/memory/PCI hotplug, VFIO passthrough, vhost-user devices, and Windows
guest support - the general-purpose VMM role Firecracker deliberately lacks.
The v53.0 release (2026-07-13) shipped the offloaded snapshot/restore daemon
(an external process that services restore page faults through userfaultfd
and vhost-user, moving snapshot work off the VMM thread), migratable
same-host VFIO devices, pre-opened VFIO character devices, and an
experimental vfio-user device backend attached through `ch-remote
add-user-device --socket=...`. The release cadence is a major version
roughly every six weeks.

| Attribute | Cloud Hypervisor v53.0 | e2ugh |
|---|---|---|
| Boot | ~90 ms microVM start | 125 ms-2 s |
| Isolation | KVM/MSHV microVM | container/microVM hybrid with virtualized views |
| Role | building block VMM | application-facing layer that can sit on top of it |

Choose Cloud Hypervisor when the product is a VMM or a snapshot-heavy cloud;
it is a component e2ugh itself can sit on top of. Choose e2ugh directly
when the requirement is the application-facing layer - forged `/proc`, virtual
nvidia-smi adapter, software GL/Vulkan/OpenCL - that a bare VMM does not provide.

### 5. WebContainers by StackBlitz (browser runtime)

How it works. WebContainers run a Node.js-compatible runtime, including npm
installs, entirely inside the browser's sandbox: the Node APIs are
implemented in WebAssembly and WebWorkers, the filesystem lives in memory,
and networking is bound by same-origin policies. Boot is measured in
milliseconds (2-5 s for full boots including heavier frameworks), there is
zero server footprint - the compute is the client's tab - and the practical
isolate ceiling is 128 MB, which rules out megabyte-scale JSON parsing per
request. Ruby 3.3 WASM runs alongside Node tooling; COOP/COEP headers are
required for the multi-threaded paths. WebContainers are the foundation of
bolt.new, the AI web-development agent; the product is a commercial GA API
whose public repository hosts issues rather than source.

| Attribute | WebContainers | e2ugh |
|---|---|---|
| Boot | ~15 ms in-tab boot | 125 ms-2 s |
| Isolation | browser sandbox (same-origin policies) | container/microVM hybrid |
| Server cost | none (client-side) | self-hosted |
| License | proprietary (commercial API) | open source |

Choose WebContainers when the sandbox must run on end-user machines with no
server budget and the workload is npm/Node-centric. Choose e2ugh when
server-side execution is available (heavy CPU-bound rendering, CUDA-flavored
workloads, or /proc spoofing that browsers forbid), or when full Linux
filesystem semantics and Docker images are required.

### 6. Daytona (self-hostable sandbox platform)

How it works. Daytona provisions stateful, full-Linux sandboxes for AI
agents, exposing them through an SDK and through the Model Context Protocol
(MCP), so agent frameworks can request sandboxes as tools; sandbox creation
is around 90 ms, and workspaces persist state across sessions (volumes FUSE
S3-backed, LSP, SSH, snapshots, hot resizing). The 2026 trajectory matters
for adopters: production source closed in June 2026, leaving the
open-source control-plane history and community forks (including Chinese
forks noted in the research pass) - the adapter models the ~90 ms figure and
carries an MCP tool descriptor, with the closure recorded as a risk fact.

| Attribute | Daytona | e2ugh |
|---|---|---|
| Boot | ~90 ms sandbox creation | 125 ms-2 s |
| Isolation | container sandbox, stateful workspaces | container/microVM hybrid with virtualized views |
| Status | OSS core history; production closed June 2026 | open source, no platform dependency |
| Self-host | core forks; original SaaS ended | yes |

Choose Daytona when a maintained platform (control plane, dashboard, MCP
integration) fits and a managed or forked third-party product is acceptable.
Choose e2ugh when the sandbox itself must present virtual hardware or the
requirement is a single embeddable engine with no platform dependency.

### 7. Modal (serverless containers for AI)

How it works. Modal executes Python-first (JavaScript secondary) functions
and containers on a serverless fabric - gVisor on KVM internally - that
scales to 100,000+ concurrent sandboxes with sub-second scheduling; sessions
run up to 24 hours, and GPUs attach elastically across T4, L4, H100, H200
and B200 inventory. Cold starts with custom images are the acknowledged weak
point (~250 ms warm pool mitigation aside; the SDK benchmark below shows
4.66 s end-to-end for a cold SQLite workload), and snapshots plus live
migration smooth long sessions.

| Attribute | Modal | e2ugh |
|---|---|---|
| Concurrency | 100,000+ sandboxes | bounded by operator hardware |
| GPUs | elastic real GPUs (T4 to B200) | software GPUs by design; real GPUs only via VFIO tiers |
| License | proprietary SaaS | open source |
| Self-host | no | yes |

Choose Modal when elastic scale and real GPUs on demand matter more than
hardware realism and a SaaS dependency is acceptable. Choose e2ugh when the
workload must believe it owns specific hardware (an agent that shells out to
nvidia-smi before choosing kernels), or when everything must run self-hosted
at zero marginal cost.

### 8. Fly.io Machines (global microVM API)

How it works. Fly Machines expose Firecracker microVMs through a global API
across 30+ regions, with start times from 10 to 600 ms, per-millisecond
billing, snapshot resumption (~300 ms restore, P99 2 s, 100 GB NVMe
checkpoint volumes), and private networking (WireGuard mesh) between
machines. A Machine can be stopped and resumed with its memory intact, so
warm starts behave like Firecracker snapshot restores - the same mechanism
e2ugh's warm pool implements locally.

| Attribute | Fly.io Machines | e2ugh |
|---|---|---|
| Boot | ~300 ms create (sub-second start/stop) | 125 ms-2 s |
| Regions | 30+ global regions | wherever the operator hosts |
| License | proprietary SaaS | open source |

Choose Fly when global latency placement and an operated Firecracker fleet
are worth paying for. Choose e2ugh to self-host the whole stack, including
Firecracker itself on KVM-capable hardware, and to control the virtual
hardware presentation end to end.

### 9. The E2B family (E2B, Morph, Cognitora, Vercel Sandbox)

How it works. This category gathers the AI-first sandbox clouds. E2B runs
agent code in Firecracker microVMs with ~150 ms cold starts achieved through
snapshot restore with userfaultfd, sessions capped at 24 hours, and an
Apache-2.0 SDK over a closed cloud (a self-host reference exists in
e2b-dev/infra: Nomad + Consul + Packer + Terraform 1.5.7 + PostgreSQL + S3).
Morph differentiates on VM forking: ~250 ms to fork a running VM so agents
explore parallel paths from a checkpoint. Cognitora is a smaller-footprint
AI code execution platform (Firecracker + Kata hardware-level isolation,
each execution with its own kernel, hvsock debugging via `socat stdin
unix-connect:kata.hvsock`). Vercel Sandbox reached GA on 2026-01-30, runs on
Firecracker at 2M+ builds/day (32 vCPU, 64 GB, 24 h ephemeral), and put a $1
million HackerOne challenge behind its security posture in August 2026. One
adapter (`E2bFamilyEngine`) covers all four through a `variant` selector.

| Attribute | E2B | Morph | Cognitora | Vercel Sandbox | e2ugh |
|---|---|---|---|---|---|
| Cold boot | ~150 ms | ~250 ms (fork) | ~220 ms | ~200 ms | 125 ms-2 s |
| Isolation | Firecracker microVM | forkable VM | per-execution kernel | Firecracker microVM | hybrid |
| License | Apache-2.0 SDK, closed infra | proprietary | proprietary | proprietary | open source |
| Self-host | reference only | no | no | no | yes |

Choose the E2B family when time-to-integration dominates: one SDK call
returns a running sandbox with an API key, and the cloud absorbs capacity
planning. Choose e2ugh when self-hosting, hardware spoofing, or per-sandbox
cost control is the driver - e2ugh targets E2B-class latency on hardware
the operator already owns. Related research artifacts: Zeropod (CRIU + eBPF
TCP redirect, turn-aware checkpointing) and Aivisor (namespaces + cgroupv2 +
Landlock + seccomp + eBPF LSM, four layers) document the family's
isolation internals.

### 10. Apple Containers 1.2.2 (macOS container runtime)

How it works. Apple's open-source Swift project (Apache-2.0) runs each Linux
container in a lightweight microVM optimized for Apple Silicon, booting in
under one second; OCI images pull and run through a `container` CLI. v0.1.0
(2025-06) established the base using the Containerization Swift package and
the Kata 3.26.0 kernel (3.17.0 arm64); 1.0.0 landed 2026-07-06, 1.2.2 on
2026-08-08, and WWDC26 (2026-06-08, session 389) introduced "container
machines" - persistent, lightweight Linux environments configured through
TOML. Security posture is Seatbelt (Landlock-like) plus seccomp for the
"mostly-helpful-but-careless agent" threat model rather than kernel/VM
boundaries; `/dev/shm` sizing needs a post-startup remount (no --shm-size
flag), the exact PyTorch pitfall `performance.md` documents for the Linux
path.

| Attribute | Apple Containers 1.2.2 | e2ugh |
|---|---|---|
| Boot | <1 s (600-900 ms modeled) | 125 ms-2 s |
| Host | macOS only (Apple Silicon) | Linux |
| License | Apache-2.0 | open source |

Choose Apple Containers when the fleet is macOS and the goal is Linux
containers with VM-grade isolation on developer machines or Mac mini
clusters. Choose e2ugh when the host is Linux, when x86_64 virtual CPU
models are needed (EPYC-v5 in QEMU), or when the Mesa software GPU trio
matters - the Apple Silicon path has its own graphics stack.

## Engines documented beyond the registry

Two engines are documented in the research corpus without registry adapters,
kept out of the code because no public contract was verifiable on 2026-08-22
- they are documented facts, not invented adapters:

| Engine | Verified facts |
|---|---|
| CubeSandbox (TencentCloud) | rust-vmm/KVM microVM service for AI agents, E2B-compatible APIs, sub-60 ms startup, single-concurrency average 67 ms, P95 90 ms, P99 137 ms, under 5 MB per sandbox, eBPF isolation, credential vault (keys never enter the sandbox), CubeCoW snapshot framework, K8s + Terraform deployment |
| EmberVM | AGPL-3.0 Firecracker + ZFS + userfaultfd: O(1) copy-on-write clone, lazy page loading, working-set prefetch (pure lazy faulting 43 MB/s versus 533 MB/s with prefetch), Lz4 8-16 KiB chunks, FastCDC content-addressed S3 on Garage/SeaweedFS, resume average 400 ms P99 2 s, proven at CodeSandbox; supports nested virtualization on GCP/AWS C8i (2026-02+) and bare-metal Hetzner at EUR 25-40 |

## Comparison matrix (all thirteen registered engines)

Boot times are the documented figures each adapter models.

| Engine | Version | Boot ms | Overhead | Isolation | Snapshot | Hosting |
|---|---|---|---|---|---|---|
| wasmtime | v48.0.0 | 3 | epoch guard ~10%; near-native | wasm sandbox, deny-by-default | component image | self-hosted library |
| gvisor | release-20260817.0 | 35 | 10-30% I/O; up to 2x syscall-bound | sentry syscall interception | none | self-hosted OCI runtime |
| kata | 4.1.0 | 240 | near-native after boot | hardware-isolated microVM per container | criu + hypervisor snapshots | self-hosted Kubernetes CRI |
| cloud-hypervisor | v53.0 | 90 | near-native | KVM/MSHV microVM | offloaded userfaultfd daemon | self-hosted rust-vmm crates |
| webcontainers | ga api | 15 | in-browser process emulation | browser sandbox | none | client-side commercial API |
| daytona | oss core + saas | 90 | light container layer | container sandbox, stateful | pause/resume state | self-hosted or saas |
| modal | saas | 250 | scheduling layer, near-native exec | cloud sandbox, elastic GPUs | warm pool snapshots | saas only |
| fly-machines | saas | 300 | near-native (Firecracker) | Firecracker microVM | firecracker snapshots | saas (30+ regions) |
| e2b | sdk apache-2.0 | 150 | near-native (Firecracker + UFFD restore) | microVM sandbox for agent code | uffd snapshot restore | saas (self-host reference) |
| morph | saas | 250 | near-native | forkable VM per agent path | vm fork | saas |
| cognitora | saas | 220 | near-native | cloud sandbox, per-execution kernel | none documented | saas |
| vercel-sandbox | ga 2026-01-30 | 200 | near-native (Firecracker) | microVM sandbox | none documented | saas |
| apple-containers | 1.2.2 | 600 | near-native on Apple Silicon | lightweight microVM per container | none | self-hosted (macOS) |

## Choosing with selectEngine

The `selectEngine(criteria)` function scores the matrix with five weighted
criteria (boot latency, isolation, snapshot, GPU, self-hosting) and returns
a ranked top three; the criteria map directly to this decision table:

| If the requirement is... | Highest-scoring engines | Why |
|---|---|---|
| Millisecond instantiation of trusted code | wasmtime, webcontainers | no OS boot at all |
| Strongest isolation for unmodified Linux binaries | kata, gvisor, cloud-hypervisor | hardware VM or sentry interception |
| Snapshot/restore of running sandboxes | e2b, fly-machines, cloud-hypervisor | UFFD restore or offloaded snapshots |
| Real GPUs at elastic scale | modal | elastic GPU inventory |
| Self-hosted, virtualized virtual hardware | e2ugh itself | the only engine forging /proc and GPU APIs |

Positioning note: none of the thirteen engines claims e2ugh's core
capability - presenting virtual hardware (CPUs, memory, GPUs) that standard
Linux tooling reads as real while executing everything on software
rasterizers and emulated CPUs. The alternatives either virtualize real
hardware honestly (Kata, Cloud Hypervisor, Firecracker-based clouds),
isolate without hardware claims (gVisor, wasm), or move execution to the
client (WebContainers). The selection question is therefore not "which of
these replaces e2ugh" but "which tier of the stack each one occupies" -
and several of them (Wasmtime, Cloud Hypervisor, Firecracker) are
simultaneously components e2ugh orchestrates internally.

## Variants and derivations: 105 variants

The variant taxonomy enumerates 105 runtime alternatives across eight
tables, each variant scored 0-10 under five lenses: Optimized (latency and
throughput tuned), Robust (hardened, audited, CVE SLA), Simple (few
dependencies, runs without /dev/kvm), Disruptive (research frontier,
changes the security model), Realistic (balanced default). The layer
notation: L0 silicon, L1 hypervisor primitive, L2 VMM, L3 secure container
wrapper, L4 OCI runtime UX, L5 orchestration and config.

| Table | Count | Representative variants | Key analysis |
|---|---|---|---|
| 1. MicroVMM backends | 15 | QEMU-KVM q35 (V001), CH-IOThreads (V004), FC+Jailer (V006), CrosVM (V007), StratoVirt (V008), Dragonball (V009), CH-TDX (V010), SEV-SNP CC (V011), pKVM (V012), OpenVMM (V015) | QEMU is the only VMM with GPU+TDX+SEV-SNP together; AI labs converge on Firecracker |
| 2. Kata derivatives | 12 | kata-qemu-standard (K016), kata-clh (K017), kata-fc (K018), SEV-SNP confidential (K019), kata-qemu-nvidia-gpu-snp (K023), SR-IOV VFIO variant (K025), CoCo OPA (K027) | K025 is mandatory for Ada+/Blackwell: NVIDIA retired mdev on kernel 6.8+, replaced by vendor VFIO via SR-IOV VFs |
| 3. Secure runtimes | 12 | gVisor-KVM (S028), gVisor-ptrace-rootless (S029), Nabla (S030), Edera per-kernel (S031/S039), Sysbox (S032), Firejail (S036), nsjail (S037) | Edera eliminates shared kernel state with a per-container kernel; Nabla is EOL (2022) |
| 4. OCI engines | 12 | Docker CE BuildKit (O040), Podman rootless (O041), nerdctl (O042), containerd raw (O043), CRI-O (O044), Incus (O045), nspawn (O047), Finch (O048) | Docker default for build and CI; containerd/CRI-O inside Kubernetes |
| 5. Hypervisor primitives | 12 | KVM (H052), ARM CCA (H053), Hyper-V WS2025 (H054), bhyve (H056), Xen PVH (H057), ESXi (H058), Apple Vz (H059), TCG fallback (H063) | H063 is the no-KVM fallback: detect CPUID hypervisor bit and fall back from Kata to gVisor or TCG (10-100x slower) |
| 6. GPU mediation | 12 | whole-GPU VFIO (G064), legacy mdev (G065), SR-IOV vendor VFIO (G066), MIG (G067), virtio-gpu virgl/venus (G068), API remoting rCUDA/WSL2 (G070), MIGv2+CC (G075) | G066 is the 2026 default for Blackwell/L40S; whole passthrough remains the only driver-free option |
| 7. Compositional stacks | 15 | QEMU+Docker+gVisor (C076), SEV-SNP+CoCo (C079), Blackwell 2xB200+SR-IOV-12VF+Edera flagship (C089), Xen edge telco (C090) | C089 combines G066+G073+G075 with per-kernel zones at Tier 4+ |
| 8. Network and storage | 15 | vhost-user-DPDK 18 us (N091), passt rootless (N092), SR-IOV 8 us (N095), virtiofs DAX (N096), virtio-blk io_uring (N097), SPDK (N100), EROFS/Nydus lazy (N101), vsock (N102), iommufd v2 (N105) | passt replaces slirp for rootless; virtiofs DAX default for shared trees |

Realistic defaults distilled from the matrix: KVM + Cloud Hypervisor
(no-GPU labs) or QEMU VFIO-variant (Blackwell); kata-clh and kata-qemu
SR-IOV variant; gVisor runsc KVM with ptrace fallback; Docker 29.7+/nerdctl
(the variants freeze was measured at 27.3 and re-pinned date-first);
passt + virtiofs DAX + virtio-blk io_uring + iommufd v2. Performance notes
from the reference host (Ryzen 9 9950X3D or Threadripper 7980X, WRX90, 2x
B200, 100 Gb SR-IOV): bare container spawn 45 ms; gVisor KVM 180 ms at 5
percent nginx overhead; CH microVM 165-210 ms at 2 percent; Firecracker
jailer 125-135 ms; QEMU q35 KVM 850 ms cold, 420 ms with microvm machine;
SEV-SNP +250 ms attestation; VFIO whole-GPU under 1 percent of bare-metal
CUDA (7.8 TB/s sustained HBM3e); SR-IOV VF 2-4 percent under whole-GPU; MIG
1g slice delivers 1/7 compute with full isolation. Rootless note: Podman
rootless with passt loses 2-3 percent throughput to userspace NAT but
removes the tun/tap CAP_NET_ADMIN requirement.

## Security posture tiers

| Tier | Variants included | Isolation guarantee | Attack surface | GPU CC |
|---|---|---|---|---|
| 1 Host container | Docker alone | process + namespaces (weak) | ~400 syscalls | no |
| 2 Filtered | gVisor, Firejail, passt | syscall filter, ~50 percent reduction; user namespaces | ~200 + seccomp BPF | no |
| 3 VM | QEMU/CH + Kata | hardware VT-x/EPT/IOMMU boundary | ~20 virtio devices | no |
| 4 vGPU + per-kernel | SR-IOV VFIO + Edera zones | per-container kernel + isolated VF | ~5 devices per zone | optional |
| 5 Confidential | SEV-SNP/TDX/CoCo | measured boot + KBS attestation + dm-verity + OPA | ~5 + attestation | via MIGv2-CC |

Tier definitions align with the engine's own layering in `security.md`:
tiers 2-5 are additive depth rungs on the same ladder, and the confidential
tier reuses the TDX/SEV-SNP flags already wired into the QEMU wrapper.

## Disruptive matrix

The disruptive-tier comparison from the research corpus (executors ranked by
what they emulate and what they honestly cannot):

| Tier | Executor | Verdict from research |
|---|---|---|
| Baseline | LLVMpipe container | simplest, free, zero hardware - the e2ugh foundation |
| Similar | SwiftShader | comparable CPU Vulkan (Chrome lineage), generally worse than Mesa 2026 |
| Emulation | QEMU TCG user-mode | slower; user-mode static builds 5-10x lighter than full-system |
| Emulation | QEMU full-system MTTCG | much slower; one host thread per vCPU; can emulate any CPU |
| MicroVM | Firecracker self-hosted | real host hardware, 125 ms, 150 VMs/s, under 5 MB; closest E2B path; needs KVM |
| Interception | gVisor runsc | ~30 percent syscall overhead; more secure; zero hardware claims |
| MicroVM | Kata Containers | 4,749 MB/s versus Kata 1,113 MB/s in the Firecracker comparison (4.3x); hardware isolation |
| VMM | Cloud Hypervisor | general-purpose Rust VMM; hotplug; VFIO |
| WASM | Wasmtime fuel metering | fast, deterministic, JS-friendly; no POSIX fidelity |
| Browser | WebContainers | Node.js in the browser via WASM; no server |
| Cloud | Vercel Sandbox | GA 2026-01, Firecracker, 2M builds/day, 32 vCPU/64 GB |
| Cloud | Modal / Fly / CubeSandbox / EmberVM | elastic GPUs; global Firecracker; 67 ms P95; uffd O(1) clones |

## Open-source research landscape

The 1000+ search multilingual pass catalogued the ecosystem in ten
categories (E2B alternatives, Firecracker-based, Kata+CH, WASM sandboxes,
GPU virtualization alternatives, virtual-hardware interception libraries, Docker
optimizations, emerging trends, study repositories, conclusion). Repos with
direct engineering value:

| Repository | Value |
|---|---|
| Mossaka/awesome-agent-sandboxes | 80+ tools: the canonical index of the category |
| e2b-dev/infra | Apache-2.0 self-host reference (Nomad, Consul, Packer, Terraform 1.5.7) |
| arpeetk/open-sandbox-router | provider-agnostic router across e2b, modal, vercel, kubernetes with failover |
| majestic81/firecracker-sandbox-skill | self-hosted E2B-class sandbox: 125 ms, 150 VMs/s, jailer + seccomp |
| joshuaisaact/hearth | local-first KVM microVMs; Apple hypervisor on Mac, Firecracker on Linux |
| zkwentz/sandbox-bench | benchmark suite (Time, Errors, Friction, ToolCalls, Cost) across providers |
| agentstep/mvm | hardware-isolated Linux VMs on Mac in 0.35 s |
| lmasiero/tupper | isolation-tier taxonomy (process/container/microVM) with boot bands |
| copyleftdev/micro-containers | 5-runtime benchmark: runc vs gVisor vs Kata-QEMU vs Kata-FC vs WASM on one 3 MB Go binary |
| stantheawesomeman/memoverlay, cdt4/dolos, pogusthewhisper/fake-nvidia-smi, x0x0x00/gpuadapter, rick-hsu/nvml-unified-shim | the fake-hardware library tier (mechanisms in `viability.md`) |
| fdevx/qemu-bench-method | reproducible QEMU benchmark methodology |

Emerging trends confirmed by the pass: Firecracker dominance for agent
isolation; Rusticl winning after Clover deletion (Mesa 25.2); AVX-512
LLVMpipe on Zen 4 and Sapphire Rapids; WASM fuel metering for infinite-loop
control; free arm64 GitHub runners; Kata + Cloud Hypervisor flexibility.

## Forge mirrors

Distribution mirrors keep the zero-dollar property end to end (the full
publishing workflow is specified in `architecture.md`):

| Mirror | Mechanism | Cost |
|---|---|---|
| GitHub | public repository; Actions unlimited minutes; self-hosted runners optional | $0 for public repos |
| GHCR | container registry storage and bandwidth for public images | $0 |
| npm | package publication with provenance, 21 formats supported across ecosystems (npm, pnpm, yarn, bun, nuget, maven, pypi, cargo, go modules, dart pub, composer, gradle, homebrew, chocolatey, winget, snap, flatpak, helm, oci, mcp, vsix) | $0 |

## Sources

- Wasmtime releases: https://github.com/bytecodealliance/wasmtime/releases - interruption: https://docs.wasmtime.dev/examples-interrupting-wasm
- WASI roadmap: https://wasi.dev/roadmap - component model: https://component-model.bytecodealliance.org
- gVisor platforms: https://gvisor.dev/docs/architecture_guide/platforms - performance: https://gvisor.dev/docs/architecture_guide/performance - releases: https://github.com/google/gvisor/releases
- Kata 4.0.0 overview: https://katacontainers.io/blog/kata-containers-4-0-0-release-overview - releases: https://github.com/kata-containers/kata-containers/releases
- Cloud Hypervisor: https://www.cloudhypervisor.org, https://github.com/cloud-hypervisor/cloud-hypervisor/releases, https://www.phoronix.com/news/Cloud-Hypervisor-53
- WebContainers: https://webcontainers.io and https://blog.stackblitz.com/posts/introducing-webcontainers
- Daytona: https://daytona.io - Modal: https://modal.com - Fly Machines: https://fly.io/machines
- E2B: https://e2b.dev, https://github.com/e2b-dev/e2b, https://e2b.dev/blog/firecracker-vs-qemu, self-host: https://github.com/e2b-dev/infra/blob/main/self-host.md
- Morph: https://morphllm.com/comparisons/daytona-alternative - Cognitora: https://cognitora.dev
- Vercel Sandbox GA: https://vercel.com/blog/vercel-sandbox-is-now-generally-available - $1M challenge: https://vercel.com/blog/one-million-dollar-hacker-challenge-for-vercel-sandbox
- Apple container: https://github.com/apple/container and https://developer.apple.com/videos/play/wwdc2026/389
- Northflank alternatives: https://northflank.com/blog/self-hostable-alternatives-to-daytona - Upstash providers: https://upstash.com/blog/best-sandbox-providers-for-ai-agents
- Mossaka awesome-agent-sandboxes: https://github.com/mossaka/awesome-agent-sandboxes - Unit42: https://unit42.paloaltonetworks.com
- GitHub Actions limits: https://docs.github.com/en/actions/usage-limits - GHCR: https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry
