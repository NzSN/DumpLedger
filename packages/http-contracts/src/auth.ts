/**
 * Authentication contracts (design section 7.2).
 *
 *   GET    /api/v1/session  -> SessionResponse
 *   POST   /api/v1/session  <- LoginRequest, -> SessionResponse (sets cookie)
 *   DELETE /api/v1/session  (CSRF header, 204 no content)
 *
 * The session cookie remains HttpOnly, SameSite=Strict, and Secure on an
 * asserted HTTPS deployment. The CSRF token is kept in memory by the browser;
 * a reload obtains it from `GET /api/v1/session`.
 */

import {
  booleanField,
  canonicalTimestamp,
  fail,
  field,
  object,
  optional,
  text,
  type Decoder,
} from "./decode.js";

/** Browser header carrying the in-memory session CSRF token on mutations. */
export const CSRF_HEADER = "x-csrf-token";

export const MAX_CSRF_TOKEN_LENGTH = 256;
export const MAX_PASSWORD_LENGTH = 1024;

export interface LoginRequest {
  readonly password: string;
}

export interface SessionResponse {
  readonly authenticated: boolean;
  /** Present only when `authenticated` is true. */
  readonly csrfToken?: string;
  /** Canonical UTC session expiry; present only when `authenticated` is true. */
  readonly expiresAt?: string;
}

export const decodeLoginRequest: Decoder<LoginRequest> = (value, path) => {
  const decoded = object(
    {
      password: field(text({ min: 1, max: MAX_PASSWORD_LENGTH, label: "password" })),
    },
    "login request",
  )(value, path);
  return { password: decoded.password };
};

export function encodeLoginRequest(request: LoginRequest): Record<string, unknown> {
  return { password: request.password };
}

/**
 * An authenticated session carries the CSRF token and expiry; an
 * unauthenticated session must carry neither. This asymmetry is deliberate:
 * an authenticated `false` with a stray token is a rejected response rather
 * than silently readable state.
 */
export const decodeSessionResponse: Decoder<SessionResponse> = (value, path) => {
  const decoded = object(
    {
      authenticated: field(booleanField()),
      csrfToken: optional(text({ max: MAX_CSRF_TOKEN_LENGTH, label: "csrf token", pattern: /^\S+$/ })),
      expiresAt: optional(canonicalTimestamp("expiresAt")),
    },
    "session response",
  )(value, path);
  if (decoded.authenticated) {
    if (decoded.csrfToken === undefined) fail("$.csrfToken", "missing required field for an authenticated session");
    if (decoded.expiresAt === undefined) fail("$.expiresAt", "missing required field for an authenticated session");
    return { authenticated: true, csrfToken: decoded.csrfToken, expiresAt: decoded.expiresAt };
  }
  if (decoded.csrfToken !== undefined) fail("$.csrfToken", "must be absent for an unauthenticated session");
  if (decoded.expiresAt !== undefined) fail("$.expiresAt", "must be absent for an unauthenticated session");
  return { authenticated: false };
};

export function encodeSessionResponse(session: SessionResponse): Record<string, unknown> {
  const output: Record<string, unknown> = { authenticated: session.authenticated };
  if (session.csrfToken !== undefined) output.csrfToken = session.csrfToken;
  if (session.expiresAt !== undefined) output.expiresAt = session.expiresAt;
  return output;
}

