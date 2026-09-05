/**
 * format.ts — the formatting gate used by the check pipeline.
 *
 * This file is the v2.0.0 grand-merge consolidation of the former nested
 * folders of the repository (format) into the single
 * root-level domain file of the e2ugh family standard: one optimized
 * TypeScript file per correlated domain, ordinal sections, JSDoc on every
 * block, intra-domain imports dissolved, cross-domain imports rewritten to
 * ./<domain>.js. Every capability of every source file is preserved here;
 * the pure re-export barrels (none in this domain) folded their surface into this file directly.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/* ════════════════════════════════════════════════════════════════════ */
/* Section 1: format/check.ts — format check validates the public root based JavaScript layout before release. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * format check validates the public root based JavaScript layout before release.
 */

/* the grand-merge layout: the public logic surface is the flat set of root
   domain TypeScript files; the formatting contract checks each of them. */
const domains = ["index", "foundation", "isolation", "virtual", "execution", "browser", "acquisition", "webscrape", "communication", "integration", "automation", "intelligence", "distribution", "modes", "operations", "cli", "server", "format", "alternatives", "compute", "media", "orchestrator", "performance", "quantum", "render", "scheduler", "security", "tiers", "virtualcpu", "virtualgpu", "virtualization", "virtualmemory"];

/** Finds domain files that do not follow the skill formatting contract. */
export async function formatissues(root = process.cwd()) {
  const issues = [];
  for (const domain of domains) {
    const file = join(root, `${domain}.ts`);
    let source;
    try { source = await readFile(file, "utf8"); } catch { issues.push(`${domain}.ts: missing domain file`); continue; }
    if (/[A-Z_-]/.test(domain)) issues.push(`${domain}.ts: invalid path format`);
    if (!source.includes("/**")) issues.push(`${domain}.ts: missing jsdoc`);
  }
  return issues;
}

/** Runs the check as a CLI and throws a short diagnostic on failure. */
export async function runformatcheck() { const issues = await formatissues(); if (issues.length) throw new Error(issues.join("\n")); return { ok: true, checked: domains.length }; }

async function javascriptfiles(directory) { let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; } const files = []; for (const entry of entries) { const file = join(directory, entry.name); if (entry.isDirectory()) files.push(...await javascriptfiles(file)); else if (entry.name.endsWith(".js")) files.push(file); } return files; }

if (import.meta.url === `file://${process.argv[1]}`) runformatcheck().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
