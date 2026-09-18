import { createHash, createHmac } from "node:crypto";
import { DumpLedgerError, SimulatedCrash } from "../domain/errors.js";
import { parseAuditEventId, parseCaseId, parseCustomerId, parseDumpId, parseGrantId, parseSymbolArtifactId, type AuditEventId, type DumpId, type IdSource } from "../domain/ids.js";
import { isCoverageKind, parseCaseStatus, parseDumpPhase, parseSymbolArtifactKind, parseTokenState, parseValidationState, type CoverageKind, type DumpPhase, type SymbolArtifactKind } from "../domain/lifecycle.js";
import { MAX_GRANT_UPLOAD_SLOTS, SqliteLedger } from "../ledger/sqlite-ledger.js";
import type { SymbolVault, Vault } from "../vault/vault.js";
import type { ImportCounts, ImportSummary, LifecycleCommand } from "./commands.js";
import { CryptoEntropy, NoFailpoints, RandomIds, SystemClock, type Clock, type EntropySource, type FailpointPort } from "./dependencies.js";
import type { InspectionPort } from "./inspection-port.js";
import type { BackupInventory, DumpLedgerProjection, StoredSymbolArtifact, TransitionReceipt, TransitionSuccess } from "./projection.js";

export { DeterministicClock, DeterministicEntropy, DeterministicIds, ScriptedFailpoints } from "./dependencies.js";
export type { DurableCheckpoint } from "./dependencies.js";
export type { InspectionOutcome, InspectionPort } from "./inspection-port.js";
export type { ImportAuditEventRecord, ImportCaseRecord, ImportCounts, ImportCustomerRecord, ImportDumpRecord, ImportGrantRecord, ImportSummary, LifecycleCommand } from "./commands.js";
export type { BackupInventory, BackupInventoryDump, DumpLedgerProjection, StoredSymbolArtifact, TransitionReceipt } from "./projection.js";

export interface DumpLedgerEngineOptions { readonly databasePath: string; readonly vault: Vault; readonly inspection: InspectionPort; readonly grantSecretKey: Uint8Array; readonly symbolVault?: SymbolVault; readonly clock?: Clock; readonly entropy?: EntropySource; readonly ids?: IdSource; readonly failpoints?: FailpointPort }
/** Public grant-quota answer (batch upload design): what the holder of a valid secret may still upload. */
export interface GrantQuota {
  readonly maxUploads: number;
  readonly uploadsUsed: number;
  readonly maxBytes: bigint;
  readonly expiresAt: string;
}

