import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDumpLedgerEngine,
  DeterministicClock,
  DeterministicEntropy,
  DeterministicIds,
  type DumpLedgerEngine,
} from "../../src/engine/dump-ledger-engine.js";
import type { CaseId, CustomerId } from "../../src/domain/ids.js";
import type { LifecycleAction } from "../../src/engine/commands.js";
import type { CaseStatus } from "../../src/domain/lifecycle.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";
import { fixture, createQuarantined } from "./support.js";

function withEntropy(secrets: readonly string[]): ReturnType<typeof fixture> {
  const clock = new DeterministicClock("2026-09-04T00:00:00.000Z");
  const vault = new MemoryVault();
  const engine = createDumpLedgerEngine({
    databasePath: ":memory:",
    vault,
    inspection: { inspect: () => ({ ok: true, coverage: "partial", facts: {} }) },
    grantSecretKey: Uint8Array.from({ length: 32 }, () => 0x41),
    clock,
    entropy: new DeterministicEntropy([...secrets]),
    ids: new DeterministicIds(),
  });
  return { clock, engine, vault };
}

const manySecrets = Array.from(
  { length: 12 },
  (_unused, index) => `upload-secret-${String(index).padStart(24, "0")}`,
);

interface Workflow {
  readonly engine: DumpLedgerEngine;
  readonly caseId: CaseId;
}

function createCase(engine: DumpLedgerEngine): Workflow {
  const customer = engine.execute({ type: "CreateCustomer", displayName: "Acme" });
  assert.ok(customer.ok);
  const created = engine.execute({
    type: "CreateCase",
    customerId: customer.customerId!,
    title: "Crash",
  });
  assert.ok(created.ok);
  return { engine, caseId: created.caseId! };
}

function transit(
  workflow: Workflow,
  action: Extract<
    LifecycleAction,
    "StartInvestigation" | "WaitForCustomer" | "ResumeInvestigation" | "ResolveCase" | "CloseCase"
  >,
): void {
  const receipt = workflow.engine.execute({ type: action, caseId: workflow.caseId });
  assert.ok(receipt.ok, `${action} should be legal: ${JSON.stringify(receipt)}`);
}

function statusOf(engine: DumpLedgerEngine, caseId: CaseId): CaseStatus {
  const found = engine.snapshot().cases.find((candidate) => candidate.caseId === caseId);
  assert.ok(found);
  return found.status;
}

const statuses: readonly CaseStatus[] = [
  "new",
  "investigating",
  "waiting-for-customer",
  "resolved",
  "closed",
];

/** Move a fresh "new" case to the requested status using only legal transitions. */
function advance(workflow: Workflow, target: CaseStatus): void {
  const { engine, caseId } = workflow;
  const current = statusOf(engine, caseId);
  if (current === target) return;
  switch (target) {
    case "investigating":
      assert.equal(current, "new");
      transit(workflow, "StartInvestigation");
      return;
    case "waiting-for-customer":
      advance(workflow, "investigating");
      transit(workflow, "WaitForCustomer");
      return;
    case "resolved":
      if (current === "new") {
        transit(workflow, "StartInvestigation");
      } else if (current === "waiting-for-customer") {
        transit(workflow, "ResumeInvestigation");
      }
      transit(workflow, "ResolveCase");
      return;
    case "closed":
      advance(workflow, "resolved");
      transit(workflow, "CloseCase");
      return;
  }
}

const legalFrom: Readonly<Record<CaseStatus, readonly string[]>> = {
  new: ["StartInvestigation"],
  investigating: ["WaitForCustomer", "ResolveCase"],
  "waiting-for-customer": ["ResumeInvestigation", "ResolveCase"],
  resolved: ["ResumeInvestigation", "CloseCase"],
  closed: ["ResumeInvestigation"],
};
const allCaseActions = [
  "StartInvestigation",
  "WaitForCustomer",
  "ResumeInvestigation",
  "ResolveCase",
  "CloseCase",
] as const;

