// Sign-in page: faithful absorption of login.html — the account panel with
// the login form, the api status line and the project footer. the session
// is carried exclusively by the saddlesession cookie (nothing sensitive is
// ever stored in localstorage).
import { Link } from "wouter";
import LoginForm from "./LoginForm";
import { SaddleMark } from "../SaddleMark";

/** meta description carried by the absorbed static page. */
export const loginpagedescription =
  "saddle sign in: username and password only, session carried by the saddlesession cookie";

/**
 * the sign-in page frame: brand lockup, the account panel and the
 * static-edge footer notes.
 */
export default function Login() {
  return (
    <div className="auth-frame">
      <div className="auth-wrap">
        <header className="auth-head">
          <Link href="/" className="brand-lockup">
            <SaddleMark className="h-10 w-10" />
            <span className="brand-wordmark">SADDLE</span>
          </Link>
          <span className="auth-tagline">sign in</span>
        </header>

        <main>
          <section className="auth-panel" aria-labelledby="formtitle">
            <h2 className="auth-panel-title" id="formtitle">
              account
            </h2>
            <LoginForm />
          </section>
        </main>

        <footer className="auth-foot">
          <span>session cookie: saddlesession (httponly)</span>
          <span className="auth-foot-right">self-hosted node api · no serverless functions</span>
        </footer>
      </div>
    </div>
  );
}
