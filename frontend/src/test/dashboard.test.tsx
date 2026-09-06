/**
 * Dashboard operator tests (T5, design sections 7.3 and 8.4).
 *
 * Renders the real DashboardPage inside the providers with an
 * OperatorFakeHttpClient that models GET /api/v1/dashboard plus the
 * create-customer and per-customer create-case mutations. Covers loading,
 * ready, empty, and error states; both create flows' pending/success/failure;
 * focus moving to the finished mutation summary; refetch-after-mutation; and
 * abort-on-unmount so a stale response can never overwrite a newer route.
 */

import { act, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { CaseSummary, CustomerSummary, DashboardResponse } from "@dump-ledger/http-contracts";
import { HttpRequestError } from "../shared/http-client";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { HttpClientProvider } from "../shared/http-client-context";
import {
  OperatorFakeHttpClient,
  renderFeaturePage,
  type OperatorResponder,
} from "./operator-fake-http-client";

const CUSTOMERS: readonly CustomerSummary[] = [
  { customerId: "customer-acme", displayName: "Acme Corp" },
  { customerId: "customer-globex", displayName: "Globex Ltd" },
];

const RECENT_CASES: readonly CaseSummary[] = [
  {
    caseId: "case-1001",
    customerId: "customer-acme",
    title: "Renderer crash on startup",
    status: "new",
    createdAt: "2026-09-01T10:00:00.000Z",
  },
  {
    caseId: "case-1002",
    customerId: "customer-globex",
    title: "Audio service hang",
    status: "investigating",
    createdAt: "2026-09-02T12:00:00.000Z",
  },
];

function dashboardFixture(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    counts: { customers: 2, activeCases: 1, availableDumps: 3, processingDumps: 1 },
    customers: CUSTOMERS,
    recentCases: RECENT_CASES,
    ...overrides,
  };
}

/**
 * RTL's default getByText only inspects an element's direct text nodes, so a
 * phrase broken across child elements (e.g. "Added customer <strong>X</strong>")
 * needs a full-textContent matcher.
 */
function byText(fragment: string): (text: string, node: Element | null) => boolean {
  return (_text: string, node: Element | null): boolean =>
    node?.textContent?.includes(fragment) === true;
}

