import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertRichAnalysis } from "../../src/domain/rich-report.js";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("engine and framework-free contract mirror identical canonical schema rules", () => {
  const body = (path: string): string => {
    const text = readFileSync(new URL(path, import.meta.url), "utf8");
    return text.slice(text.indexOf("/** Schema rules"), text.indexOf("\nexport interface"));
  };
  assert.equal(body("../../../src/domain/rich-report.ts"), body("../../../packages/http-contracts/src/rich-analyses.ts"));
});

test("the actual Rust canonical report satisfies the TypeScript digest/identity/assessment boundary", () => {
  const reportJson = readFileSync(new URL("../../../packages/http-contracts/test/fixtures/rust-canonical-report.json", import.meta.url), "utf8");
  const r = JSON.parse(reportJson) as { identity: { dumpId: string; inputSha256: string; kind: string; analyzerName: string; analyzerVersion: string }; outcome: string; summary: string; reportId: string; exception: { code: string | null }; stack: { frames: unknown[] }; rootCause: { status: string } }, reportDigest = createHash("sha256").update(reportJson).digest("hex");
  assert.equal(reportDigest, "8f63144361a5407fa16f78eb229cbc9097d124f8d6681ad5fe8cc46bfce5873e");
  assertRichAnalysis({ reportJson, reportDigest }, { ...r.identity, outcome: r.outcome, summary: r.summary, facts: { schemaVersion: 2, reportId: r.reportId, reportDigest, exceptionCode: r.exception.code, frameCount: r.stack.frames.length, causeStatus: r.rootCause.status } });
});
