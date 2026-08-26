/**
 * surface manifests describe repackaging targets without adding target code to the engine.
 */
export const surfaces = Object.freeze(["application", "computer", "browser", "extension", "desktop", "mobile", "cli", "binary", "web", "internet", "libreoffice", "mcp", "vsix", "container", "n8n", "library"]);

export const surfaceformats = Object.freeze({
  library: Object.freeze(["npm", "github", "maven", "nuget", "rubygems", "oci", "tarball"]),
  application: Object.freeze(["zip", "tarball"]),
  computer: Object.freeze(["node", "bun", "deno", "singlefile"]),
  desktop: Object.freeze(["appimage", "deb", "rpm", "snap", "flatpak", "dmg", "pkg", "exe", "msi", "msix"]),
  mobile: Object.freeze(["apk", "aab", "ipa"]),
  browser: Object.freeze(["html", "pwa", "wasm"]),
  extension: Object.freeze(["crx", "xpi", "safariextz"]),
  cli: Object.freeze(["node", "bun", "deno", "singlefile", "exe", "deb", "rpm"]),
  binary: Object.freeze(["sea", "singlefile", "wasm"]),
  web: Object.freeze(["html", "pwa", "ssg", "ssr", "wasm"]),
  internet: Object.freeze(["http", "websocket", "grpc", "rest"]),
  libreoffice: Object.freeze(["oxt", "zip"]),
  mcp: Object.freeze(["stdio", "jsonrpc"]),
  vsix: Object.freeze(["vsix"]),
  container: Object.freeze(["oci", "docker"]),
  n8n: Object.freeze(["node", "json"])
});

export function surfacemanifest(options = {}) {
  const target = options.target ?? "library";
  if (!surfaces.includes(target)) throw new TypeError(`unsupported surface: ${target}`);
  return { target, name: options.name ?? "saddle", entry: options.entry ?? "dist/index.js", runtime: options.runtime ?? "caller", formats: [...(options.formats ?? surfaceformats[target] ?? [])], permissions: options.permissions ?? [], capabilities: options.capabilities ?? ["memory", "scrape", "workflow"], metadata: options.metadata ?? {} };
}

/** Creates a desktop surface manifest with caller-selected packaging formats. */
export function desktopmanifest(options = {}) { return surfacemanifest({ ...options, target: "desktop", formats: options.formats ?? surfaceformats.desktop }); }

/** Creates a mobile surface manifest with caller-selected packaging formats. */
export function mobilemanifest(options = {}) { return surfacemanifest({ ...options, target: "mobile", formats: options.formats ?? surfaceformats.mobile }); }

/** Creates a caller-owned target manifest for any supported surface. */
export function applicationmanifest(options = {}) { return surfacemanifest({ ...options, target: options.target ?? "application" }); }

/** Describes installation without performing a package or platform mutation. */
export function surfacebundle(manifest) {
  if (!manifest?.target || !surfaces.includes(manifest.target)) throw new TypeError("surface bundle requires a valid manifest");
  const install = { n8n: "n8n import", browser: "import by url", extension: "load unpacked", desktop: "caller desktop bundle", mobile: "caller mobile bundle" }[manifest.target] ?? "npm install";
  return { ...manifest, files: [...new Set([manifest.entry, ...(manifest.files ?? [])])], install };
}
