/**
 * the local example shows that the library can run without a remote service.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventbus, engine, inprocess, scheduler } from "../index.js";
import { localmemory } from "../virtual.js";
import { localstorage } from "../virtual.js";

const root = await mkdtemp(join(tmpdir(), "saddleexample"));
const events = eventbus();
const run = engine({ storage: localstorage(root), memory: localmemory(), scheduler: scheduler([inprocess()]), events });
const result = await run.run({ name: "localexample", input: { source: "example" }, outputkey: "results/example.json" }, ({ job }) => ({ jobid: job.id, ok: true }));
console.log({ jobid: result.job.id, artifact: result.artifact.key, eventcount: events.all().length });
