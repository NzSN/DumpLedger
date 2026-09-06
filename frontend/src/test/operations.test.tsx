/**
 * Operations operator tests (T5, design section 7.7).
 *
 * Renders the real OperationsPage with an OperatorFakeHttpClient serving
 * GET /api/v1/operations. Covers loading/ready/error states, integrity
 * warnings surfaced verbatim, the bounded polling rules (ticks pause while
 * document.hidden, a hidden->visible transition refreshes immediately, a tick
 * never overlaps an outstanding request), the busy refresh control, and the
 * empty-jobs state. A short `pollIntervalMs` (or 0 to disable the timer) is
 * injected per test.
 */

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OperationsResponse } from "@dump-ledger/http-contracts";
import { HttpRequestError } from "../shared/http-client";
import { OperationsPage } from "../features/operations/OperationsPage";
import {
  OperatorFakeHttpClient,
  renderFeaturePage,
  type OperatorResponder,
} from "./operator-fake-http-client";
import { operationsFixture, runtimeJob } from "./operator-fixtures";

const OPERATIONS_PATH = "/api/v1/operations";

function deferredResponder<T>(): { responder: OperatorResponder; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { responder: () => promise, resolve, reject };
}

/** jsdom keeps `hidden` on the prototype; shadow it with an own property. */
function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function renderOperations(fake: OperatorFakeHttpClient, pollIntervalMs: number): void {
  renderFeaturePage(fake, <OperationsPage pollIntervalMs={pollIntervalMs} />, { entry: "/operations" });
}

describe("Operations operator page", () => {
  afterEach(() => {
    setDocumentHidden(false);
  });

  it("loads the runtime summary with a polite loading state", async () => {
    const fake = new OperatorFakeHttpClient();
    const held = deferredResponder<OperationsResponse>();
    fake.setQueryResponder(OPERATIONS_PATH, held.responder);
    renderOperations(fake, 0);

    expect(await screen.findByRole("heading", { name: "Operations" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Loading operations…");

    await act(async () => {
      held.resolve(operationsFixture());
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText("All checks passed")).toBeTruthy();
    expect(screen.getByText("2/8")).toBeTruthy();
    expect(screen.getByText("retention-sweep")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(fake.queryCalls.filter((call) => call.path === OPERATIONS_PATH)).toHaveLength(1);
  });

  it("surfaces integrity warnings verbatim for operator review", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(OPERATIONS_PATH, () =>
      operationsFixture({
        integrityStatus: "degraded",
        integrityErrors: ["SQLite page 42 is corrupt", "WAL check failed at offset 8192"],
      }),
    );
    renderOperations(fake, 0);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("2 integrity errors require operator review.");
    expect(screen.getByText("SQLite page 42 is corrupt")).toBeTruthy();
    expect(screen.getByText("WAL check failed at offset 8192")).toBeTruthy();
    // "Degraded" appears in both the metric word and the status pill.
    expect(screen.getAllByText("Degraded").length).toBeGreaterThan(0);
  });

  it("shows an empty state when no runtime jobs are configured", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(OPERATIONS_PATH, () => operationsFixture({ jobs: [] }));
    renderOperations(fake, 0);

    expect(await screen.findByText("No periodic jobs")).toBeTruthy();
  });

  it("recovers from a retryable load error via Try again", async () => {
    const fake = new OperatorFakeHttpClient();
    let calls = 0;
    fake.setQueryResponder(OPERATIONS_PATH, () => {
      calls += 1;
      if (calls === 1) {
        throw new HttpRequestError("The operations summary is temporarily unavailable.", {
          code: "internal_error",
          status: 503,
          retryable: true,
          path: OPERATIONS_PATH,
        });
      }
      return operationsFixture();
    });
    const user = userEvent.setup();
    renderOperations(fake, 0);

    expect(await screen.findByText("The operations summary is temporarily unavailable.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("All checks passed")).toBeTruthy();
    expect(fake.queryCalls.filter((call) => call.path === OPERATIONS_PATH)).toHaveLength(2);
  });

  it("keeps a manual refresh disabled while a request is in flight", async () => {
    const fake = new OperatorFakeHttpClient();
    const held = deferredResponder<OperationsResponse>();
    // The first call resolves immediately; every later call is held open.
    let calls = 0;
    fake.setQueryResponder(OPERATIONS_PATH, (request) => {
      calls += 1;
      return calls === 1 ? operationsFixture() : held.responder(request);
    });
    const user = userEvent.setup();
    renderOperations(fake, 0);

    await screen.findByText("All checks passed");
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    const refreshing = await screen.findByRole("button", { name: "Refreshing…" });
    expect((refreshing as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      held.resolve(operationsFixture());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(fake.queryCalls.filter((call) => call.path === OPERATIONS_PATH)).toHaveLength(2);
  });

  it("never lets an interval tick overlap an outstanding request", async () => {
    const fake = new OperatorFakeHttpClient();
    const held = deferredResponder<OperationsResponse>();
    fake.setQueryResponder(OPERATIONS_PATH, held.responder);
    renderOperations(fake, 40);

    // Initial request is in flight; several poll ticks must not overlap it.
    await waitFor(() => {
      expect(fake.queryCalls.filter((call) => call.path === OPERATIONS_PATH)).toHaveLength(1);
    });
    await sleep(180);
    expect(fake.queryCalls.filter((call) => call.path === OPERATIONS_PATH)).toHaveLength(1);

    await act(async () => {
      held.resolve(operationsFixture());
      await Promise.resolve();
      await Promise.resolve();
    });
    await screen.findByText("All checks passed");

    // With the guard released, the next tick polls again.
    await waitFor(
      () => {
        expect(fake.queryCalls.filter((call) => call.path === OPERATIONS_PATH).length).toBeGreaterThan(1);
      },
      { timeout: 1500 },
    );
  });

  it("pauses interval polling while the document is hidden", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(OPERATIONS_PATH, () => operationsFixture());
    renderOperations(fake, 40);

    await screen.findByText("All checks passed");
    expect(fake.queryCalls.filter((call) => call.path === OPERATIONS_PATH)).toHaveLength(1);

    setDocumentHidden(true);
    // Several ticks pass while hidden; none may start a request.
    await sleep(220);
    expect(fake.queryCalls.filter((call) => call.path === OPERATIONS_PATH)).toHaveLength(1);
  });

  it("refreshes immediately when the document becomes visible again", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(OPERATIONS_PATH, () => operationsFixture());
    setDocumentHidden(true);
    // Polling is disabled entirely; only the visibility handler can refresh.
    renderOperations(fake, 0);

    await screen.findByText("All checks passed");
    expect(fake.queryCalls.filter((call) => call.path === OPERATIONS_PATH)).toHaveLength(1);
    await sleep(80);
    expect(fake.queryCalls.filter((call) => call.path === OPERATIONS_PATH)).toHaveLength(1);

    setDocumentHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(fake.queryCalls.filter((call) => call.path === OPERATIONS_PATH)).toHaveLength(2);
    });
  });
});
