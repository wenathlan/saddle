// Signal & Ledger: o console do engine (a superfície e2ugh que entrou no merge) como rota do app.
import { ArrowUpRight, Cpu, Database, KeyRound, Radar, Terminal } from "lucide-react";
import PageShell from "@/components/PageShell";

const consoleGroups = [
  { label: "Console de engine", items: [{ icon: Terminal, name: "console.html", body: "terminal do engine: catálogos, plan, snapshots, bus de eventos" }, { icon: Cpu, name: "sandbox.js", body: "dispatcher browser-puro — o mesmo contrato local e via API" }] },
  { label: "API auto-hospedada", items: [{ icon: Database, name: "server.js + db.js", body: "/api/v1: sandboxes, specs, arquivos, eventos — zero dependências" }, { icon: Radar, name: "mesh.js", body: "comunicação assinada clone → main com anti-replay" }] },
  { label: "Superfície de conta", items: [{ icon: KeyRound, name: "login / register", body: "contas locais com scrypt + sessões opacas; fallback estático" }, { icon: ArrowUpRight, name: "dashboard.html", body: "visão de usuário e admin: sandboxes, nós, auditoria" }] },
];

export default function Console() {
  return (
    <PageShell section="06 / 07" label="Console" title="O engine tem terminal." intro="A superfície do console virtual-hardware entrou no merge: páginas estáticas na raiz de web/, o mesmo dispatcher do engine no navegador e uma API node sem dependências quando você auto-hospeda.">
      <section className="content-section split-content"><div><p className="eyebrow">MERGED SURFACE</p><h2 className="section-title">O console vive na raiz de web/.</h2></div><div className="prose-copy"><p>O deploy auto-hospedado serve o console em <code>/</code> com <code>npm run web</code> (node web/server.js): terminal, login, registro e dashboard com a API <code>/api/v1</code> ao lado. O deploy estático (Netlify, Vercel, clones) entrega as mesmas páginas com o fallback localauth — nenhuma função serverless.</p><p>Esta rota documenta e conecta; o terminal real é a página console.html servida pelo node ou pelo edge estático.</p></div></section>
      <section className="content-section integration-groups">{consoleGroups.map((group)=><div className="integration-group" key={group.label}><div className="content-section-heading"><p className="eyebrow">{group.label}</p><span className="mono-label">web root</span></div><div className="integration-grid">{group.items.map((item)=>{const Icon=item.icon;return <div className="integration-card" key={item.name}><Icon size={20} strokeWidth={1.5}/><strong>{item.name}</strong><span>{item.body}</span></div>})}</div></div>)}</section>
      <section className="content-section integration-quote"><p>“O mesmo dispatcher roda no navegador e atrás da API — o console é o engine visto de fora.”</p><span className="mono-label">SADDLE / PRINCIPLE 07</span></section>
    </PageShell>
  );
}
