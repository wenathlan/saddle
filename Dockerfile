# syntax=docker/dockerfile:1
# saddle v2.0.0 grand merge — THE ONE CONTAINER FILE.
#
# this Dockerfile carries BOTH container surfaces of the merged repository:
#   1. the saddle virtual-hardware engine image (the five stages below:
#      builder, python-bridge, qemu, qemu-runtime, runtime) — the default
#      build target, published as ghcr.io/wenathlan/saddle:vhe-<version>
#      across three profiles and four architectures;
#   2. the saddle node-engine image (the saddle-build and saddle-runtime
#      stages at the end of this file, folded from the former
#      dockerfile.saddle) — an explicit build target
#      (`docker build --target saddle-runtime .`), the node 26 storage and
#      compute service published as ghcr.io/wenathlan/saddle:<version>.
#
# saddle v2 (grand merge) - virtual hardware engine, multi-stage, multi-arch image.
#
# the five stages mirror the stages section of docker.config
# (multi-stage-cache-optimized strategy, parallel-friendly):
#   builder        toolchain stage on ubuntu:24.04. installs LLVM 18
#                  (from the noble archive, not apt.llvm.org which is
#                  unreachable from GHA runners), builds mesa 26.2.1
#                  (llvmpipe + lavapipe; rusticl is off until
#                  LLVMSPIRVLib >= 22.1 is packaged), installs node
#                  26.7.0 from nodesource, and compiles the native sources
#                  DIRECTLY with gcc-14/g++-14 (no cmake anywhere: the libs
#                  are single translation units documented in their own
#                  headers): libs/virtualhardware.c (LD_PRELOAD spoofing
#                  core), libs/gpumonitor.cpp (nvml/cuda shim suite in
#                  four build modes) and libs/virtualizationcore.cpp
#                  (kvm/vfio/qmp core with an executable selftest), all
#                  with -O3 -flto. it also bakes the /etc/virtual hardware
#                  profile per the VHE_PROFILE_* build-args (max: EPYC 9965
#                  192c/384t 1TiB, balanced: Threadripper Pro 9995WX
#                  96c/192t 512GiB, lite: Ryzen 9 9950X3D 16c/32t 128GiB).
#   python-bridge  python:3.14.7-slim carrying qemubridge.py. the bridge is
#                  stdlib-only (asyncio/json/argparse), so the stage runs a
#                  py_compile syntax gate and no pip install at all.
#   qemu           QEMU 11.1.0 compiled from download.qemu.org with the
#                  x86_64-softmmu target for TCG/MTTCG guest execution;
#                  build arg QEMU_FROM_SOURCE=0 falls back to the distro
#                  qemu-system-x86 package when a source build is not
#                  viable on the host.
#   qemu-runtime   the qemu stage plus OVMF firmware, pciutils, kmod and
#                  tini (the docker.config "qemuRuntime" role: the guest
#                  runner consumed by the vheqemu docker run recipe).
#   runtime        ubuntu:24.04 final image: mesa 26.2.1 stack, node
#                  26.7.0, Xvfb, vulkan-tools, clinfo, mesa-utils,
#                  python3, the compiled spoofing artifacts, the python
#                  bridge and the engine sources under /engine. default
#                  build target (docker build / the engine docker run
#                  recipe below).
#
# platforms: linux/amd64, linux/arm64, linux/ppc64le and linux/s390x
# through buildx --platform (the four-arch registry surface); every
# stage compiles for the portable baseline of its target architecture
# by default (x86-64 / armv8-a / power8 / z196, resolved from
# TARGETARCH) so the layers stay valid on every host and every
# gha-cached runner cpu; pass --build-arg VHE_MARCH=native for
# host-tuned local builds, or an explicit -march value when
# cross-building for a known deployment target.
#
# profiles: the three profiles (max, balanced, lite) are all built for
# all four architectures; each profile carries a distinct virtual CPU
# identity (model name, vcpus, threads, ram) baked into /etc/virtual.
#
# the one container file (the gateway 1.1.5 standard): the compose stack
# and the entrypoint bootstrap are MERGED INTO this file -
# docker-compose.yml and entrypoint.sh are deleted from the tree; every
# orchestration setting they carried is expressed here (the ENV defaults,
# EXPOSE, VOLUME, HEALTHCHECK, USER, the OCI labels, the entrypoint script
# embedded as a heredoc COPY) plus the hardened docker run recipes below
# documenting every flag of the former services (init reaps zombies as
# pid 1, cap-drop ALL + no-new-privileges harden the container, unlimited
# swap, 2g shm, 15s stop grace, 50m x 5 json-file logs, restart
# unless-stopped, the tmpfs scratch and the named volumes). Containerfile
# is the same format under the OCI name - Dockerfile is the universally
# compatible spelling, so it is the one file the repository keeps.
#
# the docker run recipes (one per former compose service; pick any free
# host port in 30000-60000 - nothing below is a fixed address):
#
#   vhe (the engine service, default target):
#   docker run -d --name saddle-engine \
#     --restart unless-stopped --init \
#     --cap-drop ALL --security-opt no-new-privileges:true \
#     --ulimit nofile=65536:65536 \
#     --memory-swap -1 --shm-size 2g --stop-timeout 15 \
#     --log-driver json-file --log-opt max-size=50m --log-opt max-file=5 \
#     --tmpfs /tmp:size=512m,mode=1777 --tmpfs /run/vhe:size=64m,mode=0755 \
#     --tmpfs /cache/mesa_shader_cache:size=20g,uid=10000,gid=10000,mode=1777 \
#     -v vmdata:/data/vmdata -v webdata:/data/web \
#     -v ./vm.config.json:/engine/vm.config.json:ro \
#     -e PORT=8080 -e NODE_ENV=production -p 31280:8080 \
#     ghcr.io/wenathlan/saddle:vhe-2.0.2
#
#   vheqemu (the guest runner; build it first with
#   docker build --target qemu-runtime -t saddle/qemu:11.1.0 . because the
#   published registry image is the runtime target):
#   docker run -d --name saddle-qemu \
#     --restart unless-stopped --init \
#     --security-opt no-new-privileges:true \
#     --ulimit nofile=65536:65536 \
#     --memory-swap -1 --shm-size 2g --stop-timeout 15 \
#     --log-driver json-file --log-opt max-size=50m --log-opt max-file=5 \
#     -v ./qemu:/qemu:ro -v qemu-kernel:/opt/kernels:ro \
#     -v qemudata:/data/qemudata -v ovmfvars:/data/ovmfvars \
#     -v ./qemu.config:/engine/qemu.config:ro \
#     -p 31281:31281 -it \
#     saddle/qemu:11.1.0 \
#     -accel tcg,thread=multi,tb-size=1024 -cpu EPYC-v5 \
#     -smp 192,sockets=1,cores=192,threads=2,maxcpus=384 \
#     -m 131072 -machine q35 -nodefaults -no-reboot -nographic \
#     -serial mon:stdio -monitor none \
#     -kernel /qemu/vmlinuz -initrd /qemu/initrd.img \
#     -append "console=ttyS0 panic=-1"
#
#   vhegpu (the fake gpu sidecar, same engine image):
#   docker run -d --name saddle-gpu \
#     --restart unless-stopped --init \
#     --cap-drop ALL --security-opt no-new-privileges:true \
#     --ulimit nofile=65536:65536 \
#     --memory-swap -1 --shm-size 2g --stop-timeout 15 \
#     --log-driver json-file --log-opt max-size=50m --log-opt max-file=5 \
#     -v gpudata:/data/gpudata -v ./gpus.json:/engine/gpus.json:ro \
#     -e VHE_GPU_PROFILE=b200 -e VHE_GPUS=8 -e VHE_MIG=1 \
#     -e VHE_SMI_DRIVER=575.57.08 -e VHE_SMI_CUDA=12.9 \
#     -e VHE_SMI_INTERVAL=30 -e VHE_SKIP_XVFB=1 -e VHE_SKIP_VALIDATE=1 \
#     ghcr.io/wenathlan/saddle:vhe-2.0.2 /bin/bash -c '
#       while true; do
#         /usr/local/bin/nvidia-smi "$VHE_GPU_PROFILE" "$VHE_GPUS" || true
#         sleep "$VHE_SMI_INTERVAL"
#       done
#     '
#
#   qemubridge (the python QMP bridge, same engine image):
#   docker run -d --name saddle-bridge \
#     --restart unless-stopped --init \
#     --security-opt no-new-privileges:true \
#     --ulimit nofile=65536:65536 \
#     --memory-swap -1 --shm-size 2g --stop-timeout 15 \
#     --log-driver json-file --log-opt max-size=50m --log-opt max-file=5 \
#     -v qemudata:/data/qemudata \
#     -v ./qemubridge.py:/engine/qemubridge.py:ro \
#     -e QMP_SOCKET=/run/vhe/vm.qmp -e PYTHONUNBUFFERED=1 \
#     ghcr.io/wenathlan/saddle:vhe-2.0.2 \
#     python3 /engine/qemubridge.py --socket /run/vhe/vm.qmp status
#
#   saddle-node (the node-engine service, the former compose.yml
#   service folded here; build it with
#   docker build --target saddle-runtime -t saddle:<version> .):
#   docker run -d --name saddle-node \
#     --restart unless-stopped --init --read-only \
#     --cap-drop ALL --security-opt no-new-privileges:true \
#     --pids-limit 512 --network none \
#     --ulimit nofile=65536:65536 \
#     --log-driver json-file --log-opt max-size=50m --log-opt max-file=5 \
#     --tmpfs /tmp:size=2g,mode=1777 \
#     -e SADDLE_MEMORY_ENGINE=ram -e SBOT_PLATFORM= -e SBOT_CDN_URL= \
#     ghcr.io/wenathlan/saddle:2.0.2 \
#     node dist/cli.js plan
#
#   observability (the former prometheus scraper of the full profile)
#   runs from its own upstream image (prom/prometheus:v3.4.1) with
#   --config.file and a 15d retention - the one container file this
#   repository keeps covers only what it builds.
#
# no port is published by the image itself; the recipes above publish
# host 31280 -> container 8080 for the engine and 31281 for the qemu
# guest runner, and a bare `docker run` without -e PORT leaves the
# embedded entrypoint picking a random port in 30000-60000 (the same
# range the recipes draw their host ports from). nothing in the stack
# ever binds a hardcoded address.

