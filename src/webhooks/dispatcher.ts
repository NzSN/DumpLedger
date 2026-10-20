import { createHmac, randomBytes } from "node:crypto";

import { parseCaseId } from "../domain/ids.js";
import type { AuditFeedFilter, AuditFeedPage } from "../engine/dump-ledger-engine.js";
import type { AuditFeedEntry } from "../ledger/sqlite-ledger.js";
import type { WebhookDeliveryFailure, WebhookDeliveryRecord, WebhookStorage, WebhookSubscriptionRecord } from "./storage.js";

type TimerHandle = unknown;

/**
 * The dispatcher's narrow read of the audit feed: the engine's
 * `readAuditEvents` keyset read (docs/analyzer-integration-design.md, "Event
 * feed"), without any other engine capability. Structural so tests and the
 * application can supply a fake or the engine itself.
 */
export interface WebhookEventSource {
  readAuditEvents(afterRowid?: number, filter?: AuditFeedFilter, limit?: number): AuditFeedPage;
}

export interface WebhookDispatcherOptions {
  readonly source: WebhookEventSource;
  readonly storage: WebhookStorage;
  readonly tickMs?: number;
  readonly timeoutMs?: number;
  readonly retryBaseMs?: number;
  readonly maxAttempts?: number;
  readonly pageSize?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => string;
  readonly newDeliveryId?: () => string;
  readonly schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancel?: (handle: TimerHandle) => void;
}

export interface WebhookDispatcherSnapshot {
  readonly delivered: number;
  readonly exhausted: number;
  readonly retries: number;
}

type AttemptOutcome = "delivered" | "retry" | "exhausted";

/** Event feed cursor codec (docs/analyzer-integration-design.md, "Event
 * feed"): the zero-padded 16-digit decimal rowid the wire payload carries. */
function formatEventCursor(rowid: number): string {
  return rowid.toString(10).padStart(16, "0");
}

/** The AI2 feed entry as the webhook payload: the body is exactly the feed
 * `Event` object, so a consumer already speaking AI2 needs no new parser. */
function eventPayloadOf(entry: AuditFeedEntry): Readonly<Record<string, unknown>> {
  return {
    cursor: formatEventCursor(entry.rowid),
    eventId: entry.eventId,
    occurredAt: entry.occurredAt,
    action: entry.action,
    customerId: entry.customerId,
    caseId: entry.caseId,
    dumpId: entry.dumpId,
    detail: entry.detail,
  };
}

function failureMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function feedFilterOf(subscription: WebhookSubscriptionRecord): AuditFeedFilter {
  return {
    ...(subscription.actions === null ? {} : { actions: subscription.actions }),
    ...(subscription.caseId === null ? {} : { caseId: parseCaseId(subscription.caseId) }),
  };
}

/**
 * Webhook dispatcher (docs/webhook-notifications-design.md, "Delivery
 * semantics" and "Wire format"): an in-process, tick-driven follower of the
 * audit feed that POSTs matching events to operator-registered endpoints.
 *
 * Per subscription the order is strict (one page after `cursorRowid` per
 * tick, events in `rowid` order) and a retryable failure blocks the page
 * until its `nextAttemptAt` comes due. The delivery row is the durable retry
 * record, so a restart resumes the same attempt instead of duplicating it.
 * The feed remains the resumable truth; this is a low-latency tap.
 */
export class WebhookDispatcher {
  readonly #source: WebhookEventSource;
  readonly #storage: WebhookStorage;
  readonly #tickMs: number;
  readonly #timeoutMs: number;
  readonly #retryBaseMs: number;
  readonly #maxAttempts: number;
  readonly #pageSize: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;
  readonly #newDeliveryId: () => string;
  readonly #schedule: (callback: () => void, delayMs: number) => TimerHandle;
  readonly #cancel: (handle: TimerHandle) => void;
  #timer: TimerHandle | undefined;
  #started = false;
  #closed = false;
  #ticking = false;
  #delivered = 0;
  #exhausted = 0;
  #retries = 0;

