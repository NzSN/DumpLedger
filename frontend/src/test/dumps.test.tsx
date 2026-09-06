/**
 * Dump detail operator tests (T5, design section 7.7).
 *
 * Renders the real DumpDetailPage against an OperatorFakeHttpClient serving
 * GET /api/v1/dumps/:dumpId and PUT /api/v1/dumps/:dumpId/retention. Covers
 * the lifecycle/coverage/facts/activity detail, download as an ordinary
 * navigation only when the backend marks the dump downloadable, retention
 * control bounded to whole days and shown only for backend-accepted phases,
 * the server-returned canonical purge deadline after an update (browser clock
 * is never authoritative), retention pending/success/failure, and
 * abort-on-unmount.
 */

import { act, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { DumpDetailResponse, RetentionResponse } from "@dump-ledger/http-contracts";
import { HttpRequestError } from "../shared/http-client";
import { DumpDetailPage } from "../features/dumps/DumpDetailPage";
import { HttpClientProvider } from "../shared/http-client-context";
import {
  OperatorFakeHttpClient,
  renderFeaturePage,
  type OperatorResponder,
} from "./operator-fake-http-client";
import { dumpDetailFixture, activityItem } from "./operator-fixtures";

function byText(fragment: string): (text: string, node: Element | null) => boolean {
  return (_text: string, node: Element | null): boolean =>
    node?.textContent?.includes(fragment) === true;
}

function deferredResponder<T>(): { responder: OperatorResponder; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { responder: () => promise, resolve, reject };
}

function retentionError(message: string): HttpRequestError {
  return new HttpRequestError(message, { code: "invalid_request", status: 422, retryable: false, path: "/api/v1/dumps/dump-9001/retention" });
}

function renderStandalone(
  fake: OperatorFakeHttpClient,
  element: ReactNode,
): { unmount: () => void } {
  const router = createMemoryRouter([{ path: "/dumps/:dumpId", element }], {
    initialEntries: ["/dumps/dump-9001"],
  });
  const view = render(
    <HttpClientProvider client={fake}>
      <RouterProvider router={router} />
    </HttpClientProvider>,
  );
  return { unmount: view.unmount };
}

function renderDumpDetail(fake: OperatorFakeHttpClient): void {
  renderFeaturePage(fake, <DumpDetailPage />, { entry: "/dumps/dump-9001", path: "/dumps/:dumpId" });
}

const DETAIL_PATH = "/api/v1/dumps/dump-9001";
const RETENTION_PATH = "/api/v1/dumps/dump-9001/retention";

describe("Dump detail operator page", () => {
  it("shows a polite loading state and then the recorded facts", async () => {
    const fake = new OperatorFakeHttpClient();
    const held = deferredResponder<DumpDetailResponse>();
    fake.setQueryResponder(DETAIL_PATH, held.responder);
    renderDumpDetail(fake);

    expect(await screen.findByRole("heading", { name: "Dump detail" })).toBeTruthy();
    expect(screen.getByText("Dump dump-9001")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Loading dump…");

    await act(async () => {
      held.resolve(
        dumpDetailFixture({
          sha256: "ab".repeat(32),
          purgeAt: "2026-10-01T00:00:00.000Z",
          activity: [activityItem("2026-09-01T11:00:00.000Z", "DumpReceived")],
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText("Available")).toBeTruthy();
    expect(screen.getByText("Valid")).toBeTruthy();
    expect(screen.getByText("Full memory declared")).toBeTruthy();
    expect(screen.getByText("10 MiB")).toBeTruthy();
    expect(screen.getByText("2026-10-01 00:00:00 UTC")).toBeTruthy();
    // Activity list shows the audited event with a readable label.
    expect(screen.getByText("Dump Received")).toBeTruthy();
    // Download is an ordinary content-endpoint navigation.
    const download = screen.getByRole("link", { name: "Download original dump" });
    expect(download.getAttribute("href")).toBe(`${DETAIL_PATH}/content`);
    expect(download.getAttribute("download")).toBe("dump-9001.dmp");
    expect(fake.queryCalls.filter((call) => call.path === DETAIL_PATH)).toHaveLength(1);
  });

  it("offers retention only for backend-accepted phases and hides download when not downloadable", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () => dumpDetailFixture({ phase: "deleted", downloadable: false }));
    renderDumpDetail(fake);

    expect(await screen.findByText("Deleted")).toBeTruthy();
    // No retention form for terminal phases.
    expect(screen.queryByLabelText("Retain for")).toBeNull();
    expect(screen.getByText("Retention can be assigned after validation reaches available or rejected.")).toBeTruthy();
    // No download link for a non-downloadable artifact.
    expect(screen.queryByRole("link", { name: "Download original dump" })).toBeNull();
    // "Not scheduled" appears because purgeAt is null and the fact is still shown.
    expect(screen.getByText("Not scheduled")).toBeTruthy();
  });

  it("validates retention as bounded whole days", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () => dumpDetailFixture());
    const user = userEvent.setup();
    renderDumpDetail(fake);

    await screen.findByText("Available");
    const days = screen.getByLabelText("Retain for");
    await user.clear(days);
    await user.type(days, "0");
    await user.click(screen.getByRole("button", { name: "Update retention" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Enter whole days from 1 to 36500.");
    expect(fake.mutationCalls).toHaveLength(0);
  });

  it("updates retention and shows the server-returned canonical purge deadline", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () => dumpDetailFixture({ purgeAt: "2026-09-15T00:00:00.000Z" }));
    const mutation = deferredResponder<RetentionResponse>();
    fake.setMutationResponder("PUT", RETENTION_PATH, mutation.responder);
    const user = userEvent.setup();
    renderDumpDetail(fake);

    await screen.findByText("Available");
    const days = screen.getByLabelText("Retain for");
    await user.clear(days);
    await user.type(days, "45");
    await user.click(screen.getByRole("button", { name: "Update retention" }));

    const pendingButton = await screen.findByRole("button", { name: "Updating…" });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      mutation.resolve({ dump: { dumpId: "dump-9001", purgeAt: "2026-10-16T00:00:00.000Z" } });
      await Promise.resolve();
      await Promise.resolve();
    });

    // The success summary shows the server-computed deadline verbatim; the
    // browser clock is never used to derive it.
    await waitFor(() => {
      expect(
        screen.getAllByText(byText("Retention updated — the server-scheduled purge deadline is 2026-10-16 00:00:00 UTC")).length,
      ).toBeGreaterThan(0);
    });
    // The request body carried the bounded whole-day count.
    const calls = fake.mutationCalls.filter((call) => call.method === "PUT" && call.path === RETENTION_PATH);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ days: 45 });
    // Authoritative dump detail was refetched after the update.
    await waitFor(() => {
      expect(fake.queryCalls.filter((call) => call.path === DETAIL_PATH)).toHaveLength(2);
    });
  });

  it("surfaces a retention failure as a focus-moved alert", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () => dumpDetailFixture());
    fake.setMutationResponder("PUT", RETENTION_PATH, () => {
      throw retentionError("Retention cannot be changed while the dump is being purged.");
    });
    const user = userEvent.setup();
    renderDumpDetail(fake);

    await screen.findByText("Available");
    await user.click(screen.getByRole("button", { name: "Update retention" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Retention cannot be changed while the dump is being purged.");
    await waitFor(() => {
      expect(document.activeElement?.textContent).toContain("Retention cannot be changed while the dump is being purged.");
    });
    expect((screen.getByRole("button", { name: "Update retention" }) as HTMLButtonElement).disabled).toBe(false);
    expect(fake.queryCalls.filter((call) => call.path === DETAIL_PATH)).toHaveLength(1);
  });

  it("aborts the in-flight dump detail load on unmount", async () => {
    const fake = new OperatorFakeHttpClient();
    const held = deferredResponder<DumpDetailResponse>();
    fake.setQueryResponder(DETAIL_PATH, held.responder);
    const { unmount } = renderStandalone(fake, <DumpDetailPage />);

    await screen.findByText("Loading dump…");
    unmount();

    await waitFor(() => {
      expect(fake.abortedSignals.some((signal) => signal.aborted)).toBe(true);
    });
    await act(async () => {
      held.resolve(dumpDetailFixture());
      await Promise.resolve();
    });
  });

  it("recovers from a retryable page-load error", async () => {
    const fake = new OperatorFakeHttpClient();
    let calls = 0;
    fake.setQueryResponder(DETAIL_PATH, () => {
      calls += 1;
      if (calls === 1) {
        throw new HttpRequestError("The dump could not be loaded.", {
          code: "internal_error",
          status: 503,
          retryable: true,
          path: DETAIL_PATH,
        });
      }
      return dumpDetailFixture();
    });
    const user = userEvent.setup();
    renderDumpDetail(fake);

    expect(await screen.findByText("The dump could not be loaded.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Available")).toBeTruthy();
    expect(fake.queryCalls.filter((call) => call.path === DETAIL_PATH)).toHaveLength(2);
  });
});
