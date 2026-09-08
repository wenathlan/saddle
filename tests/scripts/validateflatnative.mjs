import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** Returns whether a path exists without turning a missing generated path into a failure. */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verifies the 2.1.0 tree contract: the native wrappers (android, ios,
 * desktop, extension) are generated on the runners into build/native/*
 * and never tracked, the interface is one flat tsx tree (page folders +
 * loose modules, no nested support folders, no legacy window-global
 * localauth.ts), and the static e2ugh console pages stay absorbed in the
 * tsx pages. the tree never goes back to tracked wrappers.
 */
async function validateFlatNative() {
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  const webRoot = join(repositoryRoot, "web");
  const forbiddenDirectories = [
    "android",
    "ios",
    "desktop",
    "extension",
    "pages",
    "components",
    "hooks",
    "lib",
    "contexts",
  ];
  const forbiddenFiles = [
    "const.ts",
    "localauth.js",
    "login.html",
    "register.html",
    "console.html",
    "dashboard.html",
    "login.js",
    "register.js",
    "console.js",
    "dashboard.js",
  ];

  for (const directory of forbiddenDirectories) {
    const path = join(webRoot, directory);
    if (await exists(path)) {
      throw new Error(`Forbidden native wrapper directory exists: ${path}`);
    }
  }
  for (const file of forbiddenFiles) {
    const path = join(webRoot, file);
    if (await exists(path)) {
      throw new Error(`Forbidden flat-interface file exists: ${path}`);
    }
  }

  const canonicalTodo = join(repositoryRoot, "docs", "todo.md");
  if (!(await exists(canonicalTodo))) {
    throw new Error(`Canonical operational checklist is missing: ${canonicalTodo}`);
  }
}

try {
  await validateFlatNative();
  console.log("Flat native surface validation passed.");
} catch (error) {
  console.error("Flat native surface validation failed.", error);
  process.exitCode = 1;
}
