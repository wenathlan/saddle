/**
 * the engine coordinates job intent, working memory, runner execution, and commit.
 */
import { aserror } from "../core/errors.js";
import { eventbus } from "../core/events.js";
import { idfactory, systemclock } from "../core/ids.js";
import { createjob } from "../core/jobs.js";

export function engine(options) {
  if (!options?.storage || !options?.memory || !options?.scheduler) throw new TypeError("engine requires storage memory and scheduler");
  const events = options.events ?? eventbus();
  const ids = options.ids ?? idfactory();
  const clock = options.clock ?? systemclock();
  async function emit(job, type, data) { events.emit({ id: ids.next("event"), type, jobid: job.id, at: clock.now(), data }); }
  return {
    events,
    async run(spec, handler) {
      const job = createjob(spec, ids, clock);
      await emit(job, "jobqueued", { name: job.name });
      let set;
      let provider;
      try {
        job.status = "preparing";
        await emit(job, "jobpreparing", { status: job.status });
        provider = await options.scheduler.select(job);
        await emit(job, "runnerselected", { runnerid: provider.descriptor().id });
        set = await options.memory.prepare(job);
        job.status = "running";
        await emit(job, "jobrunning", { status: job.status, location: set.location });
        const output = await provider.execute({ job, workingset: set, signal: new AbortController().signal }, handler);
        const encoded = encodeoutput(output);
        job.status = "syncing";
        await emit(job, "jobsyncing", { status: job.status, bytes: encoded.bytes.byteLength });
        const sync = await options.memory.sync(set, encoded.bytes);
        const artifact = await options.storage.put({ key: spec.outputkey ?? `results/${job.id}${encoded.extension}`, data: encoded.bytes, contenttype: encoded.contenttype, metadata: { jobid: job.id, runnerid: provider.descriptor().id } });
        await emit(job, "storagecommitted", { key: artifact.key, sha256: artifact.sha256 });
        job.status = "completed";
        await emit(job, "jobcompleted", { status: job.status, artifactkey: artifact.key });
        return { job, output, runnerid: provider.descriptor().id, artifact, sync };
      } catch (error) {
        job.status = "failed";
        const failure = aserror(error, job.id);
        await emit(job, "jobfailed", { code: failure.code, retryable: failure.retryable, message: failure.message });
        throw failure;
      } finally {
        if (set) await options.memory.cleanup(set);
      }
    }
  };
}

function encodeoutput(output) {
  if (output instanceof Uint8Array) return { bytes: output, contenttype: "application/octet-stream", extension: ".bin" };
  if (typeof output === "string") return { bytes: new TextEncoder().encode(output), contenttype: "text/plain;charset=utf-8", extension: ".txt" };
  return { bytes: new TextEncoder().encode(JSON.stringify(output)), contenttype: "application/json", extension: ".json" };
}
