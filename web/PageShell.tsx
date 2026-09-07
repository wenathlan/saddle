// Signal & Ledger: moldura comum para páginas internas, preservando contexto e ritmo editorial.
import type { ReactNode } from "react";
import SiteHeader from "./SiteHeader";
import SectionRail from "./SectionRail";

type PageShellProps = {
  section: string;
  label: string;
  title: string;
  intro: string;
  children: ReactNode;
  image?: string;
  imageAlt?: string;
};

export default function PageShell({ section, label, title, intro, children, image, imageAlt }: PageShellProps) {
  return (
    <div className="site-frame">
      <SiteHeader />
      <main>
        <section className="page-intro container">
          <SectionRail number={section} label={label} />
          <div className="page-intro-copy">
            <p className="eyebrow">SADDLE / {label}</p>
            <h1 className="page-title">{title}</h1>
            <p className="page-intro-text">{intro}</p>
          </div>
          {image && (
            <div className="page-intro-art">
              <img src={image} alt={imageAlt ?? "Saddle technical illustration"} />
            </div>
          )}
        </section>
        <div className="page-content container">{children}</div>
      </main>
      <footer className="site-footer container">
        <span>© 2026 Saddle / distributed by design</span>
        <span className="mono-label">storage == compute</span>
      </footer>
    </div>
  );
}
