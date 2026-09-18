import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeCaseDetailResponse,
  decodeDumpDetailResponse,
  decodeJsonText,
  encodeCaseDetailResponse,
  encodeDumpDetailResponse,
  toJsonText,
} from "@dump-ledger/http-contracts";

import type { CaseId, DumpId } from "../../src/domain/ids.js";
import type { DumpLedgerEngine, InspectionOutcome, InspectionPort } from "../../src/engine/dump-ledger-engine.js";
import { EngineHttpApplication } from "../../src/http/application.js";
import type { MemoryVault } from "../../src/vault/memory-vault.js";
import { fixture } from "./support.js";

/**
 * Integration coverage for dump <-> symbol linkage (docs/symbols-design.md
 * milestone 2): dump-detail `symbolCoverage` and case-detail `missingSymbols`.
 *
 * The inspection port is scripted, so these tests pin the stored-facts shape
 * (`inspectionFacts.modules[]` with optional `debugFile`/`debugId`) without
 * depending on the minidump parser.
 */

const CASE_EXPIRY = "2026-09-05T00:00:00.000Z";

const ELECTRON = { debugFile: "electron.pdb", debugId: "3A9C1F2E4B5D6789012345678ABCDEF1" } as const;
const GPU = { debugFile: "gpu.pdb", debugId: "4B5D6789012345678ABCDEF13A9C1F2E" } as const;
const AUDIO = { debugFile: "audio.pdb", debugId: "5C6E7890123456789ABCDEF134A9C1F2E" } as const;

/** Facts keyed by dump, so each upload can carry a different module list. */
class ScriptedInspection implements InspectionPort {
  private readonly factsByDump = new Map<DumpId, Readonly<Record<string, unknown>>>();
  stage(dumpId: DumpId, facts: Readonly<Record<string, unknown>>): void { this.factsByDump.set(dumpId, facts); }
  inspect(dumpId: DumpId): InspectionOutcome {
    return { ok: true, coverage: "partial", facts: this.factsByDump.get(dumpId) ?? {} };
  }
}

function boot(inspection: InspectionPort) {
  const { engine, vault } = fixture(inspection);
  return { engine, vault, application: new EngineHttpApplication(engine, vault), inspection };
}

function createCase(engine: DumpLedgerEngine): CaseId {
  const customer = engine.execute({ type: "CreateCustomer", displayName: "Acme" });
  assert.ok(customer.ok && customer.customerId !== undefined);
  const supportCase = engine.execute({ type: "CreateCase", customerId: customer.customerId, title: "Crash" });
  assert.ok(supportCase.ok && supportCase.caseId !== undefined);
  return supportCase.caseId;
}

/** Ingests one artifact through the engine's symbol commands (no HTTP). */
function seedSymbol(engine: DumpLedgerEngine, vault: MemoryVault, identity: { debugFile: string; debugId: string }): string {
  const begun = engine.execute({ type: "IngestSymbol", kind: "pdb" });
  assert.ok(begun.ok && begun.artifactId !== undefined);
  vault.appendSymbol(begun.artifactId, Uint8Array.of(1, 2, 3, 4));
  vault.syncAndCloseSymbol(begun.artifactId);
  const sealed = engine.execute({
    type: "SealSymbol",
    artifactId: begun.artifactId,
    debugFile: identity.debugFile,
    debugId: identity.debugId,
    kind: "pdb",
    byteSize: 4n,
    sha256: "b".repeat(64),
  });
  assert.ok(sealed.ok && sealed.artifactId !== undefined);
  return sealed.artifactId;
}

