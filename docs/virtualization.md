# e2ugh v6 - Virtualization Stack Reference

This document specifies the execution layer of the engine: QEMU 11.1.0 and KVM, the boot chain (OVMF, Secure Boot, measured boot), libvirt overlay, the GPU passthrough triad (VFIO, vGPU, MIG), the passage network stack, storage volumes, Docker 29.7.2 and containerd integration, the microVM engines (Firecracker, Cloud Hypervisor, gVisor, Kata, CRIU), the MTTG multi-tenant scheduler with cgroups v2, passage security with snapshot rollback, the Mesa rendering summary, the WASM tier, checkpoint/restore and the alternative hypervisors. Hardware identities are in `hardware.md`; orchestration policy and module wiring are in `architecture.md`; the spoofing threat model is in `security.md`.

Context map (24 related contexts): QEMU 11.1.0, MTTCG internals, QMP, EPYC-v5,
microvm and q35 machines, KVM-less runners, OVMF secure boot, swtpm,
libvirt overlay, vm.config schema, VFIO, vGPU unlock, MIG, Looking Glass,
passage six modes, OVS and DPDK, XDP and eBPF, io_uring ZCRX, WireGuard
zero-trust, storage volumes, Docker 29.7.2, containerd microVMs, MTTG
cgroups v2, checkpoint/restore, Mesa stack summary, WASM tier.

---

## 1. Stack overview (24 layers)

| # | Layer | Version (2026-08-23) | Role |
| --- | --- | --- | --- |
| 1 | QEMU | 11.1.0 | full-system TCG/MTTCG and KVM guests |
| 2 | KVM | kernel 7.1.9 stable / 6.18.45 longterm host | hardware acceleration when `/dev/kvm` exists |
| 3 | HVF / WHPX | macOS / Windows | same plan, different `-accel` |
| 4 | libvirt | 12.5.0 (overlay only) | optional XML lifecycle, hooks, nodedev detach |
| 5 | VFIO / IOMMU | kernel | device passthrough group isolation |
| 6 | vendor-reset | - | reset quirks for Navi and older NVIDIA ids |
| 7 | single-GPU passage | - | unbind/rebind host console flow |
| 8 | NVIDIA vGPU | R570/R580 branches | licensed GRID profiles |
| 9 | AMD MxGPU / SR-IOV | ROCm 7.x | VF passthrough on Instinct |
| 10 | virtio-gpu Venus | Mesa both sides | Vulkan in the guest via virtio |
| 11 | Docker Engine | 29.7.2, API 1.52 | default execution path |
| 12 | Dockerfile / Buildx | syntax 1.14 / 0.36.1 | multi-stage image builds, GHA cache |
| 13 | Podman / nerdctl | 6.1 | rootless OCI twins |
| 14 | Firecracker | 1.16.1 | 125 ms microVMs, snapshot warm pools |
| 15 | Cloud Hypervisor | 53.0 | rust-vmm VMM, vfio-user |
| 16 | Kata Containers | 4.1.0 | VM-per-container, runtime-rs |
| 17 | gVisor | release-20260817.0 | userspace kernel (runsc, systrap) |
| 18 | Wasmtime / WASI | 48.0.0 / 0.3.0 | fuel-metered component tier |
| 19 | Incus / LXD | 7.2 / 6.0.4 | system containers plus VM mode |
| 20 | KubeVirt | current | CRDs wrapping QEMU |
| 21 | nested virtualization | - | Docker-in-QEMU, WSL2-in-QEMU |
| 22 | snapshots | - | qcow2 internal/external, migrate-to-file |
| 23 | live migration | QEMU 11 | pre-copy/post-copy, multifd |
| 24 | swtpm | 2.0 | TPM 2.0 emulator, measured boot |

## 2. QEMU 11.1.0 and KVM

Released 2026-08-11 with more than 3200 commits from 285 authors and 12 CVE fixes. Release line relevant to the engine: 10.1.0 (2025-08-26, previous generation baseline), 11.0.0 (2026-04-22: nitro accelerator, CET virtualization, Diamond Rapids CPU model, TCG plugins in C++, 32-bit x86 hosts dropped), 11.1.0 (UFS 4.1 emulation, vhost-host-user virtio-rtc, hvf nested virtualization).

### 2.1 MTTCG (one host thread per vCPU)

Multi-threaded TCG lets a KVM-less host run a parallel guest. Four load-bearing parts:

1. Per-vCPU host threads: one QEMUThread per vCPU, each running its own translation loop; a 192-vCPU guest is 192 host threads plus main loop and async workers (verified with `ps -T`).
2. TranslationBlock cache: one shared code buffer sized by `tb-size` MiB; blocks translated by vCPU 0 are reused by vCPU 1; large code footprints (LLVM, kernel builds) want 512-1024 MiB - the engine passes 1024 (1536 in the older F1 template; `qemu.config` keeps both as documented variants).
3. QHT (`util/qht.c`): lockless, RCU-protected hash from guest PC to TranslationBlock; readers scale without contention, which makes the shared cache viable.
4. Cross-thread invalidation through RCU lists and tb_lock; guest-side JITs (V8, JVM) trigger invalidation storms, so JIT-heavy workloads route to Docker instead.

Memory-model rule (when MTTCG is enabled):

| Guest on host | MTTCG | Consequence |
| --- | --- | --- |
| x86_64 on x86_64 | allowed, the default | the engine case; one host thread per vCPU without explicit flags |
| aarch64 on x86_64 | allowed (weak on strong) | cross-arch CI works |
| x86_64 on aarch64 | not allowed | falls back to single-threaded TCG |
| any with `-icount` | forced single-thread | deterministic virtual time and record/replay are incompatible with MTTCG |

