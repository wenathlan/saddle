# Saddle 1.8.19 release notes

## Release intent

Version **1.8.19** reorganizes the existing Saddle implementation into **twenty correlated logic domains**. It is an architecture and maintainability release: it does not remove public features, introduce an implicit infrastructure provider, or relax the existing default-denial boundaries for browser, filesystem, storage, network, runner and remote-provider effects.

## Architecture changes

| Domain change | Result | Compatibility boundary |
| --- | --- | --- |
| Public root router | The package root re-exports coherent domain façades rather than a long undifferentiated module list. | The root remains transport-neutral. |
| Foundation and execution | Domain nouns moved into `core/`; queues, workflow dispatch and session behavior moved into `runtime/`. | Published session and queue subpaths resolve to their new compiled files. |
| Communication and adapters | JSON-family protocol, webhook and MCP logic moved into API and adapter contexts. | API names and MCP command behavior remain unchanged. |
| Automation and modes | Workflow, bot and automation surfaces share an automation context; target profiles belong to modes. | Bot and surface-requirement subpaths remain available. |
| Distribution and acquisition | Delivery and proxy-pool logic now live beside their related package and scrape contracts. | Delivery and deploy subpaths remain available. |

The complete ownership map and dependency-flow diagram are included with the package documentation. The only allowed effects remain caller-owned adapters that are explicitly supplied and approved at invocation time.

## Package and native metadata

| Surface | Active version |
| --- | --- |
| npm, Maven, NuGet and RubyGems | `1.8.19` |
| Desktop and extension | `1.8.19` |
| Capacitor mobile metadata | `1.8.19` |
| iOS marketing version / build number | `1.8.19` / `1008019` |
| Robots user agent | `Saddle/1.8.19` |

## Validation evidence

The source tree passed the engine build, **140 active Node tests**, **69 legacy Vitest tests**, web type checking and production build, flat-native ownership validation, format checking, npm pack dry-run, diff integrity checking, and a production dependency audit with no reported vulnerabilities. A web build produced a bundle-size advisory for a JavaScript chunk over 500 kB; this is a non-blocking bundler warning, not a failing gate.

## Release boundary

This document records publication readiness only. It does **not** claim that registries, remote runners, signing services, hosted browsers or native packages have been activated. A tag and release remain separate operator actions and must be created only after the validated commit is available on the main branch.
