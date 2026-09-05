/**
 * modes.ts — target mode resolution and host-neutral deployment contracts.
 *
 * This file is the v2.0.0 grand-merge consolidation of the former nested
 * folders of the repository (modes) into the single
 * root-level domain file of the saddle family standard: one optimized
 * TypeScript file per correlated domain, ordinal sections, JSDoc on every
 * block, intra-domain imports dissolved, cross-domain imports rewritten to
 * ./<domain>.js. Every capability of every source file is preserved here;
 * the pure re-export barrels (none in this domain) folded their surface into this file directly.
 */



/* ════════════════════════════════════════════════════════════════════ */
/* Section 1: modes/modes.ts — mode profiles describe paired operation surfaces without changing engine contracts. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * mode profiles describe paired operation surfaces without changing engine contracts.
 */
const names = ["computer", "library", "application", "browser", "desktop", "mobile", "extension", "cli", "binary", "internet", "physicalfile", "vectorfile", "visible", "headless"];

export function modeprofile(options = {}) {
  const enabled = new Set(options.enabled ?? ["library", "cli", "binary"]);
  return Object.fromEntries(names.map((name) => [name, { name, enabled: enabled.has(name), paired: Boolean(options.paired?.includes(name)) }]));
}

export function librarymode(factory) { return { name: "library", start: factory, stop: async () => undefined }; }
export function climode(run) { return { name: "cli", run }; }
export function binarymode(run) { return { name: "binary", run }; }
export function browsermode(adapter) { return { name: "browser", adapter }; }
export function headlessmode(adapter) { return { name: "headless", adapter }; }
export function computemode(adapter) { return { name: "computer", adapter }; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 2: modes/matrix.ts — mode matrix keeps supported execution choices in one grouped contract. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * mode matrix keeps supported execution choices in one grouped contract.
 */
export const modeaxes = Object.freeze({
  execution: ["library", "application", "browser", "desktopapp", "mobileapp", "extension", "cli", "binary", "computer", "internet"],
  runtime: ["node", "browser", "deno", "bun", "worker", "unknown"],
  memory: ["internal", "external", "physical", "vectorized", "library"],
  file: ["internal", "external", "physical", "vector"],
  dependency: ["internal", "external", "dev"],
  visibility: ["visible", "headless"],
  pair: ["without", "with"]
});

export const operationmodes = Object.freeze(modeaxes.execution.flatMap((execution) => modeaxes.pair.map((pair) => `${execution}${pair}`)));

/** Returns true when the matrix contains the requested axis value. */
export function validatemode(axis, value) { return Boolean(modeaxes[axis]?.includes(value)); }

/** Returns a serializable snapshot for documentation and diagnostics. */
export function modecatalog() { return { axes: Object.fromEntries(Object.entries(modeaxes).map(([key, values]) => [key, [...values]])), operationmodes: [...operationmodes] }; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 3: modes/resolve.ts — mode resolver selects open defaults while preserving every caller choice. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * mode resolver selects open defaults while preserving every caller choice.
 */

/** Resolves an execution profile without starting a process or opening a socket. */
export function resolvemode(options = {}) {
  const profile = {
    execution: options.execution ?? "library",
    runtime: options.runtime ?? "unknown",
    memory: options.memory ?? "internal",
    file: options.file ?? "internal",
    dependency: options.dependency ?? "internal",
    visibility: options.visibility ?? "headless",
    pair: options.pair ?? "without"
  };
  for (const [axis, value] of Object.entries(profile)) if (!validatemode(axis, value)) throw new TypeError(`unsupported mode ${axis}:${value}`);
  return { ...profile, capabilities: modecapabilities(profile) };
}

/** Returns stable capabilities for adapters and diagnostics. */
export function modecapabilities(profile) {
  return {
    library: profile.execution === "library" || profile.execution === "application",
    browser: profile.execution === "browser" || profile.execution === "extension" || profile.runtime === "browser" || profile.runtime === "worker",
    cli: profile.execution === "cli" || profile.execution === "binary",
    physicalmemory: profile.memory === "physical",
    vectorizedmemory: profile.memory === "vectorized",
    externalmemory: profile.memory === "external",
    externalfile: profile.file === "external",
    externaldependency: profile.dependency === "external",
    visible: profile.visibility === "visible"
  };
}

/** Returns a stable cross-runtime capability report without starting infrastructure. */
export function capabilityreport(options = {}) {
  const overrides = { runtime: options.runtime ?? "unknown", memory: options.memory ?? "internal", file: options.file ?? "internal", dependency: options.dependency ?? "internal", visibility: options.visibility ?? "headless", pair: options.pair ?? "without" };
  const profiles = modeaxes.execution.map((execution) => {
    const profile = resolvemode({ ...overrides, execution });
    return { mode: execution, capabilities: profile.capabilities, profile };
  });
  return { version: 1, axes: Object.fromEntries(Object.entries(modeaxes).map(([key, values]) => [key, [...values]])), overrides, profiles, infrastructure: { host: "caller-owned", port: "caller-owned", credentials: "caller-owned", provider: "caller-owned" } };
}

/** Applies one profile to a caller supplied operation. */
export async function withmode(options, operation) { if (typeof operation !== "function") throw new TypeError("mode operation is required"); return operation(resolvemode(options)); }


/* ════════════════════════════════════════════════════════════════════ */
/* Section 4: modes/deploy.ts — deploy surface exposes artifact planning without performing provider mutations. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * deploy surface exposes artifact planning without performing provider mutations.
 */
export { publishplan, registrymanifest } from "./distribution.js";
export { surfacemanifest, surfacebundle } from "./automation.js";

/* ════════════════════════════════════════════════════════════════════ */
/* Section 5: modes/targets.ts — target profiles keep platform packaging open and describe capability boundaries. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * target profiles keep platform packaging open and describe capability boundaries.
 */
export const targetprofiles = Object.freeze({
  application: { runtime: "caller", entry: "dist/index.js", capabilities: ["memory", "storage", "network"], formats: ["zip", "tarball"] },
  computer: { runtime: "node", entry: "dist/index.js", capabilities: ["memory", "storage", "runner"], formats: ["node", "bun", "deno", "singlefile"] },
  desktopapp: { runtime: "tauri", entry: "desktop/src-tauri", capabilities: ["memory", "file", "visible"], formats: ["appimage", "deb", "rpm", "snap", "flatpak", "dmg", "pkg", "exe", "msi", "msix"] },
  mobileapp: { runtime: "capacitor", entry: "web/dist/public/index.html", capabilities: ["memory", "network", "visible"], formats: ["apk", "aab", "ipa"] },
  android: { runtime: "capacitor", entry: "android", capabilities: ["memory", "network", "visible"], formats: ["apk", "aab"] },
  ios: { runtime: "capacitor", entry: "ios", capabilities: ["memory", "network", "visible"], formats: ["ipa"] },
  cli: { runtime: "node", entry: "dist/cli/main.js", capabilities: ["memory", "storage", "network"], formats: ["node", "bun", "deno", "singlefile", "exe", "deb", "rpm"] },
  binary: { runtime: "caller", entry: "dist/cli/main.js", capabilities: ["memory", "storage", "runner"], formats: ["sea", "singlefile", "wasm"] },
  browser: { runtime: "tauri", entry: "desktop/src-tauri", capabilities: ["memory", "network", "visible"], formats: ["html", "pwa", "wasm", "appimage", "deb", "rpm", "dmg", "exe", "msi"] },
  extension: { runtime: "browser", entry: "dist/extension/index.js", capabilities: ["browser", "network", "visible"], formats: ["crx", "xpi", "safariextz"] },
  internet: { runtime: "caller", entry: "dist/index.js", capabilities: ["network", "webhook", "api"], formats: ["http", "websocket", "grpc", "rest"] },
  web: { runtime: "browser", entry: "web/dist/public/index.html", capabilities: ["network", "visible"], formats: ["html", "pwa", "ssg", "ssr", "wasm"] },
  libreoffice: { runtime: "caller", entry: "dist/index.js", capabilities: ["file", "network"], formats: ["oxt", "zip"] },
  mcp: { runtime: "caller", entry: "dist/adapters/mcpserver.js", capabilities: ["network", "api"], formats: ["stdio", "jsonrpc"] },
  vsix: { runtime: "caller", entry: "dist/index.js", capabilities: ["network", "visible"], formats: ["vsix"] },
  container: { runtime: "node", entry: "dist/index.js", capabilities: ["memory", "storage", "network"], formats: ["oci", "docker"] }
});

/** Creates a surface target with caller supplied entry and capabilities. */
export function targetmanifest(target, options = {}) { const profile = targetprofiles[target]; if (!profile) throw new TypeError(`unsupported target: ${target}`); return { target, runtime: options.runtime ?? profile.runtime, entry: options.entry ?? profile.entry, formats: options.formats ?? [...profile.formats], capabilities: options.capabilities ?? [...profile.capabilities], permissions: options.permissions ?? [], metadata: options.metadata ?? {} }; }

/** Returns all supported target profiles for documentation and tooling. */
export function targetcatalog() { return Object.fromEntries(Object.entries(targetprofiles).map(([key, value]) => [key, { ...value, capabilities: [...value.capabilities] }])); }
