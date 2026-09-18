/**
 * Symbol-store integration flow (docs/symbols-design.md): operator ingest,
 * symsrv read serving, dedup, purge, and auth boundaries — all through the
 * real engine, vault, and HTTP stack with a synthetic MSF/RSDS fixture.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeErrorResponse,
  decodeSessionResponse,
  decodeSymbolIngestResponse,
  decodeSymbolListResponse,
  encodeSymbolFilenameBase64url,
  X_SYMBOL_FILENAME_HEADER,
  MAX_SYMBOL_BYTES,
} from "@dump-ledger/http-contracts";
import { OperatorSessions, hashOperatorPassword } from "../../src/auth/sessions.js";
import { createDumpLedgerEngine, DeterministicClock, DeterministicEntropy, DeterministicIds } from "../../src/engine/dump-ledger-engine.js";
import { EngineHttpApplication } from "../../src/http/application.js";
import { buildHttpServer } from "../../src/http/server.js";
import { createVaultMinidumpInspectionPort } from "../../src/inspection/index.js";
import { EngineUploadLifecycle, EngineUploadPostProcessor, VaultUploadSink } from "../../src/intake/intake-facade.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";

/* ------------------------------------------------------------------------ */
/* Synthetic minimal MSF 7.0 fixture with one stream-1 RSDS record           */
/* ------------------------------------------------------------------------ */

const MSF_MAGIC = "Microsoft C/C++ MSF 7.00\r\n\u001aDS";
const GUID_BYTES = Buffer.from([
  0x67, 0x45, 0x23, 0x01, 0xab, 0x89, 0xef, 0xcd,
  0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
]);
// Data1/Data2/Data3 little-endian per SymSrv -> "0123456789ABCDEF" + Data4 hex.
const EXPECTED_DEBUG_ID = "0123456789ABCDEF0123456789ABCDEF1";
const EXPECTED_DEBUG_FILE = "electron.pdb";

/* Synthetic minimal PE image: DOS stub, PE signature at e_lfanew, COFF header
 * with a TimeDateStamp, and an optional header carrying SizeOfImage. */
const PE_E_LFANEW = 0x80;
const PE_TIMESTAMP = 0x5f3759df;
const PE_SIZE_OF_IMAGE = 0x20000;
const EXPECTED_CODE_ID = "5F3759DF20000";
const EXPECTED_CODE_FILE = "electron.exe";

function syntheticExe(timestamp = PE_TIMESTAMP, sizeOfImage = PE_SIZE_OF_IMAGE): Buffer {
  const bytes = Buffer.alloc(PE_E_LFANEW + 4 + 20 + 0xf0 + 16);
  bytes.write("MZ", 0, "latin1");
  bytes.writeUInt32LE(PE_E_LFANEW, 0x3c);
  bytes.write("PE\0\0", PE_E_LFANEW, "latin1");
  const coff = PE_E_LFANEW + 4;
  bytes.writeUInt16LE(0x8664, coff); // machine: x64
  bytes.writeUInt32LE(timestamp >>> 0, coff + 4);
  bytes.writeUInt16LE(0xf0, coff + 16); // SizeOfOptionalHeader
  bytes.writeUInt32LE(sizeOfImage >>> 0, coff + 20 + 56); // SizeOfImage
  return bytes;
}

