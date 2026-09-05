<p align="center">
  <img src="docs/assets/saddlemark.svg" alt="Saddle" width="720" />
</p>

<p align="center">
  <strong>Storage-backed jobs, scraping contracts and portable runners for Node.js.</strong><br/>
  <strong>Binary computing engine, agent browser, scraper and packager.</strong><br/>
  <a href="https://github.com/wenathlan/saddle/actions/workflows/ci.yml"><img src="https://github.com/wenathlan/saddle/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/wenathlan/saddle/releases/tag/v2.0.0"><img src="https://img.shields.io/badge/release-v2.0.0-d35d3d" alt="Release 2.0.0" /></a>
  <a href="https://github.com/wenathlan/saddle/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--only-202a2f" alt="GPL 3.0 only license" /></a>
</p>

> **Core idea:** storage is the durable side of the working set; the runner is replaceable; the artifact is the boundary. **Storage == Compute** means that the same bytes can be retained or processed according to an explicit usage flag.

Saddle is a **TypeScript-first ESM engine** compiled to JavaScript, declarations and source maps for jobs that move data between storage, a bounded working set, a caller-injected runner and durable artifacts. It is also a virtual machine published as a package: the caller can run it on GitHub Actions, Forgejo, Gitea, GitLab, Codeberg, Docker or another third-party compute surface. The engine does not require the operator's local machine, does not embed credentials and does not choose a mandatory cloud provider.

The canonical JavaScript package is `@wenathlan/saddle`. GitHub Packages npm, Maven and GHCR use the `wenathlan` owner namespace; NuGet and RubyGems retain their ecosystem package names. Older `@wenathlan`, `@iakadion` and `io.devthink` references in archived documents are historical records, not current package identities.

## The e2ugh virtual-hardware engine (the grand merge)

Version 2.0.0 merges the e2ugh repository into saddle. The engine core
(`createVirtualEngine`, `validateSpec`, `randomPort`, `InternalMemory`,
`MetricsStore`, the `enginebus`) is re-exported from the package root; the
domain modules land beside the saddle domains:

| module | surface |
| --- | --- |
| `virtualcpu.ts`, `virtualmemory.ts`, `virtualgpu.ts` | the virtual hardware catalog contracts |
| `virtualization.ts`, `orchestrator.ts` | grid orchestration and the sandbox/vm runtime strategies |
| `scheduler.ts`, `compute.ts`, `performance.ts` | job queues, batch compute and benchmark planning |
| `media.ts`, `render.ts`, `quantum.ts`, `tiers.ts` | media pipeline, GPU registry, quantum simulation, tier policy |
| `security.ts`, `alternatives.ts` | hardening gates and the alternative-stack catalog |
| `web/sandbox/` | the static console and the zero-dependency self-hosted API (`node web/sandbox/server.js`) |
| `specs/*` package exports | processors, gpus, cores, boards and the qemu/mttg/passage/docker envelopes |

The full pre-merge documentation of the engine lives in
[docs/e2ugh-engine.md](docs/e2ugh-engine.md) and its release history in
[docs/e2ugh-changelog.md](docs/e2ugh-changelog.md).

## Start here

Saddle requires **Node.js 26.7.0 or newer**.

```bash
npm install @wenathlan/saddle
```

```js
import { scrapeurl, formatforagent } from "@wenathlan/saddle";

const result = await scrapeurl("https://example.com", { format: "markdown" });
const context = formatforagent(result, { maxchunksize: 2000, keypoints: 4 });

console.log(context.summary);
```

The deterministic examples and tests do not require network access or real credentials:

```bash
node --import tsx examples/publicapi.ts
npm test
```

## Foundation

Saddle is organized as a progressive architecture. **Foundation** defines the storage, runner and working-set model. **Engine** defines the contracts that make that model executable. **Productization** exposes the same contracts through package, extension, workflow, native and web surfaces without creating a second source of truth.

### Storage, runners and working sets

Saddle treats a repository, bucket or object store as durable state and a third-party runner as a replaceable processor. GitHub Actions is one adapter, not the core. Forgejo, Gitea, GitLab, Codeberg, Docker and caller-owned runners can implement the same runner contracts.

