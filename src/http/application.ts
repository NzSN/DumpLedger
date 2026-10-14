import { Readable } from "node:stream";
import type { ByteReader } from "../symbols/identity.js";

import {
  type ActivityItem,
  type AnalysisListResponse,
  type AnalysisReport,
  type CaseAction,
  type CaseDetailResponse,
  type CaseSearchParams,
  type CaseSearchResponse,
  type CaseSummary,
  type CustomerDetailResponse,
  type DashboardResponse,
  type DumpCatalogEntry,
  type DumpCatalogParams,
  type DumpCatalogResponse,
  type DumpCatalogSymbolCoverage,
  type DumpDetailResponse,
  type EventFeedEntry,
  type EventFeedParams,
  type EventFeedResponse,
  type GrantRecord,
  type MissingSymbolIdentity,
  type ModuleSymbolCoverage,
  type ModuleSymbolStatus,
  MAX_ANALYSES_PER_DUMP,
  MAX_CASE_LIST_ITEMS,
  MAX_CATALOG_CURSOR_LENGTH,
  MAX_DASHBOARD_CUSTOMERS,
  MAX_DASHBOARD_RECENT_CASES,
  MAX_DEBUG_FILE_LENGTH,
  MAX_DEBUG_ID_LENGTH,
  MAX_EVENT_DETAIL_BYTES,
  MAX_MODULE_NAME_LENGTH,
  type RecordAnalysisRequest,
  type SymbolKind,
} from "@dump-ledger/http-contracts";
import { DumpLedgerError } from "../domain/errors.js";
import { parseCaseId, parseCustomerId, parseDumpId, parseGrantId, parseSymbolArtifactId, type CaseId } from "../domain/ids.js";
import type { AuditFeedFilter, DumpLedgerEngine } from "../engine/dump-ledger-engine.js";
import type { DumpLedgerProjection, DumpProjection, StoredAnalysisReport, SymbolArtifactProjection } from "../engine/projection.js";
import type { AuditFeedEntry, DumpCatalogAfter, DumpCatalogFilter, DumpCatalogRow } from "../ledger/sqlite-ledger.js";
import type { SymbolVault, Vault, VaultReader } from "../vault/vault.js";
import type { AnalysisRecordOutcome, CaseTransitionOutcome, HttpApplicationPort, SymbolIngestInput } from "./server.js";

function readerStream(reader: VaultReader): Readable {
  return Readable.from((async function* () {
    let position = 0n;
    try {
      while (position < reader.size) {
        const remaining = reader.size - position;
        const length = Number(remaining > 64n * 1024n ? 64n * 1024n : remaining);
        const chunk = reader.read(position, length);
        if (chunk.byteLength === 0) throw new Error("vault object ended before its recorded size");
        position += BigInt(chunk.byteLength);
        yield chunk;
      }
    } finally {
      reader.close();
    }
  })());
}

export class EngineHttpApplication implements HttpApplicationPort {
  private readonly symbolVault: SymbolVault | undefined;

  constructor(
    private readonly engine: DumpLedgerEngine,
    private readonly vault: Vault,
  ) {
    const candidate = vault as Partial<SymbolVault>;
    this.symbolVault = typeof candidate.openSymbol === "function" ? (candidate as SymbolVault) : undefined;
  }

  customerDetail(customerIdText: string): CustomerDetailResponse | undefined {
    let customerId;
    try { customerId = parseCustomerId(customerIdText); } catch { return undefined; }
    const projection = this.engine.snapshot();
    const customer = projection.customers.find(candidate => candidate.customerId === customerId);
    if (customer === undefined) return undefined;
    const cases = projection.cases
      .filter(candidate => candidate.customerId === customerId)
      .slice(-MAX_CASE_LIST_ITEMS)
      .map(item => ({
        caseId: item.caseId,
        customerId: item.customerId,
        title: item.title,
        status: item.status,
        createdAt: item.createdAt,
      }));
    return {
      customer: { customerId: customer.customerId, displayName: customer.displayName, createdAt: customer.createdAt },
      cases,
    };
  }

  createCustomer(displayName: string) {
    const receipt = this.engine.execute({ type: "CreateCustomer", displayName });
    return receipt.ok && receipt.customerId !== undefined
      ? { ok: true as const, id: receipt.customerId }
      : { ok: false as const, code: receipt.ok ? "integrity_failure" : receipt.error.code };
  }

  createCase(customerIdText: string, title: string) {
    let customerId;
    try { customerId = parseCustomerId(customerIdText); } catch { return { ok: false as const, code: "customer_not_found" }; }
    const receipt = this.engine.execute({ type: "CreateCase", customerId, title });
    return receipt.ok && receipt.caseId !== undefined
      ? { ok: true as const, id: receipt.caseId }
      : { ok: false as const, code: receipt.ok ? "integrity_failure" : receipt.error.code };
  }

