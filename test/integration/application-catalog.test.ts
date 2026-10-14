import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MAX_CATALOG_PAGE,
  decodeDumpCatalogResponse,
  decodeJsonText,
  encodeDumpCatalogResponse,
  toJsonText,
  type DumpCatalogResponse,
} from "@dump-ledger/http-contracts";

import { DumpLedgerError } from "../../src/domain/errors.js";
import type { CaseId, DumpId } from "../../src/domain/ids.js";
import type { DeterministicClock, DumpLedgerEngine, InspectionOutcome, InspectionPort } from "../../src/engine/dump-ledger-engine.js";
import { EngineHttpApplication } from "../../src/http/application.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";
import { fixture } from "./support.js";

/**
 * Integration coverage for the application half of the dump catalog
 * (docs/analyzer-integration-design.md, "Dump catalog search"): the
 * engine read-through, contract filter mapping, the opaque keyset cursor
 * codec, by-sha256 lookup, and invalid-input surfacing. Runs a real engine
 * over a temp-directory SQLite ledger and seeds every state through the
 * public lifecycle commands, exactly like the production composition root.
 */

const EXPIRY = "2026-09-05T00:00:00.000Z";

/** Scripted inspection outcomes keyed by dump, so stored facts match the
 * shapes the vault inspection port writes (`serializeFacts` strings 64-bit
 * integers) without depending on the minidump parser. */
class ScriptedInspection implements InspectionPort {
  private readonly outcomes = new Map<DumpId, InspectionOutcome>();
  stage(dumpId: DumpId, facts: Readonly<Record<string, unknown>>): void {
    this.outcomes.set(dumpId, { ok: true, coverage: "partial", facts });
  }
  reject(dumpId: DumpId, error: string): void {
    this.outcomes.set(dumpId, { ok: false, error });
  }
  inspect(dumpId: DumpId): InspectionOutcome {
    return this.outcomes.get(dumpId) ?? { ok: true, coverage: "partial", facts: {} };
  }
}

interface Harness {
  readonly root: string;
  readonly clock: DeterministicClock;
  readonly engine: DumpLedgerEngine;
  readonly vault: MemoryVault;
  readonly inspection: ScriptedInspection;
  readonly application: EngineHttpApplication;
}

function boot(): Harness {
  const root = mkdtempSync(join(tmpdir(), "dump-ledger-catalog-app-"));
  const inspection = new ScriptedInspection();
  const vault = new MemoryVault();
  const { clock, engine } = fixture(inspection, vault, join(root, "ledger.sqlite"));
  return { root, clock, engine, vault, inspection, application: new EngineHttpApplication(engine, vault) };
}

function shutdown(harness: Harness): void {
  harness.engine.close();
  rmSync(harness.root, { recursive: true, force: true });
}

function createCase(engine: DumpLedgerEngine): CaseId {
  const customer = engine.execute({ type: "CreateCustomer", displayName: "Acme" });
  assert.ok(customer.ok && customer.customerId !== undefined);
  const supportCase = engine.execute({ type: "CreateCase", customerId: customer.customerId, title: "Crash" });
  assert.ok(supportCase.ok && supportCase.caseId !== undefined);
  return supportCase.caseId;
}

function issueGrant(engine: DumpLedgerEngine, caseId: CaseId, maxUploads: number): string {
  const grant = engine.execute({ type: "IssueGrant", caseId, expiresAt: EXPIRY, maxBytes: 1_000_000n, maxUploads });
  assert.ok(grant.ok && grant.grantSecret !== undefined);
  return grant.grantSecret;
}

