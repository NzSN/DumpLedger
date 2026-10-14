import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  parseAuditEventId,
  parseCaseId,
  parseCustomerId,
  parseDumpId,
  parseGrantId,
  type AuditEventId,
  type CaseId,
  type CustomerId,
  type DumpId,
  type GrantId,
} from "../../src/domain/ids.js";
import { MAX_AUDIT_FEED_PAGE, SqliteLedger, type AuditFeedEntry } from "../../src/ledger/sqlite-ledger.js";

/**
 * Integration coverage for the ledger half of the audit event feed
 * (docs/analyzer-integration-design.md, "Event feed"): the `rowid` cursor
 * read over rows produced only by engine commands, the action and case
 * filters, cursor paging with engine writes interleaved between fetches, and
 * the empty-ledger / beyond-end cursor echo. Runs against a real SQLite
 * ledger in a temp directory, mirroring the catalog integration tests.
 */

const BASE = "2026-09-01T00:00:00.000Z";
const EXPIRY = "2027-01-01T00:00:00.000Z";

const body = (value: number): string => value.toString(10).padStart(26, "0");
const customerId = (value: number): CustomerId => parseCustomerId(`customer_${body(value)}`);
const caseId = (value: number): CaseId => parseCaseId(`case_${body(value)}`);
const grantId = (value: number): GrantId => parseGrantId(`grant_${body(value)}`);
const dumpId = (value: number): DumpId => parseDumpId(`dump_${body(value)}`);
const shaFor = (value: number): string => value.toString(16).padStart(64, "0");
const at = (seconds: number): string => new Date(Date.parse(BASE) + seconds * 1000).toISOString();

let eventCounter = 0;
function event(at: string): { readonly eventId: AuditEventId; readonly occurredAt: string } {
  eventCounter += 1;
  return { eventId: parseAuditEventId(`audit_${body(eventCounter)}`), occurredAt: at };
}

/** The audit row one engine command must append, as this test expects it. */
interface ExpectedAuditEvent {
  readonly eventId: AuditEventId;
  readonly occurredAt: string;
  readonly action: string;
  readonly customerId: CustomerId | null;
  readonly caseId: CaseId | null;
  readonly dumpId: DumpId | null;
  readonly detail: Record<string, unknown>;
}

function model(entry: AuditFeedEntry): ExpectedAuditEvent {
  return { eventId: entry.eventId, occurredAt: entry.occurredAt, action: entry.action, customerId: entry.customerId, caseId: entry.caseId, dumpId: entry.dumpId, detail: entry.detail };
}

