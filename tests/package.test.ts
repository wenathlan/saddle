/**
 * package surface tests import every declared export target and catch accidental runtime coupling.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { releaseartifactmatrix } from "../distribution.js";

/* The transport-neutral graph of the grand merge: the flat domain files
   bundle full-stack sections, so the browser-loadable surface is the curated
   set of domains whose whole import closure stays free of Node-only modules
   (foundation, intelligence, automation). The node-only capabilities keep
   their deep exports (./memory-*, ./sessions-file, ./release-*, ...). */
const transportneutral = ["dist/foundation.js", "dist/intelligence.js", "dist/automation.js"];

test("imports every declared package export target in Node", async () => {
  const root = dirname(new URL(import.meta.url).pathname);
  const packagejson = JSON.parse(await readFile(resolve(root, "../package.json"), "utf8"));
  for (const target of Object.values(packagejson.exports)) {
    assert.equal(typeof target, "string");
    const resolved = resolve(root, "..", target);
    /* the virtual-hardware envelope carriers (.config data documents, .json
       hardware specs) are data files: assert readability, not module import */
    if (/\.(?:config|json)$/.test(target)) {
      await readFile(resolved, "utf8");
      continue;
    }
    await import(pathToFileURL(resolved).href);
  }
});

test("declares runtime metadata and an optional browser provider peer", async () => {
  const root = dirname(new URL(import.meta.url).pathname);
  const packagejson = JSON.parse(await readFile(resolve(root, "../package.json"), "utf8"));
  assert.equal(packagejson.private, false);
  assert.equal(packagejson.engines.node, ">=26.7.0");
  assert.equal(packagejson.packageManager, "npm@12.0.2");
  assert.equal(packagejson.peerDependencies.playwright, "^1.62.1");
  assert.equal(packagejson.peerDependenciesMeta.playwright.optional, true);
  assert.equal(packagejson.exports["./browser-playwright"], "./dist/browser.js");
});

test("keeps transport-neutral export graphs free of Node-only imports", async () => {
  const root = dirname(new URL(import.meta.url).pathname);
  const seen = new Set();
  const pending = transportneutral.map((entry) => resolve(root, "..", entry));
  while (pending.length) {
    const filename = pending.pop();
    if (seen.has(filename)) continue;
    seen.add(filename);
    const source = await readFile(filename, "utf8");
    assert.doesNotMatch(source, /from\s+["']node:/, `${filename} imports a Node-only module`);
    for (const match of source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const child = resolve(dirname(filename), specifier);
      pending.push(child.endsWith(".js") ? child : `${child}.js`);
    }
  }
  assert.equal(seen.has(resolve(root, "..", "dist/foundation.js")), true);
  assert.equal(seen.has(resolve(root, "..", "dist/automation.js")), true);
});

test("creates the expanded release matrix without vendor coupling", () => {
  const matrix = releaseartifactmatrix("1.8.14", { signing: "caller-owned" });
  assert.equal(matrix.entries.length, 11);
  assert.deepEqual(matrix.entries.find((entry) => entry.platform === "windows" && entry.architecture === "x86")?.files, ["saddle.browser.1.8.14.x86.exe", "saddle.browser.1.8.14.x86.msi"]);
  assert.deepEqual(matrix.entries.find((entry) => entry.surface === "android")?.files, ["saddle.apk.1.8.14.apk", "saddle.aab.1.8.14.aab"]);
  assert.equal(matrix.entries.find((entry) => entry.surface === "container")?.manifest, "manifest.container.1.8.14.json");
});
