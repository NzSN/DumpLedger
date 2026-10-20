import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { parseAuditEventId, parseCaseId, parseCustomerId, parseDumpId, type CaseId } from "../../src/domain/ids.js";
import type { AuditFeedFilter, AuditFeedPage } from "../../src/engine/dump-ledger-engine.js";
import type { AuditFeedEntry } from "../../src/ledger/sqlite-ledger.js";
import { WebhookDispatcher, type WebhookEventSource } from "../../src/webhooks/dispatcher.js";
import type {
  CreateWebhookDeliveryInput,
  CreateWebhookSubscriptionInput,
  WebhookDeliveryFailure,
  WebhookDeliveryRecord,
  WebhookStorage,
  WebhookSubscriptionRecord,
} from "../../src/webhooks/storage.js";

/**
 * Dispatcher coverage for webhook notifications (docs/webhook-notifications-design.md,
 * "Delivery semantics" and "Wire format"): ordering, head-of-line blocking,
 * backoff dues, exhaustion, timeouts, the signed feed-shaped POST, and
 * close() quiescence, all driven through injected source/storage/fetch/time.
 */

const NOW = "2026-10-20T00:00:00.000Z";
const SECRET = "whsec_test_secret";
const SUBSCRIPTION_ID = "webhook_00000000000000000000000001";
const CASE_A = parseCaseId(`case_${"0".repeat(25)}1`);
const CASE_B = parseCaseId(`case_${"0".repeat(25)}2`);

type TimerHandle = unknown;

interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

class FakeStorage implements WebhookStorage {
  readonly #subscriptions: WebhookSubscriptionRecord[] = [];
  readonly #deliveries = new Map<string, WebhookDeliveryRecord>();

  seedSubscription(record: WebhookSubscriptionRecord): void {
    this.#subscriptions.push(record);
  }

  delivery(subscriptionId: string, eventRowid: number): WebhookDeliveryRecord | null {
    return this.#deliveries.get(keyOf(subscriptionId, eventRowid)) ?? null;
  }

  createSubscription(input: CreateWebhookSubscriptionInput): WebhookSubscriptionRecord {
    const record: WebhookSubscriptionRecord = { ...input };
    this.#subscriptions.push(record);
    return record;
  }

  listSubscriptions(): readonly WebhookSubscriptionRecord[] {
    return [...this.#subscriptions];
  }

  findSubscription(subscriptionId: string): WebhookSubscriptionRecord | null {
    return this.#subscriptions.find(record => record.subscriptionId === subscriptionId) ?? null;
  }

  deleteSubscription(subscriptionId: string): boolean {
    const index = this.#subscriptions.findIndex(record => record.subscriptionId === subscriptionId);
    if (index < 0) return false;
    this.#subscriptions.splice(index, 1);
    return true;
  }

  listDeliveries(subscriptionId: string, limit: number): readonly WebhookDeliveryRecord[] {
    return [...this.#deliveries.values()].filter(record => record.subscriptionId === subscriptionId).slice(0, limit);
  }

  findDelivery(subscriptionId: string, eventRowid: number): WebhookDeliveryRecord | null {
    return this.delivery(subscriptionId, eventRowid);
  }

  createDelivery(input: CreateWebhookDeliveryInput): WebhookDeliveryRecord {
    const record: WebhookDeliveryRecord = {
      deliveryId: input.deliveryId,
      subscriptionId: input.subscriptionId,
      eventRowid: input.eventRowid,
      action: input.action,
      dumpId: input.dumpId,
      status: "pending",
      attempts: 0,
      lastStatusCode: null,
      lastError: null,
      nextAttemptAt: null,
      deliveredAt: null,
      createdAt: input.createdAt,
    };
    this.#deliveries.set(keyOf(input.subscriptionId, input.eventRowid), record);
    return record;
  }

  markDelivered(deliveryId: string, statusCode: number, deliveredAt: string): void {
    const record = this.#byId(deliveryId);
    this.#set({ ...record, status: "delivered", lastStatusCode: statusCode, lastError: null, nextAttemptAt: null, deliveredAt });
  }

  markRetryScheduled(deliveryId: string, attempts: number, failure: WebhookDeliveryFailure, nextAttemptAt: string): void {
    const record = this.#byId(deliveryId);
    this.#set({
      ...record,
      status: "pending",
      attempts,
      lastStatusCode: failure.statusCode,
      lastError: failure.error,
      nextAttemptAt,
      deliveredAt: null,
    });
  }

