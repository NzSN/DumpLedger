/**
 * Case search tests (T5, design section 7.3).
 *
 * CasesPage runs the bounded search + cursor pagination against
 * GET /api/v1/cases?query=&cursor=. Covers loading/ready/empty/error states,
 * explicit search submission, "Load more" cursor paging, no-overlap guards,
 * and abort-on-unmount so an older search can never replace a newer page.
 */

import { act, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { CaseSearchResponse, CaseSummary } from "@dump-ledger/http-contracts";
import { HttpRequestError } from "../shared/http-client";
import { CasesPage } from "../features/cases/CasesPage";
import { HttpClientProvider } from "../shared/http-client-context";
import {
  OperatorFakeHttpClient,
  renderFeaturePage,
  type OperatorResponder,
} from "./operator-fake-http-client";

function caseRow(caseId: string, title: string, status: CaseSummary["status"] = "new"): CaseSummary {
  return { caseId, customerId: "customer-1", title, status, createdAt: "2026-09-01T10:00:00.000Z" };
}

const PAGE_ONE: readonly CaseSummary[] = [
  caseRow("case-1", "Renderer crash on startup"),
  caseRow("case-2", "GPU driver reset"),
];
const PAGE_TWO: readonly CaseSummary[] = [caseRow("case-3", "Audio service hang", "investigating")];
const EMPTY: CaseSearchResponse = { cases: [] };

function deferredResponder<T>(): { responder: OperatorResponder; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { responder: () => promise, resolve };
}

function renderCases(fake: OperatorFakeHttpClient): void {
  renderFeaturePage(fake, <CasesPage />, { entry: "/cases" });
}

/** Local variant that returns an unmount handle for abort-on-unmount tests. */
function renderStandalone(fake: OperatorFakeHttpClient, element: ReactNode): { unmount: () => void } {
  const router = createMemoryRouter([{ path: "*", element }], { initialEntries: ["/cases"] });
  const view = render(
    <HttpClientProvider client={fake}>
      <RouterProvider router={router} />
    </HttpClientProvider>,
  );
  return { unmount: view.unmount };
}

describe("Cases search operator page", () => {
  it("loads the latest cases with a polite loading state", async () => {
    const fake = new OperatorFakeHttpClient();
    const held = deferredResponder<CaseSearchResponse>();
    fake.setQueryResponder("/api/v1/cases", held.responder);
    renderCases(fake);

    expect(await screen.findByRole("heading", { name: "Cases" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Searching cases…");

    await act(async () => {
      held.resolve({ cases: PAGE_ONE, nextCursor: "cursor-2" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByRole("link", { name: /Renderer crash on startup/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /GPU driver reset/ })).toBeTruthy();
    expect(fake.queryCalls.map((call) => call.path)).toEqual(["/api/v1/cases"]);
  });

  it("shows an empty state when nothing matches", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder("/api/v1/cases", () => EMPTY);
    renderCases(fake);

    expect(await screen.findByText("No matching cases")).toBeTruthy();
  });

  it("shows a retryable error and recovers", async () => {
    const fake = new OperatorFakeHttpClient();
    let calls = 0;
    fake.setQueryResponder("/api/v1/cases", () => {
      calls += 1;
      if (calls === 1) {
        throw new HttpRequestError("The case search failed.", {
          code: "internal_error",
          status: 503,
          retryable: true,
          path: "/api/v1/cases",
        });
      }
      return { cases: PAGE_ONE };
    });
    const user = userEvent.setup();
    renderCases(fake);

    expect(await screen.findByText("The case search failed.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: /Renderer crash on startup/ })).toBeTruthy();
    expect(fake.queryCalls.filter((call) => call.path === "/api/v1/cases")).toHaveLength(2);
  });

  it("submits a bounded query and replaces the previous page", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder("/api/v1/cases", () => ({ cases: PAGE_ONE }));
    fake.setQueryResponder("/api/v1/cases?query=renderer", () => ({ cases: [PAGE_ONE[0] ?? caseRow("case-1", "Renderer crash on startup")] }));
    const user = userEvent.setup();
    renderCases(fake);

    await screen.findByRole("link", { name: /GPU driver reset/ });
    const input = screen.getByRole("searchbox", { name: "Search query" });
    await user.type(input, "renderer");
    await user.click(screen.getByRole("button", { name: "Search" }));

    // The filtered page replaced the previous rows and shows the match heading.
    await waitFor(() => {
      expect(screen.getByText('Matches for “renderer”.')).toBeTruthy();
    });
    expect(screen.getByRole("link", { name: /Renderer crash on startup/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /GPU driver reset/ })).toBeNull();
    expect(fake.queryCalls.some((call) => call.path === "/api/v1/cases?query=renderer")).toBe(true);
  });

  it("appends the next cursor page and hides Load more at the end", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder("/api/v1/cases", () => ({ cases: PAGE_ONE, nextCursor: "cursor-2" }));
    fake.setQueryResponder("/api/v1/cases?cursor=cursor-2", () => ({ cases: PAGE_TWO }));
    const user = userEvent.setup();
    renderCases(fake);

    await screen.findByRole("link", { name: /Renderer crash on startup/ });
    const loadMore = screen.getByRole("button", { name: "Load more" });
    await user.click(loadMore);

    expect(await screen.findByRole("link", { name: /Audio service hang/ })).toBeTruthy();
    // Appended, not replaced.
    expect(screen.getByRole("link", { name: /Renderer crash on startup/ })).toBeTruthy();
    // No further cursor: Load more disappears.
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(fake.queryCalls.map((call) => call.path)).toContain("/api/v1/cases?cursor=cursor-2");
  });

  it("shows the load-more pending state on the button", async () => {
    const fake = new OperatorFakeHttpClient();
    const held = deferredResponder<CaseSearchResponse>();
    fake.setQueryResponder("/api/v1/cases", () => ({ cases: PAGE_ONE, nextCursor: "cursor-2" }));
    fake.setQueryResponder("/api/v1/cases?cursor=cursor-2", held.responder);
    const user = userEvent.setup();
    renderCases(fake);

    await screen.findByRole("link", { name: /Renderer crash on startup/ });
    await user.click(screen.getByRole("button", { name: "Load more" }));

    const pending = await screen.findByRole("button", { name: "Loading more…" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      held.resolve({ cases: PAGE_TWO });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByRole("link", { name: /Audio service hang/ })).toBeTruthy();
  });

  it("aborts an in-flight search on unmount so a stale page can never land", async () => {
    const fake = new OperatorFakeHttpClient();
    const held = deferredResponder<CaseSearchResponse>();
    fake.setQueryResponder("/api/v1/cases", held.responder);
    const { unmount } = renderStandalone(fake, <CasesPage />);

    await screen.findByRole("status");
    unmount();

    await waitFor(() => {
      expect(fake.abortedSignals.some((signal) => signal.aborted)).toBe(true);
    });
    // A response that resolves after the unmount must be discarded entirely.
    await act(async () => {
      held.resolve({ cases: PAGE_ONE });
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
