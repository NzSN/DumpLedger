import { Readable } from "node:stream";

import {
  type ActivityItem,
  type CaseAction,
  type CaseDetailResponse,
  type CaseSearchParams,
  type CaseSearchResponse,
  type CaseSummary,
  type DashboardResponse,
  type DumpDetailResponse,
  type GrantRecord,
  MAX_CASE_LIST_ITEMS,
  MAX_DASHBOARD_CUSTOMERS,
  MAX_DASHBOARD_RECENT_CASES,
} from "@dump-ledger/http-contracts";
import { parseCaseId, parseCustomerId, parseDumpId, parseGrantId } from "../domain/ids.js";
import type { DumpLedgerEngine } from "../engine/dump-ledger-engine.js";
import type { Vault, VaultReader } from "../vault/vault.js";
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
  constructor(
    private readonly engine: DumpLedgerEngine,
    private readonly vault: Vault,
  ) {}

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

  issueGrant(caseIdText: string, expiresAt: number, maxBytes: bigint) {
    let caseId;
    try { caseId = parseCaseId(caseIdText); } catch { return { ok: false as const, code: "case_not_found" }; }
    const receipt = this.engine.execute({ type: "IssueGrant", caseId, expiresAt: new Date(expiresAt).toISOString(), maxBytes });
    return receipt.ok && receipt.grantId !== undefined && receipt.grantSecret !== undefined
      ? { ok: true as const, id: receipt.grantId, secret: receipt.grantSecret }
      : { ok: false as const, code: receipt.ok ? "integrity_failure" : receipt.error.code };
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
