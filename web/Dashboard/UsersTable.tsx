// Signal & Ledger: a tabela de usuários absorvida do dashboard.js — busca
// client-side por username, campos de conta apenas (hash e salt nunca saem
// da api); no edge estático, o registro local do navegador.
import { useEffect, useState } from "react";
import { available, roleof } from "../localauth.ts";
import { apiresult, asarray, chipclass, fmtdate, pick } from "./lib";

type UsersTableProps = {
  /** "api" lists /api/v1/admin/users; "local" the browser account registry. */
  mode: "api" | "local";
  /** bumped by the admin refresh-all action. */
  reloadkey: number;
};

/** reads the local account names (defensive; the api mode never lands here). */
function localaccountnames(): string[] {
  try {
    const raw = window.localStorage.getItem("saddle_local_users");
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed !== null && typeof parsed === "object") {
      return Object.keys(parsed as Record<string, unknown>);
    }
  } catch {
    /* no registry or unreadable storage: the empty table applies */
  }
  return [];
}

export default function UsersTable({ mode, reloadkey }: UsersTableProps) {
  const [users, setusers] = useState<unknown[]>([]);
  const [error, seterror] = useState("");
  const [query, setquery] = useState("");

  useEffect(() => {
    if (mode === "local") {
      seterror("");
      setusers(available() ? localaccountnames() : []);
      return;
    }
    let stopped = false;
    (async () => {
      try {
        const result = await apiresult("/api/v1/admin/users");
        if (stopped) {
          return;
        }
        if (!result.ok) {
          seterror(`user table unavailable (status ${result.status}).`);
          return;
        }
        seterror("");
        setusers(asarray(result.body, ["users", "items", "data", "list"]));
      } catch {
        if (!stopped) {
          seterror("the users endpoint is unreachable.");
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [mode, reloadkey]);

  const needle = query.trim().toLowerCase();
  const rows = users.filter((user) => {
    const username = mode === "local"
      ? String(user)
      : String(pick(user, ["username", "name", "user"], ""));
    return needle === "" || username.toLowerCase().includes(needle);
  });

  return (
    <div>
      <div className="dash-field" style={{ maxWidth: "340px" }}>
        <label htmlFor="usersearch">search by username</label>
        <input
          type="search"
          id="usersearch"
          placeholder="filter..."
          aria-label="filter the users table by username"
          value={query}
          onChange={(event) => {
            setquery(event.target.value);
          }}
        />
      </div>
      <div className="dash-tablescroll" tabIndex={0} role="region" aria-label="users table">
        <table>
          {rows.length === 0 && error === "" && (
            <caption className="dash-empty">
              {needle === ""
                ? mode === "local"
                  ? "no accounts registered in this browser."
                  : "no users registered yet."
                : `no users match "${needle}".`}
            </caption>
          )}
          <thead>
            <tr>
              <th scope="col">username</th>
              <th scope="col">role</th>
              <th scope="col">last login</th>
              <th scope="col">created</th>
            </tr>
          </thead>
          <tbody>
            {mode === "local"
              ? rows.map((name) => (
                  <tr key={String(name)}>
                    <td>{String(name)}</td>
                    <td>{roleof(String(name))}</td>
                    <td>browser-local</td>
                  </tr>
                ))
              : rows.map((user, index) => {
                  const username = String(pick(user, ["username", "name", "user"], "?"));
                  const role = String(pick(user, ["role"], "user"));
                  /* account fields only: hash and salt keys are ignored */
                  return (
                    <tr key={`${username}-${index}`}>
                      <td>{username}</td>
                      <td>
                        <span className={chipclass(role)}>{role}</span>
                      </td>
                      <td>{fmtdate(pick(user, ["lastLoginAt", "last_login_at", "lastlogin"], null))}</td>
                      <td>{fmtdate(pick(user, ["createdAt", "created_at", "createdat"], null))}</td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
      {mode !== "local" && (
        <p className="dash-statusnote">
          password hashes and salts never leave the api; this table renders account fields only.
        </p>
      )}
      {error !== "" && <p className="dash-panelerror">{error}</p>}
    </div>
  );
}