Flag form and implementation anchors: `--accel tcg,thread=multi,tb-size=1024`; `tcg-accel-ops-mttcg.c` with `mttcg_qemu_thread_new` / `tcg_register_thread` / `qemu_thread_create`; queues at 2 x vCPU; near-linear scaling to 192 vCPUs with under 8% overhead; never combined with KVM (TCG and KVM are alternative accelerators). Naming warning: MTTCG is not MTTG (section 12).

### 2.2 CPU models and machines

`-cpu EPYC-v5` is the engine default (confirmed in `target/i386/cpu.c`; EPYC-v4 covers Zen 4); the turbo argv in `virtualization.ts` uses `DiamondRapids` with `host-phys-bits=true`, `hidden=1` and the `NV43FIX` hv_vendor_id that keeps NVIDIA drivers alive inside guests (`kvm=off` equivalents for hiding the hypervisor); portable ladders `EPQC-Genoa` / `GraniteRapids` / `SierraForest` / `qemu64`; `host` is KVM-only and never used in CI. Machines: `q35` with `smm=on,kernel-irqchip=split` for identity-complete guests; `microvm` with direct kernel boot for boot-latency-sensitive tests (about 4x faster than the default PC machine); the nitro accelerator remains a reference for AWS-shaped enclaves.

### 2.3 QMP runtime surface

Runtime control runs over QMP on a unix socket (`-qmp unix:/run/qemu-<id>.qmp,server,nowait`); the bridge clients (`qemubridge.py`, `qemuruntime`, the C++ `QmpClient`) speak this surface:

| QMP/HMP call | Purpose in the engine |
| --- | --- |
| `query-status` | lifecycle inspection feeding `vm:phase` events |
| `query-cpus-fast` | per-vCPU thread accounting for the MTTG floor checks |
| `device_add` (`epyc-v5-x86_64-cpu`) | CPU hotplug; requires `maxcpus` headroom on `-smp` |
| `device_add` (nvme namespace, vfio-pci) | device hotplug for storage and GPU attach |
| `snapshot-save` / `snapshot-load` | internal snapshots for the pool |
| `migrate` (to file, `tcp:host:port`) | pool warm boots and live migration |
| `balloon` / `object-add` (memory-backend, cxl-type3) | memory elasticity commands exported by `memorymodularizer` |
| `query-qemu-features` | feature probe absorbed from the v5 bridge |
| `dirty-rate` (page-sampling) | migration readiness polling |
| `qmp_capabilities` handshake | greeting filter with the 1 MiB read cap on the C++ side |

Since QEMU 11.0, TCG plugins written in C++ observe guest execution (instructions, memory accesses, translation events) without changing translated code - the engine uses them for guest-activity telemetry in research builds. A duplicate `-qmp` push in the inherited wrapper argv was deduplicated during the v2 merge (documented in the module header). Live-migration tuning recovered from the v4 production pool: xbzrle compressed transfer with a 64 MiB cache, auto-converge on CPU-throttle convergence, and `-accel kvm,dirty-ring-size=65536` (the same dirty-ring size the appendix B F-005 target assumes for sub-800 ms vGPU pre-copy).

### 2.4 Running without KVM

