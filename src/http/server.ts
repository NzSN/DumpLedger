import Fastify, { type FastifyInstance } from "fastify";
import type { Readable } from "node:stream";

import type {
  CaseAction,
  CaseDetailResponse,
  CaseSearchParams,
  CaseSearchResponse,
  CaseSummary,
  DashboardResponse,
  DumpDetailResponse,
  GrantRecord,
  TransitionResponse,
} from "@dump-ledger/http-contracts";
import { FixedWindowRateLimiter } from "../auth/rate-limiter.js";
import { OperatorSessions } from "../auth/sessions.js";
import { UploadAdmission } from "../intake/upload-admission.js";
import type { UploadPostProcessor } from "../intake/intake-facade.js";
import type { PostProcessingQueue } from "../intake/post-processing-queue.js";
import { UploadSession, type UploadByteSink, type UploadLifecyclePort } from "../intake/upload-session.js";
import type { RuntimeJobSnapshot } from "./runtime-jobs.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerCaseRoutes } from "./routes/case-routes.js";
import type { RouteContext } from "./routes/common.js";
import { registerCustomerRoutes } from "./routes/customer-routes.js";
import { registerDumpRoutes } from "./routes/dump-routes.js";
import { registerGrantRoutes } from "./routes/grant-routes.js";
import { registerOperationRoutes } from "./routes/operation-routes.js";
import { registerUploadRoutes } from "./routes/upload-routes.js";
import { registerStaticWeb } from "./static-web.js";

type MutationResult = { readonly ok: true; readonly id?: string; readonly secret?: string } | { readonly ok: false; readonly code: string };

export type CaseTransitionOutcome =
  | { readonly ok: true; readonly response: TransitionResponse }
  | { readonly ok: false; readonly code: string };

/**
 * Browser use-case port. There is no global `snapshot()`: every route is
 * served by one of the bounded query methods below, so no endpoint ships the
 * whole ledger projection to the browser (design section 10).
 */
export interface HttpApplicationPort {
  createCustomer(displayName: string): MutationResult;
  createCase(customerId: string, title: string): MutationResult;
  issueGrant(caseId: string, expiresAt: number, maxBytes: bigint): MutationResult;
  revokeGrant(grantId: string): MutationResult;
  setRetention(dumpId: string, purgeAt: string): MutationResult;
  caseManifest(caseId: string): unknown;
  openDownload(dumpId: string): { readonly phase: string; readonly byteSize: bigint; readonly bytes: Readable } | undefined;
  operations(): { readonly integrityErrors: readonly string[] };
  dashboard(): DashboardResponse;
  searchCases(params: CaseSearchParams): CaseSearchResponse;
  caseSummary(caseId: string): CaseSummary | undefined;
  caseDetail(caseId: string): CaseDetailResponse | undefined;
  transitionCase(caseId: string, action: CaseAction): CaseTransitionOutcome | undefined;
  dumpDetail(dumpId: string): DumpDetailResponse | undefined;
  grantRecord(grantId: string): GrantRecord | undefined;
}

export interface HttpServerOptions {
  readonly application: HttpApplicationPort;
  readonly sessions: OperatorSessions;
  readonly uploadLifecycle: UploadLifecyclePort;
  readonly uploadSink: UploadByteSink;
  readonly now?: () => number;
  readonly uploadPostProcessor?: UploadPostProcessor;
  readonly postProcessingQueue?: PostProcessingQueue;
  readonly uploadAdmission?: UploadAdmission;
  readonly maxConcurrentUploads?: number;
  readonly loginRateLimiter?: FixedWindowRateLimiter;
  readonly uploadGrantRateLimiter?: FixedWindowRateLimiter;
  readonly secureDeployment?: boolean;
  readonly runtimeJobs?: readonly { snapshot(): RuntimeJobSnapshot }[];
  /** Directory containing the Vite production build (defaults to `<cwd>/dist/web`). */
  readonly webRoot?: string;
  /**
   * Additional trusted browser origins for the Origin defense-in-depth check
   * on authenticated mutations (design section 7.2). Production deployments
   * normally omit this: the browser and the API share one origin. Development
   * can add the Vite dev origin when the dev proxy rewrites the Host header.
   */
  readonly allowedOrigins?: readonly string[];
}

/**
 * Production Content-Security-Policy (design section 9). Vite emits external
 * hashed modules only, so no inline script/style allowance is needed. The
 * development HMR story is separate and never permitted here.
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export function buildHttpServer(options: HttpServerOptions): FastifyInstance {
  const server = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  const upload = new UploadSession(options.uploadLifecycle, options.uploadSink);
  const now = options.now ?? Date.now;
  const uploadAdmission = options.uploadAdmission ?? new UploadAdmission(options.maxConcurrentUploads ?? 2);
  const loginRateLimiter = options.loginRateLimiter ?? new FixedWindowRateLimiter({ limit: 10, windowMs: 5 * 60_000, maxKeys: 2_048, now });
  const uploadGrantRateLimiter = options.uploadGrantRateLimiter ?? new FixedWindowRateLimiter({ limit: 30, windowMs: 60_000, maxKeys: 4_096, now });

  // Parser order matters. application/json is decoded by the /api/v1 request
  // adapters (they never parse the body themselves) and octet-stream feeds the
  // raw upload byte path. The catch-all string parser guarantees any mutation
  // surfaces the stable 401/403 envelope first, even when the client omits or
  // mislabels Content-Type. The legacy urlencoded HTML-form parser is gone
  // with the deleted server-rendered pages.
  server.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));
  server.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  server.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => done(null, body));

  server.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", PRODUCTION_CSP);
    // Hashed assets set their own immutable cache header in the static route;
    // every other response (HTML shell, JSON, uploads, downloads) is no-store.
    if (!request.url.startsWith("/assets/")) reply.header("Cache-Control", "no-store");
    if (options.secureDeployment === true) reply.header("Strict-Transport-Security", "max-age=31536000");
    return payload;
  });

  server.get("/health", async () => ({ status: "ok" }));

  // Shared per-server state for every /api/v1 route module.
  const ctx: RouteContext = { options, now, upload, uploadAdmission, loginRateLimiter, uploadGrantRateLimiter };
  registerAuthRoutes(server, ctx);
  registerCustomerRoutes(server, ctx);
  registerCaseRoutes(server, ctx);
  registerGrantRoutes(server, ctx);
  registerDumpRoutes(server, ctx);
  registerOperationRoutes(server, ctx);
  registerUploadRoutes(server, ctx);

  // The React build is mounted at the final browser routes last; nothing is
  // registered after this that could shadow an /api or /health path.
  registerStaticWeb(server, options);

  return server;
}
