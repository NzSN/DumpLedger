import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import { IntakeError, UploadSession, type UploadByteSink, type UploadLifecyclePort } from "../../src/intake/upload-session.js";

function fixture(overrides: Partial<UploadLifecyclePort> = {}) {
  const commands: unknown[] = [];
  const chunks: number[] = [];
  const lifecycle: UploadLifecyclePort = {
    begin(input) { commands.push({ action: "begin", ...input }); return { ok: true, dumpId: "dump-1", maxBytes: 8n }; },
    seal(input) { commands.push({ action: "seal", ...input }); return { ok: true }; },
    fail(input) { commands.push({ action: "fail", ...input }); return { ok: true }; },
    ...overrides,
  };
  const sink: UploadByteSink = { append(_dumpId, chunk) { chunks.push(chunk.byteLength); }, syncAndClose() {} };
  return { session: new UploadSession(lifecycle, sink), commands, chunks };
}

test("streaming upload seals the lifecycle with a stable digest and byte count", async () => {
  const { session, commands, chunks } = fixture();
  const receipt = await session.receive({ grantSecret: "secret", originalName: "customer.dmp", contentLength: 6n, bytes: Readable.from([Buffer.from("abc"), Buffer.from("def")]) });
  assert.deepEqual(receipt, { dumpId: "dump-1", byteSize: 6n, sha256: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721" });
  assert.deepEqual(chunks, [3, 3]);
  assert.deepEqual(commands, [
    { action: "begin", grantSecret: "secret", originalName: "customer.dmp" },
    { action: "seal", dumpId: "dump-1", byteSize: 6n, sha256: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721" },
  ]);
});

test("oversized streams fail the lifecycle and never seal", async () => {
  const { session, commands } = fixture();
  await assert.rejects(session.receive({ grantSecret: "secret", originalName: "large.dmp", bytes: Readable.from([Buffer.alloc(5), Buffer.alloc(4)]) }), error => error instanceof IntakeError && error.code === "upload_too_large");
  assert.deepEqual(commands.map(command => (command as { action: string }).action), ["begin", "fail"]);
});

test("source failures end in a non-downloadable failed state", async () => {
  const { session, commands } = fixture();
  const broken = Readable.from((async function* () { yield Buffer.from("abc"); throw new Error("connection reset"); })());
  await assert.rejects(session.receive({ grantSecret: "secret", originalName: "broken.dmp", bytes: broken }), error => error instanceof IntakeError && error.code === "upload_incomplete");
  assert.deepEqual(commands.map(command => (command as { action: string }).action), ["begin", "fail"]);
});

test("storage failures report storage unavailable and fail the lifecycle", async () => {
  const commands: unknown[] = [];
  const lifecycle: UploadLifecyclePort = {
    begin(input) { commands.push({ action: "begin", ...input }); return { ok: true, dumpId: "dump-1", maxBytes: 8n }; },
    seal(input) { commands.push({ action: "seal", ...input }); return { ok: true }; },
    fail(input) { commands.push({ action: "fail", ...input }); return { ok: true }; },
  };
  const session = new UploadSession(lifecycle, { append() { throw new Error("disk full"); }, syncAndClose() {} });
  await assert.rejects(session.receive({ grantSecret: "secret", originalName: "x.dmp", bytes: Readable.from([Buffer.from("abc")]) }), error => error instanceof IntakeError && error.code === "storage_unavailable");
  assert.deepEqual(commands.map(command => (command as { action: string }).action), ["begin", "fail"]);
});

test("a failed FailUpload transition is surfaced as an integrity failure", async () => {
  const lifecycle: UploadLifecyclePort = {
    begin: () => ({ ok: true, dumpId: "dump-1", maxBytes: 1n }),
    seal: () => ({ ok: true }),
    fail: () => ({ ok: false, code: "invalid_transition" }),
  };
  const session = new UploadSession(lifecycle, { append() {}, syncAndClose() {} });
  await assert.rejects(session.receive({ grantSecret: "secret", originalName: "x.dmp", bytes: Readable.from([Buffer.alloc(2)]) }), error => error instanceof IntakeError && error.code === "integrity_failure");
});

test("invalid grants fail before reading the request body", async () => {
  let read = false;
  const lifecycle: UploadLifecyclePort = { begin: () => ({ ok: false, code: "grant_invalid" }), seal: () => ({ ok: true }), fail: () => ({ ok: true }) };
  const session = new UploadSession(lifecycle, { append() {}, syncAndClose() {} });
  const body = Readable.from((async function* () { read = true; yield Buffer.from("secret bytes"); })());
  await assert.rejects(session.receive({ grantSecret: "invalid", originalName: "x.dmp", bytes: body }), error => error instanceof IntakeError && error.code === "grant_invalid");
  assert.equal(read, false);
});
