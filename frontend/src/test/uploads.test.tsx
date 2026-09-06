/**
 * Public uploader tests (T6, design sections 6, 7.6, 8.4, 9, 12).
 *
 * Renders the real App/router graph on /upload with a fake HTTP adapter that
 * models only the upload seam (composed here rather than modifying the shared
 * fake-http-client.ts helper). The fake mirrors the real client's observable
 * contract: uploads resolve to `UploadSuccess` or reject with
 * `HttpRequestError` / `AbortError`, and progress reaches the page through the
 * observer callbacks.
 *
 * Covers: fragment extraction + replaceState cleanup (incl. StrictMode),
 * missing/invalid grant guidance, selection and drag/drop, determinate
 * progress, every terminal state (201 available/rejected, 202
 * retry-queued/recovery-required, 404, 413, 503, abort/uncertain),
 * no-auto-retry, and accessibility roles/labels/focus. Global
 * fetch/XMLHttpRequest are never mocked.
 */

import { act, StrictMode, type ReactNode } from "react";
import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app/App";
import { createTestRouter } from "../app/router";
import { FakeHttpClient } from "./fake-http-client";
import {
  HttpRequestError,
  type UploadHandle,
  type UploadObserver,
  type UploadRequest,
  type UploadSuccess,
} from "../shared/http-client";

/** 32-char base64url secret (matches UPLOAD_GRANT_SECRET_PATTERN). */
const VALID_GRANT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
/** 64-char hex SHA-256 value used in fake success responses. */
const SHA256_HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

const UPLOAD_PATH = "/api/v1/uploads";

function makeFile(name = "crash.dmp", size = 128): File {
  return new File([new Uint8Array(size)], name, { type: "application/octet-stream" });
}

interface PendingUpload {
  readonly request: UploadRequest;
  readonly observer: UploadObserver;
  readonly resolve: (value: UploadSuccess) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Fake adapter for the public uploader. Extends the shell fake so session
 * wiring (setCsrfTokenSource/setOnSessionExpired) is already correct, then
 * models the upload seam with test-controlled progress/completion.
 */
class UploadFake extends FakeHttpClient {
  readonly uploads: PendingUpload[] = [];

  upload(request: UploadRequest, observer: UploadObserver): UploadHandle {
    let resolve!: (value: UploadSuccess) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<UploadSuccess>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const pending: PendingUpload = { request, observer, resolve, reject };
    this.uploads.push(pending);
    return {
      result,
      abort: () => {
        // Mirrors the real client: cancelling rejects with an AbortError.
        pending.reject(new DOMException("The upload was aborted.", "AbortError"));
      },
    };
  }

  get latest(): PendingUpload {
    const latest = this.uploads[this.uploads.length - 1];
    if (latest === undefined) throw new Error("no upload has started");
    return latest;
  }

  /** Fires an upload progress event exactly like the real XHR observer. */
  progress(fraction: number): void {
    act(() => {
      this.latest.observer.onProgress?.(fraction);
    });
  }

  async succeed(success: UploadSuccess): Promise<void> {
    await settle(() => this.latest.resolve(success));
  }

  async failWith(error: unknown): Promise<void> {
    await settle(() => this.latest.reject(error));
  }
}

/** Flushes promise continuations inside act so setState stays in React's scope. */
async function settle(run: () => void): Promise<void> {
  await act(async () => {
    run();
    await Promise.resolve();
    await Promise.resolve();
  });
}

interface RenderOptions {
  readonly hash?: string;
  readonly strict?: boolean;
}

function renderUpload(fake: UploadFake, options: RenderOptions = {}): void {
  window.history.replaceState(null, "", "/upload");
  if (options.hash !== undefined) window.location.hash = options.hash;
  const ui: ReactNode = <App client={fake} router={createTestRouter(["/upload"])} />;
  render(options.strict === true ? <StrictMode>{ui}</StrictMode> : ui);
}

type User = ReturnType<typeof userEvent.setup>;

async function chooseMinidump(user: User, file = makeFile()): Promise<File> {
  await user.upload(screen.getByLabelText("Choose a minidump file"), file);
  return file;
}

async function beginUpload(user: User, fake: UploadFake): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Upload dump" }));
  await waitFor(() => expect(fake.uploads).toHaveLength(1));
}

function completeResponse(phase: "available" | "rejected" | "sealed", overrides: Partial<Record<string, unknown>> = {}) {
  return {
    dumpId: "dump-100",
    phase,
    byteSize: 128n,
    sha256: SHA256_HEX,
    ...overrides,
  } as const;
}

function queuedResponse(processing: "retry-queued" | "recovery-required") {
  return { dumpId: "dump-100", byteSize: 128n, sha256: SHA256_HEX, processing } as const;
}

