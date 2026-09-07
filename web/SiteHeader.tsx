// Signal & Ledger: cabeçalho editorial compacto, com logo visível e navegação contextual.
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { SaddleMark } from "./SaddleMark";

const navItems = [
  { href: "/architecture", label: "Architecture" },
  { href: "/agent-browser", label: "Agent Browser" },
  { href: "/compute", label: "Compute" },
  { href: "/playground", label: "Playground" },
  { href: "/integrations", label: "Integrations" },
  { href: "/console", label: "Console" },
  { href: "/docs", label: "Docs" },
];

export default function SiteHeader() {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);

  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link href="/" className="brand-lockup" onClick={() => setOpen(false)}>
          <SaddleMark className="h-10 w-10" />
          <span className="brand-wordmark">SADDLE</span>
        </Link>

        <nav className={`desktop-nav ${open ? "is-open" : ""}`} aria-label="Primary navigation">
          <Link href="/" className={location === "/" ? "nav-link is-active" : "nav-link"} onClick={() => setOpen(false)}>
            Overview
          </Link>
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={location === item.href ? "nav-link is-active" : "nav-link"}
              onClick={() => setOpen(false)}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="header-actions">
          <a className="header-status" href="https://github.com/wenathlan/saddle" target="_blank" rel="noreferrer">
            <span className="status-dot" />
            Open source
          </a>
          <button className="mobile-menu-button" type="button" aria-expanded={open} aria-label="Open navigation" onClick={() => setOpen((value) => !value)}>
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>
    </header>
  );
}