/** Uploads one dump into an existing case and stops at `quarantined`. */
function uploadQuarantined(engine: DumpLedgerEngine, vault: MemoryVault, caseId: CaseId, originalName: string): DumpId {
  const grant = engine.execute({ type: "IssueGrant", caseId, expiresAt: CASE_EXPIRY, maxBytes: 64n });
  assert.ok(grant.ok && grant.grantSecret !== undefined);
  const begun = engine.execute({ type: "BeginUpload", grantSecret: grant.grantSecret, originalName });
  assert.ok(begun.ok && begun.dumpId !== undefined);
  vault.append(begun.dumpId, Uint8Array.of(1, 2, 3, 4));
  vault.syncAndClose(begun.dumpId);
  assert.ok(engine.execute({ type: "SealUpload", dumpId: begun.dumpId, byteSize: 4n, sha256: "a".repeat(64) }).ok);
  assert.ok(engine.execute({ type: "PromoteObject", dumpId: begun.dumpId }).ok);
  assert.ok(engine.execute({ type: "MarkQuarantined", dumpId: begun.dumpId }).ok);
  return begun.dumpId;
}

test("dump detail maps stored module facts onto symbol coverage", () => {
  const inspection = new ScriptedInspection();
  const { engine, vault, application } = boot(inspection);
  const caseId = createCase(engine);
  const artifactId = seedSymbol(engine, vault, ELECTRON);

  const dumpId = uploadQuarantined(engine, vault, caseId, "crash.dmp");
  const facts = {
    modules: [
      { name: "electron.exe", baseOfImage: "140000000", sizeOfImage: 1048576, timestamp: 1, ...ELECTRON },
      { name: "gpu.dll", baseOfImage: "7FFE0000", sizeOfImage: 4096, timestamp: 2, ...GPU },
      { name: "nodebug.dll", baseOfImage: "7FFF0000", sizeOfImage: 8192, timestamp: 3 },
      // Identity matching is exact/case-sensitive: upper-cased casing is missing.
      { name: "electron-upper.exe", baseOfImage: "140000000", sizeOfImage: 1048576, timestamp: 1, debugFile: "ELECTRON.PDB", debugId: ELECTRON.debugId },
      // Non-object entries are skipped; invalid fields read as absent.
      "not-an-object",
      { name: 7, debugFile: false, debugId: null },
      // OS-owned modules are flagged system so clients can collapse them.
      { name: "C:\\Windows\\System32\\ntdll.dll", baseOfImage: "7FFE0000", sizeOfImage: 4096, timestamp: 4, debugFile: "ntdll.pdb", debugId: "0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A1" },
      { name: "c:/windows/syswow64/kernel32.dll", baseOfImage: "7FFD0000", sizeOfImage: 4096, timestamp: 5 },
    ],
    memoryRangeCount: 1,
  };
  inspection.stage(dumpId, facts);
  assert.ok(engine.execute({ type: "AcceptDump", dumpId }).ok);

  // The projection carries the stored facts through the ledger round trip.
  const stored = engine.snapshot().dumps.find(dump => dump.dumpId === dumpId);
  assert.deepEqual(stored?.inspectionFacts, facts);

  const detail = application.dumpDetail(dumpId);
  assert.ok(detail !== undefined);
  const expected = [
    { name: "electron.exe", debugFile: ELECTRON.debugFile, debugId: ELECTRON.debugId, status: "present" as const, artifactId, system: false },
    { name: "gpu.dll", debugFile: GPU.debugFile, debugId: GPU.debugId, status: "missing" as const, artifactId: null, system: false },
    { name: "nodebug.dll", debugFile: null, debugId: null, status: "unidentified" as const, artifactId: null, system: false },
    { name: "electron-upper.exe", debugFile: "ELECTRON.PDB", debugId: ELECTRON.debugId, status: "missing" as const, artifactId: null, system: false },
    // The non-object entry is skipped; the object with invalid fields is unidentified.
    { name: null, debugFile: null, debugId: null, status: "unidentified" as const, artifactId: null, system: false },
    { name: "C:\\Windows\\System32\\ntdll.dll", debugFile: "ntdll.pdb", debugId: "0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A1", status: "missing" as const, artifactId: null, system: true },
    { name: "c:/windows/syswow64/kernel32.dll", debugFile: null, debugId: null, status: "unidentified" as const, artifactId: null, system: true },
  ];
  assert.deepEqual(detail.symbolCoverage, expected);
  assert.deepEqual(
    decodeJsonText(toJsonText(encodeDumpDetailResponse(detail)), decodeDumpDetailResponse).symbolCoverage,
    expected,
  );
  engine.close();
});

