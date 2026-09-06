/**
 * Public upload contracts (design section 7.6).
 *
 * Bytes travel as raw `application/octet-stream`; only the grant secret and
 * the base64url-encoded original filename cross in headers:
 *
 *   POST /api/v1/uploads
 *   Content-Type: application/octet-stream
 *   X-Upload-Grant: <base64url-secret>
 *   X-Dump-Filename-Base64url: <UTF-8 filename encoded as base64url>
 *
 * The shareable link carries the secret only in the URL fragment
 * (`/upload#grant=<base64url-secret>`), so it never reaches request-target
 * access logs. This module contains the pure UTF-8/base64url primitives used
 * by both the browser and the backend; it imports no DOM, Node, or engine
 * module.
 */

import {
  canonicalDecimal,
  DecodeError,
  fail,
  field,
  identifierField,
  object,
  oneOf,
  sha256Hex,
  text,
  type Decoder,
} from "./decode.js";

export const X_UPLOAD_GRANT_HEADER = "x-upload-grant";
export const X_DUMP_FILENAME_HEADER = "x-dump-filename-base64url";
export const UPLOAD_FALLBACK_FILENAME = "upload.dmp";

export const MAX_UPLOAD_GRANT_SECRET_LENGTH = 256;
export const MAX_DUMP_FILENAME_HEADER_LENGTH = 4096;
export const MAX_UPLOAD_FILENAME_LENGTH = 1024;

export const UPLOAD_GRANT_SECRET_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_LOOKUP = new Map<string, number>(
  [...BASE64URL_ALPHABET].map((character, index) => [character, index]),
);

/** Encodes UTF-8 bytes to unpadded base64url text. */
export function bytesToBase64Url(bytes: readonly number[]): string {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset] ?? 0;
    const second = bytes[offset + 1] ?? 0;
    const third = bytes[offset + 2] ?? 0;
    const group = (first << 16) | (second << 8) | third;
    output += BASE64URL_ALPHABET[(group >> 18) & 63] as string;
    output += BASE64URL_ALPHABET[(group >> 12) & 63] as string;
    if (offset + 1 < bytes.length) output += BASE64URL_ALPHABET[(group >> 6) & 63] as string;
    if (offset + 2 < bytes.length) output += BASE64URL_ALPHABET[group & 63] as string;
  }
  return output;
}

/** Decodes unpadded base64url text to bytes; throws {@link DecodeError} on bad input. */
export function base64UrlToBytes(value: string, path = "$"): number[] {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail(path, "value is not base64url text");
  }
  const length = value.length;
  if (length % 4 === 1) fail(path, "base64url length is invalid");
  const bytes: number[] = [];
  for (let offset = 0; offset < length; offset += 4) {
    const c0 = charTo6(value[offset]);
    const c1 = charTo6(value[offset + 1]);
    const c2 = offset + 2 < length ? charTo6(value[offset + 2]) : 0;
    const c3 = offset + 3 < length ? charTo6(value[offset + 3]) : 0;
    bytes.push((c0 << 2) | (c1 >> 4));
    if (offset + 2 < length) bytes.push(((c1 & 0x0f) << 4) | (c2 >> 2));
    if (offset + 3 < length) bytes.push(((c2 & 0x03) << 6) | c3);
  }
  return bytes;
}

function charTo6(character: string | undefined): number {
  if (character === undefined) return 0;
  const value = BASE64URL_LOOKUP.get(character);
  if (value === undefined) throw new DecodeError("$", "value is not base64url text");
  return value;
}

/** Encodes a JavaScript string as UTF-8 bytes (surrogate pairs included). */
export function utf8Encode(input: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    let code = input.charCodeAt(index) as number;
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < input.length) {
      const low = input.charCodeAt(index + 1) as number;
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        index += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/** Strictly decodes UTF-8 bytes to a string; throws {@link DecodeError} on malformed input. */
export function utf8Decode(bytes: readonly number[], path = "$"): string {
  let output = "";
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index] as number;
    if (first < 0x80) {
      output += String.fromCharCode(first);
      index += 1;
      continue;
    }
    let code: number;
    let extra: number;
    let minimum: number;
    if (first >= 0xc2 && first <= 0xdf) {
      code = first & 0x1f;
      extra = 1;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      code = first & 0x0f;
      extra = 2;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      code = first & 0x07;
      extra = 3;
      minimum = 0x10000;
    } else {
      throw new DecodeError(path, "invalid UTF-8");
    }
    if (index + extra >= bytes.length) throw new DecodeError(path, "invalid UTF-8");
    for (let step = 1; step <= extra; step += 1) {
      const continuation = bytes[index + step];
      if (continuation === undefined || (continuation & 0xc0) !== 0x80) {
        throw new DecodeError(path, "invalid UTF-8");
      }
      code = (code << 6) | (continuation & 0x3f);
    }
    if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      throw new DecodeError(path, "invalid UTF-8");
    }
    index += extra + 1;
    if (code > 0xffff) {
      code -= 0x10000;
      output += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else {
      output += String.fromCharCode(code);
    }
  }
  return output;
}

