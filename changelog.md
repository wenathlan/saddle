                         SADDLE - CHANGELOG
                       Version 1.7, August 2026

 Copyright (C) 2026 devthink, nathlan, iakadion, nathu filho, allan neris, andraneris, and contributors. Licensed under GPL-3.0-only.
 Project: saddle

  All notable changes to Project saddle are documented in this file.

	  ## [Unreleased]

	    - Future changes will be recorded here after the 1.8.19 release.

	  ## [1.8.19] - 2026-08-26

	    - Reorganized the TypeScript-first library into twenty correlated domains behind a transport-neutral public router.
	    - Consolidated foundation nouns, runtime execution state, API protocols and webhooks, MCP adapters, automation contracts, delivery planning and mode profiles while preserving package subpaths.
	    - Added an architecture organization record and rendered dependency-flow diagram, with compatibility rules for package exports, native metadata and workflows.
	    - Verified 140 active tests, 69 legacy tests, web type checking and build, flat-native validation, formatting, npm packaging and a production dependency audit with no reported vulnerabilities.
	    - Aligned active npm, lockfile, Maven, NuGet, RubyGems, desktop, Capacitor, iOS, extension and crawler metadata to `1.8.19`, with iOS build number `1008019`.
	    - Added the canonical [1.8.19 release notes](docs/releasenotes-1.8.19.md).

		  ## [1.8.18] - 2026-08-17

		    - Added serializable `executionrequest`, `executiondecision`, `executionhandoff`, `internalenvelope`, and `internalapi` contracts for privileged-effect planning without implicit runtime effects.
		    - Added explicit default denial for binary execution, host bridging, remote dispatch, provider access, local storage, browser sessions, databases and network effects until policy, approval and caller-owned adapter declarations agree.
		    - Added the `@wenathlan/saddle/isolation` package export and deterministic tests that cover missing adapters, local targets, provider targets, browser targets and ignored undeclared URLs.
		    - Added the unified `web/` playground route that visualizes typed internal API boundaries and the difference between a denied request and a non-executing caller handoff.
		    - Aligned active package, registry, native, extension, crawler, Capacitor and iOS metadata to `1.8.18`, with iOS build number `1008018`.
		    - Added the canonical [1.8.18 release notes](docs/releasenotes-1.8.18.md).

		  ## [1.8.17] - 2026-08-14

		    - Expanded the GHCR Linux OCI manifest target to `linux/amd64`, `linux/arm64`, and `linux/ppc64le` with QEMU-enabled Buildx publication.
		    - Retained a loadable `linux/amd64` image for the container vulnerability scan, OCI version-label verification, and CLI smoke test.
		    - Added a post-push manifest-index assertion that verifies the published Linux architectures before reporting container availability.
		    - Documented the deferred Windows container boundary and rejected non-runnable `unknown` descriptors.
		    - Aligned active package, native, extension, crawler, iOS build, and Capacitor metadata to `1.8.17`.
		    - Added the canonical [1.8.17 release notes](docs/releasenotes-1.8.17.md).

		  ## [1.8.16] - 2026-08-14

		    - Added `releaseevidence`, `evaluateevidence`, and `releasereadiness` as data-only release evidence and readiness contracts with explicit statuses, policy reason codes, and no external release effects.
		    - Added `evidencefromverification` to map an already-valid local checksum result into `checked` evidence without upgrading declared signing state into a trust claim.
		    - Exported the feature from the root entry and `@wenathlan/saddle/release-evidence`, with documented consumer boundaries.
		    - Expanded deterministic release coverage to 136 active tests while preserving the 69 legacy tests and passing package, web, audit, and flat-native gates.
		    - Aligned active package, native, extension, crawler and iOS build metadata to `1.8.16`.
		    - Added the canonical [1.8.16 release notes](docs/releasenotes-1.8.16.md).

		  ## [1.8.15] - 2026-08-14

	    - Added verified storage pools with quorum writes, explicit write modes, bounded operations, range reads, repair plans and restoration plans.
	    - Added bounded working-set admission, capability-gated bridge plans, materialization ledgers and caller-owned cleanup plans.
	    - Added WASM and binary transformation contracts, isolated execution adapters, archive inspection limits and sensitive-cache eligibility controls.
	    - Added declarative provider selection, capability evidence, cancellation and dispatch rendering, immutable delivery manifests, PWA/CDN plans, and Mini App/DNS surface requirements.
	    - Aligned all active package, native, extension, crawler and iOS build metadata to `1.8.15`.
	    - Added the canonical [1.8.15 release notes](docs/releasenotes-1.8.15.md).

	  ## [1.8.14] - 2026-08-14

	    - Bumped active npm, lockfile, Maven, NuGet, RubyGems, desktop, mobile, extension and crawler metadata to `1.8.14`.
	    - Restored container-first package ordering in the canonical documentation and release matrix.
	    - Added OCI version labels, build-stage engine compilation and post-push pull/label/CLI smoke validation for GHCR images.
	    - Added the canonical [1.8.14 release notes](docs/releasenotes-1.8.14.md) while preserving the historical 1.8.13 record.

	  ## [1.8.13] - 2026-08-14

	    - Added caller-owned persistent queue leases, visibility timeouts, renewals, attempt accounting and idempotency keys.
	    - Added schema-neutral structured extraction with field provenance, bounded UTF-8 payloads and injected parsers.
	    - Added allowlisted browser snapshot projection with stable references and deterministic context byte budgets.
	    - Added resumable workflow cancellation reasons and caller-owned idempotent compensation callbacks.
	    - Added deterministic artifact retention policies and keep/prune decisions without implicit deletion.
	    - Expanded the 1.8.21 comparative research matrix to 60 public repositories and documented the selected implementation boundaries.
	    - Aligned active package, native, extension and crawler metadata to `1.8.13`.
	    - Added the canonical [1.8.13 release notes](docs/releasenotes-1.8.13.md) while preserving the historical 1.8.12 record.

	  ## [1.8.12] - 2026-08-13

	    - Added the canonical [1.8.12 release notes](docs/releasenotes-1.8.12.md) with the artifact matrix and explicit signing-state policy.
	    - Standardized the project license and root legal documents on GPL-3.0-only, preserving one canonical `LICENSE` file and removing byte-identical Markdown/Text duplicates.
    - Added the public SignPath Foundation code-signing policy, GitHub Actions integration path and explicit unsigned, caller-owned, test-key and notarized status vocabulary.
    - Expanded the desktop matrix to Linux x64/arm64, Windows x86/x64/arm64 and macOS x64/arm64, with dotted lowercase artifact names and per-runner manifests and checksums.
    - Prepared Android APK/AAB and iOS IPA/app archive metadata, container and browser-extension release assets, with signing claims controlled by the actual CI state.
    - Preserved the Saddle brand icon across native and extension surfaces and retained security scanning, SBOM and provenance gates.

  ## [1.8.11] - 2026-08-13

    - Flattened the project-owned Tauri desktop surface into `desktop/` with root Cargo, Rust entrypoints, icons and configuration
    - Flattened the project-owned Capacitor Android surface into root `android/` source sets with explicit Gradle mappings and generated staging cleanup
    - Preserved Capacitor and Xcode generator-owned internals while rejecting project-owned `src` paths in native surfaces
    - Added flat native validation, Android staging flattening and workflow path corrections for desktop, Android and iOS
    - Bumped active package, registry, extension, crawler and native metadata to `1.8.11`

  ## [1.8.10] - 2026-08-13

    - Normalized active package, desktop, extension, registry and crawler identity to `1.8.10`
    - Added mobile conversion research for Capacitor, Ionic and Tauri with an explicit library-first decision
    - Added explicit Capacitor Android and iOS surfaces that reuse the shared web output and library contracts
    - Enabled Android R8, resource shrinking and optimized resource shrinking; the generated APK is 3,498,594 bytes and the AAB is 3,893,352 bytes
    - Normalized public artifacts to lowercase dotted names and rejected helper binaries, underscore-based names and generic metadata
    - Published the verified desktop, Android, container and extension assets with surface-specific manifests and SHA-256 files

  ## [1.8.9] - 2026-08-13

    - Converted the active engine and deterministic tests from JavaScript to a root-based TypeScript source layout
    - Added dist-only compilation with declarations, source maps and generated output excluded from version control
    - Added TypeScript-first extension source resolution and retained the stable JavaScript Manifest V3 artifact format
    - Added declarative application, computer, desktop, Android, iOS, CLI, binary, browser, web, LibreOffice, VSIX and container target plans
    - Added tag-driven target-plan workflow without hardcoded credentials or platform-specific source code
    - Preserved the legacy typed scrape feature surface and verified 98 active tests plus 69 legacy Vitest tests
    - Moved the development debug collector into the TypeScript web graph and repaired web compiler blockers

  ## [1.8.8] - 2026-08-13

    - Consolidated URL normalization, crawl traversal, frontier budgets and persistent crawl state into `scrape/crawl.js`
    - Consolidated retry policy and circuit protection into `runtime/retry.js`
    - Merged scraper-specific error taxonomy into the core error context and removed redundant top-level folders
    - Preserved the public export names and deterministic behavior while reducing active source files and folder boundaries
    - Updated package, extension, Maven, NuGet, RubyGems, README and release metadata to `1.8.8`

  ## [1.8.7] - 2026-08-13

    - Removed the obsolete nested `scrape` package manifests and lockfile while preserving the engine's dependency-free JavaScript scrape contracts
    - Removed the public `__manus__` directory and moved the development collector to `web/public/debugcollector.js` with a private `/debuglogs` endpoint
    - Added base-aware asset URL resolution and normalized GitHub Pages subpath builds
    - Removed the unused JSX locator plugin and upgraded Vitest to the security-fixed 4.1.10 line
    - Added npm audit and dependency review gates to the primary CI workflow
    - Consolidated canonical package identity, security boundaries, architecture and release documentation

  ## [1.8.6] - 2026-08-13

    - Added durable pending extension commands with explicit rehydration and resume
    - Added optional Playwright peer metadata and a Node-only `browser-playwright` adapter
    - Added a read-only page-world bridge with token-correlated `pagefacts` responses and deterministic timeout handling
    - Added extension snapshot diffs plus persisted window, tab and frame context for explicit resume
    - Added deterministic SHA256SUMS, CycloneDX SBOM and in-toto-shaped provenance asset generation
    - Flattened the web application into a root-based layout and corrected GitHub Pages, CI and Dependabot paths
    - Fixed the GHCR production image build for the root manifest's dev-only peer dependency graph

  ## [1.8.5] - 2026-08-13

    - Added Node.js 26.7.0 and npm 12 package metadata
    - Added an optional Playwright peer and explicit Node-only browser adapter
    - Preserved the transport-neutral root without adding runtime dependencies

  ## [1.8.4] - 2026-08-12

    - Updated all active library and forge pipelines from Node 22 to Node.js 26.7.0
    - Added complete deterministic gates to GitLab, Forgejo, Gitea and Woodpecker validation workflows
    - Documented caller-owned Pages and cross-forge deployment boundaries

  ## [1.8.2] - 2026-08-12

    - Added a minimal Manifest V3 permission policy with caller-owned optional escalation
    - Added a Node-only extension builder that versions the unpacked manifest from release metadata
    - Added a release workflow that packages and attaches `saddle-extension-<version>.zip`
    - Added context-aware replay for caller-owned window, tab and frame restoration
    - Added a transport-neutral export graph audit for browser-like package loading
    - Added bounded content-type detection and normalization for structured and binary scrape results
    - Migrated active repository, Maven and GitHub Packages owner metadata to `wenathlan`
    - Prepared all release workflows to derive owner namespaces from the transferred repository

  ## [1.8.1] - 2026-08-12

    - Changed the canonical public npm package identity to `@wenathlan/saddle`
    - Preserved the v1.8.1 GitHub Packages npm artifact namespace as `@iakadion/saddle` for historical accuracy
    - Added follow-up release metadata after the immutable v1.8.0 package identity
    - Kept package version resolution derived from the release tag

  ## [1.8.0] - 2026-08-12

    - Updated GitHub Actions, Docker bases and CI toolchains to Node.js 26.7.0 and current stable action majors
    - Added a transport-neutral browser worker bridge and package export import tests
    - Added a Node 26.7.0 cross-runtime probe lane for Node, Bun and Deno
    - Kept package publication versions derived from release tags without manual version inputs

  ## [1.7.0] - 2026-08-12

    - Added app installation, suspension, revocation and scope authorization
    - Added command scope guards and idempotent bot command results
    - Added webhook delivery attempts, retryable failures and dead letters
    - Verified GitHub npm, GHCR, Maven, NuGet and RubyGems publication workflows for 1.7.0
    - Documented the public npmjs Trusted Publisher bootstrap requirement

  ## [1.6.0] - 2026-08-12

    - Added request identity, success and error API envelopes
    - Added caller-owned optional authorization verification
    - Added secure response headers and bounded redirect checks
    - Added injected DNS resolution checks for private targets
    - Added optional browser snapshot and action MCP tools

  ## [1.5.0] - 2026-08-12

    - Added semantic page extraction for headings, landmarks, controls and links
    - Added priority crawl frontiers and per-domain page budgets
    - Added retrieval provenance and provenance merging for RAG context
    - Added bounded in-memory counters and duration metrics

  ## [1.4.0] - 2026-08-11

    - Added provider health and capacity reports
    - Added cooperative heartbeat signals for long-running work
    - Added forge-neutral manual, webhook, schedule, retry and heartbeat triggers
    - Added legal remote run transitions with resumable submit, status and cancel operations

  ## [1.3.0] - 2026-08-11

    - Added bounded range reads to chunked storage
    - Added content-addressed immutable object storage and logical references
    - Added tiered hot and cold cache with stale-while-revalidate loading
    - Added manifest comparison, conflict policy and multi-backend sync
    - Added memory engine backend capabilities and sync methods

  ## [1.2.0] - 2026-08-11

    - Added vendor-neutral page snapshots with bounded elements and stable references
    - Added stale snapshot errors and snapshot diffs
    - Added tab, frame and active context registry
    - Added bounded browser action batches and structured outcomes
    - Added snapshot-aware action recording for replay provenance

  ## [1.1.0] - 2026-08-11

    - Added a Manifest V3 browser bridge under `extension/`
    - Added versioned extension messages, page snapshots and stale reference checks
    - Added service worker routing with session state persistence
    - Added a narrow popup for user initiated snapshots and page reads
    - Added deterministic extension tests without browser credentials or network access
    - Added the `@wenathlan/saddle/extension` package export

  ## [1.0.0] - 2026-08-11

    - Initial release of saddle
    - Initial engine contracts and package release
    - GNU General Public License v3.0

                         END OF CHANGELOG
