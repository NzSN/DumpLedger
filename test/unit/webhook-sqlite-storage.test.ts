import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import BetterSqlite3 from "better-sqlite3";

import { DumpLedgerError } from "../../src/domain/errors.js";
import { parseAuditEventId, parseCaseId, parseCustomerId, type AuditEventId, type CaseId } from "../../src/domain/ids.js";
import { SqliteLedger } from "../../src/ledger/sqlite-ledger.js";
import type { CreateWebhookDeliveryInput, CreateWebhookSubscriptionInput, WebhookStorage } from "../../src/webhooks/storage.js";

/**
 * Storage coverage for webhook notifications (docs/webhook-notifications-design.md,
 * "Storage (migration 11)"): subscriptions and deliveries on a real ledger's
 * single-writer SQLite connection, including the FK/cascade behavior and the
 * UNIQUE pair that makes retries reuse their delivery row.
 */

const NOW = "2026-10-20T00:00:00.000Z";
const LATER = "2026-10-20T00:01:00.000Z";
const DELIVERED_AT = "2026-10-20T00:02:00.000Z";
const EXHAUSTED_AT = "2026-10-20T00:03:00.000Z";

const body = (value: number): string => value.toString(10).padStart(26, "0");

let eventCounter = 0;
function event(occurredAt: string): { readonly eventId: AuditEventId; readonly occurredAt: string } {
  eventCounter += 1;
  return { eventId: parseAuditEventId(`audit_${body(eventCounter)}`), occurredAt };
}

function withLedger(run: (ledger: SqliteLedger) => void): void {
  const ledger = new SqliteLedger(":memory:");
  try {
    run(ledger);
  } finally {
    ledger.close();
  }
}

function seedCase(ledger: SqliteLedger): CaseId {
  const customerId = parseCustomerId(`customer_${body(1)}`);
  const caseId = parseCaseId(`case_${body(1)}`);
  ledger.createCustomer(customerId, "Acme", event(NOW));
  ledger.createCase(caseId, customerId, "Renderer crash", event(NOW));
  return caseId;
}

function subscriptionInput(overrides: Partial<CreateWebhookSubscriptionInput> = {}): CreateWebhookSubscriptionInput {
  return {
    subscriptionId: "webhook_00000000000000000000000001",
    url: "https://analyzer.example.test/hook",
    secret: "signing-secret",
    actions: null,
    caseId: null,
    cursorRowid: 0,
    createdAt: NOW,
    ...overrides,
  };
}

function deliveryInput(overrides: Partial<CreateWebhookDeliveryInput> = {}): CreateWebhookDeliveryInput {
  return {
    deliveryId: "whd_00000000000000000000000001",
    subscriptionId: "webhook_00000000000000000000000001",
    eventRowid: 1,
    action: "AcceptDump",
    dumpId: "dump_00000000000000000000000001",
    createdAt: NOW,
    ...overrides,
  };
}