/**
 * Encodes a UTF-8 filename as an HTTP-safe base64url header value. Any JS
 * string (including non-ASCII and emoji) round-trips through
 * {@link decodeFilenameBase64url}.
 */
export function encodeFilenameBase64url(filename: string): string {
  return bytesToBase64Url(utf8Encode(filename));
}

/** True when a decoded filename is safe to display and store. */
export function isSafeUploadFilename(filename: string): boolean {
  if (filename.length === 0 || filename.length > MAX_UPLOAD_FILENAME_LENGTH) return false;
  if (/[\u0000-\u001f\u007f]/.test(filename)) return false;
  if (filename.includes("/") || filename.includes("\\")) return false;
  return true;
}

/**
 * Decodes and validates the `X-Dump-Filename-Base64url` header value. Throws
 * {@link DecodeError} on malformed base64url, invalid UTF-8, or an unsafe
 * filename; the backend route falls back to {@link UPLOAD_FALLBACK_FILENAME}.
 */
export function decodeFilenameBase64url(headerValue: unknown, path = "$.x-dump-filename-base64url"): string {
  if (typeof headerValue !== "string" || headerValue.length === 0) {
    fail(path, "filename header must be a non-empty string");
  }
  if ((headerValue as string).length > MAX_DUMP_FILENAME_HEADER_LENGTH) {
    fail(path, "filename header exceeds the length limit");
  }
  const bytes = base64UrlToBytes(headerValue as string, path);
  if (bytes.length === 0) fail(path, "filename header decodes to no bytes");
  let filename: string;
  try {
    filename = utf8Decode(bytes, path);
  } catch {
    fail(path, "filename is not valid UTF-8");
  }
  if (!isSafeUploadFilename(filename)) {
    fail(path, "filename is empty, oversized, or contains unsafe characters");
  }
  return filename;
}

/** Decodes the `X-Upload-Grant` bearer header on the backend. */
export function decodeUploadGrantSecret(value: unknown, path = "$.x-upload-grant"): string {
  if (typeof value !== "string") fail(path, "grant secret must be a string");
  const decoded = text({ max: MAX_UPLOAD_GRANT_SECRET_LENGTH, label: "grant secret", pattern: UPLOAD_GRANT_SECRET_PATTERN })(
    value,
    path,
  );
  return decoded;
}

/** Parses the uploader fragment (`#grant=<base64url-secret>`); null when absent. */
export function parseUploadFragment(fragment: string): string | null {
  if (typeof fragment !== "string") return null;
  const match = /^#grant=([A-Za-z0-9_-]{16,256})$/.exec(fragment);
  return match === null ? null : (match[1] as string);
}

/** 201 body: bytes sealed and possibly post-processed to available or rejected. */
export const UPLOAD_COMPLETE_PHASES = ["sealed", "available", "rejected"] as const;
export type UploadCompletePhase = (typeof UPLOAD_COMPLETE_PHASES)[number];

export interface UploadCompleteResponse {
  readonly dumpId: string;
  readonly phase: UploadCompletePhase;
  readonly byteSize: bigint;
  readonly sha256: string;
}

export const decodeUploadCompleteResponse: Decoder<UploadCompleteResponse> = (value, path) => {
  const decoded = object(
    {
      dumpId: field(identifierField("dumpId")),
      phase: field(oneOf(UPLOAD_COMPLETE_PHASES, "upload phase")),
      byteSize: field(canonicalDecimal({ label: "byteSize" })),
      sha256: field(sha256Hex("sha256")),
    },
    "upload complete response",
  )(value, path);
  return {
    dumpId: decoded.dumpId,
    phase: decoded.phase,
    byteSize: decoded.byteSize,
    sha256: decoded.sha256,
  };
};

export function encodeUploadCompleteResponse(response: UploadCompleteResponse): Record<string, unknown> {
  return {
    dumpId: response.dumpId,
    phase: response.phase,
    byteSize: response.byteSize.toString(),
    sha256: response.sha256,
  };
}

/** 202 body: bytes sealed with post-processing queued or requiring recovery. */
export const UPLOAD_PROCESSING_STATES = ["retry-queued", "recovery-required"] as const;
export type UploadProcessingState = (typeof UPLOAD_PROCESSING_STATES)[number];

export interface UploadQueuedResponse {
  readonly dumpId: string;
  readonly byteSize: bigint;
  readonly sha256: string;
  readonly processing: UploadProcessingState;
}

export const decodeUploadQueuedResponse: Decoder<UploadQueuedResponse> = (value, path) => {
  const decoded = object(
    {
      dumpId: field(identifierField("dumpId")),
      byteSize: field(canonicalDecimal({ label: "byteSize" })),
      sha256: field(sha256Hex("sha256")),
      processing: field(oneOf(UPLOAD_PROCESSING_STATES, "upload processing state")),
    },
    "upload queued response",
  )(value, path);
  return {
    dumpId: decoded.dumpId,
    byteSize: decoded.byteSize,
    sha256: decoded.sha256,
    processing: decoded.processing,
  };
};

export function encodeUploadQueuedResponse(response: UploadQueuedResponse): Record<string, unknown> {
  return {
    dumpId: response.dumpId,
    byteSize: response.byteSize.toString(),
    sha256: response.sha256,
    processing: response.processing,
  };
}
