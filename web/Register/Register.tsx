// Account creation page: faithful absorption of register.html + register.js —
// username charset validation (3-32 of [a-z0-9.-], lowercased as the visitor
// types), password strength meter, confirmation match, then POST
// /api/v1/auth/register with the localauth fallback for the static edge.
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { apibase, apierrormessage, apifetch, apistatustext } from "../api";
import { SaddleMark } from "../SaddleMark";
import PasswordConfirm from "./PasswordConfirm";
import PasswordMeter from "./PasswordMeter";
import UsernameRules, { usernamere } from "./UsernameRules";

/** meta description carried by the absorbed static page. */
export const registerpagedescription =
  "saddle account creation: username and password only, no e-mail by project policy";

/** state of the static-edge detection: does an api answer at this base? */
type ApiMode = "probing" | "remote" | "local";

/**
 * the create-account page: brand lockup, the registration panel (form
 * with the live rules), the api status line and the policy footer.
 */
export default function Register() {
  const [, navigate] = useLocation();
  const usernameref = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [usernameinvalid, setUsernameinvalid] = useState(false);
  const [passwordinvalid, setPasswordinvalid] = useState(false);
  const [confirminvalid, setConfirminvalid] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
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

  /** auto-lowercase the username while typing (selection restored). */
  const onusernamechange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const lowered = input.value.toLowerCase();
    if (lowered !== input.value) {
      const start = input.selectionStart ?? input.value.length;
      const position = start - (input.value.length - lowered.length);
      input.value = lowered;
      try {
        input.setSelectionRange(position, position);
      } catch {
        /* selection restore is cosmetic */
      }
    }
    setUsername(input.value);
  };

  const onsubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    let valid = true;
    if (!usernamere.test(username)) {
      setUsernameinvalid(true);
      valid = false;
    } else {
      setUsernameinvalid(false);
    }
    if (password.length < 8) {
      setPasswordinvalid(true);
      valid = false;
    } else {
      setPasswordinvalid(false);
    }
    if (password !== confirmation) {
      setConfirminvalid(true);
      valid = false;
    } else {
      setConfirminvalid(false);
    }
    if (!valid) {
      setError("fix the highlighted fields and try again.");
      return;
    }

    setPending(true);

    /* static edge: no api at this base -> browser-local account */
    if (apimode === "local") {
      try {
        const localauth = await import("../localauth.ts");
        await localauth.register(username, password);
        setSucceeded(true);
        navigate("/dashboard");
      } catch (registererror) {
        const message =
          registererror instanceof Error ? registererror.message : "local registration failed.";
        setError(message);
        setPending(false);
      }
      return;
    }

    try {
      const response = await apifetch("/api/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      if (response.ok) {
        /* the backend sets the saddlesession cookie: straight to the dashboard */
        setSucceeded(true);
        navigate("/dashboard");
        return;
      }
      if (response.status === 404) {
        setError(
          "registration is not available at this api target; set ?api=<main node url> and try again.",
        );
      } else {
        let message = "registration failed; try again.";
        if (response.status === 400 || response.status === 409 || response.status === 429) {
          const payloadmessage = await apierrormessage(response);
          if (payloadmessage !== null) {
            message = payloadmessage;
          }
        }
        setError(message);
      }
    } catch {
      setError("the api is unreachable; check the api target or try again later.");
    }
    setPending(false);
  };

  const hintstate =
    username.length > 0 && !usernamere.test(username)
      ? "auth-hint bad"
      : usernamere.test(username)
        ? "auth-hint ok"
        : "auth-hint";

  return (
    <div className="auth-frame">
      <div className="auth-wrap auth-wrap-wide">
        <header className="auth-head">
          <Link href="/" className="brand-lockup">
            <SaddleMark className="h-10 w-10" />
            <span className="brand-wordmark">SADDLE</span>
          </Link>
          <span className="auth-tagline">create account</span>
        </header>

        <main>
          <section className="auth-panel" aria-labelledby="formtitle">
            <h2 className="auth-panel-title" id="formtitle">
              username + password only
            </h2>
            {succeeded ? (
              <div className="auth-success">
                <p className="auth-success-title" role="status" aria-live="polite">
                  account created; opening your dashboard.
                </p>
                <p className="auth-statusline">
                  continue <Link href="/dashboard">to the dashboard</Link>
                  <span aria-hidden="true"> · </span>
                  <Link href="/login">sign in</Link>
                </p>
              </div>
            ) : (
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
                    minLength={3}
                    maxLength={32}
                    pattern="[a-z0-9.-]{3,32}"
                    aria-invalid={usernameinvalid ? "true" : undefined}
                    aria-describedby="usernamehint"
                    value={username}
                    onChange={onusernamechange}
                  />
                  <p className={hintstate} id="usernamehint">
                    3-32 chars, lowercase a-z 0-9 . - (auto-lowercased)
                  </p>
                  <UsernameRules value={username} />
                </div>
                <div className="auth-field">
                  <label htmlFor="password">password</label>
                  <input
                    className="auth-input"
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    aria-invalid={passwordinvalid ? "true" : undefined}
                    aria-describedby="passwordhint"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <PasswordMeter password={password} />
                </div>
                <PasswordConfirm
                  password={password}
                  value={confirmation}
                  invalid={confirminvalid}
                  onChange={setConfirmation}
                />
                {error !== "" && (
                  <p className="auth-formerror" role="alert" aria-live="polite">
                    {error}
                  </p>
                )}
                <button className="button button-primary auth-submit" type="submit" disabled={pending}>
                  {pending ? "creating..." : "create account"}
                </button>
              </form>
            )}
            <p className="auth-statusline">{statusline}</p>
            <p className="auth-statusline">
              already registered? <Link href="/login">sign in</Link>
              <span aria-hidden="true"> · </span>
              <Link href="/console">back to the sandbox</Link>
            </p>
          </section>
        </main>

        <footer className="auth-foot">
          <span>no e-mail field: project policy is username + password only</span>
          <span className="auth-foot-right">passwords hashed with scrypt server-side</span>
        </footer>
      </div>
    </div>
  );
}
