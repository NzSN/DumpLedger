/**
 * LoginPage — operator authentication (design sections 6 and 7.2).
 *
 * POSTs the password to /api/v1/session through the shared HTTP client
 * (never fetch directly), then lets SessionProvider's authenticated state
 * declaratively redirect to the originally requested operator route. A failed
 * attempt shows a safe server message in an alert region and moves focus to
 * it so keyboard and screen-reader users hear the result.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useSession } from "../../app/SessionProvider";
import { errorText } from "../../shared/http-client";
import { PublicLayout } from "../../app/layouts";
import { FormField } from "../../shared/components/form-field";
import { Notice } from "../../shared/components/notice";

interface LoginLocationState {
  readonly from?: string;
}

export function LoginPage(): ReactNode {
  const { session, signIn } = useSession();
  const location = useLocation();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);

  const state = location.state as LoginLocationState | null;
  const from = state?.from !== undefined && state.from !== "/login" ? state.from : "/";

  // Move focus to the error summary after a failed mutation (design 8.4).
  useEffect(() => {
    if (error !== null) {
      errorRef.current?.focus();
    }
  }, [error]);

  if (session.status === "authenticated") {
    // SessionProvider now holds the session; the guard/route redirect follows.
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPassword("");
    setPending(true);
    try {
      await signIn(password);
      // Success is expressed through session state above.
    } catch (cause) {
      setError(errorText(cause, "Sign in failed."));
    } finally {
      setPending(false);
    }
  }

  return (
    <PublicLayout>
      <section className="auth-shell" aria-labelledby="login-title">
        <div className="auth-card">
          <div className="auth-symbol" aria-hidden="true">
            ◆
          </div>
          <h1 id="login-title">Operator sign in</h1>
          <p>Enter the operator password to open the crash evidence vault.</p>
          {error !== null && (
            <div ref={errorRef} tabIndex={-1} className="auth-error">
              <Notice tone="error" role="alert">
                <p>{error}</p>
              </Notice>
            </div>
          )}
          <form className="form-stack auth-form" onSubmit={(event) => void handleSubmit(event)}>
            <FormField id="operator-password" label="Operator password">
              {({ describedBy }) => (
                <input
                  id="operator-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={error !== null}
                  disabled={pending}
                  required
                  autoFocus
                />
              )}
            </FormField>
            <button type="submit" className="button" disabled={pending}>
              {pending ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <p className="auth-footnote">
            <span aria-hidden="true">🔒</span> Session cookies are HttpOnly and SameSite=Strict.
          </p>
        </div>
      </section>
    </PublicLayout>
  );
}
