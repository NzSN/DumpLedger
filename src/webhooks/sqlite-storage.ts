import type Database from "better-sqlite3";

import { DumpLedgerError } from "../domain/errors.js";
import type {
  CreateWebhookDeliveryInput,
  CreateWebhookSubscriptionInput,
  WebhookDeliveryFailure,
  WebhookDeliveryRecord,
  WebhookDeliveryStatus,
  WebhookStorage,
  WebhookSubscriptionRecord,
} from "./storage.js";

type Row = Record<string, unknown>;

const MAX_DELIVERY_PAGE = 500;

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new DumpLedgerError("integrity_failure", `invalid database ${key}`);
  return value;
}

function nullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new DumpLedgerError("integrity_failure", `invalid database ${key}`);
  return value;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" && typeof value !== "bigint") throw new DumpLedgerError("integrity_failure", `invalid database ${label}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new DumpLedgerError("integrity_failure", `invalid database ${label}`);
  return parsed;
}

function integerFromRow(row: Row, key: string, minimum: number): number {
  return integer(row[key], key, minimum);
}

function nullableIntegerFromRow(row: Row, key: string, minimum: number): number | null {
  const value = row[key];
  return value === null ? null : integer(value, key, minimum);
}

function actionsFromRow(row: Row): readonly string[] | null {
  const raw = row.actions_json;
  if (raw === null) return null;
  if (typeof raw !== "string") throw new DumpLedgerError("integrity_failure", "invalid database actions_json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DumpLedgerError("integrity_failure", "invalid database actions_json", { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every((entry: unknown) => typeof entry === "string")) {
    throw new DumpLedgerError("integrity_failure", "invalid database actions_json");
  }
  return parsed as readonly string[];
}

function statusFromRow(row: Row): WebhookDeliveryStatus {
  const value = requiredString(row, "status");
  if (value !== "pending" && value !== "delivered" && value !== "exhausted") throw new DumpLedgerError("integrity_failure", "invalid database status");
  return value;
}

function subscriptionFromRow(row: Row): WebhookSubscriptionRecord {
  return {
    subscriptionId: requiredString(row, "subscription_id"),
    url: requiredString(row, "url"),
    secret: requiredString(row, "secret"),
    actions: actionsFromRow(row),
    caseId: nullableString(row, "case_id"),
    cursorRowid: integerFromRow(row, "cursor_rowid", 0),
    createdAt: requiredString(row, "created_at"),
  };
}

function deliveryFromRow(row: Row): WebhookDeliveryRecord {
  return {
    deliveryId: requiredString(row, "delivery_id"),
    subscriptionId: requiredString(row, "subscription_id"),
    eventRowid: integerFromRow(row, "event_rowid", 1),
    action: requiredString(row, "action"),
    dumpId: nullableString(row, "dump_id"),
    status: statusFromRow(row),
    attempts: integerFromRow(row, "attempts", 0),
    lastStatusCode: nullableIntegerFromRow(row, "last_status_code", 0),
    lastError: nullableString(row, "last_error"),
    nextAttemptAt: nullableString(row, "next_attempt_at"),
    deliveredAt: nullableString(row, "delivered_at"),
    createdAt: requiredString(row, "created_at"),
  };
}

function isForeignKeyFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { readonly code?: unknown }).code === "SQLITE_CONSTRAINT_FOREIGNKEY";
}

export class SqliteWebhookStorage implements WebhookStorage {
  constructor(private readonly database: Database.Database) {}

