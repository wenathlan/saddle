// Real sandbox console: faithful absorption of console.html + console.js —
// the spec panel, the animated boot sequence, the interactive terminal, the
// bus event timeline, snapshot/stop and the api detection badge. when the
// self-hosted node answers, the sandbox is also created through
// /api/v1/sandboxes and commands run through the api exec endpoint;
// otherwise the same dispatcher runs locally in the browser.
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import PageShell from "@/PageShell";
import { apibase, apifetch, fetchhealth } from "../api";
import type { ExecResult, SandboxCreated, SandboxSpecPayload } from "../api";
import { bootSequence, createSandboxState, cpudata, dispatch, gpudata } from "../sandbox.ts";
import type { SandboxState } from "../sandbox.ts";
import ApiBadge from "./ApiBadge";
import EventsTimeline from "./EventsTimeline";
import type { SandboxEvent, SandboxEventKind } from "./EventsTimeline";
import SnapshotControls from "./SnapshotControls";
import SpecPanel from "./SpecPanel";
import type { SandboxSpecSelection } from "./SpecPanel";
import Terminal from "./Terminal";
import type { TerminalRow, TerminalState } from "./Terminal";

/** display cap for very large payloads such as cpuinfo at 192 vcpus. */
const displaycap = 120000;

/** initial spec selection mirroring the static page defaults. */
const initialspec: SandboxSpecSelection = {
  model: cpudata[0].model,
  quotamb: 16,
  vcpus: 8,
  ramgb: 32,
  gpu: gpudata[0].id,
  mig: "off",
};

/** the sleep used to animate the boot sequence line by line. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * the console page: wires the spec panel, terminal, events timeline and
 * lifecycle controls to the browser-pure engine (sandbox.ts) and, when
 * available, the self-hosted /api/v1 contract.
 */