The physical limit remains explicit: remote storage is not VRAM. A storage-to-RAM bridge can stage a bounded working set through a local filesystem, tmpfs, mmap, cache or caller-owned storage adapter, but it cannot remove network latency or create the bandwidth of a GPU bus. The engine exposes that distinction instead of hiding it behind marketing language.

### The execution model

The execution model is intentionally small and explicit:

```text
repository or bucket -> runner working set -> process -> durable artifact
        persistent state       virtual processor       published boundary
```

The repository may act as a disk, a CI workflow may act as a function call, Pages may act as a static bus and a release artifact may act as the durable boundary. `workflow_dispatch`, `repository_dispatch` and HTTP adapters remain caller-configured interfaces.

### Runtime modes and physical boundaries

The historical design treats the repository and its runner as a **virtual processor**, not as a claim that remote storage is physical VRAM. The storage-to-compute bridge stages a bounded working set through memory, filesystem, tmpfs, mmap or a caller-owned adapter; network latency, bandwidth and provider quotas remain real limits. The same library contracts are available with or without their paired surface, so a caller can use fetch or browser, visible or headless, internal or external storage, physical or vectorized memory, and library or binary packaging without being locked to one mode.

| Mode | Boundary | Typical use |
| --- | --- | --- |
| Fetch | no browser | Static HTML, APIs and deterministic extraction. |
| Browser | caller-owned transport | Interactive pages, snapshots, tabs and actions. |
| Auto | adaptive selection | Fetch first, then browser when the caller permits it. |
| Headless | no visible UI | CI runners, servers and scheduled jobs. |
| CLI or binary | packaged entry point | Operator tools or third-party compute jobs. |
| Computer | storage-to-compute bridge | Bounded binary and memory processing. |

The engine keeps these boundaries explicit. It does not silently install a browser, mount a bucket as VRAM, create a database, choose a proxy, or transfer credentials to a provider.

## Engine

The engine coordinates serializable contracts rather than hiding providers. The caller composes storage, working-set, runner, protocol and delivery adapters around a durable artifact boundary. Remote effects remain adapter-owned; the transport-neutral root does not require a cloud account, database, browser binary or secret.

### What is included

| Area | Contracts shipped | Result |
| --- | --- | --- |
| Jobs | `engine`, `scheduler`, `inprocess` | `prepare -> process -> sync -> cleanup` |
| Storage | local, chunked, content-addressed, S3-compatible, GitHub Contents and file-hosting adapters | durable objects, ranges, dedupe and sync |
| Working set | memory bridge, modes, objects and transforms | storage-to-compute and compute-to-storage flows |
| Scraping | robots, cache, extraction, semantic facts, schema and normalization | bounded text, metadata, links, controls and structured output |
| Crawl | normalization, priority frontier, BFS crawler and persistent frontier contracts | domain-aware bounded crawling |
| Browser | snapshots, tabs, frames, actions, fingerprint, session and replay contracts | caller-owned browser automation without a mandatory provider |
| Operations | queues, idempotency, saga, retry, circuit breaker, health and heartbeat | controlled execution and recovery |
| Protocols | JSON, NDJSON, SSE, blocks, API envelopes and MCP | transport-neutral messages |
| Delivery | manifests, workflow registry, extension packaging and release assets | repeatable package and runner surfaces |
| Integrations | GitHub, GitLab, Forgejo, app lifecycle, command scopes and delivery adapters | caller-owned provider connectivity |

The protocol layer accepts JSON request/response envelopes, NDJSON append-only events, SSE progress streams, structured text and raw binary chunks. Retryable operations use bounded backoff, idempotency keys and caller-owned persistence; multi-step operations expose saga compensation instead of assuming that a partial remote action can be rolled back automatically.

| Reliability concern | Contract | Default boundary |
| --- | --- | --- |
| Retry | transient HTTP and network failures only | bounded attempts with caller-selected delay |
| Idempotency | request or delivery identity | at-least-once dispatch without duplicate effects |
| Circuit breaker | `closed -> open -> half-open` | caller-owned recovery threshold and timeout |
| Concurrency | queue, frontier or pool budget | explicit limits instead of unbounded fan-out |
| Compensation | workflow or saga callback | caller-owned cleanup after cancellation |

The root entry point is transport-neutral. Node filesystem, HTTP server, persistent sessions and Playwright are explicit subpaths or optional adapters. The library accepts caller-provided fetchers, browser transports, storage adapters, persistence, proxy pools, captcha evidence handlers, webhook secrets and remote credentials.