/** One full upload through quarantined, without inspection. */
function upload(
  engine: DumpLedgerEngine,
  vault: MemoryVault,
  grantSecret: string,
  originalName: string,
  byteSize: bigint,
  sha256: string,
): DumpId {
  const begun = engine.execute({ type: "BeginUpload", grantSecret, originalName });
  assert.ok(begun.ok && begun.dumpId !== undefined);
  const dumpId: DumpId = begun.dumpId;
  vault.append(dumpId, Uint8Array.of(1, 2, 3, 4));
  vault.syncAndClose(dumpId);
  assert.ok(engine.execute({ type: "SealUpload", dumpId, byteSize, sha256 }).ok);
  assert.ok(engine.execute({ type: "PromoteObject", dumpId }).ok);
  assert.ok(engine.execute({ type: "MarkQuarantined", dumpId }).ok);
  return dumpId;
}

/** One receiving-phase row: the cheapest production lifecycle state. */
function beginOnly(engine: DumpLedgerEngine, grantSecret: string, originalName: string): DumpId {
  const begun = engine.execute({ type: "BeginUpload", grantSecret, originalName });
  assert.ok(begun.ok && begun.dumpId !== undefined);
  return begun.dumpId;
}

function seedSymbol(engine: DumpLedgerEngine, vault: MemoryVault, debugFile: string, debugId: string): string {
  const begun = engine.execute({ type: "IngestSymbol", kind: "pdb" });
  assert.ok(begun.ok && begun.artifactId !== undefined);
  vault.appendSymbol(begun.artifactId, Uint8Array.of(1, 2, 3, 4));
  vault.syncAndCloseSymbol(begun.artifactId);
  const sealed = engine.execute({ type: "SealSymbol", artifactId: begun.artifactId, kind: "pdb", debugFile, debugId, byteSize: 4n, sha256: "b".repeat(64) });
  assert.ok(sealed.ok && sealed.artifactId !== undefined);
  return sealed.artifactId;
}

function expectInvalidInput(run: () => unknown, messagePattern: RegExp, label: string): void {
  assert.throws(
    run,
    (error: unknown) => error instanceof DumpLedgerError
      && error.code === "invalid_input"
      && messagePattern.test(error.message),
    label,
  );
}

const ELECTRON = { debugFile: "electron.pdb", debugId: "3A9C1F2E4B5D6789012345678ABCDEF1" } as const;

const FACTS_X86 = {
  architecture: "x86_64",
  exceptionCode: "3221225477",
  exceptionAddress: "140695802675200",
  modules: [
    { name: "electron.exe", ...ELECTRON },
    { name: "gpu.dll", debugFile: "gpu.pdb", debugId: "4B5D6789012345678ABCDEF13A9C1F2E" },
    { name: "nodebug.dll" },
  ],
};

const SHA_X86 = "a1".repeat(32);
const SHA_ARM = "b2".repeat(32);

