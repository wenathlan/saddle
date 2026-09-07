// Signal & Ledger: o painel de conta absorvido do dashboard.js — dl de
// campos da sessão (api) ou da conta local do navegador (edge estático),
// com o keyfile de backup/restore que cobre a limpeza total do storage.
import { useRef } from "react";
import { adminusers, exportaccounts, importaccounts } from "../localauth.ts";
import { fmtdate } from "./lib";
import type { SessionUser } from "./lib";

/** the local browser session normalized at boot (defensive read). */
export type LocalSessionView = {
  user: string;
  role: string;
  issuedat: number;
  expiresat: number;
};

type AccountPanelProps = {
  /** "api" renders the /auth/me account; "local" the browser session. */
  mode: "api" | "local";
  /** the normalized account (api mode). */
  user: SessionUser | null;
  /** the normalized local session (local mode). */
  local: LocalSessionView | null;
};

export default function AccountPanel({ mode, user, local }: AccountPanelProps) {
  const fileref = useRef<HTMLInputElement>(null);

  /** downloads the accounts keyfile (salt + hash only, never passwords). */
  async function backup() {
    try {
      const count = await exportaccounts();
      window.alert(
        count > 0
          ? `backup downloaded (${count} account(s)). keep the file safe; it restores every account after a full browser wipe.`
          : "no accounts to back up yet.",
      );
    } catch {
      window.alert("the backup download failed.");
    }
  }

  /** imports accounts from the chosen keyfile (merge, never overwrite). */
  async function restore(file: File) {
    try {
      const imported = await importaccounts(file);
      window.alert(
        imported > 0
          ? `${imported} account(s) restored from the backup.`
          : "no new accounts in that backup (already present or invalid).",
      );
      window.location.reload();
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "import failed.";
      window.alert(message);
    }
  }

  if (mode === "local" && local !== null) {
    const isadmin = local.role === "admin";
    return (
      <div>
        <dl className="dash-kv">
          <dt>username</dt>
          <dd>{local.user}</dd>
          <dt>role</dt>
          <dd>
            {isadmin
              ? `admin (CODEOWNERS allowlist: ${adminusers.join(", ")})`
              : "user"}
          </dd>
          <dt>mode</dt>
          <dd>
            local browser account (static edge; pbkdf2 in localstorage, never
            synced; the built-in admin seed survives storage resets)
          </dd>
          <dt>signed in</dt>
          <dd>{fmtdate(new Date(local.issuedat).toISOString())}</dd>
          <dt>expires</dt>
          <dd>{fmtdate(new Date(local.expiresat).toISOString())}</dd>
        </dl>
        {/* account backup controls: the keyfile covers a full wipe (the
            IndexedDB mirror already covers partial clears). */}
        <div className="dash-actions">
          <button type="button" className="dash-btn" onClick={() => void backup()}>
            backup accounts
          </button>
          <button
            type="button"
            className="dash-btn"
            onClick={() => {
              fileref.current?.click();
            }}
          >
            restore accounts
          </button>
        </div>
        <input
          ref={fileref}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) {
              void restore(file);
            }
          }}
        />
      </div>
    );
  }

  const account = user;
  return (
    <dl className="dash-kv">
      <dt>username</dt>
      <dd>{account?.username ?? "..."}</dd>
      <dt>role</dt>
      <dd>{account?.role ?? "..."}</dd>
      <dt>created</dt>
      <dd>{fmtdate(account?.createdat)}</dd>
      <dt>last login</dt>
      <dd>{fmtdate(account?.lastloginat)}</dd>
      {account?.id !== null && account?.id !== undefined && (
        <>
          <dt>id</dt>
          <dd>{String(account.id)}</dd>
        </>
      )}
    </dl>
  );
}
