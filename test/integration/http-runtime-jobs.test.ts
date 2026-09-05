import assert from "node:assert/strict";
import { test } from "node:test";
import { PeriodicRuntimeJob } from "../../src/http/runtime-jobs.js";

test("periodic runtime job reschedules without overlap and closes without sleeps", () => {
  const callbacks: Array<() => void> = [];
  let runs = 0;
  let cancelled = 0;
  const job = new PeriodicRuntimeJob({ name: "retention", intervalMs: 100, run: () => { runs += 1; }, schedule: callback => { callbacks.push(callback); return callback; }, cancel: () => { cancelled += 1; } });
  job.start();
  job.start();
  assert.equal(callbacks.length, 1);
  callbacks.shift()?.();
  assert.equal(runs, 1);
  assert.equal(callbacks.length, 1);
  assert.deepEqual(job.snapshot(), { name: "retention", running: true, runs: 1, failures: 0 });
  job.close();
  assert.equal(cancelled, 1);
  assert.equal(job.snapshot().running, false);
});

test("periodic runtime job contains callback failures and schedules the next tick", () => {
  const callbacks: Array<() => void> = [];
  const job = new PeriodicRuntimeJob({ name: "retention", intervalMs: 1, run: () => { throw new Error("temporary failure"); }, schedule: callback => { callbacks.push(callback); return callback; }, cancel: () => {} });
  job.start();
  callbacks.shift()?.();
  assert.deepEqual(job.snapshot(), { name: "retention", running: true, runs: 1, failures: 1 });
  assert.equal(callbacks.length, 1);
  job.close();
});