test("catalog search passes filters through and shapes entries per contract", () => {
  const harness = boot();
  try {
    const { engine, vault, application, clock } = harness;
    const caseId = createCase(engine);
    const grant = issueGrant(engine, caseId, 8);
    const artifactId = seedSymbol(engine, vault, ELECTRON.debugFile, ELECTRON.debugId);
    assert.ok(artifactId.length > 0);

    clock.set("2026-09-04T00:00:01.000Z");
    const available = upload(engine, vault, grant, "renderer.dmp", 1234n, SHA_X86);
    harness.inspection.stage(available, FACTS_X86);
    assert.ok(engine.execute({ type: "AcceptDump", dumpId: available }).ok);
    assert.ok(engine.execute({ type: "SetRetention", dumpId: available, purgeAt: "2026-09-04T01:00:00.000Z" }).ok);

    clock.set("2026-09-04T00:00:02.000Z");
    const arm = upload(engine, vault, grant, "gpu.dmp", 2222n, SHA_ARM);
    harness.inspection.stage(arm, { architecture: "arm64" });
    assert.ok(engine.execute({ type: "AcceptDump", dumpId: arm }).ok);

    clock.set("2026-09-04T00:00:03.000Z");
    const rejected = upload(engine, vault, grant, "broken.dmp", 3333n, "c3".repeat(32));
    harness.inspection.reject(rejected, "not a minidump");
    assert.ok(engine.execute({ type: "RejectDump", dumpId: rejected }).ok);

    clock.set("2026-09-04T00:00:04.000Z");
    const receiving = beginOnly(engine, grant, "still-uploading.dmp");

    const all = application.searchDumps({});
    assert.deepEqual(all.dumps.map(entry => entry.dumpId), [available, arm, rejected, receiving]);
    assert.ok(!("nextCursor" in all), "a single page must not carry a cursor");

    // Filter pass-through: exact phase, inclusive received bounds, and the
    // stored inspector architecture (which requires a successful inspection).
    assert.deepEqual(application.searchDumps({ phase: "available" }).dumps.map(entry => entry.dumpId), [available, arm]);
    assert.deepEqual(application.searchDumps({ phase: "rejected" }).dumps.map(entry => entry.dumpId), [rejected]);
    assert.deepEqual(application.searchDumps({ receivedAfter: "2026-09-04T00:00:02.000Z" }).dumps.map(entry => entry.dumpId), [arm, rejected, receiving]);
    assert.deepEqual(application.searchDumps({ receivedBefore: "2026-09-04T00:00:02.000Z" }).dumps.map(entry => entry.dumpId), [available, arm]);
    assert.deepEqual(application.searchDumps({ architecture: "x86_64" }).dumps.map(entry => entry.dumpId), [available]);
    assert.deepEqual(application.searchDumps({ exceptionCode: 3221225477 }).dumps.map(entry => entry.dumpId), [available]);
    assert.deepEqual(application.searchDumps({ caseId }).dumps.map(entry => entry.dumpId), [available, arm, rejected, receiving]);
    assert.deepEqual(application.searchDumps({ caseId: "case_00000000000000000000000001" }), { dumps: [] });

    // Entry shaping: nullability, bigint conventions, inspector facts, and the
    // aggregated symbol coverage (one present module, one missing, one without
    // an identity).
    const [first, second, third, fourth] = all.dumps;
    assert.ok(first !== undefined && second !== undefined && third !== undefined && fourth !== undefined);
    assert.equal(first.phase, "available");
    assert.equal(first.validation, "valid");
    assert.equal(first.originalName, "renderer.dmp");
    assert.equal(first.byteSize, 1234n);
    assert.equal(first.sha256, SHA_X86);
    assert.equal(first.receivedAt, "2026-09-04T00:00:01.000Z");
    assert.equal(first.availableAt, "2026-09-04T00:00:01.000Z");
    assert.equal(first.purgeAt, "2026-09-04T01:00:00.000Z");
    assert.equal(first.architecture, "x86_64");
    assert.equal(first.exceptionCode, 3221225477);
    assert.equal(first.exceptionAddress, 140695802675200n);
    assert.deepEqual(first.symbolCoverage, { present: 1, missing: 1, unidentified: 1 });

    assert.equal(second.architecture, "arm64");
    assert.ok(!("exceptionCode" in second) && !("exceptionAddress" in second), "absent facts must be absent keys");
    assert.deepEqual(second.symbolCoverage, { present: 0, missing: 0, unidentified: 0 });

    assert.equal(third.phase, "rejected");
    assert.equal(third.validation, "invalid");
    assert.ok(!("architecture" in third) && !("exceptionCode" in third) && !("exceptionAddress" in third));

    assert.equal(fourth.phase, "receiving");
    assert.equal(fourth.byteSize, null);
    assert.equal(fourth.sha256, null);
    assert.equal(fourth.availableAt, null);
    assert.equal(fourth.purgeAt, null);
    assert.deepEqual(fourth.symbolCoverage, { present: 0, missing: 0, unidentified: 0 });

    // The response must satisfy its own contract decoder (decimal-string
    // bigints, canonical timestamps, strict optional fields) after a full
    // JSON text round trip.
    const decoded = decodeJsonText(toJsonText(encodeDumpCatalogResponse(all)), decodeDumpCatalogResponse);
    assert.deepEqual(decoded, all);

    // Read-only read-through: no command, audit event, or projection change.
    const before = engine.snapshot();
    application.searchDumps({ phase: "available" });
    application.searchDumps({ architecture: "x86_64" });
    application.dumpsBySha256(SHA_X86);
    assert.deepEqual(engine.snapshot(), before);
  } finally {
    shutdown(harness);
  }
});

