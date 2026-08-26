# Saddle 1.8.19 implementation checklist

> This plan contains **1,000 individual actions**. It uses 100 unchecked work packages, each with ten ordered actions: **inspect, extract, classify, design, implement, test, boundary-test, review, document, and record**. A package is complete only when its corresponding evidence exists. The plan treats the user-supplied scope as product direction, not as proof that a remote browser, micro-VM, provider account, storage service, or hardware isolation already exists.

## Non-negotiable operating rules

| Rule | Requirement |
| --- | --- |
| User boundary | The root library and browser playground must not inspect, read, write, delete, upload, download, execute, or configure the user’s browser, local filesystem, local storage, installed software, process list, device, or credentials by default. |
| Virtuality | “Virtual” means a caller-owned remote or isolated adapter owns the process, storage and network effects. An in-memory object, a client-side cache or a JavaScript worker is not described as a VPS or micro-VM. |
| Browser engines | Chromium-family and Gecko-family support are declared through capability adapters. The library must not claim that one executable is simultaneously a Chromium and Firefox engine. |
| Saddle Browser | The custom browser is a product surface with a design system and portable shell plans; it becomes an isolated remote browser only when an operator supplies a verified runtime adapter. |
| Micro-VM | A micro-VM requires an operator-provided host, virtualization mechanism, images, resource limits, network policy and lifecycle evidence. The transport-neutral root only plans and evaluates those requirements. |
| Effects | Download, upload, browser navigation, binary execution, container start, database access, filesystem access, network dispatch and provider use remain explicit privileged effects. |
| Storage | Virtual storage remains adapter-owned durable state with bounded materialization, integrity evidence, retention policy and cleanup intent. It is never advertised as the user’s absent physical storage. |
| Release | Existing tags and published packages remain immutable. Artifact recovery may rerun a failed workflow only when its source revision is valid; otherwise it requires a new version. |

## 1. Scope, terminology, and requirement audit — actions 0001–0100

- [ ] **0001–0010.** Read the 1.8.18 README, conversations, planning records and release notes; extract every virtual execution, storage, browser, container, micro-VM and artifact requirement.
- [ ] **0011–0020.** Classify every extracted requirement as shipped, contract-ready, adapter-ready, research-only, deferred, infeasible, policy-rejected, or dependent on operator infrastructure.
- [ ] **0021–0030.** Define exact terms for virtual plan, virtual storage adapter, isolated runner, remote browser, container, micro-VM, browser engine, browser shell and custom browser product.
- [ ] **0031–0040.** Define prohibited marketing language for in-process memory, browser-only demonstration, client cache and non-isolated worker execution.
- [ ] **0041–0050.** Define evidence requirements for claims about host isolation, network isolation, storage isolation, browser isolation, process isolation and provider isolation.
- [ ] **0051–0060.** Define a capability matrix separating Chromium-family, Gecko-family, WebKit-family, custom-shell and remote-session capabilities.
- [ ] **0061–0070.** Define a decision matrix separating browser compatibility adapters from the Saddle Browser custom shell and from a remote browser session service.
- [ ] **0071–0080.** Define ownership boundaries for user, application integrator, adapter implementer, infrastructure operator, package maintainer and release workflow.
- [ ] **0081–0090.** Define the 1.8.19 non-goals: no stealth access, no local browser control, no implicit downloads, no hidden storage, no quota evasion and no provider account creation.
- [ ] **0091–0100.** Record the reconciled product direction and unresolved architectural choices in the 1.8.19 planning base.

## 2. Zero-touch virtual execution policy — actions 0101–0200