test("case detail aggregates missing identities across the case's available dumps", () => {
  const inspection = new ScriptedInspection();
  const { engine, vault, application } = boot(inspection);
  const caseId = createCase(engine);
  seedSymbol(engine, vault, ELECTRON);

  const dumpA = uploadQuarantined(engine, vault, caseId, "a.dmp");
  const dumpB = uploadQuarantined(engine, vault, caseId, "b.dmp");
  inspection.stage(dumpA, {
    modules: [
      { name: "electron.exe", ...ELECTRON },
      { name: "gpu.dll", ...GPU },
      { name: "nodebug.dll" },
    ],
  });
  inspection.stage(dumpB, {
    modules: [
      { name: "gpu.dll", ...GPU },
      { name: "gpu-copy.dll", ...GPU },
      { name: "audio.dll", ...AUDIO },
      // OS-module identities never need ingesting here; excluded from the
      // aggregation even though no store artifact matches them.
      { name: "C:\\Windows\\System32\\ntdll.dll", debugFile: "ntdll.pdb", debugId: "0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A1" },
      { name: "C:\\Windows\\WinSxS\\amd64_msvcrt\\msvcrt.dll", debugFile: "msvcrt.pdb", debugId: "1B1B1B1B1B1B1B1B1B1B1B1B1B1B1B1B1" },
    ],
  });
  assert.ok(engine.execute({ type: "AcceptDump", dumpId: dumpA }).ok);
  assert.ok(engine.execute({ type: "AcceptDump", dumpId: dumpB }).ok);

  // A dump in another case never leaks into this case's aggregation.
  const otherCaseId = createCase(engine);
  const otherDump = uploadQuarantined(engine, vault, otherCaseId, "other.dmp");
  inspection.stage(otherDump, { modules: [{ name: "gpu.dll", ...GPU }] });
  assert.ok(engine.execute({ type: "AcceptDump", dumpId: otherDump }).ok);

  const detail = application.caseDetail(caseId);
  assert.ok(detail !== undefined);
  assert.deepEqual(detail.missingSymbols, [
    { debugFile: AUDIO.debugFile, debugId: AUDIO.debugId, dumpIds: [dumpB] },
    { debugFile: GPU.debugFile, debugId: GPU.debugId, dumpIds: [dumpA, dumpB].sort() },
  ]);
  assert.deepEqual(
    decodeJsonText(toJsonText(encodeCaseDetailResponse(detail)), decodeCaseDetailResponse).missingSymbols,
    detail.missingSymbols,
  );
  engine.close();
});

test("dumps without a modules array or without facts expose no coverage", () => {
  const inspection = new ScriptedInspection();
  const { engine, vault, application } = boot(inspection);
  const caseId = createCase(engine);

  const withoutModules = uploadQuarantined(engine, vault, caseId, "partial.dmp");
  inspection.stage(withoutModules, { memoryRangeCount: 4, hasMemoryListStream: true });
  assert.ok(engine.execute({ type: "AcceptDump", dumpId: withoutModules }).ok);

  const neverInspected = uploadQuarantined(engine, vault, caseId, "pending.dmp");
  assert.equal(engine.snapshot().dumps.find(dump => dump.dumpId === neverInspected)?.inspectionFacts, null);

  assert.deepEqual(application.dumpDetail(withoutModules)?.symbolCoverage, []);
  assert.deepEqual(application.dumpDetail(neverInspected)?.symbolCoverage, []);
  assert.deepEqual(application.caseDetail(caseId)?.missingSymbols, []);
  engine.close();
});