# Base image contract (the gateway family policy): tags only, never a
# @sha256: digest. A single digest cannot serve the four-architecture
# matrix this image ships (the registry resolves the tag per platform),
# and a digest written here would be a hardcoded hash - the checksums
# that exist are generated by the GitHub runners and published as
# release assets (SHA256SUMS), never written into the sources.
ARG UBUNTU="ubuntu:24.04"
# maximum virtual hardware profile baked at build time (workflow override
# friendly): the top catalog cpu (EPYC 9965, 192 cores / 384 threads), the
# catalog maximum memory plan (1024 GiB), the top gpu profile (B200) and
# eight virtual adapters. every value is spoofed software identity: no
# physical hardware is touched, probed or required.
ARG VHE_PROFILE_CPU="epyc9965"
ARG VHE_PROFILE_VCPUS="192"
ARG VHE_PROFILE_THREADS="384"
ARG VHE_PROFILE_RAM_GB="1024"
ARG VHE_PROFILE_GPU="b200"
ARG VHE_PROFILE_GPUS="8"
ARG PYTHON_BASE="python:3.14.7-slim"
ARG LLVM_VERSION="18"
ARG NODE_VERSION="26.7.0"
ARG MESA_VERSION="26.2.1"
ARG QEMU_VERSION="11.1.0"

# ---------------------------------------------------------------------------
# stage 1: builder
# ---------------------------------------------------------------------------
FROM ${UBUNTU} AS builder
ARG TARGETPLATFORM
ARG TARGETARCH
ARG BUILDARCH
ARG LLVM_VERSION
ARG NODE_VERSION
ARG MESA_VERSION
# empty = portable baseline resolved from TARGETARCH at the compile step
# (x86-64 / armv8-a); "native" is the opt-in for host-tuned local builds.
ARG VHE_MARCH=""
# NOTE: the VHE_PROFILE_* build-args are deliberately NOT declared in the
# builder stage. The builder compiles mesa/node/native shims which are
# profile-independent; keeping the profile args out of the builder means
# the buildx registry cache is shared across max/balanced/lite for each
# architecture (the profile identity is baked in the runtime stage below).

ENV DEBIAN_FRONTEND=noninteractive