  issueGrant(caseIdText: string, expiresAt: number, maxBytes: bigint, maxUploads?: number) {
    let caseId;
    try { caseId = parseCaseId(caseIdText); } catch { return { ok: false as const, code: "case_not_found" }; }
    const receipt = this.engine.execute({
      type: "IssueGrant",
      caseId,
      expiresAt: new Date(expiresAt).toISOString(),
      maxBytes,
      ...(maxUploads === undefined ? {} : { maxUploads }),
    });
    return receipt.ok && receipt.grantId !== undefined && receipt.grantSecret !== undefined
      ? { ok: true as const, id: receipt.grantId, secret: receipt.grantSecret }
      : { ok: false as const, code: receipt.ok ? "integrity_failure" : receipt.error.code };
  }

  grantQuota(grantSecret: string) {
    return this.engine.grantQuota(grantSecret);
  }

  listSymbols() {
    return {
      symbols: this.engine.listSymbolArtifacts().map((artifact) => ({
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        debugFile: artifact.debugFile,
        debugId: artifact.debugId,
        codeFile: artifact.codeFile,
        codeId: artifact.codeId,
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
        ...(artifact.product === null ? {} : { product: artifact.product }),
        ...(artifact.version === null ? {} : { version: artifact.version }),
        ...(artifact.arch === null ? {} : { arch: artifact.arch }),
        ingestedAt: artifact.createdAt,
      })),
    };
  }

  beginSymbolIngest(kind: SymbolKind) {
    const receipt = this.engine.execute({ type: "IngestSymbol", kind });
    return receipt.ok && receipt.artifactId !== undefined
      ? { ok: true as const, id: receipt.artifactId }
      : { ok: false as const, code: receipt.ok ? "integrity_failure" : receipt.error.code };
  }

  sealSymbolIngest(input: SymbolIngestInput) {
    const annotations = {
      ...(input.product === undefined ? {} : { product: input.product }),
      ...(input.version === undefined ? {} : { version: input.version }),
      ...(input.arch === undefined ? {} : { arch: input.arch }),
    };
    const receipt = this.engine.execute(input.kind === "pdb"
      ? { type: "SealSymbol", artifactId: input.artifactId as never, kind: "pdb", debugFile: input.debugFile, debugId: input.debugId, byteSize: input.byteSize, sha256: input.sha256, ...annotations, ingestAuth: input.ingestAuth }
      : { type: "SealSymbol", artifactId: input.artifactId as never, kind: "exe", codeFile: input.codeFile, codeId: input.codeId, byteSize: input.byteSize, sha256: input.sha256, ...annotations, ingestAuth: input.ingestAuth });
    return receipt.ok && receipt.artifactId !== undefined
      ? { ok: true as const, id: receipt.artifactId, deduplicated: receipt.deduplicated === true }
      : { ok: false as const, code: receipt.ok ? "integrity_failure" : receipt.error.code };
  }

  failSymbolIngest(artifactId: string) {
    this.engine.execute({ type: "FailSymbol", artifactId: artifactId as never });
  }

  appendSymbolBytes(artifactIdText: string, chunk: Uint8Array): void {
    if (this.symbolVault === undefined) throw new Error("symbol storage is not configured");
    this.symbolVault.appendSymbol(parseSymbolArtifactId(artifactIdText), chunk);
  }

