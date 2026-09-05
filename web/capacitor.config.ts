import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor 2.0.0 uses the shared web build as the native application source.
 * Project-owned native configuration stays at web/android and web/ios (the interface shells of the grand merge).
 * Capacitor-generated staging remains transient and never owns engine logic.
 */
const config: CapacitorConfig = {
  appId: "com.wenathlan.saddle",
  appName: "Saddle Browser",
  webDir: "web/dist/public",
  loggingBehavior: "none",
  android: {
    path: "android",
    webContentsDebuggingEnabled: false,
  },
  ios: {
    path: "ios",
    preferredContentMode: "mobile",
    webContentsDebuggingEnabled: false,
  },
};

export default config;