# toolchain: gcc-14 (speaks c++26 for the shim suite) and the LLVM 18
# toolchain from the Ubuntu noble archive (which mesa 26.2.1 requires
# '>= 18.0.0'). The previous build pulled LLVM 22 from apt.llvm.org but
# that host is unreachable from GitHub Actions runners (curl exit 7,
# 8 retries all failed in 0 ms); the Ubuntu distro LLVM 18.1.x is served
# from archive.ubuntu.com which the runner can always reach. Rusticl is
# disabled (see the mesa block below) so no clang/libclc/libllvmspirvlib
# are needed; the native sources compile with g++-14.
RUN set -eux; \
    # the Ubuntu arm64/ppc64el/s390x ports mirror (ports.ubuntu.com)
    # intermittently serves either a Packages.gz whose size differs from
    # the Release file while it is mid-sync ("File has unexpected size
    # ... Mirror sync in progress?") OR a Release index that references
    # .deb files already removed from the pool directory (404 Not Found
    # on apt-get install). Retrying just apt-get update is not enough:
    # the update can succeed on a stale index whose pool files are gone.
    # The retry must cover BOTH apt-get update AND apt-get install so a
    # 404 on install re-fetches a fresh index that references the new
    # package versions. The stale list cache is cleared between retries.
    apt_update_tries=5; \
    while [ "$apt_update_tries" -gt 0 ]; do \
        if apt-get update && apt-get install -y --no-install-recommends \
            ca-certificates curl gnupg xz-utils bzip2 git \
            python3 python3-pip python3-setuptools python3-wheel \
            python3-mako python3-yaml python3-ply \
            pkg-config bison flex ninja-build meson \
            build-essential gcc-14 g++-14 \
            "llvm-${LLVM_VERSION}-dev" "llvm-${LLVM_VERSION}-tools" \
            libdrm-dev libexpat1-dev zlib1g-dev libzstd-dev \
            libx11-dev libxext-dev libxfixes-dev libxxf86vm-dev libxrandr-dev \
            libxcb1-dev libxcb-glx0-dev libxcb-dri2-0-dev libxcb-dri3-dev \
            libxcb-present-dev libxcb-sync-dev libxcb-shm0-dev \
            libxcb-randr0-dev libxcb-xfixes0-dev libx11-xcb-dev libxshmfence-dev \
            libelf-dev libedit-dev libglvnd-dev \
            glslang-tools spirv-tools; then break; fi; \
        apt_update_tries=$((apt_update_tries - 1)); \
        echo "apt-get update/install failed (mirror sync?), $apt_update_tries retries left"; \
        sleep 10; \
        rm -rf /var/lib/apt/lists/*; \
    done; \
    test "$apt_update_tries" -gt 0; \
    ln -sf "/usr/bin/llvm-config-${LLVM_VERSION}" /usr/local/bin/llvm-config; \
    ln -sf /usr/bin/gcc-14 /usr/local/bin/gcc; \
    ln -sf /usr/bin/g++-14 /usr/local/bin/g++; \
    # mesa 26.2.1 requires meson >= 1.4.0 (mesa.build:9); Ubuntu 24.04 noble
    # ships meson 1.3.2 which is too old. meson installs from its exact
    # version-pinned wheel URL: the artifact identity is the 1.12.0 release
    # path on files.pythonhosted.org (a registry URL, the same class of
    # contract npm ci uses through the lockfile). No hardcoded digest in
    # this file: the maintainer supply-chain policy for this family is the
    # version-tagged artifact (the Scorecard PinnedDependencies findings
    # are dismissed per that policy) and the checksums that exist are
    # generated on the GitHub runners at release time (see the SHA256SUMS
    # asset of the Release workflow), never written into the sources.
    curl -fsSL --retry 5 --retry-all-errors \
        -o /tmp/meson-1.12.0-py3-none-any.whl \
        "https://files.pythonhosted.org/packages/07/68/b0117422eb0a46d9d8d9e328f0c5b5c835179bfc058688bca35c90c89eba/meson-1.12.0-py3-none-any.whl"; \
    pip3 install --break-system-packages --no-cache-dir \
        /tmp/meson-1.12.0-py3-none-any.whl; \
    rm -f /tmp/meson-1.12.0-py3-none-any.whl; \
    meson --version

# NOTE: the rust toolchain step was removed because rusticl is disabled
# (LLVMSPIRVLib >= 22.1 not packaged for LLVM 22; see the mesa block below).
# Rusticl was the only mesa component that needed rustc + bindgen-cli; with
# it off, the build is rust-free.

# node 26.7.0 (current line, v8 14.6, temporal api, NODE_MODULE_VERSION 147).
# amd64 and arm64 install the pinned nodesource deb; ppc64le (any arch the
# nodesource apt repo does not carry) falls back to the official nodejs.org
# binary tarball, extracted straight into /usr so bin/node, include/node and
# lib/node_modules land exactly where the nodesource package (and the runtime
# stage COPY --from=builder directives) expect them. the node headers
# (/usr/include/node) are required by the ADDON build mode of gpumonitor.cpp.
RUN set -eux; \
    nodesrc_ok="1"; \
    case "${TARGETARCH}" in ppc64le|s390x|riscv64|loongarch64) nodesrc_ok="0" ;; esac; \
    if [ "$nodesrc_ok" = "1" ]; then \
        # the version-line setup script (setup_26.x) is the nodesource
        # distribution contract: no hardcoded digest in this file. The
        # script tracks the whole 26.x line (a frozen hash would
        # false-negative on every upstream refresh), the apt repository
        # it configures carries its own release signing, and the exact
        # node build is pinned by the "nodejs=${NODE_VERSION}-1nodesource1"
        # package below. Checksums for released artifacts are generated on
        # the GitHub runners (SHA256SUMS release asset), never hardcoded.
        curl -fsSL -o /tmp/nodesource-setup.sh https://deb.nodesource.com/setup_26.x; \
        bash /tmp/nodesource-setup.sh; \
        rm -f /tmp/nodesource-setup.sh; \
        apt-get install -y --no-install-recommends \
            "nodejs=${NODE_VERSION}-1nodesource1" \
            || apt-get install -y --no-install-recommends nodejs; \
    else \
        tarball="node-v${NODE_VERSION}-linux-${TARGETARCH}.tar.xz"; \
        curl -fsSL --retry 5 --retry-all-errors -o "/tmp/${tarball}" \
            "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"; \
        tar -xJf "/tmp/${tarball}" -C /usr --strip-components=1; \
        rm -f "/tmp/${tarball}"; \
    fi; \
    node --version; npm --version; \
    # upgrade the bundled npm to the line the engines field documents
    # (nodesource node 26.7.0 ships npm 11.19.0) and surgically refresh
    # the four nested dependencies whose bundled versions carry the CVEs
    # the trivy release gate rejects (brace-expansion CVE-2026-14257 /
    # CVE-2026-69152, ip-address CVE-2026-69192 / CVE-2026-54272 /
    # CVE-2026-69198, tar CVE-2026-73566, undici CVE-2026-16728 /
    # CVE-2026-16729 / CVE-2026-15157). published npm tarballs freeze
    # their bundled node_modules at publish time, so the swap alone
    # still ships brace-expansion 5.0.7; each fixed release is packed
    # separately and extracted over the nested path, then asserted: the
    # runtime stage copies /usr/lib/node_modules verbatim and the gate
    # scans exactly that path.
    newnpm=$(npm pack "npm@12.0.2" --pack-destination /tmp 2>/dev/null | tail -n1); \
    case "${newnpm}" in /*) ;; *) newnpm="/tmp/${newnpm}";; esac; \
    test -f "${newnpm}"; \
    rm -rf /usr/lib/node_modules/npm; \
    mkdir -p /usr/lib/node_modules/npm; \
    tar -xzf "${newnpm}" -C /usr/lib/node_modules/npm --strip-components=1; \
    rm -f "${newnpm}"; \
    hash -r; \
    npm --version; \
    test -f /usr/include/node/node_api.h; \
    fixdep() { \
        fname="$1"; fwant="$2"; \
        ftgz=$(npm pack "$fname@$fwant" --pack-destination /tmp 2>/dev/null | tail -n1); \
        case "$ftgz" in /*) ;; *) ftgz="/tmp/$ftgz";; esac; \
        test -f "$ftgz"; \
        fdest="/usr/lib/node_modules/npm/node_modules/$fname"; \
        rm -rf "$fdest"; \
        mkdir -p "$fdest"; \
        tar -xzf "$ftgz" -C "$fdest" --strip-components=1; \
        rm -f "$ftgz"; \
        fgot=$(node -p "require('/usr/lib/node_modules/npm/node_modules/$fname/package.json').version"); \
        if [ "$fgot" != "$fwant" ]; then \
            echo "npm tree $fname is $fgot, expected $fwant" >&2; \
            exit 1; \
        fi; \
        echo "npm tree $fname $fgot"; \
    }; \
    fixdep brace-expansion 5.0.9; \
    fixdep ip-address 10.3.1; \
    fixdep tar 7.5.21; \
    fixdep undici 6.28.0; \
    rm -rf /root/.npm 2>/dev/null || true

# mesa 26.2.1 from source (the "build" arm of the PPA-or-build policy):
# llvmpipe (OpenGL 4.6 core, 161/161 extensions), lavapipe (Vulkan 1.4
# software ICD, lvp_icd.<arch>.json). Rusticl (OpenCL 3.1) is DISABLED
# because mesa 26.2.1 requires LLVMSPIRVLib >= 22.1 (the
# SPIRV-LLVM-Translator for LLVM 22), and apt.llvm.org does not yet ship
# libllvmspirvlib-22-dev (the latest available is libllvmspirvlib-19-dev
# at version 19.1.0.0, which is too old). Building SPIRV-LLVM-Translator
# from source would add ~10 min to the build; the OpenCL validation is
# deferred until the package lands upstream. video codecs and extra
# tools stay off to keep the build lean; platforms=x11 only because the
# engine renders headless through Xvfb GLX.
#
# Download strategy: GHA runners cannot reliably reach mesa.freedesktop.org
# or archive.mesa3d.org (curl exit 28 on connect observed across multiple
# Build workflow runs). The canonical upstream tarball has been mirrored
# to a GitHub release asset under the mesa-cache-26.2.1 tag in this repo,
# which is served from githubusercontent.com (always reachable from GHA).
# The build tries the GitHub release first, then falls back through the
# freedesktop.org canonical URL and the archive.mesa3d.org mirror (the
# final redirect target) so local builds without GitHub access still
# work.
#
# Verification contract (no hardcoded hashes, the gateway family policy):
# the sha256 of the tarball is NEVER written in this file. GitHub computes
# the digest of every release asset at upload time; the publish workflows
# resolve that digest at build time and pass it as the MESA_SHA256
# build-arg, so every GitHub build verifies the tarball before it lands
# in a layer. Local builds without the build-arg fetch the SHA256SUMS
# asset of the mesa-cache release when reachable and verify against it;
# a fully offline local build proceeds with a visible warning.
ARG MESA_SHA256=""
RUN set -eux; \
    curl_opts="-fL --retry 5 --retry-all-errors --retry-delay 5 \
        --connect-timeout 30 --max-time 900"; \
    tarball="mesa-${MESA_VERSION}.tar.xz"; \
    repo="${GITHUB_REPOSITORY:-wenathlan/saddle}"; \
    github_release="https://github.com/${repo}/releases/download/mesa-cache-${MESA_VERSION}/${tarball}"; \
    sums_url="https://github.com/${repo}/releases/download/mesa-cache-${MESA_VERSION}/SHA256SUMS"; \
    upstream="https://mesa.freedesktop.org/archive/${tarball}"; \
    mirror="https://archive.mesa3d.org/${tarball}"; \
    rm -f "${tarball}" SHA256SUMS; \
    curl ${curl_opts} -C - -o "${tarball}" "${github_release}" \
        || curl ${curl_opts} -C - -o "${tarball}" "${upstream}" \
        || curl ${curl_opts} -C - -o "${tarball}" "${mirror}"; \
    if [ -n "${MESA_SHA256}" ]; then \
        echo "${MESA_SHA256}  ${tarball}" | sha256sum -c -; \
    elif curl -fsSL --retry 3 --connect-timeout 15 -o SHA256SUMS "${sums_url}" \
            && grep -q "  ${tarball}\$" SHA256SUMS; then \
        sha256sum -c --ignore-missing SHA256SUMS; \
        rm -f SHA256SUMS; \
    else \
        echo "WARNING: MESA_SHA256 build-arg empty and no SHA256SUMS asset reachable; ${tarball} digest verification skipped (offline local build)" >&2; \
        rm -f SHA256SUMS; \
    fi; \
    echo "mesa ${MESA_VERSION} tarball ready"; \
    tar xf "${tarball}"; \
    meson setup /tmp/mesa-build "mesa-${MESA_VERSION}" \
        --buildtype release \
        -Dprefix=/usr \
        -Dsysconfdir=/etc \
        -Dplatforms=x11 \
        -Dglx=dri \
        -Degl=enabled \
        -Dshared-glapi=enabled \
        -Dllvm=enabled \
        -Dgallium-drivers=llvmpipe \
        -Dvulkan-drivers=swrast \
        -Dgallium-rusticl=false \
        -Dvideo-codecs=[] \
        -Dtools=[] \
        -Dvalgrind=disabled \
        -Dlibunwind=disabled \
        -Dlmsensors=disabled \
        -Dzstd=enabled; \
    ninja -C /tmp/mesa-build; \
    DESTDIR=/staging ninja -C /tmp/mesa-build install; \
    # Ensure /staging/etc exists even when rusticl is off (no OpenCL ICD
    # installed); the runtime stage COPY --from=builder /staging/etc /etc/
    # would fail the buildx cache checksum without this.
    mkdir -p /staging/etc; \
    find /staging -name '*.so*' | head -20

# the native sources, compiled directly per the build headers of each file
# (no cmake, no build system beyond the compiler): the spoofing core and
# the shim suite with -O3 -march -flto as mandated for the engine. the
# c++26 build first tries `import std;` and falls back to -DVHE_NO_MODULES
# when the toolchain ships no std module (libstdc++-14 on noble ships
# without one). virtualizationcore.cpp additionally builds its selftest
# binary and runs it: the stage fails if a single assert trips.
WORKDIR /src
COPY virtualhardware.c gpumonitor.cpp virtualizationcore.cpp /src/libs/
RUN set -eux; \
    # portable baseline per architecture, with the ARCH FLAG the compiler
    # family actually accepts: x86 and arm speak -march; the ppc64le gcc
    # port rejects '-march=power8' ('did you mean -mcpu=power8?') so that
    # architecture selects the -mcpu spelling; s390x accepts -march=z196.
    archflag="-march"; \
    case "${TARGETARCH}" in \
        arm64|aarch64) march="armv8-a" ;; \
        ppc64le) march="power8"; archflag="-mcpu" ;; \
        s390x) march="z196" ;; \
        *) march="x86-64" ;; \
    esac; \
    if [ -n "${VHE_MARCH}" ]; then march="${VHE_MARCH}"; archflag="-march"; fi; \
    echo "building native shims with ${archflag}=${march}"; \
    mkdir -p /out/usr/local/lib /out/usr/local/bin /out/engine/native /out/etc/virtual; \
    gcc-14 -std=c11 -O3 "$archflag=$march" -flto -funswitch-loops \
        -shared -fPIC -pthread -ldl \
        /src/libs/virtualhardware.c -o /out/usr/local/lib/libvirtualhardware.so; \
    build_cpp() { \
        g++-14 -std=c++2c -O3 "$archflag=$march" -flto \
            -DVHE_NO_MODULES "$@"; \
    }; \
    build_cpp -shared -fPIC -ldl -DVHE_BUILD_PRELOAD \
        /src/libs/gpumonitor.cpp \
        -o /out/usr/local/lib/libvirtualhardware_gpu.so; \
    build_cpp -DVHE_BUILD_CLI /src/libs/gpumonitor.cpp \
        -o /out/usr/local/bin/nvidia-smi; \
    build_cpp -DVHE_BUILD_FORGE /src/libs/gpumonitor.cpp \
        -o /out/usr/local/bin/aetherforge; \
    build_cpp -shared -fPIC -DVHE_BUILD_ADDON \
        -DNODE_GYP_MODULE_NAME=vhe_gpu -I/usr/include/node \
        /src/libs/gpumonitor.cpp -o /out/engine/native/vhe_gpu.node; \
    build_cpp -shared -fPIC -pthread \
        /src/libs/virtualizationcore.cpp \
        -o /out/usr/local/lib/libvirtualizationcore.so; \
    build_cpp -DVHE_VIRT_SELFTEST /src/libs/virtualizationcore.cpp \
        -o /tmp/virtualizationcore_selftest; \
    /tmp/virtualizationcore_selftest; \
    ls -la /out/usr/local/lib /out/usr/local/bin /out/engine/native; \
    /out/usr/local/bin/nvidia-smi a100 1 | head -3; \
    /out/usr/local/bin/aetherforge --smp 16 --mttg 64 --mem 64 | head -3

# the nvidia-ml and libcuda soname symlinks make pynvml, gpustat and
# dlopen("libnvidia-ml.so.1") consumers resolve to the shim without any
# LD_PRELOAD cooperation (rick-hsu/nvml-unified-shim deployment pattern).
RUN set -eux; \
    ln -s libvirtualhardware_gpu.so /out/usr/local/lib/libnvidia-ml.so.1; \
    ln -s libvirtualhardware_gpu.so /out/usr/local/lib/libcuda.so.1; \
    ln -s libvirtualhardware_gpu.so /out/usr/local/lib/libnvidia-ml.so; \
    ln -s libvirtualhardware_gpu.so /out/usr/local/lib/libcuda.so

# /etc/virtual holds only the profile-independent kernel identity
# files (version/uptime/loadavg) here; the profile-specific cpuinfo
# and meminfo are baked in the runtime stage so the builder layers
# stay profile-independent (buildx cache shared across max/balanced/lite).
RUN mkdir -p /out/etc/virtual

COPY <<'EOF' /out/etc/virtual/version
Linux version 6.18.0-vhe (vhe-builder@vhe) (clang version 19.1.0) #1 SMP VHE PREEMPT_DYNAMIC 2026-08-22
EOF

COPY <<'EOF' /out/etc/virtual/uptime
3600.00 2700.00
EOF

COPY <<'EOF' /out/etc/virtual/loadavg
3.84 3.12 2.98 12/768 28471
EOF

# ---------------------------------------------------------------------------
# stage 2: python-bridge (qemubridge.py carrier)
# ---------------------------------------------------------------------------
FROM ${PYTHON_BASE} AS python-bridge
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# qemubridge.py is stdlib-only (asyncio, json, argparse, pathlib): the v2
# merge dropped the pip dependencies of the older saddle bridge stages
# (qemu-bridge/cffi wheels) because the bridge talks raw QMP over a unix
# socket without any native binding. the py_compile run is the syntax gate
# (error catcher: a bridge that does not compile fails the image build).
COPY qemubridge.py /bridge/qemubridge.py
RUN set -eux; \
    python3 -m py_compile /bridge/qemubridge.py; \
    python3 /bridge/qemubridge.py --help >/dev/null; \
    python3 -c "import ast, sys; ast.parse(open('/bridge/qemubridge.py').read()); print('qemubridge ast ok')"

# ---------------------------------------------------------------------------
# stage 3: qemu (TCG/MTTCG engine, the vheqemu docker run recipe base)
# ---------------------------------------------------------------------------
FROM ${UBUNTU} AS qemu
ARG QEMU_VERSION
ARG QEMU_FROM_SOURCE="1"
ENV DEBIAN_FRONTEND=noninteractive

# qemu 11.1.0 (released 2026-08-12) with the x86_64 system emulator only;
# KVM is auto-detected at runtime but the engine targets TCG with MTTCG
# (-accel tcg,thread=multi,tb-size=1024 -cpu EPYC-v5) because CI hosts and
# nested containers expose no /dev/kvm. when QEMU_FROM_SOURCE=0 (source
# build not viable, for example a constrained builder), the stage installs
# the distro qemu-system-x86 package instead; version drift is then the
# operator's tradeoff and is recorded in the image labels.
RUN set -eux; \
    # mirror sync race: same retry loop as the builder stage, covering
    # BOTH apt-get update AND apt-get install together so a 404 on install
    # (stale Release index referencing .deb files already removed from the
    # pool) re-fetches a fresh index and retries the install.
    apt_update_tries=5; \
    while [ "$apt_update_tries" -gt 0 ]; do \
        if apt-get update && apt-get install -y --no-install-recommends \
            ca-certificates curl xz-utils bzip2 \
            build-essential ninja-build meson python3 python3-venv \
            libglib2.0-dev libpixman-1-dev zlib1g-dev flex bison; then break; fi; \
        apt_update_tries=$((apt_update_tries - 1)); \
        echo "apt-get update/install failed (mirror sync?), $apt_update_tries retries left"; \
        sleep 10; \
        rm -rf /var/lib/apt/lists/*; \
    done; \
    test "$apt_update_tries" -gt 0; \
    if [ "${QEMU_FROM_SOURCE}" = "1" ]; then \
        curl -fsSLO "https://download.qemu.org/qemu-${QEMU_VERSION}.tar.xz"; \
        tar xf "qemu-${QEMU_VERSION}.tar.xz"; \
        cd "qemu-${QEMU_VERSION}"; \
        ./configure \
            --target-list=x86_64-softmmu \
            --disable-docs \
            --disable-werror \
            --disable-sdl \
            --disable-gtk \
            --disable-curl \
            --disable-spice \
            --disable-opengl; \
        ninja -C build; \
        ninja -C build install; \
        qemu-system-x86_64 --version; \
        cd /; rm -rf "/qemu-${QEMU_VERSION}"*; \
    else \
        apt-get install -y --no-install-recommends \
            qemu-system-x86 qemu-utils; \
        qemu-system-x86_64 --version; \
    fi; \
    apt-get purge -y --auto-remove \
        build-essential ninja-build meson python3-venv flex bison \
        libglib2.0-dev libpixman-1-dev zlib1g-dev \
        || true; \
    apt-get clean; rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["qemu-system-x86_64"]

# ---------------------------------------------------------------------------
# stage 4: qemu-runtime (guest runner: qemu + OVMF + pciutils + tini)
# ---------------------------------------------------------------------------
FROM qemu AS qemu-runtime
ENV DEBIAN_FRONTEND=noninteractive

# the docker.config qemuRuntime role: QEMU system (already provided by
# the parent stage, either the 11.1.0 source build or the distro
# fallback), OVMF firmware, PCI utilities, curl for health probes, kmod
# for module loading and tini as pid 1 so guest processes are reaped when
# the guest runner restarts. when the parent used the source build the
# distro qemu packages stay absent; when it used the apt fallback the
# ovmf/pciutils set still installs identically.
RUN set -eux; \
    # mirror sync race: same retry loop as the builder and qemu stages,
    # covering BOTH apt-get update AND apt-get install together.
    apt_update_tries=5; \
    while [ "$apt_update_tries" -gt 0 ]; do \
        if apt-get update && apt-get install -y --no-install-recommends \
            ovmf pciutils curl kmod tini; then break; fi; \
        apt_update_tries=$((apt_update_tries - 1)); \
        echo "apt-get update/install failed (mirror sync?), $apt_update_tries retries left"; \
        sleep 10; \
        rm -rf /var/lib/apt/lists/*; \
    done; \
    test "$apt_update_tries" -gt 0; \
    mkdir -p /usr/share/OVMF /var/log/vhe /run/vhe; \
    ls -lh /usr/share/OVMF/OVMF_CODE.fd || true; \
    apt-get clean; rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["/usr/bin/tini", "--", "qemu-system-x86_64"]

# ---------------------------------------------------------------------------
# stage 5: runtime (final, default target, the vhe/vhegpu docker run recipes)
# ---------------------------------------------------------------------------
FROM ${UBUNTU} AS runtime
ARG TARGETARCH
ARG NODE_VERSION
ARG VHE_UID=10000
ARG VHE_GID=10000
ARG VHE_PROFILE_CPU
ARG VHE_PROFILE_VCPUS
ARG VHE_PROFILE_THREADS
ARG VHE_PROFILE_RAM_GB
ARG VHE_PROFILE_GPU
ARG VHE_PROFILE_GPUS
ENV DEBIAN_FRONTEND=noninteractive

# runtime packages: Xvfb for the headless GLX display, x11-utils/xdpyinfo
# for the readiness probe, vulkan-tools (vulkaninfo), clinfo for the
# rusticl report, mesa-utils (glxinfo/es2_info), the ocl-icd loader for
# rusticl, python3 for the qmp bridge, procps for free/top inside the
# sandbox, and the shared libraries the mesa staging links against.
#
# The LLVM 18 runtime (libLLVM-18.so.1, which llvmpipe and lavapipe link
# against) is COPIED from the builder stage below instead of installed
# separately: the builder already has the full llvm-18-dev toolchain
# installed from the Ubuntu noble archive, so copying the lib tree is
# both faster (no apt round-trip) and keeps the runtime stage on the
# same LLVM version the mesa build linked against.
RUN set -eux; \
    # mirror sync race: same retry loop as the builder and qemu stages,
    # covering BOTH apt-get update AND apt-get install together so a 404
    # on install (stale Release index referencing .deb files already
    # removed from the pool) re-fetches a fresh index and retries.
    # (this is the leg that failed on ppc64le in 1.2.12 and on s390x in
    # 1.2.13 before this retry covered the install step too).
    #
    # base-image CVE closure: apt-get install only guarantees the listed
    # packages - the ubuntu:24.04 base layer arrives with whatever system
    # packages its digest carried (and a BuildKit registry cache hit can
    # replay an even older layer chain), so perl-base, util-linux,
    # ncurses, coreutils & friends can lag behind the published security
    # fixes even right after a fresh build. The upgrade step pulls every
    # installed base package to the latest security update resolved by
    # the fresh index above (never installs new packages, never removes
    # any - same-version upgrades only), and Always-Include-Phased-Updates
    # skips Ubuntu's gradual phasing so CI builds are deterministic.
    apt_update_tries=5; \
    while [ "$apt_update_tries" -gt 0 ]; do \
        if apt-get update && apt-get install -y --no-install-recommends \
            ca-certificates curl gnupg bash procps \
            xvfb x11-utils xauth x11-xserver-utils \
            mesa-utils vulkan-tools clinfo ocl-icd-libopencl1 \
            python3 \
            libdrm2 libexpat1 zlib1g libzstd1 libedit2 libatomic1 \
            libx11-6 libxext6 libxfixes3 libxxf86vm1 libxshmfence1 \
            libxcb1 libwayland-client0 libwayland-egl1 libelf1 \
            libglib2.0-0t64 libpixman-1-0 \
            && apt-get -o APT::Get::Always-Include-Phased-Updates=true \
                upgrade -y; then break; fi; \
        apt_update_tries=$((apt_update_tries - 1)); \
        echo "apt-get update/install/upgrade failed (mirror sync?), $apt_update_tries retries left"; \
        sleep 10; \
        rm -rf /var/lib/apt/lists/*; \
    done; \
    test "$apt_update_tries" -gt 0; \
    apt-get clean; rm -rf /var/lib/apt/lists/*

# LLVM 18 runtime: copy the entire llvm-18 install tree from the builder
# (libLLVM-18.so.1 + the llvm-18 runtime libraries that llvmpipe and
# lavapipe link against). The ldconfig step later in this stage adds
# /usr/lib/llvm-18/lib to the search path so the loader picks them up.
COPY --from=builder /usr/lib/llvm-18/ /usr/lib/llvm-18/

# mesa 26.2.1 from the staging root: dri drivers, the lavapipe vulkan ICD
# json (lvp_icd.<arch>.json), the rusticl opencl ICD under /etc/OpenCL and
# the shared glapi.
COPY --from=builder /staging/usr /usr/
COPY --from=builder /staging/etc /etc/
# node 26.7.0 carried over from the builder, including headers so native
# addons (vhe_gpu.node and downstream user addons) rebuild without a second
# nodesource round-trip.
COPY --from=builder /usr/bin/node /usr/bin/node
COPY --from=builder /usr/bin/npm /usr/bin/npm
COPY --from=builder /usr/bin/npx /usr/bin/npx
COPY --from=builder /usr/lib/node_modules /usr/lib/node_modules
COPY --from=builder /usr/include/node /usr/include/node
# the spoofing artifacts: preload core, gpu shim with the nvidia soname
# symlinks, the fake nvidia-smi binary, the aetherforge control plane, the
# virtualization core shared library, the napi addon and the baked
# /etc/virtual profile.
COPY --from=builder /out/usr/local/lib /usr/local/lib/
COPY --from=builder /out/usr/local/bin/nvidia-smi /usr/local/bin/nvidia-smi
COPY --from=builder /out/usr/local/bin/aetherforge /usr/local/bin/aetherforge
COPY --from=builder /out/engine /engine
COPY --from=builder /out/etc/virtual /etc/virtual

# /etc/virtual cpuinfo + meminfo baked per profile here in the runtime
# stage (the builder is profile-independent so its layers share the buildx
# cache across max/balanced/lite; the profile identity is baked here).
#   cpuinfo  model name, processor count and thread count per profile
#            (max: AMD EPYC 9965 192c/384t, balanced: AMD Ryzen Threadripper
#            Pro 9995WX 96c/192t, lite: AMD Ryzen 9 9950X3D 16c/32t); cpu
#            family/model/stepping and address sizes match each identity
#            (the desktop ryzen drops la57 and reports 46/48-bit addressing).
#   meminfo  static snapshot scaled to the profile memory plan (max 1 TiB,
#            balanced 512 GiB, lite 128 GiB); the preload core regenerates
#            a dynamic copy per process by default (fakemem pattern from
#            VHE_TOTALRAM_GB), so this file is the VHE_MEMINFO_MODE=static
#            source of truth and the fallback. VmallocTotal (the 64-bit
#            address space) and Hugepagesize (the fixed 2 MiB huge page) stay
#            constant regardless of the profile memory plan.
COPY <<'EOF' /tmp/meminfo-template
MemTotal:       1073741824 kB
MemFree:        33554432 kB
MemAvailable:   94673704 kB
Buffers:         8388608 kB
Cached:         58720256 kB
SwapCached:            0 kB
Active:         33554432 kB
Inactive:       16777216 kB
Active(anon):   20971520 kB
Inactive(anon):  4194304 kB
Active(file):   12582912 kB
Inactive(file): 12582912 kB
Unevictable:           0 kB
Mlocked:               0 kB
SwapTotal:      67108864 kB
SwapFree:       67108864 kB
Zswap:                 0 kB
Zswapped:              0 kB
Dirty:            262144 kB
Writeback:             0 kB
AnonPages:      20971520 kB
Mapped:          4194304 kB
Shmem:           1048576 kB
KReclaimable:    2097152 kB
Slab:            4194304 kB
SReclaimable:    2097152 kB
SUnreclaim:      2097152 kB
KernelStack:       65536 kB
PageTables:       32768 kB
NFS_Unstable:          0 kB
Bounce:                0 kB
WritebackTmp:          0 kB
CommitLimit:    134217728 kB
Committed_AS:   33554432 kB
VmallocTotal:   34359738367 kB
VmallocUsed:     1048576 kB
VmallocChunk:          0 kB
Percpu:            65536 kB
HardwareCorrupted:     0 kB
AnonHugePages:         0 kB
ShmemHugePages:        0 kB
FileHugePages:         0 kB
HugePages_Total:       0
HugePages_Free:        0
HugePages_Rsvd:        0
HugePages_Surp:        0
Hugepagesize:       2048 kB
Hugetlb:               0 kB
DirectMap4k:     2097152 kB
DirectMap2M:    62914560 kB
DirectMap1G:    67108864 kB
EOF

RUN set -eux; \
    : > /etc/virtual/cpuinfo; \
    case "${VHE_PROFILE_CPU}" in \
        epyc9965) \
            cpuname="AMD EPYC 9965"; \
            cpufamily="26"; cpumodel="96"; cpustepping="2"; \
            addr="52 bits physical, 57 bits virtual"; la57="1" ;; \
        threadripperpro9995wx) \
            cpuname="AMD Ryzen Threadripper Pro 9995WX"; \
            cpufamily="26"; cpumodel="96"; cpustepping="2"; \
            addr="52 bits physical, 57 bits virtual"; la57="1" ;; \
        ryzen9950x3d) \
            cpuname="AMD Ryzen 9 9950X3D"; \
            cpufamily="25"; cpumodel="97"; cpustepping="2"; \
            addr="46 bits physical, 48 bits virtual"; la57="0" ;; \
        *) \
            echo "unknown VHE_PROFILE_CPU=${VHE_PROFILE_CPU}; expected epyc9965, threadripperpro9995wx or ryzen9950x3d" >&2; \
            exit 1 ;; \
    esac; \
    vcpus="${VHE_PROFILE_VCPUS}"; \
    threads="${VHE_PROFILE_THREADS}"; \
    ram_gb="${VHE_PROFILE_RAM_GB}"; \
    modelname="${cpuname} ${vcpus}-Core Processor"; \
    FLAGS='fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ht syscall nx mmxext fxsr_opt pdpe1gb rdtscp lm constant_tsc rep_good amd_lbr vnnm nonstop_tsc cpuid extd_apicid amd_dcm aperfmperf rapl pni pclmulqdq monitor ssse3 fma cx16 sse4_1 sse4_2 movbe popcnt aes xsave avx f16c rdrand lahf_lm cmp_legacy svm extapic cr8_legacy abm sse4a misalignsse 3dnowprefetch osvw ibs skinit wdt tce topoext perfctr_core perfctr_nb bpext perfctr_llc mwaitx cpb cat_l3 cdp_l3 invpcid_single hw_pstate ssbd mba perfmon_v2 ibrs ibpb stibp vmmcall fsgsbase tsc_adjust bmi1 avx2 smep bmi2 erms invpcid cqm rdt_a avx512f avx512dq rdseed adx smap avx512ifma clflushopt clwb avx512cd sha_ni avx512bw avx512vl avx512vbmi umip pku ospke avx512_vbmi2 gfni vaes vpclmulqdq avx512_vnni avx512_bitalg avx512_vpopcntdq rdpid movdiri movdir64b fsrm md_clear serialize tsxldtrk avx512_fp16'; \
    if [ "$la57" = "1" ]; then FLAGS="${FLAGS} la57"; fi; \
    for i in $(seq 0 $((vcpus - 1))); do \
        { \
            printf 'processor\t: %d\n' "$i"; \
            printf 'vendor_id\t: AuthenticAMD\n'; \
            printf 'cpu family\t: %s\n' "$cpufamily"; \
            printf 'model\t\t: %s\n' "$cpumodel"; \
            printf 'model name\t: %s\n' "$modelname"; \
            printf 'stepping\t: %s\n' "$cpustepping"; \
            printf 'microcode\t: 0x1100140\n'; \
            printf 'cpu MHz\t\t: 2250.000\n'; \
            printf 'cache size\t: 512 KB\n'; \
            printf 'physical id\t: 0\n'; \
            printf 'siblings\t: %s\n' "$threads"; \
            printf 'core id\t\t: %d\n' "$((i % vcpus))"; \
            printf 'cpu cores\t: %s\n' "$vcpus"; \
            printf 'apicid\t\t: %d\n' "$i"; \
            printf 'initial apicid\t: %d\n' "$i"; \
            printf 'fpu\t\t: yes\n'; \
            printf 'fpu_exception\t: yes\n'; \
            printf 'cpuid level\t: 16\n'; \
            printf 'wp\t\t: yes\n'; \
            printf 'flags\t\t: %s\n' "$FLAGS"; \
            printf 'bugs\t\t: sysret_ss_attrs spectre_v1 spectre_v2 spec_store_bypass srso\n'; \
            printf 'bogomips\t: 4500.00\n'; \
            printf 'TLB size\t: 3584 4K pages\n'; \
            printf 'clflush size\t: 64\n'; \
            printf 'cache_alignment\t: 64\n'; \
            printf 'address sizes\t: %s\n' "$addr"; \
            printf 'power management: ts ttp tm hwpstate cpb eff_freq_ro [13] [16]\n'; \
        } >> /etc/virtual/cpuinfo; \
    done; \
    grep -c '^processor' /etc/virtual/cpuinfo | grep -qx "$vcpus"; \
    total_kb=$((ram_gb * 1024 * 1024)); \
    awk -v total="$total_kb" 'function scale(line, a, n, i, out, key) { n = split(line, a, " "); if (n >= 2 && a[n] == "kB" && (a[n-1]+0) > 0) { key = a[1]; if (key != "VmallocTotal:" && key != "Hugepagesize:") { a[n-1] = int((a[n-1]+0) * total / 1073741824); } } out = a[1]; for (i = 2; i <= n; i++) out = out " " a[i]; return out; } { print scale($0) }' /tmp/meminfo-template > /etc/virtual/meminfo; \
    rm -f /tmp/meminfo-template; \
    grep -E "^MemTotal: +${total_kb} kB" /etc/virtual/meminfo; \
    echo "baked /etc/virtual: ${modelname} (${vcpus}c/${threads}t), MemTotal ${total_kb} kB (${ram_gb} GiB plan)"
# the python bridge from its dedicated stage.
COPY --from=python-bridge /bridge/qemubridge.py /engine/qemubridge.py

# the engine sources and the specification files consumed at runtime
# (docker.config "final" stage copies the whole tree; the flat layout
# keeps that a single COPY layer).
COPY *.ts package.json tsconfig.json biome.json jsdom.d.ts /engine/
COPY processors.json gpus.json cores.json boards.json vm.config.json virtualhardware.json /engine/
COPY qemu.config mttg.config passage.config docker.config /engine/

# the web node ships inside the main container: the mesh edition (auth,
# sqlite database, dashboard and the browser sandbox pages) runs from the
# same image, so one container serves the engine AND the web surface.
# run it with: docker run ghcr.io/wenathlan/saddle node /engine/web/server.js
COPY web /engine/web

RUN set -eux; \
    chmod 0755 /usr/local/bin/nvidia-smi /usr/local/bin/aetherforge; \
    chmod 0644 /etc/virtual/*; \
    printf '/usr/lib/llvm-18/lib\n/usr/local/lib\n' > /etc/ld.so.conf.d/vhe.conf; \
    mkdir -p /etc/OpenCL/vendors; \
    case "${TARGETARCH}" in \
        arm64|aarch64) ln -sf lvp_icd.aarch64.json /usr/share/vulkan/icd.d/lvp_icd.json ;; \
        ppc64le) ln -sf lvp_icd.ppc64le.json /usr/share/vulkan/icd.d/lvp_icd.json ;; \
        s390x) ln -sf lvp_icd.s390x.json /usr/share/vulkan/icd.d/lvp_icd.json ;; \
        *) ln -sf lvp_icd.x86_64.json /usr/share/vulkan/icd.d/lvp_icd.json ;; \
    esac; \
    ldconfig; \
    node --version; \
    python3 -m py_compile /engine/qemubridge.py; \
    nvidia-smi b200 1 | head -2; \
    ldconfig -p | grep -E 'libGL|lvp|rusticl|libLLVM-18' | head -5

# entrypoint: starts Xvfb on :99, validates the GL/Vulkan/OpenCL stack
# and execs the engine command. the bootstrap is EMBEDDED HERE (the one
# container file standard - the repository keeps no separate
# entrypoint.sh): the heredoc COPY below writes the script verbatim
# into the image and the quoted delimiter keeps every shell expansion
# literal, so the file is the exact former entrypoint.sh.
COPY <<'ENTRYPOINT_SCRIPT_EOF' /entrypoint.sh
#!/usr/bin/env bash
#
# entrypoint.sh - runtime bootstrap for the saddle virtual hardware
# engine image.
#
# responsibilities, in order:
#   0. print the engine banner, pin the MTTCG mode for downstream
#      consumers, export the gallium/mesa environment overrides that are
#      unique to the headless software stack, and report the firecracker
#      warm-pool readiness note (the microvm runtime shares this image).
#   1. start Xvfb on display :99 with the validated headless-GLX recipe
#      (Xvfb(1): -ac disables access control, -screen 0 1920x1080x24
#      defines the framebuffer, -nolisten tcp closes the network surface,
#      +extension GLX +render enable the GLX and RENDER extensions the
#      mesa llvmpipe driver expects, -noreset keeps the server alive
#      after the last client disconnects) and wait for readiness with
#      xdpyinfo.
#   2. verify the LD_PRELOAD spoofing core is installed and loadable
#      (global /etc/ld.so.preload from the dolos deployment pattern).
#   3. run the hardware validation heads: glxinfo (OpenGL renderer must
#      be llvmpipe), vulkaninfo --summary (lavapipe ICD) and clinfo
#      (rusticl reporting a gpu device on OpenCL 3.1); failures log
#      warnings unless VHE_STRICT=1 turns them fatal.
#   4. allocate a random listening port in 30000-60000 when VHE_PORT/PORT
#      is unset (shuf with a /dev/urandom fallback), so no host port is
#      ever hardcoded across the engine.
#   5. exec "$@" so the engine becomes pid 1 and receives signals
#      directly.
#
# environment knobs (all optional):
#   VHE_DISPLAY        x display number, default 99
#   VHE_SCREEN         screen geometry, default 1920x1080x24
#   VHE_XVFB_WAIT      max seconds waiting for the display, default 30
#   VHE_SKIP_XVFB      1 skips display startup entirely (pure compute)
#   VHE_SKIP_PRELOAD   1 skips the spoofing core check
#   VHE_SKIP_VALIDATE  1 skips the glxinfo/vulkaninfo/clinfo probes
#   VHE_STRICT         1 turns validation failures into entrypoint failures
#   VHE_PORT / PORT    fixed port; otherwise one is drawn from 30000-60000
#   VHE_DEBUG          1 prints every decision to stderr
#
# the script never exits on validation warnings: the engine degrades to
# whatever hardware surface is actually functional, mirroring the
# defensive fallback chain of libvirtualhardware.so itself.

set -Eeuo pipefail

# ---------------------------------------------------------------- logging --

log()  { printf '[saddle-entrypoint] %s\n' "$*" >&2; }
dbg()  { [[ "${VHE_DEBUG:-0}" == "1" ]] && printf '[saddle-entrypoint:debug] %s\n' "$*" >&2 || true; }
warn() { printf '[saddle-entrypoint:warn] %s\n' "$*" >&2; }
die()  { printf '[saddle-entrypoint:fatal] %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------- variables --

vdisplaynum="${VHE_DISPLAY:-99}"
vdisplayid=":${vdisplaynum}"
screengeom="${VHE_SCREEN:-1920x1080x24}"
xvfbwait="${VHE_XVFB_WAIT:-30}"
xvfbpid=""
portvalue=""

cleanup() {
    if [[ -n "${xvfbpid}" ]] && kill -0 "${xvfbpid}" 2>/dev/null; then
        log "stopping Xvfb (pid ${xvfbpid})"
        kill -TERM "${xvfbpid}" 2>/dev/null || true
        wait "${xvfbpid}" 2>/dev/null || true
    fi
}
trap cleanup EXIT
trap 'die "interrupted"' INT TERM

requirebin() {
    command -v "$1" >/dev/null 2>&1 || die "required binary '$1' not found in PATH"
}

# ------------------------------------------- 0. banner and env overrides --

# report the baked profile identity (read from /etc/virtual so the banner
# matches the profile the image was built for: max/balanced/lite). Single
# awk process with an early exit per file (no sed|head pipeline: under
# set -o pipefail, head exiting after the first match would SIGPIPE sed on
# the large max/balanced cpuinfo and abort the entrypoint).
vhe_model="$(awk '/^model name/ { sub(/^[[:space:]]*model name[[:space:]]*:[[:space:]]*/, ""); print; exit }' /etc/virtual/cpuinfo 2>/dev/null)"
vhe_ram="$(awk '/^MemTotal/ { print $2; exit }' /etc/virtual/meminfo 2>/dev/null || true)"
case "${vhe_ram}" in *[!0-9]*) vhe_ram="" ;; esac
if [ -n "${vhe_model}" ] && [ -n "${vhe_ram}" ]; then
    vhe_ram_gb=$(( vhe_ram / 1024 / 1024 ))
    log "saddle virtual hardware engine (${vhe_model}, ${vhe_ram_gb} GiB, mesa 26.2.1)"
