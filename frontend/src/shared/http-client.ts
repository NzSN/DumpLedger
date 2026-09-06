/**
 * shared/http-client.ts — the DumpLedger HTTP client (design section 8.1).
 *
 * This is a deep module with a small interface (`query` / `mutate` / `upload`).
 * Its implementation owns:
 *   - same-origin credentials (session cookie),
 *   - the in-memory CSRF header for mutations,
 *   - JSON encode/decode plus runtime response validation through the
 *     @dump-ledger/http-contracts decoders (one source of truth),
 *   - stable error conversion onto the contract error envelope,
 *   - AbortSignal cancellation,
 *   - 401 session invalidation (clears session via SessionProvider),
 *   - upload progress via XMLHttpRequest (fetch has no upload progress event).
 *
 * Feature modules must never call `fetch` or `XMLHttpRequest` directly, and
 * this client never automatically retries mutations or uploads: callers
 * refetch authoritative state after an uncertain result.
 */

import {
  CSRF_HEADER,
  X_DUMP_FILENAME_HEADER,
  X_UPLOAD_GRANT_HEADER,
  decodeErrorResponse,
  decodeJsonText,
  decodeUploadCompleteResponse,
  decodeUploadQueuedResponse,
  encodeFilenameBase64url,
  toJsonText,
  type Decoder,
  type HttpErrorCode,
  type UploadCompleteResponse,
  type UploadQueuedResponse,
} from "@dump-ledger/http-contracts";

/** Relative path within the application origin (dev proxy forwards /api). */
export interface QueryRequest<T> {
  readonly path: string;
  /** Runtime decoder for the success body (queries always return JSON). */
  readonly decoder: Decoder<T>;
  readonly signal?: AbortSignal;
}

export interface MutationRequest<T> {
  readonly path: string;
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON-serializable request payload; omit for bodiless mutations. */
  readonly body?: unknown;
  /**
   * Runtime decoder for the success body. Omit when the success is empty
   * (204 no content); the resolved value is then `undefined`.
   */
  readonly decoder?: Decoder<T>;
  readonly signal?: AbortSignal;
}

export interface UploadRequest {
  readonly path: string;
  /** Raw bytes are streamed directly; never buffered or base64-encoded. */
  readonly file: Blob;
  /** Bearer value sent only in the X-Upload-Grant header. */
  readonly grant: string;
  /** Original filename; sent as a base64url header value by the client. */
  readonly filename: string;
  readonly signal?: AbortSignal;
}

export interface UploadObserver {
  /** Progress fraction in [0, 1]; only fires while the length is computable. */
  readonly onProgress?: (fraction: number) => void;
}

export type UploadSuccess =
  | { readonly kind: "complete"; readonly response: UploadCompleteResponse }
  | { readonly kind: "queued"; readonly response: UploadQueuedResponse };

export interface UploadHandle {
  readonly result: Promise<UploadSuccess>;
  abort(): void;
}

/** The narrow interface feature modules consume (design section 8.1). */
export interface DumpLedgerHttpClient {
  query<T>(request: QueryRequest<T>): Promise<T>;
  mutate<T>(request: MutationRequest<T>): Promise<T>;
  upload(request: UploadRequest, observer: UploadObserver): UploadHandle;
}

/** Session wiring used only by SessionProvider. */
export interface HttpClientSessionWiring {
  setCsrfTokenSource(source: (() => string | undefined) | undefined): void;
  setOnSessionExpired(handler: (() => void) | undefined): void;
}

export type SessionAwareHttpClient = DumpLedgerHttpClient & HttpClientSessionWiring;

export interface HttpRequestErrorOptions {
  readonly code: HttpErrorCode;
  /** HTTP status, or 0 for a transport failure with no HTTP response. */
  readonly status: number;
  readonly retryable: boolean;
  readonly path: string;
  readonly cause?: unknown;
}

/** Stable client-side error carrying the contract error code. */
export class HttpRequestError extends Error {
  readonly code: HttpErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly path: string;

