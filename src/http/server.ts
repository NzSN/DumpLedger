import Fastify, { type FastifyInstance } from "fastify";
import type { Readable } from "node:stream";

import type {
  AnalysisListResponse,
  AnalysisReport,
  CaseAction,
  CaseDetailResponse,
  CaseSearchParams,
  CaseSearchResponse,
  CaseSummary,
  CustomerDetailResponse,
  CustomerListResponse,
  DashboardResponse,
  DumpCatalogParams,
  DumpCatalogResponse,
  DumpDetailResponse,
  EventFeedParams,
  EventFeedResponse,
  GrantQuotaResponse,
  GrantRecord,
  RecordAnalysisRequest,
  SymbolKind,
  SymbolListResponse,
  TransitionResponse,
} from "@dump-ledger/http-contracts";
import { FixedWindowRateLimiter } from "../auth/rate-limiter.js";
import { OperatorSessions } from "../auth/sessions.js";
import type { SymbolIngestAuthChannel } from "../domain/lifecycle.js";
import { UploadAdmission } from "../intake/upload-admission.js";
import { DEFAULT_UPLOAD_TIMEOUTS, validateUploadTimeouts, type UploadTimeouts } from "../intake/bounded-pipeline.js";
import type { UploadPostProcessor } from "../intake/intake-facade.js";
import type { PostProcessingQueue } from "../intake/post-processing-queue.js";
import { UploadSession, type UploadByteSink, type UploadLifecyclePort } from "../intake/upload-session.js";
import type { TransferManager } from "../transfer/manager.js";
import type { RuntimeJobSnapshot } from "./runtime-jobs.js";
import { registerAnalysisRoutes } from "./routes/analysis-routes.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerCaseRoutes } from "./routes/case-routes.js";
import type { RouteContext } from "./routes/common.js";
import { registerCustomerRoutes } from "./routes/customer-routes.js";
import { registerDumpCatalogRoutes } from "./routes/dump-catalog-routes.js";
import { registerDumpRoutes } from "./routes/dump-routes.js";
import { registerEventRoutes } from "./routes/event-routes.js";
import { registerGrantRoutes } from "./routes/grant-routes.js";
import { registerOperationRoutes } from "./routes/operation-routes.js";
import { registerTransferRoutes } from "./routes/transfer-routes.js";
import { registerUploadRoutes } from "./routes/upload-routes.js";
import type { ByteReader } from "../symbols/identity.js";
import { registerSymbolRoutes } from "./routes/symbol-routes.js";
import { registerSymbolAdminRoutes } from "./routes/symbol-admin-routes.js";
import { registerStaticWeb } from "./static-web.js";

type MutationResult = { readonly ok: true; readonly id?: string; readonly secret?: string } | { readonly ok: false; readonly code: string };

/** The identity pair one symbol ingest carries, fixed by the artifact kind
 * (docs/symbols-design.md, "Identity model"): a PDB its RSDS debug identity,
 * an EXE/DLL image its PE code identity. */
export type SymbolIngestIdentity =
  | { readonly kind: "pdb"; readonly debugFile: string; readonly debugId: string }
  | { readonly kind: "exe"; readonly codeFile: string; readonly codeId: string };

/** One sealed symbol ingest: the parsed identity plus the byte facts. */
export type SymbolIngestInput =
  | { readonly kind: "pdb"; readonly debugFile: string; readonly debugId: string; readonly artifactId: string; readonly byteSize: bigint; readonly sha256: string; readonly product?: string; readonly version?: string; readonly arch?: string; readonly ingestAuth: SymbolIngestAuthChannel }
  | { readonly kind: "exe"; readonly codeFile: string; readonly codeId: string; readonly artifactId: string; readonly byteSize: bigint; readonly sha256: string; readonly product?: string; readonly version?: string; readonly arch?: string; readonly ingestAuth: SymbolIngestAuthChannel };

export type CaseTransitionOutcome =
  | { readonly ok: true; readonly response: TransitionResponse }
  | { readonly ok: false; readonly code: string };

/**
 * Analysis write-back outcome (docs/analyzer-integration-design.md, "Analysis
 * write-back"; milestone AI3): the stored report plus whether the engine
 * resolved an identity replay and stored nothing new, or a stable failure
 * code for the route layer to map onto the shared error envelope.
 */
