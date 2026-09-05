import assert from "node:assert/strict";
import { test } from "node:test";

import { OperatorSessions, hashOperatorPassword } from "../../src/auth/sessions.js";

test("operator login creates an authenticated, CSRF-protected session", async () => {
  let now = 1_000;
  const sessions = new OperatorSessions({ passwordHash: await hashOperatorPassword("correct horse"), secureCookies: true, now: () => now });
  const login = await sessions.login("correct horse");
  assert.ok(login);
  assert.match(login.setCookie, /^dump_ledger_session=/);
  assert.match(login.setCookie, /HttpOnly/);
  assert.match(login.setCookie, /SameSite=Strict/);
  assert.match(login.setCookie, /Secure/);
  const authenticated = sessions.authenticate(login.setCookie);
  assert.ok(authenticated);
  assert.equal(sessions.verifyCsrf(authenticated, login.csrfToken), true);
  assert.equal(sessions.verifyCsrf(authenticated, "wrong"), false);
  now += 8 * 60 * 60 * 1_000 + 1;
  assert.equal(sessions.authenticate(login.setCookie), undefined);
});

test("operator login rejects an incorrect password without a session", async () => {
  const sessions = new OperatorSessions({ passwordHash: await hashOperatorPassword("right-password"), secureCookies: false });
  assert.equal(await sessions.login("wrong"), undefined);
});

test("invalid password-hash configuration fails at startup", () => {
  assert.throws(() => new OperatorSessions({ passwordHash: "plaintext", secureCookies: false }), /supported scrypt/);
});
