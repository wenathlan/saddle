# e2ugh optimization roadmap — the slow QEMU/Mesa build pipeline

> Status: planning document (docs/optimization.md). The QEMU/Mesa
> pipeline is correct but heavy: a cold multi-arch validation run
> executes more than 2,700 compile steps (QEMU 11.1.0 from source with
> the x86_64-softmmu target, Mesa 26.2.1 with llvmpipe + lavapipe, LLVM
> 18 toolchain, gcc-14/g++-14 native shims) and the emulated legs
> (linux/arm64 and linux/ppc64le under qemu-user) dominate the wall
> clock. This document records the optimization backlog so each item can
> be scheduled without rediscovering the analysis.

## 1. Where the time goes today

| Stage | Runner cost | Emulated? | Bottleneck |
| --- | --- | --- | --- |
| QEMU 11.1.0 source build (x86_64-softmmu) | ~14 min native | yes on arm64/ppc64le legs | ~1,500 compile steps of C |
| Mesa 26.2.1 source build (llvmpipe + lavapipe) | ~9 min native | yes on arm64/ppc64le legs | ~800 compile steps of C + meson/ninja graph |
| LLVM 18 + gcc-14 toolchain apt install | ~3 min | no | package unpack under emulation is 3-5x slower |
| Native shims (virtualhardware.c, gpumonitor.cpp, virtualizationcore.cpp) | ~4 min | yes (LTO) | -O3 -flto link time under emulation |
| Runtime probes (cpuinfo/free/clinfo/vulkaninfo) | ~2 min | yes | LLVMpipe JIT warmup under emulation |
| **Total cold, three arches** | **~60-90 min** | | |

With a warm `type=gha` BuildKit cache the same grid completes in ~6-10
minutes, which is why the cache-retention policy keeps exactly one
buildkit cache family entry on the default branch.

## 2. Optimization backlog (ordered by expected win)

### 2.1 Cross-compilation instead of emulation (the big win)

Build the arm64 and ppc64le images from an amd64 runner using the
 debian cross toolchains (`gcc-14-aarch64-linux-gnu`,
 `gcc-14-powerpc64le-linux-gnu`, `clang --target=aarch64-linux-gnu`
 with LLVM 18) instead of executing the entire toolchain under
 qemu-user. Mesa and QEMU both cross-build cleanly with meson
 (`--cross-file`); only the runtime probes still need emulation, and
 those run against the finished image in seconds, not minutes.

Expected wall clock: the emulated 60-90 minute grid drops to roughly
 3 parallel native-speed builds (~18-25 min total).

Blockers: the Dockerfile must gain a `CROSS` build mode (meson
 cross-files, `PKG_CONFIG_PATH` per arch, `--cross-prefix` for the QEMU
 configure) and the march baseline table must move from `TARGETARCH`
 runtime probing to the cross file. Nothing in the engine logic changes:
 the shims are arch-portable since the 1.2.0 KVM register guards.

### 2.2 Prebuilt QEMU base image

Pin QEMU 11.1.0 into a dedicated `ghcr.io/wenathlan/e2ugh-qemu` base
 image (built once per release from the `qemu` stage) and consume it
 with `FROM ghcr.io/wenathlan/e2ugh-qemu:11.1.0 AS qemu` in the main
 Dockerfile. The ~14 minute QEMU compile then happens only when the
 pinned tag moves, not on every cache-cold run.

Expected wall clock: -12 to -14 minutes on every cold build.

### 2.3 Prebuilt Mesa layer with a digest pin

Same pattern for Mesa 26.2.1: publish `ghcr.io/wenathlan/e2ugh-mesa`
 with the compiled llvmpipe/lavapipe stack per arch and consume it as a
 build stage. The sha256-verified source tarball stays in the repo as
 the reproducible fallback (`MESA_FROM_SOURCE=1`).

Expected wall clock: -7 to -9 minutes on every cold build.

### 2.4 ccache for the native shims

The three shim translation units are small, but `-O3 -flto` link time
 under emulation is disproportionate. Mount a `~/.ccache` Actions cache
 keyed on `hashFiles('libs/**')` and compile through `ccache g++-14`.
 Cheap (~15 lines of Dockerfile) and compounds with 2.1.

Expected wall clock: -1 to -2 minutes on cache-warm shim rebuilds.

### 2.5 Trim the QEMU target surface

The `qemu` stage configures the full x86_64-softmmu system emulator,
 but the engine only ever boots the documented `-M` machine list
 (docker.config `qemuRuntime`). Auditing the configure line for
 `--disable-*` blocks (no block migration, no vnc, no spice, no
 networking backends beyond the documented tap/user list) removes an
 estimated 300-400 compile steps.

Expected wall clock: -3 to -4 minutes per arch on cold builds.

### 2.6 Matrix sharding for the emulated legs

If 2.1 lands late, shard the emulated Mesa build per arch into
 per-arch digest pushes (already the publish pattern) and let the
 validation legs consume the pushed digests instead of rebuilding the
 image: validate probes run against `ghcr.io/...@sha256:...` pulled
 with `--platform`. The rebuild-then-probe duplication disappears.

Expected wall clock: -8 to -12 minutes (the validate grid stops
 rebuilding what publish just built).

### 2.7 Native arm64 runners

GitHub offers arm64 hosted runners; moving the linux/arm64 leg off
 qemu-user removes its entire emulation multiplier (~5-8x on the Mesa
 graph). ppc64le stays emulated (no hosted runner) but becomes the only
 emulated leg.

Expected wall clock: arm64 leg ~35 min -> ~8 min.

## 3. Non-goals

- No caching of the final published images beyond the existing
  provenance/SBOM attestations - the release chain must always build
  from the tagged source.
- No `docker save` artifact juggling between validate and publish; the
  digest registry is the transport.
- The cache-retention policy stays aggressive (one entry per family on
  the default branch); the wins above must come from doing less work,
  not from hoarding more cache.

## 4. Suggested sequence

1. 2.2 (QEMU base image) and 2.3 (Mesa layer) - pure infrastructure,
   no Dockerfile semantics change, immediate cold-build win.
2. 2.5 (QEMU configure trim) - one-line audit, benefits every arch.
3. 2.1 (cross-compilation) - the structural win; schedule with the
   march table refactor from the 1.2.0 portability work.
4. 2.7 (native arm64 runners) once the cross-build exists as fallback.
5. 2.4 and 2.6 opportunistically alongside any of the above.
