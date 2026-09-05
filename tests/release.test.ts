/**
 * release asset tests prove deterministic metadata without publishing or external credentials.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createassets } from "../distribution.js";
import { retentionplan } from "../distribution.js";
import { verifyassets } from "../distribution.js";
import { evaluateevidence, evidencefromverification } from "../distribution.js";

test("creates reproducible checksums, SBOM and provenance subjects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saddle-release-"));
  try {
    const artifact = join(directory, "saddle.tgz");
    const output = join(directory, "assets");
    await writeFile(artifact, "artifact payload\n");
    const packagefile = join(directory, "package.json");
    const lockfile = join(directory, "package-lock.json");
    await writeFile(packagefile, JSON.stringify({ name: "@wenathlan/example", version: "1.0.0" }));
    await writeFile(lockfile, JSON.stringify({ packages: { "": { dependencies: { exampledep: "1.2.3" }, devDependencies: { testdep: "2.0.0" } }, "node_modules/exampledep": { version: "1.2.3" }, "node_modules/testdep": { version: "2.0.0" } } }));
    const first = await createassets({ packagefile, lockfile, output, artifactroot: directory, artifacts: [artifact], version: "1.0.0", surface: "library", buildtype: "test-build", builder: "test-builder" });
    const checksums = await readFile(first.files.checksums, "utf8");
    const sbom = JSON.parse(await readFile(first.files.sbom, "utf8"));
    const provenance = JSON.parse(await readFile(first.files.provenance, "utf8"));
    assert.match(checksums, /saddle\.tgz\s*$/);
    assert.match(first.files.checksums, /sha256\.library\.1\.0\.0$/);
    assert.match(first.files.manifest, /manifest\.library\.1\.0\.0\.json$/);
    assert.equal(sbom.bomFormat, "CycloneDX");
    assert.deepEqual(sbom.components.map((component) => component.name), ["exampledep", "testdep"]);
    assert.equal(provenance.subject[0].digest.sha256.length, 64);
    const second = await createassets({ packagefile, lockfile, output, artifactroot: directory, artifacts: [artifact], version: "1.0.0", surface: "library", buildtype: "test-build", builder: "test-builder" });
    assert.equal(await readFile(second.files.checksums, "utf8"), checksums);
    assert.equal(await readFile(second.files.sbom, "utf8"), await readFile(first.files.sbom, "utf8"));
    assert.equal(await readFile(second.files.provenance, "utf8"), await readFile(first.files.provenance, "utf8"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects helper binaries and underscore-based public names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saddle-release-invalid-"));
  try {
    const packagefile = join(directory, "package.json");
    const lockfile = join(directory, "package-lock.json");
    await writeFile(packagefile, JSON.stringify({ name: "@wenathlan/example", version: "1.0.0" }));
    await writeFile(lockfile, JSON.stringify({ packages: { "": {} } }));
    const helper = join(directory, "build_script_build.exe");
    await writeFile(helper, "helper\n");
    await assert.rejects(createassets({ packagefile, lockfile, output: join(directory, "assets"), artifactroot: directory, artifacts: [helper], version: "1.0.0", surface: "desktop" }), /forbidden release artifact filename/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("verifies release checksums and explicit signing status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saddle-release-verify-"));
  try {
    const artifact = join(directory, "saddle.browser.1.8.12.x64.exe");
    const output = join(directory, "assets");
    const packagefile = join(directory, "package.json");
    const lockfile = join(directory, "package-lock.json");
    await writeFile(artifact, "verified artifact\n");
    await writeFile(packagefile, JSON.stringify({ name: "@wenathlan/example", version: "1.8.12" }));
    await writeFile(lockfile, JSON.stringify({ packages: { "": {} } }));
    const created = await createassets({ packagefile, lockfile, output, artifactroot: directory, artifacts: [artifact], version: "1.8.12", surface: "desktop.windows.x64", signing: "unsigned" });
    const result = await verifyassets({ checksums: created.files.checksums, manifest: created.files.manifest, artifactroot: directory, version: "1.8.12" });
    assert.equal(result.valid, true);
    assert.equal(result.signing, "unsigned");
    await writeFile(artifact, "tampered artifact\n");
    await assert.rejects(verifyassets({ checksums: created.files.checksums, manifest: created.files.manifest, artifactroot: directory, version: "1.8.12" }), /checksum mismatch/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("maps verified local checksums into policy-evaluable release evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saddle-release-evidence-"));
  try {
    const artifact = join(directory, "saddle.browser.1.8.16.x64.exe");
    const output = join(directory, "assets");
    const packagefile = join(directory, "package.json");
    const lockfile = join(directory, "package-lock.json");
    await writeFile(artifact, "evidence payload\n");
    await writeFile(packagefile, JSON.stringify({ name: "@wenathlan/example", version: "1.8.16" }));
    await writeFile(lockfile, JSON.stringify({ packages: { "": {} } }));
    const created = await createassets({ packagefile, lockfile, output, artifactroot: directory, artifacts: [artifact], version: "1.8.16", surface: "desktop.windows.x64", signing: "unsigned" });
    const verification = await verifyassets({ checksums: created.files.checksums, manifest: created.files.manifest, artifactroot: directory, version: "1.8.16" });
    const envelope = evidencefromverification({ verification, producer: "local-release-test", workflow: "verify.yml", verifiedat: 1 });
    assert.equal(envelope.signingstatus, "unsigned");
    assert.equal(envelope.evidence[0].status, "checked");
    assert.equal(envelope.evidence[0].metadata.artifact, "saddle.browser.1.8.16.x64.exe");
    const evaluation = evaluateevidence({ subjectdigest: verification.files[0].digest, evidence: envelope.evidence, policy: { requiredkinds: ["checksum"], allowedstatuses: ["checked"], expectedproducer: { checksum: "local-release-test" }, expectedworkflow: { checksum: "verify.yml" } } });
    assert.equal(evaluation.decision, "accepted");
    assert.throws(() => evidencefromverification({ verification: { ...verification, valid: false } }), /must be valid/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("records deterministic retention metadata without deleting caller artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saddle-release-retention-"));
  try {
    const artifact = join(directory, "saddle.browser.1.8.14.x64.exe");
    const output = join(directory, "assets");
    const packagefile = join(directory, "package.json");
    const lockfile = join(directory, "package-lock.json");
    await writeFile(artifact, "retained artifact\n");
    await writeFile(packagefile, JSON.stringify({ name: "@wenathlan/example", version: "1.8.14" }));
    await writeFile(lockfile, JSON.stringify({ packages: { "": {} } }));
    const created = await createassets({ packagefile, lockfile, output, artifactroot: directory, artifacts: [artifact], version: "1.8.14", surface: "desktop.windows.x64", retention: { maxcount: 1, evaluatedat: 100 } });
    const manifest = JSON.parse(await readFile(created.files.manifest, "utf8"));
    assert.equal(manifest.retention.maxcount, 1);
    assert.equal(manifest.retentionplan[0].action, "keep");
    const plan = retentionplan([{ name: "old", bytes: 5, updatedat: 1 }, { name: "new", bytes: 5, updatedat: 2 }], { maxcount: 1, evaluatedat: 100 });
    assert.deepEqual(plan.decisions.map((decision) => [decision.name, decision.action]), [["new", "keep"], ["old", "prune"]]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
