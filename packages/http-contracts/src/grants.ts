/**
 * Grant contracts (design section 7.5).
 *
 *   POST /api/v1/cases/:caseId/grants       <- CreateGrantRequest
 *                                            -> CreateGrantResponse
 *   POST /api/v1/grants/:grantId/revoke     -> RevokeGrantResponse
 *
 * `uploadPath` is relative: the frontend builds the shareable URL from
 * `location.origin`, so an attacker-controlled `Host` header never influences
 * where the grant link points. The one-time grant secret travels only in the
 * fragment of that path (`/upload#grant=<base64url-secret>`); fragments are
 * never sent to the server or written to request-target access logs.
 */

import {
  canonicalDecimal,
  canonicalTimestamp,
  fail,
  field,
  identifierField,
  integerField,
  object,
  text,
  type Decoder,
} from "./decode.js";
import { grantStateDecoder, type GrantState } from "./vocab.js";

/** Longest grant validity accepted from an operator (365 days). */
export const MAX_GRANT_VALID_FOR_HOURS = 24 * 366;
export const MAX_UPLOAD_PATH_LENGTH = 512;
export const MIN_GRANT_SECRET_BASE64URL_LENGTH = 16;

/** `POST /api/v1/cases/:caseId/grants` body. */
export interface CreateGrantRequest {
  /** Whole hours the grant stays valid for a new upload. */
  readonly validForHours: number;
  /** Original-byte ceiling for the upload, in canonical decimal form on the wire. */
  readonly maxBytes: bigint;
}

export const decodeCreateGrantRequest: Decoder<CreateGrantRequest> = (value, path) => {
  const decoded = object(
    {
      validForHours: field(integerField({ min: 1, max: MAX_GRANT_VALID_FOR_HOURS, label: "validForHours" })),
      maxBytes: field(canonicalDecimal({ label: "maxBytes", positive: true })),
    },
    "create grant request",
  )(value, path);
  return { validForHours: decoded.validForHours, maxBytes: decoded.maxBytes };
};

export function encodeCreateGrantRequest(request: CreateGrantRequest): Record<string, unknown> {
  return { validForHours: request.validForHours, maxBytes: request.maxBytes.toString() };
}

/** One grant row with its owning case, as returned by grant mutations. */
export interface GrantRecord {
  readonly grantId: string;
  readonly caseId: string;
  readonly state: GrantState;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly maxBytes: bigint;
}

export type IssuedGrant = GrantRecord & { readonly state: "issued" };
export type RevokedGrant = GrantRecord & { readonly state: "revoked" };

export const decodeGrantRecord: Decoder<GrantRecord> = (value, path) => {
  const decoded = object(
    {
      grantId: field(identifierField("grantId")),
      caseId: field(identifierField("caseId")),
      state: field(grantStateDecoder),
      createdAt: field(canonicalTimestamp("createdAt")),
      expiresAt: field(canonicalTimestamp("expiresAt")),
      maxBytes: field(canonicalDecimal({ label: "maxBytes" })),
    },
    "grant record",
  )(value, path);
  return {
    grantId: decoded.grantId,
    caseId: decoded.caseId,
    state: decoded.state,
    createdAt: decoded.createdAt,
    expiresAt: decoded.expiresAt,
    maxBytes: decoded.maxBytes,
  };
};

export function encodeGrantRecord(grant: GrantRecord): Record<string, unknown> {
  return {
    grantId: grant.grantId,
    caseId: grant.caseId,
    state: grant.state,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    maxBytes: grant.maxBytes.toString(),
  };
}

/**
 * One-time relative upload link of the form `/upload#grant=<base64url-secret>`.
 * Validates the structural guarantees the backend promises: relative, no
 * scheme, forward slashes only, no control characters, and a bounded
 * base64url secret in the fragment.
 */
export function decodeUploadPath(value: unknown, path: string): string {
  const decoded = text({ max: MAX_UPLOAD_PATH_LENGTH, label: "upload path", pattern: /^\S+$/ })(value, path);
  if (!decoded.startsWith("/")) fail(path, "upload path must be relative");
  if (decoded.startsWith("//")) fail(path, "upload path must not be protocol-relative");
  if (decoded.includes("://")) fail(path, "upload path must not contain a scheme");
  if (decoded.includes("\\")) fail(path, "upload path must use forward slashes");
  const match = /^\/upload#grant=([A-Za-z0-9_-]+)$/.exec(decoded);
  if (match === null) fail(path, "upload path must be a /upload#grant=<secret> link");
  const secret = match[1];
  if (secret === undefined || secret.length < MIN_GRANT_SECRET_BASE64URL_LENGTH) {
    fail(path, "upload path grant secret is too short");
  }
  return decoded;
}

/** Grant-creation success: metadata plus the one-time relative upload link. */
export interface CreateGrantResponse {
  readonly grant: IssuedGrant;
  readonly uploadPath: string;
}

export const decodeCreateGrantResponse: Decoder<CreateGrantResponse> = (value, path) => {
  const decoded = object(
    {
      grant: field((entry, entryPath) => {
        const grant = decodeGrantRecord(entry, entryPath);
        if (grant.state !== "issued") fail(entryPath, "created grant must be issued");
        return { ...grant, state: "issued" as const };
      }),
      uploadPath: field(decodeUploadPath),
    },
    "create grant response",
  )(value, path);
  return { grant: decoded.grant, uploadPath: decoded.uploadPath };
};

export function encodeCreateGrantResponse(response: CreateGrantResponse): Record<string, unknown> {
  return { grant: encodeGrantRecord(response.grant), uploadPath: response.uploadPath };
}

/** Revoke success is the resulting revoked grant (server state). */
export interface RevokeGrantResponse {
  readonly grant: RevokedGrant;
}

export const decodeRevokeGrantResponse: Decoder<RevokeGrantResponse> = (value, path) => {
  const decoded = object(
    {
      grant: field((entry, entryPath) => {
        const grant = decodeGrantRecord(entry, entryPath);
        if (grant.state !== "revoked") fail(entryPath, "revoked grant must be revoked");
        return { ...grant, state: "revoked" as const };
      }),
    },
    "revoke grant response",
  )(value, path);
  return { grant: decoded.grant };
};

export function encodeRevokeGrantResponse(response: RevokeGrantResponse): Record<string, unknown> {
  return { grant: encodeGrantRecord(response.grant) };
}
