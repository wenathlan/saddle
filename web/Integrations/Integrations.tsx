// Signal & Ledger: integrações como superfícies do mesmo engine, não produtos desconectados.
import { Apple, Bot, Box, Chrome, Container, Github, Smartphone, Terminal } from "lucide-react";
import PageShell from "@/PageShell";

const integrationGroups = [
  { label: "Package surfaces", items: [{ icon: Box, name: "npm package", body: "@wenathlan/saddle" }, { icon: Terminal, name: "CLI / binary", body: "one command, remote run" }, { icon: Container, name: "GitHub Container", body: "runner-ready image" }] },
  { label: "Client surfaces", items: [{ icon: Chrome, name: "CRX extension", body: "capture from the browser" }, { icon: Smartphone, name: "Android / iOS", body: "native or Capacitor" }, { icon: Apple, name: "Tauri desktop", body: "local shell, remote engine" }] },
  { label: "Bot surfaces", items: [{ icon: Github, name: "Forge adapters", body: "GitHub / GitLab / Forgejo" }, { icon: Bot, name: "n8n node", body: "workflow as trigger" }, { icon: Terminal, name: "Webhook server", body: "event in, run out" }] },
];

export default function Integrations() {
  return (
    <PageShell section="04 / 06" label="Integrations" title="Uma máquina. Muitos pontos de entrada." intro="A superfície muda para caber no fluxo do operador; o engine continua o mesmo, com storage, runner, eventos e resultados no centro.">
      <section className="content-section split-content"><div><p className="eyebrow">SURFACE AREA</p><h2 className="section-title">Não escolha entre package, app ou workflow. Encadeie.</h2></div><div className="prose-copy"><p>O Saddle pode ser importado, acionado, empacotado ou embutido. A arquitetura mantém uma separação útil: interfaces fazem a entrada e a observação; a cadeia remota faz o trabalho.</p><p>Esse é o detalhe que permite trocar a casca sem reescrever a máquina.</p></div></section>
      <section className="content-section integration-groups">{integrationGroups.map((group)=><div className="integration-group" key={group.label}><div className="content-section-heading"><p className="eyebrow">{group.label}</p><span className="mono-label">3 surfaces</span></div><div className="integration-grid">{group.items.map((item)=>{const Icon=item.icon;return <div className="integration-card" key={item.name}><Icon size={20} strokeWidth={1.5}/><strong>{item.name}</strong><span>{item.body}</span></div>})}</div></div>)}</section>
      <section className="content-section integration-quote"><p>“The same engine is sometimes each of the other three.”</p><span className="mono-label">SADDLE / PRINCIPLE 04</span></section>
    </PageShell>
  );
}
