// Signal & Ledger: a lista de sandboxes absorvida do dashboard.js — chips de
// estado, skeletons, refresh de 30 s, ações open/delete (api) e stop (engine
// local do navegador).
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { apiresult, asarray, chipclass, errormessage, fmtdate, pick, readlocalsandboxes, writelocalsandboxes } from "./lib";
import type { ApiResult, LocalSandbox } from "./lib";

type SandboxListProps = {
  /** "api" polls the shelf endpoint; "local" renders the sessionStorage shelf. */
  mode: "api" | "local";
  /** bumped by the orchestrator to force a skeleton reload. */
  reloadkey: number;
  /** false while the session bootstrap runs (avoids a premature 401). */
  ready: boolean;
};

/** truncates one sandbox id for display (the full id stays in the links). */
function shortid(id: string): string {
  return id.slice(0, 13) + (id.length > 13 ? "..." : "");
}

export default function SandboxList({ mode, reloadkey, ready }: SandboxListProps) {
  const [loading, setloading] = useState(true);
  const [items, setitems] = useState<unknown[]>([]);
  const [error, seterror] = useState("");
  const [notlive, setnotlive] = useState(false);
  const [deleting, setdeleting] = useState<string | null>(null);
  const [locals, setlocals] = useState<LocalSandbox[]>([]);

  /** loads the authenticated user's shelf exactly like the original page. */
  const load = useCallback(async (showskeleton: boolean) => {
    if (showskeleton) {
      setloading(true);
      setitems([]);
    }
    let result: ApiResult;
    try {
      result = await apiresult("/api/v1/sandboxes");
    } catch {
      setloading(false);
      seterror("the sandbox list is unreachable right now.");
      return;
    }
    if (result.status === 401 || result.status === 403) {
      setloading(false);
      seterror("the session expired; sign in again.");
      return;
    }
    setloading(false);
    seterror("");
    if (result.status === 404) {
      /* the list endpoint is not live on this node yet (v7 rollout) */
      setitems([]);
      setnotlive(true);
      return;
    }
    setnotlive(false);
    const rows = asarray(result.body, ["sandboxes", "items", "data", "list"]);
    setitems(rows);
  }, []);

  useEffect(() => {
    if (!ready) {
      return undefined;
    }
    if (mode === "local") {
      setloading(false);
      seterror("");
      setlocals(readlocalsandboxes());
      return;
    }
    void load(true);
  }, [mode, reloadkey, ready, load]);

  /* the 30 s shelf poll: only while the tab is visible (api mode). */
  useEffect(() => {
    if (mode !== "api" || !ready) {
      return undefined;
    }
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void load(false);
    }, 30000);
    return () => clearInterval(timer);
  }, [mode, ready, load]);

  /** deletes one sandbox (the manual purge of the shelf contract). */
  async function destroy(id: string) {
    setdeleting(id);
    try {
      const result = await apiresult(`/api/v1/sandboxes/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (result.ok) {
        await load(true);
      } else {
        seterror(errormessage(result, `delete failed with status ${result.status}.`));
      }
    } catch {
      seterror("the api is unreachable; the sandbox was not deleted.");
    }
    setdeleting(null);
  }

  /** stops one browser-local sandbox (removes it from the shelf). */
  function stop(id: string) {
    const remaining = readlocalsandboxes().filter((entry) => entry.id !== id);
    writelocalsandboxes(remaining);
    setlocals(remaining);
  }

  const emptyvisible =
    !loading &&
    error === "" &&
    (mode === "local" ? locals.length === 0 : items.length === 0);
  const listvisible = mode === "local" ? locals.length > 0 : items.length > 0 && !loading;

  return (
    <div>
      <h3>running list</h3>
      {loading && (
        <div aria-hidden="true">
          <div className="dash-skeleton" />
          <div className="dash-skeleton" style={{ width: "88%" }} />
          <div className="dash-skeleton" style={{ width: "70%" }} />
        </div>
      )}
      {listvisible && (
        <ul className="dash-boxlist" aria-live="polite" aria-label="my sandboxes">
          {mode === "local"
            ? locals.map((record) => {
                const spectext = [
                  record.spec.model,
                  `x${record.spec.vcpus} vcpus`,
                  `${record.spec.ramgb} gb`,
                  record.spec.gpu,
                  record.spec.mig && record.spec.mig !== "off" ? `mig ${record.spec.mig}` : "",
                ]
                  .filter(Boolean)
                  .join(" / ");
                return (
                  <li key={record.id}>
                    <div className="rowtop">
                      <span className="id">{shortid(record.id)}</span>
                      <span className={chipclass(record.state ?? "running")}>
                        {record.state ?? "running"}
                      </span>
                      <span className="rowactions">
                        <button
                          type="button"
                          className="danger mini"
                          aria-label={`stop ${record.id}`}
                          onClick={() => stop(record.id)}
                        >
                          stop
                        </button>
                      </span>
                    </div>
                    <span className="specs">{spectext}</span>
                    <span className="meta">created {fmtdate(record.createdat)}</span>
                  </li>
                );
              })
            : items.map((record) => {
                const id = String(pick(record, ["id"], ""));
                const state = String(pick(record, ["state"], "?"));
                const specobj = pick(record, ["spec"], null);
                const spec = specobj !== null && typeof specobj === "object" ? specobj : record;
                const spectext = [
                  String(pick(spec, ["model"], "?")),
                  `x${String(pick(spec, ["vcpus"], "?"))} vcpus`,
                  `${String(pick(spec, ["ramgb", "ramGb", "ram"], "?"))} gb`,
                  String(pick(spec, ["gpu"], "?")),
                  `mig ${String(pick(spec, ["mig"], "off"))}`,
                ].join(" / ");
                const files = pick(record, ["files"], null);
                const meta =
                  `created ${fmtdate(pick(record, ["createdAt", "createdat", "created_at"], null))}` +
                  ` / expires ${fmtdate(pick(record, ["expiresAt", "expiresat", "expires_at"], null))}` +
                  ` / execs ${String(pick(record, ["execCount", "execcount"], 0))}` +
                  (files !== null && files !== undefined ? ` / files ${String(files)}` : "");
                return (
                  <li key={id}>
                    <div className="rowtop">
                      <span className="id">{shortid(id)}</span>
                      <span className={chipclass(state)}>{state}</span>
                      <span className="rowactions">
                        <Link
                          className="dash-btn mini"
                          href={`/console?sandbox=${encodeURIComponent(id)}`}
                          aria-label={`open sandbox ${id} in the terminal`}
                        >
                          open
                        </Link>
                        <button
                          type="button"
                          className="danger mini"
                          aria-label={`delete sandbox ${id}`}
                          disabled={deleting === id}
                          onClick={() => {
                            void destroy(id);
                          }}
                        >
                          delete
                        </button>
                      </span>
                    </div>
                    <span className="specs">{spectext}</span>
                    <span className="meta">{meta}</span>
                  </li>
                );
              })}
        </ul>
      )}
      {emptyvisible && (
        <p className="dash-empty">
          {notlive
            ? "the sandbox list is not live on this node yet; creation still works."
            : "no sandboxes yet; create one above or boot the local engine from the "}
          {!notlive && <Link href="/console">console</Link>}
          {!notlive && "."}
        </p>
      )}
      {error !== "" && <p className="dash-panelerror">{error}</p>}
    </div>
  );
}
