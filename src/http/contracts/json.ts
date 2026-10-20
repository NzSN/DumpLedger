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
import { verifyAnalyzerToken } from "../../auth/analyzer-token.js";
import type { OperatorSession, OperatorSessions } from "../../auth/sessions.js";
import { verifyWebhookAdminToken } from "../../auth/webhook-admin-token.js";
import type { HttpServerOptions } from "../server.js";

const HTTP_STATUS: Readonly<Record<HttpErrorCode, number>> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_transition: 409,
  grant_unavailable: 404,
  grant_slots_exhausted: 404,
  upload_too_large: 413,
  upload_busy: 503,
  rate_limited: 429,
  storage_unavailable: 503,
  integrity_failure: 500,
  internal_error: 500,
  symbol_identity_unreadable: 422,
  symbol_kind_unsupported: 409,
  symbol_too_large: 413,
};

/** Fixed safe operator-facing message per stable code (never derived from inputs). */
const MESSAGES: Readonly<Record<HttpErrorCode, string>> = {
  invalid_request: "The request was malformed.",
  unauthenticated: "Authentication is required.",
  forbidden: "Forbidden.",
  not_found: "Not found.",
  invalid_transition: "That action is not allowed from the current state.",
  grant_unavailable: "The upload grant is unavailable.",
  grant_slots_exhausted: "This upload link has no remaining upload slots.",
  upload_too_large: "The upload exceeded its allowed byte size.",
  upload_busy: "Upload processing is busy; try again shortly.",
  rate_limited: "Too many requests. Try again later.",
  storage_unavailable: "Storage is temporarily unavailable.",
  integrity_failure: "An internal integrity check failed.",
  internal_error: "An internal error occurred.",
  symbol_identity_unreadable: "The file carries no readable PDB or PE identity.",
  symbol_kind_unsupported: "That symbol artifact kind is not supported.",
  symbol_too_large: "The symbol artifact exceeds its allowed byte size.",
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

/** Which credential walked an analyzer-scoped read route. */
export type AnalyzerReadAuthChannel = "operator" | "analyzer-token";

/**
 * Analyzer-or-session guard for the read routes in the analyzer token's scope
 * (docs/analyzer-integration-design.md, "Analyzer tokens"). Pinned bearer
 * precedence, mirroring `authorizeSymbolIngest`: when the request carries any
 * `Authorization` header, ONLY the bearer token path is consulted — a
 * malformed header, a token that does not match the configured analyzer
 * digest, or a disabled token configuration is the same generic 401 envelope
 * the session guard sends, and it never falls through to the session cookie.
 * Without the header the operator session guard applies unchanged. Bearer
 * requests carry no cookie semantics, so no CSRF/Origin evidence applies on
 * that path. Every other mutation and every non-analyzer route keeps its own
 * guard; the analysis write-back POST is the one mutation in the analyzer
 * token's scope and uses {@link authorizeSessionOrAnalyzerMutation}.
 */
export function authorizeSessionOrAnalyzer(
  request: FastifyRequest,
  reply: FastifyReply,
  options: HttpServerOptions,
): AnalyzerReadAuthChannel | undefined {
  const authorization = request.headers.authorization;
  if (authorization === undefined) {
    return jsonRequireSession(request, reply, options.sessions) === undefined ? undefined : "operator";
  }
  // The scheme name is matched case-insensitively (HTTP auth semantics); the
  // token itself is exact and opaque, compared by sha256 digest only.
  const token = /^Bearer +(\S+)$/i.exec(authorization)?.[1];
  if (token === undefined || !verifyAnalyzerToken(options.analyzerTokenHash, token)) {
    sendError(reply, "unauthenticated");
    return undefined;
  }
  return "analyzer-token";
}

/**
 * Which credential walked an analyzer-scoped write-back mutation (the
 * analysis `POST`); the value set matches {@link AnalyzerReadAuthChannel}.
 */
export type AnalyzerMutationAuthChannel = AnalyzerReadAuthChannel;

/**
 * Analyzer-or-session guard for the one mutation in the analyzer token's
 * scope — the analysis write-back route (docs/analyzer-integration-design.md,
 * "Analyzer tokens" and "Analysis write-back", milestone AI3). Pinned bearer
 * precedence, mirroring `authorizeSymbolIngest`: when the request carries any
 * `Authorization` header, ONLY the bearer token path is consulted — a
 * malformed header, a token that does not match the configured analyzer
 * digest, or a disabled token configuration is the same generic 401 envelope
 * the session guard sends, and it never falls through to the session cookie.
 * Without the header the operator session+CSRF+Origin guard applies exactly
 * as before. Bearer requests carry no cookie semantics, so there is no
 * CSRF/Origin evidence to check on that path: a machine caller has no ambient
 * browser authority.
 */
export function authorizeSessionOrAnalyzerMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  options: HttpServerOptions,
): AnalyzerMutationAuthChannel | undefined {
  const authorization = request.headers.authorization;
  if (authorization === undefined) {
    return jsonRequireMutation(request, reply, options.sessions, options.allowedOrigins) === undefined ? undefined : "operator";
  }
  // The scheme name is matched case-insensitively (HTTP auth semantics); the
  // token itself is exact and opaque, compared by sha256 digest only.
  const token = /^Bearer +(\S+)$/i.exec(authorization)?.[1];
  if (token === undefined || !verifyAnalyzerToken(options.analyzerTokenHash, token)) {
    sendError(reply, "unauthenticated");
    return undefined;
  }
  return "analyzer-token";
}

