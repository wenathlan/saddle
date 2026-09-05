# Saddle iOS surface

The iOS surface is a Capacitor conversion target for the shared Saddle web application. The TypeScript library and the compiled `web/dist/public` directory remain authoritative. The generated Xcode project owns only platform metadata, WebView hosting, entitlements and caller-provided signing configuration.

Saddle-owned iOS configuration stays at the `ios/` root. The nested Xcode project and `CapApp-SPM/Sources` package are generator-owned platform internals required by Capacitor and are not treated as a project-owned `src` tree.

The workflow runs on macOS, synchronizes the web output with `npx cap sync ios` and builds an IPA only when Apple certificates, provisioning profiles and export settings are explicitly configured. No signing material is stored in the repository, and an unsigned or unprovisioned build is never described as App Store ready.

The public artifact contract is version-derived and uses the dotted lowercase pattern `saddle.ipa.1.8.14.ipa`. Generated Xcode build directories and temporary archives remain excluded from version control.