function withLedger(run: (ledger: SqliteLedger) => void, prefix: string): void {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    const ledger = new SqliteLedger(join(root, "ledger.sqlite"));
    try {
      run(ledger);
    } finally {
      ledger.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface Seeded {
  readonly customer1: CustomerId;
  readonly case1: CaseId;
  readonly case2: CaseId;
  /** The audit rows the engine commands must append, in trail order; tests
   * append any interleaved writes so the model stays the full expected trail. */
  readonly expected: ExpectedAuditEvent[];
}

/**
 * Seeds a ledger through engine commands only — a customer, two cases, grant
 * issuance/revocation/expiry, the dump lifecycle on case1 (accepted +
 * authorized + retention set, then a rejected dump purged) and case2 (an
 * interrupted transfer), and the case workflow on case2 through to closed —
 * recording every audit row each command must append, in order.
 */
function seed(ledger: SqliteLedger): Seeded {
  const expected: ExpectedAuditEvent[] = [];
  const record = (identity: { readonly eventId: AuditEventId; readonly occurredAt: string }, action: string, customerId: CustomerId | null, caseId: CaseId | null, dumpId: DumpId | null, detail: Record<string, unknown>): void => {
    expected.push({ eventId: identity.eventId, occurredAt: identity.occurredAt, action, customerId, caseId, dumpId, detail });
  };

  const customer1 = customerId(1);
  const case1 = caseId(1);
  const case2 = caseId(2);
  const grant1 = grantId(1);
  const grant2 = grantId(2);
  const grant3 = grantId(3);

  const created = event(at(0));
  ledger.createCustomer(customer1, "Acme", created);
  record(created, "CreateCustomer", customer1, null, null, {});

  const case1Created = event(at(1));
  ledger.createCase(case1, customer1, "Renderer crash", case1Created);
  record(case1Created, "CreateCase", customer1, case1, null, {});

  const case2Created = event(at(2));
  ledger.createCase(case2, customer1, "GPU crash", case2Created);
  record(case2Created, "CreateCase", customer1, case2, null, {});

  const grant1Issued = event(at(3));
  ledger.issueGrant(grant1, case1, "secret-1", EXPIRY, 1_000_000n, 16, grant1Issued);
  record(grant1Issued, "IssueGrant", customer1, case1, null, { grantId: grant1, maxUploads: 16 });

  const grant2Issued = event(at(4));
  ledger.issueGrant(grant2, case2, "secret-2", EXPIRY, 1_000_000n, 2, grant2Issued);
  record(grant2Issued, "IssueGrant", customer1, case2, null, { grantId: grant2, maxUploads: 2 });

  // Dump 1: accepted, downloadable, retention set.
  const begun1 = event(at(5));
  ledger.beginUpload(grant1, dumpId(1), "crash-1.dmp", begun1);
  record(begun1, "BeginUpload", customer1, case1, dumpId(1), { grantId: grant1 });
  const sealed1 = event(at(6));
  ledger.sealUpload(dumpId(1), 1_000n, shaFor(1), sealed1);
  record(sealed1, "SealUpload", customer1, case1, dumpId(1), {});
  const promoted1 = event(at(7));
  ledger.recordPromoted(dumpId(1), promoted1);
  record(promoted1, "PromoteObject", customer1, case1, dumpId(1), {});
  const quarantined1 = event(at(8));
  ledger.markQuarantined(dumpId(1), quarantined1);
  record(quarantined1, "MarkQuarantined", customer1, case1, dumpId(1), {});
  const accepted1 = event(at(9));
  ledger.acceptDump(dumpId(1), "partial", { architecture: "x86_64" }, accepted1);
  record(accepted1, "AcceptDump", customer1, case1, dumpId(1), {});
  const authorized1 = event(at(10));
  ledger.authorizeDownload(dumpId(1), authorized1);
  record(authorized1, "AuthorizeDownload", customer1, case1, dumpId(1), {});
  const retention1 = event(at(11));
  ledger.setRetention(dumpId(1), at(600), retention1);
  record(retention1, "SetRetention", customer1, case1, dumpId(1), { purgeAt: at(600) });

  // Dump 2: rejected by inspection, then purged.
  const begun2 = event(at(12));
  ledger.beginUpload(grant1, dumpId(2), "crash-2.dmp", begun2);
  record(begun2, "BeginUpload", customer1, case1, dumpId(2), { grantId: grant1 });
  const sealed2 = event(at(13));
  ledger.sealUpload(dumpId(2), 2_000n, shaFor(2), sealed2);
  record(sealed2, "SealUpload", customer1, case1, dumpId(2), {});
  const promoted2 = event(at(14));
  ledger.recordPromoted(dumpId(2), promoted2);
  record(promoted2, "PromoteObject", customer1, case1, dumpId(2), {});
  const quarantined2 = event(at(15));
  ledger.markQuarantined(dumpId(2), quarantined2);
  record(quarantined2, "MarkQuarantined", customer1, case1, dumpId(2), {});
  const rejected2 = event(at(16));
  ledger.rejectDump(dumpId(2), "malformed-stream: no exception stream", rejected2);
  record(rejected2, "RejectDump", customer1, case1, dumpId(2), {});
  const purging2 = event(at(17));
  ledger.beginPurge(dumpId(2), purging2);
  record(purging2, "BeginPurge", customer1, case1, dumpId(2), {});
  const purged2 = event(at(18));
  ledger.finishPurge(dumpId(2), purged2);
  record(purged2, "FinishPurge", customer1, case1, dumpId(2), {});

  // Dump 3 (case2): interrupted transfer.
  const begun3 = event(at(19));
  ledger.beginUpload(grant2, dumpId(3), "crash-3.dmp", begun3);
  record(begun3, "BeginUpload", customer1, case2, dumpId(3), { grantId: grant2 });
  const failed3 = event(at(20));
  ledger.failUpload(dumpId(3), failed3);
  record(failed3, "FailUpload", customer1, case2, dumpId(3), {});

  // Grant revocation and expiry on case2.
  const grant3Issued = event(at(21));
  ledger.issueGrant(grant3, case2, "secret-3", EXPIRY, 1_000_000n, 1, grant3Issued);
  record(grant3Issued, "IssueGrant", customer1, case2, null, { grantId: grant3, maxUploads: 1 });
  const revoked3 = event(at(22));
  ledger.transitionGrant(grant3, "revoked", revoked3);
  record(revoked3, "RevokeGrant", customer1, case2, null, { grantId: grant3 });
  const expired2 = event(at(23));
  ledger.transitionGrant(grant2, "expired", expired2);
  record(expired2, "ExpireGrant", customer1, case2, null, { grantId: grant2 });

  // Case workflow on case2, through to closed (no issued grants remain).
  const investigated2 = event(at(24));
  ledger.startInvestigation(case2, investigated2);
  record(investigated2, "StartInvestigation", customer1, case2, null, {});
  const waiting2 = event(at(25));
  ledger.waitForCustomer(case2, waiting2);
  record(waiting2, "WaitForCustomer", customer1, case2, null, {});
  const resolved2 = event(at(26));
  ledger.resolveCase(case2, resolved2);
  record(resolved2, "ResolveCase", customer1, case2, null, {});
  const closed2 = event(at(27));
  ledger.closeCase(case2, closed2);
  record(closed2, "CloseCase", customer1, case2, null, { revokedGrantIds: [] });

  return { customer1, case1, case2, expected };
}

describe("ledger audit event feed", () => {
  it("reads the whole trail from 0 in rowid order with parsed details", () => {
    withLedger(ledger => {
      const { expected } = seed(ledger);

      const fromZero = ledger.readAuditEvents(0);
      assert.equal(fromZero.events.length, expected.length);
      assert.deepEqual(fromZero.events.map(model), expected);

      // The default cursor is the same full scan, and re-reads are stable.
      assert.deepEqual(ledger.readAuditEvents(), fromZero);
      assert.deepEqual(ledger.readAuditEvents(0), fromZero);

      // A non-empty page's cursor is the rowid of its last delivered row.
      const last = fromZero.events[fromZero.events.length - 1];
      assert.ok(last !== undefined);
      assert.equal(fromZero.lastRowid, last.rowid);

      // Strictly increasing rowids, starting at 1 on a fresh append-only table.
      assert.equal(fromZero.events[0]?.rowid, 1);
      for (let index = 1; index < fromZero.events.length; index += 1) {
        const previous = fromZero.events[index - 1];
        const current = fromZero.events[index];
        assert.ok(previous !== undefined && current !== undefined);
        assert.ok(previous.rowid < current.rowid, `rowid order broke at index ${index}`);
      }
    }, "dump-ledger-events-scan-");
  });

  it("filters by action allowlist and case, alone and combined", () => {
    withLedger(ledger => {
      const { case1, expected } = seed(ledger);
      const eventsFor = (filter: { readonly actions?: readonly string[]; readonly caseId?: CaseId }): readonly ExpectedAuditEvent[] =>
        ledger.readAuditEvents(undefined, filter).events.map(model);

      // The design doc's example allowlist, in trail order.
      assert.deepEqual(
        eventsFor({ actions: ["SealUpload", "RejectDump"] }),
        expected.filter(entry => entry.action === "SealUpload" || entry.action === "RejectDump"),
      );

      // Case filter alone keeps trail order.
      const case1Events = ledger.readAuditEvents(undefined, { caseId: case1 });
      assert.deepEqual(case1Events.events.map(model), expected.filter(entry => entry.caseId === case1));
      assert.equal(case1Events.events.length > 0, true);

      // Case and allowlist combine.
      assert.deepEqual(
        eventsFor({ actions: ["BeginUpload", "SealUpload"], caseId: case1 }),
        expected.filter(entry => entry.caseId === case1 && (entry.action === "BeginUpload" || entry.action === "SealUpload")),
      );

      // A cursor and the case filter combine; the cursor stays rowid-based.
      const firstCase1 = case1Events.events[0];
      assert.ok(firstCase1 !== undefined);
      const afterFirst = ledger.readAuditEvents(firstCase1.rowid, { caseId: case1 });
      assert.deepEqual(afterFirst.events.map(model), expected.filter(entry => entry.caseId === case1).slice(1));
      const lastAfterFirst = afterFirst.events[afterFirst.events.length - 1];
      assert.ok(lastAfterFirst !== undefined);
      assert.equal(afterFirst.lastRowid, lastAfterFirst.rowid);

      // No action matches: empty page, and the cursor reads 0 without a cursor.
      const none = ledger.readAuditEvents(undefined, { actions: ["NoSuchAction"] });
      assert.deepEqual(none.events, []);
      assert.equal(none.lastRowid, 0);

      // An explicitly empty allowlist filters out every action.
      const empty = ledger.readAuditEvents(undefined, { actions: [] });
      assert.deepEqual(empty.events, []);
      assert.equal(empty.lastRowid, 0);
    }, "dump-ledger-events-filters-");
  });

  it("pages gaplessly and duplicate-free with engine writes between fetches", () => {
    withLedger(ledger => {
      const { customer1, case1, case2, expected } = seed(ledger);
      const limit = 4;
      const pages: Array<readonly AuditFeedEntry[]> = [];
      let terminal: { readonly events: readonly AuditFeedEntry[]; readonly lastRowid: number } | null = null;

      let cursor = 0;
      let fetches = 0;
      while (true) {
        const page = ledger.readAuditEvents(cursor, undefined, limit);
        fetches += 1;
        if (page.events.length === 0) { terminal = page; break; }
        pages.push(page.events);
        assert.ok(page.events.length <= limit);
        if (fetches === 2) {
          // New engine writes land after the cursor; later pages must carry
          // them exactly once, after the rows already delivered.
          const resumed = event(at(100));
          ledger.resumeInvestigation(case2, resumed);
          expected.push({ eventId: resumed.eventId, occurredAt: resumed.occurredAt, action: "ResumeInvestigation", customerId: customer1, caseId: case2, dumpId: null, detail: {} });
          const investigated = event(at(101));
          ledger.startInvestigation(case1, investigated);
          expected.push({ eventId: investigated.eventId, occurredAt: investigated.occurredAt, action: "StartInvestigation", customerId: customer1, caseId: case1, dumpId: null, detail: {} });
        }
        cursor = page.lastRowid;
      }

      const delivered = pages.flat();

      // 28 seeded rows + 2 interleaved rows: 7 full pages of 4 plus a tail of 2.
      assert.equal(delivered.length, expected.length);
      for (const page of pages.slice(0, -1)) assert.equal(page.length, limit);
      const tail = pages[pages.length - 1];
      assert.ok(tail !== undefined);
      assert.equal(tail.length, expected.length % limit);

      // Rowids strictly increase across the whole run: no duplicate, no skip.
      for (let index = 1; index < delivered.length; index += 1) {
        const previous = delivered[index - 1];
        const current = delivered[index];
        assert.ok(previous !== undefined && current !== undefined);
        assert.ok(previous.rowid < current.rowid, `paging redelivered or reordered rowid ${current.rowid}`);
      }
      assert.equal(new Set(delivered.map(entry => entry.rowid)).size, delivered.length);

      // The union of pages is exactly a fresh full scan, interleaved rows included.
      const full = ledger.readAuditEvents();
      assert.deepEqual(full.events.map(model), expected);
      assert.deepEqual(delivered.map(model), expected);

      // The fetch after the final page was beyond the end: empty, cursor echoed.
      assert.ok(terminal !== null);
      assert.deepEqual(terminal.events, []);
      const lastDelivered = delivered[delivered.length - 1];
      assert.ok(lastDelivered !== undefined);
      assert.equal(terminal.lastRowid, lastDelivered.rowid);
    }, "dump-ledger-events-paging-");
  });

  it("returns an empty page beyond the end, echoing the request cursor", () => {
    withLedger(ledger => {
      const { expected } = seed(ledger);
      const full = ledger.readAuditEvents();
      assert.equal(full.events.length, expected.length);
      const last = full.events[full.events.length - 1];
      assert.ok(last !== undefined);
      assert.equal(full.lastRowid, last.rowid);

      // At the end and beyond it, the page is empty and the cursor is echoed.
      const caughtUp = ledger.readAuditEvents(last.rowid);
      assert.deepEqual(caughtUp.events, []);
      assert.equal(caughtUp.lastRowid, last.rowid);

      const beyond = ledger.readAuditEvents(last.rowid + 1_000);
      assert.deepEqual(beyond.events, []);
      assert.equal(beyond.lastRowid, last.rowid + 1_000);

      // Echo holds with a filter too: an empty page never advances the cursor.
      const filtered = ledger.readAuditEvents(last.rowid + 1_000, { actions: ["SealUpload"] });
      assert.deepEqual(filtered.events, []);
      assert.equal(filtered.lastRowid, last.rowid + 1_000);
    }, "dump-ledger-events-beyond-");
  });

  it("reads an empty ledger as an empty page with cursor 0", () => {
    withLedger(ledger => {
      const fresh = ledger.readAuditEvents();
      assert.deepEqual(fresh.events, []);
      assert.equal(fresh.lastRowid, 0);

      const positioned = ledger.readAuditEvents(17);
      assert.deepEqual(positioned.events, []);
      assert.equal(positioned.lastRowid, 17);
    }, "dump-ledger-events-empty-");
  });

  it("clamps the page size into [1, 500]", () => {
    withLedger(ledger => {
      const { expected } = seed(ledger);

      const zero = ledger.readAuditEvents(0, undefined, 0);
      assert.equal(zero.events.length, 1);
      assert.equal(zero.events[0]?.rowid, 1);
      assert.equal(zero.lastRowid, 1);

      const negative = ledger.readAuditEvents(0, undefined, -5);
      assert.deepEqual(negative.events, zero.events);

      // A limit above the cap reads as the default scan here; the cap itself
      // is observable over a longer trail below.
      const oversized = ledger.readAuditEvents(0, undefined, 10_000);
      assert.equal(oversized.events.length, expected.length);
      assert.deepEqual(oversized, ledger.readAuditEvents(0));
    }, "dump-ledger-events-limit-");
  });

  it("caps a page at MAX_AUDIT_FEED_PAGE over a longer trail", () => {
    withLedger(ledger => {
      // A long trail arrives through the import path, still engine commands.
      const imported = MAX_AUDIT_FEED_PAGE + 1;
      ledger.beginImport(event(at(0)), {});
      for (let index = 1; index <= imported; index += 1) {
        ledger.importAuditEvent({
          eventId: parseAuditEventId(`audit_${body(1_000_000 + index)}`),
          occurredAt: at(index),
          action: "ImportCase",
          customerId: null, caseId: null, dumpId: null,
          detail: { index },
        });
      }

      const first = ledger.readAuditEvents();
      assert.equal(first.events.length, MAX_AUDIT_FEED_PAGE);
      const firstLast = first.events[first.events.length - 1];
      assert.ok(firstLast !== undefined);
      assert.equal(first.lastRowid, firstLast.rowid);

      const rest = ledger.readAuditEvents(first.lastRowid);
      assert.equal(rest.events.length, 2);
      const restLast = rest.events[rest.events.length - 1];
      assert.ok(restLast !== undefined);
      assert.equal(rest.lastRowid, restLast.rowid);
      assert.ok((rest.events[0]?.rowid ?? 0) > first.lastRowid);

      // An oversized explicit limit is capped at the same 500-row page.
      const oversized = ledger.readAuditEvents(0, undefined, MAX_AUDIT_FEED_PAGE * 10);
      assert.equal(oversized.events.length, MAX_AUDIT_FEED_PAGE);
      assert.deepEqual(oversized.events, first.events);

      // Caught up at the end of the longer trail: empty page, echoed cursor.
      const caughtUp = ledger.readAuditEvents(rest.lastRowid);
      assert.deepEqual(caughtUp.events, []);
      assert.equal(caughtUp.lastRowid, rest.lastRowid);
    }, "dump-ledger-events-cap-");
  });
});