/** Mounts one element and returns an unmount handle (local render variant). */
function renderStandalone(fake: OperatorFakeHttpClient, element: ReactNode): { unmount: () => void } {
  const router = createMemoryRouter([{ path: "*", element }], { initialEntries: ["/"] });
  const view = render(
    <HttpClientProvider client={fake}>
      <RouterProvider router={router} />
    </HttpClientProvider>,
  );
  return { unmount: view.unmount };
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

function apiError(message: string, status = 422): HttpRequestError {
  return new HttpRequestError(message, { code: "invalid_request", status, retryable: false, path: "/api/v1/customers" });
}

function renderDashboard(fake: OperatorFakeHttpClient): void {
  renderFeaturePage(fake, <DashboardPage />, { entry: "/" });
}

describe("Dashboard operator page", () => {
  it("shows a polite loading state and then the bounded summary", async () => {
    const fake = new OperatorFakeHttpClient();
    const held = deferredResponder<DashboardResponse>();
    fake.setQueryResponder("/api/v1/dashboard", held.responder);
    renderDashboard(fake);

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Loading overview…");

    await act(async () => {
      held.resolve(dashboardFixture());
      await Promise.resolve();
    });

    // Bounded metrics plus links to recent cases.
    expect(await screen.findByText("Available dumps")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Renderer crash on startup/ })).toBeTruthy();
    // No content region is announced with role=alert on a normal page load.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders empty states when the ledger has no customers or cases", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder("/api/v1/dashboard", () =>
      dashboardFixture({ customers: [], recentCases: [] }),
    );
    renderDashboard(fake);

    expect(await screen.findByText("No cases yet")).toBeTruthy();
    expect(screen.getByText("No customers yet")).toBeTruthy();
  });

  it("shows a retryable page error and recovers on Try again", async () => {
    const fake = new OperatorFakeHttpClient();
    let calls = 0;
    fake.setQueryResponder("/api/v1/dashboard", () => {
      calls += 1;
      if (calls === 1) {
        throw new HttpRequestError("The overview could not be loaded.", {
          code: "internal_error",
          status: 503,
          retryable: true,
          path: "/api/v1/dashboard",
        });
      }
      return dashboardFixture();
    });
    const user = userEvent.setup();
    renderDashboard(fake);

    expect(await screen.findByText("The overview could not be loaded.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Available dumps")).toBeTruthy();
    expect(fake.queryCalls.filter((call) => call.path === "/api/v1/dashboard")).toHaveLength(2);
  });

  it("creates a customer: pending state, success summary, focus, input clear, and refetch", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder("/api/v1/dashboard", () => dashboardFixture());
    const mutation = deferredResponder<{ readonly customer: CustomerSummary }>();
    fake.setMutationResponder("POST", "/api/v1/customers", mutation.responder);
    const user = userEvent.setup();
    renderDashboard(fake);

    const nameInput = await screen.findByLabelText("Display name");
    await user.type(nameInput, "Umbrella Research");
    await user.click(screen.getByRole("button", { name: "Add customer" }));

    const pendingButton = await screen.findByRole("button", { name: "Adding…" });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);
    expect((nameInput as HTMLInputElement).disabled).toBe(true);

    await act(async () => {
      mutation.resolve({ customer: { customerId: "customer-umbrella", displayName: "Umbrella Research" } });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Success summary becomes visible and focus moved onto it.
    await waitFor(() => {
      expect(screen.getAllByText(byText("Added customer Umbrella Research")).length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(document.activeElement?.textContent).toContain("Added customer Umbrella Research");
    });
    // The authoritative dashboard was refetched after the mutation.
    await waitFor(() => {
      expect(fake.queryCalls.filter((call) => call.path === "/api/v1/dashboard")).toHaveLength(2);
    });
    expect((nameInput as HTMLInputElement).value).toBe("");
  });

  it("surfaces a customer-creation failure and moves focus to the alert", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder("/api/v1/dashboard", () => dashboardFixture());
    fake.setMutationResponder("POST", "/api/v1/customers", () => {
      throw apiError("A customer with that display name already exists.");
    });
    const user = userEvent.setup();
    renderDashboard(fake);

    const nameInput = await screen.findByLabelText("Display name");
    await user.type(nameInput, "Acme Corp");
    await user.click(screen.getByRole("button", { name: "Add customer" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("A customer with that display name already exists.");
    await waitFor(() => {
      expect(document.activeElement?.textContent).toContain("A customer with that display name already exists.");
    });
    expect(screen.queryByText(byText("Added customer"))).toBeNull();
    expect((screen.getByRole("button", { name: "Add customer" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("creates a case under one customer with a link to its detail page", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder("/api/v1/dashboard", () => dashboardFixture());
    const created: CaseSummary = {
      caseId: "case-2001",
      customerId: "customer-acme",
      title: "GPU driver reset",
      status: "new",
      createdAt: "2026-09-03T08:00:00.000Z",
    };
    fake.setMutationResponder("POST", "/api/v1/customers/customer-acme/cases", () => created);
    const user = userEvent.setup();
    renderDashboard(fake);

    // Scope to the Acme customer card (the Customers panel heading is unique).
    const customersPanel = (await screen.findByRole("heading", { name: "Customers" })).closest(".panel");
    if (customersPanel === null) throw new Error("customers panel not found");
    const acmeCard = within(customersPanel as HTMLElement).getByText("Acme Corp").closest(".customer-card");
    if (acmeCard === null) throw new Error("customer card not found");
    const withinCard = within(acmeCard as HTMLElement);
    await user.type(withinCard.getByLabelText("New case"), "GPU driver reset");
    await user.click(withinCard.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(withinCard.getAllByText(byText("Created case GPU driver reset")).length).toBeGreaterThan(0);
    });
    const openLink = withinCard.getByRole("link", { name: "Open case" });
    expect(openLink.getAttribute("href")).toBe("/cases/case-2001");
    await waitFor(() => {
      expect(fake.queryCalls.filter((call) => call.path === "/api/v1/dashboard")).toHaveLength(2);
    });
  });

  it("aborts the in-flight dashboard load on unmount", async () => {
    const fake = new OperatorFakeHttpClient();
    const held = deferredResponder<DashboardResponse>();
    fake.setQueryResponder("/api/v1/dashboard", held.responder);
    const { unmount } = renderStandalone(fake, <DashboardPage />);

    await screen.findByText("Loading overview…");
    unmount();

    await waitFor(() => {
      expect(fake.abortedSignals.length).toBeGreaterThan(0);
    });
    await act(async () => {
      held.resolve(dashboardFixture());
      await Promise.resolve();
    });
  });
});