- [ ] **0101–0110.** Define default-deny requirements for local filesystem reads, writes, deletes, mounts, clipboard access and hardware device access.
- [ ] **0111–0120.** Define default-deny requirements for local browser sessions, cookies, profiles, extensions, tabs, downloads and history.
- [ ] **0121–0130.** Define default-deny requirements for local process start, binary execution, shell evaluation, package installation and native module loading.
- [ ] **0131–0140.** Define default-deny requirements for local network listeners, outbound requests, proxy selection, DNS changes and credential injection.
- [ ] **0141–0150.** Define explicit policy fields for remote-only execution, remote-only storage, remote-only browser and operator-approval requirements.
- [ ] **0151–0160.** Define consent correlation records that state which caller approved a privileged effect, for what adapter, target, duration and budget.
- [ ] **0161–0170.** Define structured denial receipts that state the blocked capability without leaking credentials, paths, browser state or host details.
- [ ] **0171–0180.** Define effect-free preview behavior for every virtual execution request in the browser playground.
- [ ] **0181–0190.** Define deterministic fixtures for user-device, local-browser, local-storage, local-process and unknown-target denials.
- [ ] **0191–0200.** Define tests proving that no default request invokes an adapter or reaches a host resource.

## 3. Virtual storage and bounded materialization — actions 0201–0300

- [ ] **0201–0210.** Define remote artifact references for content-addressed objects, provider objects, object-store keys and caller-owned streams.
- [ ] **0211–0220.** Define virtual storage capability receipts for read range, write, integrity, region, retention, encryption declaration and lifecycle status.
- [ ] **0221–0230.** Define bounded remote download plans that identify the adapter, byte cap, digest expectation, destination intent and expiry.
- [ ] **0231–0240.** Define remote upload plans that identify source references, content type, integrity policy, destination adapter and caller approval.
- [ ] **0241–0250.** Define zero-local-storage policy evaluation that denies plans whose adapter declares local host persistence or unbounded materialization.
- [ ] **0251–0260.** Define virtual cache contracts for freshness, content identity, retention intent, eviction intent and adapter ownership.
- [ ] **0261–0270.** Define virtual working-set plans that expose bounded bytes and ranges without claiming RAM, VRAM or disk conversion.
- [ ] **0271–0280.** Define artifact handoff records between storage, transform, runner and browser adapters with hashes and capability receipts.
- [ ] **0281–0290.** Define fake remote-storage adapters for deterministic tests that have no network, filesystem or provider effect.
- [ ] **0291–0300.** Define storage policy tests for malformed references, oversized transfers, missing integrity, local fallback and expired retention.

## 4. Virtual binary processing and container plans — actions 0301–0400

- [ ] **0301–0310.** Define virtual binary source references for durable remote artifacts, inline bounded metadata and caller-owned remote streams.
- [ ] **0311–0320.** Define binary inspection plans using declared metadata, magic bytes, digest and bounded sampling without execution.
- [ ] **0321–0330.** Define binary classification records for archive, executable, document, image, model, unknown and malformed artifacts.
- [ ] **0331–0340.** Define virtual transform plans for WASM, native process, OCI container, micro-VM and remote runner adapters.
- [ ] **0341–0350.** Define OCI image identity, immutable digest, platform, command, read-only inputs, writable-output policy and resource-limit requirements.
- [ ] **0351–0360.** Define container execution eligibility rules requiring a named operator adapter, explicit policy, approval, image evidence and output destination.
- [ ] **0361–0370.** Define container receipt records for isolation declaration, host identity redaction, timing, exit classification, output evidence and unknown state.
- [ ] **0371–0380.** Define virtual archive inspection and extraction plans that reject unsafe paths, symlinks, oversized entries and implicit local extraction.
- [ ] **0381–0390.** Define fake container adapters for deterministic acceptance, denial, receipt and unknown-state tests.
- [ ] **0391–0400.** Define security boundary tests proving the root never starts a container, executes bytes or chooses a cloud provider.

## 5. Micro-VM capability contracts — actions 0401–0500