export default function Console() {
  const rowseq = useRef(0);
  const eventseq = useRef(0);
  const engineref = useRef<SandboxState | null>(null);
  const apiref = useRef<string | null>(null);
  const [selection, setSelection] = useState<SandboxSpecSelection>(initialspec);
  const [rows, setRows] = useState<TerminalRow[]>([]);
  const [events, setEvents] = useState<SandboxEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [termstate, setTermstate] = useState<TerminalState>("halted");
  const [prompt, setPrompt] = useState("root@saddle:~#");
  const [apimode, setApimode] = useState(false);
  const [badgelabel, setBadgelabel] = useState("engine: local (no api)");

  /** api detection: probe the health endpoint once (1.5s budget). */
  useEffect(() => {
    let cancelled = false;
    const detect = async () => {
      const health = await fetchhealth(apibase(), 1500);
      if (cancelled) return;
      if (health !== null) {
        setApimode(true);
        setBadgelabel(`api connected (v${health.version}, uptime ${health.uptime}s)`);
      } else {
        setBadgelabel("engine: local (no api)");
      }
    };
    detect().catch(() => {
      if (!cancelled) setBadgelabel("engine: local (no api)");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** appends one text block as a row; truncates giant payloads for display. */
  const printrow = (text: string, cls: string) => {
    rowseq.current += 1;
    const id = rowseq.current;
    if (text.length > displaycap) {
      rowseq.current += 1;
      const truncid = rowseq.current;
      setRows((prev) => [
        ...prev,
        { id, text: text.slice(0, displaycap), cls },
        {
          id: truncid,
          text: `... output truncated for display (${text.length} bytes total)`,
          cls: "trunc",
        },
      ]);
    } else {
      setRows((prev) => [...prev, { id, text, cls }]);
    }
  };

  /** prepends one bus event; the timeline keeps at most 50 entries. */
  const logevent = (topic: string, detail: string, kind: SandboxEventKind) => {
    eventseq.current += 1;
    const now = new Date();
    const item: SandboxEvent = {
      id: eventseq.current,
      time: now.toTimeString().slice(0, 8),
      topic,
      detail,
      kind,
    };
    setEvents((prev) => [item, ...prev].slice(0, 50));
  };

  const onselectionchange = (patch: Partial<SandboxSpecSelection>) => {
    setSelection((prev) => ({ ...prev, ...patch }));
  };

  /** boots the sandbox: spec commit, api-backed creation, animated dmesg. */
  const bootsandbox = async () => {
    setBusy(true);
    setRunning(false);
    setRows([]);
    setTermstate("booting");

    const spec: SandboxSpecPayload = {
      model: selection.model,
      vcpus: selection.vcpus,
      ramgb: selection.ramgb,
      gpu: selection.gpu,
      mig: selection.mig,
      quotamb: selection.quotamb,
    };
    const state = createSandboxState(spec);
    engineref.current = state;
    setPrompt(`root@${state.hostname}:~#`);

    logevent(
      "vm:creating",
      `${spec.model} x${state.vcpus} vcpus, ${spec.ramgb} gb ram, ${spec.gpu}`,
      "lifecycle",
    );

    /* api-backed sandbox when the self-hosted server answers */
    if (apimode) {
      try {
        const response = await apifetch("/api/v1/sandboxes", {
          method: "POST",
          body: JSON.stringify(spec),
        });
        if (response.ok) {
          const created = (await response.json()) as SandboxCreated;
          apiref.current = created.id;
          logevent(
            "sandbox:created",
            `api sandbox ${created.id} state ${created.state}`,
            "lifecycle",
          );
        }
      } catch {
        apiref.current = null;
        logevent(
          "sandbox:create-failed",
          "api unreachable; falling back to the local engine",
          "lifecycle",
        );
      }
    }

    printrow(
      `saddle sandbox booting (${spec.model}, ${state.vcpus} vcpus, ${spec.ramgb} gb, ${spec.gpu})`,
      "boot",
    );
    const lines = bootSequence(spec.model, state.vcpus, spec.ramgb, spec.gpu);
    for (const bootline of lines) {
      printrow(bootline, "boot");
      await sleep(28 + Math.random() * 34);
    }
    printrow('ok: sandbox running. type "help" for the command list.', "ok");
    logevent("vm:created", `sandbox ${state.id} specs committed`, "lifecycle");
    logevent("vm:started", "firecracker microvm 125 ms bring-up complete", "lifecycle");

    setRunning(true);
    setTermstate("running");
    setBusy(false);
  };

  const onstart = () => {
    bootsandbox().catch(() => {
      printrow("boot failed unexpectedly; check the console log", "err");
      setBusy(false);
    });
  };

  /** executes one command: api exec first, local dispatcher as fallback. */
  const runcommand = async (rawcommand: string) => {
    printrow(`${prompt} ${rawcommand}`, "cmdline");

    if (rawcommand === "clear") {
      setRows([]);
      return;
    }

    let result: ExecResult | null = null;
    let source = "local";
    if (apiref.current !== null) {
      try {
        const response = await apifetch(`/api/v1/sandboxes/${apiref.current}/exec`, {
          method: "POST",
          body: JSON.stringify({ command: rawcommand }),
        });
        if (response.ok) {
          result = (await response.json()) as ExecResult;
          source = "api";
        }
      } catch {
        result = null;
      }
    }
    if (result === null) {
      result =
        engineref.current !== null
          ? dispatch(rawcommand, engineref.current)
          : { output: "the sandbox is not running", exitCode: 1 };
      source = "local";
    }
    if (result.output.length > 0) {
      printrow(result.output, result.exitCode === 0 ? "" : "err");
    }
    logevent("exec:completed", `"${rawcommand}" exit ${result.exitCode} via ${source}`, "exec");
  };

  /** snapshot: precopy stage 1 of 1, memory + disk. */
  const onsnapshot = () => {
    if (!running) return;
    const snapid = `snap-${Math.random().toString(16).slice(2, 10)}`;
    printrow(`snapshot ${snapid} created (memory + disk, precopy stage 1 of 1)`, "ok");
    logevent(
      "snapshot:created",
      `${snapid} for sandbox ${engineref.current?.id ?? "n/a"}`,
      "snapshot",
    );
  };

  /** teardown: local halt plus the api sandbox delete when connected. */
  const onstop = async () => {
    if (!running) return;
    setRunning(false);
    setTermstate("stopped");
    printrow("sandbox stopped; snapshot-less teardown complete.", "boot");
    logevent("vm:stopped", `sandbox ${engineref.current?.id ?? "n/a"} torn down`, "lifecycle");
    if (apiref.current !== null) {
      const id = apiref.current;
      try {
        await apifetch(`/api/v1/sandboxes/${id}`, { method: "DELETE" });
        logevent("vm:deleted", `api sandbox ${id} destroyed`, "lifecycle");
      } catch {
        logevent("vm:delete-failed", `api sandbox ${id} unreachable`, "lifecycle");
      }
      apiref.current = null;
    }
  };

  return (
    <PageShell
      section="06 / 07"
      label="Console"
      title="The sandbox runs here."
      intro="Pick the virtual hardware, boot the microvm and type: the same engine dispatcher answers locally in the browser and through the self-hosted node api. No account needed to run it; sign in to keep sandboxes."
    >
      <section className="content-section console-section">
        <div className="content-section-heading">
          <p className="eyebrow">LIVE SANDBOX / SPEC PANEL · TERMINAL · BUS EVENTS</p>
          <div className="console-heading-side">
            <Link href="/login" className="console-signin">
              sign in
            </Link>
            <ApiBadge apion={apimode} label={badgelabel} />
          </div>
        </div>
        <div className="sandbox-grid">
          <section className="sandbox-panel" aria-labelledby="specstitle">
            <h2 className="sandbox-panel-title" id="specstitle">
              sandbox specs
            </h2>
            <SpecPanel
              spec={selection}
              onChange={onselectionchange}
              disabled={busy || running}
            />
            <div className="sandbox-actions">
              <button
                className="button button-primary"
                type="button"
                onClick={onstart}
                disabled={busy || running}
                aria-label="start the virtual sandbox"
              >
                start sandbox
              </button>
              <SnapshotControls running={running} onsnapshot={onsnapshot} onstop={onstop} />
            </div>
          </section>
          <Terminal
            rows={rows}
            prompt={prompt}
            state={termstate}
            enabled={running}
            oncommand={runcommand}
          />
          <EventsTimeline events={events} />
        </div>
        <p className="console-note">self-hosted node api · no serverless functions</p>
      </section>
    </PageShell>
  );
}
