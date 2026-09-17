/**
 * Individual customer panel tests: record + bounded case list rendering,
 * case-row navigation, create-case reload, and the not-found state.
 */

import { StrictMode, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { HttpRequestError } from "../shared/http-client";
import type { CustomerDetailResponse } from "@dump-ledger/http-contracts";
import { CustomerDetailPage } from "../features/customers/CustomerDetailPage";
import { OperatorFakeHttpClient, renderFeaturePage } from "./operator-fake-http-client";

const CUSTOMER_ID = "customer_01JTEST0000000000000000001";
const DETAIL_PATH = `/api/v1/customers/${CUSTOMER_ID}`;

function detailFixture(cases: CustomerDetailResponse["cases"] = []): CustomerDetailResponse {
  return {
    customer: {
      customerId: CUSTOMER_ID,
      displayName: "Acme Corp",
      createdAt: "2026-09-01T09:00:00.000Z",
    },
    cases,
  };
}

function renderPanel(fake: OperatorFakeHttpClient): void {
  renderFeaturePage(fake, <CustomerDetailPage />, {
    entry: `/customers/${CUSTOMER_ID}`,
    path: "/customers/:customerId",
  });
}

describe("individual customer panel", () => {
  it("renders the customer record and their cases with status pills and links", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () => detailFixture([
      { caseId: "case-1001", customerId: CUSTOMER_ID, title: "Crash on 1.4.2", status: "investigating", createdAt: "2026-09-01T10:00:00.000Z" },
      { caseId: "case-1002", customerId: CUSTOMER_ID, title: "Hang on save", status: "resolved", createdAt: "2026-09-02T10:00:00.000Z" },
    ]));
    renderPanel(fake);

    expect((await screen.findByRole("heading", { name: "Acme Corp" })).textContent).toBe("Acme Corp");
    expect(screen.getByText(CUSTOMER_ID)).toBeTruthy();
    expect(await screen.findByText("Crash on 1.4.2")).toBeTruthy();
    expect(screen.getByText("Hang on save")).toBeTruthy();
    expect(screen.getByText("Investigating")).toBeTruthy();
    expect(screen.getByText("Resolved")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Crash on 1\.4\.2/ });
    expect(link.getAttribute("href")).toBe("/cases/case-1001");
  });

  it("shows the empty state when the customer has no cases", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () => detailFixture());
    renderPanel(fake);

    expect(await screen.findByText("No cases yet")).toBeTruthy();
    expect(screen.getByText(/Cases \(0\)/)).toBeTruthy();
  });

  it("renders a not-found panel for an unknown customer", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () => {
      throw new HttpRequestError("Not found.", { code: "not_found", status: 404, retryable: false, path: DETAIL_PATH });
    });
    renderPanel(fake);

    expect(await screen.findByText("Customer not found")).toBeTruthy();
  });

  it("creates a case from the panel and refetches the detail", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () => detailFixture());
    fake.setMutationResponder("POST", `/api/v1/customers/${CUSTOMER_ID}/cases`, () => ({
      caseId: "case-2001",
      customerId: CUSTOMER_ID,
      title: "New intake",
      status: "new",
      createdAt: "2026-09-03T10:00:00.000Z",
    }));
    renderPanel(fake);

    await screen.findByRole("heading", { name: "Acme Corp" });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New case"), "New intake");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => {
      expect(fake.queryCalls.filter((call) => call.path === DETAIL_PATH).length).toBe(2);
    });
  });

  it("keeps the panel stable across a StrictMode double-mount", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () => detailFixture());
    const ui: ReactNode = (
      <StrictMode>
        <CustomerDetailPage />
      </StrictMode>
    );
    renderFeaturePage(fake, ui, { entry: `/customers/${CUSTOMER_ID}`, path: "/customers/:customerId" });
    expect(await screen.findByRole("heading", { name: "Acme Corp" })).toBeTruthy();
  });
});
