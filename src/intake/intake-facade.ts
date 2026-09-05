import { parseDumpId } from "../domain/ids.js";
import type { DumpLedgerEngine } from "../engine/dump-ledger-engine.js";
import type { Vault } from "../vault/vault.js";
import type { UploadByteSink, UploadLifecyclePort } from "./upload-session.js";

/**
 * Narrow asynchronous-intake adapter. It keeps HTTP independent of the
 * engine's command union while preserving the engine as lifecycle authority.
 */
export class EngineUploadLifecycle implements UploadLifecyclePort {
  constructor(private readonly engine: DumpLedgerEngine) {}

  begin(input: { readonly grantSecret: string; readonly originalName: string }) {
    const receipt = this.engine.execute({ type: "BeginUpload", ...input });
    if (!receipt.ok || receipt.dumpId === undefined || receipt.maxBytes === undefined) {
      return { ok: false as const, code: receipt.ok ? "integrity_failure" : receipt.error.code };
    }
    return { ok: true as const, dumpId: receipt.dumpId, maxBytes: receipt.maxBytes };
  }

  seal(input: { readonly dumpId: string; readonly byteSize: bigint; readonly sha256: string }) {
    let dumpId;
    try { dumpId = parseDumpId(input.dumpId); } catch { return { ok: false as const, code: "invalid_dump" }; }
    const receipt = this.engine.execute({ type: "SealUpload", dumpId, byteSize: input.byteSize, sha256: input.sha256 });
    return receipt.ok ? { ok: true as const } : { ok: false as const, code: receipt.error.code };
  }

  fail(input: { readonly dumpId: string; readonly reason: string }) {
    let dumpId;
    try { dumpId = parseDumpId(input.dumpId); } catch { return { ok: false as const, code: "invalid_dump" }; }
    const receipt = this.engine.execute({ type: "FailUpload", dumpId });
    return receipt.ok ? { ok: true as const } : { ok: false as const, code: receipt.error.code };
  }
}

export class VaultUploadSink implements UploadByteSink {
  constructor(private readonly vault: Vault) {}

  append(dumpId: string, chunk: Uint8Array): void {
    this.vault.append(parseDumpId(dumpId), chunk);
  }

  syncAndClose(dumpId: string): void {
    this.vault.syncAndClose(parseDumpId(dumpId));
  }
}

export interface UploadPostProcessor {
  process(dumpId: string): "available" | "rejected";
}

/** Completes the durable post-transfer lifecycle without crossing an await. */
export class EngineUploadPostProcessor implements UploadPostProcessor {
  constructor(private readonly engine: DumpLedgerEngine) {}

  process(dumpIdText: string): "available" | "rejected" {
    const dumpId = parseDumpId(dumpIdText);
    let dump = this.engine.snapshot().dumps.find(candidate => candidate.dumpId === dumpId);
    if (dump === undefined) throw new Error("post-processing dump was not found");
    if (dump.phase === "available" || dump.phase === "rejected") return dump.phase;
    if (dump.phase === "sealed") {
      if (dump.blobState === "staging") {
        this.requireSuccess(this.engine.execute({ type: "PromoteObject", dumpId }));
      }
      this.requireSuccess(this.engine.execute({ type: "MarkQuarantined", dumpId }));
      dump = this.engine.snapshot().dumps.find(candidate => candidate.dumpId === dumpId);
    }
    if (dump?.phase !== "quarantined") throw new Error(`post-processing cannot resume from ${dump?.phase ?? "missing"}`);
    const accepted = this.engine.execute({ type: "AcceptDump", dumpId });
    if (accepted.ok) return "available";
    if (accepted.error.code !== "inspection_outcome_mismatch") {
      this.requireSuccess(accepted);
    }
    this.requireSuccess(this.engine.execute({ type: "RejectDump", dumpId }));
    return "rejected";
  }

  private requireSuccess(receipt: ReturnType<DumpLedgerEngine["execute"]>): void {
    if (!receipt.ok) throw new Error(`${receipt.action} failed: ${receipt.error.code}`);
  }
}