  /** Read-only random access over a synced symbol staging object, for
   * identity verification against the FULL staged bytes (a multi-GB PDB's
   * MSF directory can live anywhere in the file). */
  openSymbolStagingReader(artifactIdText: string): (ByteReader & { close(): void }) | undefined {
    if (this.symbolVault === undefined || typeof this.symbolVault.openSymbolStagingReader !== "function") return undefined;
    let artifactId;
    try { artifactId = parseSymbolArtifactId(artifactIdText); } catch { return undefined; }
    const reader = this.symbolVault.openSymbolStagingReader(artifactId);
    if (reader === undefined) return undefined;
    if (reader.size > BigInt(Number.MAX_SAFE_INTEGER)) { reader.close(); return undefined; }
    const size = Number(reader.size);
    return {
      size,
      readAt: (offset, length) => {
        if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > size) return undefined;
        const chunk = reader.read(BigInt(offset), length);
        return chunk.length === length ? chunk : undefined;
      },
      close: () => reader.close(),
    };
  }

  syncSymbolStaging(artifactIdText: string): void {
    if (this.symbolVault === undefined) throw new Error("symbol storage is not configured");
    this.symbolVault.syncAndCloseSymbol(parseSymbolArtifactId(artifactIdText));
  }

  purgeSymbol(artifactIdText: string) {
    let artifactId;
    try { artifactId = parseSymbolArtifactId(artifactIdText); } catch { return { ok: false as const, code: "not_found" }; }
    const receipt = this.engine.execute({ type: "PurgeSymbol", artifactId });
    return receipt.ok ? { ok: true as const } : { ok: false as const, code: receipt.error.code };
  }

  openSymbolArtifact(name: string, id: string) {
    if (this.symbolVault === undefined) return undefined;
    const artifact = this.engine.findSymbolArtifactByStorePath(name, id);
    if (artifact === undefined) return undefined;
    const reader = this.symbolVault.openSymbol(artifact.artifactId);
    if (reader === undefined) return undefined;
    return { byteSize: reader.size, stream: readerStream(reader) };
  }

  revokeGrant(grantIdText: string) {
    let grantId;
    try { grantId = parseGrantId(grantIdText); } catch { return { ok: false as const, code: "grant_invalid" }; }
    const receipt = this.engine.execute({ type: "RevokeGrant", grantId });
    return receipt.ok ? { ok: true as const } : { ok: false as const, code: receipt.error.code };
  }

  setRetention(dumpIdText: string, purgeAt: string) {
    let dumpId;
    try { dumpId = parseDumpId(dumpIdText); } catch { return { ok: false as const, code: "not_found" }; }
    const receipt = this.engine.execute({ type: "SetRetention", dumpId, purgeAt });
    return receipt.ok ? { ok: true as const } : { ok: false as const, code: receipt.error.code };
  }

  caseManifest(caseIdText: string): unknown {
    let caseId;
    try { caseId = parseCaseId(caseIdText); } catch { return { error: "case_not_found" }; }
    const projection = this.engine.snapshot();
    const supportCase = projection.cases.find(item => item.caseId === caseId);
    if (supportCase === undefined) return { error: "case_not_found" };
    return {
      schema: "dump-ledger.case-manifest/v1",
      case: supportCase,
      customer: projection.customers.find(item => item.customerId === supportCase.customerId),
      grants: projection.grants.filter(item => item.caseId === caseId).map(item => ({
        ...item,
        maxBytes: item.maxBytes.toString(),
      })),
      dumps: projection.dumps.filter(item => item.caseId === caseId).map(item => ({
        ...item,
        byteSize: item.byteSize?.toString() ?? null,
      })),
      auditEvents: projection.auditEvents.filter(item => item.caseId === caseId),
    };
  }

  openDownload(dumpIdText: string) {
    let dumpId;
    try { dumpId = parseDumpId(dumpIdText); } catch { return undefined; }
    const authorized = this.engine.execute({ type: "AuthorizeDownload", dumpId });
    if (!authorized.ok || authorized.dump === undefined) return undefined;
    const dump = authorized.dump;
    if (dump.phase !== "available" || !dump.downloadable || dump.byteSize === null) return undefined;
    try {
      const reader = this.vault.openImmutable(dumpId);
      if (reader.size !== dump.byteSize) {
        reader.close();
        return undefined;
      }
      return { phase: dump.phase, byteSize: dump.byteSize, bytes: readerStream(reader) };
    } catch {
      return undefined;
    }
  }

  operations() {
    return { integrityErrors: this.engine.integrityCheck().filter(result => result !== "ok") };
  }

  // ---------------------------------------------------------------------------
  // Bounded browser queries (design sections 7.3, 7.4, 7.7). Every /api/v1
  // route is served by one of these methods; none of them hands the raw engine
  // projection to the browser (the Phase-5 cutover removed the HTML
  // comparison oracle and the HTTP port's snapshot()).
  // ---------------------------------------------------------------------------

  dashboard(): DashboardResponse {
    const projection = this.engine.snapshot();
    const cases = projection.cases;
    const customers = projection.customers.slice(0, MAX_DASHBOARD_CUSTOMERS).map(item => ({
      customerId: item.customerId,
      displayName: item.displayName,
    }));
    const recentCases = cases.slice(-MAX_DASHBOARD_RECENT_CASES).reverse().map(item => ({
      caseId: item.caseId,
      customerId: item.customerId,
      title: item.title,
      status: item.status,
      createdAt: item.createdAt,
    }));
    return {
      counts: {
        customers: projection.customers.length,
        activeCases: cases.filter(item => item.status !== "resolved" && item.status !== "closed").length,
        availableDumps: projection.dumps.filter(item => item.phase === "available").length,
        processingDumps: projection.dumps.filter(item =>
          ["receiving", "sealed", "quarantined", "deleting"].includes(item.phase)).length,
      },
      customers,
      recentCases,
    };
  }

  searchCases(params: CaseSearchParams): CaseSearchResponse {
    const projection = this.engine.snapshot();
    const customerNames = new Map(projection.customers.map(item => [item.customerId, item.displayName.toLowerCase()]));
    const query = (params.query ?? "").trim().toLowerCase();
    const ordered = [...projection.cases].sort((left, right) => left.caseId.localeCompare(right.caseId));
    const matched = query.length === 0
      ? ordered
      : ordered.filter(item => {
        const haystack = `${item.caseId} ${item.title} ${item.customerId} ${customerNames.get(item.customerId) ?? ""}`.toLowerCase();
        return haystack.includes(query);
      });
    const start = parseCursorOffset(params.cursor);
    const page = matched.slice(start, start + MAX_CASE_LIST_ITEMS);
    const cases = page.map(item => ({
      caseId: item.caseId,
      customerId: item.customerId,
      title: item.title,
      status: item.status,
      createdAt: item.createdAt,
    }));
    const reachedEnd = start + page.length >= matched.length;
    return {
      cases,
      ...(reachedEnd ? {} : { nextCursor: (start + page.length).toString(36) }),
    };
  }

  /** Dump catalog search (docs/analyzer-integration-design.md, "Dump catalog
   * search"): the contract filter bag maps onto the ledger's keyset catalog
   * read, and rows shape into one bounded page. Read-only. Malformed
   * identifiers and cursors throw `invalid_input`, which the route layer maps
   * to `invalid_request` via `contractErrorFor`. */
  searchDumps(params: DumpCatalogParams): DumpCatalogResponse {
    const after = params.cursor === undefined ? undefined : decodeCatalogCursor(params.cursor);
    const page = this.engine.searchDumps(catalogFilterOf(params), after);
    return catalogResponseOf(page.rows, page.nextAfter, this.engine.snapshot());
  }

  /** By-content-hash lookup: every dump carrying exactly these bytes (normally
   * zero or one); an empty page is a hit on no rows, not an error. */
  dumpsBySha256(sha256: string): DumpCatalogResponse {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new DumpLedgerError("invalid_input", "sha256 is invalid");
    return catalogResponseOf(this.engine.dumpsBySha256(sha256), undefined, this.engine.snapshot());
  }

  /** Audit event feed (docs/analyzer-integration-design.md, "Event feed"): the
   * contract query bag maps onto the ledger's rowid read and rows shape into
   * one bounded page. Read-only (no engine command, no audit event). A
   * malformed `since` cursor or case filter throws `invalid_input`, mapped to
   * `invalid_request` by the route layer. `nextCursor` is always present: past
   * the end it echoes the request position, which is how a poller sleeps
   * between pages. */
  eventFeed(params: EventFeedParams): EventFeedResponse {
    const afterRowid = params.since === undefined ? undefined : decodeEventCursor(params.since);
    const filter: AuditFeedFilter = {
      ...(params.actions === undefined ? {} : { actions: params.actions }),
      ...(params.caseId === undefined ? {} : { caseId: catalogIdentifier(parseCaseId, params.caseId, "caseId") }),
    };
    const page = this.engine.readAuditEvents(afterRowid, filter, params.limit);
    return { events: page.events.map(eventFeedEntryOf), nextCursor: formatEventCursor(page.lastRowid) };
  }

  /** Analysis write-back (docs/analyzer-integration-design.md, "Analysis
   * write-back"): one analyzer verdict pinned to the dump's sealed bytes,
   * recorded through the `RecordAnalysis` engine command. The engine's
   * identity tuple `(dumpId, analyzer.name, analyzer.version, kind,
   * inputSha256)` makes a repeat POST an idempotent replay that returns the
   * stored report (`replayed: true`). The per-dump cap is enforced here,
   * before the command: {@link MAX_ANALYSES_PER_DUMP} stored reports is the
   * limit for NEW identities, while a replay stores nothing new and stays
   * admissible at the cap (an analyzer retrying after a lost response must
   * not be turned away by its own earlier reports). A malformed dump id is
   * `dump_not_found` (404), an unknown dump surfaces the engine's
   * `not_found`, and a dump outside `available` surfaces `invalid_transition`. */
  recordAnalysis(dumpIdText: string, request: RecordAnalysisRequest): AnalysisRecordOutcome {
    let dumpId;
    try { dumpId = parseDumpId(dumpIdText); } catch { return { ok: false, code: "dump_not_found" }; }
    const stored = this.engine.listAnalyses(dumpId);
    if (stored.length >= MAX_ANALYSES_PER_DUMP && !stored.some(report => sameAnalysisIdentity(report, request))) {
      return { ok: false, code: "invalid_transition" };
    }
    const receipt = this.engine.execute({
      type: "RecordAnalysis",
      dumpId,
      analyzerName: request.analyzer.name,
      analyzerVersion: request.analyzer.version,
      kind: request.kind,
      inputSha256: request.inputSha256,
      outcome: request.outcome,
      summary: request.summary,
      ...(request.facts === undefined ? {} : { facts: request.facts }),
      ...(request.duplicateOf === undefined ? {} : { duplicateOf: request.duplicateOf as never }),
    });
    if (!receipt.ok) return { ok: false, code: receipt.error.code };
    if (receipt.analysis === undefined) return { ok: false, code: "integrity_failure" };
    return { ok: true, report: analysisReportOf(receipt.analysis), replayed: receipt.replayed === true };
  }

  /** Every stored report for one dump, ordered by `(createdAt, analysisId)`
   * (the ledger's `(created_at, analysis_id)` read-through). `undefined`
   * means the dump itself is unknown — a dump with no reports is an empty
   * list — which the route layer maps to `not_found`, exactly like dump
   * detail. */
  listAnalyses(dumpIdText: string): AnalysisListResponse | undefined {
    let dumpId;
    try { dumpId = parseDumpId(dumpIdText); } catch { return undefined; }
    if (!this.engine.snapshot().dumps.some(dump => dump.dumpId === dumpId)) return undefined;
    return { analyses: this.engine.listAnalyses(dumpId).map(analysisReportOf) };
  }

  caseSummary(caseIdText: string): CaseSummary | undefined {
    let caseId;
    try { caseId = parseCaseId(caseIdText); } catch { return undefined; }
    const projection = this.engine.snapshot();
    const item = projection.cases.find(candidate => candidate.caseId === caseId);
    if (item === undefined) return undefined;
    return {
      caseId: item.caseId,
      customerId: item.customerId,
      title: item.title,
      status: item.status,
      createdAt: item.createdAt,
    };
  }

  caseDetail(caseIdText: string): CaseDetailResponse | undefined {
    let caseId;
    try { caseId = parseCaseId(caseIdText); } catch { return undefined; }
    const projection = this.engine.snapshot();
    const item = projection.cases.find(candidate => candidate.caseId === caseId);
    if (item === undefined) return undefined;
    const customer = projection.customers.find(candidate => candidate.customerId === item.customerId);
    const grants = projection.grants.filter(candidate => candidate.caseId === caseId)
      .slice(-MAX_CASE_LIST_ITEMS)
      .map(grant => ({
        grantId: grant.grantId,
        state: grant.state,
        createdAt: grant.createdAt,
        expiresAt: grant.expiresAt,
        maxBytes: grant.maxBytes,
        maxUploads: grant.maxUploads,
        uploadsUsed: grant.uploadsUsed,
      }));
    const dumps = projection.dumps.filter(candidate => candidate.caseId === caseId)
      .slice(-MAX_CASE_LIST_ITEMS)
      .map(dump => ({
        dumpId: dump.dumpId,
        phase: dump.phase,
        originalName: dump.originalName,
        byteSize: dump.byteSize,
        receivedAt: dump.receivedAt,
      }));
    const activity = projection.auditEvents.filter(event => event.caseId === caseId)
      .reverse()
      .slice(0, MAX_CASE_LIST_ITEMS)
      .map(event => activityItemOf(event.action, event.occurredAt, event.detail));
    return {
      caseId: item.caseId,
      customerId: item.customerId,
      title: item.title,
      status: item.status,
      createdAt: item.createdAt,
      customer: { customerId: item.customerId, displayName: customer?.displayName ?? item.customerId },
      allowedActions: allowedActionsFor(item.status),
      grants,
      dumps,
      missingSymbols: missingSymbolsFor(projection, caseId),
      activity,
    };
  }

  transitionCase(caseIdText: string, action: CaseAction): CaseTransitionOutcome | undefined {
    let caseId;
    try { caseId = parseCaseId(caseIdText); } catch { return { ok: false, code: "case_not_found" }; }
    const receipt = this.engine.execute({ type: action, caseId });
    if (!receipt.ok || receipt.caseId === undefined) {
      return receipt.ok ? { ok: false, code: "integrity_failure" } : { ok: false, code: receipt.error.code };
    }
    const projection = this.engine.snapshot();
    const item = projection.cases.find(candidate => candidate.caseId === caseId);
    if (item === undefined) return { ok: false, code: "integrity_failure" };
    const revokedGrants = receipt.revokedGrantIds;
    return {
      ok: true,
      response: {
        caseId: receipt.caseId,
        action,
        status: item.status,
        occurredAt: receipt.occurredAt,
        ...(revokedGrants === undefined
          ? {}
          : { revokedGrants: { count: revokedGrants.length, grantIds: [...revokedGrants] } }),
      },
    };
  }

  dumpDetail(dumpIdText: string): DumpDetailResponse | undefined {
    let dumpId;
    try { dumpId = parseDumpId(dumpIdText); } catch { return undefined; }
    const projection = this.engine.snapshot();
    const dump = projection.dumps.find(candidate => candidate.dumpId === dumpId);
    if (dump === undefined) return undefined;
    const supportCase = projection.cases.find(candidate => candidate.caseId === dump.caseId);
    const activity = projection.auditEvents.filter(event => event.dumpId === dumpId)
      .reverse()
      .slice(0, MAX_CASE_LIST_ITEMS)
      .map(event => activityItemOf(event.action, event.occurredAt, event.detail));
    return {
      dumpId: dump.dumpId,
      case: { caseId: dump.caseId, title: supportCase?.title ?? dump.caseId },
      phase: dump.phase,
      originalName: dump.originalName,
      byteSize: dump.byteSize,
      sha256: dump.sha256,
      validation: dump.validation,
      coverage: dump.coverage,
      downloadable: dump.downloadable,
      receivedAt: dump.receivedAt,
      availableAt: dump.availableAt,
      purgeAt: dump.purgeAt,
      purgedAt: dump.purgedAt,
      inspectionError: dump.inspectionError === null ? null : dump.inspectionError.slice(0, 2000),
      symbolCoverage: symbolCoverageFor(dump.inspectionFacts, projection.symbols),
      activity,
    };
  }

  grantRecord(grantIdText: string): GrantRecord | undefined {
    let grantId;
    try { grantId = parseGrantId(grantIdText); } catch { return undefined; }
    const projection = this.engine.snapshot();
    const grant = projection.grants.find(candidate => candidate.grantId === grantId);
    if (grant === undefined) return undefined;
    return {
      grantId: grant.grantId,
      caseId: grant.caseId,
      state: grant.state,
      createdAt: grant.createdAt,
      expiresAt: grant.expiresAt,
      maxBytes: grant.maxBytes,
      maxUploads: grant.maxUploads,
      uploadsUsed: grant.uploadsUsed,
    };
  }
}

