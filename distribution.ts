/**
 * distribution.ts — binary, package, delivery and release-evidence contracts.
 *
 * This file is the v2.0.0 grand-merge consolidation of the former nested
 * folders of the repository (binary, packager, release) into the single
 * root-level domain file of the e2ugh family standard: one optimized
 * TypeScript file per correlated domain, ordinal sections, JSDoc on every
 * block, intra-domain imports dissolved, cross-domain imports rewritten to
 * ./<domain>.js. Every capability of every source file is preserved here;
 * the pure re-export barrels (none in this domain) folded their surface into this file directly.
 */

import { sha256 } from "./foundation.js";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/* ════════════════════════════════════════════════════════════════════ */
/* Section 1: binary/build.ts — binary builder plans portable artifacts without choosing a compiler vendor. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * binary builder plans portable artifacts without choosing a compiler vendor.
 */
export const binarytargets = Object.freeze(["node", "deno", "bun", "wasm", "singlefile", "sea", "appimage", "deb", "rpm", "snap", "flatpak", "dmg", "pkg", "exe", "msi", "msix", "apk", "aab", "ipa"]);

/** Creates a deterministic binary build plan from explicit options. */
export function portablebinaryplan(options = {}) {
  const target = options.target ?? "node";
  if (!binarytargets.includes(target)) throw new TypeError(`unsupported binary target: ${target}`);
  return { name: options.name ?? "saddle", target, entry: options.entry ?? "dist/cli/main.js", output: options.output ?? "dist/artifacts", command: options.command ?? `build ${target}`, minify: options.minify ?? false, embedruntime: options.embedruntime ?? false, externaldependencies: options.externaldependencies ?? [], metadata: options.metadata ?? {} };
}

/** Returns an artifact manifest without writing files or running a compiler. */
export function binarymanifest(plan) { return { name: plan.name, target: plan.target, entry: plan.entry, output: plan.output, files: [plan.entry], reproducible: true, metadata: plan.metadata }; }