- [ ] **0401–0410.** Define a micro-VM capability declaration for virtualization mechanism, architecture, kernel provenance, root image provenance and operator identity.
- [ ] **0411–0420.** Define micro-VM resource requirements for vCPU, memory, disk image, network policy, boot timeout, execution timeout and output limits.
- [ ] **0421–0430.** Define micro-VM lifecycle states for planned, policy-denied, approval-required, adapter-handoff, starting, observed, completed, failed and unknown.
- [ ] **0431–0440.** Define micro-VM network policy shapes for none, allowlist, proxy-only, service-mesh and operator-defined policy without implicit public access.
- [ ] **0441–0450.** Define micro-VM storage attachment plans that require read-only inputs, explicit writable destinations and cleanup intent.
- [ ] **0451–0460.** Define micro-VM browser payload plans that separate browser engine selection from the VM runtime selection.
- [ ] **0461–0470.** Define micro-VM evidence receipts for image digest, adapter version, limits, lifecycle events, browser session handoff and output artifacts.
- [ ] **0471–0480.** Define cancellation and lost-contact contracts that preserve unknown remote state and prohibit false cleanup claims.
- [ ] **0481–0490.** Define fake micro-VM adapters that simulate only serializable status transitions and never emulate hardware isolation.
- [ ] **0491–0500.** Define deterministic tests for micro-VM admission, denial, lifecycle validation, receipt evaluation and unknown-state behavior.

## 6. Browser engine compatibility model — actions 0501–0600

- [ ] **0501–0510.** Define browser-engine family identifiers for chromium, gecko, webkit and unknown engines without embedding vendor binaries.
- [ ] **0511–0520.** Define browser distribution identifiers for Chrome, Chromium, Edge, Brave, Vivaldi, Firefox, Tor Browser and operator-defined distributions.
- [ ] **0521–0530.** Define capability declarations for navigation, tab, frame, screenshot, download plan, upload plan, DevTools protocol, WebDriver and remote-display transport.
- [ ] **0531–0540.** Define compatibility evaluation that selects declared adapter capabilities rather than claiming binary or source-level engine fusion.
- [ ] **0541–0550.** Define browser-profile policies that reject access to user profiles, cookies, passwords, history, extensions and local browser data by default.
- [ ] **0551–0560.** Define remote-browser session requests with engine family, distribution preference, screen size, locale, network policy, storage policy and time budget.
- [ ] **0561–0570.** Define browser-session receipts with adapter identity, engine declaration, image reference, session lifecycle, allowed actions and evidence references.
- [ ] **0571–0580.** Define browser action request records for navigation, click, type, capture, download plan and upload plan with explicit approval boundaries.
- [ ] **0581–0590.** Define compatibility fixtures for Chromium-family, Gecko-family, unsupported distribution and missing-capability outcomes.
- [ ] **0591–0600.** Define deterministic tests proving engine preference never launches, downloads or controls a user browser.

## 7. Saddle Browser product surface — actions 0601–0700

- [ ] **0601–0610.** Define the Saddle Browser product charter as a custom interface and adapter-owning shell, distinct from an embedded engine claim.
- [ ] **0611–0620.** Define the Saddle Browser design system, visual identity, navigation model, virtual-session states and accessibility requirements.
- [ ] **0621–0630.** Define browser-shell plans for desktop, web, mobile and remote-session surfaces without adding generated `src` directories.
- [ ] **0631–0640.** Define a portable session manifest that can request a compatible engine adapter or the Saddle Browser shell presentation.
- [ ] **0641–0650.** Define navigation workspace models for virtual tabs, sessions, captures, evidence, storage references and policy status.
- [ ] **0651–0660.** Define isolated-download and upload presentation states that show plans, approvals, adapter ownership and denial reasons without touching user files.
- [ ] **0661–0670.** Define AI browser-assistance boundaries for proposed actions, evidence collection, request planning and no autonomous credential handling.
- [ ] **0671–0680.** Define remote display and shared-session capability requirements inspired by remote browser products without copying implementation claims.
- [ ] **0681–0690.** Define responsive playground pages that compare custom Saddle Browser shell, Chromium-compatible adapter and Gecko-compatible adapter capabilities.
- [ ] **0691–0700.** Define UI tests for safe fixture rendering, keyboard operation, denial display, adapter handoff display and no-effect browser interactions.

## 8. Neko-style remote browser integration research — actions 0701–0800

