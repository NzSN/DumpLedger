import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DumpLedgerError } from "../../src/domain/errors.js";
import type { SymbolArtifactId } from "../../src/domain/ids.js";
import {
  EXPORT_MANIFEST_SCHEMA,
  parseExportManifest,
  serializeExportManifest,
  symbolEntryName,
  type ExportManifest,
  type ExportManifestSymbol,
} from "../../src/transfer/manifest.js";

/**
 * Unit coverage for the opt-in symbol payload on `dump-ledger.export-manifest/v1`
 * (design milestone 3): the schema stays v1, the `symbols` field follows the
 * `auditEvents` optional-field precedent, and the strict parser bounds and
 * cross-checks every entry.
 */

const ARTIFACT_ID = "symbol_0123456789ABCDEFGHJKMNPQRS" as SymbolArtifactId;
const OTHER_ARTIFACT_ID = "symbol_0123456789ABCDEFGHJKMNPQRT" as SymbolArtifactId;

function symbol(overrides: Partial<ExportManifestSymbol> = {}): ExportManifestSymbol {
  return {
    artifactId: ARTIFACT_ID,
    debugFile: "electron.pdb",
    debugId: "3A9C1F2E4B5D6789012345678ABCDEF1",
    kind: "pdb",
    byteSize: 214_748_364n,
    sha256: "ab".repeat(32),
    entry: symbolEntryName(ARTIFACT_ID),
    product: "Electron",
    version: "41.10.6",
    arch: "x64",
    ...overrides,
  };
}

/** The wire shape of one symbol entry (byteSize is a canonical decimal string). */
function wireSymbol(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifactId: ARTIFACT_ID,
    debugFile: "electron.pdb",
    debugId: "3A9C1F2E4B5D6789012345678ABCDEF1",
    kind: "pdb",
    byteSize: "214748364",
    sha256: "ab".repeat(32),
    entry: symbolEntryName(ARTIFACT_ID),
    product: "Electron",
    version: "41.10.6",
    arch: "x64",
    ...overrides,
  };
}

