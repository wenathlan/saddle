import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** Copies the contents of a generated directory into a flat project directory. */
async function copyDirectoryContents(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    await cp(join(source, entry.name), join(destination, entry.name), {
      force: true,
      recursive: true,
    });
  }
}

/** Copies a generated file when Capacitor created it and ignores absent optional files. */
async function copyOptionalFile(source, destination) {
  try {
    await cp(source, destination, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/** Copies an optional generated directory when the selected Capacitor plugins create it. */
async function copyOptionalDirectory(source, destination) {
  try {
    await copyDirectoryContents(source, destination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/** Removes the generated Capacitor app module after its staging is mapped to the root. */
async function flattenAndroid() {
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  const androidRoot = join(repositoryRoot, "web", "android");
  const generatedApp = join(androidRoot, "app");
  const generatedAssets = join(generatedApp, "src", "main", "assets");
  const generatedConfig = join(
    generatedApp,
    "src",
    "main",
    "res",
    "xml",
    "config.xml",
  );

  await copyOptionalDirectory(generatedAssets, join(androidRoot, "assets"));
  await mkdir(join(androidRoot, "res", "xml"), { recursive: true });
  await copyOptionalFile(
    generatedConfig,
    join(androidRoot, "res", "xml", "config.xml"),
  );
  await rm(generatedApp, { force: true, recursive: true });
}

try {
  await flattenAndroid();
  console.log("Android Capacitor staging mapped to the flat android root.");
} catch (error) {
  console.error("Android staging flatten failed.", error);
  process.exitCode = 1;
}