/** Which credential walked a webhook-administration read route. */
export type WebhookAdminReadAuthChannel = "operator" | "webhook-admin-token";

/**
 * Webhook-admin-or-session guard for the two read routes in the webhook-admin
 * token's scope (docs/webhook-admin-token-design.md, "Authorization model";
 * milestone WH2). Pinned bearer precedence, mirroring
 * `authorizeSessionOrAnalyzer`: when the request carries any `Authorization`
 * header, ONLY the bearer token path is consulted — a malformed header, a
 * token that does not match the configured webhook-admin digest, or a
 * disabled token configuration is the same generic 401 envelope the session
 * guard sends, and it never falls through to the session cookie. Without the
 * header the operator session guard applies unchanged. Bearer requests carry
 * no cookie semantics, so no CSRF/Origin evidence applies on that path. Scope
 * is exactly the four `/api/v1/webhooks` routes; the analyzer token remains
 * rejected there.
 */
export function authorizeSessionOrWebhookAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  options: HttpServerOptions,
): WebhookAdminReadAuthChannel | undefined {
  const authorization = request.headers.authorization;
  if (authorization === undefined) {
    return jsonRequireSession(request, reply, options.sessions) === undefined ? undefined : "operator";
  }
  // The scheme name is matched case-insensitively (HTTP auth semantics); the
  // token itself is exact and opaque, compared by sha256 digest only.
  const token = /^Bearer +(\S+)$/i.exec(authorization)?.[1];
  if (token === undefined || !verifyWebhookAdminToken(options.webhookAdminTokenHash, token)) {
    sendError(reply, "unauthenticated");
    return undefined;
  }
  return "webhook-admin-token";
}

/**
 * Which credential walked a webhook-administration mutation (create or
 * delete); the value set matches {@link WebhookAdminReadAuthChannel}.
 */
export type WebhookAdminMutationAuthChannel = WebhookAdminReadAuthChannel;

/**
 * Webhook-admin-or-session guard for the mutation routes in the webhook-admin
 * token's scope — `POST /api/v1/webhooks` and
 * `DELETE /api/v1/webhooks/:webhookId` (docs/webhook-admin-token-design.md,
 * "Authorization model"; milestone WH2). Pinned bearer precedence, mirroring
 * `authorizeSessionOrAnalyzerMutation`: when the request carries any
 * `Authorization` header, ONLY the bearer token path is consulted — a
 * malformed header, a token that does not match the configured webhook-admin
 * digest, or a disabled token configuration is the same generic 401 envelope
 * the session guard sends, and it never falls through to the session cookie.
 * Without the header the operator session+CSRF+Origin guard applies exactly
 * as before. Bearer requests carry no cookie semantics, so there is no
 * CSRF/Origin evidence to check on that path: a machine caller has no ambient
 * browser authority.
 */
export function authorizeSessionOrWebhookAdminMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  options: HttpServerOptions,
): WebhookAdminMutationAuthChannel | undefined {
  const authorization = request.headers.authorization;
  if (authorization === undefined) {
    return jsonRequireMutation(request, reply, options.sessions, options.allowedOrigins) === undefined ? undefined : "operator";
  }
  // The scheme name is matched case-insensitively (HTTP auth semantics); the
  // token itself is exact and opaque, compared by sha256 digest only.
  const token = /^Bearer +(\S+)$/i.exec(authorization)?.[1];
  if (token === undefined || !verifyWebhookAdminToken(options.webhookAdminTokenHash, token)) {
    sendError(reply, "unauthenticated");
    return undefined;
  }
  return "webhook-admin-token";
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
