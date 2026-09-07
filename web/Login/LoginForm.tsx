// Login form: faithful absorption of login.js — posts the credentials to
// /api/v1/auth/login, falls back to the browser-local accounts when no api
// answers, and honors the sanitized ?next= target on success.
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { apibase, apifetch, apistatustext } from "../api";

/** fallback target when no ?next= parameter is present. */
const defaulttarget = "dashboard";

/**
 * only same-origin page-relative targets are honored; absolute urls,
 * protocol relative (//host), backslash (\host), scheme (javascript:,
 * data:), control characters and path traversal are all rejected.
 * targets stay page-relative (no leading slash) so the redirect works
 * both on the self-hosted node (/, /login) and inside sub-path static
 * hosting such as github pages (/saddle/login). the redirect target
 * never depends on an unvalidated user value. legacy ".html" suffixes
 * from the absorbed static pages map to the spa route of the same name.
 *
 * @returns the sanitized page-relative target.
 */
export function safenext(): string {
  try {
    const raw = new URLSearchParams(window.location.search).get("next");
    if (raw === null) return defaulttarget;
    const decoded = decodeURIComponent(raw);
    if (!/^[A-Za-z0-9._\-/]*$/.test(decoded)) return defaulttarget;
    if (decoded.trim() === "") return defaulttarget;
    if (decoded.startsWith("//") || decoded.startsWith("/\\")) return defaulttarget;
    if (decoded.includes("../") || decoded.includes("/./") || decoded.startsWith("./")) {
      return defaulttarget;
    }
    return decoded.replace(/^\/+/, "").replace(/\.html$/, "");
  } catch {
    return defaulttarget;
  }
}

/** state of the static-edge detection: does an api answer at this base? */
type ApiMode = "probing" | "remote" | "local";

/**
 * the sign-in form: username + password only, generic error messages on
 * purpose (no user enumeration, no cause leak), aria-invalid feedback and
 * loading states while the submission is in flight.
 */
export default function LoginForm() {
  const [, navigate] = useLocation();
  const usernameref = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [usernameinvalid, setUsernameinvalid] = useState(false);
  const [passwordinvalid, setPasswordinvalid] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [apimode, setApimode] = useState<ApiMode>("probing");
  const [statusline, setStatusline] = useState(apistatustext());

  /** static edge detection: probe the api once; no answer -> local mode. */
  useEffect(() => {
    let cancelled = false;
    const detect = async () => {
      const base = apibase();
      const localauth = await import("../localauth.ts");
      const apianswers = await localauth.probe(base);
      if (cancelled) return;
      if (!apianswers) {
        setApimode("local");
        setStatusline("accounts: local browser (static edge, no api)");
      } else {
        setApimode("remote");
      }
    };
    detect().catch(() => {
      if (!cancelled) setApimode("local");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** username field focus, like the static page controller. */
  useEffect(() => {
    usernameref.current?.focus();
  }, []);

  const clearerror = () => setError("");

  const showerror = (message: string) => setError(message);

  const onsubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clearerror();
    const trimmedusername = username.trim();
    if (trimmedusername.length === 0 || password.length === 0) {
      setUsernameinvalid(trimmedusername.length === 0);
      setPasswordinvalid(password.length === 0);
      showerror("enter both the username and the password.");
      return;
    }
    setUsernameinvalid(false);
    setPasswordinvalid(false);
    setPending(true);

    /* static edge: no api at this base -> verify the local account */
    if (apimode === "local") {
      try {
        const localauth = await import("../localauth.ts");
        await localauth.login(trimmedusername, password);
        navigate(`/${safenext()}`);
      } catch (loginerror) {
        const message =
          loginerror instanceof Error ? loginerror.message : "invalid username or password.";
        showerror(message);
        setPending(false);
      }
      return;
    }

    try {
      const response = await apifetch("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: trimmedusername, password }),
      });
      if (response.ok) {
        navigate(`/${safenext()}`);
        return;
      }
      if (response.status === 404) {
        showerror(
          "auth is not available at this api target; set ?api=<main node url> and try again.",
        );
      } else {
        /* generic message on purpose: no user enumeration, no cause leak */
        showerror("invalid username or password.");
      }
    } catch {
      showerror("the api is unreachable; check the api target or try again later.");
    }
    setPending(false);
  };

  return (
    <form className="auth-form" noValidate onSubmit={onsubmit}>
      <div className="auth-field">
        <label htmlFor="username">username</label>
        <input
          ref={usernameref}
          className="auth-input"
          id="username"
          name="username"
          type="text"
          autoComplete="username"
          spellCheck={false}
          autoCapitalize="none"
          required
          aria-invalid={usernameinvalid ? "true" : undefined}
          aria-describedby="usernamehint"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <p className="auth-hint" id="usernamehint">
          username only; this project has no e-mail field.
        </p>
      </div>
      <div className="auth-field">
        <label htmlFor="password">password</label>
        <input
          className="auth-input"
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={passwordinvalid ? "true" : undefined}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      {error !== "" && (
        <p className="auth-formerror" role="alert" aria-live="polite">
          {error}
        </p>
      )}
      <button className="button button-primary auth-submit" type="submit" disabled={pending}>
        {pending ? "signing in..." : "sign in"}
      </button>
      <p className="auth-statusline">{statusline}</p>
      <p className="auth-statusline">
        no account? <Link href="/register">create one</Link>
        <span aria-hidden="true"> · </span>
        <Link href="/console">back to the sandbox</Link>
      </p>
    </form>
  );
}