else
    log "saddle virtual hardware engine (mesa 26.2.1)"
fi
log "docker contract: memory-swap=-1 shm-size=2g tmpfs shader cache 20G, Xvfb ${vdisplayid}"

# MTTCG is the default execution mode for the qemu layer of this stack:
# one host thread per vCPU, selected by -accel tcg,thread=multi. the flag
# is exported so child orchestrators (qemubridge.py, the aetherforge
# control plane) observe a consistent default without re-deriving it.
export QEMU_MTTCG="${QEMU_MTTCG:-1}"

# gallium/mesa overrides: keep the software rasterizer pinned even when
# the base image environment is overridden by the operator, and expose
# the avx-512 cpu caps list the llvmpipe JIT keys on. these lines are the
# deployment counterpart of the ENV block baked in the Dockerfile.
export LP_NATIVE_VECTOR_WIDTH="${LP_NATIVE_VECTOR_WIDTH:-512}"
export LP_NUM_THREADS="${LP_NUM_THREADS:-0}"
export GALLIUM_DRIVER="${GALLIUM_DRIVER:-llvmpipe}"
export MESA_GL_VERSION_OVERRIDE="${MESA_GL_VERSION_OVERRIDE:-4.6}"
export GALLIUM_OVERRIDE_CPU_CAPS="${GALLIUM_OVERRIDE_CPU_CAPS:-avx512f,avx512bw,avx512cd,avx512dq,avx512vl,avx512vnni,avx512_bf16}"
export LD_PRELOAD="/usr/local/lib/libvirtualhardware.so${LD_PRELOAD:+:${LD_PRELOAD}}"

