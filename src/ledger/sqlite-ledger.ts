import BetterSqlite3 from "better-sqlite3";
import { DumpLedgerError } from "../domain/errors.js";
import { parseAuditEventId, parseCaseId, parseCustomerId, parseDumpId, parseGrantId, type AuditEventId, type CaseId, type CustomerId, type DumpId, type GrantId } from "../domain/ids.js";
import { isCoverageKind, parseBlobState, parseCaseStatus, parseDumpPhase, parseTokenState, parseValidationState, type CaseStatus, type CoverageKind, type DumpPhase } from "../domain/lifecycle.js";
import type { AuditEventProjection, DumpLedgerProjection, DumpProjection, GrantProjection } from "../engine/projection.js";
import { applyMigrations } from "./migrations.js";

export interface GrantRecord extends GrantProjection { readonly secretDigest: string }
interface EventIdentity { readonly eventId: AuditEventId; readonly occurredAt: string }
type Row = Record<string, unknown>;
function requiredString(row: Row, key: string): string { const value = row[key]; if (typeof value !== "string") throw new DumpLedgerError("integrity_failure", `invalid database ${key}`); return value; }
function nullableString(row: Row, key: string): string | null { const value = row[key]; if (value === null) return null; if (typeof value !== "string") throw new DumpLedgerError("integrity_failure", `invalid database ${key}`); return value; }
function nullableIsoTimestamp(row: Row, key: string): string | null { const value = nullableString(row, key); if (value !== null && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) throw new DumpLedgerError("integrity_failure", `invalid database ${key}`); return value; }
function booleanInteger(row: Row, key: string): boolean { const value = row[key]; if (value === 0 || value === 0n) return false; if (value === 1 || value === 1n) return true; throw new DumpLedgerError("integrity_failure", `invalid database ${key}`); }
function parseJsonObject(value: string): Readonly<Record<string, unknown>> { const parsed: unknown = JSON.parse(value); if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new DumpLedgerError("integrity_failure", "invalid database detail_json"); return parsed as Readonly<Record<string, unknown>>; }
function stringifyJson(value: Readonly<Record<string, unknown>>): string { return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item); }
function databaseValue<T>(label: string, parse: (value: unknown) => T, value: unknown): T { try { return parse(value); } catch (error) { throw new DumpLedgerError("integrity_failure", `invalid database ${label}`, { cause: error }); } }

function dumpFromRow(row: Row): DumpProjection {
  const coverageValue = row.coverage;
  if (coverageValue !== null && !isCoverageKind(coverageValue)) throw new DumpLedgerError("integrity_failure", "invalid database coverage");
  const byteSize = nullableString(row, "byte_size");
  return {
    dumpId: databaseValue("dump_id", parseDumpId, row.dump_id), caseId: databaseValue("case_id", parseCaseId, row.case_id),
    phase: databaseValue("phase", parseDumpPhase, row.phase), blobState: databaseValue("blob_state", parseBlobState, row.blob_state),
    originalName: requiredString(row, "original_name"), byteSize: byteSize === null ? null : BigInt(byteSize), sha256: nullableString(row, "sha256"),
    validation: databaseValue("validation", parseValidationState, row.validation), coverage: coverageValue, downloadable: booleanInteger(row, "downloadable"),
    inspectionError: nullableString(row, "inspection_error"), receivedAt: requiredString(row, "received_at"),
    availableAt: nullableIsoTimestamp(row, "available_at"), purgeAt: nullableIsoTimestamp(row, "purge_at"), purgedAt: nullableIsoTimestamp(row, "purged_at"),
  };
}
function grantFromRow(row: Row): GrantRecord {
  const consumed = row.consumed_by_dump_id;
  return {
    grantId: databaseValue("grant_id", parseGrantId, row.grant_id), caseId: databaseValue("case_id", parseCaseId, row.case_id),
    secretDigest: requiredString(row, "secret_digest"), state: databaseValue("grant state", parseTokenState, row.state),
    expiresAt: requiredString(row, "expires_at"), maxBytes: BigInt(requiredString(row, "max_bytes")),
    consumedByDumpId: consumed === null ? null : databaseValue("consumed_by_dump_id", parseDumpId, consumed), createdAt: requiredString(row, "created_at"),
  };
}

