import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseIngestTokenHash, verifyIngestToken } from "../../src/auth/ingest-token.js";
import { generateIngestToken, ingestTokenHash } from "../../tools/generate-ingest-token.js";

test("ingest token config: unset or empty disables token auth entirely", () => {
  assert.equal(parseIngestTokenHash(undefined), undefined);
  assert.equal(parseIngestTokenHash(""), undefined);
  assert.equal(verifyIngestToken(undefined, "any-token"), false);
});

test("ingest token config: malformed digests fail fast", () => {
  const malformed = [
    "abc",
    "a".repeat(63),
    "a".repeat(65),
    "a".repeat(63) + " ",
    "A".repeat(64),
    "G".repeat(64),
    "sha256:" + "a".repeat(64),
  ];
  for (const value of malformed) {
    assert.throws(() => parseIngestTokenHash(value), /DUMP_LEDGER_INGEST_TOKEN_HASH must be 64 lowercase hex characters/);
  }
});

test("ingest token verification matches sha256 digests exactly", () => {
  const token = generateIngestToken();
  const configured = parseIngestTokenHash(ingestTokenHash(token));
  assert.equal(configured?.byteLength, 32);
  assert.equal(verifyIngestToken(configured, token), true);
  assert.equal(verifyIngestToken(configured, token.slice(0, -1)), false);
  assert.equal(verifyIngestToken(configured, `${token}x`), false);
  assert.equal(verifyIngestToken(parseIngestTokenHash(ingestTokenHash("other-token")), token), false);
});

test("ingest token generator emits canonical 256-bit base64url and its hex digest", () => {
  const token = generateIngestToken();
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(token, "base64url").byteLength, 32);
  assert.equal(Buffer.from(token, "base64url").toString("base64url"), token);
  assert.equal(ingestTokenHash(token), createHash("sha256").update(token, "utf8").digest("hex"));
  assert.match(ingestTokenHash(token), /^[0-9a-f]{64}$/);
});
