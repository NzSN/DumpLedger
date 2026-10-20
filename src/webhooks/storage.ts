/**
 * Operational webhook state (docs/webhook-notifications-design.md, "Storage
 * (migration 11)"): operator subscriptions and their durable delivery rows.
 * This port is not a ledger command surface and appends no audit events.
 */
export type WebhookDeliveryStatus = "pending" | "delivered" | "exhausted";

export interface WebhookSubscriptionRecord {
  readonly subscriptionId: string;
  readonly url: string;
  readonly secret: string;
  readonly actions: readonly string[] | null;
  readonly caseId: string | null;
  readonly cursorRowid: number;
  readonly createdAt: string;
}

export interface WebhookDeliveryRecord {
  readonly deliveryId: string;
  readonly subscriptionId: string;
  readonly eventRowid: number;
  readonly action: string;
  readonly dumpId: string | null;
  readonly status: WebhookDeliveryStatus;
  readonly attempts: number;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly nextAttemptAt: string | null;
  readonly deliveredAt: string | null;
  readonly createdAt: string;
}

export interface CreateWebhookSubscriptionInput {
  readonly subscriptionId: string;
  readonly url: string;
  readonly secret: string;
  readonly actions: readonly string[] | null;
  readonly caseId: string | null;
  readonly cursorRowid: number;
  readonly createdAt: string;
}

export interface CreateWebhookDeliveryInput {
  readonly deliveryId: string;
  readonly subscriptionId: string;
  readonly eventRowid: number;
  readonly action: string;
  readonly dumpId: string | null;
  readonly createdAt: string;
}

export interface WebhookDeliveryFailure {
  readonly statusCode: number | null;
  readonly error: string;
}

export interface WebhookStorage {
  createSubscription(input: CreateWebhookSubscriptionInput): WebhookSubscriptionRecord;
  listSubscriptions(): readonly WebhookSubscriptionRecord[];
  findSubscription(subscriptionId: string): WebhookSubscriptionRecord | null;
  deleteSubscription(subscriptionId: string): boolean;
  listDeliveries(subscriptionId: string, limit: number): readonly WebhookDeliveryRecord[];
  findDelivery(subscriptionId: string, eventRowid: number): WebhookDeliveryRecord | null;
  createDelivery(input: CreateWebhookDeliveryInput): WebhookDeliveryRecord;
  markDelivered(deliveryId: string, statusCode: number, deliveredAt: string): void;
  markRetryScheduled(deliveryId: string, attempts: number, failure: WebhookDeliveryFailure, nextAttemptAt: string): void;
  markExhausted(deliveryId: string, attempts: number, failure: WebhookDeliveryFailure, now: string): void;
  advanceCursor(subscriptionId: string, eventRowid: number): void;
  auditLiveEdge(): number;
}
