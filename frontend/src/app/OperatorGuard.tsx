/**
 * OperatorGuard — protects operator routes (design sections 6 and 8.2).
 *
 * Only operator routes mount this guard, so deep links into public routes
 * (/login, /upload) never trigger the authenticated session bootstrap. When
 * the session is absent the guard redirects to /login with a safe relative
 * return path; when the server cannot be reached the guard shows a retryable
 * error instead of silently bouncing the operator to the login form.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useSession } from "./SessionProvider";
import { OperatorLayout } from "./layouts";
import { errorText } from "../shared/http-client";
import { Notice } from "../shared/components/notice";

function SessionCheckingScreen(): ReactNode {
  return (
    <div className="checking-screen" role="status">
      <p>Restoring session…</p>
    </div>
  );
}

export interface SessionRestoreErrorProps {
  readonly message: string;
  readonly onRetry: () => void;
}

function SessionRestoreError({ message, onRetry }: SessionRestoreErrorProps): ReactNode {
  return (
    <div className="page-frame">
      <section className="screen-status" aria-labelledby="session-error-title">
        <h1 id="session-error-title" className="screen-title">
          Cannot restore your session
        </h1>
        <Notice tone="error" role="alert">
          <p>{message}</p>
        </Notice>
        <p>
          <button type="button" className="button" onClick={onRetry}>
            Try again
          </button>
        </p>
      </section>
    </div>
  );
}

export function OperatorGuard(): ReactNode {
  const { session, bootstrap } = useSession();
  const location = useLocation();
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (session.status !== "checking") return;
    let cancelled = false;
    setBootstrapError(null);
    bootstrap().catch((error: unknown) => {
      if (!cancelled) setBootstrapError(errorText(error, "The session could not be restored."));
    });
    return () => {
      cancelled = true;
    };
  }, [session.status, bootstrap, attempt]);

  if (session.status === "authenticated") {
    return <OperatorLayout />;
  }
  if (session.status === "anonymous") {
    const from = `${location.pathname}${location.search}`;
    return <Navigate to="/login" replace state={{ from }} />;
  }
  // checking
  if (bootstrapError !== null) {
    return <SessionRestoreError message={bootstrapError} onRetry={() => setAttempt((value) => value + 1)} />;
  }
  return <SessionCheckingScreen />;
}