  markExhausted(deliveryId: string, attempts: number, failure: WebhookDeliveryFailure, _now: string): void {
    const record = this.#byId(deliveryId);
    this.#set({
      ...record,
      status: "exhausted",
      attempts,
      lastStatusCode: failure.statusCode,
      lastError: failure.error,
      nextAttemptAt: null,
      deliveredAt: null,
    });
  }

  advanceCursor(subscriptionId: string, eventRowid: number): void {
    const index = this.#subscriptions.findIndex(record => record.subscriptionId === subscriptionId);
    const record = this.#subscriptions[index];
    assert.ok(record !== undefined);
    if (eventRowid > record.cursorRowid) this.#subscriptions[index] = { ...record, cursorRowid: eventRowid };
  }

  auditLiveEdge(): number {
    return 0;
  }

  #byId(deliveryId: string): WebhookDeliveryRecord {
    const record = [...this.#deliveries.values()].find(candidate => candidate.deliveryId === deliveryId);
    assert.ok(record !== undefined, `unknown delivery ${deliveryId}`);
    return record;
  }

  #set(record: WebhookDeliveryRecord): void {
    this.#deliveries.set(keyOf(record.subscriptionId, record.eventRowid), record);
  }
}

function keyOf(subscriptionId: string, eventRowid: number): string {
  return `${subscriptionId}:${eventRowid}`;
}

class FakeSource implements WebhookEventSource {
  readonly events: readonly AuditFeedEntry[];
  readonly calls: Array<{ readonly afterRowid: number | undefined; readonly filter: AuditFeedFilter | undefined; readonly limit: number | undefined }> = [];

  constructor(events: readonly AuditFeedEntry[]) {
    this.events = events;
  }

  readAuditEvents(afterRowid?: number, filter?: AuditFeedFilter, limit?: number): AuditFeedPage {
    this.calls.push({ afterRowid, filter, limit });
    const after = afterRowid ?? 0;
    const actions = filter?.actions;
    const caseId = filter?.caseId;
    const events = this.events
      .filter(event => event.rowid > after)
      .filter(event => actions === undefined || actions.includes(event.action))
      .filter(event => caseId === undefined || event.caseId === caseId)
      .slice(0, limit ?? 500);
    const last = events[events.length - 1];
    return { events, lastRowid: last === undefined ? after : last.rowid };
  }
}

interface ManualScheduler {
  readonly callbacks: Array<() => void>;
  readonly delays: number[];
  readonly schedule: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancel: (handle: TimerHandle) => void;
  readonly cancelCount: () => number;
}

function manualScheduler(): ManualScheduler {
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  let cancelled = 0;
  return {
    callbacks,
    delays,
    schedule: (callback, delayMs) => {
      callbacks.push(callback);
      delays.push(delayMs);
      return callback;
    },
    cancel: () => {
      cancelled += 1;
    },
    cancelCount: () => cancelled,
  };
}

function feedEvent(rowid: number, overrides: Partial<AuditFeedEntry> = {}): AuditFeedEntry {
  const padded = rowid.toString(10).padStart(26, "0");
  return {
    rowid,
    eventId: parseAuditEventId(`audit_${padded}`),
    occurredAt: NOW,
    action: "AcceptDump",
    customerId: parseCustomerId(`customer_${"0".repeat(25)}1`),
    caseId: CASE_A,
    dumpId: parseDumpId(`dump_${padded}`),
    detail: {},
    ...overrides,
  };
}

