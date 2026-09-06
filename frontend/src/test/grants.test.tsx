/**
 * Upload grant operator tests (T5, design section 7.5).
 *
 * Grants are composed on the real CaseDetailPage: the create-grant form
 * (bounded validForHours/maxBytes validation), the one-time shareable URL
 * built ONLY from `location.origin + uploadPath` (never the Host header),
 * route-local secret lifecycle (gone after the page unmounts), and a
 * confirmation-gated revoke. Each successful mutation refetches authoritative
 * case state. Covers pending/success/failure for both mutations.
 */

import { act, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { CreateGrantResponse, CaseDetailResponse, RevokeGrantResponse } from "@dump-ledger/http-contracts";
import { HttpRequestError } from "../shared/http-client";
import { CaseDetailPage } from "../features/cases/CaseDetailPage";
import { HttpClientProvider } from "../shared/http-client-context";
import {
  OperatorFakeHttpClient,
  renderFeaturePage,
  type OperatorResponder,
} from "./operator-fake-http-client";
import { caseDetailFixture, caseGrant, issuedGrantRecord } from "./operator-fixtures";

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

function apiError(message: string, status = 422): HttpRequestError {
  return new HttpRequestError(message, { code: "invalid_request", status, retryable: false, path: "/api/v1/cases/case-1001/grants" });
}

const DETAIL_PATH = "/api/v1/cases/case-1001";
const GRANTS_PATH = "/api/v1/cases/case-1001/grants";
const UPLOAD_PATH = "/upload#grant=abc123DEF456ghijklmnopqrstuvwxyz";

function renderStandalone(
  fake: OperatorFakeHttpClient,
  element: ReactNode,
): { unmount: () => void } {
  const router = createMemoryRouter([{ path: "/cases/:caseId", element }], {
    initialEntries: ["/cases/case-1001"],
  });
  const view = render(
    <HttpClientProvider client={fake}>
      <RouterProvider router={router} />
    </HttpClientProvider>,
  );
  return { unmount: view.unmount };
}

function renderCaseDetail(fake: OperatorFakeHttpClient): void {
  renderFeaturePage(fake, <CaseDetailPage />, { entry: "/cases/case-1001", path: "/cases/:caseId" });
}

describe("Upload grant operator flows", () => {
  it("validates bounded hours and bytes before submitting", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () => caseDetailFixture());
    const user = userEvent.setup();
    renderCaseDetail(fake);

    await screen.findByText("Renderer crash on startup");
    const hours = screen.getByLabelText("Valid for");
    const bytes = screen.getByLabelText("Maximum bytes");
    // Defaults are present so a grant can be created with one click.
    expect((hours as HTMLInputElement).value).toBe("24");
    expect((bytes as HTMLInputElement).value).toBe("10737418240");

    // 0 hours is outside the bounded range.
    await user.clear(hours);
    await user.type(hours, "0");
    await user.click(screen.getByRole("button", { name: "Generate secure link" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Whole hours from 1 to 8784.");

    // A non-numeric byte ceiling is rejected.
    await user.clear(hours);
    await user.type(hours, "48");
    await user.clear(bytes);
    await user.type(bytes, "lots");
    await user.click(screen.getByRole("button", { name: "Generate secure link" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Enter a whole number of bytes greater than zero.",
    );
    // Nothing reached the server.
    expect(fake.mutationCalls).toHaveLength(0);
  });

  it("creates a grant and reveals a share URL built from location.origin + uploadPath", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () => caseDetailFixture());
    const mutation = deferredResponder<CreateGrantResponse>();
    fake.setMutationResponder("POST", GRANTS_PATH, mutation.responder);
    const user = userEvent.setup();
    renderCaseDetail(fake);

    await screen.findByText("Renderer crash on startup");
    await user.click(screen.getByRole("button", { name: "Generate secure link" }));

    const pendingButton = await screen.findByRole("button", { name: "Generating…" });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      mutation.resolve({
        grant: issuedGrantRecord("grant-21"),
        uploadPath: UPLOAD_PATH,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // The share field holds origin + the server-relative path, verbatim.
    const shareInput = (await screen.findByLabelText("Shareable upload URL")) as HTMLInputElement;
    expect(shareInput.value).toBe(`${window.location.origin}${UPLOAD_PATH}`);
    // The body sent the bounded, canonical-decimal request.
    const calls = fake.mutationCalls.filter((call) => call.method === "POST" && call.path === GRANTS_PATH);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ validForHours: 24, maxBytes: "10737418240" });
    // Authoritative case detail was refetched after the mutation.
    await waitFor(() => {
      expect(fake.queryCalls.filter((call) => call.path === DETAIL_PATH)).toHaveLength(2);
    });
  });

  it("surfaces a grant-creation failure and moves focus to the alert", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () => caseDetailFixture());
    fake.setMutationResponder("POST", GRANTS_PATH, () => {
      throw apiError("The case could not accept another upload grant.");
    });
    const user = userEvent.setup();
    renderCaseDetail(fake);

    await screen.findByText("Renderer crash on startup");
    await user.click(screen.getByRole("button", { name: "Generate secure link" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The case could not accept another upload grant.");
    await waitFor(() => {
      expect(document.activeElement?.textContent).toContain("The case could not accept another upload grant.");
    });
    expect(screen.queryByLabelText("Shareable upload URL")).toBeNull();
    expect((screen.getByRole("button", { name: "Generate secure link" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the share secret only for the route instance and clears it on unmount", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () => caseDetailFixture());
    fake.setMutationResponder("POST", GRANTS_PATH, () => ({
      grant: issuedGrantRecord("grant-31"),
      uploadPath: UPLOAD_PATH,
    }));
    const user = userEvent.setup();
    const { unmount } = renderStandalone(fake, <CaseDetailPage />);

    await screen.findByText("Renderer crash on startup");
    await user.click(screen.getByRole("button", { name: "Generate secure link" }));
    await screen.findByLabelText("Shareable upload URL");

    // Navigating away unmounts the route-local state that held the secret.
    unmount();
    await waitFor(() => {
      expect(fake.abortedSignals.some((signal) => signal.aborted)).toBe(true);
    });
  });

  it("revokes an issued grant only after confirmation and refetches", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () =>
      caseDetailFixture({
        grants: [caseGrant("grant-41", "issued"), caseGrant("grant-42", "consumed")],
      }),
    );
    const mutation = deferredResponder<RevokeGrantResponse>();
    fake.setMutationResponder("POST", "/api/v1/grants/grant-41/revoke", mutation.responder);
    const user = userEvent.setup();
    renderCaseDetail(fake);

    await screen.findByText("Renderer crash on startup");
    // Consumed grants never offer a revoke control.
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Revoke upload grant");
    await user.click(within(dialog).getByRole("button", { name: "Revoke grant" }));

    // The confirmation dialog closes immediately; the row's revoke control
    // shows the optimistic pending state while the request is in flight.
    expect(screen.queryByRole("dialog")).toBeNull();
    const rowRevokePending = await screen.findByRole("button", { name: "Revoking…" });
    expect((rowRevokePending as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      mutation.resolve({
        grant: { ...issuedGrantRecord("grant-41"), state: "revoked" },
      } as RevokeGrantResponse);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getAllByText(byText("Revoked grant grant-41.")).length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => {
      expect(fake.queryCalls.filter((call) => call.path === DETAIL_PATH)).toHaveLength(2);
    });
    // The revoke target was the confirmed grant.
    const revokeCalls = fake.mutationCalls.filter(
      (call) => call.method === "POST" && call.path === "/api/v1/grants/grant-41/revoke",
    );
    expect(revokeCalls).toHaveLength(1);
  });

  it("surfaces a revoke failure without removing the row", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () =>
      caseDetailFixture({ grants: [caseGrant("grant-51", "issued")] }),
    );
    fake.setMutationResponder("POST", "/api/v1/grants/grant-51/revoke", () => {
      throw new HttpRequestError("The grant is no longer revocable.", {
        code: "grant_unavailable",
        status: 409,
        retryable: false,
        path: "/api/v1/grants/grant-51/revoke",
      });
    });
    const user = userEvent.setup();
    renderCaseDetail(fake);

    await screen.findByText("Renderer crash on startup");
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Revoke grant" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The grant is no longer revocable.");
    // The grant row is still present and the case was not refetched.
    expect(screen.getByText("grant-51")).toBeTruthy();
    expect(fake.queryCalls.filter((call) => call.path === DETAIL_PATH)).toHaveLength(1);
    // The row's revoke control is usable again.
    expect((screen.getByRole("button", { name: "Revoke" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
