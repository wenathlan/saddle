// Signal & Ledger: o formulário de criação absorvido do dashboard.js —
// catálogos do engine (sandbox.ts) com fallback estático, spec postada na
// api ou materializada no engine local (modo estático).
import { useState } from "react";
import { createSandboxState, cpudata, gpudata } from "../sandbox.ts";
import { apiresult, errormessage, fallbackcpus, fallbackgpus, readlocalsandboxes, writelocalsandboxes } from "./lib";

type CreateSandboxFormProps = {
  /** "api" posts /api/v1/sandboxes; "local" drives the browser engine shelf. */
  mode: "api" | "local";
  /** fires after a successful creation so the list reloads. */
  oncreated: () => void;
  /** the refresh action beside the submit button. */
  onrefresh: () => void;
};

/** the spec fields of one creation request (model from the reviewed catalog). */
function catalogs() {
  const cpumodels = Array.isArray(cpudata) && cpudata.length > 0
    ? cpudata.map((cpu) => cpu.model)
    : fallbackcpus;
  const gpuids = Array.isArray(gpudata) && gpudata.length > 0
    ? gpudata.map((gpu) => gpu.id)
    : fallbackgpus;
  return { cpumodels, gpuids };
}

export default function CreateSandboxForm({ mode, oncreated, onrefresh }: CreateSandboxFormProps) {
  const { cpumodels, gpuids } = catalogs();
  const [model, setmodel] = useState(cpumodels[0] ?? fallbackcpus[0]);
  const [vcpus, setvcpus] = useState(8);
  const [ramgb, setramgb] = useState(32);
  const [gpu, setgpu] = useState(gpuids[0] ?? fallbackgpus[0]);
  const [mig, setmig] = useState("off");
  const [busy, setbusy] = useState(false);
  const [error, seterror] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    seterror("");
    const spec = { model, vcpus: Number(vcpus) || 8, ramgb: Number(ramgb) || 32, gpu, mig };
    if (mode === "local") {
      /* the browser-pure engine port drives the shelf: the same
       * createSandboxState the console runs, no server involved. */
      const state = createSandboxState(spec);
      const list = readlocalsandboxes();
      list.unshift({
        id: state.id,
        spec: {
          model: state.model,
          vcpus: state.vcpus,
          ramgb: state.ramgb,
          gpu: state.gpu,
          mig: state.mig,
        },
        createdat: new Date().toISOString(),
        state: "running",
      });
      writelocalsandboxes(list);
      oncreated();
      return;
    }
    setbusy(true);
    try {
      const result = await apiresult("/api/v1/sandboxes", {
        method: "POST",
        body: JSON.stringify(spec),
      });
      if (result.ok) {
        oncreated();
      } else {
        seterror(errormessage(result, `creation failed with status ${result.status}.`));
      }
    } catch {
      seterror("the api is unreachable; the sandbox was not created.");
    }
    setbusy(false);
  }

  return (
    <form noValidate aria-label="create a new sandbox" onSubmit={submit}>
      <div className="dash-formrow">
        <div className="dash-field">
          <label htmlFor="newmodel">cpu model</label>
          <select
            id="newmodel"
            aria-label="virtual cpu model"
            value={model}
            onChange={(event) => setmodel(event.target.value)}
          >
            {cpumodels.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </div>
        <div className="dash-field">
          <label htmlFor="newvcpus">vcpus</label>
          <input
            type="number"
            id="newvcpus"
            min={1}
            max={192}
            value={vcpus}
            aria-label="virtual cpu count"
            onChange={(event) => setvcpus(Number(event.target.value))}
          />
        </div>
        <div className="dash-field">
          <label htmlFor="newram">ram (gb)</label>
          <input
            type="number"
            id="newram"
            min={1}
            max={1024}
            value={ramgb}
            aria-label="virtual memory in gigabytes"
            onChange={(event) => setramgb(Number(event.target.value))}
          />
        </div>
        <div className="dash-field">
          <label htmlFor="newgpu">gpu</label>
          <select
            id="newgpu"
            aria-label="virtual gpu model"
            value={gpu}
            onChange={(event) => setgpu(event.target.value)}
          >
            {gpuids.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </div>
        <div className="dash-field">
          <label htmlFor="newmig">mig profile</label>
          <select
            id="newmig"
            aria-label="gpu mig slicing profile"
            value={mig}
            onChange={(event) => setmig(event.target.value)}
          >
            <option value="off">off</option>
            <option value="1g.24gb">1g.24gb</option>
            <option value="2g.48gb">2g.48gb</option>
            <option value="4g.96gb">4g.96gb</option>
          </select>
        </div>
      </div>
      {error !== "" && (
        <p className="dash-panelerror" role="alert">
          {error}
        </p>
      )}
      <div className="dash-actions">
        <button
          type="submit"
          className="primary"
          disabled={busy}
          aria-label="create a new sandbox"
        >
          create sandbox
        </button>
        <button type="button" aria-label="reload the sandbox list" onClick={onrefresh}>
          refresh
        </button>
      </div>
    </form>
  );
}