function syntheticPdb(pdbPath = `C:\\build\\${EXPECTED_DEBUG_FILE}`, age = 1): Buffer {
  const blockSize = 4096;
  const rsds = Buffer.alloc(4 + 16 + 4 + pdbPath.length + 1);
  rsds.write("RSDS", 0, "latin1");
  GUID_BYTES.copy(rsds, 4);
  rsds.writeUInt32LE(age, 20);
  rsds.write(pdbPath, 24, "latin1");

  const streams = [Buffer.alloc(0), rsds];
  const directory = Buffer.alloc(4 + streams.length * 4);
  directory.writeUInt32LE(streams.length, 0);
  streams.forEach((stream, index) => directory.writeUInt32LE(stream.length, 4 + index * 4));

  const streamStartBlocks: number[] = [];
  let nextBlock = 1;
  for (const stream of streams) {
    streamStartBlocks.push(nextBlock);
    nextBlock += Math.ceil(stream.length / blockSize);
  }
  const directoryStartBlock = nextBlock;
  const blockMapStartBlock = directoryStartBlock + 1;
  const numBlocks = blockMapStartBlock + 1;

  const bytes = Buffer.alloc(numBlocks * blockSize);
  bytes.write(MSF_MAGIC, 0, "latin1");
  bytes.writeUInt32LE(blockSize, 32);
  bytes.writeUInt32LE(1, 36);
  bytes.writeUInt32LE(numBlocks, 40);
  bytes.writeUInt32LE(directory.length, 44);
  bytes.writeUInt32LE(0, 48);
  bytes.writeUInt32LE(blockMapStartBlock, 52);
  streams.forEach((stream, index) => stream.copy(bytes, streamStartBlocks[index]! * blockSize));
  directory.copy(bytes, directoryStartBlock * blockSize);
  bytes.writeUInt32LE(directoryStartBlock, blockMapStartBlock * blockSize);
  bytes.writeUInt32LE(blockMapStartBlock, blockMapStartBlock * blockSize + 4);
  return bytes;
}

/* ------------------------------------------------------------------------ */
/* Fixture                                                                   */
/* ------------------------------------------------------------------------ */

async function makeFixture() {
  const vault = new MemoryVault();
  const engine = createDumpLedgerEngine({
    databasePath: ":memory:",
    vault,
    inspection: createVaultMinidumpInspectionPort(vault),
    grantSecretKey: Buffer.alloc(32, 0x6b),
    clock: new DeterministicClock("2026-09-16T08:00:00.000Z"),
    entropy: new DeterministicEntropy(["s".repeat(44)]),
    ids: new DeterministicIds(),
  });
  const sessions = new OperatorSessions({
    passwordHash: await hashOperatorPassword("local-password"),
    secureCookies: false,
  });
  const server = buildHttpServer({
    application: new EngineHttpApplication(engine, vault),
    sessions,
    uploadLifecycle: new EngineUploadLifecycle(engine),
    uploadSink: new VaultUploadSink(vault),
    uploadPostProcessor: new EngineUploadPostProcessor(engine),
    now: () => Date.parse("2026-09-16T08:00:00.000Z"),
  });
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/session",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ password: "local-password" }),
  });
  assert.equal(login.statusCode, 200);
  const cookie = (login.headers["set-cookie"] as string).split(";")[0]!;
  const csrf = decodeSessionResponse(login.json(), "$").csrfToken as string;
  // Origin absent is allowed (matches the other mutation-route fixtures).
  const mutationHeaders = { cookie, "x-csrf-token": csrf };
  return { server, engine, vault, cookie, csrf, mutationHeaders };
}

function errorCode(response: { json(): unknown }): string {
  return decodeErrorResponse(response.json(), "$").error.code;
}

/* ------------------------------------------------------------------------ */

