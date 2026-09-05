import type { StableError } from "../domain/errors.js";
import type { DumpId } from "../domain/ids.js";
import type { DumpLedgerEngine } from "../engine/dump-ledger-engine.js";
export type RetentionRunResult = {readonly dumpId:DumpId;readonly ok:true;readonly phase:"deleted"}|{readonly dumpId:DumpId;readonly ok:false;readonly step:"begin"|"finish";readonly error:StableError};
export interface RetentionRunReport {readonly results:readonly RetentionRunResult[];readonly hasMore:boolean}
export interface RetentionRunOptions {readonly limit?:number}
export function runRetention(engine:DumpLedgerEngine,at?:string,options:RetentionRunOptions={}):RetentionRunReport {
  const limit=options.limit??32;if(!Number.isSafeInteger(limit)||limit<=0)throw new RangeError("retention limit must be a positive safe integer");
  const results:RetentionRunResult[]=[];const due=engine.dueForPurge(at);const pending=engine.pendingPurgeCompletion();const candidates=[...pending.map(dumpId=>({dumpId,pending:true as const})),...due.map(dumpId=>({dumpId,pending:false as const}))];
  for(const candidate of candidates.slice(0,limit)){const {dumpId}=candidate;if(candidate.pending){const finished=engine.execute({type:"FinishPurge",dumpId});if(!finished.ok){results.push({dumpId,ok:false,step:"finish",error:finished.error});continue;}results.push({dumpId,ok:true,phase:"deleted"});continue;}
    const begun=engine.execute({type:"BeginPurge",dumpId});if(!begun.ok){results.push({dumpId,ok:false,step:"begin",error:begun.error});continue;}const finished=engine.execute({type:"FinishPurge",dumpId});if(!finished.ok){results.push({dumpId,ok:false,step:"finish",error:finished.error});continue;}results.push({dumpId,ok:true,phase:"deleted"});}
  return {results,hasMore:candidates.length>limit||results.some(result=>!result.ok)};
}
