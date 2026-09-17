import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import { decodeErrorResponse } from "@dump-ledger/http-contracts";
import Fastify, { type FastifyInstance } from "fastify";

import { registerSymbolRoutes, type SymbolArtifactStorePort } from "../../src/http/routes/symbol-routes.js";

/**
 * Integration coverage for the symsrv read route `GET /symbols/:name/:id/:file`
 * (design section "Read serving (symsrv route)", decision D1). A bare Fastify
 * instance registers only this route over an in-memory fake of the store port:
 * no auth surface, no engine, no server wiring — the route's own contract is
 * the subject under test (the parent wires it into the real server).
 *
 * Note on traversal spellings: literal `..` and `%2E%2E` segments never reach
 * any route through an HTTP URL parser — the WHATWG `URL` parser collapses
 * them before routing (verified against light-my-request, whose `inject` is
 * the transport here). The grammar still rejects them defensively for raw
 * request paths; the encoded-separator spellings below (`..%2F..%2F…`,
 * `..%5C…`) are the forms that actually arrive at the route, and they must be
 * rejected before the store is touched.
 */

const ARTIFACT_SIZE = 1024 * 1024; // 1 MiB
const DEBUG_FILE = "electron.pdb";
const DEBUG_ID = "3A9C1F2E4B5D6789012345678ABCDEF1";
const UNKNOWN_DEBUG_ID = "3A9C1F2E4B5D6789012345678ABCDEF2";
const STATIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** 1 MiB of deterministic patterned bytes; each 64 KiB chunk differs. */
function patternedBytes(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) {
    const chunk = Math.floor(index / 65_536);
    bytes[index] = (index * 131 + chunk * 29 + 17) & 0xff;
  }
  return bytes;
}

/** Streams in 64 KiB reads, mirroring the vault reader chunking. */
function byteStream(bytes: Buffer, chunkSize = 64 * 1024): Readable {
  return Readable.from((function* () {
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    }
  })());
}

class FakeSymbolStore implements SymbolArtifactStorePort {
  readonly calls: Array<readonly [string, string, string]> = [];
  private readonly artifacts = new Map<string, Buffer>();

  register(debugFile: string, debugId: string, file: string, bytes: Buffer): void {
    this.artifacts.set(`${debugFile}\u0000${debugId}\u0000${file}`, bytes);
  }

  openArtifact(debugFile: string, debugId: string, file: string) {
    this.calls.push([debugFile, debugId, file]);
    const bytes = this.artifacts.get(`${debugFile}\u0000${debugId}\u0000${file}`);
    if (bytes === undefined) return undefined;
    return { byteSize: BigInt(bytes.byteLength), stream: byteStream(bytes) };
  }
}

/**
 * Bare Fastify instance (no `buildHttpServer`): the route's own contract is
 * the subject under test. `maxParamLength` is raised from Fastify's default
 * of 100 because the store-path grammar permits 255-char segments — with the
 * default, the router answers 414 `FST_ERR_MAX_PARAM_LENGTH` before the route
 * ever sees an over-long segment (the real server wiring must raise it too).
 */
function makeServer(store: SymbolArtifactStorePort): FastifyInstance {
  const server = Fastify({ routerOptions: { maxParamLength: 1024 } });
  registerSymbolRoutes(server, store);
  return server;
}

interface Fixture {
  readonly server: FastifyInstance;
  readonly store: FakeSymbolStore;
  readonly bytes: Buffer;
}

function makeFixture(): Fixture {
  const bytes = patternedBytes(ARTIFACT_SIZE);
  const store = new FakeSymbolStore();
  store.register(DEBUG_FILE, DEBUG_ID, DEBUG_FILE, bytes);
  return { server: makeServer(store), store, bytes };
}

function symbolsUrl(name: string, id: string, file: string): string {
  return `/symbols/${name}/${id}/${file}`;
}

function assertErrorEnvelope(code: string, body: unknown, headers: Record<string, unknown>): void {
  assert.equal(decodeErrorResponse(body, "$").error.code, code);
  assert.equal(headers["cache-control"], "no-store");
}

test("serves the known artifact byte-identically with immutable cache headers", async (t) => {
  const { server, store, bytes } = makeFixture();
  t.after(async () => { await server.close(); });

  const response = await server.inject({ method: "GET", url: symbolsUrl(DEBUG_FILE, DEBUG_ID, DEBUG_FILE) });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/octet-stream");
  assert.equal(response.headers["content-length"], String(ARTIFACT_SIZE));
  assert.equal(response.headers["cache-control"], STATIC_CACHE_CONTROL);
  assert.equal(response.rawPayload.byteLength, ARTIFACT_SIZE);
  assert.ok(response.rawPayload.equals(bytes), "streamed body must be byte-identical to the stored artifact");
  assert.deepEqual(store.calls, [[DEBUG_FILE, DEBUG_ID, DEBUG_FILE]]);
});

