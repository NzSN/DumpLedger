import assert from "node:assert/strict";
import { test } from "node:test";
import { UploadAdmission } from "../../src/intake/upload-admission.js";

test("upload admission is bounded and releases capacity idempotently", () => {
  const admission = new UploadAdmission(2);
  const first = admission.tryAcquire();
  const second = admission.tryAcquire();
  assert.ok(first);
  assert.ok(second);
  assert.equal(admission.tryAcquire(), undefined);
  assert.deepEqual(admission.snapshot(), { active: 2, capacity: 2 });
  first.release();
  first.release();
  assert.equal(admission.snapshot().active, 1);
  assert.ok(admission.tryAcquire());
});
