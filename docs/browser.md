# Saddle browser surface

The root `browser/` directory contains the transport-neutral browser-agent contracts: session state, context, snapshots, fingerprints, Playwright integration, recording and agent orchestration. It is library logic and is shared by callers; it is not a second copy of the desktop UI.

The user-facing browser application is the existing Tauri shell in `desktop/`, which wraps the compiled `web/dist/public` surface on Windows, Linux and macOS. Android and iOS convert the same web output through Capacitor. This boundary keeps browser behavior in the library and keeps presentation and native packaging in their target surfaces.

Release filenames identify the user-facing desktop browser with the dotted lowercase pattern `saddle.browser.1.8.14.<format>`. Internal module filenames remain API-compatible unless a deliberate public compatibility migration is documented.