function httpError(code: string, status: number, retryable: boolean, message: string): HttpRequestError {
  return new HttpRequestError(message, {
    code: code as HttpRequestError["code"],
    status,
    retryable,
    path: UPLOAD_PATH,
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/upload");
});

describe("fragment grant transport", () => {
  it("reads the grant into memory, scrubs the fragment, and never queries the session", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    // The form appears (no "no link" guidance) and the fragment is removed.
    expect(await screen.findByRole("button", { name: "Choose a minidump or drop it here" })).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(screen.queryByText("No intake link found")).toBeNull();
    // Public route: no session bootstrap or any metadata query occurred.
    expect(fake.calls.filter((call) => call.kind === "query")).toHaveLength(0);

    // The captured secret is sent only in the upload request contract.
    await chooseMinidump(user);
    await beginUpload(user, fake);
    expect(fake.latest.request.path).toBe(UPLOAD_PATH);
    expect(fake.latest.request.grant).toBe(VALID_GRANT);
    expect(fake.latest.request.filename).toBe("crash.dmp");
  });

  it("keeps the captured grant across a StrictMode double-mount", async () => {
    const fake = new UploadFake();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}`, strict: true });

    expect(await screen.findByRole("button", { name: "Choose a minidump or drop it here" })).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(screen.queryByText("No intake link found")).toBeNull();
  });

  it("shows neutral guidance when no fragment is present and never queries the session", async () => {
    const fake = new UploadFake();
    renderUpload(fake);

    expect(await screen.findByText("No intake link found")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload dump" })).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it("scrubs an invalid grant fragment and still shows neutral guidance", async () => {
    const fake = new UploadFake();
    renderUpload(fake, { hash: "#grant=way-too-short" });

    expect(await screen.findByText("No intake link found")).toBeTruthy();
    // The secret-shaped fragment is removed from the address bar regardless.
    await waitFor(() => expect(window.location.hash).toBe(""));
  });
});

describe("file selection and drag/drop", () => {
  it("disables upload until a file is selected, then arms it through the picker input", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    const uploadButton = await screen.findByRole("button", { name: "Upload dump" });
    expect((uploadButton as HTMLButtonElement).disabled).toBe(true);

    await chooseMinidump(user);

    expect(await screen.findByText("crash.dmp")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Upload dump" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("Ready to upload")).toBeTruthy();
  });

  it("selects a file dropped onto the drop zone", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    const zone = await screen.findByRole("button", { name: "Choose a minidump or drop it here" });
    const file = makeFile("dropped.dmp", 64);
    fireEvent.dragEnter(zone, { dataTransfer: { files: [file] } });
    fireEvent.dragOver(zone, { dataTransfer: { files: [file] } });
    expect(zone.className).toContain("is-dragging");
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });

    expect(await screen.findByText("dropped.dmp")).toBeTruthy();
    expect(zone.className).toContain("has-file");
  });
});

describe("upload progress", () => {
  it("renders determinate progress from observer callbacks", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    await chooseMinidump(user);
    await beginUpload(user, fake);

    expect(await screen.findByRole("progressbar")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");

    fake.progress(0.42);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByText("Uploading… 42%")).toBeTruthy();
    const bar = screen.getByRole("progressbar").querySelector(".progress-bar") as HTMLElement | null;
    expect(bar?.style.width).toBe("42%");

    fake.progress(1);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByText("Uploading… 100%")).toBeTruthy();
  });
});

describe("terminal outcomes", () => {
  /** Asserts the terminal result region exposes its title and body copy. */
  async function expectResult(
    role: "status" | "alert",
    title: string,
    bodyParts: readonly string[],
  ): Promise<HTMLElement> {
    const region = await screen.findByRole(role);
    expect(region.textContent).toContain(title);
    for (const part of bodyParts) expect(region.textContent).toContain(part);
    return region;
  }

  it("201 available: announces completion with a receipt and moves focus to the result", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    await chooseMinidump(user);
    await beginUpload(user, fake);
    await fake.succeed({ kind: "complete", response: completeResponse("available") });

    const region = await expectResult("status", "Upload complete", [
      "now available to the support team",
    ]);
    expect(region.textContent).toContain("Dump ID: dump-100");
    expect(region.textContent).toContain("SHA-256: 9f86d081");
    // Focus moved to the result region after the terminal state.
    await waitFor(() => {
      expect(document.activeElement?.getAttribute("aria-labelledby")).toBe("upload-result-title");
    });
  });

  it("201 rejected: explains the rejection plainly", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    await chooseMinidump(user);
    await beginUpload(user, fake);
    await fake.succeed({ kind: "complete", response: completeResponse("rejected") });

    await expectResult("status", "File received but not accepted", [
      "could not be processed and was not kept",
      "ask the support team for a new link",
    ]);
  });

  it("201 sealed: neutral received state", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    await chooseMinidump(user);
    await beginUpload(user, fake);
    await fake.succeed({ kind: "complete", response: completeResponse("sealed") });

    await expectResult("status", "Upload received", ["sealed for the support team"]);
  });

  it("202 retry-queued: explains processing continues automatically", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    await chooseMinidump(user);
    await beginUpload(user, fake);
    await fake.succeed({ kind: "queued", response: queuedResponse("retry-queued") });

    await expectResult("status", "Upload received — processing queued", [
      "processing is queued and continues automatically on the server",
    ]);
  });

  it("202 recovery-required: explains processing needs server recovery", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    await chooseMinidump(user);
    await beginUpload(user, fake);
    await fake.succeed({ kind: "queued", response: queuedResponse("recovery-required") });

    await expectResult("status", "Upload received — processing needs recovery", [
      "flagged it for recovery",
    ]);
  });

  it("404 grant unavailable: neutral wording, no retry offered", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    await chooseMinidump(user);
    await beginUpload(user, fake);
    await fake.failWith(httpError("grant_unavailable", 404, false, "The upload grant is unavailable."));

    await expectResult("alert", "This intake link is not available", [
      "may have expired, already been used, been revoked",
    ]);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upload dump" })).toBeNull();
  });

  it("413 too large: states the byte limit and asks for a new link", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    const file = makeFile("big.dmp", 4096);
    await chooseMinidump(user, file);
    await beginUpload(user, fake);
    await fake.failWith(httpError("upload_too_large", 413, false, "The upload exceeded its allowed byte size."));

    await expectResult("alert", "The file is too large for this intake link", [
      "big.dmp",
      "byte limit",
      "Ask the support team for a new intake link",
    ]);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("503 storage unavailable: safe retry guidance with a manual retry only", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    await chooseMinidump(user);
    await beginUpload(user, fake);
    await fake.failWith(
      httpError("storage_unavailable", 503, true, "Storage is temporarily unavailable."),
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("The upload did not start")).toBeTruthy();
    // No automatic retry: exactly one upload happened and none follow on their own.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.uploads).toHaveLength(1);

    // Manual retry with the same grant/file is safe (request never started).
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fake.uploads).toHaveLength(2));
    await fake.succeed({ kind: "complete", response: completeResponse("available") });
    await expectResult("status", "Upload complete", ["now available to the support team"]);
  });

  it("503 upload busy is treated with the same safe retry guidance", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    await chooseMinidump(user);
    await beginUpload(user, fake);
    await fake.failWith(httpError("upload_busy", 503, true, "Upload processing is busy; try again shortly."));

    expect(await screen.findByText("The upload did not start")).toBeTruthy();
    expect(fake.uploads).toHaveLength(1);
  });

  it("user abort: uncertain outcome guidance asks for a new link", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    await chooseMinidump(user);
    await beginUpload(user, fake);
    await user.click(screen.getByRole("button", { name: "Cancel upload" }));

    await expectResult("alert", "Upload outcome unknown", [
      "You cancelled the upload",
      "may already have been consumed",
    ]);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upload dump" })).toBeNull();
  });

  it("transport failure: uncertain outcome guidance asks for a new link", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    await chooseMinidump(user);
    await beginUpload(user, fake);
    await fake.failWith(
      new HttpRequestError("The upload connection failed.", {
        code: "internal_error",
        status: 0,
        retryable: false,
        path: UPLOAD_PATH,
      }),
    );

    await expectResult("alert", "Upload outcome unknown", [
      "connection was lost",
      "ask the support team for a new intake link",
    ]);
  });
});

describe("accessibility", () => {
  it("exposes labelled controls, a progressbar, and a polite status region", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    expect(await screen.findByRole("heading", { level: 1, name: "Crash dump intake" })).toBeTruthy();
    // Native button drop zone is the keyboard file-selection control.
    expect(screen.getByRole("button", { name: "Choose a minidump or drop it here" })).toBeTruthy();
    expect(screen.getByLabelText("Choose a minidump file")).toBeTruthy();
    const status = screen.getByText("Select a file to continue");
    expect(status.getAttribute("aria-live")).toBe("polite");

    await chooseMinidump(user);
    await beginUpload(user, fake);

    const progress = await screen.findByRole("progressbar");
    expect(progress.getAttribute("aria-valuemin")).toBe("0");
    expect(progress.getAttribute("aria-valuemax")).toBe("100");
    expect(screen.getByRole("button", { name: "Cancel upload" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload dump" })).toBeNull();

    fake.progress(0.5);
    expect(screen.getByText("Uploading… 50%")).toBeTruthy();
  });

  it("announces terminal errors in an alert region and moves focus to it", async () => {
    const fake = new UploadFake();
    const user = userEvent.setup();
    renderUpload(fake, { hash: `#grant=${VALID_GRANT}` });

    await chooseMinidump(user);
    await beginUpload(user, fake);
    await fake.failWith(httpError("grant_unavailable", 404, false, "The upload grant is unavailable."));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This intake link is not available");
    await waitFor(() => {
      expect(document.activeElement?.getAttribute("aria-labelledby")).toBe("upload-result-title");
    });
  });
});
