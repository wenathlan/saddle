// Signal & Ledger: a view de admin absorvida do dashboard.js — cartões de
// overview com refresh global, nós do mesh, usuários, sandboxes globais e
// auditoria; no edge estático, o overview do próprio navegador.
import { useEffect, useState } from "react";
import { available } from "../localauth.ts";
import { apiresult, fmtuptime, pick, readlocalsandboxes } from "./lib";
import MeshNodesTable from "./MeshNodesTable";
import UsersTable from "./UsersTable";
import GlobalSandboxesTable from "./GlobalSandboxesTable";
import AuditLog from "./AuditLog";

type AdminPanelProps = {
  /** "api" reads the admin surface; "local" the browser-local overview. */
  mode: "api" | "local";
};

/** the six overview counters. */
type Overview = {
  users: string;
  nodes: string;
  sandboxes: string;
  sessions: string;
  events: string;
  uptime: string;
};

/** the placeholder state while the overview loads. */
const pending: Overview = {
  users: "...",
  nodes: "...",
  sandboxes: "...",
  sessions: "...",
  events: "...",
  uptime: "...",
};

/** the browser-local overview of the static edge admin. */
function localoverview(): Overview {
  let accounts = 0;
  try {
    const raw = window.localStorage.getItem("saddle_local_users");
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed !== null && typeof parsed === "object") {
      accounts = Object.keys(parsed as Record<string, unknown>).length;
    }
  } catch {
    /* no registry in this browser */
  }
  const localboxes = available() ? readlocalsandboxes().length : 0;
  return {
    users: String(accounts),
    nodes: "1 (this browser)",
    sandboxes: String(localboxes),
    sessions: "local",
    events: "n/a",
    uptime: "n/a",
  };
}

export default function AdminPanel({ mode }: AdminPanelProps) {
  const [overview, setoverview] = useState<Overview>(pending);
  const [reloadkey, setreloadkey] = useState(0);

  useEffect(() => {
    if (mode === "local") {
      setoverview(localoverview());
      return;
    }
    let stopped = false;
    (async () => {
      try {
        const result = await apiresult("/api/v1/admin/overview");
        if (stopped) {
          return;
        }
        if (!result.ok || result.body === null || typeof result.body !== "object") {
          setoverview({ ...pending, users: "n/a" });
          return;
        }
        const body = result.body as Record<string, unknown>;
        const counts =
          body.counts !== null && typeof body.counts === "object"
            ? body.counts
            : body.overview !== null && typeof body.overview === "object"
              ? body.overview
              : body;
        setoverview({
          users: String(pick(counts, ["users", "userCount", "totalUsers", "usercount"], "n/a")),
          nodes: String(pick(counts, ["nodes", "nodeCount", "totalNodes", "nodecount"], "n/a")),
          sandboxes: String(pick(counts, ["sandboxes", "sandboxCount", "totalSandboxes"], "n/a")),
          sessions: String(pick(counts, ["sessions", "sessionCount", "totalSessions"], "n/a")),
          events: String(pick(counts, ["events", "eventCount", "totalEvents"], "n/a")),
          uptime: fmtuptime(pick(counts, ["uptime", "uptimeSeconds", "uptime_seconds"], 0)),
        });
      } catch {
        if (!stopped) {
          setoverview({ ...pending, users: "n/a" });
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [mode, reloadkey]);

  return (
    <div>
      <section className="dash-panel" aria-labelledby="overtitle">
        <h2 id="overtitle">overview</h2>
        <div className="dash-cards">
          <div className="dash-card">
            <div className="k">users</div>
            <div className="v">{overview.users}</div>
          </div>
          <div className="dash-card">
            <div className="k">nodes</div>
            <div className="v">{overview.nodes}</div>
          </div>
          <div className="dash-card">
            <div className="k">sandboxes</div>
            <div className="v">{overview.sandboxes}</div>
          </div>
          <div className="dash-card">
            <div className="k">sessions</div>
            <div className="v">{overview.sessions}</div>
          </div>
          <div className="dash-card">
            <div className="k">events</div>
            <div className="v">{overview.events}</div>
          </div>
          <div className="dash-card">
            <div className="k">uptime</div>
            <div className="v">{overview.uptime}</div>
          </div>
        </div>
        <div className="dash-actions">
          <button
            type="button"
            aria-label="reload every admin table"
            onClick={() => {
              setreloadkey((key) => key + 1);
            }}
          >
            refresh all
          </button>
        </div>
      </section>

      <section className="dash-panel" aria-labelledby="nodestitle">
        <h2 id="nodestitle">mesh nodes</h2>
        <MeshNodesTable mode={mode} reloadkey={reloadkey} />
      </section>

      <section className="dash-panel" aria-labelledby="userstitle">
        <h2 id="userstitle">users</h2>
        <UsersTable mode={mode} reloadkey={reloadkey} />
      </section>

      <section className="dash-panel" aria-labelledby="boxestitle">
        <h2 id="boxestitle">sandboxes (global)</h2>
        <GlobalSandboxesTable mode={mode} reloadkey={reloadkey} />
      </section>

      <section className="dash-panel" aria-labelledby="audittitle">
        <h2 id="audittitle">audit log</h2>
        <AuditLog mode={mode} reloadkey={reloadkey} />
      </section>
    </div>
  );
}