test("keyset paging round-trips cursors across a forced two-page traversal", () => {
  const harness = boot();
  try {
    const { engine, application, clock } = harness;
    const caseId = createCase(engine);
    const firstGrant = issueGrant(engine, caseId, 128);
    const secondGrant = issueGrant(engine, caseId, 128);

    const firstWindow = "2026-09-04T00:00:01.000Z";
    const secondWindow = "2026-09-04T00:00:02.000Z";
    const seeded: DumpId[] = [];
    const total = MAX_CATALOG_PAGE + 4;
    for (let index = 0; index < total; index += 1) {
      clock.set(index < 100 ? firstWindow : secondWindow);
      seeded.push(beginOnly(engine, index < 128 ? firstGrant : secondGrant, `bulk-${index}.dmp`));
    }

    const first = application.searchDumps({});
    assert.equal(first.dumps.length, MAX_CATALOG_PAGE);
    assert.equal(first.dumps[0]?.dumpId, seeded[0]);
    assert.ok(first.nextCursor !== undefined, "a full page must carry the next cursor");
    const boundary = first.dumps[MAX_CATALOG_PAGE - 1];
    assert.ok(boundary !== undefined);
    // The opaque cursor is the base64url of the last row's [receivedAt, dumpId].
    assert.deepEqual(JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8")), [boundary.receivedAt, boundary.dumpId]);

    const second = application.searchDumps({ cursor: first.nextCursor });
    assert.equal(second.dumps.length, total - MAX_CATALOG_PAGE);
    assert.ok(!("nextCursor" in second), "the final page must not carry a cursor");
    const resume = second.dumps[0];
    assert.ok(resume !== undefined);
    assert.equal(resume.dumpId, seeded[MAX_CATALOG_PAGE]);
    // The page boundary falls inside one timestamp window, so resumption can
    // only be correct via the (receivedAt, dumpId) row-value comparison.
    assert.equal(boundary.receivedAt, secondWindow);
    assert.equal(resume.receivedAt, boundary.receivedAt);

    // Walk every page through the application and compare with the seed order.
    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const response: DumpCatalogResponse = application.searchDumps(cursor === undefined ? {} : { cursor });
      collected.push(...response.dumps.map(entry => entry.dumpId));
      cursor = response.nextCursor;
      if (cursor === undefined) break;
    }
    assert.equal(cursor, undefined, "the traversal must terminate");
    assert.deepEqual(collected, seeded.map(String));

    // A hand-built cursor in the documented format addresses the same keyset
    // position and resumes strictly after it.
    const crafted = Buffer.from(JSON.stringify([secondWindow, seeded[100]]), "utf8").toString("base64url");
    const craftedPage = application.searchDumps({ cursor: crafted });
    assert.equal(craftedPage.dumps[0]?.dumpId, seeded[101]);
  } finally {
    shutdown(harness);
  }
});