  constructor(options: WebhookDispatcherOptions) {
    this.#source = options.source;
    this.#storage = options.storage;
    this.#tickMs = options.tickMs ?? 2_000;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#retryBaseMs = options.retryBaseMs ?? 10_000;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#pageSize = options.pageSize ?? 500;
    if (!Number.isInteger(this.#tickMs) || this.#tickMs < 1) throw new RangeError("tickMs must be positive");
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs < 1) throw new RangeError("timeoutMs must be positive");
    if (!Number.isFinite(this.#retryBaseMs) || this.#retryBaseMs < 0) throw new RangeError("retryBaseMs must not be negative");
    if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts < 1) throw new RangeError("maxAttempts must be positive");
    if (!Number.isInteger(this.#pageSize) || this.#pageSize < 1) throw new RangeError("pageSize must be positive");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newDeliveryId = options.newDeliveryId ?? (() => `whd_${randomBytes(16).toString("base64url")}`);
    this.#schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#scheduleNext();
  }

  snapshot(): WebhookDispatcherSnapshot {
    return { delivered: this.#delivered, exhausted: this.#exhausted, retries: this.#retries };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) this.#cancel(this.#timer);
    this.#timer = undefined;
  }

  #scheduleNext(): void {
    if (this.#closed) return;
    this.#timer = this.#schedule(() => {
      this.#timer = undefined;
      void this.#tick();
    }, this.#tickMs);
  }

  /** One sequential tick over every subscription in creation order. The
   * `#ticking` guard makes an overlapping trigger a no-op; the in-flight
   * tick schedules the next one when it finishes. */
  async #tick(): Promise<void> {
    if (this.#closed || this.#ticking) return;
    this.#ticking = true;
    try {
      const subscriptions = this.#storage.listSubscriptions();
      for (const subscription of subscriptions) {
        if (this.#closed) break;
        try {
          await this.#deliverPage(subscription);
        } catch {
          // A storage or source fault for one subscription must not starve
          // the others; its cursor stays durable and the next tick retries
          // from the same rowid.
        }
      }
    } catch {
      // Listing failed; keep the tick loop alive for the next interval.
    } finally {
      this.#ticking = false;
      this.#scheduleNext();
    }
  }

  /** One feed page for one subscription, head-of-line ordered. Returns when
   * the page is drained, an event is blocked on its retry due time, or a
   * retryable failure stops the page. */
  async #deliverPage(subscription: WebhookSubscriptionRecord): Promise<void> {
    const page = this.#source.readAuditEvents(subscription.cursorRowid, feedFilterOf(subscription), this.#pageSize);
    for (const event of page.events) {
      if (this.#closed) return;
      const existing = this.#storage.findDelivery(subscription.subscriptionId, event.rowid);
      if (existing !== null && existing.status !== "pending") {
        // A crash between the delivery update and the cursor advance leaves
        // the row settled ahead of the cursor; resume past it without a
        // second POST.
        this.#storage.advanceCursor(subscription.subscriptionId, event.rowid);
        continue;
      }
      const attemptedAt = this.#now();
      if (existing !== null && existing.nextAttemptAt !== null && Date.parse(existing.nextAttemptAt) > Date.parse(attemptedAt)) {
        return;
      }
      const delivery = existing ?? this.#storage.createDelivery({
        deliveryId: this.#newDeliveryId(),
        subscriptionId: subscription.subscriptionId,
        eventRowid: event.rowid,
        action: event.action,
        dumpId: event.dumpId,
        createdAt: attemptedAt,
      });
      const outcome = await this.#attempt(subscription, event, delivery, attemptedAt);
      if (outcome === "retry") return;
    }
  }

  async #attempt(
    subscription: WebhookSubscriptionRecord,
    event: AuditFeedEntry,
    delivery: WebhookDeliveryRecord,
    attemptedAt: string,
  ): Promise<AttemptOutcome> {
    const body = JSON.stringify(eventPayloadOf(event));
    const signature = createHmac("sha256", subscription.secret).update(body, "utf8").digest("hex");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(subscription.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "DumpLedger-Webhook/1",
          "X-DumpLedger-Event": event.action,
          "X-DumpLedger-Delivery": delivery.deliveryId,
          "X-DumpLedger-Delivered-At": attemptedAt,
          "X-DumpLedger-Signature-256": `sha256=${signature}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      return this.#scheduleFailure(subscription, event, delivery, {
        statusCode: null,
        error: controller.signal.aborted ? `timeout after ${this.#timeoutMs}ms` : failureMessageOf(error),
      });
    } finally {
      clearTimeout(timeout);
    }
    if (response.body !== null) {
      // Only the status matters; releasing the body frees the connection.
      await response.body.cancel().catch(() => {});
    }
    if (response.status >= 200 && response.status < 300) {
      this.#storage.markDelivered(delivery.deliveryId, response.status, attemptedAt);
      this.#storage.advanceCursor(subscription.subscriptionId, event.rowid);
      this.#delivered += 1;
      return "delivered";
    }
    return this.#scheduleFailure(subscription, event, delivery, {
      statusCode: response.status,
      error: `HTTP ${response.status}`,
    });
  }

  /** Records a failed attempt: exhaustion advances the cursor past the event
   * (the feed remains the truth), any other failure schedules the exponential
   * backoff and blocks the subscription's page. Applied even after `close()`
   * because the attempt already reached the receiver and storage is durable. */
  #scheduleFailure(
    subscription: WebhookSubscriptionRecord,
    event: AuditFeedEntry,
    delivery: WebhookDeliveryRecord,
    failure: WebhookDeliveryFailure,
  ): AttemptOutcome {
    const attempts = delivery.attempts + 1;
    const failedAt = this.#now();
    if (attempts >= this.#maxAttempts) {
      this.#storage.markExhausted(delivery.deliveryId, attempts, failure, failedAt);
      this.#storage.advanceCursor(subscription.subscriptionId, event.rowid);
      this.#exhausted += 1;
      return "exhausted";
    }
    const delayMs = this.#retryBaseMs * 5 ** (attempts - 1);
    this.#storage.markRetryScheduled(
      delivery.deliveryId,
      attempts,
      failure,
      new Date(Date.parse(failedAt) + delayMs).toISOString(),
    );
    this.#retries += 1;
    return "retry";
  }
}