/** One stored analysis report as the wire shape. `facts` and `duplicateOf`
 * are omitted when the stored column is SQL NULL: the store collapses
 * "absent" and "explicitly null" `duplicateOf` into NULL, and the contract
 * marks both fields optional. */
function analysisReportOf(report: StoredAnalysisReport): AnalysisReport {
  return {
    analysisId: report.analysisId,
    dumpId: report.dumpId,
    analyzer: { name: report.analyzer.name, version: report.analyzer.version },
    kind: report.kind,
    inputSha256: report.inputSha256,
    outcome: report.outcome,
    summary: report.summary,
    createdAt: report.createdAt,
    ...(report.facts === null ? {} : { facts: report.facts }),
    ...(report.duplicateOf === null ? {} : { duplicateOf: report.duplicateOf }),
  };
}

/** The engine's analysis identity tuple
 * `(dumpId, analyzer.name, analyzer.version, kind, inputSha256)`, minus the
 * dump id both sides already share. */
function sameAnalysisIdentity(report: StoredAnalysisReport, request: RecordAnalysisRequest): boolean {
  return report.analyzer.name === request.analyzer.name
    && report.analyzer.version === request.analyzer.version
    && report.kind === request.kind
    && report.inputSha256 === request.inputSha256;
}

/**
 * Presentation guidance mirroring the case workflow transition table in
 * `specs/DumpLedger.tla` and the lifecycle engine (design section 7.4). This
 * list is guidance only: every transition command is re-checked inside the
 * engine's ledger transaction, and the engine remains authoritative.
 */
