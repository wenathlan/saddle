// Signal & Ledger: o dashboard do e2ugh absorvido na interface única —
// sessão pelo cookie saddlesession (api) ou pela conta local do navegador
// (edge estático), view de usuário e view de admin no mesmo shell React.
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { apibase } from "../api";
/* the explicit .ts suffix keeps the resolution unambiguous while the
 * typed ES module that replaced the window-global localauth.js of the static edge (the original
 * beside the typed module - the same convention the Login page uses. */
import { logout, probe, session as readlocalsession } from "../localauth.ts";
import { apiresult, noderole, pick } from "./lib";
import type { ApiResult, SessionUser } from "./lib";
import CreateSandboxForm from "./CreateSandboxForm";
import SandboxList from "./SandboxList";
import EventsTimeline from "./EventsTimeline";
import AccountPanel from "./AccountPanel";
import AdminPanel from "./AdminPanel";
import type { LocalSessionView } from "./AccountPanel";
import "./dashboard.css";

/** which surface answers: the node api or the static-edge local engine. */
type Phase = "booting" | "api" | "local";

export default function Dashboard() {
  const [, navigate] = useLocation();
  const [phase, setphase] = useState<Phase>("booting");
  const [fatal, setfatal] = useState<string | null>(null);
  const [me, setme] = useState<SessionUser | null>(null);
  const [localview, setlocalview] = useState<LocalSessionView | null>(null);
  const [nodelabel, setnodelabel] = useState("...");
  const [tab, settab] = useState<"user" | "admin">("user");
  const [sandboxreload, setsandboxreload] = useState(0);
  const [leaving, setleaving] = useState(false);
  const tabrefs = useRef<Record<string, HTMLButtonElement | null>>({});

  /** decorative health read: paints the node role badge. */
  async function loadhealth() {
    try {
      const result = await apiresult("/api/v1/health");
      if (result.ok && result.body !== null && typeof result.body === "object") {
        setnodelabel(noderole(result.body));
        return;
      }
    } catch {
      /* health is decorative; the badge simply stays neutral */
    }
    setnodelabel("standalone (no api)");
  }

  /** the account bootstrap: /auth/me fills the session or the fatal gate. */
  async function loadme() {
    let result: ApiResult;
    try {
      result = await apiresult("/api/v1/auth/me");
    } catch {
      setfatal("the api is unreachable; set the api target (?api=...) or try again later.");
      return;
    }
    if (result.status === 401 || result.status === 403) {
      setfatal("this page needs a signed in session.");
      return;
    }
    if (!result.ok || result.body === null || typeof result.body !== "object") {
      setfatal("the api answered but the account payload was not understood.");
      return;
    }
    const envelope = result.body as Record<string, unknown>;
    const body =
      envelope.user !== null && typeof envelope.user === "object"
        ? (envelope.user as Record<string, unknown>)
        : envelope;
    setme({
      username: String(pick(body, ["username", "name", "user"], "unknown")),
      role: String(pick(body, ["role"], "user")).toLowerCase(),
      createdat: pick(body, ["createdAt", "created_at", "createdat", "registeredAt"], null),
      lastloginat: pick(body, ["lastLoginAt", "last_login_at", "lastlogin", "lastLogin"], null),
      id: pick(body, ["id", "uuid"], null),
    });
  }

  /* boot: probe the api once; no answer -> the static edge takes over with
   * the browser-local session (localauth), exactly like the original page. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const answers = await probe(apibase());
      if (cancelled) {
        return;
      }
      if (!answers) {
        setphase("local");
        setnodelabel("static edge (no api)");
        const raw = (await readlocalsession()) as unknown;
        if (raw === null || raw === undefined) {
          setfatal(
            "this static page has no signed-in browser session; sign in or create a local account first.",
          );
          return;
        }
        const view = {
          user: String(pick(raw, ["user", "username"], "unknown")),
          role: String(pick(raw, ["role"], "user")),
          issuedat: Number(pick(raw, ["issuedat", "issuedAt"], Date.now())),
          expiresat: Number(pick(raw, ["expiresat", "expiresAt"], 0)),
        };
        setlocalview(view);
        setme({
          username: view.user,
          role: view.role === "admin" ? "admin" : "local",
          createdat: null,
          lastloginat: new Date(view.issuedat).toISOString(),
          id: null,
        });
        return;
      }
      setphase("api");
      void loadhealth();
      void loadme();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** ends the session (cookie or local) and returns to the sign in page. */
  async function dolgout() {
    setleaving(true);
    /* clears the local browser session too (no-op on the api mode) */
    void logout();
    try {
      await apiresult("/api/v1/auth/logout", { method: "POST" });
    } catch {
      /* the cookie may already be gone; proceed to the login page */
    }
    navigate("/login");
  }

  /** selects one tab and moves the roving focus onto it. */
  function selecttab(next: "user" | "admin") {
    settab(next);
    requestAnimationFrame(() => {
      tabrefs.current[next]?.focus();
    });
  }

  const mode = phase === "local" ? "local" : "api";
  const adminvisible = me !== null && me.role === "admin";
  const userbadge =
    me === null
      ? "..."
      : mode === "local"
        ? `${me.username}${me.role === "admin" ? " (admin, local)" : " (local)"}`
        : `${me.username}${me.role === "admin" ? " (admin)" : ""}`;
  const roleclass =
    nodelabel === "main" || nodelabel === "clone" ? `dash-rolebadge ${nodelabel}` : "dash-rolebadge";

  return (
    <div className="dash">
      <div className="dash-wrap">
        <header className="dash-topbar">
          <h1>
            <Link href="/console">saddle</Link>
          </h1>
          <span className="dash-tagline">dashboard</span>
          <span className={roleclass} aria-live="polite">
            node: {nodelabel}
          </span>
          <span className="dash-spacer" />
          <span className="dash-userbadge">{userbadge}</span>
          <button
            type="button"
            aria-label="end the session and return to the sign in page"
            disabled={leaving}
            onClick={() => {
              void dolgout();
            }}
          >
            logout
          </button>
        </header>

        {fatal !== null && (
          <div className="dash-panel dash-fatal" aria-live="polite">
            <h2>session required</h2>
            <p>{fatal}</p>
            <div className="dash-actions">
              <Link className="dash-btn" href="/login">
                sign in
              </Link>
              <Link className="dash-btn" href="/console">
                back to the sandbox
              </Link>
            </div>
          </div>
        )}

        {fatal === null && (
          <div
            className="dash-tabs"
            role="tablist"
            aria-label="dashboard views"
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
                return;
              }
              if (adminvisible) {
                event.preventDefault();
                selecttab(tab === "user" ? "admin" : "user");
              }
            }}
          >
            <button
              type="button"
              role="tab"
              id="tab-user"
              ref={(node) => {
                tabrefs.current.user = node;
              }}
              aria-selected={tab === "user"}
              aria-controls="panel-user"
              tabIndex={tab === "user" ? 0 : -1}
              onClick={() => {
                selecttab("user");
              }}
            >
              user
            </button>
            {adminvisible && (
              <button
                type="button"
                role="tab"
                id="tab-admin"
                ref={(node) => {
                  tabrefs.current.admin = node;
                }}
                aria-selected={tab === "admin"}
                aria-controls="panel-admin"
                tabIndex={tab === "admin" ? 0 : -1}
                onClick={() => {
                  selecttab("admin");
                }}
              >
                admin
              </button>
            )}
          </div>
        )}

        {fatal === null && (
          <div role="tabpanel" id="panel-user" aria-labelledby="tab-user" hidden={tab !== "user"}>
            <div className="dash-grid2">
              <div>
                <section className="dash-panel" aria-labelledby="boxtitle">
                  <h2 id="boxtitle">my sandboxes</h2>
                  <CreateSandboxForm
                    mode={mode}
                    oncreated={() => {
                      setsandboxreload((key) => key + 1);
                    }}
                    onrefresh={() => {
                      setsandboxreload((key) => key + 1);
                    }}
                  />
                  <SandboxList mode={mode} reloadkey={sandboxreload} ready={me !== null} />
                </section>
              </div>
              <div>
                <section className="dash-panel" aria-labelledby="infotitle">
                  <h2 id="infotitle">my account</h2>
                  <AccountPanel mode={mode} user={me} local={localview} />
                </section>
                <section className="dash-panel" aria-labelledby="eventstitle">
                  <h2 id="eventstitle">bus events</h2>
                  <EventsTimeline mode={mode} ready={me !== null} />
                </section>
              </div>
            </div>
          </div>
        )}

        {fatal === null && adminvisible && (
          <div
            role="tabpanel"
            id="panel-admin"
            aria-labelledby="tab-admin"
            hidden={tab !== "admin"}
          >
            <AdminPanel mode={mode} />
          </div>
        )}

        <footer className="dash-footer">
          <span>session cookie: saddlesession (httponly)</span>
          <span>nothing sensitive in localstorage</span>
          <span style={{ marginLeft: "auto" }}>
            self-hosted node api &middot; no serverless functions
          </span>
        </footer>
      </div>
    </div>
  );
}