export class SqliteLedger {
  private readonly database: BetterSqlite3.Database;
  private readonly statements = new Map<string, BetterSqlite3.Statement<unknown[], unknown>>();
  constructor(path: string) { this.database = new BetterSqlite3(path); this.database.pragma("foreign_keys = ON"); if (path !== ":memory:") this.database.pragma("journal_mode = WAL"); applyMigrations(this.database); }
  close(): void { this.database.close(); }
  integrityCheck(): readonly string[] { return (this.database.pragma("integrity_check") as Array<{integrity_check:string}>).map(row => row.integrity_check).filter(finding => finding !== "ok"); }
  async backup(destination: string): Promise<void> { await this.database.backup(destination); }

  createCustomer(customerId: CustomerId, displayName: string, event: EventIdentity): void { this.database.transaction(() => { this.prepare("INSERT INTO customers(customer_id, display_name, created_at) VALUES (?, ?, ?)").run(customerId, displayName, event.occurredAt); this.insertAudit(event, "CreateCustomer", customerId, null, null, {}); })(); }
  createCase(caseId: CaseId, customerId: CustomerId, title: string, event: EventIdentity): void { this.database.transaction(() => { this.prepare("INSERT INTO cases(case_id, customer_id, title, status, created_at) VALUES (?, ?, ?, 'new', ?)").run(caseId, customerId, title, event.occurredAt); this.insertAudit(event, "CreateCase", customerId, caseId, null, {}); })(); }
  startInvestigation(caseId: CaseId, event: EventIdentity): void { this.transitionCase(caseId, ["new"], event, "StartInvestigation", "investigating"); }
  waitForCustomer(caseId: CaseId, event: EventIdentity): void { this.transitionCase(caseId, ["investigating"], event, "WaitForCustomer", "waiting-for-customer"); }
  resumeInvestigation(caseId: CaseId, event: EventIdentity): void { this.transitionCase(caseId, ["waiting-for-customer", "resolved", "closed"], event, "ResumeInvestigation", "investigating"); }
  resolveCase(caseId: CaseId, event: EventIdentity): void { this.transitionCase(caseId, ["investigating", "waiting-for-customer"], event, "ResolveCase", "resolved"); }
  closeCase(caseId: CaseId, event: EventIdentity): readonly GrantId[] {
    return this.database.transaction(() => {
      const status = this.caseStatusFor(caseId);
      if (this.prepare("UPDATE cases SET status = 'closed' WHERE case_id = ? AND status = 'resolved'").run(caseId).changes !== 1) throw new DumpLedgerError("invalid_transition", `cannot CloseCase from status ${status}`);
      const rows = this.prepare("SELECT grant_id FROM upload_grants WHERE case_id = ? AND state = 'issued' ORDER BY grant_id").all(caseId) as Row[];
      const revokedGrantIds = rows.map(row => databaseValue("grant_id", parseGrantId, row.grant_id));
      for (const grantId of revokedGrantIds) {
        if (this.prepare("UPDATE upload_grants SET state = 'revoked' WHERE grant_id = ? AND state = 'issued'").run(grantId).changes !== 1) throw new DumpLedgerError("integrity_failure", "issued grant could not be revoked during CloseCase");
      }
      this.insertAudit(event, "CloseCase", this.customerForCase(caseId), caseId, null, { revokedGrantIds });
      return revokedGrantIds;
    })();
  }
  issueGrant(grantId: GrantId, caseId: CaseId, secretDigest: string, expiresAt: string, maxBytes: bigint, event: EventIdentity): void {
    this.database.transaction(() => {
      if (this.caseStatusFor(caseId) === "closed") throw new DumpLedgerError("invalid_transition", "cannot IssueGrant on a closed case");
      const customerId = this.customerForCase(caseId);
      this.prepare("INSERT INTO upload_grants(grant_id, case_id, secret_digest, state, expires_at, max_bytes, consumed_by_dump_id, created_at) VALUES (?, ?, ?, 'issued', ?, ?, NULL, ?)").run(grantId, caseId, secretDigest, expiresAt, maxBytes.toString(), event.occurredAt);
      this.insertAudit(event, "IssueGrant", customerId, caseId, null, { grantId });
    })();
  }
  findGrantByDigest(secretDigest: string): GrantRecord | null { const row = this.prepare("SELECT * FROM upload_grants WHERE secret_digest = ?").get(secretDigest) as Row | undefined; return row === undefined ? null : grantFromRow(row); }
  transitionGrant(grantId: GrantId, next: "revoked" | "expired", event: EventIdentity): void {
    this.database.transaction(() => {
      const row = this.prepare("SELECT g.*, c.customer_id FROM upload_grants g JOIN cases c ON c.case_id = g.case_id WHERE g.grant_id = ?").get(grantId) as Row | undefined;
      if (row === undefined) throw new DumpLedgerError("not_found", "upload grant was not found");
      if (this.prepare("UPDATE upload_grants SET state = ? WHERE grant_id = ? AND state = 'issued'").run(next, grantId).changes !== 1) throw new DumpLedgerError("invalid_transition", "upload grant is not issued");
      this.insertAudit(event, next === "revoked" ? "RevokeGrant" : "ExpireGrant", parseCustomerId(row.customer_id), parseCaseId(row.case_id), null, { grantId });
    })();
  }
  beginUpload(grantId: GrantId, dumpId: DumpId, originalName: string, event: EventIdentity): void {
    this.database.transaction(() => {
      const row = this.prepare("SELECT g.case_id, c.customer_id, c.status AS case_status FROM upload_grants g JOIN cases c ON c.case_id = g.case_id WHERE g.grant_id = ?").get(grantId) as Row | undefined;
      if (row === undefined) throw new DumpLedgerError("grant_invalid", "upload grant is invalid");
      if (row.case_status === "closed") throw new DumpLedgerError("invalid_transition", "cannot BeginUpload on a closed case");
      const caseId = parseCaseId(row.case_id);
      if (this.prepare("UPDATE upload_grants SET state = 'consumed', consumed_by_dump_id = ? WHERE grant_id = ? AND state = 'issued' AND consumed_by_dump_id IS NULL").run(dumpId, grantId).changes !== 1) throw new DumpLedgerError("grant_consumed", "upload grant has already been used");
      this.prepare("INSERT INTO dumps(dump_id, case_id, phase, blob_state, original_name, byte_size, sha256, validation, coverage, downloadable, inspection_error, inspection_facts_json, received_at, available_at, purged_at) VALUES (?, ?, 'receiving', 'staging', ?, NULL, NULL, 'not-checked', NULL, 0, NULL, NULL, ?, NULL, NULL)").run(dumpId, caseId, originalName, event.occurredAt);
      this.insertAudit(event, "BeginUpload", parseCustomerId(row.customer_id), caseId, dumpId, { grantId });
    })();
  }
  getDump(dumpId: DumpId): DumpProjection | null { const row = this.prepare("SELECT * FROM dumps WHERE dump_id = ?").get(dumpId) as Row | undefined; return row === undefined ? null : dumpFromRow(row); }
  sealUpload(dumpId: DumpId, byteSize: bigint, sha256: string, event: EventIdentity): void { this.transitionDump(dumpId, ["receiving"], event, "SealUpload", "phase = 'sealed', byte_size = @byteSize, sha256 = @sha256", {byteSize: byteSize.toString(), sha256}); }
  failUpload(dumpId: DumpId, event: EventIdentity): void { this.transitionDump(dumpId, ["receiving"], event, "FailUpload", "phase = 'rejected', blob_state = 'none', validation = 'transfer-failed', downloadable = 0"); }
  recordPromoted(dumpId: DumpId, event: EventIdentity): void { this.transitionDump(dumpId, ["sealed"], event, "PromoteObject", "blob_state = 'vault'", {}, "blob_state = 'staging'"); }
  markQuarantined(dumpId: DumpId, event: EventIdentity): void { this.transitionDump(dumpId, ["sealed"], event, "MarkQuarantined", "phase = 'quarantined'", {}, "blob_state = 'vault' AND sha256 IS NOT NULL"); }
  acceptDump(dumpId: DumpId, coverage: CoverageKind, facts: Readonly<Record<string, unknown>>, event: EventIdentity): void { this.transitionDump(dumpId, ["quarantined"], event, "AcceptDump", "phase = 'available', validation = 'valid', coverage = @coverage, downloadable = 1, inspection_error = NULL, inspection_facts_json = @facts, available_at = @availableAt", {coverage, facts: stringifyJson(facts), availableAt:event.occurredAt}, "blob_state = 'vault' AND sha256 IS NOT NULL"); }
  rejectDump(dumpId: DumpId, reason: string, event: EventIdentity): void { this.transitionDump(dumpId, ["quarantined"], event, "RejectDump", "phase = 'rejected', validation = 'invalid', downloadable = 0, inspection_error = @reason", {reason}, "blob_state = 'vault'"); }
  beginPurge(dumpId: DumpId, event: EventIdentity): void { this.transitionDump(dumpId, ["available", "rejected"], event, "BeginPurge", "phase = 'deleting', downloadable = 0"); }
  finishPurge(dumpId: DumpId, event: EventIdentity): void { this.transitionDump(dumpId, ["deleting"], event, "FinishPurge", "phase = 'deleted', blob_state = 'none', downloadable = 0, purged_at = @purgedAt", {purgedAt:event.occurredAt}); }
  setRetention(dumpId: DumpId, purgeAt: string, event: EventIdentity): void {
    this.database.transaction(() => {
      const dump = this.getDump(dumpId); if (dump === null) throw new DumpLedgerError("not_found", "dump was not found");
      if (this.prepare("UPDATE dumps SET purge_at = ? WHERE dump_id = ? AND phase IN ('available', 'rejected')").run(purgeAt, dumpId).changes !== 1) throw new DumpLedgerError("invalid_transition", `cannot SetRetention from phase ${dump.phase}`);
      this.insertAudit(event, "SetRetention", this.customerForCase(dump.caseId), dump.caseId, dumpId, {purgeAt});
    })();
  }
  dueForPurge(at: string): readonly DumpId[] { return (this.prepare("SELECT dump_id FROM dumps WHERE phase IN ('available', 'rejected') AND purge_at IS NOT NULL AND purge_at <= ? ORDER BY dump_id").all(at) as Row[]).map(row => databaseValue("dump_id", parseDumpId, row.dump_id)); }
  authorizeDownload(dumpId: DumpId, event: EventIdentity): DumpProjection {
    return this.database.transaction(() => { const dump = this.getDump(dumpId); if (dump === null) throw new DumpLedgerError("not_found", "dump was not found"); if (dump.phase !== "available" || !dump.downloadable) throw new DumpLedgerError("invalid_transition", "dump is not available for download"); this.insertAudit(event, "AuthorizeDownload", this.customerForCase(dump.caseId), dump.caseId, dumpId, {}); return dump; })();
  }
  snapshot(): DumpLedgerProjection {
    const customers = (this.prepare("SELECT * FROM customers ORDER BY customer_id").all() as Row[]).map(row => ({ customerId: databaseValue("customer_id", parseCustomerId, row.customer_id), displayName: requiredString(row, "display_name"), createdAt: requiredString(row, "created_at") }));
    const cases = (this.prepare("SELECT * FROM cases ORDER BY case_id").all() as Row[]).map(row => ({ caseId: databaseValue("case_id", parseCaseId, row.case_id), customerId: databaseValue("customer_id", parseCustomerId, row.customer_id), title: requiredString(row, "title"), status: databaseValue("case status", parseCaseStatus, row.status), createdAt: requiredString(row, "created_at") }));
    const grants = (this.prepare("SELECT * FROM upload_grants ORDER BY grant_id").all() as Row[]).map(grantFromRow).map(({secretDigest: _secretDigest, ...grant}) => grant);
    const dumps = (this.prepare("SELECT * FROM dumps ORDER BY dump_id").all() as Row[]).map(dumpFromRow);
    const auditEvents: AuditEventProjection[] = (this.prepare("SELECT * FROM audit_events ORDER BY rowid").all() as Row[]).map(row => ({
      eventId: databaseValue("event_id", parseAuditEventId, row.event_id), occurredAt: requiredString(row, "occurred_at"), action: requiredString(row, "action"),
      customerId: row.customer_id === null ? null : databaseValue("customer_id", parseCustomerId, row.customer_id),
      caseId: row.case_id === null ? null : databaseValue("case_id", parseCaseId, row.case_id),
      dumpId: row.dump_id === null ? null : databaseValue("dump_id", parseDumpId, row.dump_id), detail: parseJsonObject(requiredString(row, "detail_json")),
    }));
    return { customers, cases, grants, dumps, downloadable: dumps.filter(dump => dump.downloadable).map(dump => dump.dumpId), auditEvents };
  }
  private transitionDump(dumpId: DumpId, expected: readonly DumpPhase[], event: EventIdentity, action: string, assignments: string, values: Readonly<Record<string,string>> = {}, extraPredicate = "1 = 1"): void {
    this.database.transaction(() => {
      const dump = this.getDump(dumpId); if (dump === null) throw new DumpLedgerError("not_found", "dump was not found");
      const placeholders = expected.map(() => "?").join(", ");
      const result = this.prepare(`UPDATE dumps SET ${assignments} WHERE dump_id = @dumpId AND phase IN (${placeholders}) AND ${extraPredicate}`).run({dumpId, ...values}, ...expected);
      if (result.changes !== 1) throw new DumpLedgerError("invalid_transition", `cannot ${action} from phase ${dump.phase}`);
      this.insertAudit(event, action, this.customerForCase(dump.caseId), dump.caseId, dumpId, {});
    })();
  }
  private caseStatusFor(caseId: CaseId): CaseStatus {
    const row = this.prepare("SELECT status FROM cases WHERE case_id = ?").get(caseId) as Row | undefined;
    if (row === undefined) throw new DumpLedgerError("not_found", "case was not found");
    return databaseValue("case status", parseCaseStatus, row.status);
  }
  private transitionCase(caseId: CaseId, expected: readonly CaseStatus[], event: EventIdentity, action: string, next: CaseStatus): void {
    this.database.transaction(() => {
      const status = this.caseStatusFor(caseId);
      const placeholders = expected.map(() => "?").join(", ");
      if (this.prepare(`UPDATE cases SET status = ? WHERE case_id = ? AND status IN (${placeholders})`).run(next, caseId, ...expected).changes !== 1) throw new DumpLedgerError("invalid_transition", `cannot ${action} from status ${status}`);
      this.insertAudit(event, action, this.customerForCase(caseId), caseId, null, {});
    })();
  }
  private customerForCase(caseId: CaseId): CustomerId {
    const row = this.prepare("SELECT customer_id FROM cases WHERE case_id = ?").get(caseId) as Row | undefined;
    if (row === undefined) throw new DumpLedgerError("not_found", "case was not found");
    return databaseValue("customer_id", parseCustomerId, row.customer_id);
  }
  private insertAudit(event: EventIdentity, action: string, customerId: CustomerId | null, caseId: CaseId | null, dumpId: DumpId | null, detail: Readonly<Record<string,unknown>>): void {
    this.prepare("INSERT INTO audit_events(event_id, occurred_at, action, customer_id, case_id, dump_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(event.eventId, event.occurredAt, action, customerId, caseId, dumpId, stringifyJson(detail));
  }
  private prepare(sql: string): BetterSqlite3.Statement<unknown[],unknown> {
    const cached = this.statements.get(sql); if (cached !== undefined) return cached;
    const statement = this.database.prepare(sql); this.statements.set(sql, statement); return statement;
  }
}