  constructor(message: string, options: HttpRequestErrorOptions) {
    super(message);
    this.name = "HttpRequestError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
    this.path = options.path;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** Safe operator-facing text for an arbitrary thrown value. */
export function errorText(error: unknown, fallback = "The request failed."): string {
  if (error instanceof HttpRequestError && error.message.length > 0) return error.message;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback;
}

function statusToCode(status: number): HttpErrorCode {
  if (status === 400) return "invalid_request";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 413) return "upload_too_large";
  if (status === 429) return "rate_limited";
  if (status === 503) return "storage_unavailable";
  return "internal_error";
}

function fallbackMessage(code: HttpErrorCode): string {
  switch (code) {
    case "invalid_request":
      return "The request was invalid.";
    case "unauthenticated":
      return "Your session is no longer valid.";
    case "forbidden":
      return "This action is not allowed.";
    case "not_found":
      return "The requested resource was not found.";
    case "upload_too_large":
      return "The upload is too large.";
    case "rate_limited":
      return "Too many requests; try again shortly.";
    case "storage_unavailable":
      return "Storage is temporarily unavailable.";
    default:
      return "An unexpected server error occurred.";
  }
}

/** Reads an error response body; falls back to a status-derived envelope. */
async function readErrorResponse(response: Response, path: string): Promise<HttpRequestError> {
  try {
    const text = await response.text();
    const envelope = decodeJsonText(text, decodeErrorResponse);
    return new HttpRequestError(envelope.error.message, {
      code: envelope.error.code,
      status: response.status,
      retryable: envelope.error.retryable,
      path,
    });
  } catch {
    const code = statusToCode(response.status);
    return new HttpRequestError(fallbackMessage(code), {
      code,
      status: response.status,
      retryable: code === "rate_limited" || code === "storage_unavailable",
      path,
    });
  }
}

/** A body that fails contract decoding is a stable internal error. */
function unreadableResponse(path: string, status: number, cause: unknown): HttpRequestError {
  return new HttpRequestError("The server returned an unreadable response.", {
    code: "internal_error",
    status,
    retryable: false,
    path,
    cause,
  });
}

class FetchHttpClient implements SessionAwareHttpClient {
  private csrfTokenSource: (() => string | undefined) | undefined;
  private onSessionExpired: (() => void) | undefined;

  setCsrfTokenSource(source: (() => string | undefined) | undefined): void {
    this.csrfTokenSource = source;
  }

  setOnSessionExpired(handler: (() => void) | undefined): void {
    this.onSessionExpired = handler;
  }

  private handleUnauthenticated(): void {
    // 401 invalidates the session. The registered handler clears session state
    // and moves the user to /login; a 403 never reaches this path.
    try {
      this.onSessionExpired?.();
    } catch {
      // A session handler must never mask the original request error.
    }
  }

  async query<T>(request: QueryRequest<T>): Promise<T> {
    const queryInit: RequestInit = {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    };
    if (request.signal !== undefined) queryInit.signal = request.signal;
    let response: Response;
    try {
      response = await fetch(request.path, queryInit);
    } catch (cause) {
      throw this.transportError(request.path, cause);
    }
    if (!response.ok) {
      const error = await readErrorResponse(response, request.path);
      if (response.status === 401) this.handleUnauthenticated();
      throw error;
    }
    const text = await response.text();
    try {
      return decodeJsonText(text, request.decoder);
    } catch (cause) {
      throw unreadableResponse(request.path, response.status, cause);
    }
  }

  async mutate<T>(request: MutationRequest<T>): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    const csrfToken = this.csrfTokenSource?.();
    if (csrfToken !== undefined) headers[CSRF_HEADER] = csrfToken;
    const mutationInit: RequestInit = {
      method: request.method,
      credentials: "same-origin",
      headers,
    };
    if (request.body !== undefined) {
      headers["content-type"] = "application/json";
      mutationInit.body = toJsonText(request.body);
    }
    if (request.signal !== undefined) mutationInit.signal = request.signal;
    let response: Response;
    try {
      response = await fetch(request.path, mutationInit);
    } catch (cause) {
      throw this.transportError(request.path, cause);
    }
    if (!response.ok) {
      const error = await readErrorResponse(response, request.path);
      if (response.status === 401) this.handleUnauthenticated();
      throw error;
    }
    if (request.decoder === undefined) {
      // Empty-body success (204 no content).
      return undefined as T;
    }
    const text = await response.text();
    try {
      return decodeJsonText(text, request.decoder);
    } catch (cause) {
      throw unreadableResponse(request.path, response.status, cause);
    }
  }