function allowedActionsFor(status: string): readonly CaseAction[] {
  switch (status) {
    case "new": return ["StartInvestigation"];
    case "investigating": return ["WaitForCustomer", "ResolveCase"];
    case "waiting-for-customer": return ["ResumeInvestigation", "ResolveCase"];
    case "resolved": return ["ResumeInvestigation", "CloseCase"];
    case "closed": return ["ResumeInvestigation"];
    default: return [];
  }
}

/** The activity cursor is an opaque base36 page offset into a stable snapshot ordering. */
function parseCursorOffset(cursor: string | undefined): number {
  if (cursor === undefined || cursor.length === 0 || cursor.length > 256 || !/^[0-9a-z]+$/.test(cursor)) return 0;
  const value = Number.parseInt(cursor, 36);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Dump catalog: contract filter parameters -> ledger filter. Identifiers are
 * parsed with the domain parsers; a value that is merely identifier-shaped
 * fails as `invalid_input` (mapped to `invalid_request` by the route layer). */
function catalogFilterOf(params: DumpCatalogParams): DumpCatalogFilter {
  return {
    ...(params.caseId === undefined ? {} : { caseId: catalogIdentifier(parseCaseId, params.caseId, "caseId") }),
    ...(params.customerId === undefined ? {} : { customerId: catalogIdentifier(parseCustomerId, params.customerId, "customerId") }),
    ...(params.phase === undefined ? {} : { phase: params.phase }),
    ...(params.validation === undefined ? {} : { validation: params.validation }),
    ...(params.receivedAfter === undefined ? {} : { receivedAfter: params.receivedAfter }),
    ...(params.receivedBefore === undefined ? {} : { receivedBefore: params.receivedBefore }),
    ...(params.architecture === undefined ? {} : { architecture: params.architecture }),
    ...(params.exceptionCode === undefined ? {} : { exceptionCode: params.exceptionCode }),
    ...(params.sha256 === undefined ? {} : { sha256: params.sha256 }),
  };
}

function catalogIdentifier<T>(parse: (value: unknown) => T, value: unknown, label: string): T {
  try {
    return parse(value);
  } catch {
    throw new DumpLedgerError("invalid_input", `${label} is invalid`);
  }
}

/** Catalog cursor codec: base64url of `JSON.stringify([receivedAt, dumpId])`,
 * i.e. the ledger's `DumpCatalogAfter` pair. The string is opaque to clients;
 * decoding validates both halves (canonical UTC timestamp, dump identifier)
 * and rejects non-canonical base64url, so a malformed cursor fails as
 * `invalid_input` instead of silently restarting the traversal. */
function encodeCatalogCursor(after: DumpCatalogAfter): string {
  return Buffer.from(JSON.stringify([after.receivedAt, after.dumpId]), "utf8").toString("base64url");
}

function decodeCatalogCursor(cursor: string): DumpCatalogAfter {
  if (cursor.length === 0 || cursor.length > MAX_CATALOG_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalidCatalogInput("cursor is invalid");
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.toString("base64url") !== cursor) invalidCatalogInput("cursor is invalid");
  const decoded = parseCatalogCursorJson(bytes.toString("utf8"));
  const receivedAt = decoded[0];
  if (typeof receivedAt !== "string" || !isCanonicalTimestamp(receivedAt)) invalidCatalogInput("cursor is invalid");
  return { receivedAt, dumpId: catalogIdentifier(parseDumpId, decoded[1], "cursor") };
}

function parseCatalogCursorJson(text: string): readonly unknown[] {
  let decoded: unknown = undefined;
  try {
    decoded = JSON.parse(text);
  } catch {
    invalidCatalogInput("cursor is invalid");
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) invalidCatalogInput("cursor is invalid");
  return decoded;
}

function invalidCatalogInput(message: string): never {
  throw new DumpLedgerError("invalid_input", message);
}

/** Canonical UTC timestamp (milliseconds precision, `Z` suffix, real date),
 * mirroring the contract decoders' rule. */
function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** Event feed cursor codec: the zero-padded 16-digit decimal rowid
 * (docs/analyzer-integration-design.md, "Event feed"). The cursor is opaque to
 * clients; decoding requires 1..16 decimal digits within
 * `Number.MAX_SAFE_INTEGER`, so a malformed value fails as `invalid_input`
 * instead of silently restarting the traversal. */
function formatEventCursor(rowid: number): string {
  return rowid.toString(10).padStart(16, "0");
}

function decodeEventCursor(cursor: string): number {
  if (!/^\d{1,16}$/.test(cursor)) invalidCatalogInput("cursor is invalid");
  const rowid = Number(cursor);
  if (!Number.isSafeInteger(rowid)) invalidCatalogInput("cursor is invalid");
  return rowid;
}

/** One ledger audit row as the wire entry; the entry cursor is the row's own
 * formatted rowid, so a client can resume strictly after it. */
function eventFeedEntryOf(entry: AuditFeedEntry): EventFeedEntry {
  return {
    cursor: formatEventCursor(entry.rowid),
    eventId: entry.eventId,
    occurredAt: entry.occurredAt,
    action: entry.action,
    customerId: entry.customerId,
    caseId: entry.caseId,
    dumpId: entry.dumpId,
    detail: boundedEventDetail(entry.detail),
  };
}

/** The response contract bounds `detail` at {@link MAX_EVENT_DETAIL_BYTES} of
 * compact JSON. Audit details are engine-written and normally small; a stored
 * detail that somehow exceeds the bound must not fail the whole feed, so that
 * one field degrades to `{}` (which the response decoder accepts) rather than
 * the page 500ing. */
function boundedEventDetail(detail: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const serialized = JSON.stringify(detail);
  if (serialized === undefined) return {};
  return Buffer.byteLength(serialized, "utf8") > MAX_EVENT_DETAIL_BYTES ? {} : detail;
}

/** One ledger catalog page as the wire response; `nextCursor` is present
 * exactly when the ledger page carried a following keyset position. */
function catalogResponseOf(
  rows: readonly DumpCatalogRow[],
  nextAfter: DumpCatalogAfter | undefined,
  projection: DumpLedgerProjection,
): DumpCatalogResponse {
  const dumpsById = new Map(projection.dumps.map(dump => [dump.dumpId, dump]));
  return {
    dumps: rows.map(row => catalogEntryOf(row, dumpsById.get(row.dumpId), projection.symbols)),
    ...(nextAfter === undefined ? {} : { nextCursor: encodeCatalogCursor(nextAfter) }),
  };
}

/** One catalog row as the wire entry. Inspector facts follow the ledger's
 * stored-inspection rule (present only when the inspection succeeded and the
 * stored fact parsed); `symbolCoverage` aggregates the same module rows the
 * dump detail route shows. */
function catalogEntryOf(
  row: DumpCatalogRow,
  dump: DumpProjection | undefined,
  symbols: readonly SymbolArtifactProjection[],
): DumpCatalogEntry {
  const facts = dump === undefined || dump.inspectionError !== null ? null : dump.inspectionFacts;
  return {
    dumpId: row.dumpId,
    caseId: row.caseId,
    customerId: row.customerId,
    phase: row.phase,
    validation: row.validation,
    originalName: row.originalName,
    byteSize: row.byteSize,
    sha256: row.sha256,
    receivedAt: row.receivedAt,
    availableAt: row.availableAt,
    purgeAt: row.purgeAt,
    ...(row.architecture === undefined ? {} : { architecture: row.architecture }),
    ...(row.exceptionCode === undefined ? {} : { exceptionCode: row.exceptionCode }),
    ...(row.exceptionAddress === undefined ? {} : { exceptionAddress: row.exceptionAddress }),
    symbolCoverage: catalogSymbolCoverage(facts, symbols),
  };
}

function catalogSymbolCoverage(
  facts: Readonly<Record<string, unknown>> | null,
  symbols: readonly SymbolArtifactProjection[],
): DumpCatalogSymbolCoverage {
  const counts: Record<ModuleSymbolStatus, number> = { present: 0, missing: 0, unidentified: 0 };
  for (const module of symbolCoverageFor(facts, symbols)) counts[module.status] += 1;
  return counts;
}

/** Bounds an audit action/outcome to the wire limits before it leaves the server. */
function activityItemOf(
  action: string,
  occurredAt: string,
  detail: Readonly<Record<string, unknown>>,
): ActivityItem {
  const outcomeValue = detail.outcome;
  const outcome = typeof outcomeValue === "string" ? outcomeValue.slice(0, 256) : undefined;
  return {
    action: action.slice(0, 64),
    occurredAt,
    ...(outcome === undefined || outcome.length === 0 ? {} : { outcome }),
  };
}

/**
 * Tolerant module-fact readers for `inspection_facts.modules[]`
 * (docs/symbols-design.md: "Dump <-> symbol linkage"). Facts are stored JSON
 * written by an earlier server version, so every field is optional and any
 * value that is not plain bounded text reads as absent.
 */
function factText(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return null;
  return /[\u0000-\u001f\u007f]/.test(value) ? null : value;
}

function factModules(
  facts: Readonly<Record<string, unknown>> | null,
): readonly Readonly<Record<string, unknown>>[] | null {
  const modules = facts === null ? undefined : facts.modules;
  if (!Array.isArray(modules)) return null;
  return modules.filter((entry): entry is Readonly<Record<string, unknown>> =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry));
}

