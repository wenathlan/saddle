import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The one conversion config of the grand merge, living at the web root
 * so the Capacitor CLI resolves it from its working directory (verified against
 * @capacitor/cli 8.5.1: loadConfig searches process.cwd() - the mobile
 * workflow runs `npx cap add`/`npx cap sync` from web/ and every path
 * below - webDir, android.path, ios.path - resolves relative to that cwd).
 * The shared web build (dist/public, produced by vite) is the single
 * application source; the native shells are GENERATED ON THE RUNNERS
 * (npx cap add android / npx cap add ios) into ../build/native/{android,ios}
 * at the repository root, a gitignored toolchain output that is never
 * committed (see docs/native-wrappers.md for the doctrine).
 */
const config: CapacitorConfig = {
  appId: "com.wenathlan.saddle",
  appName: "Saddle Browser",
  webDir: "dist/public",
  loggingBehavior: "none",
  android: {
    path: "../build/native/android",
    webContentsDebuggingEnabled: false,
  },
  ios: {
    path: "../build/native/ios",
    preferredContentMode: "mobile",
    webContentsDebuggingEnabled: false,
  },
};

export default config;
