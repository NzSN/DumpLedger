import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodeRecordRichAnalysisRequest, decodeRichAnalysisReport, MAX_RICH_REPORT_BYTES } from "../src/rich-analyses.js";
import { decodeJsonText } from "../src/decode.js";
import { bindRichFixture, richFixture } from "./rich-fixture.js";

describe("canonical rich analysis contract", () => {
  it("accepts the actual Rust canonical wire document without reserialization", () => {
    const reportJson = readFileSync(new URL("../../test/fixtures/rust-canonical-report.json", import.meta.url), "utf8");
    const report = JSON.parse(reportJson) as Record<string, unknown>, generated = bindRichFixture(report);
    assert.equal(generated.reportJson, reportJson);
    decodeRecordRichAnalysisRequest({ ...generated, reportJson }, "$");
  });
  it("round trips exact canonical bytes and compact binding", () => {
    const { request } = richFixture();
    assert.deepEqual(decodeRecordRichAnalysisRequest(request, "$"), request);
    assert.deepEqual(decodeJsonText(JSON.stringify(request), decodeRecordRichAnalysisRequest), request);
    const response = { ...request, analysisId: "analysis_00000000000000000000000001", dumpId: "dump_00000000000000000000000001", createdAt: "2026-10-15T00:00:00.000Z" };
    assert.deepEqual(decodeRichAnalysisReport(response, "$"), response);
    assert.throws(() => decodeRichAnalysisReport({ ...response, unexpected: true }, "$"));
  });
  for (const key of ["exception", "stack", "symbols", "rootCause", "context", "provenance", "evidence", "completeness"]) it(`requires ${key}`, () => {
    const { document, request } = richFixture(); delete document[key];
    assert.throws(() => decodeRecordRichAnalysisRequest({ ...request, reportJson: JSON.stringify(document) }, "$"));
  });
  it("rejects absent/forged nested citations, duplicate IDs, and model confirmation", () => {
    for (const mutation of [
      (d: Record<string, unknown>) => { (d.rootCause as Record<string, unknown>).status = "confirmed"; },
      (d: Record<string, unknown>) => { (d.rootCause as Record<string, unknown>).hypotheses = [{ explanation: "Claim", evidenceRefs: ["fabricated"], missingEvidence: ["Proof"], nextChecks: [] }]; },
      (d: Record<string, unknown>) => { (d.evidence as unknown[]).push((d.evidence as unknown[])[0]); },
      (d: Record<string, unknown>) => { (d.exception as Record<string, unknown>).address = "900719925474099300000"; },
      (d: Record<string, unknown>) => { (d.exception as Record<string, unknown>).address = "0xFFFF"; },
      (d: Record<string, unknown>) => { (d.exception as Record<string, unknown>).address = "1000"; },
      (d: Record<string, unknown>) => { (d.stack as Record<string, unknown>).frames = new Array(129).fill({}); },
      (d: Record<string, unknown>) => { ((d.rootCause as Record<string, unknown>).mechanism as Record<string, unknown>).status = "confirmed"; },
    ]) { const { document } = richFixture(); mutation(document); assert.throws(() => decodeRecordRichAnalysisRequest(bindRichFixture(document), "$")); }
  });

  it("accepts matched hyphenated PDB identities and rejects mismatched loaded identity", () => {
    const { document } = richFixture(), id = { guid: "00112233-4455-6677-8899-aabbccddeeff", age: 2 };
    (document.symbols as Record<string, unknown>).modules = [{ module: "app", imageBase: "0x1000", imageSize: "0x100", timestamp: "0x12345678", expectedPdb: id, loadedPdb: { ...id }, pdbPath: "cache/app.pdb", quality: "matched", evidenceRefs: ["exception"] }];
    decodeRecordRichAnalysisRequest(bindRichFixture(document), "$");
    (((document.symbols as Record<string, unknown>).modules as Array<Record<string, unknown>>)[0]!.loadedPdb as Record<string, unknown>).age = 3;
    assert.throws(() => decodeRecordRichAnalysisRequest(bindRichFixture(document), "$"));
  });
  it("accepts only the exact independently checked mechanism template", () => {
    const { document } = richFixture(), context = document.context as Record<string, unknown>, cause = document.rootCause as Record<string, unknown>;
    context.registers = { rax: "0x0" }; context.evidenceRefs = ["exception"]; context.faultInstruction = { address: "0x1000", bytes: "488b00", disassembly: "mov rax,qword ptr [rax]", effectiveAddress: "0x0", evidenceRefs: ["exception"] };
    const mechanism = { status: "confirmed", description: "The saved exception instruction reads through rax at 0x0, matching the access-violation target 0x0. This establishes the immediate faulting read; the origin of the pointer is not established.", evidenceRefs: ["exception"] };
    cause.mechanism = mechanism; decodeRecordRichAnalysisRequest(bindRichFixture(document), "$");
    mechanism.description = "A use-after-free definitely caused this crash";
    assert.throws(() => decodeRecordRichAnalysisRequest(bindRichFixture(document), "$"));
  });
  it("rejects unknown fields, duplicate JSON keys, missing digest binding, oversized UTF8", () => {
    const { request } = richFixture();
    assert.throws(() => decodeRecordRichAnalysisRequest({ ...request, extra: true }, "$"));
    assert.throws(() => decodeRecordRichAnalysisRequest({ ...request, facts: {} }, "$"));
    assert.throws(() => decodeRecordRichAnalysisRequest({ ...request, reportJson: request.reportJson.replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2') }, "$"));
    assert.throws(() => decodeRecordRichAnalysisRequest({ ...request, reportJson: "中".repeat(MAX_RICH_REPORT_BYTES / 3 + 1) }, "$"));
  });
});