- [ ] **0701–0710.** Read Neko’s public architecture, session model, image configuration and WebRTC requirements as research data.
- [ ] **0711–0720.** Identify which Neko concepts are container orchestration, remote display, browser image selection, input transport and operator policy.
- [ ] **0721–0730.** Compare Neko-style browser containers with Chromium CDP, WebDriver, Playwright, Gecko Remote Protocol and custom remote-display adapters.
- [ ] **0731–0740.** Define a Saddle remote-browser adapter contract that can represent Neko-compatible services without importing or starting them in the root.
- [ ] **0741–0750.** Define configuration references for image, engine, profile policy, display transport, authentication, room/session policy and network limits.
- [ ] **0751–0760.** Define remote-browser lifecycle receipts for service endpoint redaction, session identity, capability evidence, time budget and cleanup intent.
- [ ] **0761–0770.** Define integration security requirements for authentication, room isolation, TLS termination, signaling, WebRTC and inbound input policy.
- [ ] **0771–0780.** Define adapter conformance fixtures that use in-memory declarations and no live Neko, container, browser or network service.
- [ ] **0781–0790.** Define research evidence records that distinguish a compatible adapter plan from an actual hosted Neko deployment.
- [ ] **0791–0800.** Define acceptance tests for engine selection, policy denial, session receipt validation and unsupported remote-display features.

## 9. Unified backend API and persistence contracts — actions 0801–0900

- [ ] **0801–0810.** Define internal API boundaries for gateway, policy, virtual storage, binary plan, micro-VM plan, browser plan, evidence and persistence.
- [ ] **0811–0820.** Define external API envelopes for create-plan, evaluate-policy, request-handoff, report-receipt and inspect-capabilities operations.
- [ ] **0821–0830.** Define API authentication and authorization as application-layer adapters with no client-side secret storage.
- [ ] **0831–0840.** Define optional Drizzle persistence adapter requirements for plans, approvals, receipts, artifacts, sessions, audits and retention intents.
- [ ] **0841–0850.** Define a storage-neutral persistence interface so database choice remains caller-owned and the root stays dependency-free.
- [ ] **0851–0860.** Define schema projections for virtual jobs, remote sessions, browser capability receipts, container receipts and micro-VM receipts.
- [ ] **0861–0870.** Define event protocol projections for JSON, NDJSON, SSE and MCP without an always-on service claim.
- [ ] **0871–0880.** Define redaction and serialization rules for URLs, endpoints, policies, storage references, credentials, logs and browser evidence.
- [ ] **0881–0890.** Define deterministic in-memory persistence fakes for contracts, tests and playground projections without a database server.
- [ ] **0891–0900.** Define tests for API shape, access denial, redaction, receipt immutability and persistence adapter absence.

## 10. Playground and public-site integration — actions 0901–1000

- [ ] **0901–0910.** Audit the single root-based `web/` site and preserve its shared navigation, base path, assets and no-`src` structure.
- [ ] **0911–0920.** Define a virtual control-plane playground flow for request, policy, storage plan, binary plan, runner plan, browser plan and receipt projection.
- [ ] **0921–0930.** Define a visible zero-touch mode that explicitly denies user browser, device, local file and local storage effects.
- [ ] **0931–0940.** Define remote-only mode controls that display required operator adapter, approval, infrastructure, cost and availability prerequisites.
- [ ] **0941–0950.** Define browser engine comparison panels for Chromium-family, Gecko-family, WebKit-family and custom Saddle Browser shell capabilities.
- [ ] **0951–0960.** Define virtual storage and binary processing visualizations that state bounded materialization and never promise invisible free compute.
- [ ] **0961–0970.** Define a micro-VM readiness view for image, policy, limits, network, storage and receipt prerequisites.
- [ ] **0971–0980.** Define integration guidance for library-only, application backend, remote runner and browser-service deployments with clear operator responsibility.
- [ ] **0981–0990.** Define GitHub Pages release behavior and future external-host portability requirements without adding provider-specific server functions.
- [ ] **0991–1000.** Define responsive, accessible, deterministic UI tests and static build checks for each virtual control-plane state.

## 11. Artifact recovery for immutable 1.8.18 — actions 1001–1100