export interface DumpLedgerEngine {
  execute(command: LifecycleCommand): TransitionReceipt;
  grantKeyFingerprint(): string;
  /** Bounded symbol-artifact lookup by the identity pair `kind` resolves by (docs/symbols-design.md). */
  findSymbolArtifact(name: string, id: string, kind: SymbolArtifactKind): StoredSymbolArtifact | undefined;
  /** Store-path lookup (symsrv read route): the debug identity of a PDB or the code identity of an EXE. */
  findSymbolArtifactByStorePath(name: string, id: string): StoredSymbolArtifact | undefined;
  /** Every stored artifact, both kinds (the operator Symbols list). */
  listSymbolArtifacts(): readonly StoredSymbolArtifact[];
  /** Returns quota for issued or consumed grants; undefined for unknown, revoked, or expired secrets. */
  grantQuota(grantSecret: string): GrantQuota | undefined;
  snapshot(): DumpLedgerProjection;
  dueForPurge(at?: string): readonly DumpId[];
  pendingPurgeCompletion(): readonly DumpId[];
  backupInventory(): BackupInventory;
  integrityCheck(): readonly string[];
  backup(destination: string): Promise<void>;
  close(): void;
}
function digestSecret(secret: string, key: Uint8Array): string { return createHmac("sha256", key).update(secret, "utf8").digest("hex"); }
function assertText(value: unknown, name: string, maximum: number): string { if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) throw new DumpLedgerError("invalid_input", `${name} is invalid`); return value; }
function assertIsoTimestamp(value: unknown, name: string): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new DumpLedgerError("invalid_input", `${name} must be a canonical ISO timestamp`); return value; }
function assertPositiveBigint(value: unknown, name: string): bigint { if (typeof value !== "bigint" || value <= 0n) throw new DumpLedgerError("invalid_input", `${name} must be a positive bigint`); return value; }
function assertNonnegativeBigint(value: unknown, name: string): bigint { if (typeof value !== "bigint" || value < 0n) throw new DumpLedgerError("invalid_input", `${name} must be a nonnegative bigint`); return value; }
function assertSha256(value: unknown): string { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new DumpLedgerError("invalid_input", "sha256 must be 64 lowercase hexadecimal characters"); return value; }
function assertNullableIsoTimestamp(value: unknown, name: string): string | null { return value === null ? null : assertIsoTimestamp(value, name); }
function assertNullableByteSize(value: unknown): bigint | null { return value === null ? null : assertNonnegativeBigint(value, "byteSize"); }
function assertNullableSha256(value: unknown): string | null { return value === null ? null : assertSha256(value); }
function assertNullableCoverage(value: unknown): CoverageKind | null { if (value === null || value === undefined) return null; if (!isCoverageKind(value)) throw new DumpLedgerError("invalid_input", "coverage is invalid"); return value; }
function assertInspectionFacts(value: unknown): Readonly<Record<string, unknown>> | null { if (value === null || value === undefined) return null; if (typeof value !== "object" || Array.isArray(value)) throw new DumpLedgerError("invalid_input", "inspectionFacts must be an object"); return value as Readonly<Record<string, unknown>>; }
function assertPlainObject(value: unknown, name: string, maxSerializedBytes: number): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DumpLedgerError("invalid_input", `${name} must be an object`);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxSerializedBytes) throw new DumpLedgerError("invalid_input", `${name} exceeds its serialized size bound`);
  return value as Readonly<Record<string, unknown>>;
}
function assertMaxUploads(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_GRANT_UPLOAD_SLOTS) throw new DumpLedgerError("invalid_input", "maxUploads must be an integer between 1 and 16");
  return value;
}
function assertUploadsUsed(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_GRANT_UPLOAD_SLOTS) throw new DumpLedgerError("invalid_input", "uploadsUsed must be an integer between 0 and 16");
  return value;
}
function assertCount(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new DumpLedgerError("invalid_input", `${name} must be a nonnegative integer`); return value; }
function assertImportCounts(value: unknown, name: string): ImportCounts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DumpLedgerError("invalid_input", `${name} must be an object`);
  const entries = value as Record<string, unknown>;
  for (const key of Object.keys(entries)) if (!["customers", "cases", "grants", "dumps", "auditEvents"].includes(key)) throw new DumpLedgerError("invalid_input", `${name}.${key} is not a known count`);
  const counts: ImportCounts = { customers: assertCount(entries.customers, `${name}.customers`), cases: assertCount(entries.cases, `${name}.cases`), grants: assertCount(entries.grants, `${name}.grants`), dumps: assertCount(entries.dumps, `${name}.dumps`) };
  if (entries.auditEvents !== undefined) return { ...counts, auditEvents: assertCount(entries.auditEvents, `${name}.auditEvents`) };
  return counts;
}
function assertImportSummary(value: unknown): ImportSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DumpLedgerError("invalid_input", "summary must be an object");
  const entries = value as Record<string, unknown>;
  return { imported: assertImportCounts(entries.imported, "summary.imported"), skipped: assertCount(entries.skipped, "summary.skipped") };
}