test("unknown artifact, mismatched file, and case-different file are 404 not_found", async (t) => {
  const { server, store } = makeFixture();
  t.after(async () => { await server.close(); });

  // Well-formed id that the store does not know: a clean miss (symsrv falls through).
  const unknownId = await server.inject({ method: "GET", url: symbolsUrl(DEBUG_FILE, UNKNOWN_DEBUG_ID, DEBUG_FILE) });
  assert.equal(unknownId.statusCode, 404);
  assertErrorEnvelope("not_found", unknownId.json(), unknownId.headers as Record<string, unknown>);
  assert.deepEqual(store.calls, [[DEBUG_FILE, UNKNOWN_DEBUG_ID, DEBUG_FILE]]);

  const callsBeforeMismatches = store.calls.length;
  // SymSrv schema: the file segment repeats the name byte-for-byte, so any
  // other spelling misses before the store is consulted (casing stays literal).
  const mismatchedFile = await server.inject({ method: "GET", url: symbolsUrl(DEBUG_FILE, DEBUG_ID, "electron.exe") });
  assert.equal(mismatchedFile.statusCode, 404);
  assertErrorEnvelope("not_found", mismatchedFile.json(), mismatchedFile.headers as Record<string, unknown>);

  const caseDifferentFile = await server.inject({ method: "GET", url: symbolsUrl(DEBUG_FILE, DEBUG_ID, "ELECTRON.PDB") });
  assert.equal(caseDifferentFile.statusCode, 404);
  assertErrorEnvelope("not_found", caseDifferentFile.json(), caseDifferentFile.headers as Record<string, unknown>);

  assert.equal(store.calls.length, callsBeforeMismatches, "a file/name mismatch must not reach the store");

  // Same-name different debug file (name === file, but not an artifact): the
  // only other request that legitimately reaches the store, and it misses.
  const otherFile = await server.inject({ method: "GET", url: symbolsUrl("other.pdb", DEBUG_ID, "other.pdb") });
  assert.equal(otherFile.statusCode, 404);
  assertErrorEnvelope("not_found", otherFile.json(), otherFile.headers as Record<string, unknown>);
  assert.deepEqual(store.calls.slice(callsBeforeMismatches), [["other.pdb", DEBUG_ID, "other.pdb"]]);
});

test("malformed segments are 400 invalid_request and never reach the store", async (t) => {
  const { server, store } = makeFixture();
  t.after(async () => { await server.close(); });

  const malformed: ReadonlyArray<readonly [string, string]> = [
    ["lowercase hex id", symbolsUrl(DEBUG_FILE, DEBUG_ID.toLowerCase(), DEBUG_FILE)],
    ["one-character id", symbolsUrl(DEBUG_FILE, "A", DEBUG_FILE)],
    ["oversized id", symbolsUrl(DEBUG_FILE, "A".repeat(65), DEBUG_FILE)],
    ["non-hex id", symbolsUrl(DEBUG_FILE, "Z".repeat(32), DEBUG_FILE)],
    ["name with a leading dot", symbolsUrl(".electron.pdb", DEBUG_ID, ".electron.pdb")],
    ["name with a trailing dot", symbolsUrl("electron.pdb.", DEBUG_ID, "electron.pdb.")],
    ["name with an embedded '..'", symbolsUrl("electron..pdb", DEBUG_ID, "electron..pdb")],
    ["name with an encoded NUL", symbolsUrl("nul%00electron.pdb", DEBUG_ID, "nul%00electron.pdb")],
    ["oversized name", symbolsUrl("e".repeat(256), DEBUG_ID, "e".repeat(256))],
    ["name with an encoded slash", symbolsUrl("electron%2F.pdb", DEBUG_ID, "electron%2F.pdb")],
    ["name with an encoded backslash", symbolsUrl("electron%5C.pdb", DEBUG_ID, "electron%5C.pdb")],
    ["traversal in both segments", symbolsUrl("..%2F..%2Fledger.sqlite", DEBUG_ID, "..%2F..%2Fledger.sqlite")],
    ["traversal in the file segment", symbolsUrl(DEBUG_FILE, DEBUG_ID, "..%5C..%5Celectron.pdb")],
  ];

  for (const [label, url] of malformed) {
    const response = await server.inject({ method: "GET", url });
    assert.equal(response.statusCode, 400, `${label} must be rejected: ${url}`);
    assertErrorEnvelope("invalid_request", response.json(), response.headers as Record<string, unknown>);
  }
  assert.equal(store.calls.length, 0, "malformed paths must not reach the store");

  // Boundary: 255 chars is the last grammar-valid segment length, so it is a
  // store miss (404), while 256 chars is rejected by the route's own grammar
  // (the "oversized name" case above).
  const boundaryName = "e".repeat(255);
  const boundary = await server.inject({ method: "GET", url: symbolsUrl(boundaryName, DEBUG_ID, boundaryName) });
  assert.equal(boundary.statusCode, 404);
  assertErrorEnvelope("not_found", boundary.json(), boundary.headers as Record<string, unknown>);
});

test("bare /symbols paths are not handled by this route", async (t) => {
  const { server } = makeFixture();
  t.after(async () => { await server.close(); });

  // The SPA `/symbols` page and every other segment count stay with the
  // static-web fallback (registered by the caller): a bare Fastify instance
  // answers them with its default 404, never with the shared error envelope.
  for (const url of ["/symbols", "/symbols/electron.pdb", "/symbols/a/b/c/d"]) {
    const response = await server.inject({ method: "GET", url });
    assert.equal(response.statusCode, 404, url);
    const body = response.json() as { readonly error?: unknown };
    assert.equal(typeof body.error, "string", `${url} must fall through to Fastify's default 404`);
    assert.equal(response.headers["cache-control"], undefined, `${url} must not be answered by sendError`);
  }
});

test("a store failure surfaces as a 500 internal_error envelope", async (t) => {
  const store: SymbolArtifactStorePort = {
    openArtifact() { throw new Error("vault offline"); },
  };
  const server = makeServer(store);
  t.after(async () => { await server.close(); });

  const response = await server.inject({ method: "GET", url: symbolsUrl(DEBUG_FILE, DEBUG_ID, DEBUG_FILE) });
  assert.equal(response.statusCode, 500);
  assertErrorEnvelope("internal_error", response.json(), response.headers as Record<string, unknown>);
});
