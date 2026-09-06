/**
 * Thin Fastify adapters over @dump-ledger/http-contracts (design sections 7.1
 * and 7.2). Everything here bridges Fastify requests/replies to the stable
 * contract envelope; it contains no domain logic and no engine access.
 *
 * Rules honoured by every /api/v1 route:
 *   - request bodies are decoded at runtime before any engine call,
 *   - responses carry `Cache-Control: no-store` (also enforced by the shared
 *     onSend hook in server.ts),
 *   - errors use the single `{ error: { code, message, retryable } }` envelope
 *     with a fixed safe operator-facing message per stable code,
 *   - 401 means "no usable session" (the browser treats this as logout),
 *     403 means "authenticated but CSRF evidence is missing or wrong" and is
 *     a visible authorization/CSRF error, never a logout signal.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import {
  CSRF_HEADER,
  type Decoder,
  decodeJsonText,
  encodeErrorResponse,
  type HttpErrorCode,
} from "@dump-ledger/http-contracts";
import type { OperatorSession, OperatorSessions } from "../../auth/sessions.js";

const HTTP_STATUS: Readonly<Record<HttpErrorCode, number>> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_transition: 409,
  grant_unavailable: 404,
  upload_too_large: 413,
  upload_busy: 503,
  rate_limited: 429,
  storage_unavailable: 503,
  integrity_failure: 500,
  internal_error: 500,
};

/** Fixed safe operator-facing message per stable code (never derived from inputs). */
const MESSAGES: Readonly<Record<HttpErrorCode, string>> = {
  invalid_request: "The request was malformed.",
  unauthenticated: "Authentication is required.",
  forbidden: "Forbidden.",
  not_found: "Not found.",
  invalid_transition: "That action is not allowed from the current state.",
  grant_unavailable: "The upload grant is unavailable.",
  upload_too_large: "The upload exceeded its allowed byte size.",
  upload_busy: "Upload processing is busy; try again shortly.",
  rate_limited: "Too many requests. Try again later.",
  storage_unavailable: "Storage is temporarily unavailable.",
  integrity_failure: "An internal integrity check failed.",
  internal_error: "An internal error occurred.",
};

const RETRYABLE_CODES: ReadonlySet<HttpErrorCode> = new Set([
  "rate_limited",
  "upload_busy",
  "storage_unavailable",
]);

export function httpStatusFor(code: HttpErrorCode): number {
  return HTTP_STATUS[code];
}

export function messageFor(code: HttpErrorCode): string {
  return MESSAGES[code];
}

export function retryableFor(code: HttpErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

/** Sends the stable JSON error envelope and returns the reply for chaining. */
export function sendError(reply: FastifyReply, code: HttpErrorCode): FastifyReply {
  return reply
    .code(httpStatusFor(code))
    .header("Cache-Control", "no-store")
    .type("application/json; charset=utf-8")
    .send(
      encodeErrorResponse({
        error: { code, message: messageFor(code), retryable: retryableFor(code) },
      }),
    );
}

/**
 * Maps an application/engine failure code onto the stable HTTP error code.
 * Unknown or unexpected codes degrade to `internal_error` rather than leaking
 * an internal identifier to the operator.
 */
export function contractErrorFor(code: string): HttpErrorCode {
  switch (code) {
    case "invalid_input": return "invalid_request";
    case "customer_not_found":
    case "case_not_found":
    case "dump_not_found":
    case "not_found": return "not_found";
    case "grant_invalid":
    case "grant_expired":
    case "grant_consumed":
    case "grant_unavailable": return "grant_unavailable";
    case "invalid_transition": return "invalid_transition";
    case "upload_too_large": return "upload_too_large";
    case "upload_busy": return "upload_busy";
    case "rate_limited": return "rate_limited";
    case "storage_unavailable": return "storage_unavailable";
    case "integrity_failure": return "integrity_failure";
    default: return "internal_error";
  }
}

/**
 * Decodes a JSON request body through a contract decoder. Returns
 * `{ ok: true, value }` on success and `{ ok: false }` for any malformed,
 * oversized, or type-invalid payload (which the caller reports as
 * `invalid_request`). No engine or side effect runs on the failure path.
 */
export function decodeJsonRequest<T>(
  request: FastifyRequest,
  decoder: Decoder<T>,
): { readonly ok: true; readonly value: T } | { readonly ok: false } {
  if (typeof request.body !== "string") return { ok: false };
  try {
    return { ok: true, value: decodeJsonText(request.body, decoder) };
  } catch {
    return { ok: false };
  }
}

/** Authenticated session for a JSON request, if the cookie is valid. */
export function jsonSession(request: FastifyRequest, sessions: OperatorSessions): OperatorSession | undefined {
  return sessions.authenticate(request.headers.cookie);
}

/** JSON variant of `requireOperator`: missing session is a 401 envelope, never a redirect. */
export function jsonRequireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: OperatorSessions,
): OperatorSession | undefined {
  const session = jsonSession(request, sessions);
  if (session === undefined) sendError(reply, "unauthenticated");
  return session;
}

/**
 * Defense-in-depth origin check (design section 7.2). The CSRF header remains
 * the primary control; Origin and Fetch Metadata are validated only when the
 * browser actually sends them, so non-browser clients (curl, tests, scripts)
 * are unaffected. Same-origin means the browser origin equals the host the
 * Fastify server sees (protocol + Host header), which is the production
 * topology where Fastify serves both the UI and the /api. Development may
 * supply the Vite dev origin(s) via `allowedOrigins` when the dev proxy
 * rewrites the Host header.
 */
export function originAllowed(request: FastifyRequest, allowedOrigins: readonly string[] | undefined): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) return true;
  const host = request.headers.host;
  if (typeof host === "string" && host.length > 0 && origin === `${request.protocol}://${host}`) return true;
  if (allowedOrigins?.includes(origin) === true) return true;
  return false;
}

/**
 * Fetch Metadata defense-in-depth: a cross-site request (an attacker page on
 * another site) is rejected even before the CSRF token is consulted. Absent
 * or benign site values are accepted; the CSRF header still gates them.
 */
export function fetchMetadataAllowed(request: FastifyRequest): boolean {
  return request.headers["sec-fetch-site"] !== "cross-site";
}

/**
 * JSON mutation guard: requires a valid session cookie (401), the CSRF token
 * carried in the `X-CSRF-Token` header (403 when missing or wrong), and, when
 * the browser sends them, an acceptable Origin and Fetch Metadata (403).
 * A 403 never invalidates the session.
 */
export function jsonRequireMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: OperatorSessions,
  allowedOrigins?: readonly string[],
): OperatorSession | undefined {
  const session = jsonRequireSession(request, reply, sessions);
  if (session === undefined) return undefined;
  const presented = request.headers[CSRF_HEADER];
  if (typeof presented !== "string" || !sessions.verifyCsrf(session, presented)) {
    sendError(reply, "forbidden");
    return undefined;
  }
  if (!originAllowed(request, allowedOrigins) || !fetchMetadataAllowed(request)) {
    sendError(reply, "forbidden");
    return undefined;
  }
  return session;
}
