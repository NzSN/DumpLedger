/**
 * End-to-end webhook delivery (docs/webhook-notifications-design.md, "Delivery
 * semantics" and "Wire format"; milestone WH1): a real engine, the real
 * management route, a real tick-driven dispatcher, and a real loopback
 * `node:http` receiver. Intake truth changes only through the `AcceptDump`
 * engine command; the receiver asserts exactly one signed, feed-shaped POST.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { test } from "node:test";

import {
  CSRF_HEADER,
  decodeCreateWebhookResponse,
  decodeEventFeedEntry,
  decodeSessionResponse,
} from "@dump-ledger/http-contracts";
import { OperatorSessions, hashOperatorPassword } from "../../src/auth/sessions.js";
import { createDumpLedgerEngine, DeterministicClock, DeterministicEntropy, DeterministicIds } from "../../src/engine/dump-ledger-engine.js";
import { EngineHttpApplication } from "../../src/http/application.js";
import { buildHttpServer } from "../../src/http/server.js";
import { EngineUploadLifecycle, EngineUploadPostProcessor, VaultUploadSink } from "../../src/intake/intake-facade.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";
import { WebhookDispatcher } from "../../src/webhooks/dispatcher.js";
import { createQuarantined } from "./support.js";

const FIXED_NOW = "2026-09-04T00:00:00.000Z";

function deterministicSecrets(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${"w".repeat(40)}${index.toString(36).padStart(4, "0")}`);
}

function cursorFor(rowid: number): string {
  return rowid.toString(10).padStart(16, "0");
}

interface ReceivedRequest {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface Receiver {
  readonly url: string;
  readonly received: ReceivedRequest[];
  close(): Promise<void>;
}

/** Real loopback receiver: records one entry per POST and answers 204 (2xx). */
async function startReceiver(): Promise<Receiver> {
  const received: ReceivedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(204).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/webhook`,
    received,
    close: async () => {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("AcceptDump produces exactly one signed feed-shaped webhook", async t => {
  const receiver = await startReceiver();
  const vault = new MemoryVault();
  const engine = createDumpLedgerEngine({
    databasePath: ":memory:",
    vault,
    // The seeded bytes are not a real minidump; an accepting inspection stub
    // lets the lifecycle reach AcceptDump exactly like the engine fixtures.
    inspection: { inspect: () => ({ ok: true, coverage: "partial", facts: {} }) },
    grantSecretKey: Buffer.alloc(32, 0x71),
    clock: new DeterministicClock(FIXED_NOW),
    entropy: new DeterministicEntropy(deterministicSecrets(16)),
    ids: new DeterministicIds(),
  });
  // Seed a quarantined dump through engine commands; AcceptDump (the event
  // under test) is the next audit row after the subscription's live edge.
  const dumpId = createQuarantined(engine, vault);

  const sessions = new OperatorSessions({
    passwordHash: await hashOperatorPassword("local-password"),
    secureCookies: false,
  });
  const server = buildHttpServer({
    application: new EngineHttpApplication(engine, vault),
    sessions,
    uploadLifecycle: new EngineUploadLifecycle(engine),
    uploadSink: new VaultUploadSink(vault),
    uploadPostProcessor: new EngineUploadPostProcessor(engine),
    now: () => Date.parse(FIXED_NOW),
  });
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/session",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ password: "local-password" }),
  });
  assert.equal(login.statusCode, 200);
  const session = decodeSessionResponse(login.json(), "$");
  assert.ok(session.csrfToken !== undefined);
  const cookie = (login.headers["set-cookie"] as string).split(";")[0]!;

  // Register through the real management route so the secret the receiver
  // verifies is exactly the one the API returned at creation time.
  const created = await server.inject({
    method: "POST",
    url: "/api/v1/webhooks",
    headers: { cookie, [CSRF_HEADER]: session.csrfToken, "content-type": "application/json" },
    payload: JSON.stringify({ url: receiver.url, actions: ["AcceptDump"] }),
  });
  assert.equal(created.statusCode, 201);
  const creation = decodeCreateWebhookResponse(created.json(), "$");
  const subscriptionId = creation.subscription.id;
  const secret = creation.secret;

  const dispatcher = new WebhookDispatcher({
    source: engine,
    storage: engine.webhookStorage(),
    tickMs: 5,
    timeoutMs: 2_000,
    retryBaseMs: 10,
    maxAttempts: 2,
  });
  t.after(async () => {
    dispatcher.close();
    await receiver.close();
    await server.close();
    engine.close();
  });

  dispatcher.start();
  const accepted = engine.execute({ type: "AcceptDump", dumpId });
  assert.ok(accepted.ok);

  await waitFor(() => receiver.received.length > 0, "the AcceptDump webhook");
  // Give further ticks a chance to duplicate before asserting exactly one.
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(receiver.received.length, 1);

  const request = receiver.received[0]!;
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.headers["user-agent"], "DumpLedger-Webhook/1");
  assert.equal(request.headers["x-dumpledger-event"], "AcceptDump");
  assert.match(String(request.headers["x-dumpledger-delivery"]), /^whd_[A-Za-z0-9_-]{22}$/);
  const deliveredAt = String(request.headers["x-dumpledger-delivered-at"]);
  assert.equal(deliveredAt, new Date(Date.parse(deliveredAt)).toISOString());

  const expectedSignature = createHmac("sha256", secret).update(request.body, "utf8").digest("hex");
  assert.equal(request.headers["x-dumpledger-signature-256"], `sha256=${expectedSignature}`);

  // Body is exactly the feed Event object, not a webhook-specific envelope.
  const entry = decodeEventFeedEntry(JSON.parse(request.body), "$");
  const feedPage = engine.readAuditEvents(Number(creation.subscription.cursor), { actions: ["AcceptDump"] }, 10);
  assert.equal(feedPage.events.length, 1);
  const expected = feedPage.events[0]!;
  assert.deepEqual(entry, {
    cursor: cursorFor(expected.rowid),
    eventId: expected.eventId,
    occurredAt: expected.occurredAt,
    action: expected.action,
    customerId: expected.customerId,
    caseId: expected.caseId,
    dumpId: expected.dumpId,
    detail: expected.detail,
  });
  assert.equal(entry.action, "AcceptDump");
  assert.equal(entry.dumpId, dumpId);
  assert.ok(entry.dumpId !== null);

  const storage = engine.webhookStorage();
  const delivery = storage.findDelivery(subscriptionId, expected.rowid);
  assert.equal(delivery?.status, "delivered");
  assert.equal(delivery?.attempts, 0);
  assert.equal(delivery?.lastStatusCode, 204);
  assert.equal(delivery?.dumpId, dumpId);
  assert.equal(storage.findSubscription(subscriptionId)?.cursorRowid, expected.rowid);
  assert.deepEqual(dispatcher.snapshot(), { delivered: 1, exhausted: 0, retries: 0 });
});
