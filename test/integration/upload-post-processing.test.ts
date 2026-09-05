import assert from "node:assert/strict";
import { test } from "node:test";

import { createDumpLedgerEngine, DeterministicClock, DeterministicEntropy, DeterministicIds, ScriptedFailpoints } from "../../src/engine/dump-ledger-engine.js";
import { EngineUploadPostProcessor } from "../../src/intake/intake-facade.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";

function stageSealed(options: { failpoints?: ScriptedFailpoints; secret: string; keyByte: number }) {
  const vault = new MemoryVault();
  const engine = createDumpLedgerEngine({
    databasePath: ":memory:", vault, inspection: { inspect: () => ({ ok: true, coverage: "partial", facts: {} }) },
    grantSecretKey: Buffer.alloc(32, options.keyByte), clock: new DeterministicClock("2026-09-04T00:00:00.000Z"),
    entropy: new DeterministicEntropy([options.secret]), ids: new DeterministicIds(), ...(options.failpoints === undefined ? {} : { failpoints: options.failpoints }),
  });
  const customer = engine.execute({ type: "CreateCustomer", displayName: "Acme" });
  assert(customer.ok && customer.customerId);
  const supportCase = engine.execute({ type: "CreateCase", customerId: customer.customerId, title: "Crash" });
  assert(supportCase.ok && supportCase.caseId);
  const grant = engine.execute({ type: "IssueGrant", caseId: supportCase.caseId, expiresAt: "2026-09-05T00:00:00.000Z", maxBytes: 16n });
  assert(grant.ok && grant.grantSecret);
  const begun = engine.execute({ type: "BeginUpload", grantSecret: grant.grantSecret, originalName: "x.dmp" });
  assert(begun.ok && begun.dumpId);
  const dumpId = begun.dumpId;
  vault.append(dumpId, Buffer.from("MDMP"));
  vault.syncAndClose(dumpId);
  assert(engine.execute({ type: "SealUpload", dumpId, byteSize: 4n, sha256: "a".repeat(64) }).ok);
  return { vault, engine, dumpId };
}

test("post-processing retry resumes after promotion crossed the filesystem checkpoint", () => {
  const context = stageSealed({ failpoints: new ScriptedFailpoints(["after_vault_promote"]), secret: "s".repeat(43), keyByte: 0x41 });
  const processor = new EngineUploadPostProcessor(context.engine);
  assert.throws(() => processor.process(context.dumpId), /simulated crash/);
  assert.equal(context.engine.snapshot().dumps[0]?.phase, "sealed");
  assert.deepEqual(context.vault.inspectPresence(context.dumpId), { staging: false, vault: true });
  assert.equal(processor.process(context.dumpId), "available");
  assert.equal(context.engine.snapshot().dumps[0]?.phase, "available");
  context.engine.close();
});

test("post-processing retry skips an already committed promotion", () => {
  const context = stageSealed({ secret: "t".repeat(43), keyByte: 0x42 });
  assert(context.engine.execute({ type: "PromoteObject", dumpId: context.dumpId }).ok);
  assert.equal(context.engine.snapshot().dumps[0]?.blobState, "vault");
  assert.equal(new EngineUploadPostProcessor(context.engine).process(context.dumpId), "available");
  assert.equal(context.engine.snapshot().dumps[0]?.phase, "available");
  context.engine.close();
});
