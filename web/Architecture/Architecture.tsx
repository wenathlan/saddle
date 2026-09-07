// Signal & Ledger: arquitetura em camadas, com a cadeia como narrativa principal.
import { ArrowUpRight, Box, Cloud, Cpu, Database, GitBranch, Globe2, HardDrive, ShieldCheck } from "lucide-react";
import PageShell from "@/PageShell";
import RuntimeDiagram from "@/RuntimeDiagram";
import { assetpath } from "@/paths";

const runtimeImage = assetpath("assets/saddle-runtime-map.webp");

export default function Architecture() {
  return (
    <PageShell section="01 / 06" label="Architecture" title="A máquina é a cadeia." intro="Saddle trata repositório, CI, páginas e buckets como partes de uma mesma máquina publicável — com cada limite exposto." image={runtimeImage} imageAlt="Mapa visual de uma cadeia de execução distribuída">
      <section className="content-section split-content"><div><p className="eyebrow">THE OPERATING MODEL</p><h2 className="section-title">Everything is a file until the flag says otherwise.</h2></div><div className="prose-copy"><p>Um repo guarda estado persistente. Um runner assume o papel de processador. Pages expõe o resultado como barramento e CDN. A arquitetura não tenta apagar as fronteiras entre esses lugares; ela transforma as fronteiras em uma API operacional.</p><p>O resultado é uma VM que pode ser publicada como pacote, acionada por workflow e reidratada a partir de artefatos.</p></div></section>
      <section className="content-section"><div className="content-section-heading"><p className="eyebrow">LAYER MAP / 04 LAYERS</p><span className="mono-label">PATH /repo → /runner → /pages</span></div><div className="layer-stack">
        {[{icon: GitBranch, name:"Repository", sub:"persistent state", body:"docs/results/ e artefatos versionados que sobrevivem ao ciclo de execução."},{icon: Cpu, name:"CI runner", sub:"virtual processor", body:"workflow_dispatch e repository_dispatch transformam o forge em função."},{icon: Database, name:"Memory bridge", sub:"storage as working set", body:"Buckets são montados como VHD/FUSE ou sincronizados para tmpfs; VRAM continua sendo VRAM."},{icon: Globe2, name:"Pages / CDN", sub:"shared surface", body:"A superfície estática observa, dispara e entrega resultados sem morar na máquina local."}].map((layer,index)=>{const Icon=layer.icon;return <div className="layer-row" key={layer.name}><span className="layer-index">0{index+1}</span><Icon size={20} strokeWidth={1.5}/><div className="layer-name"><strong>{layer.name}</strong><span>{layer.sub}</span></div><p>{layer.body}</p><ArrowUpRight size={16}/></div>})}
      </div></section>
      <section className="content-section"><div className="content-section-heading"><p className="eyebrow">PROVIDER CHAIN / FIRST FREE RUNNER WINS</p><span className="mono-label">fallback / explicit</span></div><div className="provider-grid">{["oracle-cloud","github-actions","huggingface","gitlab-ci","kaggle"].map((name,index)=><div className={`provider-cell ${index===0?"is-active":""}`} key={name}><span className="provider-index">0{index+1}</span><strong>{name}</strong><small>{index===0?"preferred":"fallback"}</small></div>)}</div></section>
      <section className="content-section architecture-note"><ShieldCheck size={21}/><div><p className="eyebrow">PHYSICAL LIMIT / DO NOT HIDE</p><p>Storage remota não é VRAM. A ponte é válida como VHD, cache ou working set; a largura de banda física continua governando o sistema.</p></div></section>
    </PageShell>
  );
}