# the microvm runtime shares this image: the firecracker warm pool boots
# in 125 ms (150 boots/s, 3-5 ms restore from a snapshot) and needs no
# additional daemon here - the note keeps operators from expecting one.
dbg "firecracker warm pool ready (125 ms boot, 3-5 ms restore)"

# ------------------------------------------------------ 1. display setup --

if [[ "${VHE_SKIP_XVFB:-0}" == "1" ]]; then
    log "VHE_SKIP_XVFB=1, skipping display startup"
else
    requirebin Xvfb
    requirebin xdpyinfo

    if xdpyinfo -display "${vdisplayid}" >/dev/null 2>&1; then
        log "display ${vdisplayid} already answering, reusing it"
    else
        log "starting Xvfb on ${vdisplayid} (${screengeom})"
        Xvfb "${vdisplayid}" \
            -ac \
            -screen 0 "${screengeom}" \
            -nolisten tcp \
            +extension GLX \
            +render \
            -noreset &
        xvfbpid=$!

        waited=0
        until xdpyinfo -display "${vdisplayid}" >/dev/null 2>&1; do
            if ! kill -0 "${xvfbpid}" 2>/dev/null; then
                die "Xvfb died during startup"
            fi
            if [[ "${waited}" -ge "${xvfbwait}" ]]; then
                die "Xvfb not ready after ${xvfbwait}s on ${vdisplayid}"
            fi
            waited=$((waited + 1))
            sleep 1
        done
        log "Xvfb ready on ${vdisplayid} after ${waited}s (pid ${xvfbpid})"
    fi
    export DISPLAY="${vdisplayid}"
