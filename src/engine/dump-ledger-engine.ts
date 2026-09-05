import { createHmac } from "node:crypto";
import { DumpLedgerError, SimulatedCrash } from "../domain/errors.js";
import { parseCaseId, parseCustomerId, parseDumpId, parseGrantId, type AuditEventId, type DumpId, type IdSource } from "../domain/ids.js";
import type { DumpPhase } from "../domain/lifecycle.js";
import { SqliteLedger } from "../ledger/sqlite-ledger.js";
import type { Vault } from "../vault/vault.js";
import type { LifecycleCommand } from "./commands.js";
import { CryptoEntropy, NoFailpoints, RandomIds, SystemClock, type Clock, type EntropySource, type FailpointPort } from "./dependencies.js";
import type { InspectionPort } from "./inspection-port.js";
import type { BackupInventory, DumpLedgerProjection, TransitionReceipt, TransitionSuccess } from "./projection.js";

export { DeterministicClock, DeterministicEntropy, DeterministicIds, ScriptedFailpoints } from "./dependencies.js";
export type { DurableCheckpoint } from "./dependencies.js";
export type { InspectionOutcome, InspectionPort } from "./inspection-port.js";
export type { LifecycleCommand } from "./commands.js";
export type { BackupInventory, BackupInventoryDump, DumpLedgerProjection, TransitionReceipt } from "./projection.js";

export interface DumpLedgerEngineOptions { readonly databasePath: string; readonly vault: Vault; readonly inspection: InspectionPort; readonly grantSecretKey: Uint8Array; readonly clock?: Clock; readonly entropy?: EntropySource; readonly ids?: IdSource; readonly failpoints?: FailpointPort }
export interface DumpLedgerEngine {
  execute(command: LifecycleCommand): TransitionReceipt;
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

class Engine implements DumpLedgerEngine {
  private readonly ledger: SqliteLedger;
  private readonly clock: Clock;
  private readonly entropy: EntropySource;
  private readonly ids: IdSource;
  private readonly failpoints: FailpointPort;
  private readonly grantSecretKey: Uint8Array;
  constructor(private readonly options: DumpLedgerEngineOptions) {
    if (options.grantSecretKey.byteLength < 32) throw new DumpLedgerError("invalid_input", "grantSecretKey must contain at least 32 bytes");
    this.grantSecretKey = Uint8Array.from(options.grantSecretKey);
    this.ledger = new SqliteLedger(options.databasePath);
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
      case "IssueGrant": {
        const caseId=parseCaseId(command.caseId), expiresAt=assertIsoTimestamp(command.expiresAt,"expiresAt"), maxBytes=assertPositiveBigint(command.maxBytes,"maxBytes");
        if (expiresAt <= occurredAt) throw new DumpLedgerError("invalid_input","grant expiry must be in the future");
        const grantId=this.ids.next("grant"), grantSecret=this.entropy.secret(); if (grantSecret.length < 24) throw new DumpLedgerError("integrity_failure","entropy source returned a short secret");
        this.ledger.issueGrant(grantId,caseId,digestSecret(grantSecret,this.grantSecretKey),expiresAt,maxBytes,event()); return {ok:true,action:command.type,occurredAt,grantId,grantSecret,caseId,maxBytes};
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
    }
  }
  private requirePhase(dumpId: DumpId, phase: DumpPhase): DumpLedgerProjection["dumps"][number] { return this.requireOneOfPhases(dumpId,[phase]); }
  private requireOneOfPhases(dumpId: DumpId, phases: readonly DumpPhase[]): DumpLedgerProjection["dumps"][number] { const dump=this.ledger.getDump(dumpId); if(dump===null) throw new DumpLedgerError("not_found","dump was not found"); if(!phases.includes(dump.phase)) throw new DumpLedgerError("invalid_transition",`dump phase ${dump.phase} is not valid for this action`); return dump; }
}
export function createDumpLedgerEngine(options: DumpLedgerEngineOptions): DumpLedgerEngine { return new Engine(options); }