interface ModuleSymbolFacts {
  readonly name: string | null;
  readonly debugFile: string | null;
  readonly debugId: string | null;
}

function moduleSymbolFacts(entry: Readonly<Record<string, unknown>>): ModuleSymbolFacts {
  return {
    name: factText(entry.name, MAX_MODULE_NAME_LENGTH),
    debugFile: factText(entry.debugFile, MAX_DEBUG_FILE_LENGTH),
    debugId: factText(entry.debugId, MAX_DEBUG_ID_LENGTH),
  };
}

/** Exact (debugFile, debugId) key: symbol resolution is case-sensitive by
 * design (docs/symbols-design.md, "Identity model"), and NUL cannot appear
 * inside either identity string. */
function symbolKey(debugFile: string, debugId: string): string {
  return `${debugFile}\u0000${debugId}`;
}

function symbolIndex(symbols: readonly SymbolArtifactProjection[]): ReadonlyMap<string, SymbolArtifactProjection> {
  return new Map(symbols.map(symbol => [symbolKey(symbol.debugFile, symbol.debugId), symbol]));
}

/** OS-owned module install roots (docs/symbols-design.md, D4's OS-module
 * display hint): their symbols resolve from the Microsoft public server,
 * never from this store. The minidump module name is the absolute path from
 * the crashed machine; matching is case-insensitive and separator-agnostic. */
