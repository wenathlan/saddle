# Security Policy — the saddle grand merge (storage/compute engine + the e2ugh virtual-hardware engine)

## Supported release line

Security fixes target the maintained `2.x` line and later maintained
releases (the grand-merge lineage: saddle 2.0.0 absorbs the e2ugh engine
1.2.x line; the pre-merge repositories remain archived as private
repositories with their full history).

## Scope of the merged repository

The grand merge carries two engine surfaces:

- **the saddle node engine** — a binary computing engine that turns
  distributed storage into a publishable working set (browsers, runners,
  adapters, memory/storage/persistence contracts);
- **the e2ugh virtual hardware engine** — 100 percent software virtual
  hardware: CPU, memory and GPU identities spoofed through an
  LD_PRELOAD interposition layer, a Mesa llvmpipe/lavapipe/rusticl
  software GL stack and QEMU TCG/MTTCG guest execution. No physical
  hardware is probed, touched or required.

The engine image runs as the non-root `vhe` user (uid/gid 10000) with no
published port; the entrypoint embedded in the one container file (the
Dockerfile heredoc) picks a random port in 30000-60000 unless the
operator pins `VHE_PORT`/`PORT`. The saddle node-engine image runs as
the non-root `node` user with the same no-port-by-default posture.

## Secrets and credentials

The public repository must not include provider keys, session cookies,
database files, captured authorization headers or `.env` payloads. The
web console node reads its mesh HMAC key from the `E2UGH_MESH_KEY`
environment variable and its database path from `E2UGH_DB`; both are
operator supplied and never committed. The CI secret-scan gates
(TruffleHog with `--results=verified` over the full git history) and
the Trivy filesystem scan (vuln, secret, misconfig) run on every push
and pull request.

Private disclosure: do not publish exploit details in a public issue
before maintainers have had a reasonable opportunity to investigate and
coordinate a fix. Remove sensitive data from logs and send a minimal
report through the repository's private security reporting channel at
https://github.com/wenathlan/saddle/security/advisories/new. Revoke any
credential that may have appeared in a local file or public commit
before reporting. Security advisories and published fixes are tracked
at https://github.com/wenathlan/saddle/security/advisories.

Security testing must be authorized by the owner of the target system.
Development and CI scanning of artifacts is allowed within the
project's own build and test environments. Unauthorized penetration
testing, fuzzing, active scanning or credential probing of third-party
systems is not allowed.

## Supply chain

- Security advisories for the npm package line are published at
  https://github.com/wenathlan/saddle/security/advisories.
- The version tag is the supply-chain contract for every GitHub Actions
  reference (the family standard: digests and checksums are computed on
  the GitHub runners at run time — release `SHA256SUMS` assets,
  GitHub-computed release-asset digests consumed as build args — never
  written into workflow files or the Dockerfile).
- The project records accepted risks, dependency advisories and
  remediation status in the security documentation and workflow
  reports.
