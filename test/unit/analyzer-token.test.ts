import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseAnalyzerTokenHash, verifyAnalyzerToken } from "../../src/auth/analyzer-token.js";

function analyzerTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

test("analyzer token config: unset or empty disables token auth entirely", () => {
  assert.equal(parseAnalyzerTokenHash(undefined), undefined);
  assert.equal(parseAnalyzerTokenHash(""), undefined);
  assert.equal(verifyAnalyzerToken(undefined, "any-token"), false);
  assert.equal(verifyAnalyzerToken(undefined, ""), false);
});

test("analyzer token config: malformed digests fail fast", () => {
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
    assert.throws(() => parseAnalyzerTokenHash(value), /DUMP_LEDGER_ANALYZER_TOKEN_HASH must be 64 lowercase hex characters/);
  }
});

test("analyzer token verification matches sha256 digests exactly", () => {
  const token = "configured-analyzer-bearer-token";
  const configured = parseAnalyzerTokenHash(analyzerTokenHash(token));
  assert.equal(configured?.byteLength, 32);
  assert.equal(verifyAnalyzerToken(configured, token), true);
  assert.equal(verifyAnalyzerToken(parseAnalyzerTokenHash(analyzerTokenHash("other-token")), token), false);
});

test("analyzer token verification rejects wrong and empty tokens", () => {
  const token = "configured-analyzer-bearer-token";
  const configured = parseAnalyzerTokenHash(analyzerTokenHash(token));
  assert.equal(verifyAnalyzerToken(configured, token.slice(0, -1)), false);
  assert.equal(verifyAnalyzerToken(configured, `${token}x`), false);
  assert.equal(verifyAnalyzerToken(configured, token.toUpperCase()), false);
  assert.equal(verifyAnalyzerToken(configured, ""), false);
});

test("analyzer token verification never throws on tokens of differing length", () => {
  const configured = parseAnalyzerTokenHash(analyzerTokenHash("baseline-token"));
  const tokens = ["", "x", "xx", "x".repeat(31), "x".repeat(32), "x".repeat(33), "x".repeat(64), "x".repeat(65), "x".repeat(1024), "秘🔑密"];
  for (const token of tokens) {
    assert.doesNotThrow(() => verifyAnalyzerToken(configured, token));
    assert.equal(verifyAnalyzerToken(configured, token), false);
  }
});