  createSubscription(input: CreateWebhookSubscriptionInput): WebhookSubscriptionRecord {
    try {
      this.database.prepare(`
        INSERT INTO webhook_subscriptions(subscription_id, url, secret, actions_json, case_id, cursor_rowid, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.subscriptionId,
        input.url,
        input.secret,
        input.actions === null ? null : JSON.stringify(input.actions),
        input.caseId,
        input.cursorRowid,
        input.createdAt,
      );
    } catch (error) {
      if (isForeignKeyFailure(error)) throw new DumpLedgerError("invalid_input", "caseId does not name an existing case", { cause: error });
      throw error;
    }
    const record = this.findSubscription(input.subscriptionId);
    if (record === null) throw new DumpLedgerError("integrity_failure", "created webhook subscription was not found");
    return record;
  }

  listSubscriptions(): readonly WebhookSubscriptionRecord[] {
    return (this.database.prepare("SELECT * FROM webhook_subscriptions ORDER BY created_at, subscription_id").all() as Row[]).map(subscriptionFromRow);
  }

  findSubscription(subscriptionId: string): WebhookSubscriptionRecord | null {
    const row = this.database.prepare("SELECT * FROM webhook_subscriptions WHERE subscription_id = ?").get(subscriptionId) as Row | undefined;
    return row === undefined ? null : subscriptionFromRow(row);
  }

  deleteSubscription(subscriptionId: string): boolean {
    return this.database.prepare("DELETE FROM webhook_subscriptions WHERE subscription_id = ?").run(subscriptionId).changes > 0;
  }

  listDeliveries(subscriptionId: string, limit: number): readonly WebhookDeliveryRecord[] {
    const pageSize = Number.isFinite(limit) ? Math.min(MAX_DELIVERY_PAGE, Math.max(1, Math.trunc(limit))) : 1;
    return (this.database.prepare(`
      SELECT * FROM webhook_deliveries
      WHERE subscription_id = ?
      ORDER BY created_at DESC, delivery_id DESC
      LIMIT ?
    `).all(subscriptionId, pageSize) as Row[]).map(deliveryFromRow);
  }

  findDelivery(subscriptionId: string, eventRowid: number): WebhookDeliveryRecord | null {
    const row = this.database.prepare("SELECT * FROM webhook_deliveries WHERE subscription_id = ? AND event_rowid = ?").get(subscriptionId, eventRowid) as Row | undefined;
    return row === undefined ? null : deliveryFromRow(row);
  }

  createDelivery(input: CreateWebhookDeliveryInput): WebhookDeliveryRecord {
    this.database.prepare(`
      INSERT INTO webhook_deliveries(delivery_id, subscription_id, event_rowid, action, dump_id, status, attempts, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)
    `).run(input.deliveryId, input.subscriptionId, input.eventRowid, input.action, input.dumpId, input.createdAt);
    const record = this.findDelivery(input.subscriptionId, input.eventRowid);
    if (record === null) throw new DumpLedgerError("integrity_failure", "created webhook delivery was not found");
    return record;
  }

  markDelivered(deliveryId: string, statusCode: number, deliveredAt: string): void {
    this.database.prepare(`
      UPDATE webhook_deliveries
      SET status = 'delivered', last_status_code = ?, last_error = NULL, next_attempt_at = NULL, delivered_at = ?
      WHERE delivery_id = ?
    `).run(statusCode, deliveredAt, deliveryId);
  }

  markRetryScheduled(deliveryId: string, attempts: number, failure: WebhookDeliveryFailure, nextAttemptAt: string): void {
    this.database.prepare(`
      UPDATE webhook_deliveries
      SET status = 'pending', attempts = ?, last_status_code = ?, last_error = ?, next_attempt_at = ?, delivered_at = NULL
      WHERE delivery_id = ?
    `).run(attempts, failure.statusCode, failure.error, nextAttemptAt, deliveryId);
  }

  markExhausted(deliveryId: string, attempts: number, failure: WebhookDeliveryFailure, now: string): void {
    void now;
    this.database.prepare(`
      UPDATE webhook_deliveries
      SET status = 'exhausted', attempts = ?, last_status_code = ?, last_error = ?, next_attempt_at = NULL, delivered_at = NULL
      WHERE delivery_id = ?
    `).run(attempts, failure.statusCode, failure.error, deliveryId);
  }

  advanceCursor(subscriptionId: string, eventRowid: number): void {
    this.database.prepare("UPDATE webhook_subscriptions SET cursor_rowid = MAX(cursor_rowid, ?) WHERE subscription_id = ?").run(eventRowid, subscriptionId);
  }

  auditLiveEdge(): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(rowid), 0) AS rowid FROM audit_events").get() as Row;
    return integerFromRow(row, "rowid", 0);
  }
}
