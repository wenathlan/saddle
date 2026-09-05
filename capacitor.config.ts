import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The one conversion config of the grand merge, living at the repository root
 * so the Capacitor CLI resolves it from its working directory (verified against
 * @capacitor/cli 8.5.1: loadConfig searches process.cwd() and every path
 * below - webDir, android.path, ios.path - resolves relative to that cwd).
 * The shared web build (web/dist/public, produced by vite) is the single
 * application source; the project-owned native shells stay at web/android and
 * web/ios (the packaging wrappers, never a second interface).
 */
const config: CapacitorConfig = {
  appId: "com.wenathlan.saddle",
  appName: "Saddle Browser",
  webDir: "web/dist/public",
  loggingBehavior: "none",
  android: {
    path: "web/android",
    webContentsDebuggingEnabled: false,
  },
  ios: {
    path: "web/ios",
    preferredContentMode: "mobile",
    webContentsDebuggingEnabled: false,
  },
};

export default config;
