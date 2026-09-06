/**
 * SessionProvider (design section 8.2) — owns ONLY the authenticated session
 * state and the in-memory CSRF token.
 *
 * It never stores cases, dumps, grants, or operations data, and the CSRF token
 * is never written to localStorage, sessionStorage, IndexedDB, or a
 * non-HttpOnly cookie. A reload restores the session by asking
 * `GET /api/v1/session` for the token again.
 *
 *   - A 401 anywhere clears the session and (through the operator guard)
 *     moves the user to /login.
 *   - A 403 remains a visible authorization/CSRF error and never clears the
 *     session.
 *
 * Session bootstrap only happens when an operator route mounts (see
 * OperatorGuard); the public /login and /upload routes never trigger it.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Outlet } from "react-router";
import {
  decodeSessionResponse,
  encodeLoginRequest,
  type SessionResponse,
} from "@dump-ledger/http-contracts";
import { useHttpClient } from "../shared/http-client-context";
import { HttpRequestError } from "../shared/http-client";

export type SessionState =
  | { readonly status: "checking" }
  | { readonly status: "anonymous" }
  | { readonly status: "authenticated"; readonly csrfToken: string; readonly expiresAt?: string };

export interface SessionContextValue {
  readonly session: SessionState;
  /** True only when an authenticated session is held in memory. */
  readonly isAuthenticated: boolean;
  /**
   * Restores the session from `GET /api/v1/session`. Resolves after the
   * state is set; a 401 resolves as `anonymous` (the normal unauthenticated
   * case), while transport/decoding failures throw for the guard to surface
   * a retryable error.
   */
  readonly bootstrap: () => Promise<void>;
  /** Signs in with the operator password; throws {@link HttpRequestError} on failure. */
  readonly signIn: (password: string) => Promise<void>;
  /** Signs out; clears the in-memory session only after the DELETE succeeds. */
  readonly signOut: () => Promise<void>;
  /** Clears the in-memory session without a request (401 handling). */
  readonly clearSession: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function sessionError(message: string, cause: unknown): HttpRequestError {
  return new HttpRequestError(message, {
    code: "internal_error",
    status: 0,
    retryable: false,
    path: "/api/v1/session",
    cause,
  });
}

/** Builds an authenticated SessionState; throws when the token is missing. */
function authenticatedState(response: SessionResponse): SessionState {
  if (response.csrfToken === undefined) {
    throw sessionError("The server returned an authenticated session without a CSRF token.", response);
  }
  return {
    status: "authenticated",
    csrfToken: response.csrfToken,
    ...(response.expiresAt === undefined ? {} : { expiresAt: response.expiresAt }),
  };
}

/** Root route element: renders the routed screen with session context. */
export function SessionProvider(): ReactNode {
  const client = useHttpClient();
  const [session, setSession] = useState<SessionState>({ status: "checking" });

  // The CSRF source must always read the *latest* in-memory token without
  // re-registering on every change, so the client reads it through a ref.
  const csrfRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    csrfRef.current = session.status === "authenticated" ? session.csrfToken : undefined;
  }, [session]);

  const clearSession = useCallback(() => {
    setSession({ status: "anonymous" });
  }, []);

  // Wire the deep module: the client reads the CSRF token from this provider,
  // and any 401 it observes clears the session here.
  useEffect(() => {
    client.setCsrfTokenSource(() => csrfRef.current);
    client.setOnSessionExpired(clearSession);
    return () => {
      client.setCsrfTokenSource(undefined);
      client.setOnSessionExpired(undefined);
    };
  }, [client, clearSession]);

  const bootstrap = useCallback(async () => {
    let response: SessionResponse;
    try {
      response = await client.query({ path: "/api/v1/session", decoder: decodeSessionResponse });
    } catch (error) {
      if (error instanceof HttpRequestError && (error.code === "unauthenticated" || error.status === 401)) {
        // The server has no valid session cookie: normal unauthenticated state.
        setSession({ status: "anonymous" });
        return;
      }
      throw error;
    }
    setSession(response.authenticated ? authenticatedState(response) : { status: "anonymous" });
  }, [client]);

  const signIn = useCallback(
    async (password: string) => {
      const response = await client.mutate({
        path: "/api/v1/session",
        method: "POST",
        body: encodeLoginRequest({ password }),
        decoder: decodeSessionResponse,
      });
      setSession(response.authenticated ? authenticatedState(response) : { status: "anonymous" });
    },
    [client],
  );

  const signOut = useCallback(async () => {
    await client.mutate({ path: "/api/v1/session", method: "DELETE" });
    setSession({ status: "anonymous" });
  }, [client]);

  const value: SessionContextValue = {
    session,
    isAuthenticated: session.status === "authenticated",
    bootstrap,
    signIn,
    signOut,
    clearSession,
  };

  return <SessionContext.Provider value={value}>{<Outlet />}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error("useSession must be used inside <SessionProvider>");
  }
  return value;
}
