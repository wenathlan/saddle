// Signal & Ledger: o log de auditoria absorvido do dashboard.js — ação,
// usuário, ip e instante das entradas que o nó principal registra; no edge
// estático, a nota honesta.
import { useEffect, useState } from "react";
import { apiresult, asarray, fmtdate, pick } from "./lib";

type AuditLogProps = {
  /** "api" lists /api/v1/admin/audit; "local" shows the static note. */
  mode: "api" | "local";
  /** bumped by the admin refresh-all action. */
  reloadkey: number;
};

export default function AuditLog({ mode, reloadkey }: AuditLogProps) {
  const [items, setitems] = useState<unknown[]>([]);
  const [error, seterror] = useState("");

  useEffect(() => {
    if (mode !== "api") {
      return undefined;
    }
    let stopped = false;
    (async () => {
      try {
        const result = await apiresult("/api/v1/admin/audit");
        if (stopped) {
          return;
        }
        if (!result.ok) {
          seterror(`audit log unavailable (status ${result.status}).`);
          return;
        }
        seterror("");
        setitems(asarray(result.body, ["entries", "audit", "items", "data", "list", "logs"]));
      } catch {
        if (!stopped) {
          seterror("the audit endpoint is unreachable.");
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [mode, reloadkey]);

  if (mode === "local") {
    return (
      <p className="dash-empty">
        the audit trail lives on the main node api; the static edge keeps no audit records.
      </p>
    );
  }

  return (
    <div>
      <div className="dash-tablescroll" tabIndex={0} role="region" aria-label="audit log table">
        <table>
          {items.length === 0 && error === "" && (
            <caption className="dash-empty">no audit entries yet.</caption>
          )}
          <thead>
            <tr>
              <th scope="col">action</th>
              <th scope="col">username</th>
              <th scope="col">ip</th>
              <th scope="col">when</th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry, index) => {
              const action = String(pick(entry, ["action", "type", "event"], "?"));
              const username = String(pick(entry, ["username", "actor", "by", "user", "userid", "user_id"], "-"));
              const ip = String(pick(entry, ["ip", "sourceIp", "address"], "-"));
              return (
                <tr key={`${action}-${index}`}>
                  <td>{action}</td>
                  <td>{username}</td>
                  <td className="wrapcell">{ip}</td>
                  <td>{fmtdate(pick(entry, ["at", "ts", "time", "createdAt", "when"], null))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {error !== "" && <p className="dash-panelerror">{error}</p>}
    </div>
  );
}
