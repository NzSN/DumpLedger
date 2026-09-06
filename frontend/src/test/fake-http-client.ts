/**
 * FakeHttpClient — an in-memory HTTP adapter that implements the exact
 * `SessionAwareHttpClient` interface (design section 8.1). Feature and shell
 * tests inject it through `App`; global `fetch`/`XMLHttpRequest` are never
 * mocked in tests.
 *
 * The fake mirrors the real client's observable contract:
 *   - a simulated 401 fires the registered session-expired handler and then
 *     throws a stable `HttpRequestError` (matching FetchHttpClient),
 *   - a simulated 403 never clears the session,
 *   - mutations carry the CSRF token read from the registered token source.
 *
 * Only the shell's session surface is modeled; unexpected requests throw so a
 * test that drifts out of the shell fails loudly instead of silently passing.
 */

import type { SessionResponse } from "@dump-ledger/http-contracts";
import {
  HttpRequestError,
  type MutationRequest,
  type QueryRequest,
  type SessionAwareHttpClient,
  type UploadHandle,
  type UploadObserver,
  type UploadRequest,
  type UploadSuccess,
} from "../shared/http-client";

export type FakeSessionMode =
  /** GET /api/v1/session answers from the in-memory session. */
  | "ok"
  /** GET /api/v1/session answers 401 (expired/absent cookie). */
  | "unauthorized"
  /** GET /api/v1/session answers 500 (server unreachable). */
  | "unreachable";

export interface RecordedCall {
  readonly kind: "query" | "mutate" | "upload";
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly csrfToken?: string;
}

export interface FakeHttpClientOptions {
  readonly password?: string;
}

/** Simulated session endpoint behavior under test control. */
export class FakeHttpClient implements SessionAwareHttpClient {
  /** Whether the simulated server currently holds an authenticated session. */
  authenticated = false;

  /** GET /api/v1/session behavior. */
  sessionMode: FakeSessionMode = "ok";

  /** DELETE /api/v1/session behavior: 204 (ok), 401 (expired), or 403 (denied). */
  deleteStatus: 204 | 401 | 403 = 204;

  /** Whether DELETE validates that a matching CSRF token was sent. */
  requireCsrf = true;

  /** Token the simulated server issued with the authenticated session. */
  readonly csrfToken = "test-session-csrf-token";
  readonly expiresAt = "2030-01-01T00:00:00.000Z";
  readonly password: string;

  readonly calls: RecordedCall[] = [];

  private csrfSource: (() => string | undefined) | undefined;
  private sessionExpiredHandler: (() => void) | undefined;

  constructor(options: FakeHttpClientOptions = {}) {
    this.password = options.password ?? "correct horse battery staple";
  }

  /** Grants an authenticated session without any HTTP call (reload simulation). */
  preAuthenticate(): void {
    this.authenticated = true;
  }

  /** Simulates the server dropping the session (expired cookie). */
  expireSession(): void {
    this.authenticated = false;
  }

  setCsrfTokenSource(source: (() => string | undefined) | undefined): void {
    this.csrfSource = source;
  }

  setOnSessionExpired(handler: (() => void) | undefined): void {
    this.sessionExpiredHandler = handler;
  }

  /** Fires the registered 401 handler exactly like the real client does. */
  private fireSessionExpired(): void {
    try {
      this.sessionExpiredHandler?.();
    } catch {
      // A session handler must never mask the original request error.
    }
  }

  private record(call: RecordedCall): void {
    this.calls.push(call);
  }

  private currentCsrf(): string | undefined {
    return this.csrfSource?.();
  }

  private sessionResponse(): SessionResponse {
    if (!this.authenticated) return { authenticated: false };
    return { authenticated: true, csrfToken: this.csrfToken, expiresAt: this.expiresAt };
  }

  private error(status: number, message: string, path: string): HttpRequestError {
    return new HttpRequestError(message, {
      code: status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : "internal_error",
      status,
      retryable: false,
      path,
    });
  }

  async query<T>(request: QueryRequest<T>): Promise<T> {
    this.record({ kind: "query", method: "GET", path: request.path });
    if (request.path !== "/api/v1/session") {
      throw new Error(`FakeHttpClient: unexpected query ${request.path}`);
    }
    if (this.sessionMode === "unreachable") {
      throw new HttpRequestError("The request could not reach the server.", {
        code: "internal_error",
        status: 0,
        retryable: true,
        path: request.path,
      });
    }
    if (this.sessionMode === "unauthorized") {
      this.fireSessionExpired();
      throw this.error(401, "The session is no longer valid.", request.path);
    }
    return this.sessionResponse() as T;
  }

  async mutate<T>(request: MutationRequest<T>): Promise<T> {
    const csrf = this.currentCsrf();
    this.record({
      kind: "mutate",
      method: request.method,
      path: request.path,
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(csrf === undefined ? {} : { csrfToken: csrf }),
    });

    if (request.path !== "/api/v1/session") {
      throw new Error(`FakeHttpClient: unexpected mutate ${request.method} ${request.path}`);
    }

    if (request.method === "POST") {
      const password = (request.body as { readonly password?: unknown } | undefined)?.password;
      if (password === this.password) {
        this.authenticated = true;
        return this.sessionResponse() as T;
      }
      // Wrong password: 401 like the backend; the client clears the session.
      this.fireSessionExpired();
      throw this.error(401, "The operator password is incorrect.", request.path);
    }

    if (request.method === "DELETE") {
      if (this.deleteStatus === 401) {
        this.fireSessionExpired();
        this.authenticated = false;
        throw this.error(401, "The session is no longer valid.", request.path);
      }
      if (this.deleteStatus === 403) {
        throw this.error(403, "Sign out is not permitted for this session.", request.path);
      }
      if (this.requireCsrf && csrf !== this.csrfToken) {
        throw this.error(403, "The CSRF token is missing or invalid.", request.path);
      }
      this.authenticated = false;
      return undefined as T;
    }

    throw new Error(`FakeHttpClient: unexpected session method ${request.method}`);
  }

  upload(_request: UploadRequest, observer: UploadObserver): UploadHandle {
    this.record({ kind: "upload", method: "POST", path: "/api/v1/uploads" });
    // Shell tests never upload; keep the seam typed but inert.
    observer.onProgress?.(0);
    const result = Promise.resolve<UploadSuccess>({
      kind: "queued",
      response: {
        dumpId: "dump-test",
        byteSize: 0n,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        processing: "retry-queued",
      },
    });
    return { result, abort: () => undefined };
  }
}
