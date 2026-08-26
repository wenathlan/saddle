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