test("symbol store: ingest, symsrv read, dedup, purge, and auth boundaries", async t => {
  const { server, engine, cookie, mutationHeaders } = await makeFixture();
  t.after(async () => { await server.close(); engine.close(); });

  // Unauthenticated list is rejected; authenticated list starts empty.
  const anon = await server.inject({ method: "GET", url: "/api/v1/symbols" });
  assert.equal(anon.statusCode, 401);
  const empty = await server.inject({ method: "GET", url: "/api/v1/symbols", headers: { cookie } });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(decodeSymbolListResponse(empty.json(), "$"), { symbols: [] });

  // Mutation surfaces require CSRF+Origin (no cookie-less ingest).
  const pdb = syntheticPdb();
  const noAuth = await server.inject({
    method: "POST", url: "/api/v1/symbols",
    headers: { "content-type": "application/octet-stream", [X_SYMBOL_FILENAME_HEADER]: encodeSymbolFilenameBase64url("electron.pdb") },
    payload: pdb,
  });
  assert.equal(noAuth.statusCode, 401);
  // With a session but no CSRF token the same request is forbidden.
  const noCsrf = await server.inject({
    method: "POST", url: "/api/v1/symbols",
    headers: { "content-type": "application/octet-stream", [X_SYMBOL_FILENAME_HEADER]: encodeSymbolFilenameBase64url("electron.pdb"), cookie },
    payload: pdb,
  });
  assert.equal(noCsrf.statusCode, 403);

  // Ingest: 201 with the server-parsed identity; the list shows the artifact.
  const ingested = await server.inject({
    method: "POST", url: "/api/v1/symbols",
    headers: { "content-type": "application/octet-stream", [X_SYMBOL_FILENAME_HEADER]: encodeSymbolFilenameBase64url("electron.pdb"), ...mutationHeaders },
    payload: pdb,
  });
  assert.equal(ingested.statusCode, 201);
  const receipt = decodeSymbolIngestResponse(ingested.json(), "$");
  assert.equal(receipt.debugFile, EXPECTED_DEBUG_FILE);
  assert.equal(receipt.debugId, EXPECTED_DEBUG_ID);
  assert.equal(receipt.kind, "pdb");
  assert.equal(receipt.byteSize, BigInt(pdb.byteLength));
  assert.equal(receipt.deduplicated, false);

  const listed = await server.inject({ method: "GET", url: "/api/v1/symbols", headers: { cookie } });
  const list = decodeSymbolListResponse(listed.json(), "$");
  assert.equal(list.symbols.length, 1);
  assert.equal(list.symbols[0]?.artifactId, receipt.artifactId);

  // The symsrv read route streams byte-identical content with immutable caching.
  const fetched = await server.inject({ method: "GET", url: `/symbols/${receipt.debugFile}/${receipt.debugId}/${receipt.debugFile}` });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.headers["content-type"], "application/octet-stream");
  assert.equal(fetched.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.deepEqual(fetched.rawPayload, pdb);

  // A miss is a clean 404 (downstream fallback semantics).
  const miss = await server.inject({ method: "GET", url: `/symbols/${receipt.debugFile}/00000000000000000000000000000000/${receipt.debugFile}` });
  assert.equal(miss.statusCode, 404);

  // Dedup: the same identity returns the original artifact, deduplicated.
  const again = await server.inject({
    method: "POST", url: "/api/v1/symbols",
    headers: { "content-type": "application/octet-stream", [X_SYMBOL_FILENAME_HEADER]: encodeSymbolFilenameBase64url("electron.pdb"), ...mutationHeaders },
    payload: pdb,
  });
  assert.equal(again.statusCode, 201);
  const dedup = decodeSymbolIngestResponse(again.json(), "$");
  assert.equal(dedup.deduplicated, true);
  assert.equal(dedup.artifactId, receipt.artifactId);
  const afterDedup = decodeSymbolListResponse((await server.inject({ method: "GET", url: "/api/v1/symbols", headers: { cookie } })).json(), "$");
  assert.equal(afterDedup.symbols.length, 1);

  // Identity/kind/ceiling rejections leave nothing staged.
  const notPdb = await server.inject({
    method: "POST", url: "/api/v1/symbols",
    headers: { "content-type": "application/octet-stream", [X_SYMBOL_FILENAME_HEADER]: encodeSymbolFilenameBase64url("electron.pdb"), ...mutationHeaders },
    payload: Buffer.from("definitely not a pdb"),
  });
  assert.equal(notPdb.statusCode, 422);
  assert.equal(errorCode(notPdb), "symbol_identity_unreadable");

  const wrongKind = await server.inject({
    method: "POST", url: "/api/v1/symbols",
    headers: { "content-type": "application/octet-stream", [X_SYMBOL_FILENAME_HEADER]: encodeSymbolFilenameBase64url("electron.sym"), ...mutationHeaders },
    payload: pdb,
  });
  assert.equal(wrongKind.statusCode, 409);
  assert.equal(errorCode(wrongKind), "symbol_kind_unsupported");

  // The suffix picks the kind, so PDB bytes under an .exe name are an
  // unreadable PE identity (same 422 as a corrupt PDB), not a kind error.
  const mismatchedKind = await server.inject({
    method: "POST", url: "/api/v1/symbols",
    headers: { "content-type": "application/octet-stream", [X_SYMBOL_FILENAME_HEADER]: encodeSymbolFilenameBase64url("electron.exe"), ...mutationHeaders },
    payload: pdb,
  });
  assert.equal(mismatchedKind.statusCode, 422);
  assert.equal(errorCode(mismatchedKind), "symbol_identity_unreadable");

  const tooLarge = await server.inject({
    method: "POST", url: "/api/v1/symbols",
    headers: {
      "content-type": "application/octet-stream",
      [X_SYMBOL_FILENAME_HEADER]: encodeSymbolFilenameBase64url("huge.pdb"),
      "content-length": (MAX_SYMBOL_BYTES + 1n).toString(),
      ...mutationHeaders,
    },
    payload: Buffer.alloc(0),
  });
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(errorCode(tooLarge), "symbol_too_large");

  // Purge: 204, then the symsrv route 404s and the list is empty again.
  const purged = await server.inject({ method: "DELETE", url: `/api/v1/symbols/${receipt.artifactId}`, headers: mutationHeaders });
  assert.equal(purged.statusCode, 204);
  const gone = await server.inject({ method: "GET", url: `/symbols/${receipt.debugFile}/${receipt.debugId}/${receipt.debugFile}` });
  assert.equal(gone.statusCode, 404);
  const emptyAgain = decodeSymbolListResponse((await server.inject({ method: "GET", url: "/api/v1/symbols", headers: { cookie } })).json(), "$");
  assert.deepEqual(emptyAgain, { symbols: [] });
});