function subscription(overrides: Partial<WebhookSubscriptionRecord> = {}): WebhookSubscriptionRecord {
  return {
    subscriptionId: SUBSCRIPTION_ID,
    url: "https://analyzer.example.test/hook",
    secret: SECRET,
    actions: null,
    caseId: null,
    cursorRowid: 0,
    createdAt: NOW,
    ...overrides,
  };
}

function recorder(responses: readonly (number | "abort")[]): { readonly requests: RecordedRequest[]; readonly fetchImpl: typeof fetch } {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    const response = responses[index];
    index += 1;
    if (response === undefined) throw new Error("unexpected fetch");
    if (response === "abort") {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal instanceof AbortSignal) {
          signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
        }
      });
    }
    return new Response(null, { status: response });
  };
  return { requests, fetchImpl };
}

function bodyOf(request: RecordedRequest): Record<string, unknown> {
  const body = request.init.body;
  if (typeof body !== "string") throw new Error("expected a string request body");
  return JSON.parse(body) as Record<string, unknown>;
}

function headerOf(request: RecordedRequest, name: string): string | null {
  return new Headers(request.init.headers).get(name);
}

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

async function runScheduledTick(scheduler: ManualScheduler): Promise<void> {
  const callback = scheduler.callbacks.shift();
  assert.ok(callback !== undefined, "expected a scheduled tick");
  callback();
  await flush();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe("webhook dispatcher", () => {
  it("posts the signed feed-shaped event in rowid order and advances the cursor", async () => {
    const storage = new FakeStorage();
    storage.seedSubscription(subscription());
    const first = feedEvent(1);
    const second = feedEvent(2, {
      action: "SealUpload",
      caseId: CASE_B,
      detail: { phase: "sealed" },
    });
    const source = new FakeSource([first, second]);
    const scheduler = manualScheduler();
    const { requests, fetchImpl } = recorder([200, 204]);
    let deliverySequence = 0;
    const dispatcher = new WebhookDispatcher({
      source,
      storage,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      fetch: fetchImpl,
      now: () => NOW,
      newDeliveryId: () => `whd_test_${++deliverySequence}`,
    });

    dispatcher.start();
    await runScheduledTick(scheduler);

    assert.deepEqual(source.calls, [{ afterRowid: 0, filter: {}, limit: 500 }]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.url, "https://analyzer.example.test/hook");
    assert.equal(requests[0]?.init.method, "POST");
    assert.ok(requests[0]?.init.signal instanceof AbortSignal);

    const firstBody = bodyOf(requests[0]!);
    assert.deepEqual(firstBody, {
      cursor: "0000000000000001",
      eventId: "audit_00000000000000000000000001",
      occurredAt: NOW,
      action: "AcceptDump",
      customerId: `customer_${"0".repeat(25)}1`,
      caseId: `case_${"0".repeat(25)}1`,
      dumpId: `dump_${"0".repeat(25)}1`,
      detail: {},
    });
    const knownSignature = createHmac("sha256", SECRET).update(JSON.stringify(firstBody), "utf8").digest("hex");
    assert.equal(knownSignature, "d0fa8b263e6bb662fb8ece07174c73ed1a0ec8b3ad9091d3c203d9283be02ee6");
    assert.equal(headerOf(requests[0]!, "x-dumpledger-signature-256"), `sha256=${knownSignature}`);
    assert.equal(headerOf(requests[0]!, "x-dumpledger-event"), "AcceptDump");
    assert.equal(headerOf(requests[0]!, "x-dumpledger-delivery"), "whd_test_1");
    assert.equal(headerOf(requests[0]!, "x-dumpledger-delivered-at"), NOW);
    assert.equal(headerOf(requests[0]!, "user-agent"), "DumpLedger-Webhook/1");
    assert.equal(headerOf(requests[0]!, "content-type"), "application/json");

    assert.equal(bodyOf(requests[1]!).cursor, "0000000000000002");
    assert.equal(bodyOf(requests[1]!).action, "SealUpload");
    assert.equal(headerOf(requests[1]!, "x-dumpledger-delivery"), "whd_test_2");

    assert.equal(storage.findSubscription(SUBSCRIPTION_ID)?.cursorRowid, 2);
    assert.deepEqual(storage.delivery(SUBSCRIPTION_ID, 1)?.status, "delivered");
    assert.deepEqual(storage.delivery(SUBSCRIPTION_ID, 1)?.lastStatusCode, 200);
    assert.deepEqual(storage.delivery(SUBSCRIPTION_ID, 1)?.deliveredAt, NOW);
    assert.deepEqual(storage.delivery(SUBSCRIPTION_ID, 2)?.status, "delivered");
    assert.deepEqual(storage.delivery(SUBSCRIPTION_ID, 2)?.lastStatusCode, 204);
    assert.deepEqual(dispatcher.snapshot(), { delivered: 2, exhausted: 0, retries: 0 });
    dispatcher.close();
  });

  it("walks subscriptions in creation order with each subscription's filter", async () => {
    const storage = new FakeStorage();
    storage.seedSubscription(subscription({ subscriptionId: "webhook_1", actions: ["AcceptDump"] }));
    storage.seedSubscription(subscription({ subscriptionId: "webhook_2", caseId: CASE_B, createdAt: "2026-10-20T00:00:01.000Z" }));
    const source = new FakeSource([
      feedEvent(1, { action: "AcceptDump", caseId: CASE_A }),
      feedEvent(2, { action: "SealUpload", caseId: CASE_B }),
      feedEvent(3, { action: "AcceptDump", caseId: CASE_B }),
    ]);
    const scheduler = manualScheduler();
    const { requests, fetchImpl } = recorder([200, 200, 200, 200]);
    const dispatcher = new WebhookDispatcher({
      source,
      storage,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      fetch: fetchImpl,
      now: () => NOW,
      newDeliveryId: () => `whd_${requests.length + 1}`,
    });

    dispatcher.start();
    await runScheduledTick(scheduler);

    assert.equal(source.calls.length, 2);
    assert.deepEqual(source.calls[0]?.filter, { actions: ["AcceptDump"] });
    assert.deepEqual(source.calls[1]?.filter, { caseId: CASE_B });
    assert.deepEqual(requests.map(request => bodyOf(request).cursor), [
      "0000000000000001",
      "0000000000000003",
      "0000000000000002",
      "0000000000000003",
    ]);
    assert.equal(storage.findSubscription("webhook_1")?.cursorRowid, 3);
    assert.equal(storage.findSubscription("webhook_2")?.cursorRowid, 3);
    assert.deepEqual(dispatcher.snapshot(), { delivered: 4, exhausted: 0, retries: 0 });
    dispatcher.close();
  });

  it("keeps other subscriptions moving when one subscription's page is blocked", async () => {
    const storage = new FakeStorage();
    storage.seedSubscription(subscription({ subscriptionId: "webhook_1" }));
    storage.seedSubscription(subscription({ subscriptionId: "webhook_2", createdAt: "2026-10-20T00:00:01.000Z" }));
    const source = new FakeSource([feedEvent(1)]);
    const scheduler = manualScheduler();
    const { requests, fetchImpl } = recorder([500, 200]);
    let sequence = 0;
    const dispatcher = new WebhookDispatcher({
      source,
      storage,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      fetch: fetchImpl,
      now: () => NOW,
      newDeliveryId: () => `whd_${++sequence}`,
    });

    dispatcher.start();
    await runScheduledTick(scheduler);

    assert.equal(requests.length, 2);
    assert.equal(storage.delivery("webhook_1", 1)?.status, "pending");
    assert.equal(storage.findSubscription("webhook_1")?.cursorRowid, 0);
    assert.equal(storage.delivery("webhook_2", 1)?.status, "delivered");
    assert.equal(storage.findSubscription("webhook_2")?.cursorRowid, 1);
    assert.deepEqual(dispatcher.snapshot(), { delivered: 1, exhausted: 0, retries: 1 });
    dispatcher.close();
  });

  it("blocks the page on a retry and skips until nextAttemptAt is due", async () => {
    const storage = new FakeStorage();
    storage.seedSubscription(subscription());
    const source = new FakeSource([feedEvent(1), feedEvent(2)]);
    const scheduler = manualScheduler();
    const { requests, fetchImpl } = recorder([500, 200, 200]);
    let epoch = Date.parse(NOW);
    const dispatcher = new WebhookDispatcher({
      source,
      storage,
      retryBaseMs: 10_000,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      fetch: fetchImpl,
      now: () => new Date(epoch).toISOString(),
      newDeliveryId: () => `whd_${requests.length + 1}`,
    });

    dispatcher.start();
    await runScheduledTick(scheduler);

    const failed = storage.delivery(SUBSCRIPTION_ID, 1);
    assert.equal(failed?.deliveryId, "whd_1");
    assert.equal(failed?.status, "pending");
    assert.equal(failed?.attempts, 1);
    assert.equal(failed?.lastStatusCode, 500);
    assert.equal(failed?.lastError, "HTTP 500");
    assert.equal(failed?.nextAttemptAt, "2026-10-20T00:00:10.000Z");
    assert.equal(storage.delivery(SUBSCRIPTION_ID, 2), null);
    assert.equal(storage.findSubscription(SUBSCRIPTION_ID)?.cursorRowid, 0);
    assert.deepEqual(dispatcher.snapshot(), { delivered: 0, exhausted: 0, retries: 1 });
    assert.equal(requests.length, 1);

    epoch += 5_000;
    await runScheduledTick(scheduler);
    assert.equal(requests.length, 1, "a pending delivery before its due time is not retried");
    assert.equal(storage.findSubscription(SUBSCRIPTION_ID)?.cursorRowid, 0);

    epoch += 5_000;
    await runScheduledTick(scheduler);
    assert.deepEqual(requests.map(request => bodyOf(request).cursor), [
      "0000000000000001",
      "0000000000000001",
      "0000000000000002",
    ]);
    assert.equal(storage.findSubscription(SUBSCRIPTION_ID)?.cursorRowid, 2);
    assert.equal(storage.delivery(SUBSCRIPTION_ID, 1)?.status, "delivered");
    assert.equal(storage.delivery(SUBSCRIPTION_ID, 1)?.attempts, 1);
    assert.equal(storage.delivery(SUBSCRIPTION_ID, 1)?.deliveryId, "whd_1", "the retry reuses its delivery row");
    assert.deepEqual(dispatcher.snapshot(), { delivered: 2, exhausted: 0, retries: 1 });
    dispatcher.close();
  });

  it("exhausts after maxAttempts, advances past the event, and continues the page", async () => {
    const storage = new FakeStorage();
    storage.seedSubscription(subscription());
    const source = new FakeSource([feedEvent(1), feedEvent(2)]);
    const scheduler = manualScheduler();
    const { requests, fetchImpl } = recorder([503, 503, 503, 503]);
    let epoch = Date.parse(NOW);
    const dispatcher = new WebhookDispatcher({
      source,
      storage,
      retryBaseMs: 100,
      maxAttempts: 2,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      fetch: fetchImpl,
      now: () => new Date(epoch).toISOString(),
      newDeliveryId: () => `whd_${requests.length + 1}`,
    });

    dispatcher.start();
    await runScheduledTick(scheduler);
    assert.equal(storage.delivery(SUBSCRIPTION_ID, 1)?.attempts, 1);
    assert.equal(storage.findSubscription(SUBSCRIPTION_ID)?.cursorRowid, 0);

    epoch += 100;
    await runScheduledTick(scheduler);

    const exhausted = storage.delivery(SUBSCRIPTION_ID, 1);
    assert.equal(exhausted?.status, "exhausted");
    assert.equal(exhausted?.attempts, 2);
    assert.equal(exhausted?.lastStatusCode, 503);
    assert.equal(exhausted?.lastError, "HTTP 503");
    assert.equal(exhausted?.nextAttemptAt, null);
    assert.equal(storage.findSubscription(SUBSCRIPTION_ID)?.cursorRowid, 1);
    assert.equal(storage.delivery(SUBSCRIPTION_ID, 2)?.status, "pending");
    assert.equal(storage.delivery(SUBSCRIPTION_ID, 2)?.attempts, 1);
    assert.deepEqual(dispatcher.snapshot(), { delivered: 0, exhausted: 1, retries: 2 });

    epoch += 100;
    await runScheduledTick(scheduler);
    assert.equal(storage.delivery(SUBSCRIPTION_ID, 2)?.status, "exhausted");
    assert.equal(storage.findSubscription(SUBSCRIPTION_ID)?.cursorRowid, 2);
    assert.deepEqual(dispatcher.snapshot(), { delivered: 0, exhausted: 2, retries: 2 });
    assert.equal(requests.length, 4);
    dispatcher.close();
  });

  it("treats a per-attempt timeout as a retryable failure", async () => {
    const storage = new FakeStorage();
    storage.seedSubscription(subscription());
    const source = new FakeSource([feedEvent(1)]);
    const scheduler = manualScheduler();
    const { requests, fetchImpl } = recorder(["abort"]);
    const dispatcher = new WebhookDispatcher({
      source,
      storage,
      timeoutMs: 10,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      fetch: fetchImpl,
      now: () => NOW,
      newDeliveryId: () => "whd_timeout",
    });

    dispatcher.start();
    const callback = scheduler.callbacks.shift();
    assert.ok(callback !== undefined);
    callback();
    await sleep(100);

    const delivery = storage.delivery(SUBSCRIPTION_ID, 1);
    assert.equal(requests.length, 1);
    assert.equal(delivery?.status, "pending");
    assert.equal(delivery?.attempts, 1);
    assert.equal(delivery?.lastStatusCode, null);
    assert.equal(delivery?.lastError, "timeout after 10ms");
    assert.equal(delivery?.nextAttemptAt, "2026-10-20T00:00:10.000Z");
    assert.equal(storage.findSubscription(SUBSCRIPTION_ID)?.cursorRowid, 0);
    assert.deepEqual(dispatcher.snapshot(), { delivered: 0, exhausted: 0, retries: 1 });
    dispatcher.close();
  });

  it("skips a settled delivery row left ahead of the cursor by a crash", async () => {
    const storage = new FakeStorage();
    storage.seedSubscription(subscription());
    storage.createDelivery({
      deliveryId: "whd_recovered",
      subscriptionId: SUBSCRIPTION_ID,
      eventRowid: 1,
      action: "AcceptDump",
      dumpId: null,
      createdAt: NOW,
    });
    storage.markDelivered("whd_recovered", 200, NOW);
    const source = new FakeSource([feedEvent(1), feedEvent(2)]);
    const scheduler = manualScheduler();
    const { requests, fetchImpl } = recorder([200]);
    const dispatcher = new WebhookDispatcher({
      source,
      storage,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      fetch: fetchImpl,
      now: () => NOW,
      newDeliveryId: () => "whd_next",
    });

    dispatcher.start();
    await runScheduledTick(scheduler);

    assert.equal(requests.length, 1);
    assert.equal(bodyOf(requests[0]!).cursor, "0000000000000002");
    assert.equal(storage.delivery(SUBSCRIPTION_ID, 1)?.deliveryId, "whd_recovered");
    assert.equal(storage.delivery(SUBSCRIPTION_ID, 1)?.status, "delivered");
    assert.equal(storage.findSubscription(SUBSCRIPTION_ID)?.cursorRowid, 2);
    assert.deepEqual(dispatcher.snapshot(), { delivered: 1, exhausted: 0, retries: 0 });
    dispatcher.close();
  });

  it("does not overlap ticks when a scheduled callback fires twice", async () => {
    const storage = new FakeStorage();
    storage.seedSubscription(subscription());
    const source = new FakeSource([feedEvent(1)]);
    const scheduler = manualScheduler();
    let fetchCount = 0;
    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const fetchImpl: typeof fetch = async () => {
      fetchCount += 1;
      markStarted?.();
      await gate;
      return new Response(null, { status: 200 });
    };
    const dispatcher = new WebhookDispatcher({
      source,
      storage,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      fetch: fetchImpl,
      now: () => NOW,
      newDeliveryId: () => "whd_overlap",
    });

    dispatcher.start();
    const callback = scheduler.callbacks.shift();
    assert.ok(callback !== undefined);
    callback();
    await started;
    callback();
    await flush();
    assert.equal(fetchCount, 1, "the second trigger is a no-op while a tick is in flight");

    release?.();
    await flush();
    assert.equal(storage.delivery(SUBSCRIPTION_ID, 1)?.status, "delivered");
    assert.equal(scheduler.callbacks.length, 1, "only the in-flight tick schedules the next one");
    assert.deepEqual(dispatcher.snapshot(), { delivered: 1, exhausted: 0, retries: 0 });
    dispatcher.close();
  });

  it("stops ticking after close but applies an in-flight attempt's result", async () => {
    const storage = new FakeStorage();
    storage.seedSubscription(subscription());
    const source = new FakeSource([feedEvent(1), feedEvent(2)]);
    const scheduler = manualScheduler();
    let resolveFetch: ((response: Response) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const fetchImpl: typeof fetch = async () => {
      markStarted?.();
      return await new Promise<Response>(resolve => {
        resolveFetch = resolve;
      });
    };
    const dispatcher = new WebhookDispatcher({
      source,
      storage,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      fetch: fetchImpl,
      now: () => NOW,
      newDeliveryId: () => "whd_inflight",
    });

    dispatcher.start();
    dispatcher.start();
    assert.equal(scheduler.callbacks.length, 1, "start() schedules exactly once");
    const callback = scheduler.callbacks.shift();
    assert.ok(callback !== undefined);
    callback();
    await started;

    dispatcher.close();
    assert.equal(scheduler.cancelCount(), 0, "an in-flight tick has no timer left to cancel");
    resolveFetch?.(new Response(null, { status: 200 }));
    await flush();

    assert.equal(storage.delivery(SUBSCRIPTION_ID, 1)?.status, "delivered");
    assert.equal(storage.findSubscription(SUBSCRIPTION_ID)?.cursorRowid, 1);
    assert.equal(storage.delivery(SUBSCRIPTION_ID, 2), null, "no attempt starts after close");
    assert.equal(scheduler.callbacks.length, 0, "close() does not reschedule");
    assert.deepEqual(dispatcher.snapshot(), { delivered: 1, exhausted: 0, retries: 0 });

    // A callback cancelled by close() must still be a no-op if a timer race fires it.
    const stale = manualScheduler();
    const staleDispatcher = new WebhookDispatcher({ source, storage, schedule: stale.schedule, cancel: stale.cancel, fetch: fetchImpl });
    staleDispatcher.start();
    const staleCallback = stale.callbacks.shift();
    assert.ok(staleCallback !== undefined);
    staleDispatcher.close();
    assert.equal(stale.cancelCount(), 1);
    staleCallback();
    await flush();
    assert.equal(stale.callbacks.length, 0);
  });
});
