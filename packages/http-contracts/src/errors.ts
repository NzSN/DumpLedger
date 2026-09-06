/**
 * Stable HTTP error envelope for the DumpLedger browser/Fastify interface
 * (design section 7.1).
 *
 * Every error response is `{ error: { code, message, retryable } }`. `code` is
 * one of the stable codes below, `message` is safe operator-facing text (never
 * a filesystem path, SQL error, grant secret, password, dump content, or stack
 * trace), and `retryable` tells the caller whether repeating the same request
 * may succeed.
 */

import {
  booleanField,
  field,
  object,
  oneOf,
  optional,
  text,
  type Decoder,
  type Shape,
} from "./decode.js";

export const HTTP_ERROR_CODES = [
  "invalid_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "invalid_transition",
  "grant_unavailable",
  "upload_too_large",
  "upload_busy",
  "rate_limited",
  "storage_unavailable",
  "integrity_failure",
  "internal_error",
] as const;

export type HttpErrorCode = (typeof HTTP_ERROR_CODES)[number];

/** Longest safe operator-facing error message. */
export const MAX_ERROR_MESSAGE_LENGTH = 300;

export interface HttpError {
  readonly code: HttpErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ErrorResponse {
  readonly error: HttpError;
}

export function isHttpErrorCode(value: unknown): value is HttpErrorCode {
  return typeof value === "string" && (HTTP_ERROR_CODES as readonly string[]).includes(value);
}

/** Single-line, content-free operator-facing message. */
export function decodeSafeMessage(value: unknown, path: string): string {
  return text({ max: MAX_ERROR_MESSAGE_LENGTH, label: "error message" })(value, path);
}

export const decodeHttpError: Decoder<HttpError> = (value, path) => {
  const decoded = object(
    {
      code: field(oneOf(HTTP_ERROR_CODES, "error code")),
      message: field((entry, entryPath) => decodeSafeMessage(entry, entryPath)),
      retryable: field(booleanField()),
    },
    "error",
  )(value, path);
  return { code: decoded.code, message: decoded.message, retryable: decoded.retryable };
};

export const decodeErrorResponse: Decoder<ErrorResponse> = (value, path) => {
  const decoded = object(
    {
      error: field((entry, entryPath) => decodeHttpError(entry, entryPath)),
    },
    "error response",
  )(value, path);
  return { error: decoded.error };
};

export function encodeHttpError(error: HttpError): Record<string, unknown> {
  return { code: error.code, message: error.message, retryable: error.retryable };
}

export function encodeErrorResponse(response: ErrorResponse): Record<string, unknown> {
  return { error: encodeHttpError(response.error) };
}

/** Kept for callers that decode a bare `{ code, message, retryable }` block. */
export const errorShape = {
  code: field(oneOf(HTTP_ERROR_CODES, "error code")),
  message: field((entry, entryPath) => decodeSafeMessage(entry, entryPath)),
  retryable: field(booleanField()),
} as const satisfies Shape;

export type ErrorShape = typeof errorShape;

export const errorCodeDecoder: Decoder<HttpErrorCode> = oneOf(HTTP_ERROR_CODES, "error code");
export const retryableDecoder: Decoder<boolean> = booleanField();
export const optionalErrorMessageDecoder: Decoder<string | undefined> = optional(
  text({ max: MAX_ERROR_MESSAGE_LENGTH, label: "error message" }),
)["decode"];
