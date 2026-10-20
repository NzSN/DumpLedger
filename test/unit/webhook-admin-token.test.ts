import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseWebhookAdminTokenHash, verifyWebhookAdminToken } from "../../src/auth/webhook-admin-token.js";
import { generateWebhookAdminToken, webhookAdminTokenHash } from "../../tools/generate-webhook-admin-token.js";

function sha256Hex(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

test("webhook admin token config: unset or empty disables token auth entirely", () => {
  assert.equal(parseWebhookAdminTokenHash(undefined), undefined);
  assert.equal(parseWebhookAdminTokenHash(""), undefined);
  assert.equal(verifyWebhookAdminToken(undefined, "any-token"), false);
  assert.equal(verifyWebhookAdminToken(undefined, ""), false);
});

test("webhook admin token config: malformed digests fail fast", () => {
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
    assert.throws(() => parseWebhookAdminTokenHash(value), /DUMP_LEDGER_WEBHOOK_ADMIN_TOKEN_HASH must be 64 lowercase hex characters/);
  }
});

test("webhook admin token verification matches sha256 digests exactly", () => {
  const token = "configured-webhook-admin-bearer-token";
  const configured = parseWebhookAdminTokenHash(sha256Hex(token));
  assert.equal(configured?.byteLength, 32);
  assert.equal(verifyWebhookAdminToken(configured, token), true);
  assert.equal(verifyWebhookAdminToken(parseWebhookAdminTokenHash(sha256Hex("other-token")), token), false);
});

test("webhook admin token verification rejects wrong and empty tokens", () => {
  const token = "configured-webhook-admin-bearer-token";
  const configured = parseWebhookAdminTokenHash(sha256Hex(token));
  assert.equal(verifyWebhookAdminToken(configured, token.slice(0, -1)), false);
  assert.equal(verifyWebhookAdminToken(configured, `${token}x`), false);
  assert.equal(verifyWebhookAdminToken(configured, token.toUpperCase()), false);
  assert.equal(verifyWebhookAdminToken(configured, ""), false);
});

test("webhook admin token verification never throws on tokens of differing length", () => {
  const configured = parseWebhookAdminTokenHash(sha256Hex("baseline-token"));
  const tokens = ["", "x", "xx", "x".repeat(31), "x".repeat(32), "x".repeat(33), "x".repeat(64), "x".repeat(65), "x".repeat(1024), "秘🔑密"];
  for (const token of tokens) {
    assert.doesNotThrow(() => verifyWebhookAdminToken(configured, token));
    assert.equal(verifyWebhookAdminToken(configured, token), false);
  }
});

test("webhook admin token generator emits canonical 256-bit base64url and its hex digest", () => {
  const token = generateWebhookAdminToken();
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(token, "base64url").byteLength, 32);
  assert.equal(Buffer.from(token, "base64url").toString("base64url"), token);
  assert.equal(webhookAdminTokenHash(token), createHash("sha256").update(token, "utf8").digest("hex"));
  assert.match(webhookAdminTokenHash(token), /^[0-9a-f]{64}$/);
  assert.equal(verifyWebhookAdminToken(parseWebhookAdminTokenHash(webhookAdminTokenHash(token)), token), true);
});
