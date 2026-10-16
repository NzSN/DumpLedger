import { createHash } from "node:crypto";
import type { RecordRichAnalysisRequest } from "../src/rich-analyses.js";

/** Synthetic evidence only: no production dump, PDB, paths, or model claims. */
export function richFixture(dumpId = "dump_00000000000000000000000001", inputSha256 = "a".repeat(64)): { document: Record<string, unknown>; request: RecordRichAnalysisRequest } {
  const document: Record<string, unknown> = {
    schemaVersion: 2, reportId: "", identity: { dumpId, inputSha256, kind: "triage", analyzerName: "dumpanalyzer", analyzerVersion: "0.2.0" },
    outcome: "completed", summary: "Captured exception evidence; underlying cause unknown",
    provenance: { provider: "cdb-ssh", debuggerVersion: null, architecture: "amd64", pointerWidth: 64, processId: null, model: null, analysisRevision: "synthetic-fixture-v1" },
    exception: { status: "present", code: "0xc0000005", flags: "0x0", address: "0x1000", recordPointer: null, parameterCount: 2, parameters: ["0x0", "0x0"], access: { operation: "read", address: "0x0", underlyingStatus: null }, evidenceRefs: ["exception"] },
    context: { source: "exception", threadId: null, registers: {}, faultInstruction: null, evidenceRefs: [] },
    stack: { threadId: null, status: "unavailable", frames: [], limitations: ["Synthetic fixture carries no stack"] },
    symbols: { modules: [], limitations: ["Synthetic fixture carries no PDB"] },
    rootCause: { status: "unknown", mechanism: { status: "unknown", description: "The exception reports an invalid read", evidenceRefs: ["exception"] }, conclusion: "Underlying cause unknown", evidenceRefs: [], hypotheses: [], missingEvidence: ["Pointer origin"], nextChecks: ["Controlled reproduction"], ruleId: null },
    evidence: [{ id: "exception", command: ".exr -1", status: "present", text: "ExceptionCode: c0000005", truncated: false, error: null }],
    completeness: { omissions: ["Synthetic fixture"], truncated: false },
  };
  return { document, request: bindRichFixture(document) };
}

export function bindRichFixture(document: Record<string, unknown>): RecordRichAnalysisRequest {
  const identity = document.identity as Record<string, string>, hash = createHash("sha256");
  for (const key of ["dumpId", "inputSha256", "kind", "analyzerName", "analyzerVersion"]) { const bytes = Buffer.from(identity[key]!, "utf8"), length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length)); hash.update(length).update(bytes); }
  document.reportId = `r2_${hash.digest("hex")}`;
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable((v as Record<string, unknown>)[k])])) : v;
  const reportJson = JSON.stringify(stable(document)), reportDigest = createHash("sha256").update(reportJson, "utf8").digest("hex");
  return { analyzer: { name: identity.analyzerName!, version: identity.analyzerVersion! }, kind: identity.kind!, inputSha256: identity.inputSha256!, outcome: document.outcome as "completed" | "failed", summary: document.summary as string,
    facts: { schemaVersion: 2, reportId: document.reportId, reportDigest, exceptionCode: (document.exception as Record<string, unknown>).code, frameCount: ((document.stack as Record<string, unknown>).frames as unknown[]).length, causeStatus: (document.rootCause as Record<string, unknown>).status }, reportJson, reportDigest };
}