/** Resolves an injected builder and preserves the plan as the execution boundary. */
export async function buildbinary(plan, builder) { if (typeof builder !== "function") throw new TypeError("binary builder is required"); return builder(binarymanifest(plan)); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 2: binary/archive.ts — archive inspection validates declared entry metadata before any caller-owned extraction adapter runs. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * archive inspection validates declared entry metadata before any caller-owned extraction adapter runs.
 */

/** Validates portable archive limits without opening an archive. */
export function archivelimits(input = {}) {
  return Object.freeze({ maxentries: positive(input.maxentries ?? 1, "archive maxentries"), maxdepth: positive(input.maxdepth ?? 1, "archive maxdepth"), maxoutputbytes: positive(input.maxoutputbytes ?? 1, "archive maxoutputbytes"), maxratio: positive(input.maxratio ?? 1, "archive maxratio") });
}

/** Inspects declared archive entries and returns explicit acceptance or denial evidence. */
export function archiveinspection(input = {}) {
  const limits = archivelimits(input.limits);
  if (!Array.isArray(input.entries)) throw new TypeError("archive entries must be an array");
  const entries = input.entries.map((entry) => normalizeentry(entry));
  const reasons = [];
  if (entries.length > limits.maxentries) reasons.push("entrycount");
  let outputbytes = 0;
  for (const entry of entries) {
    outputbytes += entry.sizebytes;
    if (entry.depth > limits.maxdepth) reasons.push(`depth:${entry.path}`);
    if (entry.path.split("/").includes("..") || entry.path.startsWith("/")) reasons.push(`path:${entry.path}`);
    if (entry.sizebytes / Math.max(1, entry.compressedbytes) > limits.maxratio) reasons.push(`ratio:${entry.path}`);
  }
  if (outputbytes > limits.maxoutputbytes) reasons.push("outputbytes");
  return Object.freeze({ version: 1, state: reasons.length === 0 ? "accepted" : "denied", limits, entries: Object.freeze(entries), outputbytes, reasons: Object.freeze([...new Set(reasons)]) });
}

/** Requires a caller-owned extraction adapter and denies an unsafe inspection result. */
export async function extractarchive(inspection, adapter) {
  if (inspection?.state !== "accepted") throw archiveerror("ARCHIVE_POLICY_DENIED", "archive inspection must be accepted before extraction");
  if (typeof adapter?.extract !== "function") throw archiveerror("ARCHIVE_EXTRACTION_UNAVAILABLE", "archive extraction adapter is required");
  return adapter.extract(inspection);
}

function normalizeentry(input) { const path = String(input?.path ?? ""); if (!path) throw new TypeError("archive entry path is required"); return Object.freeze({ path, sizebytes: nonnegative(input.sizebytes, "archive entry sizebytes"), compressedbytes: nonnegative(input.compressedbytes, "archive entry compressedbytes"), depth: path.split("/").filter(Boolean).length }); }
function nonnegative(value, name) { const output = Number(value); if (!Number.isSafeInteger(output) || output < 0) throw new TypeError(`${name} must be a non-negative safe integer`); return output; }
function positive(value, name) { const output = nonnegative(value, name); if (output < 1) throw new TypeError(`${name} must be positive`); return output; }
function archiveerror(code, message) { const error = new Error(message); error.code = code; return error; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 3: binary/transform.ts — binary transformation contracts classify inputs and delegate execution to isolated caller-owned adapters. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * binary transformation contracts classify inputs and delegate execution to isolated caller-owned adapters.
 */

/** Classifies a small binary prefix without trusting a filename extension. */
export function magicbytes(input) {
  const bytes = tobytes(input);
  const matches = (prefix) => prefix.every((value, index) => bytes[index] === value);
  if (matches([0x00, 0x61, 0x73, 0x6d])) return Object.freeze({ format: "wasm", executable: true });
  if (matches([0x7f, 0x45, 0x4c, 0x46])) return Object.freeze({ format: "elf", executable: true });
  if (matches([0x4d, 0x5a])) return Object.freeze({ format: "pe", executable: true });
  if (matches([0x50, 0x4b, 0x03, 0x04])) return Object.freeze({ format: "zip", executable: false });
  return Object.freeze({ format: "unknown", executable: false });
}

/** Validates a bounded WASM transformation plan without compiling or instantiating a module. */
export function wasmplan(input = {}) {
  const source = normalizedigest(input.source, "wasm source");
  const imports = normalizeimports(input.imports);
  const budget = resourcebudget(input.budget);
  return Object.freeze({ version: 1, source, imports, budget, target: String(input.target ?? "wasm"), policyversion: positiveint(input.policyversion ?? 1, "wasm policyversion"), state: "caller-executes" });
}

/** Builds a reproducible transformation cache key from verified inputs and normalized policy. */
export function transformationkey(input = {}) {
  const plan = wasmplan(input.plan ?? input);
  const compiler = normalizedigest(input.compiler, "transformation compiler");
  return sha256(JSON.stringify({ source: plan.source, imports: plan.imports, budget: plan.budget, target: plan.target, policyversion: plan.policyversion, compiler }));
}

/** Validates an immutable cache manifest that can be reused only by matching policy and toolchain identities. */
export function transformationcache(input = {}) {
  const source = normalizedigest(input.source, "transformation cache source");
  const compiler = normalizedigest(input.compiler, "transformation cache compiler");
  const key = normalizedigest(input.key, "transformation cache key");
  const outputs = Array.isArray(input.outputs) ? input.outputs.map((output) => Object.freeze({ name: nonempty(output?.name, "transformation cache output name"), sha256: normalizedigest(output?.sha256, "transformation cache output sha256"), sizebytes: positiveint(output?.sizebytes, "transformation cache output sizebytes") })) : [];
  if (outputs.length === 0) throw new TypeError("transformation cache outputs are required");
  return Object.freeze({ version: 1, key, source, compiler, policyversion: positiveint(input.policyversion, "transformation cache policyversion"), outputs: Object.freeze(outputs), verified: input.verified === true });
}

/** Explains whether a verified cache manifest can serve a requested transformation. */
export function cachedecision(manifest, request) {
  const cached = transformationcache(manifest);
  const requested = transformationcache(request);
  const reasons = [];
  if (!cached.verified) reasons.push("unverified");
  if (cached.key !== requested.key) reasons.push("key");
  if (cached.source !== requested.source) reasons.push("source");
  if (cached.compiler !== requested.compiler) reasons.push("compiler");
  if (cached.policyversion !== requested.policyversion) reasons.push("policyversion");
  return Object.freeze({ reusable: reasons.length === 0, reasons: Object.freeze(reasons), manifest: cached });
}

/** Rejects cache reuse for outputs that are sensitive, environment-bound, partial, or unverified. */
export function cacheeligibility(input = {}) {
  const reasons = [];
  if (input.verified !== true) reasons.push("unverified");
  if (input.containssecrets === true) reasons.push("secrets");
  if (input.containsprivate === true) reasons.push("private-data");
  if (input.environmentbound === true) reasons.push("environment-bound");
  if (input.partial === true) reasons.push("partial");
  return Object.freeze({ eligible: reasons.length === 0, reasons: Object.freeze(reasons) });
}

/** Runs a transformation only through an injected isolated adapter and verifies declared output digests. */
export async function executeisolated(plan, adapter) {
  if (typeof adapter?.execute !== "function") throw transformerror("ISOLATED_EXECUTION_UNAVAILABLE", "isolated transformation adapter is required");
  const result = await adapter.execute(wasmplan(plan));
  const outputs = Array.isArray(result?.outputs) ? result.outputs : [];
  if (outputs.length === 0) throw transformerror("ISOLATED_EXECUTION_OUTPUT_INVALID", "isolated transformation returned no outputs");
  const verified = outputs.map((output) => {
    const data = tobytes(output?.data);
    const expected = normalizedigest(output?.sha256, "isolated transformation output sha256");
    const actual = sha256(data);
    if (actual !== expected) throw transformerror("ISOLATED_EXECUTION_DIGEST_MISMATCH", "isolated transformation output digest did not match");
    return Object.freeze({ name: nonempty(output?.name, "isolated transformation output name"), data, sha256: actual, sizebytes: data.byteLength });
  });
  return Object.freeze({ version: 1, state: "completed", outputs: Object.freeze(verified) });
}

function resourcebudget(input = {}) { return Object.freeze({ maxbytes: positiveint(input.maxbytes ?? 1, "wasm budget maxbytes"), maxoutputbytes: positiveint(input.maxoutputbytes ?? input.maxbytes ?? 1, "wasm budget maxoutputbytes"), maxmilliseconds: positiveint(input.maxmilliseconds ?? 1, "wasm budget maxmilliseconds"), network: input.network === true }); }
function normalizeimports(input) { if (!Array.isArray(input ?? [])) throw new TypeError("wasm imports must be an array"); return Object.freeze([...new Set(input.map((value) => nonempty(value, "wasm import")))].sort()); }
function normalizedigest(value, name) { const digest = String(value ?? "").toLowerCase(); if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError(`${name} sha256 is invalid`); return digest; }
function nonempty(value, name) { const output = String(value ?? ""); if (!output) throw new TypeError(`${name} is required`); return output; }
function positiveint(value, name) { const numeric = Number(value); if (!Number.isSafeInteger(numeric) || numeric < 1) throw new TypeError(`${name} must be a positive safe integer`); return numeric; }
function tobytes(value) { if (value instanceof Uint8Array) return new Uint8Array(value); if (value instanceof ArrayBuffer) return new Uint8Array(value); throw new TypeError("binary input must be Uint8Array or ArrayBuffer"); }
function transformerror(code, message) { const error = new Error(message); error.code = code; return error; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 4: packager/manifest.ts — packager manifest context describes publication and platform artifacts without */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * packager manifest context describes publication and platform artifacts without
 * executing a platform command or selecting a vendor toolchain.
 */

export const artifactformats = Object.freeze({
  desktop: Object.freeze(["appimage", "deb", "rpm", "snap", "flatpak", "dmg", "pkg", "exe", "msi", "msix"]),
  mobile: Object.freeze(["apk", "aab", "ipa"]),
  browser: Object.freeze(["crx", "xpi", "safariextz"]),
  web: Object.freeze(["html", "pwa", "ssg", "ssr", "wasm"]),
  package: Object.freeze(["npm", "github", "maven", "nuget", "rubygems", "oci", "vsix", "oxt"])
});

const publicsurfaces = Object.freeze({ desktopapp: "browser", mobileapp: "mobile" });

/** Creates the public dotted artifact stem for a target and version. */
export function artifactname(target, version, format) {
  const surface = publicsurfaces[target] ?? target;
  const normalized = `${surface}.${version}.${format}`.toLowerCase();
  if (!/^[a-z0-9]+(?:\.[a-z0-9]+)+$/.test(normalized)) throw new TypeError("artifact name contains unsupported characters");
  return normalized;
}

/** Creates the supported cross-platform release matrix for a version. */
export function releaseartifactmatrix(version, options = {}) {
  const normalizedversion = normalizeversion(version);
  const signing = String(options.signing ?? "caller-owned");
  const entries = [
    entry("desktop", "linux", "x64", ["deb", "rpm", "appimage"], normalizedversion, signing),
    entry("desktop", "linux", "arm64", ["deb", "rpm", "appimage"], normalizedversion, signing),
    entry("desktop", "windows", "x86", ["exe", "msi"], normalizedversion, signing),
    entry("desktop", "windows", "x64", ["exe", "msi"], normalizedversion, signing),
    entry("desktop", "windows", "arm64", ["exe", "msi"], normalizedversion, signing),
    entry("desktop", "macos", "x64", ["dmg", "app.zip"], normalizedversion, signing),
    entry("desktop", "macos", "arm64", ["dmg", "app.zip"], normalizedversion, signing),
    entry("android", "android", "caller", ["apk", "aab"], normalizedversion, signing),
    entry("ios", "ios", "caller", ["ipa", "app.zip"], normalizedversion, signing),
    entry("container", "oci", "caller", ["tar.gz"], normalizedversion, signing),
    entry("extension", "browser", "caller", ["zip"], normalizedversion, signing),
  ];
  return { version: normalizedversion, signing, entries };
}

/** Creates a distribution manifest for caller-owned build and publication steps. */
export function distributionmanifest(options = {}) {
  if (!options.name || !options.version || !options.entry) throw new TypeError("distribution manifest requires name version and entry");
  return {
    name: options.name,
    version: options.version,
    entry: options.entry,
    modes: options.modes ?? ["library", "application", "computer", "desktop", "mobile", "browser", "cli", "binary", "web", "extension"],
    targets: options.targets ?? ["node", "container", "linux", "windows", "macos", "android", "ios"],
    files: options.files ?? [],
    metadata: options.metadata ?? {}
  };
}

/** Creates a caller-owned artifact plan without invoking a platform toolchain. */
export function targetplan(manifest, target, options = {}) {
  if (!manifest?.name || !manifest?.version) throw new TypeError("target plan requires a distribution manifest");
  if (!target) throw new TypeError("target plan requires a target");
  const format = options.format ?? target;
  return { name: manifest.name, version: manifest.version, target, format, entry: manifest.entry, output: options.output ?? `build/artifacts/${artifactname(target, manifest.version, format)}`, command: options.command ?? `caller-build ${target} ${format}`, generated: true, credentials: "caller-managed", metadata: options.metadata ?? {} };
}

/** Creates a declarative Node SEA or caller-selected binary build plan. */
export function binaryplan(manifest, options = {}) {
  return { tool: options.tool ?? "node", command: options.command ?? `node --experimental-sea-config ${options.config ?? "sea.config.json"}`, entry: manifest.entry, targets: options.targets ?? ["linux", "windows", "macos", "android", "ios"] };
}

/** Creates an OCI container plan with caller-controlled base, workdir and command. */
export function containerplan(manifest, options = {}) {
  const base = options.base ?? "node:26.7.0-alpine";
  const workdir = options.workdir ?? "/app";
  const command = options.command ?? ["node", manifest.entry];
  const lines = [`from ${base}`, `workdir ${workdir}`, "copy package.json package-lock.json ./", "run npm ci --omit=dev", "copy dist ./dist", `cmd ${JSON.stringify(command)}`];
  if (options.port) lines.splice(3, 0, `expose ${options.port}`);
  return { base, workdir, command, dockerfile: `${lines.join("\n")}\n` };
}

function normalizeversion(value) { const normalized = String(value).trim(); if (!/^\d+\.\d+\.\d+$/.test(normalized)) throw new TypeError(`invalid release version: ${value}`); return normalized; }

function entry(surface, platform, architecture, formats, version, signing) {
  const files = formats.map((format) => {
    if (surface === "android") return `saddle.${format}.${version}.${format}`;
    if (surface === "ios") return `saddle.${format}.${version}.${format === "app.zip" ? "app.zip" : format}`;
    if (surface === "container") return `saddle.container.${version}.tar.gz`;
    if (surface === "extension") return `saddle.extension.${version}.zip`;
    return `saddle.browser.${version}.${architecture}.${format}`;
  });
  const metadata = surface === "desktop" ? `desktop.${platform}.${architecture}` : surface;
  return { surface, platform, architecture, formats, files, signing, checksums: `sha256.${metadata}.${version}`, manifest: `manifest.${metadata}.${version}.json` };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 5: packager/publish.ts — publish plans describe registry targets without executing a publish or requiring credentials. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * publish plans describe registry targets without executing a publish or requiring credentials.
 */
export function publishplan(manifest, options = {}) {
  const version = manifest.version;
  const packageName = manifest.name;
  return {
    package: { registry: options.npm ?? "npm", name: packageName, version, command: "npm publish --access public" },
    github: { repository: options.repository ?? "", packages: true, command: "git push --follow-tags" },
    container: { registry: options.ghcr ?? "ghcr.io", image: options.image ?? packageName, version, command: "docker push" },
    maven: { registry: options.maven ?? "github-packages", name: packageName, version, command: "mvn deploy" },
    nuget: { registry: options.nuget ?? "github-packages", name: packageName, version, command: "dotnet nuget push" },
    rubygems: { registry: options.rubygems ?? "rubygems", name: packageName, version, command: "gem push" },
    cdn: [{ name: "jsdelivr", url: `https://cdn.jsdelivr.net/npm/${packageName}@${version}/index.js` }, { name: "unpkg", url: `https://unpkg.com/${packageName}@${version}/index.js` }, { name: "esm", url: `https://esm.sh/${packageName}@${version}` }]
  };
}

export function registrymanifest(manifest, options = {}) { return { name: manifest.name, version: manifest.version, surfaces: ["library", "application", "computer", "desktop", "mobile", "browser", "cli", "binary", "web", "extension", "container", ...(options.surfaces ?? [])], registries: ["npm", "github", "ghcr", "maven", "nuget", "rubygems", "jsdelivr", "unpkg", "esm.sh"] }; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 6: packager/delivery.ts — delivery manifests verify immutable chunks and keep PWA registration caller-owned. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * delivery manifests verify immutable chunks and keep PWA registration caller-owned.
 */

/** Creates an ordered immutable delivery manifest from verified chunk metadata. */
export function deliverymanifest(input = {}) {
  const chunks = Array.isArray(input.chunks) ? input.chunks.map(normalizechunk) : [];
  if (chunks.length === 0) throw new TypeError("delivery manifest chunks are required");
  const seen = new Set();
  for (const chunk of chunks) { if (seen.has(chunk.id)) throw new TypeError(`delivery manifest chunk id is duplicated: ${chunk.id}`); seen.add(chunk.id); }
  const ordered = chunks.sort((left, right) => left.index - right.index || left.id.localeCompare(right.id));
  for (let index = 0; index < ordered.length; index += 1) if (ordered[index].index !== index) throw new TypeError("delivery manifest chunk indexes must be contiguous");
  return Object.freeze({ version: 1, id: deliverynonempty(input.id, "delivery manifest id"), chunks: Object.freeze(ordered), totalbytes: ordered.reduce((total, chunk) => total + chunk.sizebytes, 0), visibility: input.visibility === "private" ? "private" : "public" });
}

/** Verifies supplied chunk bytes against a manifest without executing, importing, or caching them. */
export function verifydelivery(manifest, supplied = []) {
  const expected = deliverymanifest(manifest);
  if (!Array.isArray(supplied)) throw new TypeError("delivery chunks must be an array");
  const values = new Map(supplied.map((value) => [String(value?.id ?? ""), value]));
  const results = expected.chunks.map((chunk) => {
    const suppliedchunk = values.get(chunk.id);
    if (!suppliedchunk) return Object.freeze({ id: chunk.id, state: "missing" });
    const data = deliverytobytes(suppliedchunk.data);
    const digest = sha256(data);
    if (data.byteLength !== chunk.sizebytes || digest !== chunk.sha256) return Object.freeze({ id: chunk.id, state: "mismatch", sizebytes: data.byteLength, sha256: digest });
    return Object.freeze({ id: chunk.id, state: "verified", sizebytes: data.byteLength, sha256: digest });
  });
  return Object.freeze({ version: 1, valid: results.every((result) => result.state === "verified"), results: Object.freeze(results) });
}

/** Produces a host PWA plan that never registers a service worker or mutates browser state. */
export function pwaplan(input = {}) {
  const scope = String(input.scope ?? "");
  if (!scope.startsWith("/")) throw new TypeError("PWA scope must start with a slash");
  const serviceworker = input.capabilities?.serviceworker === true;
  const offline = input.offline === true;
  return Object.freeze({ version: 1, scope, offline, state: serviceworker ? "caller-registers" : "unsupported", update: input.update === "manual" ? "manual" : "prompt", cache: offline ? "caller-configures" : "disabled" });
}

/** Validates a caller-reported CDN capability set without contacting a CDN provider. */
export function cdncapabilities(input = {}) {
  const visibility = input.visibility === "private" ? "private" : "public";
  return Object.freeze({ version: 1, immutable: input.immutable === true, purge: input.purge === true, range: input.range === true, integrityheaders: input.integrityheaders === true, cors: input.cors === true, visibility, state: "caller-reports" });
}

const contenttypes = new Set(["application/javascript", "application/wasm", "application/octet-stream", "application/json", "text/plain"]);
function normalizechunk(input, index) { const contenttype = String(input?.contenttype ?? "application/octet-stream"); if (!contenttypes.has(contenttype)) throw new TypeError(`delivery manifest content type is unsupported: ${contenttype}`); return Object.freeze({ id: deliverynonempty(input?.id, "delivery manifest chunk id"), index: safeindex(input?.index ?? index), sha256: digest(input?.sha256, "delivery manifest chunk sha256"), sizebytes: deliverypositive(input?.sizebytes, "delivery manifest chunk sizebytes"), contenttype }); }
function deliverynonempty(value, name) { const output = String(value ?? ""); if (!output) throw new TypeError(`${name} is required`); return output; }
function digest(value, name) { const output = String(value ?? "").toLowerCase(); if (!/^[a-f0-9]{64}$/.test(output)) throw new TypeError(`${name} is invalid`); return output; }
function safeindex(value) { const output = Number(value); if (!Number.isSafeInteger(output) || output < 0) throw new TypeError("delivery manifest chunk index is invalid"); return output; }
function deliverypositive(value, name) { const output = Number(value); if (!Number.isSafeInteger(output) || output < 1) throw new TypeError(`${name} must be a deliverypositive safe integer`); return output; }
function deliverytobytes(value) { if (value instanceof Uint8Array) return value; if (value instanceof ArrayBuffer) return new Uint8Array(value); throw new TypeError("delivery chunk data must be Uint8Array or ArrayBuffer"); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 7: packager/targetcli.ts — target manifest CLI writes declarative target plans for CI artifact jobs. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * target manifest CLI writes declarative target plans for CI artifact jobs.
 * It never invokes a desktop, mobile, store or signing toolchain.
 */


/** Reads the distribution manifest and writes one target plan. */
export async function writeTargetPlan(target: string, format = target, output = "build/targets") {
  const packagejson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const manifest = { name: packagejson.name, version: packagejson.version, entry: "dist/index.js" };
  const plan = targetplan(manifest, target, { format });
  await mkdir(resolve(output), { recursive: true });
  const filename = resolve(output, `manifest.${artifactname(target, manifest.version, format)}.json`);
  await writeFile(filename, `${JSON.stringify(plan, null, 2)}\n`);
  return filename;
}

if (process.argv[1]?.endsWith("targetcli.js") || process.argv[1]?.endsWith("targetcli.ts")) {
  const [, , target = "library", format = target, output = "build/targets"] = process.argv;
  writeTargetPlan(target, format, output).then((filename) => console.log(`target plan: ${filename}`)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 8: release/assets.ts — release assets create deterministic checksums, SBOM data and provenance statements. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * release assets create deterministic checksums, SBOM data and provenance statements.
 * The adapter reads caller-selected artifacts and never publishes or handles credentials.
 */


const modulepath = dirname(fileURLToPath(import.meta.url));
const moduleparts = modulepath.split(sep);
const rootpath = moduleparts.at(-1) === "release" && moduleparts.at(-2) === "dist" ? resolve(modulepath, "..", "..") : resolve(modulepath, "..");

/** Builds deterministic release metadata files for caller-selected artifacts. */
export async function createassets(options = {}) {
  const packagefile = resolve(options.packagefile ?? join(rootpath, "package.json"));
  const lockfile = resolve(options.lockfile ?? join(rootpath, "package-lock.json"));
  const output = resolve(options.output ?? join(rootpath, "build", "release"));
  const artifactroot = resolve(options.artifactroot ?? rootpath);
  const packagejson = JSON.parse(await readFile(packagefile, "utf8"));
  const lockjson = JSON.parse(await readFile(lockfile, "utf8"));
  const artifacts = [...new Set((options.artifacts ?? []).map((artifact) => resolve(String(artifact))))].sort();
  const version = String(options.version ?? packagejson.version);
  const surface = normalizeSurface(options.surface ?? "library");
  const subjects = await Promise.all(artifacts.map(async (artifact) => {
    const name = relative(artifactroot, artifact).replaceAll("\\", "/");
    validateArtifactName(basename(name));
    const details = await stat(artifact);
    return { name, digest: await assetsha256(artifact), bytes: details.size, updatedat: Math.trunc(details.mtimeMs) };
  }));
  await mkdir(output, { recursive: true });
  const checksums = `${subjects.map((subject) => `${subject.digest}  ${subject.name}`).join("\n")}${subjects.length ? "\n" : ""}`;
  const sbom = createsbom(packagejson, lockjson);
  const provenance = createprovenance(packagejson, subjects, { ...options, version });
  const retention = options.retention ? retentionplan(subjects, options.retention) : undefined;
  const manifest = { name: String(packagejson.name), version, surface, files: subjects.map((subject) => basename(subject.name)), signing: String(options.signing ?? "caller-owned"), ...(retention ? { retention: retention.policy, retentionplan: retention.decisions, retentionevaluatedat: retention.evaluatedat } : {}) };
  const files = {
    checksums: join(output, `sha256.${surface}.${version}`),
    manifest: join(output, `manifest.${surface}.${version}.json`),
    sbom: join(output, `sbom.${surface}.${version}.cdx.json`),
    provenance: join(output, `provenance.${surface}.${version}.intoto.jsonl`)
  };
  await writeFile(files.checksums, checksums);
  await writeFile(files.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(files.sbom, `${JSON.stringify(sbom, null, 2)}\n`);
  await writeFile(files.provenance, `${JSON.stringify(provenance)}\n`);
  return { output, files, subjects, sbom, provenance, retention };
}

/** Computes deterministic keep or prune decisions without deleting caller files. */
export function retentionplan(artifacts = [], options = {}) {
  const policy = normalizeretention(options);
  const evaluatedat = Number(options.evaluatedat ?? options.now ?? 0);
  if (!Number.isSafeInteger(evaluatedat) || evaluatedat < 0) throw new RangeError("retention evaluatedat must be a non-negative safe integer");
  const entries = [...new Map(artifacts.map((artifact) => {
    const name = String(artifact.name ?? "");
    if (!name) throw new TypeError("retention artifact requires name");
    return [name, { name, bytes: normalizebytes(artifact.bytes), updatedat: normalizeupdatedat(artifact.updatedat) }];
  })).values()].sort(comparefreshness);
  const decisions = entries.map((entry) => ({ ...entry, action: "keep", reasons: [] }));
  for (const decision of decisions) {
    if (policy.maxagedays !== undefined && evaluatedat > 0 && decision.updatedat + policy.maxagedays * 86400000 < evaluatedat) { decision.action = "prune"; decision.reasons.push("max-age"); }
  }
  if (policy.maxcount !== undefined) decisions.slice(policy.maxcount).forEach((decision) => { if (decision.action === "keep") { decision.action = "prune"; decision.reasons.push("max-count"); } });
  if (policy.maxbytes !== undefined) {
    let total = decisions.filter((decision) => decision.action === "keep").reduce((sum, decision) => sum + decision.bytes, 0);
    for (const decision of [...decisions].reverse()) {
      if (total <= policy.maxbytes || decision.action !== "keep") continue;
      decision.action = "prune";
      decision.reasons.push("max-bytes");
      total -= decision.bytes;
    }
  }
  return { policy, evaluatedat, decisions: decisions.sort((left, right) => left.name.localeCompare(right.name)) };
}

/** Creates a compact CycloneDX component list from the root lockfile dependencies. */
export function createsbom(packagejson, lockjson = {}) {
  const root = lockjson.packages?.[""] ?? {};
  const dependencies = { ...(root.dependencies ?? {}), ...(root.devDependencies ?? {}) };
  const components = Object.keys(dependencies).map((name) => {
    const entry = lockjson.packages?.[`node_modules/${name}`] ?? {};
    const version = String(entry.version ?? dependencies[name]).replace(/^[^0-9]*/, "");
    return { "bom-ref": `pkg:npm/${name}@${version}`, name, version, purl: `pkg:npm/${name}@${version}`, scope: root.devDependencies?.[name] ? "optional" : "required", type: "library" };
  }).sort((left, right) => left.name.localeCompare(right.name));
  return { bomFormat: "CycloneDX", specVersion: "1.5", serialNumber: `urn:uuid:${stableuuid(`${packagejson.name}@${packagejson.version}`)}`, version: 1, metadata: { component: { type: "application", name: String(packagejson.name), version: String(packagejson.version) } }, components };
}

/** Creates an in-toto statement whose subjects are the caller-selected release artifacts. */
export function createprovenance(packagejson, subjects = [], options = {}) {
  const normalized = subjects.map((subject) => ({ name: String(subject.name), digest: { sha256: String(subject.digest) } })).sort((left, right) => left.name.localeCompare(right.name));
  return { _type: "https://in-toto.io/Statement/v1", subject: normalized, predicateType: "https://slsa.dev/provenance/v1", predicate: { buildDefinition: { buildType: String(options.buildtype ?? "caller-defined"), externalParameters: { package: String(packagejson.name), version: String(options.version ?? packagejson.version) }, internalParameters: {} }, runDetails: { builder: { id: String(options.builder ?? "caller-defined") }, metadata: { invocationId: stableuuid(`${packagejson.name}@${options.version ?? packagejson.version}:${normalized.map((subject) => subject.name).join(",")}`) } } } };
}

async function assetsha256(path) { const hash = createHash("sha256"); hash.update(await readFile(path)); return hash.digest("hex"); }

function stableuuid(value) { const hex = createHash("sha256").update(String(value)).digest("hex").slice(0, 32); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(8 + (Number.parseInt(hex.slice(16, 17), 16) % 4).toString(16))}${hex.slice(17, 20)}-${hex.slice(20)}`; }

/** Normalizes the public release surface used in metadata filenames. */
function normalizeSurface(value) { const normalized = String(value).trim().toLowerCase(); if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(normalized)) throw new TypeError(`invalid release surface: ${value}`); return normalized; }

/** Rejects helper binaries and ambiguous public filenames before metadata generation. */
function validateArtifactName(value) { if (value.includes("_") || /build[-_]script[-_]build|saddle[-_]desktop/i.test(value)) throw new TypeError(`forbidden release artifact filename: ${value}`); }

function parsearguments(argumentslist) {
  const options = { artifacts: [] };
  for (let index = 0; index < argumentslist.length; index += 1) {
    const argument = argumentslist[index];
    if (argument === "--output") options.output = argumentslist[++index];
    else if (argument === "--version") options.version = argumentslist[++index];
    else if (argument === "--surface") options.surface = argumentslist[++index];
    else if (argument === "--signing") options.signing = argumentslist[++index];
    else if (argument === "--artifact") options.artifacts.push(argumentslist[++index]);
    else if (argument === "--build-type") options.buildtype = argumentslist[++index];
    else if (argument === "--builder") options.builder = argumentslist[++index];
    else if (argument === "--max-age-days") (options.retention ??= {}).maxagedays = Number(argumentslist[++index]);
    else if (argument === "--max-count") (options.retention ??= {}).maxcount = Number(argumentslist[++index]);
    else if (argument === "--max-bytes") (options.retention ??= {}).maxbytes = Number(argumentslist[++index]);
    else if (argument === "--evaluated-at") (options.retention ??= {}).evaluatedat = Number(argumentslist[++index]);
    else throw new TypeError(`unsupported release asset argument: ${argument}`);
  }
  return options;
}

function normalizeretention(options) {
  const result = {};
  if (options.maxagedays !== undefined) result.maxagedays = normalizepolicyinteger(options.maxagedays, "maxagedays");
  if (options.maxcount !== undefined) result.maxcount = normalizepolicyinteger(options.maxcount, "maxcount");
  if (options.maxbytes !== undefined) result.maxbytes = normalizepolicyinteger(options.maxbytes, "maxbytes");
  return result;
}

function normalizepolicyinteger(value, name) { const normalized = Number(value); if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new RangeError(`${name} must be a positive safe integer`); return normalized; }

function normalizebytes(value) { const normalized = Number(value ?? 0); if (!Number.isSafeInteger(normalized) || normalized < 0) throw new RangeError("retention artifact bytes must be a non-negative safe integer"); return normalized; }

function normalizeupdatedat(value) { const normalized = Number(value ?? 0); if (!Number.isSafeInteger(normalized) || normalized < 0) throw new RangeError("retention artifact updatedat must be a non-negative safe integer"); return normalized; }

function comparefreshness(left, right) { return right.updatedat - left.updatedat || right.bytes - left.bytes || left.name.localeCompare(right.name); }

if (process.argv[1] === fileURLToPath(import.meta.url)) createassets(parsearguments(process.argv.slice(2))).then(({ output }) => { console.log(`release assets: ${output}`); }).catch((error) => { console.error(error.message); process.exitCode = 1; });

/* ════════════════════════════════════════════════════════════════════ */
/* Section 9: release/verify.ts — Release verification checks artifact digests, manifest consistency and */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * Release verification checks artifact digests, manifest consistency and
 * explicit signing state without contacting a registry or a provider.
 */


const verifymodulepath = dirname(fileURLToPath(import.meta.url));
const verifyrootpath = resolve(verifymodulepath, "..");
const signingstatuses = new Set([
  "unsigned",
  "ci-test-key",
  "caller-owned",
  "caller-configured",
  "notarized",
  "signpath-foundation",
  "provider-verified",
]);

/** Verifies a release checksum file and its correlated public manifest. */
export async function verifyassets(options = {}) {
  const checksumsfile = resolve(String(options.checksums ?? ""));
  const manifestfile = resolve(String(options.manifest ?? ""));
  if (!options.checksums || !options.manifest) throw new TypeError("checksums and manifest are required");
  const artifactroot = resolve(String(options.artifactroot ?? dirname(checksumsfile)));
  const manifest = JSON.parse(await readFile(manifestfile, "utf8"));
  const expectedversion = options.version === undefined ? undefined : String(options.version);
  const version = String(manifest.version ?? "");
  if (!version) throw new TypeError("release manifest version is required");
  if (expectedversion && expectedversion !== version) throw new Error(`release version mismatch: expected ${expectedversion}, received ${version}`);
  const signing = String(manifest.signing ?? "");
  if (!signingstatuses.has(signing)) throw new Error(`unknown release signing status: ${signing || "empty"}`);
  const checksums = parsechecksums(await readFile(checksumsfile, "utf8"));
  const manifestfiles = normalizefiles(manifest.files);
  const checksumfiles = [...checksums.keys()].sort();
  if (manifestfiles.length !== checksumfiles.length || manifestfiles.some((name, index) => name !== checksumfiles[index])) throw new Error("release manifest files do not match checksum entries");
  const verified = [];
  for (const name of checksumfiles) {
    const artifact = safepath(artifactroot, name);
    const digest = await verifysha256(artifact);
    const expected = checksums.get(name);
    if (digest !== expected) throw new Error(`checksum mismatch: ${name}`);
    verified.push({ name, digest });
  }
  return { valid: true, version, signing, files: verified };
}

/** Parses sha256sum output while accepting binary filenames with spaces. */
function parsechecksums(value) {
  const entries = new Map();
  for (const line of String(value).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-f0-9]{64})\s+[ *](.+)$/i);
    if (!match) throw new TypeError(`invalid checksum line: ${line}`);
    const name = basename(match[2]);
    if (entries.has(name)) throw new Error(`duplicate checksum entry: ${name}`);
    entries.set(name, match[1].toLowerCase());
  }
  return entries;
}

/** Normalizes and validates the manifest file list. */
function normalizefiles(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError("release manifest files must be a string array");
  const names = value.map((item) => basename(item));
  if (new Set(names).size !== names.length) throw new Error("duplicate release manifest file");
  return names.sort();
}

/** Rejects absolute paths and path traversal outside the selected artifact root. */
function safepath(root, name) {
  const artifact = resolve(root, name);
  const boundary = relative(root, artifact);
  if (isAbsolute(boundary) || boundary === ".." || boundary.startsWith(`..${sep}`)) throw new Error(`release artifact escapes root: ${name}`);
  return artifact;
}

/** Computes a SHA-256 digest with the Node.js standard library. */
async function verifysha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

/** Parses the standalone verification command used by release automation. */
function verifyparsearguments(argumentslist) {
  const options = { artifactroot: verifyrootpath };
  for (let index = 0; index < argumentslist.length; index += 1) {
    const argument = argumentslist[index];
    if (argument === "--checksums") options.checksums = argumentslist[++index];
    else if (argument === "--manifest") options.manifest = argumentslist[++index];
    else if (argument === "--root") options.artifactroot = argumentslist[++index];
    else if (argument === "--version") options.version = argumentslist[++index];
    else throw new TypeError(`unsupported release verification argument: ${argument}`);
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) verifyassets(verifyparsearguments(process.argv.slice(2))).then((result) => { console.log(JSON.stringify(result)); }).catch((error) => { console.error(error.message); process.exitCode = 1; });

/* ════════════════════════════════════════════════════════════════════ */
/* Section 10: release/evidence.ts — Release evidence evaluates caller-supplied metadata without fetching, signing, */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * Release evidence evaluates caller-supplied metadata without fetching, signing,
 * scanning, publishing or claiming an artifact has more assurance than proven.
 */

const evidencestatuses = new Set(["notProvided", "declared", "parsed", "checked", "verified", "rejected", "unknown"]);
const verifiedstatuses = new Set(["checked", "verified"]);

/** Normalizes an immutable, caller-supplied artifact evidence record. */
export function releaseevidence(input: Record<string, unknown> = {}) {
  const status = normalizestatus(input.status ?? "notProvided");
  const kind = requiredtext(input.kind, "evidence kind");
  const subjectdigest = optionaldigest(input.subjectdigest, "subject digest");
  const producer = optionaltext(input.producer);
  const workflow = optionaltext(input.workflow);
  const method = optionaltext(input.verificationmethod);
  const verifiedat = optionaltime(input.verifiedat, "verification time");
  if (verifiedstatuses.has(status) && !subjectdigest) throw new TypeError("checked evidence requires a subject digest");
  if (verifiedstatuses.has(status) && !method) throw new TypeError("checked evidence requires a verification method");
  if (status === "verified" && !producer) throw new TypeError("verified evidence requires a producer");
  if (status === "verified" && !verifiedat) throw new TypeError("verified evidence requires a verification time");
  return { version: 1, kind, status, subjectdigest, producer, workflow, verificationmethod: method, verifiedat, metadata: objectcopy(input.metadata) };
}

/** Evaluates evidence against a caller-owned policy and returns reason codes, never a trust claim. */
export function evaluateevidence(input: Record<string, unknown> = {}) {
  const evidence = Array.isArray(input.evidence) ? input.evidence.map((entry) => releaseevidence(objectvalue(entry, "evidence entry"))) : [];
  const policy = objectcopy(input.policy);
  const requiredkinds = stringlist(policy.requiredkinds, "required kinds");
  const allowedstatuses = new Set(stringlist(policy.allowedstatuses ?? ["verified"], "allowed statuses"));
  const expectedproducer = textmap(policy.expectedproducer, "expected producer");
  const expectedworkflow = textmap(policy.expectedworkflow, "expected workflow");
  const subjectdigest = optionaldigest(input.subjectdigest, "subject digest");
  const reasons = new Set<string>();
  for (const kind of requiredkinds) {
    const matches = evidence.filter((entry) => entry.kind === kind);
    if (matches.length === 0) { reasons.add(`required-evidence-missing:${kind}`); continue; }
    const accepted = matches.some((entry) => evidenceaccepted(entry, { allowedstatuses, expectedproducer, expectedworkflow, subjectdigest }, reasons));
    if (!accepted) reasons.add(`required-evidence-unsatisfied:${kind}`);
  }
  const evaluated = requiredkinds.length === 0 ? evidence : evidence.filter((entry) => requiredkinds.includes(entry.kind));
  for (const entry of evaluated) evidenceaccepted(entry, { allowedstatuses, expectedproducer, expectedworkflow, subjectdigest }, reasons);
  const ordered = [...reasons].sort();
  const rejected = ordered.some((reason) => reason.startsWith("evidence-rejected:") || reason.startsWith("producer-mismatch:") || reason.startsWith("workflow-mismatch:") || reason.startsWith("subject-mismatch:"));
  const decision = rejected ? "rejected" : ordered.length > 0 ? "insufficient" : "accepted";
  return { version: 1, decision, reasons: ordered, subjectdigest, requiredkinds, evidence };
}

/** Builds a data-only readiness receipt for a release that a caller may later execute. */
export function releasereadiness(input: Record<string, unknown> = {}) {
  const sourcetag = requiredtext(input.sourcetag, "source tag");
  const manifestversions = textmap(input.manifestversions, "manifest versions");
  const requiredgates = textmap(input.requiredgates, "required gates");
  const artifactplandigest = optionaldigest(input.artifactplandigest, "artifact plan digest");
  const targets = stringlist(input.targets, "publication targets");
  const signingstatus = optionaltext(input.signingstatus) ?? "unknown";
  const evaluation = evaluateevidence(objectvalue(input.evaluation, "evidence evaluation"));
  const reasons = new Set(evaluation.reasons);
  if (Object.values(manifestversions).some((value) => value !== sourcetag.replace(/^v/, ""))) reasons.add("manifest-version-mismatch");
  for (const [gate, status] of Object.entries(requiredgates)) if (status !== "passed") reasons.add(`required-gate-not-passed:${gate}`);
  if (!artifactplandigest) reasons.add("artifact-plan-digest-missing");
  if (targets.length === 0) reasons.add("publication-targets-missing");
  if (signingstatus === "unknown") reasons.add("signing-status-unknown");
  const ordered = [...reasons].sort();
  const decision = evaluation.decision === "rejected" ? "rejected" : ordered.length > 0 ? "insufficient" : "accepted";
  return { version: 1, sourcetag, manifestversions, requiredgates, artifactplandigest, targets, signingstatus, evaluation, decision, ready: decision === "accepted", reasons: ordered };
}

/** Maps an already-completed local checksum verification result to evidence records. */
export function evidencefromverification(input: Record<string, unknown> = {}) {
  const verification = objectvalue(input.verification, "verification result");
  if (verification.valid !== true) throw new TypeError("verification result must be valid");
  const releaseversion = requiredtext(verification.version, "release version");
  const signingstatus = requiredtext(verification.signing, "signing status");
  const files = requiredarray(verification.files, "verification files");
  if (files.length === 0) throw new TypeError("verification files must not be empty");
  const names = new Set<string>();
  const producer = optionaltext(input.producer);
  const workflow = optionaltext(input.workflow);
  const verificationmethod = optionaltext(input.verificationmethod) ?? "checksum-manifest";
  const verifiedat = optionaltime(input.verifiedat, "verification time");
  const evidence = files.map((file) => {
    const entry = objectvalue(file, "verification file");
    const name = requiredtext(entry.name, "artifact name");
    if (names.has(name)) throw new TypeError(`duplicate verification artifact: ${name}`);
    names.add(name);
    return releaseevidence({ kind: "checksum", status: "checked", subjectdigest: entry.digest, producer, workflow, verificationmethod, verifiedat, metadata: { artifact: name, releaseversion, signingstatus } });
  });
  return { version: 1, releaseversion, signingstatus, evidence };
}

function evidenceaccepted(entry: ReturnType<typeof releaseevidence>, policy: { allowedstatuses: Set<string>; expectedproducer: Record<string, string>; expectedworkflow: Record<string, string>; subjectdigest?: string }, reasons: Set<string>) {
  let accepted = true;
  if (entry.status === "rejected") { reasons.add(`evidence-rejected:${entry.kind}`); accepted = false; }
  if (!policy.allowedstatuses.has(entry.status)) { reasons.add(`evidence-status-not-allowed:${entry.kind}:${entry.status}`); accepted = false; }
  if (policy.subjectdigest && entry.subjectdigest !== policy.subjectdigest) { reasons.add(`subject-mismatch:${entry.kind}`); accepted = false; }
  if (policy.expectedproducer[entry.kind] && entry.producer !== policy.expectedproducer[entry.kind]) { reasons.add(`producer-mismatch:${entry.kind}`); accepted = false; }
  if (policy.expectedworkflow[entry.kind] && entry.workflow !== policy.expectedworkflow[entry.kind]) { reasons.add(`workflow-mismatch:${entry.kind}`); accepted = false; }
  return accepted;
}

function normalizestatus(value: unknown) { const status = requiredtext(value, "evidence status"); if (!evidencestatuses.has(status)) throw new TypeError(`unknown evidence status: ${status}`); return status; }
function requiredtext(value: unknown, label: string) { const text = optionaltext(value); if (!text) throw new TypeError(`${label} is required`); return text; }
function optionaltext(value: unknown) { const text = value === undefined || value === null ? undefined : String(value).trim(); return text || undefined; }
function optionaldigest(value: unknown, label: string) { const digest = optionaltext(value)?.toLowerCase(); if (digest && !/^[a-f0-9]{64}$/.test(digest)) throw new TypeError(`${label} must be a sha256 hex digest`); return digest; }
function optionaltime(value: unknown, label: string) { if (value === undefined || value === null) return undefined; const time = Number(value); if (!Number.isFinite(time) || time < 0) throw new TypeError(`${label} must be a non-negative finite number`); return time; }
function requiredarray(value: unknown, label: string) { if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`); return value; }
function stringlist(value: unknown, label: string) { if (value === undefined || value === null) return []; if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`); return [...new Set(value.map((item) => requiredtext(item, label)))].sort(); }
function textmap(value: unknown, label: string) { if (value === undefined || value === null) return {} as Record<string, string>; const source = objectvalue(value, label); return Object.fromEntries(Object.entries(source).map(([key, item]) => [requiredtext(key, label), requiredtext(item, label)])); }
function objectcopy(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {}; }
function objectvalue(value: unknown, label: string) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`); return value as Record<string, unknown>; }