  upload(request: UploadRequest, observer: UploadObserver): UploadHandle {
    const xhr = new XMLHttpRequest();
    let settled = false;

    const result = new Promise<UploadSuccess>((resolve, reject) => {
      xhr.open("POST", request.path);
      xhr.withCredentials = true;
      xhr.setRequestHeader("accept", "application/json");
      xhr.setRequestHeader("content-type", "application/octet-stream");
      xhr.setRequestHeader(X_UPLOAD_GRANT_HEADER, request.grant);
      xhr.setRequestHeader(X_DUMP_FILENAME_HEADER, encodeFilenameBase64url(request.filename));

      const settle = (error: Error | undefined, value?: UploadSuccess): void => {
        if (settled) return;
        settled = true;
        if (error === undefined) {
          if (value === undefined) reject(new Error("upload settled without a value"));
          else resolve(value);
        } else {
          reject(error);
        }
      };

      xhr.upload.addEventListener("progress", (event: ProgressEvent) => {
        if (!event.lengthComputable || event.total === 0) return;
        try {
          observer.onProgress?.(event.loaded / event.total);
        } catch {
          // Observer callbacks must never break the upload transport.
        }
      });

      xhr.addEventListener("abort", () => {
        settle(new DOMException("The upload was aborted.", "AbortError"));
      });

      xhr.addEventListener("error", () => {
        settle(
          new HttpRequestError("The upload connection failed.", {
            code: "internal_error",
            status: 0,
            retryable: false,
            path: request.path,
          }),
        );
      });

      xhr.addEventListener("load", () => {
        const status = xhr.status;
        try {
          if (status === 201) {
            settle(undefined, {
              kind: "complete",
              response: decodeJsonText(xhr.responseText, decodeUploadCompleteResponse),
            });
            return;
          }
          if (status === 202) {
            settle(undefined, {
              kind: "queued",
              response: decodeJsonText(xhr.responseText, decodeUploadQueuedResponse),
            });
            return;
          }
          const text = xhr.responseText;
          const error = ((): HttpRequestError => {
            try {
              const envelope = decodeJsonText(text, decodeErrorResponse);
              return new HttpRequestError(envelope.error.message, {
                code: envelope.error.code,
                status,
                retryable: envelope.error.retryable,
                path: request.path,
              });
            } catch {
              const code = statusToCode(status);
              return new HttpRequestError(fallbackMessage(code), {
                code,
                status,
                retryable: code === "rate_limited" || code === "storage_unavailable",
                path: request.path,
              });
            }
          })();
          settle(error);
        } catch (cause) {
          settle(unreadableResponse(request.path, status, cause));
        }
      });

      // The upload streams the File/Blob directly; no ArrayBuffer or base64.
      xhr.send(request.file);
    });

    if (request.signal !== undefined) {
      if (request.signal.aborted) xhr.abort();
      else {
        const onAbort = (): void => xhr.abort();
        request.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    return {
      result,
      abort: () => xhr.abort(),
    };
  }

  private transportError(path: string, cause: unknown): HttpRequestError {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      return new HttpRequestError("The request was cancelled.", {
        code: "internal_error",
        status: 0,
        retryable: false,
        path,
        cause,
      });
    }
    return new HttpRequestError("The request could not reach the server.", {
      code: "internal_error",
      status: 0,
      retryable: true,
      path,
      cause,
    });
  }
}

/** Creates the production client. Tests provide a fake adapter instead. */
export function createHttpClient(): SessionAwareHttpClient {
  return new FetchHttpClient();
}
