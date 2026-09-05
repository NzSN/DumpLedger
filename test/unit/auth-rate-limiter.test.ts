import assert from "node:assert/strict";
import { test } from "node:test";

import { FixedWindowRateLimiter } from "../../src/auth/rate-limiter.js";

test("rate limiter resets on the injected clock without sleeping", () => {
  let now = 1_000;
  const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 100, maxKeys: 3, now: () => now });
  assert.equal(limiter.take("client-a"), true);
  assert.equal(limiter.take("client-a"), true);
  assert.equal(limiter.take("client-a"), false);
  now += 100;
  assert.equal(limiter.take("client-a"), true);
});

test("rate limiter retains only a bounded number of active keys", () => {
  let now = 2_000;
  const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 2, now: () => now });
  assert.equal(limiter.take("oldest"), true);
  now += 1;
  assert.equal(limiter.take("middle"), true);
  now += 1;
  assert.equal(limiter.take("newest"), true);
  assert.equal(limiter.size, 2);
  assert.equal(limiter.take("oldest"), true, "oldest entry was evicted instead of growing the map");
  now += 1_000;
  assert.equal(limiter.take("after-expiry"), true);
  assert.equal(limiter.size, 1);
});
