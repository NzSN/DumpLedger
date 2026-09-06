/**
 * features/uploads/upload-outcomes.ts — terminal outcome classification for
 * the public uploader (design section 7.6 and 7.1).
 *
 * The shared http-client resolves an upload to `UploadSuccess` (201 complete /
 * 202 queued) or rejects with a stable `HttpRequestError` (or an AbortError
 * when the caller cancels). This module maps those raw transport results onto
 * the bounded set of customer-facing outcomes the page renders:
 *
 *   201 available / sealed / rejected  -> complete
 *   202 retry-queued / recovery-required -> queued
 *   404 grant_unavailable (never reveals why) -> grant-unavailable
 *   413 upload_too_large -> too-large
 *   retryable errors (503 upload_busy / storage_unavailable, 429) -> retryable
 *   abort / transport failure / unknown -> uncertain (request a new link)
 *
 * No domain logic is duplicated here: the backend decides every outcome; this
 * module only translates its stable contract codes for presentation.
 */

import { HttpRequestError, type UploadSuccess } from "../../shared/http-client";
import type { UploadCompleteResponse, UploadQueuedResponse } from "@dump-ledger/http-contracts";

export type UploadOutcome =
  | { readonly kind: "complete"; readonly response: UploadCompleteResponse }
  | { readonly kind: "queued"; readonly response: UploadQueuedResponse }
  | { readonly kind: "grant-unavailable" }
  | { readonly kind: "too-large" }
  | { readonly kind: "retryable"; readonly message: string }
  | {
      readonly kind: "uncertain";
      readonly reason: "aborted" | "connection" | "unknown";
      readonly message: string;
    };

/** Maps a resolved upload (201/202) onto a terminal outcome. */
export function outcomeFromSuccess(success: UploadSuccess): UploadOutcome {
  if (success.kind === "complete") {
    return { kind: "complete", response: success.response };
  }
  return { kind: "queued", response: success.response };
}

/**
 * Maps a rejected upload onto an outcome. Retryable contract errors stay on
 * the form (the request never started, so the one-time grant is still valid);
 * every other failure is terminal because the grant may already be consumed.
 */
export function outcomeFromError(error: unknown): UploadOutcome {
  if (error instanceof DOMException && error.name === "AbortError") {
    return { kind: "uncertain", reason: "aborted", message: "The upload was cancelled." };
  }
  if (error instanceof HttpRequestError) {
    switch (error.code) {
      case "grant_unavailable":
        // 404 — the backend deliberately does not reveal whether the grant
        // was unknown, expired, revoked, consumed, or blocked by a closed case.
        return { kind: "grant-unavailable" };
      case "upload_too_large":
        return { kind: "too-large" };
      default:
        break;
    }
    if (error.retryable) {
      return { kind: "retryable", message: error.message };
    }
    if (error.status === 0) {
      // Transport failure: no HTTP response arrived, so the outcome is unknown.
      return { kind: "uncertain", reason: "connection", message: error.message };
    }
    return { kind: "uncertain", reason: "unknown", message: error.message };
  }
  return {
    kind: "uncertain",
    reason: "unknown",
    message: error instanceof Error ? error.message : "The upload could not be completed.",
  };
}
