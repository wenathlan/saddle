# Container platform decision for 2.1.0

## Scope

Version 2.1.0 expands the Saddle node-engine OCI image (the `saddle-runtime`
target of the one container file, published by the `publish ghcr` workflow)
from a three-platform Linux manifest index to the four-architecture family
surface: `linux/amd64`, `linux/arm64`, `linux/ppc64le`, and `linux/s390x`.
The selection unifies the container surfaces of the grand merge: the saddle
lineage shipped amd64/arm64/ppc64le (the 1.8.17 decision, see
[containerplatforms-1.8.17.md](containerplatforms-1.8.17.md)) and the e2ugh
lineage published all four architectures for the virtual-hardware engine
(`publish ghcr vhe`). One product, one registry, one architecture surface:
the s390x leg joins the node engine from the e2ugh side of the family.

## Platform matrix

`linux/amd64` stays because it is the primary GitHub runner architecture and
the local smoke-test platform. `linux/arm64`, `linux/ppc64le` and
`linux/s390x` stay (or join) because the vhe engine of the same repository
already builds, publishes and verifies those architectures under QEMU
emulation - the publish ghcr vhe lane proves the build path - and the
node-engine build is a strict subset of that work (npm tooling, no mesa,
no qemu compilation).[1] [2]

`linux/arm/v7` and `linux/386` remain deferred because no inspected Node 26
base manifest exposes them. `windows/amd64` remains deferred (see the 1.8.17
decision): the Dockerfile uses Debian Linux stages and a Windows container
needs a Windows-specific base image, runner and smoke tests. `unknown/*`
remains rejected: OCI `unknown` descriptors are not a runnable target and
must not be advertised as a Saddle container platform.

## Base image prerequisite (the s390x gap of the bookworm-slim variant)

The current node-engine stages build `FROM node:26.8.1-bookworm-slim`. The
manifest index of that tag (inspected through the Docker Hub registry API on
2026-09-06, the same view `docker manifest inspect` reads) exposes exactly
`linux/amd64`, `linux/arm64` and `linux/ppc64le` - the bookworm-slim variant
does not publish an s390x entry. The Node 26 tags that DO carry s390x are
the default-distro (Debian trixie) variants: `node:26.8.1` and
`node:26.8.1-slim`. The four-arch publication therefore requires the
`saddle-build` and `saddle-runtime` FROM lines of the one container file to
move to a trixie-based variant (for example `node:26.8.1-slim`, keeping the
slim profile) before the first 2.1.0 publish run; until that base swap
lands, the buildx s390x leg cannot resolve its base manifest and the publish
job fails at the platform-resolution step. That Dockerfile change belongs to
the same 2.1.0 wave as this decision document (it is recorded here because
the container file is not part of this workflow-restoration change set).

## Workflow design

The `publish ghcr` workflow registers QEMU (arm64, ppc64le, s390x emulation)
before Buildx, scans a loadable `linux/amd64` image (GitHub-hosted runners
cannot load a multi-platform image into the default local image store, so
the scan build stays single-platform while the publication is pushed
directly to GHCR), pushes all four Linux variants through one Buildx
invocation, and verifies the registry manifest index for the four
architectures before the amd64 label and CLI smoke test.[2] The publish lane
also carries the restored idempotency gates: the resolve job (tag ==
package.json == published release, plus the e2ugh "already shipped"
tag/HEAD guard) so a duplicate release firing no-ops instead of repushing.

## Publication claims

The version 2.1.0 release notes and registry documentation may claim only
the four verified Linux variants after the pushed image index is inspected.
They must not claim Windows support, an `unknown` platform, or a universal
OS image.

## References

[1]: https://docs.docker.com/build/building/multi-platform/ "Docker multi-platform builds"
[2]: https://docs.docker.com/build/ci/github-actions/multi-platform/ "Multi-platform image with GitHub Actions"
