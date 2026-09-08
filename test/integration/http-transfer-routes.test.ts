import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CSRF_HEADER,
  X_DUMP_FILENAME_HEADER,
  X_UPLOAD_GRANT_HEADER,
  decodeCaseDetailResponse,
  decodeCaseSummary,
  decodeCreateCustomerResponse,
  decodeCreateExportResponse,
  decodeCreateGrantResponse,
  decodeCreateImportResponse,
  decodeDeleteExportResponse,
  decodeDumpDetailResponse,
  decodeErrorResponse,
  decodeImportProgressResponse,
  decodeListExportsResponse,
  decodeSessionResponse,
  decodeUploadCompleteResponse,
  encodeFilenameBase64url,
  parseUploadFragment,
  type ExportSummary,
} from "@dump-ledger/http-contracts";
import { OperatorSessions, hashOperatorPassword } from "../../src/auth/sessions.js";
import { RandomIds } from "../../src/engine/dependencies.js";
import { createDumpLedgerEngine, DeterministicClock, DeterministicEntropy, type DumpLedgerEngine } from "../../src/engine/dump-ledger-engine.js";
import { EngineHttpApplication } from "../../src/http/application.js";
import { buildHttpServer, type HttpServerOptions } from "../../src/http/server.js";
import { createVaultMinidumpInspectionPort } from "../../src/inspection/index.js";
import { EngineUploadLifecycle, EngineUploadPostProcessor, VaultUploadSink } from "../../src/intake/intake-facade.js";
import { TransferManager } from "../../src/transfer/manager.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";
import { syntheticMinidump } from "../fixtures/minidump/synthetic-minidump.js";

const FIXED_NOW = "2026-09-04T12:00:00.000Z";
const GRANT_KEY = Buffer.alloc(32, 0x5a);
const MISSING_EXPORT_ID = `export_${"0".repeat(32)}`;
const MISSING_IMPORT_ID = `import_${"0".repeat(32)}`;

interface Fixture {
  readonly server: ReturnType<typeof buildHttpServer>;
  readonly engine: DumpLedgerEngine;
  readonly transfer: TransferManager;
  readonly exportsDir: string;
  readonly cleanup: () => void;
}

