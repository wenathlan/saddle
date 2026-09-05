# Saddle Android surface

The Android surface is a Capacitor conversion target for the shared Saddle web application. The TypeScript library remains the source of engine logic, while the compiled `web/dist/public` directory supplies the WebView payload. Android-specific files contain application metadata, Gradle configuration, resources and signing hooks only.

Saddle-owned Android files are flat at this surface root: `AndroidManifest.xml`, `build.gradle`, `main/`, `res/`, `test/` and `androidtest/`. The Gradle `sourceSets` block maps these paths explicitly. Capacitor may create transient `app/`, `assets/` and plugin staging during synchronization; those paths are generated toolchain output, ignored by Git and never treated as project-owned source.

The workflow runs `npm run web:build:pages`, `npx cap sync android`, regenerates the Saddle icon family from `desktop/icon.svg` and executes Gradle release tasks. Release builds enable R8 code shrinking and resource shrinking. A production keystore is never committed; `ANDROID_KEY_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_STORE_PASSWORD` and `ANDROID_KEY_PASSWORD` are repository secret contracts. A manual test run may opt into a clearly labeled CI test key, but that output is not a trusted store artifact.

The public artifact contract is version-derived and uses dotted lowercase names such as `saddle.apk.1.8.14.apk` and `saddle.aab.1.8.14.aab`. The release manifest records the signing status and the workflow verifies the APK and AAB signatures before upload. Native helper binaries, generated build directories and copied web assets remain excluded from version control.
