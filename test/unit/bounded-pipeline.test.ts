import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { boundedPipeline, validateUploadTimeouts } from "../../src/intake/bounded-pipeline.js";

test("idle uploads are aborted and both streams are destroyed", async () => {
  const source = new PassThrough();
  const destination = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const pending = boundedPipeline(source, destination, { idleMs: 30, totalMs: 1000 });
  source.write(Buffer.from("one chunk"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(source.destroyed, true);
  assert.equal(destination.destroyed, true);
});

test("a trickle cannot reset the total upload deadline", async () => {
  const source = new PassThrough();
  let received = 0;
  const destination = new Writable({ write(_chunk, _encoding, done) { received += 1; done(); } });
  const trickle = setInterval(() => source.write(Buffer.from("x")), 5);
  try {
    await assert.rejects(boundedPipeline(source, destination, { idleMs: 1000, totalMs: 100 }), { name: "AbortError" });
    assert.ok(received > 0);
    assert.equal(source.destroyed, true);
  } finally {
    clearInterval(trickle);
  }
});

test("timeout configuration rejects disabled and overflowing timers", () => {
  for (const value of [0, -1, Infinity, NaN, 0.5, 2_147_483_648]) {
    assert.throws(() => validateUploadTimeouts({ idleMs: value, totalMs: 1000 }), RangeError);
    assert.throws(() => validateUploadTimeouts({ idleMs: 1000, totalMs: value }), RangeError);
  }
});
