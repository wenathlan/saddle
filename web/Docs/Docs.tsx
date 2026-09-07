// Signal & Ledger: documentação como índice de operações, com caminhos curtos e contexto preservado.
import { ArrowUpRight, BookOpen, Braces, FileCode2, Flag, GitCommitHorizontal, PlayCircle } from "lucide-react";
import PageShell from "@/PageShell";

const docs = [
  { icon: BookOpen, index: "00", title: "Start with the thesis", body: "Storage, memory and the usage flag.", meta: "FOUNDATION" },
  { icon: Braces, index: "01", title: "Session JSON", body: "The reproducible artifact behind a browser run.", meta: "AGENT BROWSER" },
  { icon: GitCommitHorizontal, index: "02", title: "Repo-as-CPU", body: "Dispatch, runners, Pages and the shared surface.", meta: "ENGINE" },
  { icon: FileCode2, index: "03", title: "Provider chain", body: "First free runner wins, with limits exposed.", meta: "ENGINE" },
  { icon: Flag, index: "04", title: "Build gates", body: "Planning before platform implementation.", meta: "PRODUCTIZATION" },
];

export default function Docs() {
  return (
    <PageShell section="05 / 06" label="Docs" title="Notas para operar a cadeia." intro="Uma documentação progressiva: primeiro a tese, depois o engine, depois as superfícies que tornam a ideia utilizável.">
      <section className="content-section split-content"><div><p className="eyebrow">PROGRESSIVE ARC</p><h2 className="section-title">Leia como um sistema é construído.</h2></div><div className="prose-copy"><p>O README do Saddle funciona como fonte de verdade. Esta superfície organiza os conceitos em passos menores, para que a arquitetura possa ser entendida antes de ser acionada.</p><p>Os guias abaixo são a primeira camada editorial e apontam para as próximas páginas de implementação.</p></div></section>
      <section className="content-section docs-list"><div className="content-section-heading"><p className="eyebrow">INDEX / FOUNDATION → PRODUCTIZATION</p><span className="mono-label">5 notes</span></div>{docs.map((doc)=>{const Icon=doc.icon;return <a className="doc-row" href="#" key={doc.title} onClick={(event)=>event.preventDefault()}><span className="doc-index">{doc.index}</span><Icon size={20} strokeWidth={1.5}/><div className="doc-copy"><span>{doc.meta}</span><strong>{doc.title}</strong><p>{doc.body}</p></div><ArrowUpRight size={17}/></a>})}</section>
      <section className="content-section docs-cta"><PlayCircle size={22}/><div><p className="eyebrow">NEXT / BUILD GATE</p><h3>Planning first. Platform next.</h3><p>O caminho de implementação começa quando a cadeia estiver suficientemente clara para ser operada.</p></div><a href="https://github.com/wenathlan/saddle" target="_blank" rel="noreferrer" className="button button-dark">Open repository <ArrowUpRight size={15}/></a></section>
    </PageShell>
  );
}