test("by-sha256 returns matching entries and an empty page on a miss", () => {
  const harness = boot();
  try {
    const { engine, vault, application, clock } = harness;
    const caseId = createCase(engine);
    const grant = issueGrant(engine, caseId, 8);
    const sharedSha = "1".repeat(64);
    const otherSha = "2".repeat(64);

    const accepted = (originalName: string, byteSize: bigint, sha256: string, at: string): DumpId => {
      clock.set(at);
      const dumpId = upload(engine, vault, grant, originalName, byteSize, sha256);
      harness.inspection.stage(dumpId, { architecture: "x86_64" });
      assert.ok(engine.execute({ type: "AcceptDump", dumpId }).ok);
      return dumpId;
    };
    const first = accepted("first.dmp", 10n, sharedSha, "2026-09-04T00:00:01.000Z");
    const duplicate = accepted("duplicate.dmp", 10n, sharedSha, "2026-09-04T00:00:02.000Z");
    const other = accepted("other.dmp", 11n, otherSha, "2026-09-04T00:00:03.000Z");

    const hit = application.dumpsBySha256(sharedSha);
    assert.deepEqual(hit.dumps.map(entry => entry.dumpId), [first, duplicate]);
    assert.deepEqual(hit.dumps.map(entry => entry.sha256), [sharedSha, sharedSha]);
    assert.deepEqual(hit.dumps.map(entry => entry.byteSize), [10n, 10n]);
    assert.ok(!("nextCursor" in hit));

    assert.deepEqual(application.dumpsBySha256(otherSha).dumps.map(entry => entry.dumpId), [other]);
    const miss = application.dumpsBySha256("0".repeat(64));
    assert.deepEqual(miss, { dumps: [] });
    assert.ok(!("nextCursor" in miss));

    for (const malformed of ["", "1".repeat(63), "1".repeat(65), "A".repeat(64), `${"1".repeat(63)}g`]) {
      expectInvalidInput(() => application.dumpsBySha256(malformed), /sha256 is invalid/, `sha256 ${JSON.stringify(malformed).slice(0, 24)}`);
    }
  } finally {
    shutdown(harness);
  }
});

test("malformed cursors and identifier filters are invalid input", () => {
  const harness = boot();
  try {
    const { engine, vault, application, clock } = harness;
    const caseId = createCase(engine);
    const grant = issueGrant(engine, caseId, 8);
    clock.set("2026-09-04T00:00:01.000Z");
    const dumpId = upload(engine, vault, grant, "seed.dmp", 10n, "3".repeat(64));
    harness.inspection.stage(dumpId, { architecture: "x86_64" });
    assert.ok(engine.execute({ type: "AcceptDump", dumpId }).ok);

    const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const malformed = [
      "",
      "not a cursor",
      "!!!",
      "12345",
      "A".repeat(257),
      b64(null),
      b64({ receivedAt: "2026-09-04T00:00:01.000Z", dumpId }),
      b64(["2026-09-04T00:00:01.000Z"]),
      b64(["2026-09-04T00:00:01.000Z", dumpId, "extra"]),
      b64(["2026-09-04T00:00:01.000Z", "not-a-dump"]),
      b64(["2026-09-04T00:00:01Z", dumpId]),
      b64(["2026-13-01T00:00:00.000Z", dumpId]),
      b64([1, dumpId]),
      `${b64(["2026-09-04T00:00:01.000Z", dumpId])}=`,
    ];
    for (const cursor of malformed) {
      expectInvalidInput(() => application.searchDumps({ cursor }), /cursor is invalid/, `cursor ${JSON.stringify(cursor).slice(0, 40)}`);
    }

    expectInvalidInput(() => application.searchDumps({ caseId: "case_x" }), /caseId is invalid/, "malformed caseId");
    expectInvalidInput(() => application.searchDumps({ customerId: "not-a-customer" }), /customerId is invalid/, "malformed customerId");
    expectInvalidInput(() => application.searchDumps({ caseId: dumpId }), /caseId is invalid/, "caseId with a dump prefix");

    // Unknown identifiers that are well formed are not malformed input: they
    // simply match nothing (or resume from the position the cursor names).
    assert.deepEqual(application.searchDumps({ customerId: "customer_00000000-0000-0000-0000-000000000001" }), { dumps: [] });
    const resume = application.searchDumps({ cursor: b64(["2026-09-04T00:00:00.000Z", dumpId]) });
    assert.deepEqual(resume.dumps.map(entry => entry.dumpId), [dumpId]);
  } finally {
    shutdown(harness);
  }
});
