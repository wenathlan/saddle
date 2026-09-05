# Security - The 2026 Defense Stack

e2ugh protects untrusted code execution with a layered 2026 defense stack:
Landlock, seccomp, eBPF LSM, cgroups v2, post-quantum TLS, CRIU with SELinux
relabeling, and confidential-computing tiers (Intel TDX, AMD SEV-SNP). None of
these layers requires root at sandbox runtime, and each one fails closed. This
document specifies what each layer does, the exact kernel or library versions
that provide it, the threat model of the engine's own spoofing surface, and
the hardening pipeline that guards the repository itself. All facts were
verified against primary sources on 2026-08-22 (date-first discipline; version pins re-verified 2026-08-23) and are
implemented in `security.ts` (1,302 lines). The sandbox engines themselves
(QEMU 11.1.0, Firecracker 1.16.1, gVisor release-20260817.0, Kata 4.1.0,
Cloud Hypervisor v53.0) are described in `virtualization.md`; their selection
policy lives in `alternatives.md`.

Contexts covered (25): Landlock ABI v1-v10 timeline, unprivileged sandboxing,
LANDLOCK_ACCESS_FS_IOCTL_DEV, scopes, abstract UNIX sockets, SIGSYS,
SECCOMP_RET_TRAP, gVisor systrap, deny-by-default profiles, io_uring blocked,
CVE-2026-46315, moby 47532, task-level io_uring restrictions, eBPF LSM,
TOCTOU immunity, Hornet LSM v6, cgroups v2 rootless delegation, ML-KEM
FIPS 203, ML-DSA FIPS 204, X25519MLKEM768, RFC 10024, ChaCha20-Poly1305,
CRIU SELinux relabel, TDX, SEV-SNP.

## Contents

