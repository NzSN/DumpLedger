import { Readable } from "node:stream";

import {
  type ActivityItem,
  type CaseAction,
  type CaseDetailResponse,
  type CaseSearchParams,
  type CaseSearchResponse,
  type CaseSummary,
  type CustomerDetailResponse,
  type DashboardResponse,
  type DumpDetailResponse,
  type GrantRecord,
  type MissingSymbolIdentity,
  type ModuleSymbolCoverage,
  MAX_CASE_LIST_ITEMS,
  MAX_DASHBOARD_CUSTOMERS,
  MAX_DASHBOARD_RECENT_CASES,
  MAX_DEBUG_FILE_LENGTH,
  MAX_DEBUG_ID_LENGTH,
  MAX_MODULE_NAME_LENGTH,
} from "@dump-ledger/http-contracts";
import { parseCaseId, parseCustomerId, parseDumpId, parseGrantId, parseSymbolArtifactId, type CaseId } from "../domain/ids.js";
import type { DumpLedgerEngine } from "../engine/dump-ledger-engine.js";
import type { DumpLedgerProjection, SymbolArtifactProjection } from "../engine/projection.js";
import type { SymbolVault, Vault, VaultReader } from "../vault/vault.js";
import type { CaseTransitionOutcome, HttpApplicationPort } from "./server.js";

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
      symbols: this.engine.snapshot().symbols.map((artifact) => ({
        artifactId: artifact.artifactId,
        debugFile: artifact.debugFile,
        debugId: artifact.debugId,
        kind: artifact.kind,
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
        ...(artifact.product === null ? {} : { product: artifact.product }),
        ...(artifact.version === null ? {} : { version: artifact.version }),
        ...(artifact.arch === null ? {} : { arch: artifact.arch }),
        ingestedAt: artifact.createdAt,
      })),
    };
  }

  beginSymbolIngest() {
    const receipt = this.engine.execute({ type: "IngestSymbol", kind: "pdb" });
    return receipt.ok && receipt.artifactId !== undefined
      ? { ok: true as const, id: receipt.artifactId }
      : { ok: false as const, code: receipt.ok ? "integrity_failure" : receipt.error.code };
  }

  sealSymbolIngest(input: {
    readonly artifactId: string;
    readonly debugFile: string;
    readonly debugId: string;
    readonly byteSize: bigint;
    readonly sha256: string;
    readonly product?: string;
    readonly version?: string;
    readonly arch?: string;
  }) {
    const receipt = this.engine.execute({
      type: "SealSymbol",
      artifactId: input.artifactId as never,
      debugFile: input.debugFile,
      debugId: input.debugId,
      kind: "pdb",
      byteSize: input.byteSize,
      sha256: input.sha256,
      ...(input.product === undefined ? {} : { product: input.product }),
      ...(input.version === undefined ? {} : { version: input.version }),
      ...(input.arch === undefined ? {} : { arch: input.arch }),
    });
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

  openSymbolArtifact(debugFile: string, debugId: string) {
    if (this.symbolVault === undefined) return undefined;
    const artifact = this.engine.findSymbolArtifact(debugFile, debugId, "pdb");
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
    if (identity.debugFile === null || identity.debugId === null) {
      return { name: identity.name, debugFile: identity.debugFile, debugId: identity.debugId, status: "unidentified", artifactId: null };
    }
    const artifact = index.get(symbolKey(identity.debugFile, identity.debugId));
    return artifact === undefined
      ? { name: identity.name, debugFile: identity.debugFile, debugId: identity.debugId, status: "missing", artifactId: null }
      : { name: identity.name, debugFile: identity.debugFile, debugId: identity.debugId, status: "present", artifactId: artifact.artifactId };
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
