import { Readable } from "node:stream";

import { parseCaseId, parseCustomerId, parseDumpId, parseGrantId } from "../domain/ids.js";
import type { DumpLedgerEngine } from "../engine/dump-ledger-engine.js";
import type { Vault, VaultReader } from "../vault/vault.js";
import type { HttpApplicationPort, HttpProjection } from "./server.js";

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

  snapshot(): HttpProjection {
    const projection = this.engine.snapshot();
    return {
      customers: projection.customers.map(item => ({ customerId: item.customerId, displayName: item.displayName })),
      cases: projection.cases.map(item => ({ caseId: item.caseId, customerId: item.customerId, title: item.title, status: item.status })),
      grants: projection.grants.map(item => ({ grantId: item.grantId, caseId: item.caseId, state: item.state, expiresAt: Date.parse(item.expiresAt), maxBytes: item.maxBytes })),
      dumps: projection.dumps.map(item => ({
        dumpId: item.dumpId,
        caseId: item.caseId,
        phase: item.phase,
        ...(item.byteSize === null ? {} : { byteSize: item.byteSize }),
        ...(item.coverage === null ? {} : { coverage: item.coverage }),
        ...(item.purgeAt === null ? {} : { purgeAt: item.purgeAt }),
      })),
      auditEvents: projection.auditEvents.map(item => ({
        action: item.action,
        occurredAt: Date.parse(item.occurredAt),
        ...(item.caseId === null ? {} : { caseId: item.caseId }),
        ...(item.dumpId === null ? {} : { dumpId: item.dumpId }),
        ...(typeof item.detail.outcome === "string" ? { outcome: item.detail.outcome } : {}),
      })),
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
}