1. [Threat model of the spoofing surface](#threat-model)
2. [Landlock: unprivileged sandboxing at ABI v10](#landlock)
3. [seccomp: the syscall filter baseline](#seccomp)
4. [io_uring: the 2026 security pariah](#io-uring)
5. [eBPF and the eBPF LSM](#ebpf-lsm)
6. [cgroups v2: unified hierarchy and rootless delegation](#cgroups)
7. [Post-quantum TLS](#pqc)
8. [CRIU and SELinux relabeling on restore](#criu-relabel)
9. [Confidential computing: TDX and SEV-SNP](#confidential)
10. [The GPU virtual identity surface](#gpu-virtual identity)
11. [Network and checkpoint security](#network)
12. [Container hardening](#hardening)
13. [Layer composition in security.ts](#composition)
14. [Repository hardening pipeline](#pipeline)
15. [Sources](#sources)

## Threat model of the spoofing surface

e2ugh spoofs hardware identity (CPU model, memory size, GPU inventory) so
that software probing the sandbox believes it runs on high-end hardware. This
is an identity claim, not an isolation claim, and the threat model states both
directions explicitly: spoofing changes what the workload sees, never what the
operator gets.

| Asset | What spoofing protects | What spoofing does not protect |
|---|---|---|
| /proc/cpuinfo, /proc/meminfo | Workloads that gate on hardware identity (installer checks, license probes, benchmark harnesses) see the virtual board | An attacker using CPUID directly sees the real host CPU; only a VM (QEMU `-cpu EPYC-v5`) shapes CPUID |
| nvidia-smi / NVML | Tooling that reads NVML or parses nvidia-smi output reports the virtual GPU inventory | Any attempt to execute real CUDA kernels fails without actual GPUs; PCI device IDs on the bus are real |
| OpenCL/Vulkan device reports | clinfo and vulkaninfo report GPU-class devices backed by Rusticl and lavapipe | Rendering and compute still consume host CPU; there is no confidentiality effect at all |
| Resource limits | Generous shm and swap semantics prevent workload failures | A determined attacker can measure real throughput and infer the absence of hardware acceleration |

Accepted risks, stated plainly: timing side channels reveal software
rendering; CPUID on the bare host (outside QEMU) reveals the true processor;
and a static binary that issues raw syscalls bypasses LD_PRELOAD
interposition entirely (Go static builds, musl static builds). That last gap
is the reason identity spoofing is layered under QEMU or gVisor for hostile
workloads rather than standing alone; the full interposition analysis lives
in `viability.md` (honest limitations).

What the defense stack actually protects: untrusted code cannot escape
through the syscall surface (seccomp deny-by-default plus Landlock at the ABI
level the host kernel provides), cannot exhaust the host (cgroups v2 cpu,
memory, io, pids), cannot reach adjacent services (Landlock scopes and the
network policy in `passage.config`), cannot use io_uring (blocked everywhere
by default), and control traffic resists future cryptanalysis (hybrid
post-quantum TLS). VM-backed sandboxes add the full hypervisor boundary, with
the engine choosing Firecracker, QEMU, Cloud Hypervisor or Kata per the
selection policy documented in `alternatives.md`.

## Landlock: unprivileged sandboxing at ABI v10

Landlock is an unprivileged, stackable LSM: any process can restrict itself
without root, CAP_SYS_ADMIN, or help from a supervisor. The mainline kernel
has reached ABI v10, which turns Landlock into a complete sandboxing
primitive (filesystem, TCP, UDP, IPC, signals) that layers on top of seccomp
rather than replacing it.

| ABI | Kernel | Capability added |
|---|---|---|
| v1 | 5.13 | Filesystem access rights (execute, write_file, read_file, read_dir, remove_dir, remove_file, make_*) |
| v2 | 5.19 | Refer and directory changes (linking/renaming across hierarchies) |
| v3 | 6.2 | File truncate |
| v4 | 6.7 | Network: TCP bind and connect |
| v5 | 6.10 | LANDLOCK_ACCESS_FS_IOCTL_DEV (device ioctls) |
| v6 | 6.12 | Scopes: abstract UNIX socket restriction and signal restriction (SIGSYS on violation) |
| v7 | 6.15 | Audit logging of denials |
| v8 | 6.16 | RESTRICT_SELF TSYNC: no_new_privs propagation to multi-threaded processes |
| v9 | 6.17 | RESOLVE_UNIX scope for path resolution |
| v10 | 6.20 | Network: UDP bind, connect and send |

Engine usage facts, as implemented in `security.ts`: the ABI level is probed
at runtime through `landlock_create_ruleset(NULL, 0,
LANDLOCK_CREATE_RULESET_VERSION)`, the applied ruleset is restricted to the
features the running kernel actually supports, and every probe failure
degrades to the remaining layers instead of aborting the sandbox. Hosts older
than 6.7 get filesystem-only Landlock; hosts on 6.20 or later get the full
unprivileged sandbox with TCP and UDP control. The v6 scopes matter most for
this engine: they cut the abstract UNIX socket channel that would otherwise
let a sandboxed process talk to an unconfined local service, which is the
classic container-escape relay.

## seccomp: the syscall filter baseline

seccomp filters syscalls with BPF programs installed by the process itself
(or its supervisor) before untrusted code runs. The engine builds
deny-by-default filters: every syscall not explicitly allowed returns an
error, matching the Docker default-profile behavior of returning ENOSYS so
denied calls look absent rather than merely forbidden.

| Action | Result for the calling thread |
|---|---|
| SECCOMP_RET_KILL_PROCESS | Process killed immediately |
| SECCOMP_RET_KILL_THREAD | Offending thread killed |
| SECCOMP_RET_TRAP | SIGSYS delivered to the thread; the call appears to return with an error |
| SECCOMP_RET_ERRNO | Configured errno returned (the engine uses 38, ENOSYS) |
| SECCOMP_RET_USER_NOTIF | Supervisor notified and decides; the fd-injection ioctl enables file-descriptor substitution |
| SECCOMP_RET_TRACE / LOG / ALLOW | Ptrace observation, logging, or pass-through |

Three placements of the same mechanism appear across the stack:

1. gVisor systrap. The gVisor Sentry itself is entered through
   SECCOMP_RET_TRAP: every guest syscall raises SIGSYS, and the signal
   handler in the Sentry emulates the call in userspace. RET_TRAP is thus the
   foundation of the default gVisor platform (release-20260817.0), not merely
   a debugging tool.
2. Second-layer seccomp inside gVisor. The Sentry additionally installs its
   own seccomp-bpf filter to constrain which syscalls can even reach the
   Sentry - defense in depth inside the sandbox runtime itself.
3. The engine profile. `security.ts` ships a Docker-default-compatible
   profile allowing roughly 140 syscalls with the privileged set denied, and
   a policy proxy that hard-fails any profile build that does not deny the
   io_uring family (next section).

## io_uring: the 2026 security pariah

io_uring is the kernel's high-performance asynchronous I/O subsystem, and as
of 2026 it is treated as a sandbox liability across the industry. The engine
position is simple: the io_uring family stays blocked in every sandbox
profile, and the performance cost is accepted (asynchronous file I/O inside
sandboxes uses thread pools instead). The kernel-side velocity work that uses
io_uring on the host (ZCRX receive, NVMe passthrough) is documented in
`performance.md` and operates outside the sandbox boundary.

| Actor | Position on io_uring in sandboxes |
|---|---|
| Docker default seccomp profile | Blocks io_uring syscalls since moby issue 47532 |
| gVisor | io_uring disabled by default in runsc |
| Kubernetes v1.33 audit and CIS benchmarks | Recommend blocking io_uring in container profiles |
| CVE record | CVE-2026-46315 (June 2026): information disclosure through io_uring |
| LWN, January 2026 | Task-level io_uring restrictions patchset: per-task limits designed to compose with seccomp, addressing the fact that SQPOLL and kernel-side offload can bypass a naive seccomp filter |

On x86_64 the blocked syscall numbers are io_uring_setup (425),
io_uring_enter (426) and io_uring_register (427). The engine denies the
family with ENOSYS, logs each denial as a policy audit event, and tracks the
LWN task-level restriction work as the only credible future path toward
re-enabling io_uring for trusted workloads.

## eBPF and the eBPF LSM

The eBPF LSM (Linux Security Module) interface, available since kernel 5.7,
attaches verified BPF programs to LSM hooks. The property that distinguishes
it from tracepoints and syscall tracing is TOCTOU immunity: LSM hooks execute
at the exact kernel decision point (file open, credential change, socket
operation), so there is no gap between the observation and the enforcement in
which an attacker could change the target object. Tracepoint-based policy
suffers precisely that gap - check-then-bind races - which is why the engine
treats eBPF LSM as the audit plane and ptrace/strace as debug-only tools
(measured in `performance.md`: eBPF tracing at 2 percent overhead versus
strace at 12x slowdown).

| Fact | Detail |
|---|---|
| Availability | Kernel 5.7 and later; enabled through the BPF LSM in the kernel security list (`/sys/kernel/security/lsm`) |
| Verification | Programs are verified by the kernel verifier at load time; hooks cannot corrupt kernel state |
| Hornet LSM v6 (April 2026) | Verifies eBPF program signatures in-kernel, closing the gap where an attacker with root loads a hostile BPF policy |
| Cloudflare practice | Uses eBPF LSM to live-patch vulnerability classes (CVE-2024-1086-style exploitation paths) on running fleets without rebooting |

The engine attaches counters to security_file_open, security_socket_create
and related hooks for intrusion telemetry, and uses a tracepoint on
sys_enter_io_uring_setup purely to count denied async I/O attempts. BPF
programs are never loaded inside sandboxes; they observe the host side only,
keeping the sandbox footprint free of privileged eBPF usage. The broader eBPF
networking and observability surfaces (XDP at 14 Mpps, ring buffers, Tetragon
per-VM syscall filtering, BPF arenas on kernel 6.17) are specified in
`performance.md` (observability) and `virtualization.md` (passage).

## cgroups v2: unified hierarchy and rootless delegation

cgroups v2 provide the resource envelope every other layer sits inside. The
unified hierarchy is the default on every modern distribution (RHEL 9 and
later, Ubuntu, Arch; managed by systemd), and the controllers the engine
uses are cpu, memory, io and pids. The multi-tenant scheduler (MTTG) that
consumes this layer is documented in `virtualization.md`; this section
covers only the security-relevant envelope.

| Controller | Engine setting | Purpose |
|---|---|---|
| cpu.max | Quota and period | CPU bandwidth per sandbox, maps Docker --cpus |
| cpu.weight | 1-10000 | Relative share under contention, per tenant QoS class |
| memory.max | Hard limit | Resident memory ceiling |
| memory.high | Soft throttle | Backpressure before the hard ceiling |
| memory.swap.max | Swap limit | Composes with --memory-swap -1 (unlimited) on the Docker path |
| pids.max | Process ceiling | Fork-bomb containment inside the sandbox |
| io.max / io.weight | Device I/O limits | Writeback-aware I/O control on the unified hierarchy |

Delegation is the reason rootless operation works: systemd subtree delegation
hands a cgroup subtree to an unprivileged user, and Podman and Docker rootless
use exactly that mechanism to run the whole container stack without root. The
engine writes its cgroup layout only into delegated subtrees and refuses to
touch the host root cgroup. This layer is what makes the Docker memory flags
from `performance.md` enforceable rather than advisory.

## Post-quantum TLS

Transport security in 2026 is post-quantum by default on this stack,
protecting sandbox control traffic against harvest-now-decrypt-later
collection.

| Primitive | Standard | Status in the engine stack |
|---|---|---|
| ML-KEM | FIPS 203 | Module-lattice key encapsulation; native in OpenSSL 3.5 |
| ML-DSA | FIPS 204 | Module-lattice signatures; native in OpenSSL 3.5 |
| SLH-DSA | FIPS 205 | Hash-based signatures; available for long-lived keys |
| X25519MLKEM768 | RFC 10024 mechanism | Hybrid classical-plus-PQ group; default TLS 1.3 key exchange in OpenSSL 3.5 |
| RFC 10024 | Published 2026-08-10 | Standardizes the PQ/T hybrid mechanisms for TLS 1.3 |
| ChaCha20-Poly1305 | RFC 8439 | Symmetric AEAD fallback for hosts without AES-NI |

The deployment consequence the engine relies on: OpenSSL 3.5 LTS ships
X25519MLKEM768 as the default TLS 1.3 group, and Node 24 bundles OpenSSL
3.5.5, so any TLS connection the orchestrator or the sandbox SDK makes
negotiates a hybrid post-quantum key exchange with zero additional code. The
secure-context builder in `security.ts` still pins the group list
(`X25519MLKEM768:X25519`) and TLS 1.3 as the minimum version so the guarantee
survives configuration drift. Client-side deployment is broad: Chrome,
Firefox and Brave prefer PQ groups, Cloudflare terminates them globally, and
AWS exposes PQ TLS in KMS, ACM and Secrets Manager. For symmetric encryption
on hosts without AES-NI, ChaCha20-Poly1305 remains the correct AEAD:
AES-256-GCM is up to three times faster with AES-NI, but ChaCha20 wins on
hardware without that acceleration (typical ARM and older x86_64 hosts), and
the cipher list keeps it available as the fallback. The same ChaCha20 stream
also encrypts CRIU checkpoint images (section on restore below).

In code, `security.ts` owns this surface end to end - the v3 redistribution
moved the post-quantum feature set out of the retired `future.ts` and back
into the security domain. Two symbols carry it: the `Rfc10024` negotiator
selects and pins the hybrid group list (X25519MLKEM768 first, X25519
classical fallback), and `PqcAuditTrail` is the tamper-evident chain for
every post-quantum key operation: append-only, hash-linked entries with an
ML-DSA signature over each link, so negotiation drift and key-usage anomalies
are detectable after the fact, not merely preventable. RFC 10024 was
published 2026-08-10 and standardizes exactly these PQ/T hybrid mechanisms
for TLS 1.3.

## CRIU and SELinux relabeling on restore

CRIU v4.2.1 checkpoints and restores process trees, and the restore path is
where label hygiene matters: an image dumped from an SELinux-confined process
must not come back with a different or missing label. CRIU supports LSM
profile restoration (`--lsm-profile selinux:<label>`), so restored processes
re-enter their original SELinux context. The `criurelabel` planner in
`security.ts` emits the relabel arguments plus a `chcon` fallback for image
trees when the CRIU build lacks the LSM option, and a policy audit event
records every relabel. Checkpoint images themselves are encrypted with
ChaCha20-Poly1305 (RFC 8439), so a stolen snapshot file does not leak guest
memory. This closes the loop with the checkpoint/restore usage described in
`virtualization.md`: warm starts must not become a downgrade attack on
label-based isolation.

## Confidential computing: TDX and SEV-SNP

For deployments where even the host operator is untrusted, the engine plans
two hardware confidential-computing tiers. QEMU 11.1.0 exposes both machine
types directly: `tdx-guest` with `sept-ve-disabled`, and `sev-snp-guest`
with `cbitpos=51 reduced-phys-bits=1` (both wired through the QEMU wrapper in
`virtualization.ts`). This section carries 27 documented contexts from the
2026-08-22 research pass.

| Context | Verified fact |
|---|---|
| Intel TDX baseline | TDX support improved through QEMU 10.1 and solidified in 11.1 |
| TDX module live update | Linux 7.2 updates the TDX module without reboot |
| TDX guest flag | `-machine q35 -object tdx-guest,sept-ve-disabled=on` in the QEMU wrapper |
| CVE-2026-20885 | TDX module vulnerability, INTEL-SA-01436, disclosed March 2026 |
| Google + Intel joint audit | 9 months, 10 security issues found and fixed |
| AMD SEV-SNP host floor | QEMU 9.2 host stack, kernel 6.14, Ubuntu 25.04 |
| SEV-SNP launch measurement | Attested launch measurement over guest memory |
| Attestation standards | RATS RFC 9334, AMD KDS, NVIDIA NRAS remote attestation |
| SVSM | VMPL2 vTPM, stateful, with virtio-blk backing |
| Key Broker Service | Trustee 0.12.0 KBS proxy for secret release |
| Secret injection | SEV secret area via config table; OVMF encrypted boot; Grub FV |
| Kata confidential pod | kata-qemu-nvidia-gpu-snp runtime class through CRI-O |
| Confidential GKE Nodes | H100 GA on Google Cloud (Blackwell generation announced) |
| Post-quantum attestation | Phase 4: Dilithium/ML-DSA signatures in the attestation chain |
| Other TEEs | Intel SGX, ARM CCA (Realm Management Extension) |
| Device migration | VFIO migration protocol v2 (QEMU 8.0+) for passthrough devices |

Positioning inside e2ugh: confidential tiers are optional depth rungs on the
detection-isolation ladder. The spoofing thesis (see `viability.md`) does not
require them; they exist for operators who must also defend the host-side
boundary against physical inspection. The GPU angle matters here too:
confidential computing with GPUs (MIGv2 plus CC mode on Blackwell, driver
570.124+) is tracked in `hardware.md`.

## The GPU virtual identity surface

The GPU identity layer rests on four public interception libraries, each
covering a different read channel. From a security standpoint these are
presence spoofing only - they answer inventory questions, never execute
kernels on silicon - and their honest limits are analyzed in `viability.md`.

| Library | Mechanism | Security-relevant scope |
|---|---|---|
| pogusthewhisper/fake-nvidia-smi | Pure-Python (stdlib only) fake CLI with flex profiles h100 81,559 MiB and a100 40,536 MiB | Replaces one binary; byte-format matches the NVIDIA manual (driver 575.57.08, CUDA 12.9) |
| x0x0x00/gpuadapter | CUDA API interception: libcuda, libcudart, libcublas, libnccl via LD_PRELOAD (DYLD on macOS); `--devices "a100:2,h100:2"` profiles | Interposes the CUDA surface itself; includes virtual nvidia-smi adapter --query-gpu, topo, MIG views |
| rick-hsu/nvml-unified-shim | libnvidia-ml shim; nvmlDeviceGetCount falls back to cudaGetDeviceCount; GB10/Blackwell era | Serves NVML readers (pynvml, gpustat) without a driver |
| ssst0n3/fake-nvidia | Stub kernel module plus libnvidia-ml.so.1 returning false inventories | Kernel-adjacent tier for hosts that probe module state |

The fourth entry is the only one that touches kernel territory, and the
engine treats it as out of scope for sandbox deployments: loading modules
defeats the rootless property that the rest of the stack preserves. The
engine's own SMI table renderer (in `render.ts` and the Python bridge
`qemubridge.py`) generates the same vocabulary (`memory.total`,
`utilization.gpu`) as the public libraries, keeping the surface auditable in
one place.

## Network and checkpoint security

The passage data-plane (six modes, from direct to zero-trust) is specified in
`virtualization.md`; this section fixes the security constants that survive
across all modes.

| Control | Setting |
|---|---|
| Gateway TLS | TLS 1.3 only (min and max), ciphers TLS_AES_128_GCM_SHA256, TLS_AES_256_GCM_SHA384, CHACHA20_POLY1305_SHA256; curves X25519, P-256, P-384; ALPN h2, h3 |
| Snapshot rollback | Five phases: detect (circuit breaker opens after 5 failures) - quiesce (guest-agent fs-freeze, pipeline drain) - loadvm - verify - reattach (network reattach plus GPU rebind through a fresh iommufd object) |
| Write-ahead log | Append-only JSONL per VM; idempotency token via node:crypto randomUUID; duplicates deduplicated on replay |
| Audit | RBAC roles admin/tenant/developer; immutable per-tenant JSONL audit log; OTEL audit_logged counter |
| Admission | seccomp plus AppArmor profiles on every gateway process |

Endpoint discipline: every listener binds to a user-resolved host on a
cryptographically random port (crypto.randomInt in the 30000-59999 band); no
component of the engine ever hardcodes an address, and the guards in
`orchestrator.ts` reject loopback defaults at construction time.

## Container hardening

Per-runtime hardening beyond the shared profile:

| Runtime | Hardening stack |
|---|---|
| Firecracker 1.16.1 | jailer (cgroup v2, netns, chroot, seccomp), api-sock on a locked-down Unix socket |
| gVisor release-20260817.0 | systrap platform (RET_TRAP), second-layer seccomp, DirectFS only where needed |
| Kata 4.1.0 | runtime-rs rootless baseline plus seccomp on the QEMU hypervisor process |
| Cloud Hypervisor v53.0 | seccomp profile on the VMM thread; vfio-user devices through validated sockets |
| Docker 29.7.2 path | no-new-privileges, Tini as PID 1, `--read-only` rootfs with tmpfs carve-outs, AutoRemove |

The engine-level composition adds Landlock scopes on top of whichever
runtime tier is active, so a sandbox that somehow reaches an unconfined
process still cannot open abstract UNIX sockets or send signals outside its
group on kernels 6.12+.

## Layer composition in security.ts

The shipped profile composes four layers, each deny-by-default, each failing
closed:

1. Landlock ruleset (ABI-probed): read-only trees, write trees, device
   ioctl gate, TCP and UDP scopes where the kernel supports them, abstract
   UNIX socket and signal scopes.
2. seccomp filter: roughly 140 allowed syscalls, privileged set denied with
   ENOSYS, io_uring family denied unconditionally; profile builds that omit
   the io_uring denial refuse to compile.
3. cgroups v2: cpu, memory, swap, pids and io limits inside a delegated
   subtree only.
4. CRIU restore policy: SELinux relabel mandatory unless explicitly
   disabled, every override audited.

A security self-check runs at engine startup: it verifies the Landlock ABI
level of the host, confirms the seccomp profile denies io_uring_setup,
checks that cgroup writes land in the delegated subtree, confirms the TLS
group list starts with X25519MLKEM768, and reports each result as a
pass/fail fact rather than a silent default. Runtime smoke checks recorded
during the v2 build: `detectlandlockabi('6.20.0')` returns 10, and the
seccomp builder's io_uring_setup denial evaluates true on every profile.

## Repository hardening pipeline

The repository guards itself with the `security.yml` workflow (eight gates,
all pinned to versions verified 2026-08-22). The workflow file carries the
authoritative configuration; this section summarizes the gates and their
blocking semantics.

| Gate | Tool (pinned version) | Blocks on |
|---|---|---|
| CodeQL | github/codeql-action@v4.37.8, languages cpp + javascript-typescript | Any query result at the configured severities; C/C++ uses manual build-mode extraction over libs/ |
| Dependency review | actions/dependency-review-action@v5.0.0 | High or critical advisories and incompatible licenses on PRs and main pushes |
| Container scan | Dockle v0.4.15 and Trivy v0.36.0 | Dockle FATAL findings; Trivy CRITICAL CVEs (ignore-unfixed), SARIF uploaded to code scanning |
| Secret scan | gitleaks-action@v3.0.0, full git history (fetch-depth 0) | Any detected credential in any commit |
| Scorecard | ossf/scorecard-action@v2.4.4 | Results published to the public Scorecard API (weekly plus main pushes) |
| Biome security | @biomejs/biome@2.5.11, security group at error severity | noSecrets (error level on json/yml/toml/env overrides), noGlobalEval, noDangerouslySetInnerHtml |
| License check | license-checker, permissive allow list (MIT, Apache-2.0, ISC, BSD, 0BSD, Unlicense, CC0, Zlib, MPL-2.0, others) | Any copyleft or unlicensed runtime dependency; missing root LICENSE |
| Snyk (optional) | snyk/actions/node, guarded by SNYK_TOKEN | Never gates (continue-on-error); findings surface in logs |

The CI graph (six gates in `ci.yml`), the provenance and SBOM publishing in
`publishghcr.yml` (the combined container pipeline), and the complete workflow inventory are documented
in `architecture.md`; the security-relevant property repeated here is that
the default workflow permission is `contents: read` and each job elevates
only what it needs (security-events: write for SARIF uploaders, id-token:
write for the Scorecard publication).

## Sources

- Landlock kernel documentation: https://docs.kernel.org/userspace-api/landlock.html
- Landlock project news and ABI timeline: https://landlock.io/news
- LWN Landlock coverage: https://lwn.net/Articles/1021648 and https://lwn.net/Articles/1050309
- seccomp manual page: https://man7.org/linux/man-pages/man2/seccomp.2.html
- gVisor platforms (systrap, RET_TRAP): https://gvisor.dev/docs/architecture_guide/platforms
- gVisor seccomp layers: https://gvisor.dev/blog/2024/02/01/seccomp
- Docker default profile blocking io_uring: https://github.com/moby/moby/issues/47532
- CVE-2026-46315 record: https://sentinelone.com/vulnerability-database/cve-2026-46315
- io_uring hardening analysis: https://systemshardening.com/articles/linux/io-uring-hardening
- LWN task-level io_uring restrictions: https://lwn.net/Articles/1054225
- eBPF LSM documentation: https://docs.kernel.org/bpf/prog_lsm.html
- Cloudflare eBPF LSM live patching: https://blog.cloudflare.com/live-patch-security-vulnerabilities-with-ebpf-lsm
- Hornet LSM v6 (LKML): https://lkml.iu.edu/2604.3/10670.html
- cgroup v2 kernel documentation: https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html
- systemd cgroup delegation: https://systemd.io/CGROUP_DELEGATION
- systemd resource control: https://www.freedesktop.org/software/systemd/man/systemd.resource-control.html
- OpenSSL post-quantum: https://openssl-corporation.org/post-quantum.html
- OpenSSL 3.5 PQ defaults analysis: https://postquantum.com/security-pqc/openssl-3-5-pqc-default
- RFC 10024 (PQ/T hybrids for TLS 1.3): https://datatracker.ietf.org/doc/rfc10024/
- RFC 8439 (ChaCha20-Poly1305): https://datatracker.ietf.org/doc/rfc8439/
- AWS PQ TLS details: https://docs.aws.amazon.com/sdkref/latest/guide/pqtls-details.html
- Cloudflare PQC support: https://developers.cloudflare.com/ssl/post-quantum-cryptography/pqc-support/
- CRIU releases: https://github.com/checkpoint-restore/criu/releases
- CRIU project: https://criu.org
- QEMU 11.1.0 announcement: https://www.qemu.org/2026/08/11/qemu-11-1-0/
- Intel TDX and INTEL-SA-01436: https://www.intel.com/content/www/us/en/security-center/advisory/intel-sa-01436.html
- AMD SEV-SNP: https://www.amd.com/en/products/processors/server/epyc/security/sev-snp.html
- RATS RFC 9334: https://datatracker.ietf.org/doc/rfc9334/
- CoCo Trustee (KBS): https://github.com/confidential-containers/trustee
- fake-nvidia-smi: https://github.com/pogusthewhisper/fake-nvidia-smi
- GpuAdapter (CUDA API interception): https://github.com/FanBB2333/GpuAdapter
- nvml-unified-shim: https://github.com/rick-hsu/nvml-unified-shim
- fake-nvidia stub: https://github.com/ssst0n3/fake-nvidia
- OSSF Scorecard: https://github.com/ossf/scorecard
- gitleaks: https://github.com/gitleaks/gitleaks
- Dockle: https://github.com/goodwithtech/dockle
- Trivy: https://github.com/aquasecurity/trivy
