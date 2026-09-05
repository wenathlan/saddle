/**
 * cli.ts — the saddle command-line entry point.
 *
 * This file is the v2.0.0 grand-merge consolidation of the former nested
 * folders of the repository (cli) into the single
 * root-level domain file of the e2ugh family standard: one optimized
 * TypeScript file per correlated domain, ordinal sections, JSDoc on every
 * block, intra-domain imports dissolved, cross-domain imports rewritten to
 * ./<domain>.js. Every capability of every source file is preserved here;
 * the pure re-export barrels (none in this domain) folded their surface into this file directly.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv } from "node:process";
import { eventbus } from "./foundation.js";
import { localmemory, localstorage } from "./virtual.js";
import { engine, inprocess, scheduler } from "./execution.js";
import { mcpserver } from "./integration.js";
import { modecatalog } from "./modes.js";

/* ════════════════════════════════════════════════════════════════════ */
/* Section 1: cli/main.ts — the saddle command-line entry point (the bin "saddle" resolves to dist/cli.js after the grand merge; the file is executable through the bin entry, not a shebang). */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * the cli keeps local execution explicit and leaves remote dispatch to adapters.
 */

/** Runs one CLI command and keeps external services behind adapters. */
export async function main(args = argv.slice(2)) {
  const command = args[0] ?? "help";
  /* Help stays short and lists only stable local commands. */
  if (["help", "--help", "-h"].includes(command)) { console.log("saddle <command>\n\ncommands\n  help\n  modes\n  runexample\n  mcp"); return; }
  if (command === "modes") { console.log(JSON.stringify(modecatalog(), null, 2)); return; }
  if (command === "runexample") {
    const root = await mkdtemp(join(tmpdir(), "saddlecli"));
    const events = eventbus();
    const run = engine({ storage: localstorage(root), memory: localmemory(), scheduler: scheduler([inprocess()]), events });
    const result = await run.run({ name: "cliexample", input: { hello: "saddle" } }, ({ job }) => ({ jobid: job.id, ok: true, message: "storage to working set to result" }));
    console.log(JSON.stringify({ jobid: result.job.id, artifact: result.artifact, events: events.all().length }, null, 2));
    return;
  }
  if (command === "mcp") { const server = mcpserver({ scrape: async (url) => ({ url, links: [] }) }); console.log(JSON.stringify({ tools: server.listtools() }, null, 2)); return; }
  throw new Error(`unknown command: ${command}`);
}

if (import.meta.url === `file://${argv[1]}`) main().catch((error) => { console.error(error); process.exitCode = 1; });