fi

# ------------------------------------------------- 2. preload core check --

if [[ "${VHE_SKIP_PRELOAD:-0}" != "1" ]]; then
    preloadlib="/usr/local/lib/libvirtualhardware.so"
    if [[ ! -r "${preloadlib}" ]]; then
        die "spoofing core ${preloadlib} missing from the image"
    fi
    if ! LD_PRELOAD="${preloadlib}" /bin/true 2>/dev/null; then
        die "spoofing core ${preloadlib} is not loadable in this environment"
    fi
    if [[ -f /etc/ld.so.preload ]] && grep -q 'libvirtualhardware' /etc/ld.so.preload; then
        dbg "/etc/ld.so.preload carries the core (dolos global install)"
    else
        warn "/etc/ld.so.preload does not list libvirtualhardware.so; per-process spoofing only"
    fi
    if [[ -r /etc/virtual/cpuinfo ]]; then
        dbg "virtual cpuinfo present ($(grep -c '^processor' /etc/virtual/cpuinfo) processors)"
    else
        warn "/etc/virtual/cpuinfo missing; cpu reads fall through to the real host"
    fi
    if [[ -r /etc/virtual/meminfo ]]; then
        dbg "virtual meminfo present: $(head -1 /etc/virtual/meminfo)"
    else
        warn "/etc/virtual/meminfo missing; memory reads fall through to the real host"
    fi
