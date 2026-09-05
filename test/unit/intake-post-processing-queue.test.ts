import assert from "node:assert/strict";
import { test } from "node:test";
import { PostProcessingQueue } from "../../src/intake/post-processing-queue.js";

test("post-processing queue retries deterministically and deduplicates dump IDs", () => {
  const callbacks: Array<() => void> = [];
  let attempts = 0;
  const queue = new PostProcessingQueue({
    processor: { process: () => { attempts += 1; if (attempts < 2) throw new Error("transient"); return "available"; } },
    maxPending: 2,
    maxAttempts: 3,
    retryDelayMs: 50,
    schedule: callback => { callbacks.push(callback); return callback; },
    cancel: () => {},
  });
  assert.equal(queue.enqueue("dump-1"), true);
  assert.equal(queue.enqueue("dump-1"), true);
  assert.equal(callbacks.length, 1);
  callbacks.shift()?.();
  assert.deepEqual(queue.snapshot(), { pending: 1, exhausted: 0, totalRetries: 1 });
  callbacks.shift()?.();
  assert.deepEqual(queue.snapshot(), { pending: 0, exhausted: 0, totalRetries: 1 });
});

test("post-processing queue is bounded, exhausts retries, and closes cleanly", () => {
  const callbacks: Array<() => void> = [];
  let cancelled = 0;
  const queue = new PostProcessingQueue({
    processor: { process: () => { throw new Error("persistent"); } },
    maxPending: 1,
    maxAttempts: 1,
    retryDelayMs: 1,
    schedule: callback => { callbacks.push(callback); return callback; },
    cancel: () => { cancelled += 1; },
  });
  assert.equal(queue.enqueue("dump-1"), true);
  assert.equal(queue.enqueue("dump-2"), false);
  callbacks.shift()?.();
  assert.deepEqual(queue.snapshot(), { pending: 0, exhausted: 1, totalRetries: 1 });
  assert.equal(queue.enqueue("dump-3"), true);
  queue.close();
  assert.equal(cancelled, 1);
  assert.equal(queue.enqueue("dump-4"), false);
  assert.equal(queue.snapshot().pending, 0);
});
