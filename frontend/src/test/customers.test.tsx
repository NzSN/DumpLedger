/**
 * Customers operator tests (T5, design sections 7.3 and 8.4).
 *
 * CustomersPage loads the bounded dashboard representation and renders the
 * directory with shared customer/case creation. Covers loading, ready/empty,
 * and error states, plus create-customer and create-case failure visibility
 * with focus moved to the alert.
 */

import { act } from "react";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CustomerSummary, DashboardResponse } from "@dump-ledger/http-contracts";
import { HttpRequestError } from "../shared/http-client";
import { CustomersPage } from "../features/customers/CustomersPage";
import {
  OperatorFakeHttpClient,
  renderFeaturePage,
  type OperatorResponder,
} from "./operator-fake-http-client";

const CUSTOMERS: readonly CustomerSummary[] = [
  { customerId: "customer-alpha", displayName: "Alpha Systems" },
  { customerId: "customer-beta", displayName: "Beta Labs" },
];

function dashboardFixture(): DashboardResponse {
  return {
    counts: { customers: 2, activeCases: 1, availableDumps: 0, processingDumps: 0 },
    customers: CUSTOMERS,
    recentCases: [],
  };
}

function byText(fragment: string): (text: string, node: Element | null) => boolean {
  return (_text: string, node: Element | null): boolean =>
    node?.textContent?.includes(fragment) === true;
}

function renderCustomers(fake: OperatorFakeHttpClient): void {
  renderFeaturePage(fake, <CustomersPage />, { entry: "/" });
}

function deferredResponder<T>(): { responder: OperatorResponder; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { responder: () => promise, resolve };
}

describe("Customers operator page", () => {
  it("shows a polite loading state and then the directory", async () => {
    const fake = new OperatorFakeHttpClient();
    const held = deferredResponder<DashboardResponse>();
    fake.setQueryResponder("/api/v1/dashboard", held.responder);
    renderCustomers(fake);

    expect(await screen.findByRole("heading", { name: "Customers" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Loading customers…");

    await act(async () => {
      held.resolve(dashboardFixture());
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText("Alpha Systems")).toBeTruthy();
    expect(screen.getByText("Beta Labs")).toBeTruthy();
    // Each customer card exposes its own per-customer case creation form.
    expect(screen.getAllByRole("button", { name: "Create" })).toHaveLength(2);
  });

  it("renders the empty directory state", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder("/api/v1/dashboard", () =>
      dashboardFixture().customers.length === 0
        ? dashboardFixture()
        : { ...dashboardFixture(), customers: [], counts: { ...dashboardFixture().counts, customers: 0 } },
    );
    renderCustomers(fake);

    expect(await screen.findByText("No customers yet")).toBeTruthy();
  });

  it("shows a load error with a working retry", async () => {
    const fake = new OperatorFakeHttpClient();
    let calls = 0;
    fake.setQueryResponder("/api/v1/dashboard", () => {
      calls += 1;
      if (calls === 1) {
        throw new HttpRequestError("Customers could not be loaded.", {
          code: "internal_error",
          status: 500,
          retryable: true,
          path: "/api/v1/dashboard",
        });
      }
      return dashboardFixture();
    });
    const user = userEvent.setup();
    renderCustomers(fake);

    expect(await screen.findByText("Customers could not be loaded.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Alpha Systems")).toBeTruthy();
  });

  it("creates a customer and refetches the directory", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder("/api/v1/dashboard", () => dashboardFixture());
    fake.setMutationResponder("POST", "/api/v1/customers", () => ({
      customer: { customerId: "customer-gamma", displayName: "Gamma Works" },
    }));
    const user = userEvent.setup();
    renderCustomers(fake);

    const nameInput = await screen.findByLabelText("Display name");
    await user.type(nameInput, "Gamma Works");
    await user.click(screen.getByRole("button", { name: "Add customer" }));

    await waitFor(() => {
      expect(screen.getAllByText(byText("Added customer Gamma Works")).length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(fake.queryCalls.filter((call) => call.path === "/api/v1/dashboard")).toHaveLength(2);
    });
  });

  it("generates a customer with a random UUID display name from the dedicated button", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder("/api/v1/dashboard", () => dashboardFixture());
    fake.setMutationResponder("POST", "/api/v1/customers", (call) => {
      const body = call.body as { readonly displayName: string };
      return { customer: { customerId: "customer-generated", displayName: body.displayName } };
    });
    const user = userEvent.setup();
    renderCustomers(fake);

    await user.click(await screen.findByRole("button", { name: "Generate customer" }));

    await waitFor(() => {
      const calls = fake.mutationCalls.filter((call) => call.path === "/api/v1/customers");
      expect(calls).toHaveLength(1);
      const body = calls[0]!.body as { readonly displayName: string };
      expect(body.displayName).toMatch(/^customer_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
    await waitFor(() => {
      expect(fake.queryCalls.filter((call) => call.path === "/api/v1/dashboard")).toHaveLength(2);
    });
  });

  it("surfaces a create-customer failure with the alert focused", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder("/api/v1/dashboard", () => dashboardFixture());
    fake.setMutationResponder("POST", "/api/v1/customers", () => {
      throw new HttpRequestError("Customer names must be unique.", {
        code: "invalid_request",
        status: 422,
        retryable: false,
        path: "/api/v1/customers",
      });
    });
    const user = userEvent.setup();
    renderCustomers(fake);

    const nameInput = await screen.findByLabelText("Display name");
    await user.type(nameInput, "Alpha Systems");
    await user.click(screen.getByRole("button", { name: "Add customer" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Customer names must be unique.");
    await waitFor(() => {
      expect(document.activeElement?.textContent).toContain("Customer names must be unique.");
    });
  });

  it("surfaces a per-customer create-case failure inside the card", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder("/api/v1/dashboard", () => dashboardFixture());
    fake.setMutationResponder("POST", "/api/v1/customers/customer-alpha/cases", () => {
      throw new HttpRequestError("The case could not be created for this customer.", {
        code: "invalid_request",
        status: 422,
        retryable: false,
        path: "/api/v1/customers/customer-alpha/cases",
      });
    });
    const user = userEvent.setup();
    renderCustomers(fake);

    const alphaCard = (await screen.findByText("Alpha Systems")).closest(".customer-card");
    if (alphaCard === null) throw new Error("customer card not found");
    const card = within(alphaCard as HTMLElement);
    await user.type(card.getByLabelText("New case"), "Crash under load");
    await user.click(card.getByRole("button", { name: "Create" }));

    const alert = await card.findByRole("alert");
    expect(alert.textContent).toContain("The case could not be created for this customer.");
  });
});
