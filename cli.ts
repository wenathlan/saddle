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

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv } from "node:process";
import { eventbus } from "./foundation.js";
import { localmemory, localstorage } from "./virtual.js";
import { engine, inprocess, scheduler } from "./execution.js";
import { mcpserver } from "./integration.js";
import { modecatalog } from "./modes.js";
import { creategrid, defaultplan, dockerrun, multiplex, planlint, plantoml, qemucommand, type plan } from "./index.js";

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
  if (["help", "--help", "-h"].includes(command)) { console.log("saddle <command>\n\ncommands\n  help\n  modes\n  plan [qemu|docker|toml]\n  runexample\n  mcp"); return; }
  if (command === "modes") { console.log(JSON.stringify(modecatalog(), null, 2)); return; }
  if (command === "plan") { await renderplan(args[1]); return; }
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

/* ════════════════════════════════════════════════════════════════════ */
/* Section 2: the plan renderer — the architect CLI absorbed from the e2ugh */
/* engine entry (index.ts); the former `e2ugh` bin folds into the single */
/* `saddle` bin at the 2.0.0 grand merge. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * Renders one machine plan (defaulting to defaultplan, overridden by the
 * optional vm.config.toml regex fields) preceded by the MTTG multiplex
 * header — the absorbed e2ugh engine CLI entry, byte-compatible with the
 * former `node ./index.ts` invocation through the single saddle bin.
 *
 * @param format the render format: qemu (default), docker or toml.
 */
async function renderplan(format = "qemu") {
  try {
    let candidate: plan = { ...defaultplan };
    try {
      const raw = await readFile("vm.config.toml", "utf8");
      const vcpus = /vcpus = (\d+)/.exec(raw)?.[1];
      const mem = /gib = (\d+)/.exec(raw)?.[1];
      const mttg = /virtual_threads = (\d+)/.exec(raw)?.[1];
      if (vcpus !== undefined) {
        candidate = { ...candidate, vcpus: Number(vcpus) };
      }
      if (mem !== undefined) {
        candidate = { ...candidate, memorygib: Number(mem) };
      }
      if (mttg !== undefined) {
        candidate = { ...candidate, mttgthreads: Number(mttg), mttg: true };
      }
    } catch {
      /* catcher: vm.config.toml is optional; defaults stay */
    }
    const grid = creategrid(undefined, candidate.mttgthreads);
    const header = `# multiplex ${multiplex(grid).toFixed(1)}x on ${grid.host} host threads\n`;
    const body =
      format === "docker"
        ? dockerrun(candidate)
        : format === "toml"
          ? plantoml(candidate)
          : qemucommand(candidate);
    process.stdout.write(`${header}${body}\n`);
    for (const note of planlint(candidate)) {
      process.stderr.write(`# ${note}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `planner failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

if (import.meta.url === `file://${argv[1]}`) main().catch((error) => { console.error(error); process.exitCode = 1; });