## Productization

### One engine, many shells

The same contracts can be surfaced as an npm library, application archive, computer runtime, desktop installer, Android APK/AAB, iOS IPA, CLI, binary, browser package, Manifest V3 extension, web/PWA artifact, LibreOffice OXT, VSIX, webhook server, MCP transport, workflow action, container image, Maven package, NuGet package or RubyGem. These surfaces are declarative target plans and caller-owned adapters around the engine; they are not separate sources of truth.

### Agent context and structured output

The extraction path is **structured-first**: metadata and schema facts are selected before free-form text, then serialized to bounded Markdown, JSON or XML. Heading-aware chunks preserve source URL, content hash, heading path and token estimates for downstream retrieval. `generateLlmsTxt` and `generateLlmsFullTxt` expose concise agent indexes with absolute links, while `estimateTokens`, `fitsInContext` and the browser context budget prevent a caller from silently exceeding its chosen model or transport limit. No model provider is mandatory; parsing and context policies remain injectable.

### Third-party compute identity

Saddle can be connected to GitHub, GitLab, Forgejo, Gitea, Codeberg, Docker or another caller-owned runner. The operator owns the application identity, repository permissions, webhook secret and provider token; Saddle supplies transport-neutral contracts and never assumes that a hosted service account, database or runner exists. This is the operational meaning of the original multi-forge design: the runner is replaceable and the artifact is the durable boundary.

## Public API

| Export | Purpose |
| --- | --- |
| `saddleurl` | choose a fetch or caller-injected browser path |
| `scrapeurl` | fetch one URL and extract bounded content |
| `scrapehtml` | extract from HTML without network access |
| `extractcontent` | structured extraction |
| `serializeresult` | serialize JSON, Markdown or XML results |
| `formatforagent` | summary, chunks and token count |
| `chunkMarkdown` / `formatChunksForRAG` | heading-aware bounded chunks for downstream context |
| `generateLlmsTxt` / `generateLlmsFullTxt` | agent-readable documentation indexes |
| `estimateTokens` / `fitsInContext` | model-neutral context and cost estimates |
| `withRetry` | bounded retry and abort handling |
| `createServer` | caller-owned HTTP surface |
| `batchscrape` | bounded URL groups |
| `crawlurl` | crawl contract with domain and budget controls |
| `browseragent` | caller-owned navigation, click, type and screenshot actions |
| `mcpserver` / `mcptransport` | MCP tools over JSONL or HTTP |
| `nodeserver` | Web Request/Response handler |
| `engine` / `scheduler` | job lifecycle and runner dispatch |
| `release-assets` | SHA256SUMS, SBOM and provenance metadata for caller-selected artifacts |
| `releaseevidence` / `evaluateevidence` | serializable release-evidence creation and evaluation |
| `releasereadiness` / `evidencefromverification` | readiness assessment from caller-supplied verification evidence |
| `executionrequest` / `executiondecision` / `executionhandoff` | denied-by-default privileged-effect planning and caller-owned handoff projection |
| `internalenvelope` / `internalapi` | pure typed envelopes for a unified web gateway, plan, policy, materialization, execution, persistence and evidence boundary |

The package export map is defined by the root manifest. Runnable public examples, API reference material and technical records ship with the package, while the root entry point remains the recommended starting surface for applications that do not need a platform-specific adapter.

## Browser extension

The extension is a TypeScript-first Manifest V3 reference surface in [`extension/`](extension/). Its source is compiled into a stable JavaScript unpacked artifact and contains a popup, service worker, isolated content bridge, read-only page-world `pagefacts` boundary, snapshot diffs and persisted window/tab/frame context for explicit resume.

```bash
# build an isolated JavaScript artifact using the version supplied by the caller or release tag
npm run extension:build -- --output build/extension

# load build/extension from chrome://extensions
ls build/extension/manifest.json build/extension/worker.js build/extension/content.js build/extension/popup.html
```

The base permission set is `activeTab`, `scripting` and `storage`. It does not request broad host permissions, cookies, `webRequest`, debugger access or arbitrary page code execution. Optional host escalation remains caller-owned. Releases attach `saddle.extension.<version>.zip`; cross-browser profiles remain adapter work.

## Security boundaries