function deterministicSecrets(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${"t".repeat(40)}${index.toString(36).padStart(4, "0")}`);
}

/**
 * A fresh instance per test: real engine (in-memory ledger, memory vault) and
 * a TransferManager over a real temp-dir exportsDir. RandomIds on both sides
 * of an import keep replayed audit ids from colliding with new ones, matching
 * the transfer-roundtrip harness.
 */
async function makeFixture(wrapEngine?: (engine: DumpLedgerEngine) => DumpLedgerEngine): Promise<Fixture> {
  const exportsDir = mkdtempSync(join(tmpdir(), "dump-ledger-http-transfer-"));
  const vault = new MemoryVault();
  const engine = createDumpLedgerEngine({
    databasePath: ":memory:",
    vault,
    inspection: createVaultMinidumpInspectionPort(vault),
    grantSecretKey: GRANT_KEY,
    clock: new DeterministicClock(FIXED_NOW),
    entropy: new DeterministicEntropy(deterministicSecrets(16)),
    ids: new RandomIds(),
  });
  const transfer = new TransferManager({
    engine: wrapEngine === undefined ? engine : wrapEngine(engine),
    vault,
    exportsDir,
  });
  const sessions = new OperatorSessions({ passwordHash: await hashOperatorPassword("local-password"), secureCookies: false });
  const serverOptions: HttpServerOptions = {
    application: new EngineHttpApplication(engine, vault),
    sessions,
    uploadLifecycle: new EngineUploadLifecycle(engine),
    uploadSink: new VaultUploadSink(vault),
    uploadPostProcessor: new EngineUploadPostProcessor(engine),
    now: () => Date.parse(FIXED_NOW),
    transfer,
    transferExportsDir: exportsDir,
  };
  const server = buildHttpServer(serverOptions);
  const cleanup = () => {
    void server.close();
    engine.close();
    rmSync(exportsDir, { recursive: true, force: true });
  };
  return { server, engine, transfer, exportsDir, cleanup };
}

async function loginJson(server: ReturnType<typeof buildHttpServer>): Promise<{ cookie: string; csrf: string }> {
  const response = await server.inject({
    method: "POST",
    url: "/api/v1/session",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ password: "local-password" }),
  });
  assert.equal(response.statusCode, 200);
  const session = decodeSessionResponse(response.json(), "$");
  assert.equal(session.authenticated, true);
  assert.ok(session.csrfToken !== undefined);
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
  assert.ok(cookie);
  return { cookie, csrf: session.csrfToken };
}

function mutationHeaders(auth: { cookie: string; csrf: string }): Record<string, string> {
  return { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf, "content-type": "application/json" };
}

function postJson(server: ReturnType<typeof buildHttpServer>, url: string, auth: { cookie: string; csrf: string }, body: unknown) {
  return server.inject({ method: "POST", url, headers: mutationHeaders(auth), payload: JSON.stringify(body) });
}

function errorCode(response: { json: () => unknown }): string {
  return decodeErrorResponse(response.json(), "$").error.code;
}

/** Polls the export list until the given export leaves "running" (or fails the test after the deadline). */
async function waitForExport(server: ReturnType<typeof buildHttpServer>, cookie: string, exportId: string): Promise<ExportSummary> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const response = await server.inject({ method: "GET", url: "/api/v1/operations/exports", headers: { cookie } });
    assert.equal(response.statusCode, 200);
    const found = decodeListExportsResponse(response.json(), "$").exports.find(entry => entry.exportId === exportId);
    if (found !== undefined && found.status !== "running") return found;
    assert.ok(Date.now() < deadline, `export ${exportId} did not settle: ${JSON.stringify(found ?? null)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test("transfer routes enforce session (401) and CSRF (403) guards", async t => {
  const { server, cleanup } = await makeFixture();
  t.after(cleanup);
  const auth = await loginJson(server);

  const endpoints = [
    { method: "POST", url: "/api/v1/operations/exports" },
    { method: "GET", url: "/api/v1/operations/exports" },
    { method: "GET", url: `/api/v1/operations/exports/${MISSING_EXPORT_ID}/file` },
    { method: "DELETE", url: `/api/v1/operations/exports/${MISSING_EXPORT_ID}` },
    { method: "POST", url: "/api/v1/operations/imports" },
    { method: "GET", url: `/api/v1/operations/imports/${MISSING_IMPORT_ID}` },
  ] as const;
  for (const { method, url } of endpoints) {
    const response = await server.inject({ method, url });
    assert.equal(response.statusCode, 401, `${method} ${url} without a session`);
    assert.equal(errorCode(response), "unauthenticated");
  }

  const mutations = [
    { method: "POST", url: "/api/v1/operations/exports" },
    { method: "DELETE", url: `/api/v1/operations/exports/${MISSING_EXPORT_ID}` },
    { method: "POST", url: "/api/v1/operations/imports" },
  ] as const;
  for (const { method, url } of mutations) {
    const missing = await server.inject({ method, url, headers: { cookie: auth.cookie } });
    assert.equal(missing.statusCode, 403, `${method} ${url} without a CSRF token`);
    assert.equal(errorCode(missing), "forbidden");
    const wrong = await server.inject({ method, url, headers: { cookie: auth.cookie, [CSRF_HEADER]: "wrong-token" } });
    assert.equal(wrong.statusCode, 403, `${method} ${url} with a wrong CSRF token`);
    assert.equal(errorCode(wrong), "forbidden");
  }
});

test("export lifecycle over HTTP: create, poll, stream, delete", async t => {
  const { server, exportsDir, cleanup } = await makeFixture();
  t.after(cleanup);
  const auth = await loginJson(server);

  const emptyList = await server.inject({ method: "GET", url: "/api/v1/operations/exports", headers: { cookie: auth.cookie } });
  assert.equal(emptyList.statusCode, 200);
  assert.deepEqual(decodeListExportsResponse(emptyList.json(), "$").exports, []);

  const created = await server.inject({ method: "POST", url: "/api/v1/operations/exports", headers: mutationHeaders(auth) });
  assert.equal(created.statusCode, 201);
  const { exportId } = decodeCreateExportResponse(created.json(), "$");
  assert.match(exportId, /^export_[0-9a-f]{32}$/);

  const sealed = await waitForExport(server, auth.cookie, exportId);
  assert.equal(sealed.status, "sealed", sealed.error ?? "export failed");
  assert.equal(sealed.error, null);
  assert.ok(sealed.byteSize !== null && BigInt(sealed.byteSize) > 0n);

  const download = await server.inject({ method: "GET", url: `/api/v1/operations/exports/${exportId}/file`, headers: { cookie: auth.cookie } });
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers["content-type"], "application/x-tar");
  assert.equal(download.headers["content-disposition"], `attachment; filename="dump-ledger-export-${exportId}.tar"`);
  assert.equal(download.headers["content-length"], sealed.byteSize);
  const body = download.rawPayload;
  assert.ok(body.byteLength > 0, "the bundle must not be empty");
  assert.equal(BigInt(body.byteLength).toString(), sealed.byteSize);
  // tar magic: "ustar" at offset 257 in the first header block
  assert.equal(body.subarray(257, 262).toString("latin1"), "ustar");
  // the streamed bytes are exactly the sealed bundle on disk
  assert.deepEqual(body, readFileSync(join(exportsDir, exportId, "bundle.tar")));

  const deleted = await server.inject({ method: "DELETE", url: `/api/v1/operations/exports/${exportId}`, headers: mutationHeaders(auth) });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(decodeDeleteExportResponse(deleted.json(), "$"), { deleted: true });

  const gone = await server.inject({ method: "GET", url: `/api/v1/operations/exports/${exportId}/file`, headers: { cookie: auth.cookie } });
  assert.equal(gone.statusCode, 404);
  assert.equal(errorCode(gone), "not_found");
  const listAfter = await server.inject({ method: "GET", url: "/api/v1/operations/exports", headers: { cookie: auth.cookie } });
  assert.deepEqual(decodeListExportsResponse(listAfter.json(), "$").exports, []);

  // unknown and malformed identifiers
  const missingFile = await server.inject({ method: "GET", url: `/api/v1/operations/exports/${MISSING_EXPORT_ID}/file`, headers: { cookie: auth.cookie } });
  assert.equal(missingFile.statusCode, 404);
  assert.equal(errorCode(missingFile), "not_found");
  const missingDelete = await server.inject({ method: "DELETE", url: `/api/v1/operations/exports/${MISSING_EXPORT_ID}`, headers: mutationHeaders(auth) });
  assert.equal(missingDelete.statusCode, 404);
  assert.equal(errorCode(missingDelete), "not_found");
  const malformedDelete = await server.inject({ method: "DELETE", url: "/api/v1/operations/exports/not-an-export-id", headers: mutationHeaders(auth) });
  assert.equal(malformedDelete.statusCode, 400);
  assert.equal(errorCode(malformedDelete), "invalid_request");
});

test("a second transfer job conflicts (409) while one is running", async t => {
  // The export pipeline awaits engine.backup; gating it parks the first
  // export deterministically with the single-job lock held.
  let gateOpen = false;
  let releaseBackup!: () => void;
  const backupGate = new Promise<void>(resolve => { releaseBackup = resolve; });
  const { server, cleanup } = await makeFixture(engine => ({
    execute: command => engine.execute(command),
    grantKeyFingerprint: () => engine.grantKeyFingerprint(),
    snapshot: () => engine.snapshot(),
    dueForPurge: at => engine.dueForPurge(at),
    pendingPurgeCompletion: () => engine.pendingPurgeCompletion(),
    backupInventory: () => engine.backupInventory(),
    integrityCheck: () => engine.integrityCheck(),
    backup: destination => (gateOpen ? engine.backup(destination) : backupGate.then(() => engine.backup(destination))),
    close: () => engine.close(),
  }));
  t.after(cleanup);
  const auth = await loginJson(server);

  const first = await server.inject({ method: "POST", url: "/api/v1/operations/exports", headers: mutationHeaders(auth) });
  assert.equal(first.statusCode, 201);
  const { exportId } = decodeCreateExportResponse(first.json(), "$");

  const second = await server.inject({ method: "POST", url: "/api/v1/operations/exports", headers: mutationHeaders(auth) });
  assert.equal(second.statusCode, 409);
  assert.equal(errorCode(second), "invalid_transition");

  // imports share the same single-job lock; the path itself is valid here so
  // only the busy state can reject the request
  const decoyDir = mkdtempSync(join(tmpdir(), "dump-ledger-decoy-"));
  t.after(() => rmSync(decoyDir, { recursive: true, force: true }));
  const decoyPath = join(decoyDir, "decoy.tar");
  writeFileSync(decoyPath, "decoy");
  const importWhileBusy = await postJson(server, "/api/v1/operations/imports", auth, { path: decoyPath });
  assert.equal(importWhileBusy.statusCode, 409);
  assert.equal(errorCode(importWhileBusy), "invalid_transition");

  // a running export cannot be downloaded or deleted
  const downloadRunning = await server.inject({ method: "GET", url: `/api/v1/operations/exports/${exportId}/file`, headers: { cookie: auth.cookie } });
  assert.equal(downloadRunning.statusCode, 409);
  assert.equal(errorCode(downloadRunning), "invalid_transition");
  const deleteRunning = await server.inject({ method: "DELETE", url: `/api/v1/operations/exports/${exportId}`, headers: mutationHeaders(auth) });
  assert.equal(deleteRunning.statusCode, 409);
  assert.equal(errorCode(deleteRunning), "invalid_transition");

  // releasing the gate lets the first export seal and frees the lock
  gateOpen = true;
  releaseBackup();
  const sealed = await waitForExport(server, auth.cookie, exportId);
  assert.equal(sealed.status, "sealed", sealed.error ?? "export failed");

  const third = await server.inject({ method: "POST", url: "/api/v1/operations/exports", headers: mutationHeaders(auth) });
  assert.equal(third.statusCode, 201);
  const thirdId = decodeCreateExportResponse(third.json(), "$").exportId;
  assert.notEqual(thirdId, exportId);
  assert.equal((await waitForExport(server, auth.cookie, thirdId)).status, "sealed");
});

test("import round trip over HTTP: A exports, B imports by path and serves the data", async t => {
  const a = await makeFixture();
  const b = await makeFixture();
  t.after(a.cleanup);
  t.after(b.cleanup);
  const authA = await loginJson(a.server);
  const authB = await loginJson(b.server);

  // populate A entirely over HTTP: customer -> case -> grant -> real upload
  const customerResponse = await postJson(a.server, "/api/v1/customers", authA, { displayName: "Acme" });
  assert.equal(customerResponse.statusCode, 201);
  const customer = decodeCreateCustomerResponse(customerResponse.json(), "$").customer;
  const caseResponse = await postJson(a.server, `/api/v1/customers/${customer.customerId}/cases`, authA, { title: "Renderer crashes" });
  assert.equal(caseResponse.statusCode, 201);
  const caseId = decodeCaseSummary(caseResponse.json(), "$").caseId;
  const transition = await postJson(a.server, `/api/v1/cases/${caseId}/transitions`, authA, { action: "StartInvestigation" });
  assert.equal(transition.statusCode, 200);
  const grantResponse = await postJson(a.server, `/api/v1/cases/${caseId}/grants`, authA, { validForHours: 24, maxBytes: "1073741824" });
  assert.equal(grantResponse.statusCode, 201);
  const grant = decodeCreateGrantResponse(grantResponse.json(), "$");
  const hashIndex = grant.uploadPath.indexOf("#");
  const grantSecret = parseUploadFragment(grant.uploadPath.slice(hashIndex));
  assert.ok(grantSecret !== null);
  const dumpBytes = syntheticMinidump({ memoryListSizes: [8] });
  const upload = await a.server.inject({
    method: "POST",
    url: "/api/v1/uploads",
    headers: {
      "content-type": "application/octet-stream",
      [X_UPLOAD_GRANT_HEADER]: grantSecret,
      [X_DUMP_FILENAME_HEADER]: encodeFilenameBase64url("renderer.dmp"),
    },
    payload: dumpBytes,
  });
  assert.equal(upload.statusCode, 201);
  const receipt = decodeUploadCompleteResponse(upload.json(), "$");
  assert.equal(receipt.phase, "available");
  const dumpId = receipt.dumpId;

  // export A and locate the sealed bundle on disk
  const created = await a.server.inject({ method: "POST", url: "/api/v1/operations/exports", headers: mutationHeaders(authA) });
  assert.equal(created.statusCode, 201);
  const { exportId } = decodeCreateExportResponse(created.json(), "$");
  const sealed = await waitForExport(a.server, authA.cookie, exportId);
  assert.equal(sealed.status, "sealed", sealed.error ?? "export failed");
  const bundlePath = join(a.exportsDir, exportId, "bundle.tar");

  // B imports the bundle by its server-local path (the import pipeline is
  // synchronous, so the job has settled by the time the response arrives)
  const started = await postJson(b.server, "/api/v1/operations/imports", authB, { path: bundlePath });
  assert.equal(started.statusCode, 201);
  const { importId } = decodeCreateImportResponse(started.json(), "$");
  assert.match(importId, /^import_[0-9a-f]{32}$/);

  const progressResponse = await b.server.inject({ method: "GET", url: `/api/v1/operations/imports/${importId}`, headers: { cookie: authB.cookie } });
  assert.equal(progressResponse.statusCode, 200);
  const progress = decodeImportProgressResponse(progressResponse.json(), "$");
  assert.equal(progress.status, "finished", progress.error ?? "import failed");
  assert.equal(progress.error, null);
  assert.deepEqual(
    { verified: progress.verified, imported: progress.imported, rejected: progress.rejected, skipped: progress.skipped },
    { verified: 1, imported: 1, rejected: 0, skipped: 0 },
  );

  // B now serves the imported case and dump detail JSON, and the raw bytes
  const caseDetail = await b.server.inject({ method: "GET", url: `/api/v1/cases/${caseId}`, headers: { cookie: authB.cookie } });
  assert.equal(caseDetail.statusCode, 200);
  const decodedCase = decodeCaseDetailResponse(caseDetail.json(), "$");
  assert.equal(decodedCase.title, "Renderer crashes");
  assert.equal(decodedCase.customer.displayName, "Acme");
  assert.equal(decodedCase.dumps.length, 1);
  assert.equal(decodedCase.dumps[0]?.dumpId, dumpId);

  const dumpDetail = await b.server.inject({ method: "GET", url: `/api/v1/dumps/${dumpId}`, headers: { cookie: authB.cookie } });
  assert.equal(dumpDetail.statusCode, 200);
  const decodedDump = decodeDumpDetailResponse(dumpDetail.json(), "$");
  assert.equal(decodedDump.dumpId, dumpId);
  assert.equal(decodedDump.case.caseId, caseId);
  assert.equal(decodedDump.phase, "available");
  assert.equal(decodedDump.originalName, "renderer.dmp");
  assert.equal(decodedDump.byteSize, BigInt(dumpBytes.byteLength));
  assert.equal(decodedDump.downloadable, true);

  const content = await b.server.inject({ method: "GET", url: `/api/v1/dumps/${dumpId}/content`, headers: { cookie: authB.cookie } });
  assert.equal(content.statusCode, 200);
  assert.deepEqual(content.rawPayload, dumpBytes);
});

test("import path policy surfaces typed errors; bundle failures land in progress", async t => {
  const { server, exportsDir, cleanup } = await makeFixture();
  t.after(cleanup);
  const auth = await loginJson(server);

  // nonexistent .tar path -> 404 not_found (pipeline code: not_found)
  const missing = await postJson(server, "/api/v1/operations/imports", auth, { path: join(exportsDir, "does-not-exist.tar") });
  assert.equal(missing.statusCode, 404);
  assert.equal(errorCode(missing), "not_found");

  // existing file without the .tar suffix -> 400 invalid_request
  const notTar = join(exportsDir, "bundle.bin");
  writeFileSync(notTar, "MDMP");
  const wrongSuffix = await postJson(server, "/api/v1/operations/imports", auth, { path: notTar });
  assert.equal(wrongSuffix.statusCode, 400);
  assert.equal(errorCode(wrongSuffix), "invalid_request");

  // a directory named *.tar is not a regular file -> 400
  const dirTar = join(exportsDir, "dir.tar");
  mkdirSync(dirTar);
  const directory = await postJson(server, "/api/v1/operations/imports", auth, { path: dirTar });
  assert.equal(directory.statusCode, 400);
  assert.equal(errorCode(directory), "invalid_request");

  // a symlink is refused even when its target exists -> 400
  const realTar = join(exportsDir, "real.tar");
  writeFileSync(realTar, "not really a tar");
  const linkTar = join(exportsDir, "link.tar");
  symlinkSync(realTar, linkTar);
  const symlink = await postJson(server, "/api/v1/operations/imports", auth, { path: linkTar });
  assert.equal(symlink.statusCode, 400);
  assert.equal(errorCode(symlink), "invalid_request");

  // malformed JSON body -> 400 invalid_request (contract decode)
  const malformed = await postJson(server, "/api/v1/operations/imports", auth, { path: 42 });
  assert.equal(malformed.statusCode, 400);
  assert.equal(errorCode(malformed), "invalid_request");

  // none of the rejected requests started an import job
  const unknownProgress = await server.inject({ method: "GET", url: `/api/v1/operations/imports/${MISSING_IMPORT_ID}`, headers: { cookie: auth.cookie } });
  assert.equal(unknownProgress.statusCode, 404);
  assert.equal(errorCode(unknownProgress), "not_found");

  // a structurally bad bundle that passes path policy IS a started job:
  // importBundle folds verification failures into the job outcome, so the
  // failure detail surfaces through the progress endpoint, not the POST
  const garbagePath = join(exportsDir, "garbage.tar");
  writeFileSync(garbagePath, "this is not a tar archive");
  const garbage = await postJson(server, "/api/v1/operations/imports", auth, { path: garbagePath });
  assert.equal(garbage.statusCode, 201);
  const { importId } = decodeCreateImportResponse(garbage.json(), "$");
  const progressResponse = await server.inject({ method: "GET", url: `/api/v1/operations/imports/${importId}`, headers: { cookie: auth.cookie } });
  assert.equal(progressResponse.statusCode, 200);
  const progress = decodeImportProgressResponse(progressResponse.json(), "$");
  assert.equal(progress.status, "failed");
  assert.ok(progress.error !== null && progress.error.length > 0);
});