const SYSTEM_MODULE_ROOTS = ["\\windows\\system32\\", "\\windows\\syswow64\\", "\\windows\\winsxs\\"] as const;

function isSystemModulePath(name: string | null): boolean {
  if (name === null) return false;
  const normalized = name.toLowerCase().replaceAll("/", "\\");
  return SYSTEM_MODULE_ROOTS.some(root => normalized.includes(root));
}

/** Per-module symbol coverage for one dump; stored order is preserved. */
function symbolCoverageFor(
  facts: Readonly<Record<string, unknown>> | null,
  symbols: readonly SymbolArtifactProjection[],
): readonly ModuleSymbolCoverage[] {
  const modules = factModules(facts);
  if (modules === null) return [];
  const index = symbolIndex(symbols);
  return modules.map((entry): ModuleSymbolCoverage => {
    const identity = moduleSymbolFacts(entry);
    const system = isSystemModulePath(identity.name);
    if (identity.debugFile === null || identity.debugId === null) {
      return { name: identity.name, debugFile: identity.debugFile, debugId: identity.debugId, status: "unidentified", artifactId: null, system };
    }
    const artifact = index.get(symbolKey(identity.debugFile, identity.debugId));
    return artifact === undefined
      ? { name: identity.name, debugFile: identity.debugFile, debugId: identity.debugId, status: "missing", artifactId: null, system }
      : { name: identity.name, debugFile: identity.debugFile, debugId: identity.debugId, status: "present", artifactId: artifact.artifactId, system };
  });
}

