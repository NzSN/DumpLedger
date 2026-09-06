import type { FixedWindowRateLimiter } from "../../auth/rate-limiter.js";
import type { UploadAdmission } from "../../intake/upload-admission.js";
import type { UploadSession } from "../../intake/upload-session.js";
import type { HttpServerOptions } from "../server.js";

/**
 * Shared per-server state handed to every /api/v1 route module. The session
 * auth and rate-limiting instances are created once by `buildHttpServer`
 * (the composition root). The server-rendered HTML helpers that lived here
 * were deleted with the legacy pages in the Phase-5 cutover.
 */
export interface RouteContext {
  readonly options: HttpServerOptions;
  readonly now: () => number;
  readonly upload: UploadSession;
  readonly uploadAdmission: UploadAdmission;
  readonly loginRateLimiter: FixedWindowRateLimiter;
  readonly uploadGrantRateLimiter: FixedWindowRateLimiter;
}