class Engine implements DumpLedgerEngine {
  private readonly ledger: SqliteLedger;
  private readonly symbolVault: SymbolVault | undefined;
  private readonly clock: Clock;
  private readonly entropy: EntropySource;
  private readonly ids: IdSource;
  private readonly failpoints: FailpointPort;
  private readonly grantSecretKey: Uint8Array;
  constructor(private readonly options: DumpLedgerEngineOptions) {
    if (options.grantSecretKey.byteLength < 32) throw new DumpLedgerError("invalid_input", "grantSecretKey must contain at least 32 bytes");
    this.grantSecretKey = Uint8Array.from(options.grantSecretKey);
    this.ledger = new SqliteLedger(options.databasePath);
    const candidate = options.symbolVault ?? (options.vault as Partial<SymbolVault>);
    this.symbolVault = typeof candidate.createSymbolStaging === "function" ? (candidate as SymbolVault) : undefined;
    this.clock = options.clock ?? new SystemClock(); this.entropy = options.entropy ?? new CryptoEntropy(); this.ids = options.ids ?? new RandomIds(); this.failpoints = options.failpoints ?? new NoFailpoints();
  }
  execute(command: LifecycleCommand): TransitionReceipt {
    try { return this.executeChecked(command); }
    catch (error) {
      if (error instanceof SimulatedCrash) throw error;
      if (error instanceof DumpLedgerError) return {ok:false, action:command.type, error:{code:error.code,message:error.message}};
      if (error instanceof TypeError || error instanceof RangeError) return {ok:false, action:command.type, error:{code:"invalid_input",message:error.message}};
      return {ok:false, action:command.type, error:{code:"storage_unavailable",message:"a durable operation failed"}};
    }
  }
  snapshot(): DumpLedgerProjection { return this.ledger.snapshot(); }
  findSymbolArtifact(name: string, id: string, kind: SymbolArtifactKind): StoredSymbolArtifact | undefined { return this.ledger.findSymbolArtifact(name, id, kind); }
  findSymbolArtifactByStorePath(name: string, id: string): StoredSymbolArtifact | undefined { return this.ledger.findSymbolArtifactByStorePath(name, id); }
  listSymbolArtifacts(): readonly StoredSymbolArtifact[] { return this.ledger.listSymbolArtifacts(); }
  grantKeyFingerprint(): string { return createHash("sha256").update(this.grantSecretKey).digest("base64url"); }
  grantQuota(grantSecret: string): GrantQuota | undefined {
    const grant = this.ledger.findGrantByDigest(digestSecret(assertText(grantSecret, "grantSecret", 1024), this.grantSecretKey));
    if (grant === null || (grant.state !== "issued" && grant.state !== "consumed")) return undefined;
    return { maxUploads: grant.maxUploads, uploadsUsed: grant.uploadsUsed, maxBytes: grant.maxBytes, expiresAt: grant.expiresAt };
  }
  dueForPurge(at?: string): readonly DumpId[] { return this.ledger.dueForPurge(assertIsoTimestamp(at ?? this.clock.now(), "retention time")); }
  pendingPurgeCompletion(): readonly DumpId[] { return this.snapshot().dumps.filter(dump => dump.phase === "deleting").map(dump => dump.dumpId); }
  backupInventory(): BackupInventory {
    return { schema:"dump-ledger.backup-inventory/v1", generatedAt:assertIsoTimestamp(this.clock.now(), "clock"), includesVaultBytes:false,
      dumps:this.snapshot().dumps.map(dump => ({dumpId:dump.dumpId,caseId:dump.caseId,phase:dump.phase,byteSize:dump.byteSize?.toString() ?? null,sha256:dump.sha256,purgeAt:dump.purgeAt,purgedAt:dump.purgedAt})) };
  }
  integrityCheck(): readonly string[] { return this.ledger.integrityCheck(); }
  backup(destination: string): Promise<void> { return this.ledger.backup(destination); }
  close(): void { this.ledger.close(); }