- [ ] **1001–1010.** Inventory the release workflows, tag source revision, release asset list and failed artifact jobs for `v1.8.18`.
- [ ] **1011–1020.** Confirm whether each failed workflow checks out the immutable tag or the current main revision before any rerun request.
- [ ] **1021–1030.** Rerun only 1.8.18 jobs whose source revision contains a valid build path and whose retry cannot alter package publication semantics.
- [ ] **1031–1040.** Record mobile artifact rerun status, Android signing state, APK/AAB availability and exact failure reasons without manufacturing files.
- [ ] **1041–1050.** Record desktop artifact rerun status, per-platform matrix availability and exact failure reasons without manufacturing files.
- [ ] **1051–1060.** Record container artifact rerun status, platform manifest availability, image verification and exact failure reasons without false claims.
- [ ] **1061–1070.** Record extension, target-plan and checksum asset status against the public release attachment list.
- [ ] **1071–1080.** Decide whether immutable 1.8.18 can recover missing assets or requires a new patch version, based on source revision evidence.
- [ ] **1081–1090.** Update release documentation only with observed workflow outputs, attached assets and independently checked registry availability.
- [ ] **1091–1100.** Preserve the public release history, never retag published versions, never overwrite registries and never claim unavailable artifacts.

## 12. Security, quality, release, and deployment boundary — actions 1101–1200

- [ ] **1101–1110.** Threat-model remote storage, remote binary plans, container plans, micro-VM plans, browser sessions, WebRTC transport and session sharing.
- [ ] **1111–1120.** Define SSRF, DNS rebinding, private-target, image-provenance, archive-bomb, token-redaction and browser-input controls.
- [ ] **1121–1130.** Define virtual resource budgets for bytes, time, concurrency, bandwidth, browser sessions, remote storage and receipt retention.
- [ ] **1131–1140.** Define test matrices for no-adapter, local-adapter, unapproved-remote, approved-remote, expired approval and unknown remote outcomes.
- [ ] **1141–1150.** Run root build, active tests, legacy tests, formatting, package inspection, web checks, native checks and audit gates for each completed code block.
- [ ] **1151–1160.** Validate that all new public contracts are additive, TypeScript-first, dependency-free, serializable and adapter-owned.
- [ ] **1161–1170.** Validate that all new browser and storage claims distinguish planning, compatibility, remote operation and independently verified execution.
- [ ] **1171–1180.** Prepare a release checklist that aligns package, native, extension, crawler, iOS and release asset metadata only when a new version is approved.
- [ ] **1181–1190.** Keep GitHub Pages as the static deployment path; evaluate external hosts only with portable static output and no provider-specific server lock-in.
- [ ] **1191–1200.** Record the release decision, evidence matrix, known limitations, unresolved infrastructure choices and next contract selection.

## Evidence ledger

Every completed package must link its source material, design record, source path, test, boundary test, validation command, result, review state and disposition. The checklist intentionally keeps operational infrastructure separate from library plans: a host, container runtime, micro-VM platform, remote browser service, database and storage provider are never activated by this document or by the transport-neutral root.

## Execution ledger

- [x] **R001.** Created the 1,200-action 1.8.19 checklist before implementing the first contract.
- [x] **R002.** Recorded the Neko architecture review and its distinct image-matrix, WebRTC and explicit persistence lessons.
- [x] **R003.** Verified the `v1.8.18` release workflow inventory and confirmed that package registries and the container artifact had already completed.
- [x] **R004.** Rebuilt desktop and Android release assets from the corrected `main` workflow dispatch; the public release now contains 38 attached assets.
- [ ] **R005.** Configure caller-owned Apple distribution certificate, password, provisioning profile, keychain password and provisioning-profile name before attempting an iOS IPA.
- [x] **R006.** Added the serializable virtual-browser request, decision, handoff and receipt contracts with default-deny tests and no runtime adapter.
- [ ] **R007.** Extend virtual browser storage, remote display and micro-VM contracts after the next review gate.

## Documentation centralization ledger

- [x] **D001.** Inventory root-level Markdown and text documents, including package, workflow and link dependencies.
- [x] **D002.** Preserve only required root entrypoints for package publication, licensing and repository architecture.
- [x] **D003.** Move eligible planning, research, operations and consolidation documents into `docs/`.
- [x] **D004.** Update all repository-relative links, workflow references and package metadata affected by the move.
- [x] **D005.** Validate the repository documentation map and commit the centralization change.

## Branch and pull request archive ledger

