import type { DumpId } from "../domain/ids.js";
import type { DumpLedgerEngine } from "../engine/dump-ledger-engine.js";
import type { TransitionReceipt } from "../engine/projection.js";
import type { Vault } from "../vault/vault.js";
export interface ReconciliationAction { readonly dumpId: DumpId; readonly outcome: "available"|"rejected"|"deleted"|"transfer-failed"|"orphan-removed"|"integrity-alarm"; readonly detail: string }
export interface ReconciliationReport { readonly actions: readonly ReconciliationAction[] }
export interface ReconciliationOptions { readonly nowMs?: number; readonly orphanGraceMs?: number }
function requireSuccess(receipt: TransitionReceipt): void { if(!receipt.ok) throw new Error(`reconciliation ${receipt.action} failed: ${receipt.error.code}`); }
function inspectQuarantined(engine: DumpLedgerEngine,dumpId:DumpId):"available"|"rejected" { const accepted=engine.execute({type:"AcceptDump",dumpId}); if(accepted.ok)return "available"; if(accepted.error.code!=="inspection_outcome_mismatch")requireSuccess(accepted); requireSuccess(engine.execute({type:"RejectDump",dumpId})); return "rejected"; }
export function reconcile(engine:DumpLedgerEngine,vault:Vault,options:ReconciliationOptions={}):ReconciliationReport {
  const actions:ReconciliationAction[]=[]; const initial=engine.snapshot(); const known=new Set(initial.dumps.map(d=>d.dumpId)); const nowMs=options.nowMs??Date.now(); const grace=options.orphanGraceMs??3600000;
  for(const orphan of vault.listStagingIds()) if(!known.has(orphan)){const modified=vault.stagingModifiedAt(orphan);if(modified!==null&&nowMs-modified>=grace){vault.removeStaging(orphan);actions.push({dumpId:orphan,outcome:"orphan-removed",detail:"removed aged unreferenced startup staging object"});}}
  for(const dump of initial.dumps){const presence=vault.inspectPresence(dump.dumpId);switch(dump.phase){
    case "receiving": vault.removeStaging(dump.dumpId);requireSuccess(engine.execute({type:"FailUpload",dumpId:dump.dumpId}));actions.push({dumpId:dump.dumpId,outcome:"transfer-failed",detail:"interrupted receiving upload was rejected"});break;
    case "sealed": {
      if(presence.staging===presence.vault){actions.push({dumpId:dump.dumpId,outcome:"integrity-alarm",detail:"sealed dump does not have exactly one recoverable object"});break;}
      if(dump.blobState==="staging")requireSuccess(engine.execute({type:"PromoteObject",dumpId:dump.dumpId}));
      else if(dump.blobState!=="vault"||!presence.vault){actions.push({dumpId:dump.dumpId,outcome:"integrity-alarm",detail:"sealed ledger and vault blob states disagree"});break;}
      requireSuccess(engine.execute({type:"MarkQuarantined",dumpId:dump.dumpId}));const outcome=inspectQuarantined(engine,dump.dumpId);actions.push({dumpId:dump.dumpId,outcome,detail:"resumed sealed dump promotion and inspection"});break;
    }
    case "quarantined": {if(!presence.vault){actions.push({dumpId:dump.dumpId,outcome:"integrity-alarm",detail:"quarantined dump has no vault object"});break;}const outcome=inspectQuarantined(engine,dump.dumpId);actions.push({dumpId:dump.dumpId,outcome,detail:"repeated idempotent inspection"});break;}
    case "available": if(!presence.vault){requireSuccess(engine.execute({type:"BeginPurge",dumpId:dump.dumpId}));requireSuccess(engine.execute({type:"FinishPurge",dumpId:dump.dumpId}));actions.push({dumpId:dump.dumpId,outcome:"integrity-alarm",detail:"missing available bytes were made non-downloadable and tombstoned"});}break;
    case "rejected": if(presence.staging){vault.removeStaging(dump.dumpId);actions.push({dumpId:dump.dumpId,outcome:"rejected",detail:"removed rejected staging residue"});}break;
    case "deleting": requireSuccess(engine.execute({type:"FinishPurge",dumpId:dump.dumpId}));actions.push({dumpId:dump.dumpId,outcome:"deleted",detail:"finished interrupted purge"});break;
    case "deleted": if(presence.staging||presence.vault){vault.remove(dump.dumpId);actions.push({dumpId:dump.dumpId,outcome:"integrity-alarm",detail:"removed bytes found after tombstone"});}break;
  }}return {actions};
}
