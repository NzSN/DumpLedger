/**
 * Case detail operator tests (T5, design sections 7.4 and 8.4).
 *
 * Renders the real CaseDetailPage against an OperatorFakeHttpClient serving
 * GET /api/v1/cases/:caseId plus POST transitions. Covers loading/ready/error
 * states; the five lifecycle controls driven entirely by the server-returned
 * allowedActions (enabled vs disabled + "Not available" notes); a transition
 * POST followed by an authoritative refetch with NO optimistic lifecycle
 * change (the only feedback is the disabled "Applying…" control); CloseCase's
 * confirmation and its revoked-grant count/identifiers in the result summary;
 * a server-rejected illegal transition surfaced as a focus-moved alert; the
 * manifest as an ordinary anchor navigation; and abort-on-unmount.
 */

import { act, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { CaseAction, CaseDetailResponse, TransitionResponse } from "@dump-ledger/http-contracts";
import { HttpRequestError } from "../shared/http-client";
import { CaseDetailPage } from "../features/cases/CaseDetailPage";
import { HttpClientProvider } from "../shared/http-client-context";
import {
  OperatorFakeHttpClient,
  renderFeaturePage,
  type OperatorResponder,
} from "./operator-fake-http-client";
import {
  caseDetailFixture,
  caseGrant,
  caseDump,
  transitionFixture,
  activityItem,
} from "./operator-fixtures";

/** Full-text matcher for phrases split across child elements. */
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

function apiError(message: string, code: "invalid_transition" | "internal_error" = "invalid_transition", retryable = false): HttpRequestError {
  return new HttpRequestError(message, {
    code,
    status: code === "internal_error" ? 503 : 409,
    retryable,
    path: "/api/v1/cases/case-1001/transitions",
  });
}

/** Mounts CaseDetailPage and returns an unmount handle (local render variant). */
function renderStandalone(
  fake: OperatorFakeHttpClient,
  element: ReactNode,
  entry = "/cases/case-1001",
): { unmount: () => void } {
  const router = createMemoryRouter([{ path: "/cases/:caseId", element }], { initialEntries: [entry] });
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

const DETAIL_PATH = "/api/v1/cases/case-1001";
const TRANSITION_PATH = "/api/v1/cases/case-1001/transitions";

describe("Case detail operator page", () => {
  it("shows a polite loading state and then the bounded detail with manifest link", async () => {
    const fake = new OperatorFakeHttpClient();
    const held = deferredResponder<CaseDetailResponse>();
    fake.setQueryResponder(DETAIL_PATH, held.responder);
    renderCaseDetail(fake);

    expect(await screen.findByRole("heading", { name: "Case detail" })).toBeTruthy();
    expect(screen.getByText("Case case-1001")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Loading case…");

    await act(async () => {
      held.resolve(caseDetailFixture({ activity: [activityItem("2026-09-01T10:00:00.000Z", "CaseOpened")] }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Title + facts from the detail body.
    expect(await screen.findByText("Renderer crash on startup")).toBeTruthy();
    expect(screen.getByText("Crash dumps")).toBeTruthy();
    expect(screen.getByText("No dumps attached")).toBeTruthy();
    // Manifest is an ordinary same-origin navigation/download.
    const manifest = screen.getByRole("link", { name: "Export manifest" });
    expect(manifest.getAttribute("href")).toBe(`${DETAIL_PATH}/manifest`);
    expect(manifest.getAttribute("download")).toBe("case-1001-manifest.json");
    expect(fake.queryCalls.filter((call) => call.path === DETAIL_PATH)).toHaveLength(1);
  });

  it("drives the five lifecycle controls from the server's allowedActions", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () =>
      caseDetailFixture({ allowedActions: ["StartInvestigation", "ResolveCase"] }),
    );
    renderCaseDetail(fake);

    await screen.findByText("Renderer crash on startup");

    const start = screen.getByRole("button", { name: "Start investigation" });
    const wait = screen.getByRole("button", { name: "Wait for customer" });
    const resume = screen.getByRole("button", { name: "Resume investigation" });
    const resolve = screen.getByRole("button", { name: "Resolve case" });
    const close = screen.getByRole("button", { name: "Close case" });

    // All five controls are visible; only server-allowed ones are enabled.
    expect((start as HTMLButtonElement).disabled).toBe(false);
    expect((resolve as HTMLButtonElement).disabled).toBe(false);
    expect((wait as HTMLButtonElement).disabled).toBe(true);
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    expect((close as HTMLButtonElement).disabled).toBe(true);
    // Disallowed actions explain why they are disabled.
    expect(screen.getAllByText("Not available in this case state.")).toHaveLength(3);
  });

  it("posts a transition then refetches authoritative detail with no optimistic change", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () =>
      caseDetailFixture({ allowedActions: ["StartInvestigation", "CloseCase"] }),
    );
    const mutation = deferredResponder<TransitionResponse>();
    fake.setMutationResponder("POST", TRANSITION_PATH, mutation.responder);
    const user = userEvent.setup();
    renderCaseDetail(fake);

    await screen.findByText("Renderer crash on startup");
    // Case starts "new" (status pill in the header actions).
    expect(screen.getByText("New")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Start investigation" }));

    // Optimistic feedback is limited to the disabled, relabelled control.
    const pendingButton = await screen.findByRole("button", { name: "Applying…" });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);
    // No lifecycle change was optimistically rendered.
    expect(screen.getByText("New")).toBeTruthy();
    expect(fake.queryCalls.filter((call) => call.path === DETAIL_PATH)).toHaveLength(1);

    await act(async () => {
      mutation.resolve(transitionFixture("StartInvestigation", "investigating"));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Result summary names the applied action and resulting status.
    await waitFor(() => {
      expect(screen.getAllByText(byText("Applied Start investigation — the case is now Investigating")).length).toBeGreaterThan(0);
    });
    // Authoritative detail was refetched after the mutation.
    await waitFor(() => {
      expect(fake.queryCalls.filter((call) => call.path === DETAIL_PATH)).toHaveLength(2);
    });
    // The request carried the action the UI intended.
    const calls = fake.mutationCalls.filter((call) => call.method === "POST" && call.path === TRANSITION_PATH);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ action: "StartInvestigation" });
  });

  it("surfaces a server-rejected illegal transition and keeps the current state", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () =>
      caseDetailFixture({ allowedActions: ["StartInvestigation", "WaitForCustomer"] }),
    );
    fake.setMutationResponder("POST", TRANSITION_PATH, () => {
      throw apiError("This action is not allowed in the current case state.");
    });
    const user = userEvent.setup();
    renderCaseDetail(fake);

    await screen.findByText("Renderer crash on startup");
    await user.click(screen.getByRole("button", { name: "Start investigation" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This action is not allowed in the current case state.");
    // Focus moved onto the mutation error summary.
    await waitFor(() => {
      expect(document.activeElement?.textContent).toContain("This action is not allowed in the current case state.");
    });
    // No success summary, no refetch on failure, controls re-enabled.
    expect(screen.queryByText(byText("Applied Start investigation"))).toBeNull();
    expect(fake.queryCalls.filter((call) => call.path === DETAIL_PATH)).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Start investigation" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("confirms CloseCase and reports the revoked grant count and identifiers", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(DETAIL_PATH, () =>
      caseDetailFixture({
        status: "investigating",
        allowedActions: ["ResolveCase", "CloseCase"],
        grants: [caseGrant("grant-11", "issued"), caseGrant("grant-12", "issued"), caseGrant("grant-13", "consumed")],
      }),
    );
    const mutation = deferredResponder<TransitionResponse>();
    fake.setMutationResponder("POST", TRANSITION_PATH, mutation.responder);
    const user = userEvent.setup();
    renderCaseDetail(fake);

    await screen.findByText("Renderer crash on startup");
    // Confirmation appears before the destructive action runs.
    await user.click(screen.getByRole("button", { name: "Close case" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Close case?");
    expect(dialog.textContent).toContain("2 currently issued");

    const confirmButton = within(dialog).getByRole("button", { name: "Close case" });
    await user.click(confirmButton);

    // Pending state disables the dialog while the request is in flight.
    const pendingConfirm = within(await screen.findByRole("dialog")).getByRole("button", { name: "Close case" });
    expect((pendingConfirm as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      mutation.resolve(
        transitionFixture("CloseCase", "closed", { count: 2, grantIds: ["grant-11", "grant-12"] }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // Result summary reports number and identifiers of revoked grants.
    await waitFor(() => {
      expect(screen.getAllByText(byText("The server revoked 2 upload grants")).length).toBeGreaterThan(0);
    });
    expect(screen.getByText("grant-11, grant-12")).toBeTruthy();
    // Dialog closed and authoritative detail refetched.
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => {
      expect(fake.queryCalls.filter((call) => call.path === DETAIL_PATH)).toHaveLength(2);
    });
  });

  it("aborts the in-flight detail load on unmount", async () => {
    const fake = new OperatorFakeHttpClient();
    const held = deferredResponder<CaseDetailResponse>();
    fake.setQueryResponder(DETAIL_PATH, held.responder);
    const { unmount } = renderStandalone(fake, <CaseDetailPage />);

    await screen.findByText("Loading case…");
    unmount();

    await waitFor(() => {
      expect(fake.abortedSignals.some((signal) => signal.aborted)).toBe(true);
    });
    await act(async () => {
      held.resolve(caseDetailFixture());
      await Promise.resolve();
    });
  });

  it("recovers from a retryable page-load error", async () => {
    const fake = new OperatorFakeHttpClient();
    let calls = 0;
    fake.setQueryResponder(DETAIL_PATH, () => {
      calls += 1;
      if (calls === 1) {
        throw apiError("The case could not be loaded.", "internal_error", true);
      }
      return caseDetailFixture();
    });
    const user = userEvent.setup();
    renderCaseDetail(fake);

    expect(await screen.findByText("The case could not be loaded.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Renderer crash on startup")).toBeTruthy();
    expect(fake.queryCalls.filter((call) => call.path === DETAIL_PATH)).toHaveLength(2);
  });
});
