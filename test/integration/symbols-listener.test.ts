import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import { buildSymbolsListener } from "../../src/http/symbols-listener.js";

/**
 * Integration coverage for the dedicated symbols listener
 * (docs/security-model.md, "Dedicated symbols listener"): the same symsrv
 * store as the main surface, but standalone, unauthenticated, and plain-HTTP.
 * Unlike the route-level tests (http-symbol-routes.test.ts, which inject at
 * the Fastify layer), these run over a real loopback socket because the
 * listener boundary itself is the subject: only the store path must exist,
 * and everything else — admin paths included — must be a uniform miss.
 */

const DEBUG_FILE = "electron.pdb";
const DEBUG_ID = "3A9C1F2E4B5D6789012345678ABCDEF1";
const BYTES = Buffer.from("fake-pdb-bytes-for-the-listener-test");
const IMMUTABLE = "public, max-age=31536000, immutable";

async function withListener(
  run: (baseUrl: string, seen: string[]) => Promise<void>,
): Promise<void> {
  const seen: string[] = [];
  const server = buildSymbolsListener({
    openArtifact: (name, id) => {
      seen.push(`${name}/${id}`);
      if (name !== DEBUG_FILE || id !== DEBUG_ID) return undefined;
      return { byteSize: BigInt(BYTES.byteLength), stream: Readable.from(BYTES) };
    },
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`, seen);
  } finally {
    await server.close();
  }
}

test("symbols listener serves an artifact over plain HTTP with immutable caching", async () => {
  await withListener(async (baseUrl, seen) => {
    const response = await fetch(`${baseUrl}/symbols/${DEBUG_FILE}/${DEBUG_ID}/${DEBUG_FILE}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), IMMUTABLE);
    assert.equal(Number(response.headers.get("content-length")), BYTES.byteLength);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), BYTES);
    assert.deepEqual(seen, [`${DEBUG_FILE}/${DEBUG_ID}`]);
  });
});

test("symbols listener answers grammar-valid misses and rejects bad grammar", async () => {
  await withListener(async (baseUrl, seen) => {
    const unknown = await fetch(`${baseUrl}/symbols/${DEBUG_FILE}/DEADBEEF00/${DEBUG_FILE}`);
    assert.equal(unknown.status, 404);
    const mismatchedTail = await fetch(`${baseUrl}/symbols/${DEBUG_FILE}/${DEBUG_ID}/other.pdb`);
    assert.equal(mismatchedTail.status, 404);
    const badGrammar = await fetch(`${baseUrl}/symbols/${DEBUG_FILE}/nothex/${DEBUG_FILE}`);
    assert.equal(badGrammar.status, 400);
    // The store was consulted only for the grammar-valid, well-formed miss;
    // the mismatched tail and the bad grammar are rejected before any lookup.
    assert.deepEqual(seen, [`${DEBUG_FILE}/DEADBEEF00`]);
  });
});

test("symbols listener has no other surface: admin, API, and root are uniform misses", async () => {
  await withListener(async (baseUrl, seen) => {
    for (const target of [
      { method: "GET", path: "/" },
      { method: "GET", path: "/symbols" },
      { method: "GET", path: "/api/v1/symbols" },
      { method: "POST", path: "/api/v1/symbols" },
      { method: "DELETE", path: "/api/v1/symbols/symbol_abc" },
      { method: "GET", path: "/health" },
    ] as const) {
      const response = await fetch(`${baseUrl}${target.path}`, { method: target.method });
      assert.equal(response.status, 404, `${target.method} ${target.path}`);
      const body = await response.json() as { readonly error?: { readonly code?: string } };
      assert.equal(body.error?.code, "not_found", `${target.method} ${target.path}`);
    }
    assert.deepEqual(seen, []);
  });
});
