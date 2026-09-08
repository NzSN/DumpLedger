/**
 * Export / Import section tests (import/export design, "HTTP and UI surface").
 *
 * Renders the real TransferSection with an OperatorFakeHttpClient serving the
 * operations transfer endpoints. Covers the export list rendering (status,
 * human-readable size, failure detail, download anchor for sealed bundles),
 * the create flow with its one-transfer-at-a-time gating, the confirmed
 * delete, the import path validation and strict-confirmation gating, import
 * progress polling until the terminal status, and the inline 409 "another
 * transfer is running" notice. Poll intervals are injected per test.
 */

import { act } from "react";
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpRequestError } from "../shared/http-client";
import { TransferSection } from "../features/transfer/TransferSection";
import {
  OperatorFakeHttpClient,
  renderFeaturePage,
  type OperatorResponder,
} from "./operator-fake-http-client";
import { exportSummary, importProgress } from "./operator-fixtures";

const EXPORTS_PATH = "/api/v1/operations/exports";
const IMPORTS_PATH = "/api/v1/operations/imports";

function deferredResponder<T>(): { responder: OperatorResponder; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { responder: () => promise, resolve };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function renderTransfer(
  fake: OperatorFakeHttpClient,
  options: { readonly exportPollIntervalMs?: number; readonly importPollIntervalMs?: number } = {},
): void {
  renderFeaturePage(
    fake,
    <TransferSection
      exportPollIntervalMs={options.exportPollIntervalMs ?? 0}
      importPollIntervalMs={options.importPollIntervalMs ?? 1_000}
    />,
    { entry: "/operations" },
  );
}

describe("Export / Import section", () => {
  it("renders the export list with status, size, and failure detail", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(EXPORTS_PATH, () => ({
      exports: [
        exportSummary("export-running", { status: "running" }),
        exportSummary("export-sealed", { status: "sealed", byteSize: "10485760" }),
        exportSummary("export-failed", { status: "failed", error: "Vault read failed." }),
      ],
    }));
    renderTransfer(fake);

    // Sealed bundle: human-readable size, formatted timestamp, download anchor.
    expect(await screen.findByText("export-sealed")).toBeTruthy();
    expect(screen.getByText("Sealed")).toBeTruthy();
    expect(screen.getByText("10 MiB")).toBeTruthy();
    expect(screen.getAllByText("Created 2026-09-05 12:00:00 UTC")).toHaveLength(3);
    const download = screen.getByRole("link", { name: "Download bundle" });
    expect(download.getAttribute("href")).toBe("/api/v1/operations/exports/export-sealed/file");
    expect(download.hasAttribute("download")).toBe(true);

    // Running bundle: no size yet, no download, and it gates the create button.
    expect(screen.getByText("export-running")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getAllByText("Unknown")).toHaveLength(2);
    expect((screen.getByRole("button", { name: "Create export bundle" }) as HTMLButtonElement).disabled).toBe(true);

    // Failed bundle: the server detail is surfaced verbatim.
    expect(screen.getByText("export-failed")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Vault read failed.")).toBeTruthy();
  });

  it("creates an export bundle and refreshes the list", async () => {
    const fake = new OperatorFakeHttpClient();
    let listCalls = 0;
    fake.setQueryResponder(EXPORTS_PATH, () => {
      listCalls += 1;
      return listCalls === 1
        ? { exports: [] }
        : { exports: [exportSummary("export-new", { status: "running" })] };
    });
    fake.setMutationResponder("POST", EXPORTS_PATH, () => ({ exportId: "export-new" }));
    const user = userEvent.setup();
    renderTransfer(fake);

    expect(await screen.findByText("No export bundles")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Create export bundle" }));

    expect(fake.mutationCalls.some((call) => call.method === "POST" && call.path === EXPORTS_PATH)).toBe(true);
    expect(await screen.findByText("export-new")).toBeTruthy();
    expect(screen.getByText(/export-new is being written/)).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    // The new running bundle keeps the create button gated.
    expect((screen.getByRole("button", { name: "Create export bundle" }) as HTMLButtonElement).disabled).toBe(true);
    expect(listCalls).toBe(2);
  });

  it("deletes an export bundle only after confirmation", async () => {
    const fake = new OperatorFakeHttpClient();
    let deleted = false;
    fake.setQueryResponder(EXPORTS_PATH, () =>
      deleted ? { exports: [] } : { exports: [exportSummary("export-1", { status: "sealed" })] },
    );
    fake.setMutationResponder("DELETE", `${EXPORTS_PATH}/export-1`, () => {
      deleted = true;
      return { deleted: true };
    });
    const user = userEvent.setup();
    renderTransfer(fake);

    await screen.findByText("export-1");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("dialog", { name: "Delete export bundle" })).toBeTruthy();

    // Cancel keeps the bundle and never calls the server.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(fake.mutationCalls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    expect(screen.getByText("export-1")).toBeTruthy();

    // Confirm deletes and the refreshed list drops the row.
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete bundle" }));
    expect(await screen.findByText("No export bundles")).toBeTruthy();
    const deletes = fake.mutationCalls.filter((call) => call.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.path).toBe(`${EXPORTS_PATH}/export-1`);
  });

  it("shows the inline notice when create meets another running transfer", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(EXPORTS_PATH, () => ({ exports: [] }));
    fake.setMutationResponder("POST", EXPORTS_PATH, () => {
      throw new HttpRequestError("That action is not allowed from the current state.", {
        code: "invalid_transition",
        status: 409,
        retryable: false,
        path: EXPORTS_PATH,
      });
    });
    const user = userEvent.setup();
    renderTransfer(fake);

    await screen.findByText("No export bundles");
    await user.click(screen.getByRole("button", { name: "Create export bundle" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Another transfer is already running.");
    expect(alert.textContent).not.toContain("That action is not allowed");
  });

  it("keeps an export list load failure visible", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(EXPORTS_PATH, () => {
      throw new HttpRequestError("This action is not allowed.", {
        code: "forbidden",
        status: 403,
        retryable: false,
        path: EXPORTS_PATH,
      });
    });
    renderTransfer(fake);

    expect(await screen.findByText("This action is not allowed.")).toBeTruthy();
  });

  it("gates import behind path validation and the strict confirmation", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(EXPORTS_PATH, () => ({ exports: [] }));
    fake.setMutationResponder("POST", IMPORTS_PATH, () => ({ importId: "import-1" }));
    const user = userEvent.setup();
    renderTransfer(fake);

    // The strict copy is part of the gating surface.
    expect(await screen.findByText(/If the bundle was exported under a different grant key/)).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Start import" }) as HTMLButtonElement;
    const pathInput = screen.getByLabelText("Bundle path on the server");
    const confirm = screen.getByRole("checkbox", { name: /I understand import requires an empty ledger/ });

    expect(submit.disabled).toBe(true);
    await user.type(pathInput, "/srv/bundles/bundle.tar");
    expect(submit.disabled).toBe(true);

    await user.click(confirm);
    expect(submit.disabled).toBe(false);

    // An empty path is rejected client-side; no mutation is sent.
    await user.clear(pathInput);
    await user.click(submit);
    const fieldError = await screen.findByRole("alert");
    expect(fieldError.textContent).toBe("Enter the path of an export bundle on the server filesystem.");
    expect(fake.mutationCalls.filter((call) => call.path === IMPORTS_PATH)).toHaveLength(0);
  });

  it("starts an import and polls progress until the terminal status", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(EXPORTS_PATH, () => ({ exports: [] }));
    fake.setMutationResponder("POST", IMPORTS_PATH, () => ({ importId: "import-1" }));
    let progressCalls = 0;
    fake.setQueryResponder(`${IMPORTS_PATH}/import-1`, () => {
      progressCalls += 1;
      if (progressCalls < 3) {
        return importProgress("import-1", "running", { verified: progressCalls, imported: progressCalls - 1 });
      }
      return importProgress("import-1", "finished", { verified: 3, imported: 2, rejected: 1, skipped: 0 });
    });
    const user = userEvent.setup();
    renderTransfer(fake, { importPollIntervalMs: 30 });

    await user.type(screen.getByLabelText("Bundle path on the server"), "/srv/bundles/bundle.tar");
    await user.click(screen.getByRole("checkbox", { name: /I understand/ }));
    await user.click(screen.getByRole("button", { name: "Start import" }));

    // The mutation carried the encoded path body.
    const start = fake.mutationCalls.find((call) => call.path === IMPORTS_PATH);
    expect(start?.method).toBe("POST");
    expect(start?.body).toEqual({ path: "/srv/bundles/bundle.tar" });

    // Live counters appear while running…
    expect(await screen.findByText("Running")).toBeTruthy();
    // …then the terminal summary replaces them and polling stops.
    expect(await screen.findByText(/Import finished: 2 imported, 1 rejected, 0 skipped \(3 verified\)\./)).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();

    const callsAtTerminal = progressCalls;
    await sleep(140);
    expect(progressCalls).toBe(callsAtTerminal);
  });

  it("shows a failed import with the server detail", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(EXPORTS_PATH, () => ({ exports: [] }));
    fake.setMutationResponder("POST", IMPORTS_PATH, () => ({ importId: "import-1" }));
    fake.setQueryResponder(`${IMPORTS_PATH}/import-1`, () =>
      importProgress("import-1", "failed", { verified: 1, imported: 0, rejected: 1, error: "Manifest digest mismatch." }),
    );
    const user = userEvent.setup();
    renderTransfer(fake, { importPollIntervalMs: 30 });

    await user.type(screen.getByLabelText("Bundle path on the server"), "/srv/bundles/bundle.tar");
    await user.click(screen.getByRole("checkbox", { name: /I understand/ }));
    await user.click(screen.getByRole("button", { name: "Start import" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Manifest digest mismatch.");
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("shows the inline notice when import start meets another running transfer", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(EXPORTS_PATH, () => ({ exports: [] }));
    fake.setMutationResponder("POST", IMPORTS_PATH, () => {
      throw new HttpRequestError("That action is not allowed from the current state.", {
        code: "invalid_transition",
        status: 409,
        retryable: false,
        path: IMPORTS_PATH,
      });
    });
    const user = userEvent.setup();
    renderTransfer(fake);

    await user.type(await screen.findByLabelText("Bundle path on the server"), "/srv/bundles/bundle.tar");
    await user.click(screen.getByRole("checkbox", { name: /I understand/ }));
    await user.click(screen.getByRole("button", { name: "Start import" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Another transfer is already running.");
  });

  it("holds import polling to one outstanding request while a poll is slow", async () => {
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(EXPORTS_PATH, () => ({ exports: [] }));
    fake.setMutationResponder("POST", IMPORTS_PATH, () => ({ importId: "import-1" }));
    const held = deferredResponder<unknown>();
    let progressCalls = 0;
    fake.setQueryResponder(`${IMPORTS_PATH}/import-1`, (request) => {
      progressCalls += 1;
      return progressCalls === 1
        ? importProgress("import-1", "running", { verified: 1 })
        : held.responder(request);
    });
    const user = userEvent.setup();
    renderTransfer(fake, { importPollIntervalMs: 30 });

    await user.type(await screen.findByLabelText("Bundle path on the server"), "/srv/bundles/bundle.tar");
    await user.click(screen.getByRole("checkbox", { name: /I understand/ }));
    await user.click(screen.getByRole("button", { name: "Start import" }));

    await waitFor(() => expect(progressCalls).toBe(2));
    // Many ticks pass while the second poll is held open; none overlap it.
    await sleep(150);
    expect(progressCalls).toBe(2);

    await act(async () => {
      held.resolve(importProgress("import-1", "finished", { verified: 2, imported: 2 }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByText(/Import finished: 2 imported/)).toBeTruthy();
  });
});
