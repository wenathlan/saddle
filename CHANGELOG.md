# saddle release notes

## 2.0.0 — the grand merge: e2ugh joins saddle (the merged release, one product, one metadata)

### Changed

| Area | Change |
| --- | --- |
| The grand merge | The e2ugh repository (private, v1.2.20 — the one container file era) merges into saddle as the virtual-hardware engine of the storage/compute engine. Every file, feature and document of e2ugh lands in this repository and is readapted to the saddle product: the fifteen root engine modules and the index core merge into the barrel, the hardware catalogs and config envelopes ship as specs/* exports, the native sources (virtualhardware.c, gpumonitor.cpp, virtualizationcore.cpp) and the python bridge (qemubridge.py) sit at the repository root, and the full documentation set joins docs/ (the e2ugh engine reference and nine engineering documents). The public barrel and the engine root stay free of npm dependencies; the legacy WebScrape toolkit generation consolidates into webscrape.ts with lazy optional runtimes. |
| The flat consolidation | Twenty-two nested logic folders fold into seventeen root-level domain files (the e2ugh family standard: one optimized TypeScript file per correlated domain, ordinal sections, JSDoc on every block, intra-domain imports dissolved, cross-domain imports rewritten). The package.json exports/bin remap to the flat dist surface. |
| The one container file | The merged Dockerfile carries both container surfaces of the one repository: the five vhe stages of e2ugh (builder, python-bridge, qemu, qemu-runtime, runtime — published through the publish ghcr vhe workflow across three profiles and four architectures) and the saddle node-engine stages (saddle-build, saddle-runtime — the publish ghcr and compose pipelines build `--target saddle-runtime`). The GHCR tag families split cleanly: the node engine publishes `saddle:<version>`, the vhe engine publishes `saddle:<version>-vhe`, `-vhe-balanced` and `-vhe-lite` (no collision, one package, one product); the mesa-cache-26.2.1 release mirrors the e2ugh tarball cache so the build-time digest resolution works in this repository (same tarball, same GitHub-computed sha256, the value never enters the sources). |
| The interface tree | The multiplatform interface consolidates inside web/ with every console file at the web root (the merged e2ugh console readapted): the self-hosted node api (server.js), the browser-pure engine dispatcher (sandbox.js), the sqlite store (db.js + init.sql + schema.prisma + drizzle.config.ts), the auth surface (auth.js + localauth.js), the mesh communication (mesh.js), the console page (console.html + console.js), the account pages (login/register/dashboard) and the static-edge deploy manifests (caddyfile, netlify.toml, vercel.json, mime.types, package.json). The React app, the capacitor shells (web/android, web/ios), the tauri shell (web/desktop) and the browser-extension assets (web/extension) share the same root; the self-hosted api serves the console page at `/` and the static pages beside it. All logic files stay at the repository root. |
| Registry envelopes (the single metadata) | Every registry carrier of the merged repository becomes saddle metadata (the one-product rule): the Maven carrier is one artifact (io.wenathlan:saddle — the former library envelope and the former io.github.wenathlan:e2ugh Java adapter merge into one pom that compiles Saddle.java); the NuGet envelope is one saddle.csproj carrying the C# process adapter (SaddleCli.cs, the former E2ughCli.cs); the Ruby envelope is one saddle.gemspec shipping the new SaddleCli.rb runner (completing the former e2ugh carrier, whose runner path never existed) with the real repository files in its list; the Java adapter class itself is Saddle.java (the former E2ugh.java, io.wenathlan.saddle). The maven publish pipeline deploys the single merged artifact. The e2ugh MIT lineage is acknowledged in third-party-notices.md. |
| The single binary | The package bin is one entry — `saddle` -> `dist/cli.js` (the former `e2ugh` bin and its CLI entry absorb into the saddle CLI): the `plan` command carries the absorbed architect CLI (the machine-plan renderer with the MTTG multiplex header, the vm.config.toml regex overrides, the qemu/docker/toml formats and the planlint notes). The start scripts readapt (`start` and `start:engine` run the plan renderer; the `web` script serves the self-hosted console at web/server.js). |
| Workflows (one workflow file per responsibility) | The .github/actions composite folder no longer exists: the release-version resolver and the package validator steps inline into every workflow that used them (release, container, mobile, desktop, targets, buildextension, publishghcr, publishnpmjs, publishgithubnpm, publishmaven, publishnuget, publishrubygems — eleven workflows, each self-contained). The workflow lint gains a push trigger (every direct push that touches workflows gets linted) and rides version-tag action pins (the SHA pins retire — the family supply-chain contract). Cache-mirror releases (the mesa-cache pattern) skip the release-triggered jobs gracefully instead of failing the version resolver. The publish ghcr vhe workflow repairs the truncated ios export command of the mobile pipeline, the pre-merge branch-filter corruptions and the profile matrix. The dependabot configuration covers all eight ecosystems of the merged repository. The alternate-forge pipeline folders (.forgejo, .gitea, .gitlab, .woodpecker) retire: their deploy knowledge lives in web/DEPLOYMENT.md and their pipeline responsibilities are covered by the GitHub workflow set (one CI authority). |
| Security (zero alerts, all workflows green) | All 35 open code-scanning alerts close: the polynomial-redos family (19 acquisition regexes hardened with disjoint character classes, the readabletext selector loop rewritten as linear indexOf extraction, the chunkmarkdown heading regex), the double-escaping family (one single-pass entity decoder replaces the four duplicated decoders — acquisition decode/clean, virtual decodexml, webscrape plainText), the bad-tag-filter and incomplete-sanitization family (one linear stripblocks helper — case-insensitive, whitespace-tolerant, unterminated-safe — replaces every script/style strip regex), the stack-trace exposure (communication.ts forwards only repo-coded error messages; raw diagnostics log server-side), the test sanitization flags, the uka-tests permissions block, and the Dockerfile DS-0013 (the pack-destination rewrite removes both cd instructions). The security workflow's cargo audit job audits web/desktop (the grand-merge path). |
| Version metadata | Full envelope lockstep at 2.0.0 across every carrier: package.json (single bin), the config envelopes, the Dockerfile OCI labels, the web manifests, the merged maven/nuget/rubygems/java/c#/ruby carriers and the readme pins. |
| Build artifacts stay out of the repository | The __pycache__ directory (the python bytecode cache of the bridge) leaves version control — GitHub runners generate every build artifact, test result and cache (the build computers are GitHub's, not the repository's). The .dockerignore scopes the console surface explicitly (the React tree stays out of the vhe image context). |

## 1.8.19 — twenty correlated domains behind a transport-neutral public router

### Changed

| Area | Change |
| --- | --- |
| engine | Reorganized the TypeScript-first library into twenty correlated domains behind a transport-neutral public router. |
| package | Consolidated foundation nouns, runtime execution state, API protocols and webhooks, MCP adapters, automation contracts, delivery planning and mode profiles while preserving package subpaths. |
| package | Added an architecture organization record and rendered dependency-flow diagram, with compatibility rules for package exports, native metadata and workflows. |
| web | Verified 140 active tests, 69 legacy tests, web type checking and build, flat-native validation, formatting, npm packaging and a production dependency audit with no reported vulnerabilities. |
| package | Aligned active npm, lockfile, Maven, NuGet, RubyGems, desktop, Capacitor, iOS, extension and crawler metadata to `1.8.19`, with iOS build number `1008019`. |
| docs | Added the canonical [1.8.19 release notes](docs/releasenotes-1.8.19.md). |

## 1.8.18 — internal API contracts with explicit default denial and the isolation export

### Changed

| Area | Change |
| --- | --- |
| engine | Added serializable `executionrequest`, `executiondecision`, `executionhandoff`, `internalenvelope`, and `internalapi` contracts for privileged-effect planning without implicit runtime effects. |
| browser | Added explicit default denial for binary execution, host bridging, remote dispatch, provider access, local storage, browser sessions, databases and network effects until policy, approval and caller-owned adapter declarations agree. |
| package | Added the `@wenathlan/saddle/isolation` package export and deterministic tests that cover missing adapters, local targets, provider targets, browser targets and ignored undeclared URLs. |
| web | Added the unified `web/` playground route that visualizes typed internal API boundaries and the difference between a denied request and a non-executing caller handoff. |
| package | Aligned active package, registry, native, extension, crawler, Capacitor and iOS metadata to `1.8.18`, with iOS build number `1008018`. |
| docs | Added the canonical [1.8.18 release notes](docs/releasenotes-1.8.18.md). |

## 1.8.17 — the three-architecture GHCR OCI manifest with QEMU Buildx

### Changed

| Area | Change |
| --- | --- |
| workflows | Expanded the GHCR Linux OCI manifest target to `linux/amd64`, `linux/arm64`, and `linux/ppc64le` with QEMU-enabled Buildx publication. |
| workflows | Retained a loadable `linux/amd64` image for the container vulnerability scan, OCI version-label verification, and CLI smoke test. |
| workflows | Added a post-push manifest-index assertion that verifies the published Linux architectures before reporting container availability. |
| workflows | Documented the deferred Windows container boundary and rejected non-runnable `unknown` descriptors. |
| package | Aligned active package, native, extension, crawler, iOS build, and Capacitor metadata to `1.8.17`. |
| docs | Added the canonical [1.8.17 release notes](docs/releasenotes-1.8.17.md). |

## 1.8.16 — release evidence and readiness contracts

### Changed

| Area | Change |
| --- | --- |
| engine | Added `releaseevidence`, `evaluateevidence`, and `releasereadiness` as data-only release evidence and readiness contracts with explicit statuses, policy reason codes, and no external release effects. |
| legal | Added `evidencefromverification` to map an already-valid local checksum result into `checked` evidence without upgrading declared signing state into a trust claim. |
| engine | Exported the feature from the root entry and `@wenathlan/saddle/release-evidence`, with documented consumer boundaries. |
| package | Expanded deterministic release coverage to 136 active tests while preserving the 69 legacy tests and passing package, web, audit, and flat-native gates. |
| package | Aligned active package, native, extension, crawler and iOS build metadata to `1.8.16`. |
| docs | Added the canonical [1.8.16 release notes](docs/releasenotes-1.8.16.md). |

## 1.8.15 — verified storage pools, working-set admission and delivery manifests

### Changed

| Area | Change |
| --- | --- |
| engine | Added verified storage pools with quorum writes, explicit write modes, bounded operations, range reads, repair plans and restoration plans. |
| engine | Added bounded working-set admission, capability-gated bridge plans, materialization ledgers and caller-owned cleanup plans. |
| engine | Added WASM and binary transformation contracts, isolated execution adapters, archive inspection limits and sensitive-cache eligibility controls. |
| engine | Added declarative provider selection, capability evidence, cancellation and dispatch rendering, immutable delivery manifests, PWA/CDN plans, and Mini App/DNS surface requirements. |
| package | Aligned all active package, native, extension, crawler and iOS build metadata to `1.8.15`. |
| docs | Added the canonical [1.8.15 release notes](docs/releasenotes-1.8.15.md). |

## 1.8.14 — container-first ordering and GHCR build-stage validation

### Changed

| Area | Change |
| --- | --- |
| package | Bumped active npm, lockfile, Maven, NuGet, RubyGems, desktop, mobile, extension and crawler metadata to `1.8.14`. |
| package | Restored container-first package ordering in the canonical documentation and release matrix. |
| workflows | Added OCI version labels, build-stage engine compilation and post-push pull/label/CLI smoke validation for GHCR images. |
| docs | Added the canonical [1.8.14 release notes](docs/releasenotes-1.8.14.md) while preserving the historical 1.8.13 record. |

## 1.8.13 — queue leases, structured extraction and artifact retention

### Changed

| Area | Change |
| --- | --- |
| engine | Added caller-owned persistent queue leases, visibility timeouts, renewals, attempt accounting and idempotency keys. |
| engine | Added schema-neutral structured extraction with field provenance, bounded UTF-8 payloads and injected parsers. |
| browser | Added allowlisted browser snapshot projection with stable references and deterministic context byte budgets. |
| workflows | Added resumable workflow cancellation reasons and caller-owned idempotent compensation callbacks. |
| tests | Added deterministic artifact retention policies and keep/prune decisions without implicit deletion. |
| docs | Expanded the 1.8.21 comparative research matrix to 60 public repositories and documented the selected implementation boundaries. |
| package | Aligned active package, native, extension and crawler metadata to `1.8.13`. |
| docs | Added the canonical [1.8.13 release notes](docs/releasenotes-1.8.13.md) while preserving the historical 1.8.12 record. |

## 1.8.12 — the GPL-3.0-only license standardization and the release artifact matrix

### Changed

| Area | Change |
| --- | --- |
| legal | Added the canonical [1.8.12 release notes](docs/releasenotes-1.8.12.md) with the artifact matrix and explicit signing-state policy. |
| legal | Standardized the project license and root legal documents on GPL-3.0-only, preserving one canonical `LICENSE` file and removing byte-identical Markdown/Text duplicates. |
| tests | Added the public SignPath Foundation code-signing policy, GitHub Actions integration path and explicit unsigned, caller-owned, test-key and notarized status vocabulary. |
| desktop | Expanded the desktop matrix to Linux x64/arm64, Windows x86/x64/arm64 and macOS x64/arm64, with dotted lowercase artifact names and per-runner manifests and checksums. |
| workflows | Prepared Android APK/AAB and iOS IPA/app archive metadata, container and browser-extension release assets, with signing claims controlled by the actual CI state. |
| extension | Preserved the Saddle brand icon across native and extension surfaces and retained security scanning, SBOM and provenance gates. |

## 1.8.11 — flat native surfaces for Tauri and Capacitor

### Changed

| Area | Change |
| --- | --- |
| desktop | Flattened the project-owned Tauri desktop surface into `desktop/` with root Cargo, Rust entrypoints, icons and configuration |
| mobile | Flattened the project-owned Capacitor Android surface into root `android/` source sets with explicit Gradle mappings and generated staging cleanup |
| mobile | Preserved Capacitor and Xcode generator-owned internals while rejecting project-owned `src` paths in native surfaces |
| workflows | Added flat native validation, Android staging flattening and workflow path corrections for desktop, Android and iOS |
| package | Bumped active package, registry, extension, crawler and native metadata to `1.8.11` |

## 1.8.10 — mobile conversion surfaces with optimized Android builds

### Changed

| Area | Change |
| --- | --- |
| package | Normalized active package, desktop, extension, registry and crawler identity to `1.8.10` |
| desktop | Added mobile conversion research for Capacitor, Ionic and Tauri with an explicit library-first decision |
| web | Added explicit Capacitor Android and iOS surfaces that reuse the shared web output and library contracts |
| mobile | Enabled Android R8, resource shrinking and optimized resource shrinking; the generated APK is 3,498,594 bytes and the AAB is 3,893,352 bytes |
| package | Normalized public artifacts to lowercase dotted names and rejected helper binaries, underscore-based names and generic metadata |
| workflows | Published the verified desktop, Android, container and extension assets with surface-specific manifests and SHA-256 files |

## 1.8.9 — the TypeScript migration and native artifacts

### Changed

| Area | Change |
| --- | --- |
| tests | Converted the active engine and deterministic tests from JavaScript to a root-based TypeScript source layout |
| engine | Added dist-only compilation with declarations, source maps and generated output excluded from version control |
| extension | Added TypeScript-first extension source resolution and retained the stable JavaScript Manifest V3 artifact format |
| workflows | Added declarative application, computer, desktop, Android, iOS, CLI, binary, browser, web, LibreOffice, VSIX and container target plans |
| workflows | Added tag-driven target-plan workflow without hardcoded credentials or platform-specific source code |
| tests | Preserved the legacy typed scrape feature surface and verified 98 active tests plus 69 legacy Vitest tests |
| web | Moved the development debug collector into the TypeScript web graph and repaired web compiler blockers |

## 1.8.8 — the consolidation of crawl, retry and error contracts

### Changed

| Area | Change |
| --- | --- |
| scrape | Consolidated URL normalization, crawl traversal, frontier budgets and persistent crawl state into `scrape/crawl.js` |
| engine | Consolidated retry policy and circuit protection into `runtime/retry.js` |
| scrape | Merged scraper-specific error taxonomy into the core error context and removed redundant top-level folders |
| tests | Preserved the public export names and deterministic behavior while reducing active source files and folder boundaries |
| package | Updated package, extension, Maven, NuGet, RubyGems, README and release metadata to `1.8.8` |

## 1.8.7 — the removal of obsolete manifests and the security gate additions

### Changed

| Area | Change |
| --- | --- |
| package | Removed the obsolete nested `scrape` package manifests and lockfile while preserving the engine's dependency-free JavaScript scrape contracts |
| web | Removed the public `__manus__` directory and moved the development collector to `web/public/debugcollector.js` with a private `/debuglogs` endpoint |
| workflows | Added base-aware asset URL resolution and normalized GitHub Pages subpath builds |
| tests | Removed the unused JSX locator plugin and upgraded Vitest to the security-fixed 4.1.10 line |
| workflows | Added npm audit and dependency review gates to the primary CI workflow |
| package | Consolidated canonical package identity, security boundaries, architecture and release documentation |

## 1.8.6 — extension persistence, snapshot diffs and provenance assets

### Changed

| Area | Change |
| --- | --- |
| extension | Added durable pending extension commands with explicit rehydration and resume |
| browser | Added optional Playwright peer metadata and a Node-only `browser-playwright` adapter |
| tests | Added a read-only page-world bridge with token-correlated `pagefacts` responses and deterministic timeout handling |
| extension | Added extension snapshot diffs plus persisted window, tab and frame context for explicit resume |
| tests | Added deterministic SHA256SUMS, CycloneDX SBOM and in-toto-shaped provenance asset generation |
| workflows | Flattened the web application into a root-based layout and corrected GitHub Pages, CI and Dependabot paths |
| workflows | Fixed the GHCR production image build for the root manifest's dev-only peer dependency graph |

## 1.8.5 — Node 26 package metadata

### Changed

| Area | Change |
| --- | --- |
| package | Added Node.js 26.7.0 and npm 12 package metadata |
| browser | Added an optional Playwright peer and explicit Node-only browser adapter |
| engine | Preserved the transport-neutral root without adding runtime dependencies |

## 1.8.4 — the cross-forge Node 26 toolchain

### Changed

| Area | Change |
| --- | --- |
| workflows | Updated all active library and forge pipelines from Node 22 to Node.js 26.7.0 |
| workflows | Added complete deterministic gates to GitLab, Forgejo, Gitea and Woodpecker validation workflows |
| workflows | Documented caller-owned Pages and cross-forge deployment boundaries |

## 1.8.2 — the Manifest V3 permission policy and release assets

### Changed

| Area | Change |
| --- | --- |
| engine | Added a minimal Manifest V3 permission policy with caller-owned optional escalation |
| extension | Added a Node-only extension builder that versions the unpacked manifest from release metadata |
| package | Added a release workflow that packages and attaches `saddle-extension-<version>.zip` |
| engine | Added context-aware replay for caller-owned window, tab and frame restoration |
| package | Added a transport-neutral export graph audit for browser-like package loading |
| scrape | Added bounded content-type detection and normalization for structured and binary scrape results |
| package | Migrated active repository, Maven and GitHub Packages owner metadata to `wenathlan` |
| workflows | Prepared all release workflows to derive owner namespaces from the transferred repository |

## 1.8.1 — the wenathlan package identity

### Changed

| Area | Change |
| --- | --- |
| package | Changed the canonical public npm package identity to `@wenathlan/saddle` |
| package | Preserved the v1.8.1 GitHub Packages npm artifact namespace as `@iakadion/saddle` for historical accuracy |
| package | Added follow-up release metadata after the immutable v1.8.0 package identity |
| package | Kept package version resolution derived from the release tag |

## 1.8.0 — the Node 26 toolchain and cross-runtime probe

### Changed

| Area | Change |
| --- | --- |
| workflows | Updated GitHub Actions, Docker bases and CI toolchains to Node.js 26.7.0 and current stable action majors |
| package | Added a transport-neutral browser worker bridge and package export import tests |
| package | Added a Node 26.7.0 cross-runtime probe lane for Node, Bun and Deno |
| package | Kept package publication versions derived from release tags without manual version inputs |

## 1.7.0 — app installation, scope authorization and webhooks

### Changed

| Area | Change |
| --- | --- |
| engine | Added app installation, suspension, revocation and scope authorization |
| engine | Added command scope guards and idempotent bot command results |
| web | Added webhook delivery attempts, retryable failures and dead letters |
| workflows | Verified GitHub npm, GHCR, Maven, NuGet and RubyGems publication workflows for 1.7.0 |
| registry | Documented the public npmjs Trusted Publisher bootstrap requirement |

## 1.6.0 — API envelopes and secure response boundaries

### Changed

| Area | Change |
| --- | --- |
| engine | Added request identity, success and error API envelopes |
| engine | Added caller-owned optional authorization verification |
| engine | Added secure response headers and bounded redirect checks |
| engine | Added injected DNS resolution checks for private targets |
| browser | Added optional browser snapshot and action MCP tools |

## 1.5.0 — semantic extraction and crawl frontiers

### Changed

| Area | Change |
| --- | --- |
| engine | Added semantic page extraction for headings, landmarks, controls and links |
| scrape | Added priority crawl frontiers and per-domain page budgets |
| engine | Added retrieval provenance and provenance merging for RAG context |
| engine | Added bounded in-memory counters and duration metrics |

## 1.4.0 — provider health and legal remote runs

### Changed

| Area | Change |
| --- | --- |
| engine | Added provider health and capacity reports |
| engine | Added cooperative heartbeat signals for long-running work |
| workflows | Added forge-neutral manual, webhook, schedule, retry and heartbeat triggers |
| legal | Added legal remote run transitions with resumable submit, status and cancel operations |

## 1.3.0 — content-addressed storage and tiered caches

### Changed

| Area | Change |
| --- | --- |
| engine | Added bounded range reads to chunked storage |
| engine | Added content-addressed immutable object storage and logical references |
| engine | Added tiered hot and cold cache with stale-while-revalidate loading |
| engine | Added manifest comparison, conflict policy and multi-backend sync |
| engine | Added memory engine backend capabilities and sync methods |

## 1.2.0 — page snapshots and browser action batches

### Changed

| Area | Change |
| --- | --- |
| browser | Added vendor-neutral page snapshots with bounded elements and stable references |
| browser | Added stale snapshot errors and snapshot diffs |
| registry | Added tab, frame and active context registry |
| browser | Added bounded browser action batches and structured outcomes |
| browser | Added snapshot-aware action recording for replay provenance |

## 1.1.0 — the Manifest V3 browser bridge

### Changed

| Area | Change |
| --- | --- |
| browser | Added a Manifest V3 browser bridge under `extension/` |
| extension | Added versioned extension messages, page snapshots and stale reference checks |
| engine | Added service worker routing with session state persistence |
| browser | Added a narrow popup for user initiated snapshots and page reads |
| browser | Added deterministic extension tests without browser credentials or network access |
| package | Added the `@wenathlan/saddle/extension` package export |

## 1.0.0 — initial release

### Changed

| Area | Change |
| --- | --- |
| engine | Initial release of saddle |
| package | Initial engine contracts and package release |
| legal | GNU General Public License v3.0 |

---

## The e2ugh lineage (the merged repository history, preserved)

The sections below are the verbatim release history of e2ugh (the private
virtual-hardware engine repository that merged into saddle at 2.0.0) —
kept in the family format so nothing of the merged product's past is lost.

## 1.2.20 — The one container file: docker-compose.yml and entrypoint.sh merged into the Dockerfile

### Changed

| Area | Change |
| --- | --- |
| Dockerfile (the one container file) | The gateway 1.1.5 standard lands: `docker-compose.yml` and `entrypoint.sh` are deleted and every setting they carried is merged INTO the Dockerfile — the single container file the repository keeps (Containerfile is the same format under the OCI name; Dockerfile is the universally compatible spelling). The former `COPY entrypoint.sh` becomes an embedded heredoc `COPY <<'ENTRYPOINT_SCRIPT_EOF' /entrypoint.sh` — the script content is the exact former entrypoint.sh (270 lines: the Xvfb :99 bootstrap, the spoofing-core checks, the glxinfo/vulkaninfo/clinfo validation heads, the random 30000-60000 port draw and the exec of the engine command), the quoted delimiter keeps every shell expansion literal and the file lands executable through the same `chmod 0755` RUN. The ENV block gains the former compose vhe service settings (`E2UGH_DB=/data/web/e2ugh.db`, which `web/db.js` already consumes, and `NODE_ENV=production`); the useradd RUN creates and chowns `/data/vmdata` and `/data/web` (the former named volume targets); `EXPOSE 8080` documents the engine service port (the former `VHE_ENGINE_PORT` default — a bare `docker run` without `-e PORT` keeps the embedded entrypoint drawing its random port, so nothing hardcodes a bind); `VOLUME /data /cache/mesa_shader_cache` declares the state surface; and the header documents the hardened `docker run` recipes of every former compose service (vhe, vheqemu, vhegpu, qemubridge plus the prometheus scraper note for the observability profile) — init reaps zombies, cap-drop ALL + no-new-privileges, unlimited swap, 2g shm, 15s stop grace, 50m x 5 json-file logs, restart unless-stopped, the tmpfs scratch and the named volumes, one recipe per service with the same host port defaults (31280:8080, 31281). |
| tests/workflow.test.ts | The compose structural contract (gate 8) becomes the one container file contract: `docker-compose.yml` and `entrypoint.sh` must not exist, the heredoc COPY and `ENTRYPOINT ["/entrypoint.sh"]` must be present, the docker run recipes must carry `--memory-swap -1` and `--shm-size 2g` (the contract the compose anchor gate used to verify), the vhe/vheqemu/vhegpu/qemubridge recipes must be documented, the `E2UGH_DB` ENV, the 8080 EXPOSE, the state VOLUME and the non-root USER must be baked in, and the HEALTHCHECK expression must stay free of the `=` character (the dockle CIS-DI-0010 lesson of the family). The gate 4 root allowlist drops the deleted compose filename; the `parsecomposesubset` yaml loader goes with it. |
| security.yml | The dockle accept-key list gains `E2UGH_DB` and `NODE_ENV` — the merged compose service settings the one container file bakes as ENV (a database path and a runtime mode, never secrets). |
| package.json | The `docker:compose` script is removed with the file it drove; `docker:build`/`docker:run`/`docker:health` follow the 1.2.20 tag; the files allowlist drops `docker-compose.yml` and `entrypoint.sh` (the npm package ships the one container file only). |
| readme.md / SECURITY.md / .dockerignore | The quick-start section describes the docker run recipes of the one container file; the file table row 5 absorbs the entrypoint and compose rows (the table renumbers); the validated-surface table and the toolchain links drop the Docker Compose entries; SECURITY.md points at the embedded entrypoint; the .dockerignore drops the compose exclusion line and documents that the bootstrap is embedded (no script file enters the build context). |
| Version metadata | Full envelope lockstep to 1.2.20 (package.json, lockfile root entries, web manifests and pins, Dockerfile OCI label, the ten `.json` config envelopes, the four `.config` envelopes and the Maven/NuGet/RubyGems specs, plus the readme and test pins). |

## 1.2.19 — Dockle accept-key for the apt upgrade option; the container Trivy SARIF chain is restored

### Fixed

| Area | Change |
| --- | --- |
| security.yml container-scan | The 1.2.18 base-image upgrade step (`apt-get -o APT::Get::Always-Include-Phased-Updates=true upgrade -y`) tripped the Dockle CIS-DI-0010 heuristic: the scanner masked the option value and reported `APT::Get::Always-Include-Phased-Updates` as a suspicious credential ENV key on the RUN instruction — a FATAL that failed the Dockle step of the container-scan job. With that step failed, the subsequent Trivy SARIF scan, the SARIF upload to code scanning and the critical-vulnerability gate were all skipped, so the 62 base-package advisories the 1.2.18 upgrade actually resolves stayed open (the closing SARIF never uploaded). The accept-key list gains `APT::Get::Always-Include-Phased-Updates` — a plain apt option, not a credential — restoring the full Dockle-then-Trivy-then-gate chain so the upgraded image's clean scan reaches code scanning and the advisories close. |
| Version metadata | Full envelope lockstep to 1.2.19 (package.json, lockfile root entries, web manifests, Dockerfile OCI label, docker-compose image tags, the ten `.json` config envelopes, the four `.config` envelopes and the Maven/NuGet/RubyGems specs, plus the readme and test pins). |

## 1.2.18 — Base-image CVE closure: apt upgrade of the runtime system packages

### Changed

| Area | Change |
| --- | --- |
| Dockerfile runtime stage | The runtime apt retry loop gains an upgrade step: after the install list succeeds, `apt-get -o APT::Get::Always-Include-Phased-Updates=true upgrade -y` pulls every installed base package (perl-base, util-linux, ncurses, coreutils, libtinfo, bsdutils and friends) to the latest security update resolved by the fresh `apt-get update` index. `apt-get install` alone only guarantees the listed packages — the ubuntu:24.04 base layer arrives with whatever system packages its digest carried, and a BuildKit registry-cache hit can replay an even older layer chain, so the base system packages can lag behind the published security fixes right after a fresh build (exactly what the 1.2.17 Security run surfaced: the Trivy SARIF of the container-scan job reported 30 HIGH advisories against base packages that all carried fixed versions in the archive). The upgrade never installs new packages and never removes any (same-version upgrades only), stays inside the 5-try mirror-race retry loop, and the phased-updates override keeps CI builds deterministic (Ubuntu's gradual phasing is skipped). The publishghcr release-image gate had scanned clean because its build had pulled a fresh base digest, while the security-scan image had replayed cached layers — the upgrade makes both paths converge deterministically. |
| publishghcr concurrency | The workflow concurrency group becomes event-scoped — `publish-ghcr-${{ github.event_name }}-${{ github.ref }}` — the gateway standard. The previous ref-only group landed the workflow_run publication run (fired ~90s after every release push, by the release completion) in the SAME lane as the push validation run started by the version-bump commit, and with cancel-in-progress it killed the in-flight validation legs on every release push — the 1.2.16 and 1.2.17 pushes both left a cancelled (red X) publish-ghcr run in the actions tab for this. Event-scoped groups keep every dedupe guarantee the ref-only group carried (duplicate workflow_run firings for the same release completion still cancel each other instead of racing the GHCR publish — the v1.2.13 lesson; superseded push validations still cancel each other on rapid double-pushes) while the push validation and the release publication for the same commit now run side by side and both finish green. Publication runs (release, workflow_dispatch) are never cancelled mid-flight — a latecomer queues behind them. |
| publishghcr job ceilings | The publish job timeout rises 180 → 330 minutes and the validate job timeout 90 → 240 minutes. The four-arch publish legs build three architectures under QEMU with mesa compiled from source: the cold-cache 1.2.17 publish legs ran past the old 180-minute ceiling and were killed by the timeout (a timed-out job reports conclusion `cancelled` — exactly what the 1.2.17 publish run shows, legs ended 180m12s after start). The ed32fbf-era push validation run hit the old 90-minute ceiling the same way (~1h35m in). 330/240 stay under the 6-hour hosted-runner job cap with headroom for mirror races; warm-cache legs complete in ~10-25 min per profile, so the ceilings only matter on cold-cache rebuilds after Dockerfile/lockfile churn. |
| Version metadata | Full envelope lockstep to 1.2.18 (package.json, lockfile root entries, web manifests, Dockerfile OCI label, docker-compose image tags, the ten `.json` config envelopes, the four `.config` envelopes and the Maven/NuGet/RubyGems specs, plus the readme and test pins). |

## 1.2.17 — Complete envelope lockstep: the four .config envelopes rejoin the version bump

### Changed

| Area | Change |
| --- | --- |
| Version envelope lockstep (completion) | The 1.2.16 release attempt failed the pre-tag gate of `release.yml`: the `docker.config`, `mttg.config`, `passage.config` and `qemu.config` envelopes were left at 1.2.15 by the 1.2.16 bump (a plain-tag glob missed the `.config` extension). The release job aborted before any artifact existed - the tag was never released, the npm/Maven/NuGet/RubyGems/GitHub-npm publish legs no-op'd through their existence checks and the GHCR resolve job skipped publishing - so no registry ever carried a 1.2.16 artifact. This release completes the lockstep across every envelope (the version-tag glob of the release gate now covered: `.json` and `.config` carriers alike) and ships the whole 1.2.16 change set. |
| Version metadata | Full envelope lockstep to 1.2.17 (package.json, lockfile root entries, web manifests, Dockerfile OCI label, docker-compose image tags, the ten `.json` config envelopes, the four `.config` envelopes and the Maven/NuGet/RubyGems specs, plus the readme and test pins). |

### Fixed

| Area | Fix |
| --- | --- |
| Security workflow (push) of 1.2.15 | (shipped from the 1.2.16 change set, on main since fc24fe4) The push-triggered Security run of 1.2.15 failed: the OSV scanner and the Trivy filesystem jobs both flagged `qs@6.15.3` for GHSA-4mjr-xmp4-gh2g (CVE-2026-82417) and GHSA-x5fp-wj9c-mxmx (CVE-2026-82562). The lockfile update to `qs` 6.16.0 (the dependabot npm_and_yarn proposal of PR #13, incorporated into main directly, per the latest-versions policy) removes the vulnerable version - only the lockfile moves, the root `package.json` manifests stay untouched, `qs` being an optional transitive dependency of `express` 5.2.1 through `body-parser` 2.3.0. Dependabot auto-closed PR #13 after detecting the incorporation. |
| Dockle CIS-DI-0010 false positive | (shipped from the 1.2.16 change set) The `total` shell variable of the meminfo baking `RUN` script (the awk total of `/etc/virtual/meminfo`) joins the `accept-key` whitelist of the dockle step in `security.yml`: the value is the plain KiB arithmetic of the profile memory plan, but the Actions runner masks it in the build log, and the heuristic flags a variable name appearing next to a masked value as a suspicious ENV key - the same false-positive class already whitelisted for `apt_update_tries` in 1.2.14. |
| Stale toolchain comments | (shipped from the 1.2.16 change set) Four comment blocks of `security.yml` still described the trivy-action references as "pinned by commit sha / immutable commit pin" - residue of the pre-1.2.13 pinning era, factually wrong since the actions are version-tag refs. They are rewritten to the actual maintainer policy: the version tag is the supply-chain contract; digests and checksums are computed in runtime by the GitHub runners, never hardcoded in workflow files. |

## 1.2.16 — qs security update, Dockle accept-key extension, stale toolchain comments (release attempt aborted at the gate; the change set ships in 1.2.17)

### Changed

| Area | Change |
| --- | --- |
| Dependency security update | `qs` is bumped 6.15.3 → 6.16.0 in the lockfile (the dependabot npm_and_yarn proposal of PR #13 incorporated into main directly, per the latest-versions policy). This closes the two medium advisories filed against the 1.2.15 chain: GHSA-4mjr-xmp4-gh2g (CVE-2026-82417) and GHSA-x5fp-wj9c-mxmx (CVE-2026-82562). `qs` is an optional transitive dependency of `express` 5.2.1 through `body-parser` 2.3.0, so only the lockfile moves — the root `package.json` manifests stay untouched, and the whole transitive closure of the runtime tree is otherwise unchanged. |
| Dockle accept-key extension | The `total` shell variable of the meminfo baking `RUN` script (the awk total of `/etc/virtual/meminfo`) joins the `accept-key` whitelist of the dockle step in `security.yml`. The value is the plain KiB arithmetic of the profile memory plan, but the Actions runner masks it in the build log, and the CIS-DI-0010 heuristic flags a variable name appearing next to a masked value as a suspicious ENV key — the same false-positive class already whitelisted for `apt_update_tries` in 1.2.14. |
| Stale toolchain comments | Four comment blocks of `security.yml` still described the trivy-action references as "pinned by commit sha / immutable commit pin" — residue of the pre-1.2.13 pinning era, factually wrong since the actions are version-tag refs. They are rewritten to the actual maintainer policy: the version tag is the supply-chain contract; digests and checksums are computed in runtime by the GitHub runners, never hardcoded in workflow files. |
| Version metadata | Full envelope lockstep to 1.2.16 (package.json, lockfile root entries, web manifests, Dockerfile OCI label, docker-compose image tags, the ten config envelopes and the Maven/NuGet/RubyGems specs). The four `.config` envelopes (docker, mttg, passage, qemu) were missed by the bump and stayed at 1.2.15, so the release gate of `release.yml` aborted the tag before any artifact was built; the completed lockstep ships as 1.2.17. |

## 1.2.15 — Zero hardcoded hashes in the Dockerfile: GitHub-computed digests, tags-only base images

### Changed

| Area | Change |
| --- | --- |
| Dependency and action bumps | The five dependabot proposals are incorporated into main directly (per the latest-versions policy) so their branches can be archived: `actions/setup-java` 5.7.0 → 6.0.0 (publishmaven), `anchore/sbom-action` 0.24.0 → 0.24.2 and `trufflesecurity/trufflehog` 3.97.0 → 3.97.1 (security), `@biomejs/biome` 2.5.10 → 2.5.11 and `@types/node` 26.2.0 → 26.4.0 (dev dependencies, lock regenerated). The local gates re-verified after the bumps: TypeScript 0 errors, Biome 0 errors, 153/153 tests. |
| Dockerfile base images | The `@sha256:` digests pinned on `ARG UBUNTU` and `ARG PYTHON_BASE` are removed: base images are referenced by plain tag (`ubuntu:24.04`, `python:3.14.7-slim`), the same convention the gateway repository established. A single digest cannot serve the four-architecture matrix this image ships (the registry resolves the tag per platform), and a digest written in the file is a hardcoded hash. The Dockerfile now carries zero 64-hex constants. |
| Mesa tarball verification | `ARG MESA_SHA256` no longer carries a hardcoded default: the checksum of the mirrored upstream tarball is resolved at build time from the mesa-cache GitHub release — GitHub computes the sha256 digest of every release asset at upload time, and the publish/validate/scan workflows read that digest and hand it to the build as the `MESA_SHA256` build-arg (with an on-runner computation fallback for legacy assets). The `resolve` job of `publishghcr.yml` also keeps a `SHA256SUMS` asset published on the mesa-cache release so local builds verify too: the hash is generated on GitHub's computers and published as a release asset, never written into the sources. |
| Meson wheel install | The hardcoded sha256 verification of the meson 1.12.0 wheel is removed; the exact version-pinned wheel URL on files.pythonhosted.org is the artifact identity (the same class of contract `npm ci` uses through the lockfile). The maintainer supply-chain policy (version-tagged artifacts as the contract, Scorecard PinnedDependencies findings dismissed per policy) is documented at the install site. |
| Nodesource setup script | The hardcoded sha256 verification of the nodesource `setup_26.x` script is removed: the script tracks the whole 26.x line (a frozen hash false-negatives on every upstream refresh), the apt repository it configures carries its own release signing, and the exact node build stays pinned by the `nodejs=${NODE_VERSION}-1nodesource1` package. |
| Workflow hash doctrine | The remaining hash-bearing sites in the container pipeline now follow the gateway family policy end to end: hashes that exist are generated on the GitHub runners (release `SHA256SUMS` assets, the GitHub-computed release-asset digests consumed as build-args, the image digests emitted by the buildx push outputs) and published as release assets; no hash constant is written in any workflow or Dockerfile. The `container-scan` and `engine-validation` jobs of `security.yml` resolve the mesa digest too, keeping the BuildKit registry cache keys coherent across workflows. |
| Version metadata | The stale `org.opencontainers.image.version="1.2.13"` label of the Dockerfile (a lockstep violation left over from the 1.2.14 bump; overridden at build time by the publish labels, but stale in the source) is brought to 1.2.15 together with the full envelope lockstep. |

### Fixed

| Area | Fix |
| --- | --- |
| Local-build tarball verification | Local `docker build` runs previously required editing the hardcoded `MESA_SHA256` default whenever the mirrored tarball changed. The Dockerfile now verifies against the `SHA256SUMS` asset of the mesa-cache release when it is reachable (the digest GitHub computed for the asset), and prints a visible warning instead of failing when a fully offline build cannot fetch it — GitHub builds always verify through the build-arg resolved by the workflows. |

## 1.2.14 — Pre-deploy existence checks, unified publish-ghcr concurrency, Dockle whitelist fix

### Changed

| Area | Change |
| --- | --- |
| Pre-deploy existence check | `publishmaven`, `publishrubygems` and `publishghcr` now query the GitHub Packages / GHCR registry versions list before attempting to publish. If the resolved version is already present, the `resolve` job exits 0 with `proceed=false` so the duplicate `workflow_run` firing (the Release workflow completes once but the `workflow_run` trigger can fire multiple times for the same logical release) no-ops instead of failing the pipeline. This closes the recurring `publish maven` HTTP 409 Conflict and `publish rubygems` "Version X.Y.Z of e2ugh has already been pushed" failures observed on the 1.2.13 chain. `publishnpmjs`, `publishgithubnpm` and `publishnuget` already carried the equivalent `npm view` / `--skip-duplicate` guard, so they were left unchanged. |
| publishghcr concurrency group | The concurrency group is now `publish-ghcr-${{ github.ref }}` (the previous `${{ github.event_name }}-${{ github.ref }}` form kept duplicate `workflow_run` firings for the same ref in separate groups, so they ran in parallel and raced the GHCR publish). `cancel-in-progress` is now `true` for both `push` and `workflow_run` events so a newer firing cancels the older in-progress one. |
| Setup-node in resolve jobs | `publishmaven`, `publishrubygems` and `publishghcr` now call `actions/setup-node@v7.0.0` before any `node -p "JSON.parse(...).version"` bash in their `resolve` jobs so the version-resolution step is reproducible across runner images (previously relied on the runner-bundled Node). Mirrors the DevThink publish-ghcr convention. |
| Resolve job runner | `publishmaven`, `publishrubygems` and `publishghcr` `resolve` jobs are pinned to `ubuntu-24.04` (Saddle / DevThink convention for the low-ceremony resolve leg); the heavy validate / publish / verify / scan jobs keep `ubuntu-latest` for capacity. `cachecleanup` and `workflowlint` were already pinned to `ubuntu-24.04`. |
| Code Scanning alerts | All 101 open `PinnedDependenciesID` alerts from OpenSSF Scorecard ("third-party / GitHub-owned GitHubAction not pinned by hash") were dismissed with `dismissed_reason=won't fix` and the maintainer-policy comment `Maintainer policy (v1.2.14+): version-tag refs are the supply-chain contract for this project (per DevThink/Saddle). SHA-pinning explicitly rejected by maintainer. See publishghcr.yml header comment lines 29-33.` The remaining 168 alerts were already `fixed` (159) or pre-existing `dismissed` (9, minimum-grant TokenPermissionsID mitigations etc.). Final open count: 0. |

### Fixed

| Area | Fix |
| --- | --- |
| Dockle CIS-DI-0010 false positive | The 1.2.13 Dockerfile commits introduced new shell variables (`cpuname`, `cpufamily`, `cpumodel`, `cpustepping`, `modelname`, `addr`, `la57`, `vcpus`, `threads`, `ram_gb`, `FLAGS`, `total_kb`, `apt_update_tries`, `i`) inside the `RUN` scripts that bake `/etc/virtual/cpuinfo` and `/etc/virtual/meminfo`. Dockle's `CIS-DI-0010` heuristic flags any ENV-key-style token ending in `name`, or any variable name appearing next to a GitHub-Actions-masked value (`apt_update_tries=*******`), as a "Suspicious ENV key". The `accept-key` whitelist of the `goodwithtech/dockle-action@v0.4.15` step in `security.yml` is extended with every new variable so the security gate no longer fails on this false positive. |
| cachecleanup CodeQL workflow_run | The `workflow_run: Security[completed]` trigger is re-added to `cachecleanup.yml`, scoped via a new `WORKFLOW_RUN_SCOPED` env var so a CodeQL-completion firing only processes the `codeql-*` family caches. The buildkit / node / trivy families (which the heavy docker legs may still be reading) are skipped entirely on a `workflow_run` firing, so the "blob not found" race that originally removed this trigger cannot recur. The schedule and `workflow_dispatch` triggers continue to run the full retention policy. |

## 1.2.13 — No hardcoded SHAs: version-tagged actions, apt retry on every stage

### Changed

| Area | Change |
| --- | --- |
| Workflow actions | Every GitHub Actions `uses:` ref across all 13 workflows in `.github/workflows/` now points at a plain version tag (`actions/checkout@v7.0.1`, `docker/build-push-action@v7.3.0`, `docker/setup-qemu-action@v4.2.0`, `docker/setup-buildx-action@v4.3.0`, `docker/login-action@v4.6.0`, `aquasecurity/trivy-action@v0.36.0`, `actions/setup-node@v7.0.0`, `actions/cache@v6.1.0`, `actions/upload-artifact@v7.0.1`, `actions/download-artifact@v8.0.1`, `softprops/action-gh-release@v3.0.2`, `ruby/setup-ruby@v1.321.0`, `actions/setup-java@v5.7.0`, `actions/setup-dotnet@v6`, `actions/setup-python@v7.0.0`, `actions/configure-pages@v6.0.0`, `actions/upload-pages-artifact@v5.0.0`, `actions/deploy-pages@v5.0.0`, `reviewdog/action-actionlint@v1.73.2`, `github/codeql-action/*@v4`, `actions/dependency-review-action@v5.0.0`, `goodwithtech/dockle-action@v0.4.15`, `trufflesecurity/trufflehog@v3.97.0`, `ossf/scorecard-action@v2.4.4`, `google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.5.1`, `anchore/sbom-action@v0.24.0`). The 118 SHA-pinned `@<40-hex>` refs are gone: the version tag is the contract, the same convention the DevThink and Saddle publish-ghcr workflows already use. No more hardcoded hashes. |
| Toolchain header comments | The `# Toolchain (sha-pinned):` block at the top of `publishghcr.yml` and `release.yml` is rewritten as `# Toolchain (version-tagged, same convention as DevThink / Saddle): ... No SHA pinning - the version tag is the contract.` so the policy is documented at the file head. |

### Fixed

| Area | Fix |
| --- | --- |
| ppc64le apt mirror race | The 1.2.12 `publish ghcr` run died on the linux/ppc64le runtime leg with `E: Failed to fetch .../noble-updates/main/binary-ppc64el/Packages.gz  File has unexpected size (907702 != 907692). Mirror sync in progress?`. The builder stage already had a 5-try `apt-get update` retry loop with a 10-second backoff; the qemu, qemu-runtime and runtime stages did not. All three stages now carry the same retry loop, so a transient `ports.ubuntu.com` arm64/ppc64el/s390x mirror sync mid-flight no longer kills the build. |
| Workflow failures analyzed | All failed runs at https://github.com/wenathlan/e2ugh/actions were inspected: `publish maven` returned HTTP 409 Conflict (1.2.12 already exists in GitHub Packages Maven), `publish rubygems` reported `Version 1.2.12 of "e2ugh" has already been pushed`, and `publish ghcr` hit the ppc64le apt mirror race. The 1.2.13 bump ships a brand-new version to every registry and the apt retry closes the only transient failure. |

## 1.2.12 — One tag per version, three profiles across all four architectures

### Changed

| Area | Change |
| --- | --- |
| GHCR tags | Each published image carries exactly ONE tag: the version. `max -> :<version>`, `balanced -> :<version>-balanced`, `lite -> :<version>-lite`. The `:1.2` (major.minor), `:latest` and `:max`/`:balanced`/`:lite` rolling aliases are removed — one tag per version, one version per release. The old double-tag (`:1.2.11` + `:1.2`) collapsed every patch into a single moving target and made it impossible to pin a precise release. |
| Profile/arch matrix | The three profiles (max, balanced, lite) are now built for ALL four architectures (linux/amd64, linux/arm64, linux/ppc64le, linux/s390x). Previously only the max profile shipped the four-arch surface; balanced and lite were amd64-only. The validate matrix is 3 profiles x 4 architectures = 12 legs; the publish matrix pushes a four-arch index per profile; the verify job asserts every profile index carries the four-arch surface. |
| Per-profile CPU identity | The `/etc/virtual/cpuinfo` is now parameterized by the `VHE_PROFILE_*` build-args so the three profiles are genuinely distinct: max bakes `AMD EPYC 9965 192c/384t`, balanced bakes `AMD Ryzen Threadripper Pro 9995WX 96c/192t`, lite bakes `AMD Ryzen 9 9950X3D 16c/32t` (with matching cpu family/model/stepping and address sizes; the desktop ryzen drops la57 and reports 46/48-bit addressing). Previously every profile baked the hardcoded EPYC 9965 identity. |
| Per-profile memory plan | The `/etc/virtual/meminfo` static snapshot is scaled to the profile memory plan (max 1 TiB, balanced 512 GiB, lite 128 GiB) so the `VHE_MEMINFO_MODE=static` source of truth matches `VHE_TOTALRAM_GB` (VmallocTotal and Hugepagesize stay constant). |
| Build cache sharing | The profile identity baking moved from the builder stage to the runtime stage, so the builder (mesa, node, native shims) is profile-independent: the buildx registry cache is shared across max/balanced/lite for each architecture. The first leg per arch builds the heavy layers; the other two profiles reuse them. |

### Fixed

| Area | Fix |
| --- | --- |
| Validate CPU check | The push validation hardcoded `EPYC 9965` for every leg, so the balanced/lite legs could never assert their own identity. The check now carries a per-profile `expectcpu` token (`EPYC 9965` / `9995WX` / `9950X3D`) and fails if the spoofed model name does not match the profile that was built. |
| QEMU setup scope | The publish job set up QEMU only for the max profile (`if: matrix.profile == 'max'`); with all three profiles now multi-arch, QEMU is set up unconditionally so the balanced/lite arm64/ppc64le/s390x legs emulate correctly. |
| Entrypoint banner | `entrypoint.sh` logged a hardcoded `EPYC 9965 192c/384t, 128 GiB` banner for every profile; it now reads the baked model name and MemTotal from `/etc/virtual` so the startup line matches the profile the image was built for. |
| .dockerignore | Excludes the package-registry source files (`E2ugh.java`, `E2ughCli.cs`, `e2ugh.csproj`, `e2ugh.gemspec`, `pom.xml`, `settings.xml`) and Python bytecode caches that are never consumed by the engine image, keeping the build context lean. |

## 1.2.11 — Simplified GHCR publication: version tags and four-arch index

### Changed

| Area | Change |
| --- | --- |
| GHCR publication | The per-arch digest pushes + merge manifest dance is replaced by the DevThink/Saddle pattern: a single `docker/build-push-action` call per profile that pushes directly with version tags. The max profile ships all four architectures (linux/amd64, linux/arm64, linux/ppc64le, linux/s390x) in one multi-arch build-push; the published image carries `:1.2.11` (version), `:1.2` (major.minor), `:latest` and `:max` tags. The old merge job was skipped entirely when one arch failed, so NO version tag was ever published - the root cause of the containers having no version number. |
| ppc64le march | The ppc64le gcc port rejects `-march=power8` ("did you mean -mcpu=power8?"): the baseline resolution now carries the arch flag per architecture (`-mcpu=power8` for ppc64le, `-march` for the rest). |
| Concurrency | Push validation and release publication have separate concurrency groups (the old shared group cancelled the in-flight arm64 validation when the release side started). |

## 1.2.9 — CODEOWNERS restored, cleanup-after-workflow, registry-cache grants

### Fixed

| Area | Fix |
| --- | --- |
| CODEOWNERS | Restored to the Saddle format verbatim: `* @iakadion @inathlan @aasblor @nasblor` (the four organization accounts; no comment additions, no removed owners). The web admin allowlist (server seed and browser seed) mirrors the four accounts with the shared bootstrap password. |
| Validate legs registry cache | The push-event validation legs failed with `denied: installation not allowed to Read organization package`: they pushed the registry buildcache without the packages:write grant (the workflow-level permissions stayed contents:read). The validate job carries its own packages:write + the GHCR login the scan/build jobs already had. |
| Test count | The admin-seed test counts the four CODEOWNERS admins plus the operator registration (5 users). |

### Added

| Area | Addition |
| --- | --- |
| Cleanup-after-workflow | The publish ghcr and Security pipelines end with a cleanup job that deletes the buildkit gha caches the run created - a workflow that finishes leaves nothing behind (the durable layer chain lives in the registry buildcache, which the cleanup keeps). |

## 1.2.8 — Cache corruption fixed: registry-only BuildKit, schedule-only retention

### Fixed

| Area | Fix |
| --- | --- |
| Engine runtime validation | The firecracker-boot and container-scan docker builds failed with `blob not found` / `failed to copy ... BlobNotFound`: the cache-retention workflow_run trigger raced the heavy matrix builds and deleted gha cache blobs those builds were still reading. The docker jobs (validate legs, Trivy release gate, digest builds, security scans) now use the REGISTRY BuildKit cache only (`ghcr.io/<repo>-buildcache`, derived from the repository) which the Actions retention cannot corrupt, and the retention runs schedule-only in the quiet windows - never while workflows are in flight. |
| Cache store hygiene | All 165 accumulated Actions caches deleted (the store had drifted far past the per-family limits); the retention keeps the aggressive policy (one entry per family on the default ref, zero for non-default refs) on its twice-daily schedule. |

## 1.2.7 — Last two Code Scanning warnings resolved

### Fixed

| Area | Fix |
| --- | --- |
| PinnedDependencies (Dockerfile) | The meson upgrade pip command was the last "not pinned by hash" warning: meson 1.12.0 now installs from its sha256-verified wheel (the digest is checked before the wheel touches the interpreter) - the same hash-pinning contract every action reference already carries. |
| SecurityPolicy (no linked content) | SECURITY.md now carries the linked content the OSSF probe counts: the private security advisory channel (github.com/wenathlan/e2ugh/security/advisories), the advisory tracker and the threat-model document URLs. |
| Hardcoded registry refs | The BuildKit registry cache references in publishghcr.yml are derived from `github.repository` (`ghcr.io/${{ github.repository }}-buildcache`) instead of the hardcoded owner/repo - the DevThink pattern; the published image name was already derived. |
| Admin panel | The dashboard admin tab is strictly admin-only in every mode: hidden for plain users on the api node (defense in depth on top of the server-side 403) and on the static edge; local admins get a notice pointing at the self-hosted authority (the static clone has no server side). |

## 1.2.6 — Combined container pipeline, four-arch surface, sha-pinned actions

### Changed

| Area | Change |
| --- | --- |
| build.yml merged into publishghcr.yml | The validation legs (per-arch dry-run builds with the runtime probes on every push) and the release publication are one pipeline: validate runs on push to main and tags, the resolve/scan/build/merge/verify chain runs on releases - one workflow owns the container lifecycle end to end. |
| Fourth architecture | The registry surface is now linux/amd64, linux/arm64, linux/ppc64le **and linux/s390x** (node from the official tarball, `z196` portable baseline, s390x Vulkan ICD link; the verify job asserts the four-architecture index). |
| Sha-pinned actions | Every `uses:` across all workflows pins the immutable commit SHA with the version tag as a comment - the OSSF Scorecard Pinned-Dependencies contract; Dependabot keeps the SHAs current. |

### Added

| Area | Addition |
| --- | --- |
| CODEOWNERS admin seed | The self-hosted node seeds the CODEOWNERS accounts (iakadion, akadion) as admins with the shared bootstrap password at every boot (idempotent, never overwrites a rotated password); only those two usernames can ever hold the admin role, and a wiped database never locks the admin surface out. |
| Account persistence | Static-edge accounts are mirrored to IndexedDB and repaired in both directions on load (a partial storage clear never loses them); the dashboard carries explicit backup/restore keyfile buttons covering a full browser wipe; the web admin bootstrap password is shared with the server seed. |
| Security readme link | The readme carries a Security section linking SECURITY.md and the threat model - the Scorecard Security-Policy linked-content contract. |

## 1.2.5 — npm dependency surgery: the release gate finally passes

### Fixed

| Area | Fix |
| --- | --- |
| Release image CVEs | Published npm tarballs freeze their bundled node_modules at publish time, so the npm 12.0.2 swap still shipped brace-expansion 5.0.7 (and the undici/ip-address/tar mediums). The builder now performs a dependency surgery after the swap: each fixed release (brace-expansion 5.0.9, ip-address 10.3.1, tar 7.5.21, undici 6.28.0) is packed separately, extracted over the nested path and asserted by version - the exact versions the Trivy gate demands, verified in-image at build time. |

## 1.2.4 — GHCR image published with the npm tree fix

### Fixed

| Area | Fix |
| --- | --- |
| GHCR image | The 1.2.3 tag was cut at the commit carrying the broken npm-swap (remove-before-install), so the publish chain correctly skipped the build and the 1.2.3 image never reached the registry. 1.2.4 tags the commit with the working pack-swap fix, so the Trivy gate passes and the three-arch image (amd64, arm64, ppc64le) publishes for real. |

## 1.2.3 — Publish chain hardening fixes

### Fixed

| Area | Fix |
| --- | --- |
| Publish workflows | The REQUESTED_TAG expressions were corrupted during the 1.2.2 hardening edit (`${ ... }` instead of `${{ ... }}`), breaking every resolve job with git exit 128; restored, and the remaining event-derived checkout refs removed so the CodeQL untrusted-checkout pattern is fully gone. |
| CI naming gate | vulnerability-reporting.yml renamed to securitypolicy.yml (the no-dash filename convention of the workflow suite). |
| npm tree swap | The 1.2.2 fix removed the bundled npm tree before installing the new one and the build died with 'npm: not found'. The new npm is now packed with the old binary first (npm pack), the tree is swapped for the tarball content and the fixed versions asserted (tar, brace-expansion) - npm never disappears mid-step. |

## 1.2.2 — Security alerts resolved, curated release notes, persistent admins

### Fixed

| Area | Fix |
| --- | --- |
| GHCR Trivy gate | The npm 12 upgrade landed in the builder but the runtime image still copied the old dependency tree (`npm install -g` leaves the bundled tree under /usr/lib/node_modules/npm in place). The builder now removes the old tree first and asserts the fixed versions are what ship (tar 7.5.21+, brace-expansion not 5.0.7); the four HIGH CVEs (CVE-2026-14257, CVE-2026-69152, CVE-2026-69192, CVE-2026-73566) and the undici/ip-address mediums are gone from the scanned image. |
| Static-edge accounts | Clearing the browser storage no longer locks the interface out: the CODEOWNERS accounts (iakadion, akadion) are seeded as built-in local admins with documented bootstrap passwords, re-applied whenever the store is missing them; only those two accounts carry the admin role (every other local account is a plain user), and the dashboard shows the role and the allowlist. |

### Added

| Area | Addition |
| --- | --- |
| Curated release notes | The GitHub release body now carries the markdown section of the released version extracted from CHANGELOG.md (the release fails loudly when the section is missing), with GitHub's commit list appended below - the Saddle/DevThink release-notes scheme, fully automatic. |
| Security policy gate | vulnerability-reporting.yml asserts SECURITY.md documents the maintained major line matching package.json on every change to either file. |

### Changed

| Area | Change |
| --- | --- |
| Token permissions | Every publish workflow scopes its write grants to the jobs that need them (packages:write on publish jobs only; contents:write only on the release-creating jobs; actions:write only on the cache-retention job) - the OSSF Scorecard Token-Permissions remediation. |
| Untrusted checkouts | The publish workflows no longer interpolate release/dispatch event data into checkout refs: the default branch is checked out first and the verified version tag (validated against package.json of its commit) is materialized through plain git commands - the CodeQL actions/untrusted-checkout and Scorecard DangerousWorkflow remediation. |
| CODEOWNERS | The ownership/admin allowlist is iakadion + akadion, the two organization accounts. |

## 1.2.1 — Five-registry surface, automatic releases, static-edge accounts

### Added

| Area | Addition |
| --- | --- |
| Maven registry | `publishmaven.yml` ships `io.github.wenathlan:e2ugh` (the Java adapter `E2ugh.java` + `pom.xml` + `settings.xml`) to maven.pkg.github.com. |
| NuGet registry | `publishnuget.yml` ships `E2ugh` (the .NET adapter `E2ughCli.cs` + `e2ugh.csproj`) to nuget.pkg.github.com. |
| RubyGems registry | `publishrubygems.yml` ships the `e2ugh` gem (`e2ugh.gemspec`, runner shim generated at build time) to rubygems.pkg.github.com. |
| Static-edge accounts | `web/localauth.js`: login, register and dashboard keep working on hosting without a server (github pages / netlify / vercel clones) through browser-local accounts - pbkdf2-sha256 via WebCrypto, 150k iterations, localstorage, 12h sessions, clearly labeled and never synced; the self-hosted node keeps the real scrypt/cookie authority. |
| Automatic releases | A push to main that bumps `package.json` now creates the missing `v{version}` tag and runs the full release pipeline (GitHub release + all six publishes) without any manual dispatch; publishes resolve the release from the source itself and skip gracefully when a Release run released nothing. |

### Fixed

| Area | Fix |
| --- | --- |
| GHCR security gate | The image bundled npm 11.19.0 whose dependency tree carried brace-expansion 5.0.7, ip-address 10.2.0 and tar 7.5.19 (CVE-2026-14257, CVE-2026-69152, CVE-2026-69192, CVE-2026-73566); the builder upgrades npm to 12.0.2 (the engines floor), which resolves the fixed releases. |
| Pages navigation | Every page link and post-login redirect is page-relative, so login/register/dashboard resolve inside the `/e2ugh/` sub-path instead of falling into the 404 SPA fallback (verified end-to-end on the deployed pages: account creation, sign-in, wrong-password rejection, dashboard session and console sandbox with the terminal dispatcher). |

### Changed

| Area | Change |
| --- | --- |
| GHCR build speed | Dual BuildKit cache: the persistent registry cache `ghcr.io/wenathlan/e2ugh-buildcache` (mode=max) keeps the heavy QEMU/Mesa layer chains warm across releases and survives the aggressive Actions cache retention; the profiles only differ in the runtime ENV layer, so balanced and lite rebuild in minutes from the cached max chain. Validation legs pull the same registry cache. |

## 1.2.0 — Reference-aligned release pipeline

Version line reset to the semantic scheme of the reference repositories
(Saddle / DevThink): the package version, the Docker image labels, the
web API envelope, the hardware config envelopes and the compose tags all
report 1.2.0 in lockstep, and the release chain is fully automated -
pushing a `v*` tag creates the GitHub release, and publishing that
release ships the image to GHCR, the package to GitHub Packages and to
npmjs.com.

### Added

| Area | Addition |
| --- | --- |
| GHCR publication | `publishghcr.yml` fires on release published: Trivy security gate on the release image, per-profile builds (max amd64+arm64, balanced, lite) pushed by digest with provenance and SBOM attestations, per-profile manifest indexes with version / sha / profile / latest tags, and an end-to-end verification of the published index (architecture set, version label, spoofing-layer smoke test). |
| GitHub Packages | `publishgithubnpm.yml` publishes `@wenathlan/e2ugh` to npm.pkg.github.com with the job token; existing versions are skipped so re-runs never fail. |
| npmjs.com | `publishnpmjs.yml` publishes `@wenathlan/e2ugh` to the public registry when the `NPM_TOKEN` secret is configured (skips with a notice otherwise). |
| GitHub Pages | `pages.yml` publishes the whole `web/` interface (console, auth and dashboard pages, browser sandbox, mime table and hosting adapters) to GitHub Pages on every main push, with the SPA fallback and `.nojekyll` marker. |
| Cache retention | `cachecleanup.yml` keeps the Actions cache store bounded: per-family limits on the default branch (node 12, buildkit 3, codeql 1, trivy 1), zero-age eviction for non-default refs, twice-daily schedule plus post-Build/Security runs and a manual dry-run mode. |
| Release pipeline | `release.yml` restructured to the reference scheme: tag push verifies the package version against the tag and the config envelopes, builds the zip -9 source archive with checksums and creates the GitHub release that fans out to the publish workflows. |

### Added (pipeline alignment round)

| Area | Addition |
| --- | --- |
| Three-arch registry surface | The GHCR image publishes `linux/amd64`, `linux/arm64` and `linux/ppc64le` on the max profile (the Saddle/DevThink registry surface): the Dockerfile gains the ppc64le march baseline (`power8`), the official nodejs.org tarball fallback for arches the nodesource apt repo does not carry, the ppc64le Vulkan ICD link and an arch-neutral `VK_DRIVER_FILES`; build.yml validates a ppc64le leg and publishghcr.yml builds and verifies the three-arch index. |
| Merged web pipeline | `webdeploy.yml` is embedded into `pages.yml`: module syntax gate, boot smoke, html lint, the webapi suite, the zip -9 static bundle and the GitHub Pages deployment run in one workflow; the release attaches the web static bundle. |
| Web routing fix | Every page link and post-login redirect is page-relative (`login.html`, `dashboard.html`, never `/login`) so the whole interface navigates correctly inside the `/e2ugh/` sub-path of GitHub Pages as well as on the self-hosted node; the login `?next=` sanitizer accepts page-relative targets. |
| Aggressive cache retention | The cache-retention policy keeps exactly ONE cache per family on the default branch (node, buildkit, codeql, trivy; anything else is deleted) and evicts every non-default-ref cache - the DevThink contract, tightened after the store grew to ~30 entries. |
| Optimization roadmap | `docs/optimization.md` records the backlog for the slow QEMU/Mesa grid (cross-compilation, prebuilt QEMU/Mesa layer images, ccache, QEMU configure trim, native arm64 runners). |

### Changed

| Area | Change |
| --- | --- |
| Build pipeline | `build.yml` is now validation-only (per-profile image probes without pushing); the GHCR publication is exclusive to `publishghcr.yml`. |
| Version metadata | package.json, web/package.json, the Dockerfile OCI labels, docker-compose tags and labels, web/server.js API envelope, web/sandbox.js banners and every hardware config envelope (processors, gpus, cores, boards, vm, qemu, mttg, passage, docker, virtualhardware) now report 1.2.0. |
| npm scripts | `docker:build` / `docker:run` / `docker:health` tag the local image `e2ugh:1.2.0`. |

## 9.0.0 — Virtual hardware engine, hardened pipelines

### Fixed

| Area | Fix |
| --- | --- |
| Build validation | The spoofed MemTotal gate now derives its expected window from the matrix profile (`max` 1024 GiB, `balanced` 512 GiB, `lite` 128 GiB) instead of a hardcoded 128 GB band, so every hardware profile validates. |
| arm64 build | `libs/virtualizationcore.cpp` compiles on aarch64: the x86-only KVM register APIs (`kvm_regs` GPR fields, `kvm_sregs`, `KVM_SET_CPUID2`) are guarded per architecture, with the arm64 `user_pt_regs` layout mapped for `getregs`/`setregs` and explicit not-supported results for the x86-only ioctls. |
| CodeQL cpp | C/C++ analysis runs build-free (`build-mode: none`, CodeQL >= 2.21.4) after the manual-build tracer never produced trap tarballs on the runner. |
| Secret scan | gitleaks (three documentation false positives) replaced by TruffleHog with verified-only reporting over the full history. |
| Container scan | Dockle CIS-DI-0010 accept-key whitelist covers the complete ENV/ARG/LABEL key set of the runtime stage. |
| Runtime stage | `libatomic1` added for the Node.js runtime dependency; `VHE_PROFILE_*` ARGs re-declared in the runtime stage. |

### Added

| Area | Addition |
| --- | --- |
| workflow lint | `actionlint` via `reviewdog/action-actionlint@v1.73.2` gates every workflow change. |
| OSV scanner | Repository-wide OSV scan (lockfile, Dockerfile, submodules) through the pinned reusable upstream workflow. |
| Trivy fs scan | Filesystem scan (vuln, secret, misconfig) with SARIF upload to code scanning. |
| SBOM | CycloneDX software bill of materials published as a workflow artifact. |
| CodeQL actions | The workflow files themselves are analyzed (missing permissions, template injection). |
| Root files | `.dockerignore`, `.nvmrc`, `.npmrc`, `SECURITY.md`, `CHANGELOG.md`, `CODEOWNERS` aligned with the reference pipelines. |
| Dockerfile | meson pinned to the exact `1.12.0` resolved by the successful builds. |

### Changed

| Area | Change |
| --- | --- |
| npm installs | Every workflow installs through `npm ci` (lockfile-pinned); the `npm install` fallback branches are gone. |
| Releases | `softprops/action-gh-release` bumped v2 -> v3.0.2 in `release.yml` and `webdeploy.yml`. |
| Snyk | The optional Snyk job (moving `@master` branch reference) replaced by the pinned OSV scanner. |