describe("lifecycle engine", () => {
  it("publishes only a case-bound validated vault object", () => {
    const { engine, vault } = fixture();
    const id = createQuarantined(engine, vault);
    assert(engine.execute({ type: "AcceptDump", dumpId: id }).ok);
    const dump = engine.snapshot().dumps[0];
    assert.equal(dump?.phase, "available");
    assert.equal(dump?.coverage, "partial");
    assert.equal(dump?.downloadable, true);
    assert.deepEqual(engine.integrityCheck(), []);
    engine.close();
  });
  it("rejects illegal transitions without partial mutation", () => {
    const { engine, vault } = fixture();
    const customer = engine.execute({ type: "CreateCustomer", displayName: "Acme" });
    assert(customer.ok && customer.customerId);
    const c = engine.execute({ type: "CreateCase", customerId: customer.customerId, title: "x" });
    assert(c.ok && c.caseId);
    const g = engine.execute({ type: "IssueGrant", caseId: c.caseId, expiresAt: "2026-09-05T00:00:00.000Z", maxBytes: 8n });
    assert(g.ok && g.grantSecret);
    const b = engine.execute({ type: "BeginUpload", grantSecret: g.grantSecret, originalName: "x" });
    assert(b.ok && b.dumpId);
    const before = engine.snapshot();
    const bad = engine.execute({ type: "PromoteObject", dumpId: b.dumpId });
    assert(!bad.ok);
    assert.equal(bad.error.code, "invalid_transition");
    assert.deepEqual(engine.snapshot(), before);
    assert.deepEqual(vault.inspectPresence(b.dumpId), { staging: true, vault: false });
    engine.close();
  });
  it("consumes each grant at most once", () => {
    const { engine, vault } = fixture();
    const customer = engine.execute({ type: "CreateCustomer", displayName: "Acme" });
    assert(customer.ok && customer.customerId);
    const c = engine.execute({ type: "CreateCase", customerId: customer.customerId, title: "x" });
    assert(c.ok && c.caseId);
    const g = engine.execute({ type: "IssueGrant", caseId: c.caseId, expiresAt: "2026-09-05T00:00:00.000Z", maxBytes: 8n });
    assert(g.ok && g.grantSecret);
    const first = engine.execute({ type: "BeginUpload", grantSecret: g.grantSecret, originalName: "one" });
    assert(first.ok);
    const second = engine.execute({ type: "BeginUpload", grantSecret: g.grantSecret, originalName: "two" });
    assert(!second.ok);
    assert.equal(second.error.code, "grant_consumed");
    assert.equal(engine.snapshot().dumps.length, 1);
    assert.equal(vault.listStagingIds().length, 1);
    engine.close();
  });
  it("preserves association and disables download in tombstone", () => {
    const { engine, vault } = fixture();
    const id = createQuarantined(engine, vault);
    assert(engine.execute({ type: "AcceptDump", dumpId: id }).ok);
    const caseId = engine.snapshot().dumps[0]?.caseId;
    assert(engine.execute({ type: "BeginPurge", dumpId: id }).ok);
    assert(engine.execute({ type: "FinishPurge", dumpId: id }).ok);
    const dump = engine.snapshot().dumps[0];
    assert.equal(dump?.phase, "deleted");
    assert.equal(dump?.caseId, caseId);
    assert.equal(dump?.downloadable, false);
    engine.close();
  });

  it("walks every legal case-transition path including resume from resolved and closed", () => {
    const { engine } = fixture();
    const workflow = createCase(engine);

    // new -> investigating -> waiting-for-customer -> investigating (resume) -> resolved
    transit(workflow, "StartInvestigation");
    assert.equal(statusOf(engine, workflow.caseId), "investigating");
    transit(workflow, "WaitForCustomer");
    assert.equal(statusOf(engine, workflow.caseId), "waiting-for-customer");
    transit(workflow, "ResumeInvestigation");
    assert.equal(statusOf(engine, workflow.caseId), "investigating");
    transit(workflow, "ResolveCase");
    assert.equal(statusOf(engine, workflow.caseId), "resolved");

    // resume from resolved, then back to resolved and close
    transit(workflow, "ResumeInvestigation");
    assert.equal(statusOf(engine, workflow.caseId), "investigating");
    transit(workflow, "ResolveCase");
    transit(workflow, "CloseCase");
    assert.equal(statusOf(engine, workflow.caseId), "closed");

    // resume from closed returns to investigating; closure grants are not restored
    transit(workflow, "ResumeInvestigation");
    assert.equal(statusOf(engine, workflow.caseId), "investigating");

    const auditActions = engine.snapshot().auditEvents.map((audit) => audit.action);
    for (const action of allCaseActions) {
      assert.ok(auditActions.includes(action), `audit should record ${action}`);
    }
    assert.ok(!auditActions.includes("IssueGrant"), "no grant was issued in this flow");
    engine.close();
  });

  it("rejects every illegal case transition without mutation and reports not_found for missing cases", () => {
    for (const from of statuses) {
      const { engine } = fixture();
      const workflow = createCase(engine);
      advance(workflow, from);
      for (const action of allCaseActions) {
        if ((legalFrom[from] as readonly string[]).includes(action)) continue;
        const before = engine.snapshot();
        const receipt = engine.execute({ type: action, caseId: workflow.caseId });
        assert.equal(receipt.ok, false, `${action} must fail from ${from}`);
        assert.equal(receipt.error.code, "invalid_transition");
        assert.equal(statusOf(engine, workflow.caseId), from, `${action} must not change ${from}`);
        assert.deepEqual(engine.snapshot(), before, `${action} must not mutate state from ${from}`);
      }
      engine.close();
    }

    const { engine } = fixture();
    const missing = "case_AAAAAAAAAAAAAAAAAAAAAAAAAA" as CaseId;
    for (const action of allCaseActions) {
      const receipt = engine.execute({ type: action, caseId: missing });
      assert.equal(receipt.ok, false);
      assert.equal(receipt.error.code, "not_found");
    }
    engine.close();
  });

  it("reports the customer on every case-transition audit event", () => {
    const { engine } = fixture();
    const workflow = createCase(engine);
    const customerId: CustomerId = engine.snapshot().auditEvents.find(
      (audit) => audit.action === "CreateCase",
    )!.customerId!;
    for (const status of ["investigating", "waiting-for-customer", "resolved", "closed"] as const) {
      advance(workflow, status);
    }
    const caseAudits = engine.snapshot().auditEvents.filter(
      (audit) => audit.action !== "CreateCustomer" && audit.action !== "CreateCase",
    );
    for (const audit of caseAudits) {
      assert.equal(audit.caseId, workflow.caseId);
      assert.equal(audit.customerId, customerId);
    }
    engine.close();
  });

  it("atomically revokes every issued grant at closure and blocks intake while closed", () => {
    const { engine } = withEntropy(manySecrets);
    const workflow = createCase(engine);
    advance(workflow, "resolved");

    const first = engine.execute({
      type: "IssueGrant",
      caseId: workflow.caseId,
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxBytes: 64n,
    });
    assert.ok(first.ok && first.grantId && first.grantSecret);
    const second = engine.execute({
      type: "IssueGrant",
      caseId: workflow.caseId,
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxBytes: 64n,
    });
    assert.ok(second.ok && second.grantId && second.grantSecret);

    const closed = engine.execute({ type: "CloseCase", caseId: workflow.caseId });
    assert.ok(closed.ok);
    assert.deepEqual(
      [...closed.revokedGrantIds!].sort(),
      [first.grantId, second.grantId].sort(),
      "CloseCase returns every revoked grant id",
    );
    assert.equal(statusOf(engine, workflow.caseId), "closed");

    const grants = engine.snapshot().grants.filter((grant) => grant.caseId === workflow.caseId);
    assert.equal(grants.length, 2);
    for (const grant of grants) {
      assert.equal(grant.state, "revoked", "every issued grant is revoked atomically at closure");
    }

    const closeAudit = [...engine.snapshot().auditEvents]
      .reverse()
      .find((audit) => audit.action === "CloseCase");
    assert.ok(closeAudit);
    assert.deepEqual(closeAudit.detail.revokedGrantIds, [first.grantId, second.grantId]);

    // A revoked grant can no longer begin an upload.
    const upload = engine.execute({
      type: "BeginUpload",
      grantSecret: first.grantSecret!,
      originalName: "blocked.dmp",
    });
    assert.equal(upload.ok, false);
    assert.equal(upload.error.code, "grant_invalid");

    // No new grant can be issued while the case is closed.
    const issued = engine.execute({
      type: "IssueGrant",
      caseId: workflow.caseId,
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxBytes: 64n,
    });
    assert.equal(issued.ok, false);
    assert.equal(issued.error.code, "invalid_transition");
    assert.equal(engine.snapshot().grants.filter((grant) => grant.caseId === workflow.caseId).length, 2);
    engine.close();
  });

  it("reopening a closed case permits new grants without restoring revoked ones", () => {
    const { engine } = withEntropy(manySecrets);
    const workflow = createCase(engine);
    advance(workflow, "resolved");
    const original = engine.execute({
      type: "IssueGrant",
      caseId: workflow.caseId,
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxBytes: 64n,
    });
    assert.ok(original.ok && original.grantSecret);
    assert.ok(engine.execute({ type: "CloseCase", caseId: workflow.caseId }).ok);

    transit(workflow, "ResumeInvestigation");
    assert.equal(statusOf(engine, workflow.caseId), "investigating");

    // The revoked grant stays revoked even though the case is investigating again.
    const originalNow = engine.snapshot().grants.find((grant) => grant.grantId === original.grantId);
    assert.equal(originalNow?.state, "revoked");

    const replacement = engine.execute({
      type: "IssueGrant",
      caseId: workflow.caseId,
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxBytes: 64n,
    });
    assert.ok(replacement.ok && replacement.grantSecret);
    const begun = engine.execute({
      type: "BeginUpload",
      grantSecret: replacement.grantSecret,
      originalName: "replacement.dmp",
    });
    assert.ok(begun.ok, "a reopened case accepts new uploads");
    engine.close();
  });

  it("never changes dump retention or downloadability at closure and purge still runs", () => {
    const { engine, vault } = withEntropy(manySecrets);
    const dumpId = createQuarantined(engine, vault);
    assert.ok(engine.execute({ type: "AcceptDump", dumpId }).ok);
    assert.ok(
      engine.execute({ type: "SetRetention", dumpId, purgeAt: "2026-09-05T00:00:00.000Z" }).ok,
    );
    const caseId = engine.snapshot().dumps.find((dump) => dump.dumpId === dumpId)!.caseId;

    const workflow = { engine, caseId };
    advance(workflow, "resolved");
    assert.ok(engine.execute({ type: "CloseCase", caseId }).ok);
    assert.equal(statusOf(engine, caseId), "closed");

    const dump = engine.snapshot().dumps.find((candidate) => candidate.dumpId === dumpId);
    assert.equal(dump?.phase, "available", "closure never changes dump phase");
    assert.equal(dump?.downloadable, true, "closure never revokes downloadability");
    assert.equal(dump?.purgeAt, "2026-09-05T00:00:00.000Z", "closure never changes retention");
    assert.equal(dump?.caseId, caseId, "closure never changes case association");

    // Retention and deletion continue to operate on a closed case's dumps.
    assert.ok(engine.execute({ type: "BeginPurge", dumpId }).ok);
    assert.ok(engine.execute({ type: "FinishPurge", dumpId }).ok);
    const purged = engine.snapshot().dumps.find((candidate) => candidate.dumpId === dumpId);
    assert.equal(purged?.phase, "deleted");
    assert.equal(purged?.downloadable, false);
    engine.close();
  });
});