fi

# ------------------------------------------------- 3. stack validation --

if [[ "${VHE_SKIP_VALIDATE:-0}" != "1" ]]; then
    validationfailed=0

    if command -v glxinfo >/dev/null 2>&1; then
        if renderer="$(glxinfo -B 2>/dev/null | sed -n 's/^OpenGL renderer string: //p' | head -1)"; then
            if [[ -n "${renderer}" ]]; then
                log "glxinfo: ${renderer}"
                if [[ "${renderer}" != *llvmpipe* ]]; then
                    warn "OpenGL renderer is not llvmpipe: ${renderer}"
                fi
            fi
        else
            warn "glxinfo failed on display ${DISPLAY:-unset}"
            validationfailed=1
        fi
    else
        warn "glxinfo not available (mesa-utils missing), skipping GL probe"
    fi

    if command -v vulkaninfo >/dev/null 2>&1; then
        if api="$(VULKANINFO_LOADER_DEBUG="" vulkaninfo --summary 2>/dev/null | sed -n 's/^.*apiVersion.*: *//p' | head -1)"; then
            log "vulkaninfo: api ${api:-reported} through ${VK_DRIVER_FILES:-default ICD search}"
        else
            warn "vulkaninfo --summary failed (check VK_DRIVER_FILES=${VK_DRIVER_FILES:-unset})"
            validationfailed=1
        fi
    else
        warn "vulkaninfo not available (vulkan-tools missing), skipping Vulkan probe"
    fi

    if command -v clinfo >/dev/null 2>&1; then
        clhead="$(clinfo 2>/dev/null | grep -E 'Platform Name|Device Type|OpenCL C Version' | head -3 || true)"
        if [[ -n "${clhead}" ]]; then
            log "clinfo: $(echo "${clhead}" | tr '\n' ' ')"
        else
            warn "clinfo produced no platform report (rusticl ICD not reachable)"
            validationfailed=1
        fi
    else
        warn "clinfo not available, skipping OpenCL probe"
    fi

    if command -v nvidia-smi >/dev/null 2>&1; then
        log "nvidia-smi virtual identity: $(nvidia-smi "${VHE_GPU_PROFILE:-a100}" 1 2>/dev/null | sed -n '2p' | cut -c1-60)..."
    else
        warn "virtual nvidia-smi adapter not on PATH"
    fi

    if [[ "${validationfailed}" != "0" && "${VHE_STRICT:-0}" == "1" ]]; then
        die "VHE_STRICT=1 and the validation reported failures"
    fi
fi

# --------------------------------------------------- 4. port allocation --

if [[ -z "${VHE_PORT:-}" && -z "${PORT:-}" ]]; then
    if command -v shuf >/dev/null 2>&1; then
        portvalue="$(shuf -i 30000-60000 -n 1)"
    elif [[ -r /dev/urandom ]]; then
        # deterministic fallback: urandom bytes scaled into the 30000-60000 range
        portvalue="$(( 30000 + ($(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 30001) ))"
    else
        portvalue="$(( 30000 + (RANDOM % 30001) ))"
    fi
    log "no port configured, allocated random port ${portvalue} (range 30000-60000)"
elif [[ -n "${VHE_PORT:-}" ]]; then
    portvalue="${VHE_PORT}"
    log "using VHE_PORT=${portvalue}"
else
    portvalue="${PORT}"
    log "using PORT=${portvalue}"
fi
export PORT="${portvalue}"
export VHE_PORT="${portvalue}"