test("EXE symbol store: ingest, code-identity symsrv read, dedup, DLL kind, and list", async t => {
  const { server, engine, cookie, mutationHeaders } = await makeFixture();
  t.after(async () => { await server.close(); engine.close(); });

  const exe = syntheticExe();
  const ingest = (filename: string, payload: Buffer) => server.inject({
    method: "POST", url: "/api/v1/symbols",
    headers: { "content-type": "application/octet-stream", [X_SYMBOL_FILENAME_HEADER]: encodeSymbolFilenameBase64url(filename), ...mutationHeaders },
    payload,
  });

  // Ingest: 201 with the server-parsed code identity and no debug identity.
  const ingested = await ingest(EXPECTED_CODE_FILE, exe);
  assert.equal(ingested.statusCode, 201);
  const receipt = decodeSymbolIngestResponse(ingested.json(), "$");
  assert.equal(receipt.kind, "exe");
  assert.equal(receipt.codeFile, EXPECTED_CODE_FILE);
  assert.equal(receipt.codeId, EXPECTED_CODE_ID);
  assert.equal(receipt.debugFile, null);
  assert.equal(receipt.debugId, null);
  assert.equal(receipt.byteSize, BigInt(exe.byteLength));
  assert.equal(receipt.deduplicated, false);

  // The symsrv read route serves the code identity path byte-identically with
  // immutable caching; a wrong code id stays a clean 404.
  const fetched = await server.inject({ method: "GET", url: `/symbols/${EXPECTED_CODE_FILE}/${EXPECTED_CODE_ID}/${EXPECTED_CODE_FILE}` });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.deepEqual(fetched.rawPayload, exe);
  const miss = await server.inject({ method: "GET", url: `/symbols/${EXPECTED_CODE_FILE}/0000000012345678/${EXPECTED_CODE_FILE}` });
  assert.equal(miss.statusCode, 404);

  // Re-ingesting the same identity is an idempotent no-op naming the original artifact.
  const again = await ingest(EXPECTED_CODE_FILE, exe);
  assert.equal(again.statusCode, 201);
  const dedup = decodeSymbolIngestResponse(again.json(), "$");
  assert.equal(dedup.deduplicated, true);
  assert.equal(dedup.artifactId, receipt.artifactId);

  // `.dll` is the same kind with its own identity (different timestamp).
  const dll = syntheticExe(0x12345678, 0x8000);
  const dllIngest = await ingest("electron.dll", dll);
  assert.equal(dllIngest.statusCode, 201);
  const dllReceipt = decodeSymbolIngestResponse(dllIngest.json(), "$");
  assert.equal(dllReceipt.kind, "exe");
  assert.equal(dllReceipt.codeFile, "electron.dll");
  assert.equal(dllReceipt.codeId, "123456788000");

  // A PDB artifact still ingests and resolves through its debug identity
  // while EXE artifacts share the store.
  const pdb = syntheticPdb();
  const pdbIngest = await ingest(EXPECTED_DEBUG_FILE, pdb);
  assert.equal(pdbIngest.statusCode, 201);
  const pdbReceipt = decodeSymbolIngestResponse(pdbIngest.json(), "$");
  assert.equal(pdbReceipt.kind, "pdb");
  assert.equal(pdbReceipt.debugFile, EXPECTED_DEBUG_FILE);
  assert.equal(pdbReceipt.codeFile, null);
  const pdbFetched = await server.inject({ method: "GET", url: `/symbols/${pdbReceipt.debugFile}/${pdbReceipt.debugId}/${pdbReceipt.debugFile}` });
  assert.equal(pdbFetched.statusCode, 200);
  assert.deepEqual(pdbFetched.rawPayload, pdb);

  // The operator list carries both kinds with the identity pair each resolves by.
  const listed = decodeSymbolListResponse((await server.inject({ method: "GET", url: "/api/v1/symbols", headers: { cookie } })).json(), "$");
  assert.equal(listed.symbols.length, 3);
  const listedExe = listed.symbols.find(symbol => symbol.artifactId === receipt.artifactId);
  assert.deepEqual(listedExe, {
    artifactId: receipt.artifactId,
    kind: "exe",
    debugFile: null,
    debugId: null,
    codeFile: EXPECTED_CODE_FILE,
    codeId: EXPECTED_CODE_ID,
    byteSize: BigInt(exe.byteLength),
    sha256: receipt.sha256,
    ingestedAt: "2026-09-16T08:00:00.000Z",
  });
  const listedPdb = listed.symbols.find(symbol => symbol.kind === "pdb");
  assert.equal(listedPdb?.debugFile, EXPECTED_DEBUG_FILE);
  assert.equal(listedPdb?.codeFile, null);

  // Purging the EXE removes only it: the code identity stops resolving while
  // the other artifacts keep serving.
  const purged = await server.inject({ method: "DELETE", url: `/api/v1/symbols/${receipt.artifactId}`, headers: mutationHeaders });
  assert.equal(purged.statusCode, 204);
  const gone = await server.inject({ method: "GET", url: `/symbols/${EXPECTED_CODE_FILE}/${EXPECTED_CODE_ID}/${EXPECTED_CODE_FILE}` });
  assert.equal(gone.statusCode, 404);
  const stillThere = await server.inject({ method: "GET", url: `/symbols/${pdbReceipt.debugFile}/${pdbReceipt.debugId}/${pdbReceipt.debugFile}` });
  assert.equal(stillThere.statusCode, 200);
});