describe("webhook SQLite storage", () => {
  it("creates, finds, and lists subscriptions in (created_at, id) order", () => {
    withLedger((ledger) => {
      const storage = ledger.webhookStorage();
      const caseId = seedCase(ledger);
      const first = storage.createSubscription(subscriptionInput({
        subscriptionId: "webhook_00000000000000000000000002",
        actions: ["AcceptDump", "RejectDump"],
        caseId,
        cursorRowid: 7,
      }));
      const tied = storage.createSubscription(subscriptionInput({
        subscriptionId: "webhook_00000000000000000000000001",
      }));
      const later = storage.createSubscription(subscriptionInput({
        subscriptionId: "webhook_00000000000000000000000003",
        actions: [],
        createdAt: LATER,
      }));

      assert.deepEqual(first, {
        subscriptionId: "webhook_00000000000000000000000002",
        url: "https://analyzer.example.test/hook",
        secret: "signing-secret",
        actions: ["AcceptDump", "RejectDump"],
        caseId,
        cursorRowid: 7,
        createdAt: NOW,
      });
      assert.deepEqual(storage.findSubscription(tied.subscriptionId), tied);
      assert.equal(storage.findSubscription("webhook_00000000000000000000000099"), null);
      assert.deepEqual(storage.listSubscriptions(), [tied, first, later]);
    });
  });

  it("translates an unknown caseId foreign-key failure to invalid_input", () => {
    withLedger((ledger) => {
      const storage = ledger.webhookStorage();
      const missingCase = `case_${body(99)}`;
      assert.throws(
        () => storage.createSubscription(subscriptionInput({ caseId: missingCase })),
        (error: unknown) => error instanceof DumpLedgerError && error.code === "invalid_input",
      );
      assert.equal(storage.findSubscription("webhook_00000000000000000000000001"), null);
      assert.deepEqual(storage.listSubscriptions(), []);
    });
  });

  it("cascades deliveries when a subscription is deleted", () => {
    withLedger((ledger) => {
      const storage = ledger.webhookStorage();
      const subscription = storage.createSubscription(subscriptionInput());
      storage.createDelivery(deliveryInput());

      assert.equal(storage.deleteSubscription(subscription.subscriptionId), true);
      assert.equal(storage.findSubscription(subscription.subscriptionId), null);
      assert.deepEqual(storage.listDeliveries(subscription.subscriptionId, 50), []);
      assert.equal(storage.deleteSubscription(subscription.subscriptionId), false);
    });
  });

  it("walks a delivery through retry to delivery and to exhaustion", () => {
    withLedger((ledger) => {
      const storage = ledger.webhookStorage();
      const subscription = storage.createSubscription(subscriptionInput());
      const delivered = storage.createDelivery(deliveryInput());

      assert.deepEqual(delivered, {
        ...deliveryInput(),
        status: "pending",
        attempts: 0,
        lastStatusCode: null,
        lastError: null,
        nextAttemptAt: null,
        deliveredAt: null,
      });
      assert.deepEqual(storage.findDelivery(subscription.subscriptionId, 1), delivered);
      assert.throws(() => storage.createDelivery(deliveryInput()), /UNIQUE constraint failed/);

      storage.markRetryScheduled(delivered.deliveryId, 1, { statusCode: 503, error: "service unavailable" }, LATER);
      let current = storage.findDelivery(subscription.subscriptionId, 1);
      assert.equal(current?.status, "pending");
      assert.equal(current?.attempts, 1);
      assert.equal(current?.lastStatusCode, 503);
      assert.equal(current?.lastError, "service unavailable");
      assert.equal(current?.nextAttemptAt, LATER);
      assert.equal(current?.deliveredAt, null);

      storage.markDelivered(delivered.deliveryId, 204, DELIVERED_AT);
      current = storage.findDelivery(subscription.subscriptionId, 1);
      assert.deepEqual(current, {
        ...delivered,
        status: "delivered",
        attempts: 1,
        lastStatusCode: 204,
        lastError: null,
        nextAttemptAt: null,
        deliveredAt: DELIVERED_AT,
      });

      const exhausted = storage.createDelivery(deliveryInput({
        deliveryId: "whd_00000000000000000000000002",
        eventRowid: 2,
        createdAt: LATER,
      }));
      storage.markRetryScheduled(exhausted.deliveryId, 4, { statusCode: null, error: "connect timeout" }, LATER);
      storage.markExhausted(exhausted.deliveryId, 5, { statusCode: null, error: "timed out" }, EXHAUSTED_AT);
      assert.deepEqual(storage.findDelivery(subscription.subscriptionId, 2), {
        ...exhausted,
        status: "exhausted",
        attempts: 5,
        lastStatusCode: null,
        lastError: "timed out",
        nextAttemptAt: null,
        deliveredAt: null,
      });

      assert.deepEqual(storage.listDeliveries(subscription.subscriptionId, 50).map((record) => record.eventRowid), [2, 1]);
      assert.deepEqual(storage.listDeliveries(subscription.subscriptionId, 0).map((record) => record.eventRowid), [2]);
      assert.equal(storage.listDeliveries(subscription.subscriptionId, 10_000).length, 2);
    });
  });

  it("advances the cursor monotonically and reads the live audit edge", () => {
    const root = mkdtempSync(join(tmpdir(), "dump-ledger-webhook-storage-"));
    const path = join(root, "ledger.sqlite");
    const ledger = new SqliteLedger(path);
    const raw = new BetterSqlite3(path);
    try {
      const storage: WebhookStorage = ledger.webhookStorage();
      assert.equal(storage.auditLiveEdge(), 0);

      raw.prepare("INSERT INTO audit_events(event_id, occurred_at, action, customer_id, case_id, dump_id, detail_json) VALUES (?, ?, ?, NULL, NULL, NULL, ?)")
        .run(`audit_${body(1)}`, NOW, "AcceptDump", "{}");
      const row = raw.prepare("SELECT rowid FROM audit_events").get() as { rowid: number };
      assert.equal(storage.auditLiveEdge(), Number(row.rowid));

      const subscription = storage.createSubscription(subscriptionInput({ cursorRowid: 0 }));
      storage.advanceCursor(subscription.subscriptionId, 1);
      assert.equal(storage.findSubscription(subscription.subscriptionId)?.cursorRowid, 1);
      storage.advanceCursor(subscription.subscriptionId, 0);
      assert.equal(storage.findSubscription(subscription.subscriptionId)?.cursorRowid, 1);
      storage.advanceCursor(subscription.subscriptionId, 2);
      assert.equal(storage.findSubscription(subscription.subscriptionId)?.cursorRowid, 2);
    } finally {
      raw.close();
      ledger.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