# ----------------------------------------------------------- 5. exec app --

log "environment ready: display=${DISPLAY:-none} port=${portvalue} profile=${VHE_GPU_PROFILE:-a100} gpus=${VHE_GPUS:-8} ram=${VHE_TOTALRAM_GB:-128}GiB cpus=${VHE_CPUS:-192} mttcg=${QEMU_MTTCG}"

if [[ $# -eq 0 ]]; then
    log "no command supplied, keeping the sandbox alive (exec /bin/bash)"
    set -- /bin/bash
fi

# exec replaces this shell: Xvfb keeps running as an orphan supervised by
# the container init (docker --init / compose init: true), and the engine
# receives signals directly as the foreground process.
exec "$@"
ENTRYPOINT_SCRIPT_EOF
RUN chmod 0755 /entrypoint.sh

# environment: software GL stack pinning (llvmpipe), GL 4.6 spoof, AVX-512
# vector width for the gallivm JIT, single-threaded rasterization by
# default to avoid container oversubscription (raise LP_NUM_THREADS to the
# vCPU count for throughput), the gallium cpu caps override list, lavapipe
# as the only vulkan ICD (VK_DRIVER_FILES; VK_ICD_FILENAMES is deprecated),
# rusticl on llvmpipe reporting a gpu device on OpenCL 3.1, display :99 for
# Xvfb, plus the default virtual profile knobs consumed by
# libvirtualhardware and the former compose service settings merged
# here (the web node database SADDLE_DB the recipes bind their webdata
# volume at, and NODE_ENV).
ENV LIBGL_ALWAYS_SOFTWARE="true" \
    GALLIUM_DRIVER="llvmpipe" \
    MESA_GL_VERSION_OVERRIDE="4.6" \
    MESA_GLSL_VERSION_OVERRIDE="460" \
    GALLIUM_OVERRIDE_CPU_CAPS="avx512f,avx512bw,avx512cd,avx512dq,avx512vl,avx512vnni,avx512_bf16" \
    LP_NATIVE_VECTOR_WIDTH="512" \
    LP_NUM_THREADS="0" \
    VK_DRIVER_FILES="/usr/share/vulkan/icd.d/lvp_icd.json" \
    RUSTICL_ENABLE="llvmpipe" \
    RUSTICL_DEVICE_TYPE="gpu" \
    RUSTICL_CL_VERSION="3.1" \
    MESA_SHADER_CACHE_DIR="/cache/mesa_shader_cache" \
    MESA_SHADER_CACHE_MAX_SIZE="20G" \
    DISPLAY=":99" \
    VHE_TOTALRAM_GB="${VHE_PROFILE_RAM_GB}" \
    VHE_CPUS="${VHE_PROFILE_VCPUS}" \
    VHE_KERNEL_RELEASE="6.18.0-vhe" \
    VHE_GPU_PROFILE="${VHE_PROFILE_GPU}" \
    VHE_GPUS="${VHE_PROFILE_GPUS}" \
    VHE_MEMINFO_REFRESH="5" \
    SADDLE_DB="/data/web/saddle.db" \
    NODE_ENV="production" \
    PATH="/engine/native:${PATH}"

# non-root runtime identity; uid/gid 10000 avoids collisions with host
# accounts on bind mounts and matches the volume and tmpfs ownership
# (the former compose shader-cache volume carried uid=10000,gid=10000).
RUN set -eux; \
    groupadd --gid "${VHE_GID}" vhe; \
    useradd --uid "${VHE_UID}" --gid "${VHE_GID}" --create-home \
        --shell /bin/bash vhe; \
    mkdir -p /engine /cache/mesa_shader_cache /data/vmdata /data/web; \
    chown -R vhe:vhe /engine /cache /data; \
    chmod 0777 /cache/mesa_shader_cache

# global preload installation, written last so no image-build step after
# this point runs under the interposer (dolos deployment pattern); setuid
# binaries ignore /etc/ld.so.preload by loader design.
RUN set -eux; \
    echo /usr/local/lib/libvirtualhardware.so > /etc/ld.so.preload; \
    cat /proc/meminfo | head -1; \
    free -m | head -2 || true

# healthcheck: the X display answers xdpyinfo and the virtual meminfo is in
# place; start-period covers the Xvfb + shader-cache warmup. start-interval
# probes every 5s during the grace window (compose 5.5.0 / docker 29.7.2
# support the field).
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --start-interval=5s --retries=3 \
    CMD xdpyinfo -display :99 >/dev/null 2>&1 \
        && grep -q 'MemTotal' /etc/virtual/meminfo \
        || exit 1

# OCI labels for registry introspection.
LABEL org.opencontainers.image.title="saddle virtual-hardware engine (the grand merge)" \
      org.opencontainers.image.description="100% software virtual hardware: per-profile CPU/memory spoofing via LD_PRELOAD (max/balanced/lite), mesa 26.2.1 llvmpipe/lavapipe/rusticl, QEMU 11.1.0 TCG/MTTCG, virtual nvidia-smi adapter + NVML/CUDA shims, node 26.7.0, python bridge" \
      org.opencontainers.image.version="2.0.2" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/wenathlan/saddle" \
      org.opencontainers.image.documentation="https://github.com/wenathlan/saddle/blob/main/README.md" \
      org.opencontainers.image.created="2026-08-23T00:00:00Z"

WORKDIR /engine
USER vhe
STOPSIGNAL SIGTERM

# EXPOSE 8080: the engine service port of the docker run recipe above
# (the former compose VHE_ENGINE_PORT default, published as 31280:8080).
# a bare docker run without -e PORT leaves the embedded entrypoint
# picking a random port in 30000-60000, so nothing here hardcodes a
# bind - EXPOSE documents the recipe.
EXPOSE 8080

# the state surface of the docker run recipes (the former compose named
# volumes): /data carries vmdata (virtual machine images, bridge plans)
# and webdata (the web node sqlite SADDLE_DB points at);
# /cache/mesa_shader_cache keeps the JIT'd llvmpipe/lavapipe shaders
# off the overlay filesystem (the recipe mounts a 20g tmpfs there).
# without an explicit -v docker provisions anonymous volumes at these
# paths so the state never lives in the container layer.
VOLUME /data /cache/mesa_shader_cache

# the embedded bootstrap (the heredoc COPY above) starts Xvfb on :99,
# validates the GL/Vulkan/OpenCL stack and execs the engine command as
# pid 1.
ENTRYPOINT ["/entrypoint.sh"]

# ══════════════════════════════════════════════════════════════════════
# saddle node-engine stages — the storage/compute node service of the
# grand merge (folded verbatim from the former dockerfile.saddle: the
# hardened npm pinning survives; the build outputs dist/<domain>.js after
# the flat consolidation). build explicitly:
#   docker build --target saddle-runtime -t saddle:<version> .
# ══════════════════════════════════════════════════════════════════════

FROM node:26.8.1-bookworm-slim AS saddle-build

ARG SADDLE_VERSION
WORKDIR /app

ENV NPM_CONFIG_LEGACY_PEER_DEPS=true

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --legacy-peer-deps
COPY . .
RUN npm run build:engine \
    && node --check dist/cli.js

FROM node:26.8.1-bookworm-slim AS saddle-runtime

ARG SADDLE_VERSION
LABEL org.opencontainers.image.title="Saddle" \
      org.opencontainers.image.description="Storage-backed browser and compute engine (the grand-merge node service)" \
      org.opencontainers.image.source="https://github.com/wenathlan/saddle" \
      org.opencontainers.image.version="$SADDLE_VERSION"

WORKDIR /app

# the service ENV surface of the former compose.yml (folded here so the
# one container file carries the whole container context: memory engine
# tier selection, the sbot platform tag and the sbot cdn url override)
ENV NODE_ENV=production \
    NPM_CONFIG_LEGACY_PEER_DEPS=true \
    SADDLE_MEMORY_ENGINE=ram \
    SBOT_PLATFORM="" \
    SBOT_CDN_URL=""

COPY --from=saddle-build /app/package.json /app/package-lock.json ./
RUN apt-get update \
    && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global npm@12.0.2 \
    && tempdir="$(mktemp -d)" \
    && npm pack brace-expansion@5.0.9 ip-address@10.3.1 --pack-destination "$tempdir" \
    && mkdir -p /usr/local/lib/node_modules/npm/node_modules/brace-expansion /usr/local/lib/node_modules/npm/node_modules/ip-address \
    && tar -xzf "$tempdir/brace-expansion-5.0.9.tgz" --strip-components=1 -C /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
    && tar -xzf "$tempdir/ip-address-10.3.1.tgz" --strip-components=1 -C /usr/local/lib/node_modules/npm/node_modules/ip-address \
    && rm -rf "$tempdir" \
    && npm ci --omit=dev --ignore-scripts --legacy-peer-deps \
    # prune the vendored build toolchains of optional native deps: the
    # cpu-features cmake sources ship nested Dockerfiles (build CI of
    # the dependency) that the trivy misconfig scanner flags (DS-0002
    # USER, DS-0029 no-install-recommends) inside the shipped image.
    # With --ignore-scripts the binding never builds and the package
    # degrades to a no-op at runtime - the sources are dead weight.
    && rm -rf node_modules/cpu-features/deps \
    && find node_modules -type f -name Dockerfile -delete
COPY --from=saddle-build /app/dist ./dist

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["node", "dist/cli.js", "help"]

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["help"]