/** Missing identities aggregated across the case's available dumps: one entry
 * per unmatched (debugFile, debugId), with deduped, sorted contributing
 * dumpIds so the case page renders deterministically. */
function missingSymbolsFor(projection: DumpLedgerProjection, caseId: CaseId): readonly MissingSymbolIdentity[] {
  const grouped = new Map<string, { debugFile: string; debugId: string; dumpIds: Set<string> }>();
  const index = symbolIndex(projection.symbols);
  for (const dump of projection.dumps) {
    if (dump.caseId !== caseId || dump.phase !== "available") continue;
    const modules = factModules(dump.inspectionFacts);
    if (modules === null) continue;
    for (const entry of modules) {
      const identity = moduleSymbolFacts(entry);
      if (identity.debugFile === null || identity.debugId === null) continue;
      // OS-module identities never need ingesting here; they resolve from
      // the Microsoft public server downstream of the symsrv path.
      if (isSystemModulePath(identity.name)) continue;
      const key = symbolKey(identity.debugFile, identity.debugId);
      if (index.has(key)) continue;
      const group = grouped.get(key);
      if (group === undefined) grouped.set(key, { debugFile: identity.debugFile, debugId: identity.debugId, dumpIds: new Set([dump.dumpId]) });
      else group.dumpIds.add(dump.dumpId);
    }
  }
  return [...grouped.values()]
    .sort((left, right) => left.debugFile === right.debugFile
      ? compareCodeUnits(left.debugId, right.debugId)
      : compareCodeUnits(left.debugFile, right.debugFile))
    .map(group => ({ debugFile: group.debugFile, debugId: group.debugId, dumpIds: [...group.dumpIds].sort() }));
}

/** Code-unit ordering, so aggregation order never depends on locale data. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
