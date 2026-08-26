/**
 * package surface tests import every declared export target and catch accidental runtime coupling.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { releaseartifactmatrix } from "../packager/manifest.js";

const transportneutral = ["dist/index.js", "dist/storage/index.js", "dist/runners/scheduler.js", "dist/core/sessions.js", "dist/modes/resolve.js", "dist/modes/matrix.js", "dist/browser/index.js", "dist/automation/bot.js", "dist/captcha/contract.js", "dist/modes/deploy.js", "dist/extension/index.js", "dist/core/hash.js", "dist/runtime/worker.js"];

test("imports every declared package export target in Node", async () => {
  const root = dirname(new URL(import.meta.url).pathname);
  const packagejson = JSON.parse(await readFile(resolve(root, "../package.json"), "utf8"));
  for (const target of Object.values(packagejson.exports)) {
    assert.equal(typeof target, "string");
    await import(pathToFileURL(resolve(root, "..", target)).href);
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
  assert.equal(packagejson.exports["./browser-playwright"], "./dist/browser/playwright.js");
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
  assert.equal(seen.has(resolve(root, "..", "dist/index.js")), true);
  assert.equal(seen.has(resolve(root, "..", "dist/extension/index.js")), true);
});

test("creates the expanded release matrix without vendor coupling", () => {
  const matrix = releaseartifactmatrix("1.8.14", { signing: "caller-owned" });
  assert.equal(matrix.entries.length, 11);
  assert.deepEqual(matrix.entries.find((entry) => entry.platform === "windows" && entry.architecture === "x86")?.files, ["saddle.browser.1.8.14.x86.exe", "saddle.browser.1.8.14.x86.msi"]);
  assert.deepEqual(matrix.entries.find((entry) => entry.surface === "android")?.files, ["saddle.apk.1.8.14.apk", "saddle.aab.1.8.14.aab"]);
  assert.equal(matrix.entries.find((entry) => entry.surface === "container")?.manifest, "manifest.container.1.8.14.json");
});