export type AnalysisRecordOutcome =
  | { readonly ok: true; readonly report: AnalysisReport; readonly replayed: boolean }
  | { readonly ok: false; readonly code: string };

/**
 * Browser use-case port. There is no global `snapshot()`: every route is
 * served by one of the bounded query methods below, so no endpoint ships the
 * whole ledger projection to the browser (design section 10).
 */
export interface HttpApplicationPort {
  createCustomer(displayName: string): MutationResult;
  customerDetail(customerId: string): CustomerDetailResponse | undefined;
  createCase(customerId: string, title: string): MutationResult;
  issueGrant(caseId: string, expiresAt: number, maxBytes: bigint, maxUploads?: number): MutationResult;
  /** Public grant-quota query (batch upload design); undefined hides unknown/revoked/expired secrets. */
  grantQuota(grantSecret: string): GrantQuotaResponse | undefined;
  revokeGrant(grantId: string): MutationResult;
  setRetention(dumpId: string, purgeAt: string): MutationResult;
  caseManifest(caseId: string): unknown;
  openDownload(dumpId: string): { readonly phase: string; readonly byteSize: bigint; readonly bytes: Readable } | undefined;
  operations(): { readonly integrityErrors: readonly string[] };
  dashboard(): DashboardResponse;
  /** `GET /api/v1/customers`: every customer (id + display name) for the analyzer's name resolution. */
  listCustomers(): CustomerListResponse;
  searchCases(params: CaseSearchParams): CaseSearchResponse;
  caseSummary(caseId: string): CaseSummary | undefined;
  caseDetail(caseId: string): CaseDetailResponse | undefined;
  transitionCase(caseId: string, action: CaseAction): CaseTransitionOutcome | undefined;
  dumpDetail(dumpId: string): DumpDetailResponse | undefined;
  grantRecord(grantId: string): GrantRecord | undefined;

  /* Dump catalog (docs/analyzer-integration-design.md, "Dump catalog
   * search"): read-only, SQLite-backed enumeration with keyset pagination;
   * `dumpsBySha256` is the exact content-hash lookup. Both throw
   * `DumpLedgerError` for malformed filters, mapped by the route layer. */
  searchDumps(params: DumpCatalogParams): DumpCatalogResponse;
  dumpsBySha256(sha256: string): DumpCatalogResponse;

  /* Event feed (docs/analyzer-integration-design.md, "Event feed"): the
   * read-only rowid cursor over the audit trail; a malformed cursor or case
   * filter throws `DumpLedgerError`, mapped by the route layer. */
  eventFeed(params: EventFeedParams): EventFeedResponse;

  /* Analysis write-back (docs/analyzer-integration-design.md, "Analysis
   * write-back"; milestone AI3): `recordAnalysis` records one analyzer
   * verdict pinned to the dump's sealed bytes, resolving an identity replay
   * to the stored report and enforcing MAX_ANALYSES_PER_DUMP before the
   * engine command runs; `listAnalyses` returns every stored report for one
   * dump, `undefined` for an unknown dump (which the route layer maps to
   * `not_found`). */
  recordAnalysis(dumpId: string, request: RecordAnalysisRequest): AnalysisRecordOutcome;
  listAnalyses(dumpId: string): AnalysisListResponse | undefined;

  /* Symbol store (docs/symbols-design.md): operator list + ingest lifecycle
   * + purge, and the unauthenticated symsrv read surface. */
  listSymbols(): SymbolListResponse;
  beginSymbolIngest(kind: SymbolKind): MutationResult;
  sealSymbolIngest(input: SymbolIngestInput): MutationResult & { readonly deduplicated?: boolean };
  failSymbolIngest(artifactId: string): void;
  appendSymbolBytes(artifactId: string, chunk: Uint8Array): void;
  syncSymbolStaging(artifactId: string): void;
  openSymbolStagingReader(artifactId: string): (ByteReader & { close(): void }) | undefined;
  purgeSymbol(artifactId: string): MutationResult;
  /** Symsrv read lookup: matches either identity pair (debug or code). */
  openSymbolArtifact(name: string, id: string):
    | { readonly byteSize: bigint; readonly stream: Readable }
    | undefined;
}

