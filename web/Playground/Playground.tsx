// Signal & Ledger: playground como ledger de planos internos, nunca como console que executa bytes.
import { Activity, ArrowRight, Ban, Blocks, Braces, Database, FileWarning, Network, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { internalapi } from "@saddle/isolation";
import PageShell from "@/PageShell";

const fixture = Object.freeze({ id: "fixture.binary.001", effect: "binary-execution", target: "remote", source: "8c3d2e7b6a5f4c1d0e9b8a7f6c5d4e3b2a1908172635445566778899aabbccdd", budget: { maxbytes: 65536, maxmilliseconds: 250 } });

const boundaries = [
  { index: "01", name: "Gateway", detail: "assigns a request identity", icon: Braces },
  { index: "02", name: "Plan", detail: "normalizes intent and budget", icon: Blocks },
  { index: "03", name: "Policy", detail: "requires explicit agreement", icon: ShieldCheck },
  { index: "04", name: "Materialize", detail: "describes, never allocates", icon: Database },
  { index: "05", name: "Execute", detail: "delegates or denies", icon: Activity },
  { index: "06", name: "Evidence", detail: "records an honest receipt", icon: FileWarning },
];

function fixtureenvelope(boundary: string, configuration = {}) {
  if (boundary === "planning") return { boundary, requestid: "web.fixture.plan", payload: fixture };
  if (boundary === "policy" || boundary === "execution") return { boundary, requestid: `web.fixture.${boundary}`, payload: { request: fixture, configuration } };
  return { boundary, requestid: `web.fixture.${boundary}`, payload: {} };
}

export default function Playground() {
  const [mode, setMode] = useState<"default" | "delegated">("default");
  const configuration = useMemo(() => mode === "delegated" ? { policy: { alloweffects: ["binary-execution"], allowtargets: ["remote"] }, approval: { effects: ["binary-execution"], targets: ["remote"] }, adapter: { owner: "operator", capabilities: ["binary-execution"] } } : {}, [mode]);
  const projection = useMemo(() => internalapi().handle(fixtureenvelope("execution", configuration)), [configuration]);
  const handoff = projection.data.handoff;

  return (
    <PageShell section="07 / 07" label="Internal API Playground" title="Map the request. Do not run it." intro="This is a single-site projection of the former multi-site model. The boundaries are internal API contracts: they show what would be required, but they do not start a process, read a file, reach a provider, or spend a quota.">
      <section className="content-section split-content"><div><p className="eyebrow">UNIFIED WEB / SAFE FIXTURE</p><h2 className="section-title">One site.<br /><span>Six boundaries.</span></h2></div><div className="prose-copy"><p>The playground uses a fixed binary descriptor. It does not accept uploads or arbitrary code, and it does not instantiate Wasm, a worker, a container, a browser, a database, or a remote session.</p><p>“Internal API” means typed request and response envelopes in the same application. It is not a hidden endpoint, a second site, or a remote machine.</p></div></section>

      <section className="content-section"><div className="content-section-heading"><p className="eyebrow">INTERNAL BOUNDARY MAP</p><span className="mono-label">pure / serializable / no transport</span></div><div className="playground-boundaries">{boundaries.map(({ index, name, detail, icon: Icon }) => <article className="playground-boundary" key={name}><span>{index}</span><Icon size={18}/><strong>{name}</strong><small>{detail}</small></article>)}</div></section>

      <section className="content-section playground-layout"><div className="playground-console"><div className="console-head"><span><Activity size={14}/> INTERNAL API PROJECTION</span><span className={handoff.state === "execution-disabled" ? "console-denied" : "console-pass"}>{handoff.state === "execution-disabled" ? <Ban size={13}/> : <ShieldCheck size={13}/>} {handoff.code}</span></div><div className="playground-console-body"><div className="playground-row"><span>request</span><b>{fixture.id}</b></div><div className="playground-row"><span>effect</span><b>{fixture.effect}</b></div><div className="playground-row"><span>target</span><b>{fixture.target}</b></div><div className="playground-row"><span>outcome</span><b>{handoff.state}</b></div><div className="playground-row"><span>effects</span><b>{JSON.stringify(projection.effects)}</b></div><pre>{JSON.stringify(handoff, null, 2)}</pre></div><div className="console-footer"><span>fixture only</span><span>no adapter invocation</span></div></div><aside className="playground-controls"><p className="eyebrow">POLICY SWITCH</p><h3>Show the difference between denial and delegation.</h3><p>The second state still does not execute. It only produces a caller-owned handoff that a separately configured adapter could evaluate later.</p><div className="playground-actions"><button className={mode === "default" ? "button button-primary" : "button"} type="button" onClick={() => setMode("default")}>Project default denial</button><button className={mode === "delegated" ? "button button-dark" : "button"} type="button" onClick={() => setMode("delegated")}>Project optional handoff <ArrowRight size={14}/></button></div></aside></section>

      <section className="content-section note-band"><Network size={21}/><div><p className="eyebrow">RESOURCE POSTURE</p><p>The static interface uses only ordinary UI rendering. It deliberately performs no binary work and has no network, persistence, browser, host-bridge, provider, or background-job capability. Any operational adapter must be supplied and authorized by its operator.</p></div></section>
    </PageShell>
  );
}
