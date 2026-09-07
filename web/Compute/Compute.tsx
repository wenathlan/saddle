// Signal & Ledger: compute como mapa de workers, memória remota e estados de execução.
import { ArrowRight, Box, Cpu, Database, Gauge, HardDrive, MemoryStick } from "lucide-react";
import PageShell from "@/PageShell";

const providers = [
  { name: "GitHub Actions", spec: "4 vCPU / 16 GB", state: "primary" },
  { name: "Forgejo / Gitea", spec: "self-hosted", state: "unlimited" },
  { name: "Hugging Face", spec: "16 GB RAM", state: "suspend-aware" },
  { name: "Kaggle", spec: "T4 / P100", state: "scheduled" },
];

export default function Compute() {
  return (
    <PageShell section="03 / 06" label="Compute" title="A memória escorre entre lugares." intro="O trabalho pesado entra em um working set temporário; o resultado volta para storage persistente e a próxima sessão continua de onde parou.">
      <section className="content-section split-content"><div><p className="eyebrow">COMPUTATIONAL MEMORY</p><h2 className="section-title">O disco é a origem. O runner é o momento.</h2></div><div className="prose-copy"><p>Saddle não promete teletransporte. Ele organiza a distância: baixa dados, monta o working set, executa em tmpfs ou memória local, sincroniza resultados e encerra o runner.</p><p>O modelo deixa claro o que permanece, o que é processo e quando uma cadeia de providers deve assumir o próximo trabalho.</p></div></section>
      <section className="content-section"><div className="content-section-heading"><p className="eyebrow">MEMORY BRIDGE / STATES</p><span className="mono-label">process ⇄ keep</span></div><div className="compute-flow">{[{icon:Database,title:"Persist",body:"repos / buckets",tone:"paper"},{icon:HardDrive,title:"Stage",body:"artifact → tmpfs",tone:"blue"},{icon:Cpu,title:"Process",body:"runner active",tone:"ember"},{icon:MemoryStick,title:"Sync",body:"RAM → storage",tone:"sage"}].map((item,index)=>{const Icon=item.icon;return <div className="compute-step-wrap" key={item.title}><div className={`compute-step tone-${item.tone}`}><Icon size={21}/><span className="step-index">0{index+1}</span><strong>{item.title}</strong><small>{item.body}</small></div>{index<3&&<ArrowRight className="compute-arrow" size={17}/>}</div>})}</div></section>
      <section className="content-section"><div className="content-section-heading"><p className="eyebrow">FREE RUNNER FARM / PRIORITY ORDER</p><span className="mono-label">first 204 accepted</span></div><div className="provider-table">{providers.map((provider,index)=><div className="provider-table-row" key={provider.name}><span className="provider-table-index">0{index+1}</span><strong>{provider.name}</strong><span>{provider.spec}</span><span className={`provider-state ${provider.state}`}>{provider.state}</span><Gauge size={16}/></div>)}</div></section>
      <section className="content-section note-band"><Box size={21}/><div><p className="eyebrow">OPERATING RULE</p><p>O farm não faz round-robin cego. Ele quebra no primeiro runner livre e mantém a cadeia legível para o operador.</p></div></section>
    </PageShell>
  );
}
