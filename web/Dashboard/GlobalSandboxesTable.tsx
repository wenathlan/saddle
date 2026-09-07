// Signal & Ledger: a tabela global de sandboxes absorvida do dashboard.js —
// linhas do db (planas ou envelopadas) para o admin do nó principal; no edge
// estático, a nota honesta apontando para a view de usuário.
import { useEffect, useState } from "react";
import { apiresult, asarray, chipclass, fmtdate, pick } from "./lib";

type GlobalSandboxesTableProps = {
  /** "api" lists /api/v1/admin/sandboxes; "local" shows the static note. */
  mode: "api" | "local";
  /** bumped by the admin refresh-all action. */
  reloadkey: number;
};

export default function GlobalSandboxesTable({ mode, reloadkey }: GlobalSandboxesTableProps) {
  const [items, setitems] = useState<unknown[]>([]);
  const [error, seterror] = useState("");

  useEffect(() => {
    if (mode !== "api") {
      return undefined;
    }
    let stopped = false;
    (async () => {
      try {
        const result = await apiresult("/api/v1/admin/sandboxes");
        if (stopped) {
          return;
        }
        if (!result.ok) {
          seterror(`sandbox table unavailable (status ${result.status}).`);
          return;
        }
        seterror("");
        setitems(asarray(result.body, ["sandboxes", "items", "data", "list"]));
      } catch {
        if (!stopped) {
          seterror("the sandboxes endpoint is unreachable.");
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
        the global sandbox table lives on the main node api; the local engine shelf stays in the
        user view.
      </p>
    );
  }

  return (
    <div>
      <div className="dash-tablescroll" tabIndex={0} role="region" aria-label="global sandboxes table">
        <table>
          {items.length === 0 && error === "" && (
            <caption className="dash-empty">no sandboxes on this node.</caption>
          )}
          <thead>
            <tr>
              <th scope="col">id</th>
              <th scope="col">owner</th>
              <th scope="col">state</th>
              <th scope="col">spec</th>
              <th scope="col">created</th>
              <th scope="col">expires</th>
            </tr>
          </thead>
          <tbody>
            {items.map((record, index) => {
              /* admin rows may be flat db rows or enveloped public views */
              const specobj = pick(record, ["spec"], null);
              const spec = specobj !== null && typeof specobj === "object" ? specobj : record;
              const owner = pick(record, ["owner", "username", "user", "ownerUsername", "userid", "user_id"], "-");
              const id = String(pick(record, ["id"], "?"));
              return (
                <tr key={`${id}-${index}`}>
                  <td className="wrapcell">{id}</td>
                  <td>{String(owner)}</td>
                  <td>
                    <span className={chipclass(pick(record, ["state"], "?"))}>
                      {String(pick(record, ["state"], "?"))}
                    </span>
                  </td>
                  <td className="wrapcell">
                    {[
                      String(pick(spec, ["model"], "?")),
                      `x${String(pick(spec, ["vcpus"], "?"))}`,
                      `${String(pick(spec, ["ramgb", "ramGb", "ram"], "?"))}gb`,
                      String(pick(spec, ["gpu"], "?")),
                    ].join(" ")}
                  </td>
                  <td>{fmtdate(pick(record, ["createdAt", "createdat", "created_at"], null))}</td>
                  <td>{fmtdate(pick(record, ["expiresAt", "expiresat", "expires_at"], null))}</td>
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
