// Signal & Ledger: agent browser como trilha de eventos, evidência e replay determinístico.
import { Activity, Camera, CheckCircle2, MousePointer2, Play, RotateCcw, ScrollText, Terminal } from "lucide-react";
import PageShell from "@/PageShell";
import { assetpath } from "@/paths";

const browserImage = assetpath("assets/saddle-browser-trace.webp");

export default function AgentBrowser() {
  return (
    <PageShell section="02 / 06" label="Agent Browser" title="Movimento vira evidência." intro="O browser agent captura uma sessão como dados: movimento, click, scroll, key e a intenção de reproduzir tudo depois." image={browserImage} imageAlt="Traçado de cursor e evidências de uma sessão de browser">
      <section className="content-section split-content"><div><p className="eyebrow">CAPTURE / REPLAY</p><h2 className="section-title">A sessão é um artefato, não uma caixa-preta.</h2></div><div className="prose-copy"><p>Brave capture, movement replay e session recording ocupam a mesma camada. O evento é armazenado com tempo relativo, coordenadas em CSS px, alvo e seed. O replay reexecuta a sequência em velocidade configurável.</p><p>Para o operador, isso significa uma trilha auditável: cada clique pode apontar para screenshot, token ou vídeo de evidência.</p></div></section>
      <section className="content-section browser-grid"><div className="session-console"><div className="console-head"><span><Terminal size={14}/> SESSION / sess_01J9XEXAMPLE</span><span className="console-pass"><CheckCircle2 size={14}/> PASSED</span></div><div className="console-rows">{[{icon:MousePointer2,label:"move",value:"x 312 / y 480",time:"00:00:12.4"},{icon:MousePointer2,label:"click",value:"#checkbox",time:"00:03:40.1"},{icon:ScrollText,label:"scroll",value:"dy -120 / settle",time:"00:05:40.0"},{icon:Activity,label:"metrics",value:"1284 events / 201s",time:"00:06:12.0"}].map((event)=>{const Icon=event.icon;return <div className="console-row" key={event.label}><Icon size={16}/><span className="console-time">{event.time}</span><strong>{event.label}</strong><span>{event.value}</span></div>})}</div><div className="console-footer"><span>seed / session-42</span><span>browser / brave</span></div></div><div className="browser-principles"><div className="principle-card"><Camera size={19}/><div><strong>DOM + vision</strong><span>Hybrid capture is the baseline.</span></div></div><div className="principle-card"><RotateCcw size={19}/><div><strong>Deterministic replay</strong><span>Same events, configurable speed.</span></div></div><div className="principle-card"><Play size={19}/><div><strong>Evidence first</strong><span>Screenshot, token, video.</span></div></div></div></section>
      <section className="content-section"><div className="content-section-heading"><p className="eyebrow">SESSION JSON / V1</p><span className="mono-label">docs/logs/&lt;session&gt;.json</span></div><pre className="code-block"><code>{`{\n  "session": { "id": "sess_...", "status": "passed" },\n  "events": [ "move", "click", "scroll", "key" ],\n  "metrics": { "eventCount": 1284, "durationMs": 201000 }\n}`}</code></pre></section>
    </PageShell>
  );
}