export interface HttpServerOptions {
  readonly application: HttpApplicationPort;
  readonly sessions: OperatorSessions;
  /**
   * Optional sha256 digest of the CI symbol-ingest bearer token
   * (docs/security-model.md, "CI symbol-ingest tokens"), already validated by
   * the composition root. Present enables `Authorization: Bearer <token>` on
   * POST /api/v1/symbols as an alternative to the operator session; absent or
   * undefined disables token auth entirely. No other route consults it.
   */
  readonly ingestTokenHash?: Buffer;
  /**
   * Optional sha256 digest of the analyzer bearer token
   * (docs/analyzer-integration-design.md, "Analyzer tokens"), already
   * validated by the composition root. Present enables
   * `Authorization: Bearer <token>` on the analyzer-scoped routes (catalog
   * list, by-sha256, dump detail/content, the audit event feed, and, since
   * milestone AI3, the analysis write-back POST) as an alternative to the
   * operator session cookie; absent or undefined disables the bearer path
   * entirely. The token's scope is exactly those routes: every other
   * mutation and non-analyzer route never consults it.
   */
  readonly analyzerTokenHash?: Buffer;
  readonly uploadLifecycle: UploadLifecyclePort;
  readonly uploadSink: UploadByteSink;
  readonly now?: () => number;
  readonly uploadPostProcessor?: UploadPostProcessor;
  readonly postProcessingQueue?: PostProcessingQueue;
  readonly uploadAdmission?: UploadAdmission;
  readonly maxConcurrentUploads?: number;
  readonly uploadTimeouts?: UploadTimeouts;
  readonly loginRateLimiter?: FixedWindowRateLimiter;
  readonly uploadGrantRateLimiter?: FixedWindowRateLimiter;
  readonly secureDeployment?: boolean;
  /**
   * Explicit proxy IP/CIDR allowlist. Empty/absent trusts no forwarding
   * headers. Fastify stops at the nearest untrusted address in the chain;
   * never enable blanket boolean trust, which lets a client-supplied prefix
   * change the IP used for rate limiting. Proxies must overwrite proto/host
   * and append the real peer to X-Forwarded-For (or overwrite it entirely).
   */
  readonly trustedProxies?: readonly string[];
  /**
   * Transfer manager backing the import/export operations routes
   * (import/export design, "HTTP and UI surface"), plus the exports directory
   * it was constructed with — the download route streams sealed bundles from
   * `<exportsDir>/<exportId>/bundle.tar` and the manager deliberately does not
   * expose its directory. Both must be provided together; when absent the
   * transfer routes are not registered and their paths 404 like any other
   * unknown /api path.
   */
  readonly transfer?: TransferManager;
  readonly transferExportsDir?: string;
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
  const timeouts = validateUploadTimeouts(options.uploadTimeouts ?? DEFAULT_UPLOAD_TIMEOUTS);
  const server = Fastify({
    logger: false,
    bodyLimit: 16 * 1024,
    trustProxy: options.trustedProxies === undefined ? false : [...options.trustedProxies],
    connectionTimeout: timeouts.idleMs,
    requestTimeout: timeouts.totalMs,
    routerOptions: { maxParamLength: 512 },
  });
  server.server.headersTimeout = Math.min(60_000, timeouts.totalMs);
  const upload = new UploadSession(options.uploadLifecycle, options.uploadSink, timeouts);
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
    if (!request.url.startsWith("/assets/") && !request.url.startsWith("/symbols/")) reply.header("Cache-Control", "no-store");
    // ^ the symsrv store path (/symbols/<name>/<id>/<file>) sets immutable
    // caching itself; errors there keep sendError's explicit no-store, and the
    // single-segment SPA page "/symbols" (no trailing slash) stays no-store.
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
  registerDumpCatalogRoutes(server, ctx);
  registerAnalysisRoutes(server, ctx);
  registerEventRoutes(server, ctx);
  registerOperationRoutes(server, ctx);
  registerTransferRoutes(server, ctx);
  registerUploadRoutes(server, ctx);
  registerSymbolAdminRoutes(server, ctx);
  // The symsrv read surface registers BEFORE the static web fallback so its
  // three-segment paths are never shadowed by the SPA (symbols-design.md,
  // implementation constraints).
  registerSymbolRoutes(server, {
    openArtifact: (debugFile, debugId) => options.application.openSymbolArtifact(debugFile, debugId),
  });

  // The React build is mounted at the final browser routes last; nothing is
  // registered after this that could shadow an /api or /health path.
  registerStaticWeb(server, options);

  return server;
}
