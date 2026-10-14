import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DumpLedgerError } from "../../src/domain/errors.js";
import {
  EXPORT_MANIFEST_SCHEMA,
  parseExportManifest,
  serializeExportManifest,
  type ExportManifest,
} from "../../src/transfer/manifest.js";

/**
 * Unit coverage for the top-level `skippedAnalyses` count
 * (docs/analyzer-integration-design.md, "Transfer exclusion"): export bundles
 * carry no analysis reports into the import surface, so the manifest records
 * how many reports were attached to the exported dumps. The field follows the
 * auditEvents optional-field precedent — the exporter always writes it (0 when
 * no exported dump has a report), while a bundle written before the field
 * existed still parses without it.
 */

function baseManifest(overrides: Partial<ExportManifest> = {}): ExportManifest {
  return {
    schema: EXPORT_MANIFEST_SCHEMA,
    createdAt: "2026-09-04T00:00:00.000Z",
    generator: { version: "0.1.0", schemaMigrations: 8 },
    grantKeyFingerprint: "A".repeat(43),
    counts: { customers: 0, cases: 0, grants: 0, dumps: 0, auditEvents: 0 },
    skipped: [],
    dumps: [],
    ...overrides,
  };
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** The exact wire shape the current serializer emits for the empty base manifest. */
function wire(): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(serializeExportManifest(baseManifest()))) as Record<string, unknown>;
}

function expectInvalid(bytes: Uint8Array, message: RegExp): void {
  assert.throws(
    () => parseExportManifest(bytes),
    (error: unknown) => {
      assert.ok(error instanceof DumpLedgerError, String(error));
      assert.equal((error as DumpLedgerError).code, "invalid_input");
      assert.match((error as Error).message, message);
      return true;
    },
  );
}

describe("export manifest skippedAnalyses count", () => {
  it("round-trips the count through the canonical serializer", () => {
    const manifest = baseManifest({ skippedAnalyses: 3 });
    const bytes = serializeExportManifest(manifest);
    assert.ok(new TextDecoder().decode(bytes).includes("\"skippedAnalyses\":3"), "the count is written verbatim");
    assert.deepEqual(parseExportManifest(bytes), manifest);
  });

  it("writes an explicit zero when no exported dump has a report", () => {
    const manifest = baseManifest({ skippedAnalyses: 0 });
    const bytes = serializeExportManifest(manifest);
    assert.ok(new TextDecoder().decode(bytes).includes("\"skippedAnalyses\":0"), "zero is present, not omitted");
    assert.equal(parseExportManifest(bytes).skippedAnalyses, 0);
  });

  it("omits the field when absent and still parses pre-field bundles", () => {
    const manifest = baseManifest();
    const bytes = serializeExportManifest(manifest);
    assert.ok(!new TextDecoder().decode(bytes).includes("skippedAnalyses"), "undefined must not appear on the wire");
    assert.equal(parseExportManifest(bytes).skippedAnalyses, undefined);
    // The pre-field wire form (a v1 manifest with no skippedAnalyses key) must
    // stay parseable, exactly like a bundle written before auditEvents existed.
    const legacy = json({
      schema: EXPORT_MANIFEST_SCHEMA,
      createdAt: manifest.createdAt,
      generator: manifest.generator,
      grantKeyFingerprint: manifest.grantKeyFingerprint,
      counts: manifest.counts,
      skipped: [],
      dumps: [],
    });
    assert.deepEqual(parseExportManifest(legacy), manifest);
  });

  it("rejects malformed counts with the shared count-field bounds", () => {
    const base = wire();
    expectInvalid(json({ ...base, skippedAnalyses: "2" }), /\$\.skippedAnalyses: must be a safe integer/);
    expectInvalid(json({ ...base, skippedAnalyses: 1.5 }), /\$\.skippedAnalyses: must be a safe integer/);
    expectInvalid(json({ ...base, skippedAnalyses: null }), /\$\.skippedAnalyses: must be a safe integer/);
    expectInvalid(json({ ...base, skippedAnalyses: true }), /\$\.skippedAnalyses: must be a safe integer/);
    expectInvalid(json({ ...base, skippedAnalyses: -1 }), /\$\.skippedAnalyses: must be between 0 and 1000000000/);
    expectInvalid(json({ ...base, skippedAnalyses: 1_000_000_001 }), /\$\.skippedAnalyses: must be between 0 and 1000000000/);
  });

  it("keeps the strict key set: an unknown sibling field is still rejected", () => {
    expectInvalid(json({ ...wire(), skippedAnalysisCount: 1 }), /\$: unknown field "skippedAnalysisCount"/);
    expectInvalid(json({ ...wire(), skippedAnalyses: 0, otherField: null }), /\$: unknown field "otherField"/);
  });
});