- [x] **B001.** Inventory every open or closed pull request and every remote branch other than `main`.
- [x] **B002.** Capture immutable commit references and create recovery tags for each non-main branch.
- [x] **B003.** Close pull requests only after their branch head is represented by a recovery tag.
- [x] **B004.** Delete every remote branch other than `main` after closing its associated pull request.
- [x] **B005.** Verify that `main` is the only remaining branch and publish the archival manifest in the cleanup commit.

## Workflow improvement audit ledger

- [x] **W001.** Inventory every tracked workflow, reusable action and trigger in the repository.
- [x] **W002.** Classify current coverage across CI, security, releases, deployment, maintenance and automation.
- [x] **W003.** Compare the current set with the official workflow categories supplied by the user.
- [x] **W004.** Identify duplicate, overlapping, inactive and missing controls with their operating costs.
- [x] **W005.** Evaluate candidate workflows against the no-secret-in-source, tag-derived-release and minimal-cache policies.
- [x] **W006.** Implement only low-risk workflow improvements with deterministic validation and no new external credentials.
- [x] **W007.** Publish a workflow-improvement assessment with evidence, trade-offs, deferred work and operating requirements.

## Architecture reorganization ledger

- [x] **A001.** Inventory root modules, mode folders, public exports, build entrypoints and generated-output boundaries.
- [x] **A002.** Build an import and export dependency map before moving any implementation file.
- [x] **A003.** Define the 20 correlated logic domains and assign every owned module to one primary domain.
- [x] **A004.** Record compatibility boundaries for package exports, CLI commands, extension entrypoints, workflows and native build metadata.
- [x] **A005.** Consolidate public API and contract logic without changing published function names or serializable shapes.
- [ ] **A006.** Consolidate virtual isolation, policy, approval, handoff and evidence logic without privileged effects.
- [ ] **A007.** Consolidate browser, virtual-browser, session and agent-facing logic into one browser domain.
- [ ] **A008.** Consolidate storage, memory, working-set, cache and materialization planning into one memory domain.
- [ ] **A009.** Consolidate binary inspection, transformation, packaging and artifact derivation into one binary domain.
- [x] **A010.** Consolidate runner, runtime, remote-execution plan and mode-selection logic into one execution domain.
- [x] **A011.** Consolidate scrape, crawl, request, content and protocol logic into one acquisition domain.
- [ ] **A012.** Consolidate release evidence, readiness, assets, registry and publication validation into one release domain.
- [ ] **A013.** Consolidate CLI commands, parsing, presentation and command fixtures into one command domain.
- [ ] **A014.** Consolidate web pages, components, styles, route composition and static-build boundaries into one web domain.
- [ ] **A015.** Align desktop, Android, iOS and extension mode folders with flat root-first ownership and shared library contracts.
- [ ] **A016.** Consolidate tests, deterministic fixtures, validation scripts and architecture assertions by the same domains.
- [x] **A017.** Update internal imports, package subpaths, workflow paths and documentation references after each domain move.
- [x] **A018.** Publish an architecture map and organization diagram that names the 20 domains and their allowed dependency direction.
- [x] **A019.** Run full engine, legacy, package, web, native, format and security gates after the final move set.
- [x] **A020.** Bump all active product manifests to 1.8.19, document the reorganization and prepare the release only after all gates pass.

### Architecture-reorganization evidence

The 1.8.19 source reorganization completed without removing logic. The public root now routes through domain façades, while correlated implementation moved into `core/`, `runtime/`, `api/`, `adapters/`, `automation/`, `packager/`, `scrape/` and `modes/`. Explicit package subpaths were redirected to their new compiled targets, and Node-only server and filesystem adapters remain outside the transport-neutral root graph.

The versioned validation pass completed with 140 active tests, 69 legacy tests, package-export import coverage, web type checking and production build, flat-native validation, formatting, npm package dry-run, diff integrity checking, and a production dependency audit reporting no vulnerabilities. The web bundler reported a non-blocking JavaScript chunk-size advisory; no gate failed. The result is publication-ready source evidence only: no tag, registry publication, signing, browser session, provider or remote execution was performed by this reorganization.