GitHub-hosted runners do not expose `/dev/kvm` ([actions/runner-images#12933](https://github.com/actions/runner-images/issues/12933)); a February 2025 community incident showed the implicit TCG fallback can break, so the engine always passes the accelerator explicitly. Policy: TCG is 10-30x slower than KVM for CPU-bound guests and CI timeouts scale accordingly; Firecracker/Kata/CLH paths run only on self-hosted or bare-metal runners and the factory refuses them without KVM (KVM detector in `orchestrator.ts`), suggesting the QEMU TCG strategy instead of failing at boot.

## 3. Boot: OVMF, Secure Boot, measured boot

OVMF/EDK2 edk2-stable202605 (released 2026-05-22; the tag format is edk2-stableAAAMM, so day-level spellings such as 20260213 do not exist): `OVMF_CODE_4M.secboot.fd` plus `OVMF_VARS_4M.fd` on pflash with `readonly=on` for code; Secure Boot with SMM; measured boot into a swtpm 2.0 TPM 2.0 (socket 0600 qemu:qemu, TPM 2.0 emulator for BitLocker-class workflows); SHIM plus Grub FV paths for signed distributions; boot order `ncd` with menu timeout; `reboot_on_panic` behavior documented. Host tuning at boot: `transparent_hugepage` policy (always/madvise/never), KSM/UKSM toggles, memory prealloc with `share=off`, ACPI SRAT for sp-mem, NVDIMM emulation, DAMON mtier hooks. Intel TDX (the module live update without reboot is a documented kernel technique, applied through `sept-ve-disabled`) and SEV-SNP (cbitpos=51, reduced-phys-bits=1) guest objects are one flag away in the turbo argv; the confidential-computing posture (RATS RFC9334 attestation, KDS, SVSM VMPL2 vTPM) is specified in `security.md`.

Boot chain, flag by flag:

| Boot element | QEMU form | Purpose |
| --- | --- | --- |
| firmware code | `-drive if=pflash,format=raw,readonly=on,file=OVMF_CODE_4M.secboot.fd` | UEFI with Secure Boot keys |
| firmware vars | `-drive if=pflash,format=raw,file=OVMF_VARS_4M.fd` | per-guest variable store |
| SMM | `-machine q35,smm=on` + `kernel-irqchip=split` | Secure Boot requires SMM |
| measured boot | `-device tpm-tis,tpmdev=tpm0 -tpmdev emulator,id=tpm0,chardev=socket` | PCR extension into the vTPM |
| swtpm socket | `chardev=socket,path=/run/swtpm-<id>.sock,server=nowait` | 0600 qemu:qemu permissions |
| 64-bit MMIO window | `-fw_cfg opt/ovmf/X-PciMmio64Mb,string=65536` | 64 GB window for 32 GB+ BARs |
| TPM crb (forge path) | `-device tpm-crb,tpmdev=tpm0` | the forge-mode twin |

## 4. libvirt overlay

libvirt 12.5.0 remains optional: `qemu.conf` ships as a drop-in for `/etc/libvirt/qemu.conf.d/` (14 device entries in the overlay section of `qemu.config`). The overlay consumes: domain XML `cputune` (`vcpupin`, `emulatorpin`, `iothreadpin`), `numatune` (bind/preferred/interleave), memory backing (hugepages, memfd), `nodedev-detach`/`nodedev-reattach` for VFIO with the dynamic-binding hook (alive check, 10 s cooldown, BAR2 `resource2_resize`), driverctl persistent overrides, ACS override as a last resort (security smell, warned), virtiofsd 1.14.0 (9p removed in the runtime-rs lineage), EROFS snapshotter, nydus 0.15.13, vhost-net/vhost-user, OVS/DPDK/AF_XDP integration, MicroOVN, Incus 7.2 as the lxc|qemu driver daemon.

## 5. VM configuration spec

`vm.config` is one schema in three serializations (JSON machine twin with 22 profiles, TOML human file, INI-like forge variant; deterministic SHA-256 identity). Sections: `meta` (name, uuid, version, format_version, hypervisor), `vcpu` (model, count, topology sockets/cores/threads/dies, pinning array, unlimited bool, cpu_flags `+avx512f +avx512bw -vmx`), `vmem` (size_mb, vramMb, ballooning, hugepages 1G/2M), `numa` (nodes, policy bind, host_nodes), `host_tuning` (THP never, KSM false, mem_prealloc), `firmware` (ovmf code/vars, secureBoot, smm), `boot` (order, menu, timeout), `disks` (qcow2/raw/nvme/vfio, cache none, io io_uring, discard unmap), `net_passage` (bridge, macvtap, passthrough, vhost-user, user), `mttg` (groups, tenant_id, cpus shares, quota, memoryMax, iothreadPin), `qemu` (binary, machine q35, accel kvm, argsExtra), `docker` (enabled, runtime, socket, sidecar_containers, compose_file, engineVersion 29.7.2), `telemetry` (prom_port, logLevel), validation via JSON Schema 2020-12 with `$defs` and `unevaluatedProperties` (ajv 8+ compatible). The planner CLI reads the TOML, plans topology, emits QEMU argv and a `docker run` line, and lints (`planlint`: mttg floor at vcpus, overcommit at most 64, vcpus at most 4096, topology-product warning).

## 6. GPU passthrough: VFIO, vGPU, MIG

Identity data, MIG profile tables and the vGPU size formula live in `hardware.md` sections 4 and 6; this section covers the mechanics.

- **VFIO/IOMMU.** `intel_iommu=on iommu=pt` or `amd_iommu=on`; group isolation verified with `find /sys/kernel/iommu_groups`; the bind path in `virtualgpu.ts` uses driverctl with the `new_id` fallback, `disable_idle_d3=1`, `pcie_port_pm=off`, and an alive check; unbind restores the host driver. QEMU device form: `-device vfio-pci,host=01:00.0,multifunction=on,x-vga=on,romfile=vendor.rom,rombar=1` with `-vga none -nographic`; BAR1 at 32 GB (Blackwell) needs Above-4G + ReBAR, the 64 GB MMIO window via `-fw_cfg opt/ovmf/X-PciMmio64Mb,string=65536`.
- **vendor-reset.** Navi 21 and some NVIDIA ids need the reset quirk (`vendor-reset` module families polaris10 through navi48 in `vendorresetfamilies`) or the GPU stays dead after the first VM; RDNA 3/4 and Blackwell are closer to native on 6.12-6.14 kernels.
- **romfile.** sysfs rom dump (echo 1/0 to the rom node), rombar, 4-byte pptable patches, IGD passthrough for Gen11/12 with `x-igd-lpc` on the LPC bridge.
- **vGPU.** Licensed GRID profiles (R570/R580 branches; vgpu-unlock lineage with vcfgclone and general-merge patchers, the vgpu_unlock-rs Rust LD_PRELOAD rewrite); the profile-size formula and the 384 MiB minimum framebuffer are code in `virtualgpu.ts`.
- **MDEV/SR-IOV.** mdev sysfs types (`nvidia-b100-mig-*` for Blackwell layouts); Intel `i915-sriov-dkms` 2026.08.02 with `xe.max_vfs=7`, `xe.force_probe=0xa7a0`; AMD MxGPU temporal partitioning.
- **Looking Glass B7.** D3D12 `ID3D12Resource` path over IVSHMEM DMA with zero CPU copy (about 300 UPS), kvmfr module 0.0.12-7 (kernels 6.13+), 128 MiB shmem default; the XML recipe ships in `virtualgpu.ts` (`lookingglassb7`).
- **virtio-gpu Venus.** Vulkan in the guest via the venus native context with `blob=on` and `hostmem=` as the VRAM window (`-device virtio-gpu-gl-pci,venus=true,hostmem=8G` in the turbo argv); Mesa on both sides.

Passthrough PCI id table (the ids `passage.config` binds with driver quirks; the GN8is row was recovered from the v4 CUDA research):

| PCI ID | Device | Note |
| --- | --- | --- |
| 10DE:2B85 | RTX 5090 | primary passage pair, vendor-reset not needed |
| 10DE:22E8 | GN8is L20-48G (L20-class Ada, 48 GB) | cloud GN8is shape; recovered from the v4 pool CUDA notes |
| 10DE:26B5 | RTX PRO 6000 Blackwell | 96 GB, ReBAR 64 GB window required |
| 1002:75A0 | Instinct MI350X | DeviceHunt-verified assignment |
| 1AF4:1050 | virtio-gpu | venus context, hostmem window instead of a discrete GPU |

## 7. NVIDIA CUDA compute surface

Driver branch R575 anchors the stack (575.57.08 / CUDA 12.9 in every virtual identity profile; R580/R590 branches recorded for Blackwell server SKUs; 575.51.03 kept as the v4 variant spelling in data files). CUDA 12.9/13.3 features cited by capacity planning: Tile Programming C++, cuOpt 26.06, cuml-cu13. Container runtime: nvidia-container-toolkit with CDI specs (`/etc/cdi/nvidia.yaml`, `nvidia.com/gpu=0` device references, `nvidia-ctk cdi generate` fallback hint). Telemetry: DCGM 3.6.1 plus eBPF uprobes on `cudaMalloc`/`launchKernel` (per-VM GPU telemetry without agent installation). Kubernetes: DRA GA on 1.35 with device-plugin 0.17.4 and CDI cold-plug. VergeOS-style universal GPU mode and WASI-GFX (wasi:webgpu) remain roadmap items (F-ledger, `viability.md` appendices).

## 8. Network passage

Passage is the data-plane bridging layer (six modes, implemented in `virtualization.ts`):

| Mode | Mechanism | Envelope |
| --- | --- | --- |
| direct | plain `--netdev user` hostfwd on a random host port | simplest; never localhost |
| bridge | Linux bridge (VLAN filtering, STP) + `virtio-net-pci` vhost, `mq=on`, queues 8, MTU 9000 | default tenant path |
| nat | iptables/nftables NAT over the bridge | multi-sandbox hosts |
| overlayVxlan | VXLAN vni 1000, dstport 4789, MTU 1400 (+1.1 ms/hop), ovs-vsctl managed | multi-host tenants |
| zeroTrust | per-tenant network namespaces `tenant-*`, WireGuard mesh (kernel mainline module, in-tree since 5.6; no out-of-tree snapshot is pinned) on 10.200.0.0/16:51820, PSK rotation 24 h | tenant isolation with mTLS per-VM certs |
| latencyOptimization | OVS-DPDK 26.07 (1024x2M hugepages, pmd cores [2,3], vhost-user) + XDP driver mode `xdp_lb.bpf.o` (XDP_REDIRECT) + io_uring ZCRX header/data split | 6 us / 100 Gbps class |

Data-plane building blocks with versions:

| Building block | Version | Envelope |
| --- | --- | --- |
| OVS | 3.7.1 (3.7.90 devel) | OpenFlow 1.6, conntrack NAT/QoS; kernel, DPDK and AF_XDP datapaths |
| DPDK | 26.07.0 (25.11.1 LTS) | 1024x2M hugepages, pmd core pinning, vhost-user |
| macvtap | kernel | four modes: bridge / vepa / private / passthrough (one VM per VF) |
| ipvlan / ipvtap | kernel | l2 / l3 / l3s; shared MAC, about 2000 tenants per host |
| SR-IOV | kernel + NIC | VF passthrough at about 8 us / 98% line rate |
| XDP | driver mode | 10 Mpps DROP/PASS/TX/REDIRECT; 14 Mpps drop versus 1.2 Mpps iptables |
| libbpf | 1.6.0 | CO-RE/BTF relocations, STRUCT_OPS map attachment |
| cilium/ebpf | Go v0.21.0 | first major 2026 release with XDP breaking changes |
| xdp-tools | 1.5.2 | libxdp dispatcher and loaders |
| AF_XDP | zerocopy | frame size 4096, UMEM management |
| io_uring ZCRX | kernel 7.x | zero-copy receive with header/data split (BNXT/mlx5 hw, soft fallback) |
| WireGuard | kernel mainline (in-tree since 5.6) | netns-per-tenant mesh, PSK rotation 24 h |
| QUIC/HTTP3 | gateway | 0-RTT via the pingora L7 gateway (7 routes, 4 upstreams in `passage.config`) |

Decision matrix: latency-critical trading path 6 us at 100 Gbps (latencyOptimization); database tenants 8 us at 98% (SR-IOV); bare-metal tenants 25 us at 25 Gbps (bridge). Socket hygiene: vsock + hvsock debug via socat (`unix-connect` to the kata hvsock), multi-queue virtio-net with vhost, MTU 9000, `52:54:00` MAC prefix policy - all in `passage.config`.

## 9. Storage and volumes

Formats: qcow2 (internal snapshots), raw, nvme, vfio device disks. Component map:

| Component | Version / form | Notes |
| --- | --- | --- |
| virtio-blk | virtio 1.3 packed rings (`VIRTIO_F_VERSION_1` + `RING_PACKED`) | queue-size 1024, ats, iothreads |
| cache modes | none / writeback / writethrough | `cache=none` default |
| async engine | `aio=io_uring` | native threads; fixed registered buffers |
| discard | `unmap` (or ignore) | thin provisioning on qcow2 |
| virtiofsd | 1.14.0 (bundled) | 9p removed in the runtime-rs lineage |
| EROFS snapshotter | current | read-only layered snapshots |
| nydus | 0.15.13 | lazy-pull image service |
| containerd CDI | annotations | cold-plug plus QMP `device_add` hot-plug |
| SPDK | v26.05 | bdev_malloc, memory tiering, NVMe-oF under 150 ms, NVMe KV, JSON-RPC |
| nullfs | Linux 7.0 | new scratch filesystem for builds |
| XFS self-healing | Linux 7.0 | background scrub |
| wrapped keys | Linux 6.15 | hardware-wrapped inline encryption |
| THP / khugepaged | always / defer+madvise | -15% TLB miss, +8% QEMU on the reference pass |
| KSM / UKSM | rich-area detection; UKSM upstream is unmaintained, the engine documents the sroeschus/uksm community fork (active, ported to recent kernels) as the only viable UKSM source | 600-2400 MB/s scan, 30-45% RAM reclaimed on fleets |
| zram | zstd / lz4hc dual | dynamic compressor switching (ZRAM_MULTI_COMP) |
| zswap | lz4hc over zsmalloc | 20% pool default |
| snapshots | qcow2 external/internal, QMP `savevm` transactional, migrate-to-file | the rollback transaction is section 13 |

## 10. Docker integration

Docker Engine 29.7.2 (2026-08-05, API 1.52, go1.24.6, runc 1.3.0) with containerd 2.3.4 (time-based minors every four months; containerd carries no LTS designation). The engine contract, flag by flag:

| Docker flag | Value | Why |
| --- | --- | --- |
| `--memory-swap` | -1 | unlimited swap up to host capacity; the elastic-RAM foundation |
| `--shm-size` | 2g | lifts the 64 MB `/dev/shm` default (PyTorch bus-error fix) |
| `--cpus` | from vcpus/overcommit | container analogue of `-smp` |
| `--pids-limit` | 0 | container analogue of unlimited threads |
| `--tmpfs /tmp` | size=20G | shader cache and scratch |
| `--rm` / AutoRemove | on | sandbox ephemerality |
| `--cpus` nano form | NanoCpus 4e9 presets | orchestrator presets |
| `--gpus` | CDI `nvidia.com/gpu=0` | device selection through the CDI spec |

Build: Buildx 0.36.1, BuildKit cache mounts, GHA cache `mode=max` (103 s to 25 s on the reference workload), multi-stage Dockerfile syntax 1.14, distroless runtime. Compose 5.5.0 (Spec v2.40 canonical `compose.yaml`; the deprecated `version:` field recorded as history), three-service stack (engine, qemu guest, gpu sidecar). Rootless: gvisor-tap-vsock 0.8.3 (slirp4netns removed from packaging), private time namespaces, cgroups v2 delegation. CDI for GPUs across nvidia/amd/intel. Ecosystem twins: Podman 6.1 (volume rename, provider-agnostic CLI), nerdctl, LXC 6.0.4 / Incus 7.2, Nanos and Unikraft 0.21.0 Ijiraq (VirtioFS PAL) for unikernel deployments, Wasmtime 36/46 shims for WASM containers. Docker VMM beta (Desktop 4.86+, Apple Containerization framework 1.0.0 from WWDC26, macOS 26, per-container VMs with vmnet and shmSize remount) tracked as an engine candidate. 2026 CVE ledger applied: CVE-2026-17106 (go-archive), CVE-2026-15793 (BuildKit), CVE-2026-41567 (docker cp PATH hijack TOCTOU), CVE-2026-32288 (sparse tar OOM), CVE-2026-53489 (CRI checkpoint symlink read), CVE-2026-15264 (vhost-user-gpu EGL).

## 11. containerd and microVM engines

- **Firecracker 1.16.1** (2026-07-02). 125 ms cold boot, under 5 MiB per microVM, 150 VMs/s per host; snapshots restore in about 4 ms (File backend: MAP_PRIVATE mapping, kernel-driven copy-on-write page faults; Uffd backend: userfaultfd userspace fault serving - the E2B primitive), diff snapshots and PCI virtio hotplug in developer preview, Linux 6.18 host support, MTU negotiation via VIRTIO_NET_F_MTU, virtio-pmem rate limiter; jailer sandboxing; strictly requires KVM (bare metal or nested). API over unix socket: PUT machine-config / boot-source / drives, InstanceStart, PATCH snapshot/create, CLI `--restore-file` / `--api-sock`. The warm pool keeps restored VMs idle (prewarm/acquire/release/refill/drain) so acquires are page-fault replays at 3-5 ms.
- **Cloud Hypervisor 53.0** (2026-07-12, six-week cadence, rust-vmm). Offloaded snapshot/restore daemon (userfaultfd + vhost-user moves the copy load out of the VMM), migratable VFIO on the same host (mlx5_vfio_pci reference, pre-opened VFIO devices), experimental vfio-user via `--user-device socket=<path>` with `ch-remote add-user-device` hotplug; the engine's `clhruntime` strategy speaks it directly.
- **gVisor release-20260817.0** (2026-08-19). runsc OCI runtime; systrap platform default (seccomp SECCOMP_RET_TRAP delivering SIGSYS to the Sentry; faster than ptrace, no `/dev/kvm` needed unlike the KVM platform); DirectFS cuts the emulation cost for I/O-heavy workloads; typical overhead 10-30% (up to 2x syscall-bound); io_uring disabled by default. Runs on GitHub-hosted runners - the no-KVM interception path.
- **Kata Containers 4.1.0** (2026-08-21). runtime-rs (Rust) default since 4.0, Go runtime deprecated (removal not before 5.0, projected Q1 2028); hypervisors QEMU, CLH, Firecracker, Dragonball, OpenVMM (4.1); 4.1 adds CLH VM templates, configurable nested virtualization, NVSwitch passthrough through IOMMUFD, rootless and seccomp baseline for QEMU; CoCo v0.14.0 with Trustee for confidential deployments.
- **CRIU 4.2.1** (2026-07-21). Process-tree checkpoint/restore (the CRIUTIBILITY 4.2 line plus a year of distro patches); integrates with runc, Podman, CRI-O and Kubernetes checkpointing; pairs with userfaultfd restore; SELinux relabel on restore is mandatory and audited; encrypted checkpoints (ChaCha20-Poly1305) and WASM linear-memory snapshots are implemented capabilities in the checkpoint/restore surface of `virtualization.ts` (v3 redistribution: the CRIU plans, MAP_PRIVATE snapshots, UFFD projection, dirty-page diffing and the migration state machine moved there from the retired `future.ts`, with the AI-session checkpoint planner in `compute.ts`).

Engine comparison matrix (the same table the orchestrator selects from):

| Engine | Version | Cold start | Memory per instance | Isolation boundary | KVM required | Snapshot/restore | Best use |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Docker (baseline) | 29.7.2 | 1-2 s | 10s of MB | namespaces, seccomp, cgroups | no | CRIU-based | default execution path |
| QEMU TCG | 11.1.0 | seconds (microvm about 4x faster) | guest RAM plus tb-size | full software VM | no | savevm/loadvm, migrate-to-file | CI without KVM, CPUID identities |
| QEMU KVM | 11.1.0 | sub-second | guest RAM | full VM, accelerated | yes | same as TCG | self-hosted throughput |
| Firecracker | 1.16.1 | 125 ms | under 5 MiB | microVM, minimal devices | yes | File/Uffd, ~4 ms restore, diff dev preview | warm pools at 150 VMs/s |
| Cloud Hypervisor | 53.0 | hundreds of ms | tens of MB | full VM, Rust VMM | yes | offloaded daemon (uffd + vhost-user) | snapshotted VMs with devices |
| gVisor | 20260817.0 | near-native container start | sentry overhead | userspace kernel | no (systrap) | not a snapshot engine | no-KVM interception |
| Kata | 4.1.0 | hundreds of ms to s | VM plus runtime-rs | VM per container | yes | hypervisor-level plus CRIU | untrusted OCI workloads |
| CRIU | 4.2.1 | millisecond restores | process tree | composes with others | no | process-tree checkpoint | warm workers |

E2B reference point: sub-200 ms published cold (about 150 ms measured), 5-30 ms snapshot starts on Firecracker+UFFD; the engine target is 125 ms cold and 3-5 ms pool acquire with the same primitives, plus the QEMU TCG path for the no-KVM environments E2B does not serve. Adjacent data points: Morph 250 ms VM forks; Vercel Sandbox GA 2026-01-30 (Firecracker-based); CubeSandbox 67 ms avg / P95 90 / P99 137 ms; EmberVM uffd O(1) CoW resume (400 ms P99 2 s with 533 MB/s prefetch); Fly Machines ~300 ms checkpoint restores. Block-I/O comparison recovered from the v4 pool benchmark pass (fio inside the guest): Firecracker versus Kata at 4749 versus 1113 MB/s on one access pattern and 3842 versus 302 MB/s on the other (4.3x and 12.7x deltas; passthrough-backed virtio-blk both sides, otherwise identical host).

## 12. MTTG: multi-tenant thread groups with cgroups v2

MTTG is the M:N scheduler (unrelated to MTTCG): `mttggrid` in `virtualization.ts` (TS mirror of the forge `Mttg` class) multiplexes up to `MTTG_MAX = 1,000,000` virtual threads onto host lanes with round-robin deques and Chase-Lev style work stealing; the guest fw_cfg handshake (`opt/aetherforge/mttg`) advertises it opt-in. Worked example: 32 host threads carrying 65,536 virtual threads is a 2048x multiplex; QEMU `-smp` stays at 32 - MTTG is userspace on top.

Tenant isolation uses cgroups v2 exclusively (controller files written by `tenantcgroupbuilder` under `/sys/fs/cgroup/vhe`):

| cgroup v2 file | Range / default | Effect |
| --- | --- | --- |
| `cpu.weight` | 1-10000 (default 100) | proportional CPU share |
| `cpu.max` | quota period | hard bandwidth cap |
| `cpu.max.burst` | accumulated burst | the Khlebnikov burst extension |
| `cpuset.cpus` / `mems` / `effective` / `exclusive` | core lists | NUMA-aware pinning and partition |
| `memory.high` | 0.8x quota | soft throttle with synchronous reclaim |
| `memory.max` | quota | hard OOM kill boundary |
| `memory.low` | floor | recursive protection |
| `io.weight` / `io.max` | 1-10000 / BPS+IOPS | block IO control |
| `pids.max` | 1024 | anti-fork-bomb |

Scheduler context with versions: EEVDF since kernel 6.6 (CFS retired in 6.12; virtual-deadline, earliest eligible lag >= 0, VRT decaying; `PLACE_LAG`/`RUN_TO_PARITY` sysctls in 6.10 measured at -13.5% latency for interactive loads); BORE (burst-Oriented Response Estimator: score via bitcount normalized 0-39, 1.25x timeslice scaling, `sched_bore` sysctls - lifetime 75000000 ns, penalty offset 24, scale 1536; CachyOS ships it default); sched_ext since 6.12 (SCX extensible BPF scheduler class, commit f0e1a0643a59 with the Microsoft backport; `scx_layered`, `scx_bpfland` policies); QoS classes guaranteed/burstable/besteffort/idle mapped to tenants gold/silver/bronze; `cpumaxqos` renders the three shapes (`max 100000` burstable, `N*100000 100000` guaranteed, `max` besteffort/idle); PSI pressure stalls plus DAMON mtier auto-tuning; `numa_balancing` TNF_FAULT_LOCAL page-fault migration; FFmpeg 7.1.1 Blackwell transcode QoS with weighted vRAM (31 modes, 5 codecs, 24 MTTG stages on NVENC dual 8K120 - the encoding matrix is in `hardware.md` section 9). Docker+MTTG merged surface (dockermttg): Buildx Bake HCL matrices, Dockerfile 1.6+ syntax, CDI device requests, `saddle.slice` parent, OCI provenance labels max, no-new-privileges plus Tini 0.19.0, pinned Actions with OTEL tracing, and the passage memory pipeline 512 MB - 4 TB with internal priority.

## 13. Passage security and snapshot rollback

Snapshot rollback is a five-phase transaction: phase 0 detect (health probes on vCPU steal and memory pressure; QMP SHUTDOWN/STOP events; circuit breaker opens after 5 failures); phase 1 quiesce (qemu-guest-agent fs-freeze/fs-thaw, pipeline drain, WAL fsync with an idempotency token per operation - `randomUUID`, duplicates deduped); phase 2 loadvm with RAM verification; phase 3 network reattach (netdev detach/attach on the bridge, virtio-net-pci queues 4, hostfwd on a random host port - `127.0.0.1` is explicitly forbidden in the binding validator); phase 4 GPU rebind (vfio-pci unbind with `driver_override`, iommufd fd close, rebind with a fresh iommufd object). Write-ahead log at `/saddle/data/wal/<vmId>.wal.jsonl` and audit at `audit/<tenant>.jsonl`, both append-only. Gateway posture: TLS 1.3 only, mTLS with per-VM certificate rotation and JWT issuer, seccomp plus AppArmor profiles, RBAC with immutable audit, disaster recovery to offsite S3. The security layers themselves (Landlock, seccomp, eBPF LSM, PQ TLS) are specified in `security.md` and composed fail-closed by `security.ts`.

## 14. Mesa rendering stack (summary)

The complete 190-variable Mesa contract, presets and probes live in `render.ts` and are summarized in `readme.md`; the virtualization-relevant facts: llvmpipe delivers OpenGL 4.6 core (161/161 extensions, Mesamatrix) with AVX-512 selected at runtime by Gallivm (MR !17813) and the rasterizer thread ceiling raised to 32 (MR 31551); lavapipe delivers the Vulkan 1.4 surface (Khronos-conformant on the 1.3 CTS, submission 2022-07-19) selected through `VK_DRIVER_FILES` (`VK_ICD_FILENAMES` deprecated by the loader); Rusticl delivers OpenCL 3.1 (sole frontend since Clover was deleted in Mesa 25.2; `RUSTICL_DEVICE_TYPE=gpu` makes clinfo report the device as a GPU; `cl_khr_fp16` default, only fp64 needs `RUSTICL_FEATURES`). Headless GLX runs on the validated Xvfb recipe `Xvfb :99 -ac -screen 0 1920x1080x24 -nolisten tcp +extension GLX +render -noreset` with an xdpyinfo wait loop (50 retries at 0.1 s), stale-lock cleanup (`/tmp/.X99-lock`, `/tmp/.X11-unix/X99`) and a 20 GB `MESA_SHADER_CACHE_DIR` tmpfs. Zink (OpenGL-on-Vulkan) is available as the GL compatibility path; the full env surface and smi-adapter rendering are `render.ts` territory. Mesa gains recovered from the v4 pool notes: the RadeonSI Rust conversion started on 2025-03-27 with about 900 lines of Rust in-tree (the beginning of the Rust-in-Mesa program that Rusticl and NVK already follow); Rusticl shared-virtual-memory support is tracked at the SVM 23.3 milestone; and the Rusticl int64 path (`RUSTICL_FEATURES` int64 lane) completes the fp64 story clinfo probes ask about.

## 15. WASM tier: Wasmtime and WASI

Wasmtime 48.0.0 (LTS, support until 2028-08-20) is the smallest engine tier: a virtual CPU budget instead of a virtual CPU map. Fuel metering (deterministic 50M-fuel budgets) and epoch interruption (180 s deadlines, about 10% overhead) implement the same M:N discipline MTTG applies to threads. WASI 0.2.8 Preview 2 ships today; WASI 0.3.0 was ratified 2026-06-11 with the component model native async - the engine's `compute.ts` (the v3 home of the wasm tier, moved out of the retired `future.ts`) implements the 0.3 async runtime with cancellation, WIT bindings generation, deny-by-default component ACL, wasi:nn and wasi:webgpu bridges (the wasipreview2 note: preview 2 remains the interchange target until the 0.3 ecosystem RTMs; both surfaces are wired in `compute.ts`, aligned with wgpu 30.x for the WebGPU side). Adjacent runtimes recorded: WAMR, WasmEdge, Wasmer, Extism 1.30, wasmCloud, Spin 3.6.0 (the spinframework repo) with wasi:http 0.3.

## 16. Alternative hypervisors

Xen 4.22 (PVH dom0, 16383 CPUs); Hyper-V WS2025 LTSC v12.0 (2048 vCPUs, GPU paravirtualization); bhyve (FreeBSD, KVM 6.18 LTS guest note); Apple Virtualization.framework `Vz` (the Apple Containers 1.2.2 base); WHPX and HVF as `-accel` twins of the same plan; Incus/LXC 6.0.4 system containers; KubeVirt CRDs (translate `vm.config` to a `VirtualMachine` spec; migration belongs to KubeVirt). Nested virtualization: Docker-in-QEMU and WSL2-in-QEMU with `kvm_intel.nested=1`; never combined with SEV-SNP.

## 17. Operations runbooks (condensed)

| Runbook | Rule |
| --- | --- |
| Host hardening | IOMMU on; `vfio-pci.ids` only for the passthrough pair; swtpm socket 0600 qemu:qemu; Looking Glass shm 0660; QEMU seccomp sandbox on; never expose `-monitor tcp:` |
| VFIO troubleshooting | `dmesg \| grep -e DMAR -e AMD-Vi`; walk `/sys/kernel/iommu_groups`; if the GPU shares a group with storage, stop - ACS override is the last resort |
| Reset troubleshooting | black screen after first VM: vendor-reset, kernel 6.14+, or a second GPU for the host; `journalctl -k \| grep vfio` |
| Overcommit troubleshooting | guest stalls, host load in the hundreds: lower vcpus or pin with `cpuset.cpus`; `vmstat 1` with non-zero si/so means off-RAM - enable zswap or cut `memory.gib` |
| Pinning | `numactl --cpunodebind=0 --membind=0` plus taskset for emulator versus vCPU threads (`debug-threads=on` names them); CCD0 for latency, CCD1 for background on X3D hosts |
| Logging | QEMU stdout is the serial console (`-serial mon:stdio`); libvirt `stdio_handler=logd`; Docker json-file with rotation |
| Backup | qcow2 plus `qemu-img snapshot`; back the virtiofs host path, not the guest mount |
| Capacity | physical floor x overcommit = honest vCPU budget (MTTG adds concurrency, not CPU time); never advertise more RAM than zswap can carry unless the guest is sparse |
| Incident: unbind of the only GPU | SSH in, `virsh destroy`, rebind via the libvirt hook; if SSH was on that GPU's display, that is why `passage.config` insists on a second path |
| Issue template | CPU, GPU, kernel, QEMU version, Docker version, IOMMU isolated, attached TOML; PRs without tests stay draft |

## 18. Micro-techniques recovered from the v4 pool

Small production techniques the analysis pool documented that belong to this stack but had no home in the v3 docs; each is one flag, one env var or one socket away from the surfaces above.

| Technique | Domain | Note |
| --- | --- | --- |
| `IORING_SETUP_NO_MMAP` with the mpscq ring layout | storage / passage | maps the SQ/CQ rings through a normal allocation instead of the mmap region; avoids fork-inherited mapping issues in the bridge processes |
| `IORING_SETUP_COOP_TASKRUN` + `IORING_SETUP_SINGLE_ISSUER` | storage | cooperative CQE task work and the single-issuer hint; trims IPI overhead on the fixed-buffer NVMe path |
| CUDA MPS (Multi-Process Service) | GPU compute | partitions one physical GPU among multiple client processes without MIG or vGPU licenses; complements the time-slicing profiles in `hardware.md` section 6 |
| `SOURCE_DATE_EPOCH` | reproducible builds | deterministic timestamps for the image build layer so the level-9 source zip rebuilds byte-identically |
| `vsock://2:1024` | microVM sockets | AF_VSOCK address shape for the guest agent channel: CID 2 (host side of the device), port 1024 (the reserved agent port in the v4 API reference) |
| `/dev/shm` remount workaround | containers | when a runtime ignores `--shm-size` (recorded against the Apple containerization path), remount tmpfs on `/dev/shm` with the required size from the entrypoint |

## Sources

1. QEMU 11.1.0 announcement: https://www.qemu.org/2026/08/11/qemu-11-1-0/
2. QEMU MTTCG design: https://www.qemu.org/docs/master/devel/multi-thread-tcg.html
3. TCG internals: https://www.qemu.org/docs/master/devel/tcg.html
4. microvm machine: https://www.qemu.org/docs/master/system/i386/microvm.html
5. QEMU source (EPYC-v5, target/i386/cpu.c): https://gitlab.com/qemu-project/qemu
6. GitHub runners lack /dev/kvm: https://github.com/actions/runner-images/issues/12933
7. TCG fallback incident: https://github.com/orgs/community/discussions/151747
8. Firecracker releases: https://github.com/firecracker-microvm/firecracker/releases
9. Firecracker snapshot support: https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshot-support.md
10. Firecracker microVM paper: https://arxiv.org/abs/2102.12892
11. AWS restore measurements: https://brooker.co.za/blog/2022/11/29/snapstart.html
12. Cloud Hypervisor v53: https://github.com/cloud-hypervisor/cloud-hypervisor/releases and https://www.cloudhypervisor.org
13. vfio-user: https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/vfio-user.md
14. gVisor platforms: https://gvisor.dev/docs/architecture_guide/platforms
15. gVisor performance: https://gvisor.dev/docs/architecture_guide/performance
16. Kata 4.0/4.1: https://katacontainers.io/blog/kata-containers-4-0-0-release-overview and https://github.com/kata-containers/kata-containers/releases
17. CRIU: https://github.com/checkpoint-restore/criu/releases and https://criu.org
18. E2B on Firecracker versus QEMU: https://e2b.dev/blog/firecracker-vs-qemu
19. E2B self-hosting requirements: https://github.com/e2b-dev/infra/blob/main/self-host.md
20. OVS: https://docs.openvswitch.org
21. DPDK releases: https://core.dpdk.org
22. XDP and eBPF tooling: https://github.com/xdp-project/xdp-tools, https://github.com/libbpf/libbpf, https://github.com/cilium/ebpf
23. WireGuard: https://www.wireguard.com
24. Docker Engine 29 release notes: https://docs.docker.com/engine/release-notes/29
25. containerd releases: https://github.com/containerd/containerd/releases
26. EEVDF and scheduler changes: https://lwn.net/Articles/969066 and the kernel tree documentation
27. Wasmtime and WASI: https://github.com/bytecodealliance/wasmtime/releases, https://wasi.dev/roadmap
28. Mesa release notes: https://docs.mesa3d.org/relnotes/26.2.1.html
29. Xvfb manual: https://man.archlinux.org/man/Xvfb.1