function baseManifest(overrides: Partial<ExportManifest> = {}): ExportManifest {
  return {
    schema: EXPORT_MANIFEST_SCHEMA,
    createdAt: "2026-09-18T00:00:00.000Z",
    generator: { version: "0.1.0", schemaMigrations: 4 },
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

function expectInvalid(bytes: Uint8Array, message: RegExp): void {
  assert.throws(
    () => parseExportManifest(bytes),
    (error: unknown) => {
      assert.ok(error instanceof DumpLedgerError, String(error));
      assert.equal(error.code, "invalid_input");
      assert.match((error as Error).message, message);
      return true;
    },
  );
}

describe("export manifest symbol payload", () => {
  it("round-trips a manifest without the field byte-identically to the pre-flag serialization", () => {
    const manifest = baseManifest();
    const bytes = serializeExportManifest(manifest);
    const text = new TextDecoder().decode(bytes);
    assert.ok(!text.includes("\"symbols\""), "a flag-off manifest must not carry the symbols field");
    const parsed = parseExportManifest(bytes);
    assert.deepEqual(parsed, manifest);
    assert.equal(parsed.symbols, undefined);
    assert.equal(parsed.counts.symbols, undefined);
    // A pre-field manifest (auditEvents only) still parses: the field is optional.
    const legacy = json({ ...manifest, counts: { ...manifest.counts } });
    assert.deepEqual(parseExportManifest(legacy), manifest);
  });

  it("round-trips a manifest with symbols, canonical decimal sizes, and optional annotations", () => {
    const entry = symbol();
    const manifest = baseManifest({
      counts: { ...baseManifest().counts, symbols: 1 },
      symbols: [entry],
    });
    const bytes = serializeExportManifest(manifest);
    const text = new TextDecoder().decode(bytes);
    assert.ok(text.includes(`"byteSize":"214748364"`), "byteSize is a canonical decimal string");
    assert.ok(text.includes(`"entry":"${symbolEntryName(ARTIFACT_ID)}"`));
    const parsed = parseExportManifest(bytes);
    assert.deepEqual(parsed, manifest);
    assert.equal(parsed.counts.symbols, 1);
    assert.equal(parsed.symbols?.[0]?.byteSize, 214_748_364n);
  });

  it("parses an explicit empty symbols list (flag requested, nothing matched)", () => {
    const manifest = baseManifest({ counts: { ...baseManifest().counts, symbols: 0 }, symbols: [] });
    const parsed = parseExportManifest(serializeExportManifest(manifest));
    assert.deepEqual(parsed.symbols, []);
    assert.equal(parsed.counts.symbols, 0);
  });

  it("rejects one missing-field, bounds, or cross-check violation per case", () => {
    const wireBase = JSON.parse(new TextDecoder().decode(serializeExportManifest(baseManifest()))) as Record<string, unknown>;
    const good = { ...wireBase, counts: { customers: 0, cases: 0, grants: 0, dumps: 0, auditEvents: 0, symbols: 1 }, symbols: [wireSymbol()] };
    const { symbols: _symbols, ...withoutSymbols } = good;
    // The count and the list are a pair: one without the other is not a v1 manifest.
    expectInvalid(json({ ...withoutSymbols, counts: good.counts }), /\$\.symbols: is required when counts\.symbols is present/);
    expectInvalid(json({ ...good, counts: { ...baseManifest().counts, symbols: undefined } }), /\$\.counts\.symbols: is required/);
    expectInvalid(json({ ...good, counts: { ...good.counts, symbols: 2 } }), /\$\.counts\.symbols/);
    expectInvalid(json({ ...good, symbols: {} }), /\$\.symbols: must be an array/);
    expectInvalid(json({ ...good, symbols: [wireSymbol({ entry: "symbols/other.bin" })] }), /\$\.symbols\[0\]\.entry/);
    expectInvalid(json({ ...good, symbols: [wireSymbol({ sha256: "AB".repeat(32) })] }), /\$\.symbols\[0\]\.sha256/);
    expectInvalid(json({ ...good, symbols: [wireSymbol({ byteSize: "007" })] }), /\$\.symbols\[0\]\.byteSize/);
    expectInvalid(json({ ...good, symbols: [wireSymbol({ byteSize: "0" })] }), /\$\.symbols\[0\]\.byteSize/);
    expectInvalid(json({ ...good, symbols: [wireSymbol({ kind: "exe" })] }), /\$\.symbols\[0\]\.kind/);
    expectInvalid(json({ ...good, symbols: [wireSymbol({ artifactId: "not_an_id" })] }), /\$\.symbols\[0\]\.artifactId/);
    expectInvalid(json({ ...good, symbols: [wireSymbol({ debugFile: "" })] }), /\$\.symbols\[0\]\.debugFile/);
    expectInvalid(json({ ...good, symbols: [wireSymbol({ debugFile: "x".repeat(256) })] }), /\$\.symbols\[0\]\.debugFile/);
    expectInvalid(
      json({ ...good, counts: { ...good.counts, symbols: 2 }, symbols: [wireSymbol(), wireSymbol({ artifactId: OTHER_ARTIFACT_ID, entry: symbolEntryName(OTHER_ARTIFACT_ID) })] }),
      /duplicate symbol identity/,
    );
    expectInvalid(
      json({ ...good, counts: { ...good.counts, symbols: 2 }, symbols: [wireSymbol(), wireSymbol({ debugFile: "other.pdb", debugId: "DEADBEEF" })] }),
      /duplicate symbol artifact/,
    );
    expectInvalid(json({ ...good, symbols: [{ ...wireSymbol(), extra: true }] }), /\$\.symbols\[0\]: unknown field "extra"/);
    expectInvalid(json({ ...good, symbols: [wireSymbol({ product: "x".repeat(201) })] }), /\$\.symbols\[0\]\.product/);
    expectInvalid(json({ ...good, symbols: [wireSymbol({ arch: 42 })] }), /\$\.symbols\[0\]\.arch/);
  });
});