| Boundary | Policy |
| --- | --- |
| Credentials | injected by the caller or repository secret; never committed or printed |
| Network | HTTP/HTTPS targets are validated; private-target access remains caller policy |
| Crawling | robots rules, crawl delay, limits and budgets are explicit |
| Storage | adapters are replaceable; the core does not own a provider account |
| Runtime | Node-only filesystem, HTTP, Playwright and release metadata stay outside the transport-neutral root |
| Extension | page-world reads are bounded, token-correlated and read-only |
| Failure | retry, circuit breaker, idempotency and resume are configurable |
| Releases | version comes from the `vX.Y.Z` tag and must match `package.json` |

Version 2.0.0 (the grand merge) absorbs the e2ugh virtual-hardware engine into the saddle engine: fifteen engine modules land at the repository root (virtualcpu, virtualmemory, virtualgpu, virtualization, orchestrator, scheduler, compute, media, render, security, performance, alternatives, tiers, quantum and the engine index core), the e2ugh static console and self-hosted API live at web/sandbox, the hardware catalogs (processors, gpus, cores, boards) and the four virtual-hardware config envelopes (qemu, mttg, passage, docker) ship as package exports under specs/*, and the legacy WebScrape toolkit generation consolidates into webscrape.ts. The engine surface stays dependency-free at the root (node built-ins only). Version 1.8.19 previously while reorganizing implementation ownership into twenty correlated domains behind a transport-neutral root router. The migration groups foundation nouns, execution state, API protocols, MCP adapters, automation contracts, package delivery and mode profiles without adding a privileged effect. Existing package subpaths remain available through their updated compiled targets. The denied-by-default execution, policy, handoff and internal-API contracts remain plans or receipts until a separately approved caller adapter is supplied. The current container targets `linux/amd64`, `linux/arm64` and `linux/ppc64le`; release evidence, readiness and verification remain serializable and caller-owned.

## Package surfaces and release automation

Workflows use the release tag and the local `releaseversion` action. They do not contain a manually edited version number. The action fetches the tag, checks out its commit and rejects a release when the tag version does not match the root `package.json`. The `created` release event fans out to the six registry workflows, so NuGet, Maven, RubyGems, GitHub Packages npm, public npmjs and GHCR receive the same validated version from one source of truth.

| Registry | Artifact | Workflow |
| --- | --- | --- |
| GHCR | `ghcr.io/wenathlan/saddle:<version>` | `publishghcr.yml` |
| GitHub Packages npm | `@wenathlan/saddle@<version>` | `publishgithubnpm.yml` |
| Public npmjs | `@wenathlan/saddle@<version>` | `publishnpmjs.yml` |
| Maven | `io.wenathlan:saddle:<version>` | `publishmaven.yml` |
| NuGet | `Saddle.<version>.nupkg` | `publishnuget.yml` |
| RubyGems | `saddle <version>` | `publishrubygems.yml` |

Release assets are caller-selected and deterministic: `SHA256SUMS`, `sbom.cdx.json` in CycloneDX 1.5 shape and `provenance.intoto.jsonl` in an in-toto statement shape. The adapter does not publish, authenticate or choose a registry. The npm token previously sent in chat is compromised and must never be used; public npmjs publication uses only the owner-managed `NPM_TOKEN` repository secret.

## Code signing policy

Saddle is applying to the SignPath Foundation for open-source code signing. Until approval is granted, release notes identify each artifact as `unsigned`, `ci-test-key`, `caller-owned` or `notarized` according to the actual build state; no release claims platform trust that has not been verified.

The requested policy is: **Free code signing provided by SignPath.io, certificate by SignPath Foundation**. Committers and reviewers are maintainers with write access to the public repository. Approvers are repository owners or release approvers recorded in `governance.md`. Every signed release must be built from repository source, pass the security and packaging gates, and receive manual signing approval.

The core program will not transfer information to other networked systems unless specifically requested by the user or the person installing or operating it. Browser sessions, storage adapters, runners and external services remain caller-configured and subject to their own policies. See [`privacy-policy.md`](privacy-policy.md) and [`security.md`](security.md).

## GitHub Pages web surface

The marketing site lives under [`web/`](web/) with a root-based TypeScript/React layout. It has no `client/` or `src/` subdirectory. Vite normalizes the base path and all visual assets resolve through a shared helper, so the same build works at `/` and `/saddle/`. Its `/playground` route projects the unified internal API boundaries with a fixed safe fixture; it is not a binary executor, service host, persistent store, remote browser or hidden backend.

```bash
npm run web:check
VITE_BASE_PATH=/saddle npm run web:build:pages
```

Small public configuration and visual assets live under `web/public/`. The development collector is TypeScript source at `web/lib/debugcollector.ts`, injected only in development, and uses `/debuglogs`; it is not part of the production build. The obsolete `web/public/__manus__` directory is intentionally absent.

## Development

```bash
npm ci
npm run check
npm run formatcheck
npm test
npm run pack:check
npm audit --audit-level=high
npm run web:check
VITE_BASE_PATH=/saddle npm run web:build:pages
```

The engine test suite is deterministic and does not require real credentials or network access. The release path is: update `package.json` and the manifest files, update `changelog.md` and release notes, run all gates, create `v<package-version>`, push the tag and create the GitHub release. Registry workflows then derive the same version from that release tag. A package metadata change alone does not publish anything; the release tag is the intentional publication boundary.

## CLI

The published `saddle` executable is a local, adapter-oriented inspection surface. It intentionally lists only stable commands and does not turn a local invocation into remote dispatch.

| Command | Purpose | External effect |
| --- | --- | --- |
| `saddle help` | list the stable command surface | none |
| `saddle modes` | print the mode catalog as JSON | none |
| `saddle runexample` | execute a temporary local engine example | temporary local storage only |
| `saddle mcp` | print the available MCP tool declarations | none |

Remote execution, provider credentials, browser transport, persistence, proxy selection, captcha evidence handling and webhook dispatch remain caller-provided adapters. The CLI is therefore a way to inspect or exercise local contracts, not a substitute for an operator-owned deployment policy.

## Repository map

```text
core/          errors, events, identifiers, hashing, jobs, artifacts, sessions and providers
memory/        working-set bridge, modes, objects and transforms
storage/       local, chunked, remote and file-hosting adapters
scrape/        robots, cache, extraction, schema, normalization and grouped crawl contracts
runtime/       engine orchestration, queues, idempotency, saga, resumable and session contexts
browser/       fingerprint, session, agent and Playwright adapter contracts
extension/     Manifest V3 reference surface and packager
desktop/       Tauri browser application for Windows, Linux and macOS
android/       Capacitor Android conversion target and optimized Gradle release
ios/           Capacitor iOS conversion target and caller-owned Xcode signing
capacitor.config.ts shared web-to-native configuration for Android and iOS
api/           envelopes, authentication, controls, JSON/NDJSON/SSE and webhooks
adapters/      forge, app, socket and MCP integration adapters
automation/    workflow, bot, permission and surface automation contracts
release/       checksums, SBOM and provenance metadata
packager/      distribution, delivery, binary, container and multi-target artifact plans
modes/         target mode selection, deployment plans and surface profiles
web/           root-based static marketing site with TypeScript React source
tests/         deterministic engine and extension coverage
docs/          architecture, API, security, release and registry notes
```

The engine is TypeScript-first ESM with English JSDoc comments and a generated JavaScript `dist/` publication surface. The web surface is TypeScript/React. Desktop is the browser application and uses Tauri; Android and iOS convert the same web output through Capacitor. No source or generated artifact hardcodes a host, port or credential.

## Historical documentation

The repository history contains 41 root README revisions and several surface-specific records. Their durable ideas are consolidated here: storage-backed execution, bounded working sets, replaceable runners, content extraction, browser actions, workflow delivery, multi-registry packaging, explicit recovery contracts and caller-owned integrations. Historical references that describe superseded identities, obsolete Node baselines, speculative provider quotas, unavailable hosted services or removed layouts remain historical evidence rather than current promises.

## Current scope

Version 1.8.19 organizes the existing engine into twenty documented, dependency-directed domains and keeps the root package as a universal, transport-neutral router. The web playground continues to demonstrate request, policy and handoff states using a fixed fixture with no operational adapter. Browser binaries, provider credentials, hosted automation registration, persistent databases, captcha solvers, remote execution and production deployment remain caller-selected adapters. Future work should extend contracts without coupling the core to one forge, registry, browser or storage vendor.

## License

Saddle is distributed under the [GNU General Public License v3.0 only](LICENSE).