  private executeChecked(command: LifecycleCommand): TransitionSuccess {
    const occurredAt = assertIsoTimestamp(this.clock.now(), "clock");
    const event = (): {eventId:AuditEventId;occurredAt:string} => ({eventId:this.ids.next("audit"),occurredAt});
    switch (command.type) {
      case "CreateCustomer": { const customerId=this.ids.next("customer"); this.ledger.createCustomer(customerId,assertText(command.displayName,"displayName",200),event()); return {ok:true,action:command.type,occurredAt,customerId}; }
      case "CreateCase": { const customerId=parseCustomerId(command.customerId), caseId=this.ids.next("case"); this.ledger.createCase(caseId,customerId,assertText(command.title,"title",500),event()); return {ok:true,action:command.type,occurredAt,caseId,customerId}; }
      case "StartInvestigation": { const caseId=parseCaseId(command.caseId); this.ledger.startInvestigation(caseId,event()); return {ok:true,action:command.type,occurredAt,caseId}; }
      case "WaitForCustomer": { const caseId=parseCaseId(command.caseId); this.ledger.waitForCustomer(caseId,event()); return {ok:true,action:command.type,occurredAt,caseId}; }
      case "ResumeInvestigation": { const caseId=parseCaseId(command.caseId); this.ledger.resumeInvestigation(caseId,event()); return {ok:true,action:command.type,occurredAt,caseId}; }
      case "ResolveCase": { const caseId=parseCaseId(command.caseId); this.ledger.resolveCase(caseId,event()); return {ok:true,action:command.type,occurredAt,caseId}; }
      case "CloseCase": { const caseId=parseCaseId(command.caseId); const revokedGrantIds=this.ledger.closeCase(caseId,event()); return {ok:true,action:command.type,occurredAt,caseId,revokedGrantIds}; }
      case "IssueGrant": {
        const caseId=parseCaseId(command.caseId), expiresAt=assertIsoTimestamp(command.expiresAt,"expiresAt"), maxBytes=assertPositiveBigint(command.maxBytes,"maxBytes");
        if (expiresAt <= occurredAt) throw new DumpLedgerError("invalid_input","grant expiry must be in the future");
        const maxUploads=assertMaxUploads(command.maxUploads);
        const grantId=this.ids.next("grant"), grantSecret=this.entropy.secret(); if (grantSecret.length < 24) throw new DumpLedgerError("integrity_failure","entropy source returned a short secret");
        this.ledger.issueGrant(grantId,caseId,digestSecret(grantSecret,this.grantSecretKey),expiresAt,maxBytes,maxUploads,event()); return {ok:true,action:command.type,occurredAt,grantId,grantSecret,caseId,maxBytes,maxUploads};
      }
      case "RevokeGrant": { const grantId=parseGrantId(command.grantId); this.ledger.transitionGrant(grantId,"revoked",event()); return {ok:true,action:command.type,occurredAt,grantId}; }
      case "ExpireGrant": { const grantId=parseGrantId(command.grantId); this.ledger.transitionGrant(grantId,"expired",event()); return {ok:true,action:command.type,occurredAt,grantId}; }
      case "BeginUpload": {
        const secret=assertText(command.grantSecret,"grantSecret",1024), originalName=assertText(command.originalName,"originalName",1024), grant=this.ledger.findGrantByDigest(digestSecret(secret,this.grantSecretKey));
        if (grant===null) throw new DumpLedgerError("grant_invalid","upload grant is invalid");
        if (grant.state==="consumed") throw new DumpLedgerError("grant_consumed","upload grant has already been used");
        if (grant.state==="expired" || grant.expiresAt<=occurredAt) throw new DumpLedgerError("grant_expired","upload grant has expired");
        if (grant.state!=="issued") throw new DumpLedgerError("grant_invalid","upload grant is not active");
        const dumpId=this.ids.next("dump"); this.options.vault.createStaging(dumpId); this.failpoints.hit("after_staging_create");
        try { this.ledger.beginUpload(grant.grantId,dumpId,originalName,event()); } catch(error) { this.options.vault.removeStaging(dumpId); throw error; }
        return {ok:true,action:command.type,occurredAt,dumpId,caseId:grant.caseId,grantId:grant.grantId,maxBytes:grant.maxBytes,phase:"receiving"};
      }
      case "SealUpload": { const dumpId=parseDumpId(command.dumpId); this.requirePhase(dumpId,"receiving"); if (!this.options.vault.inspectPresence(dumpId).staging) throw new DumpLedgerError("integrity_failure","sealed upload has no staging object"); this.ledger.sealUpload(dumpId,assertNonnegativeBigint(command.byteSize,"byteSize"),assertSha256(command.sha256),event()); return {ok:true,action:command.type,occurredAt,dumpId,phase:"sealed"}; }
      case "FailUpload": { const dumpId=parseDumpId(command.dumpId); this.requirePhase(dumpId,"receiving"); this.options.vault.removeStaging(dumpId); this.ledger.failUpload(dumpId,event()); return {ok:true,action:command.type,occurredAt,dumpId,phase:"rejected"}; }
      case "PromoteObject": { const dumpId=parseDumpId(command.dumpId); this.requirePhase(dumpId,"sealed"); this.options.vault.promote(dumpId); this.failpoints.hit("after_vault_promote"); this.ledger.recordPromoted(dumpId,event()); return {ok:true,action:command.type,occurredAt,dumpId,phase:"sealed"}; }
      case "MarkQuarantined": { const dumpId=parseDumpId(command.dumpId); this.requirePhase(dumpId,"sealed"); const presence=this.options.vault.inspectPresence(dumpId); if(!presence.vault||presence.staging) throw new DumpLedgerError("integrity_failure","quarantine requires only an immutable vault object"); this.ledger.markQuarantined(dumpId,event()); return {ok:true,action:command.type,occurredAt,dumpId,phase:"quarantined"}; }
      case "AcceptDump": { const dumpId=parseDumpId(command.dumpId); this.requirePhase(dumpId,"quarantined"); const inspection=this.options.inspection.inspect(dumpId); if(!inspection.ok) throw new DumpLedgerError("inspection_outcome_mismatch","inspection rejected the dump"); this.ledger.acceptDump(dumpId,inspection.coverage,inspection.facts,event()); return {ok:true,action:command.type,occurredAt,dumpId,phase:"available"}; }
      case "RejectDump": { const dumpId=parseDumpId(command.dumpId); this.requirePhase(dumpId,"quarantined"); const inspection=this.options.inspection.inspect(dumpId); if(inspection.ok) throw new DumpLedgerError("inspection_outcome_mismatch","inspection accepted the dump"); this.ledger.rejectDump(dumpId,inspection.error,event()); return {ok:true,action:command.type,occurredAt,dumpId,phase:"rejected"}; }
      case "AuthorizeDownload": { const dumpId=parseDumpId(command.dumpId); if(!this.options.vault.inspectPresence(dumpId).vault) throw new DumpLedgerError("integrity_failure","available dump bytes are missing"); const dump=this.ledger.authorizeDownload(dumpId,event()); return {ok:true,action:command.type,occurredAt,dumpId,phase:dump.phase,dump}; }
      case "SetRetention": { const dumpId=parseDumpId(command.dumpId), purgeAt=assertIsoTimestamp(command.purgeAt,"purgeAt"); if(purgeAt<=occurredAt) throw new DumpLedgerError("invalid_input","purgeAt must be in the future"); this.ledger.setRetention(dumpId,purgeAt,event()); return {ok:true,action:command.type,occurredAt,dumpId,purgeAt}; }
      case "BeginPurge": { const dumpId=parseDumpId(command.dumpId), dump=this.requireOneOfPhases(dumpId,["available","rejected"]); this.ledger.beginPurge(dumpId,event()); return {ok:true,action:command.type,occurredAt,dumpId,caseId:dump.caseId,phase:"deleting"}; }
      case "FinishPurge": { const dumpId=parseDumpId(command.dumpId); this.requirePhase(dumpId,"deleting"); this.options.vault.remove(dumpId); this.failpoints.hit("after_vault_remove"); this.ledger.finishPurge(dumpId,event()); return {ok:true,action:command.type,occurredAt,dumpId,phase:"deleted"}; }
      case "IngestSymbol": {
        const vault=this.requireSymbolVault();
        parseSymbolArtifactKind(command.kind);
        const artifactId=this.ids.next("symbol");
        vault.createSymbolStaging(artifactId);
        return {ok:true,action:command.type,occurredAt,artifactId};
      }
      case "SealSymbol": {
        const vault=this.requireSymbolVault();
        const artifactId=parseSymbolArtifactId(command.artifactId), sha256=assertSha256(command.sha256);
        const byteSize=assertPositiveBigint(command.byteSize,"byteSize");
        const product=command.product===undefined?null:assertText(command.product,"product",200), version=command.version===undefined?null:assertText(command.version,"version",200), arch=command.arch===undefined?null:assertText(command.arch,"arch",64);
        // The identity pair is fixed by the kind: a PDB resolves by its RSDS
        // debug identity, an EXE/DLL image by its PE code identity.
        const identity=command.kind==="pdb"
          ? {name:assertText(command.debugFile,"debugFile",255),id:assertText(command.debugId,"debugId",64)}
          : {name:assertText(command.codeFile,"codeFile",255),id:assertText(command.codeId,"codeId",64)};
        const existing=this.ledger.findSymbolArtifact(identity.name,identity.id,command.kind);
        if (existing!==undefined) {
          vault.removeSymbolStaging(artifactId);
          return {ok:true,action:command.type,occurredAt,artifactId:existing.artifactId,deduplicated:true};
        }
        vault.promoteSymbol(artifactId); this.failpoints.hit("after_symbol_vault_promote");
        const sealed=this.ledger.sealSymbolArtifact({artifactId,kind:command.kind,debugFile:command.kind==="pdb"?identity.name:null,debugId:command.kind==="pdb"?identity.id:null,codeFile:command.kind==="exe"?identity.name:null,codeId:command.kind==="exe"?identity.id:null,byteSize,sha256,product,version,arch},event());
        return {ok:true,action:command.type,occurredAt,artifactId:sealed.artifact.artifactId,deduplicated:sealed.deduplicated};
      }
      case "FailSymbol": {
        this.requireSymbolVault().removeSymbolStaging(parseSymbolArtifactId(command.artifactId));
        return {ok:true,action:command.type,occurredAt};
      }
      case "PurgeSymbol": {
        const vault=this.requireSymbolVault(), artifactId=parseSymbolArtifactId(command.artifactId);
        if (this.ledger.findSymbolArtifactById(artifactId)===undefined) throw new DumpLedgerError("not_found","symbol artifact was not found");
        vault.removeSymbol(artifactId); this.failpoints.hit("after_symbol_vault_remove");
        this.ledger.purgeSymbolArtifact(artifactId,event());
        return {ok:true,action:command.type,occurredAt,artifactId};
      }
      case "BeginImport": {
        const manifestDigest=assertText(command.manifestDigest,"manifestDigest",128), counts=assertImportCounts(command.counts,"counts");
        const marker=event();
        this.ledger.beginImport(marker,{importId:marker.eventId,manifestDigest,counts});
        return {ok:true,action:command.type,occurredAt,importId:marker.eventId};
      }
      case "ImportCustomer": {
        const record=command.record, customerId=parseCustomerId(record.customerId), displayName=assertText(record.displayName,"displayName",200), createdAt=assertIsoTimestamp(record.createdAt,"createdAt");
        this.ledger.importCustomer({customerId,displayName,createdAt},event());
        return {ok:true,action:command.type,occurredAt,customerId};
      }
      case "ImportCase": {
        const record=command.record, caseId=parseCaseId(record.caseId), customerId=parseCustomerId(record.customerId), title=assertText(record.title,"title",500), status=parseCaseStatus(record.status), createdAt=assertIsoTimestamp(record.createdAt,"createdAt");
        this.ledger.importCase({caseId,customerId,title,status,createdAt},event());
        return {ok:true,action:command.type,occurredAt,caseId,customerId};
      }
      case "ImportGrant": {
        const record=command.record;
        if (command.forcedState!==undefined && command.forcedState!=="revoked") throw new DumpLedgerError("invalid_input","forcedState must be \"revoked\"");
        const grantId=parseGrantId(record.grantId), caseId=parseCaseId(record.caseId), secretDigest=assertText(record.secretDigest,"secretDigest",128), state=parseTokenState(record.state);
        const expiresAt=assertIsoTimestamp(record.expiresAt,"expiresAt"), maxBytes=assertPositiveBigint(record.maxBytes,"maxBytes"), createdAt=assertIsoTimestamp(record.createdAt,"createdAt");
        const consumedByDumpId=record.consumedByDumpId===null?null:parseDumpId(record.consumedByDumpId);
        const maxUploads=assertMaxUploads(record.maxUploads), uploadsUsed=record.uploadsUsed===undefined?0:assertUploadsUsed(record.uploadsUsed);
        this.ledger.importGrant({grantId,caseId,secretDigest,state,expiresAt,maxBytes,maxUploads,uploadsUsed,consumedByDumpId,createdAt},command.forcedState,event());
        return {ok:true,action:command.type,occurredAt,grantId,caseId};
      }
      case "ImportDumpStaged": {
        const record=command.record, dumpId=parseDumpId(record.dumpId), caseId=parseCaseId(record.caseId), phase=parseDumpPhase(record.phase);
        const originalName=assertText(record.originalName,"originalName",1024), receivedAt=assertIsoTimestamp(record.receivedAt,"receivedAt");
        const byteSize=assertNullableByteSize(record.byteSize), sha256=assertNullableSha256(record.sha256);
        const purgeAt=assertNullableIsoTimestamp(record.purgeAt,"purgeAt"), purgedAt=assertNullableIsoTimestamp(record.purgedAt,"purgedAt");
        if (phase==="available") {
          if (byteSize===null || sha256===null) throw new DumpLedgerError("invalid_input","an available import requires byteSize and sha256");
          const presence=this.options.vault.inspectPresence(dumpId);
          if (!presence.staging || presence.vault) throw new DumpLedgerError("integrity_failure","imported dump bytes are not staged");
          try { this.ledger.importDumpStaged({dumpId,caseId,originalName,byteSize,sha256,receivedAt,purgeAt},event()); } catch (error) { this.options.vault.removeStaging(dumpId); throw error; }
          return {ok:true,action:command.type,occurredAt,dumpId,caseId,phase:"sealed"};
        }
        if (phase!=="rejected" && phase!=="deleted") throw new DumpLedgerError("invalid_transition",`dump phase ${phase} cannot be imported`);
        const validation=parseValidationState(record.validation), coverage=assertNullableCoverage(record.coverage);
        const inspectionError=record.inspectionError===null?null:assertText(record.inspectionError,"inspectionError",2000);
        const availableAt=assertNullableIsoTimestamp(record.availableAt,"availableAt");
        this.ledger.importDumpTombstone({dumpId,caseId,phase,originalName,byteSize,sha256,validation,coverage,inspectionError,inspectionFacts:assertInspectionFacts(record.inspectionFacts),receivedAt,availableAt,purgeAt,purgedAt},event());
        return {ok:true,action:command.type,occurredAt,dumpId,caseId,phase};
      }
      case "ImportAuditEvent": {
        const record=command.record, eventId=parseAuditEventId(record.eventId), action=assertText(record.action,"action",64), eventOccurredAt=assertIsoTimestamp(record.occurredAt,"occurredAt");
        const customerId=record.customerId===null?null:parseCustomerId(record.customerId), caseId=record.caseId===null?null:parseCaseId(record.caseId), dumpId=record.dumpId===null?null:parseDumpId(record.dumpId);
        const detail=assertPlainObject(record.detail,"detail",16 * 1024);
        this.ledger.importAuditEvent({eventId,occurredAt:eventOccurredAt,action,customerId,caseId,dumpId,detail});
        return {ok:true,action:command.type,occurredAt};
      }
      case "FinishImport": {
        const importId=parseAuditEventId(command.importId), summary=assertImportSummary(command.summary);
        this.ledger.finishImport(event(),importId,{importId,imported:summary.imported,skipped:summary.skipped});
        return {ok:true,action:command.type,occurredAt,importId};
      }
    }
  }
  private requirePhase(dumpId: DumpId, phase: DumpPhase): DumpLedgerProjection["dumps"][number] { return this.requireOneOfPhases(dumpId,[phase]); }
  private requireSymbolVault(): SymbolVault {
    if (this.symbolVault === undefined) throw new DumpLedgerError("storage_unavailable", "symbol storage is not configured");
    return this.symbolVault;
  }
  private requireOneOfPhases(dumpId: DumpId, phases: readonly DumpPhase[]): DumpLedgerProjection["dumps"][number] { const dump=this.ledger.getDump(dumpId); if(dump===null) throw new DumpLedgerError("not_found","dump was not found"); if(!phases.includes(dump.phase)) throw new DumpLedgerError("invalid_transition",`dump phase ${dump.phase} is not valid for this action`); return dump; }
}
export function createDumpLedgerEngine(options: DumpLedgerEngineOptions): DumpLedgerEngine { return new Engine(options); }
