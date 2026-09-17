/**
 * Symbols operator page tests (docs/symbols-design.md, "Ingest (operator
 * surface)" and milestone 1).
 *
 * Renders the real SymbolsPage inside the operator providers with an
 * OperatorFakeHttpClient extended locally for the two seams the page uses:
 * `GET /api/v1/symbols` + `DELETE /api/v1/symbols/:artifactId` (the shared
 * operator fake) and the operator raw upload (`uploadRaw`) that the shared
 * client's dump-intake-specific `upload()` cannot express yet (see the marked
 * seam in features/symbols/symbols-api.ts). The upload fake mirrors the real
 * transport's observable contract: one request per file through the observer,
 * progress callbacks, test-controlled settle, and abort support.
 *
 * Covers: artifact list rendering, the empty state, strictly sequential
 * ingest with per-file identity results and dedup copy, the stable
 * identity-unreadable message with no retry, the too-large message,
 * confirmation-gated purge plus authoritative refetch, and operator
 * route/nav registration.
 */

import { act } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SYMBOLS_PATH,
  X_SYMBOL_FILENAME_HEADER,
  type SymbolIngestResponse,
  type SymbolRecord,
} from "@dump-ledger/http-contracts";
import { HttpRequestError, type UploadObserver } from "../shared/http-client";
import { HttpClientProvider } from "../shared/http-client-context";
import { SymbolsPage } from "../features/symbols/SymbolsPage";
import {
  SYMBOL_INGEST_UNAVAILABLE_MESSAGE,
  type OperatorRawUploadRequest,
} from "../features/symbols/symbols-api";
import { createMemoryRouter, RouterProvider } from "react-router";
import { appRouteObjects } from "../app/router";
import { OperatorFakeHttpClient, renderFeaturePage } from "./operator-fake-http-client";

const SHA256_HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const DEBUG_ID = "3A9C1B2C3D4E5F60718293A4B5C6D7E81";

interface SymbolRecordOverrides {
  readonly artifactId?: string;
  readonly debugFile?: string;
  readonly debugId?: string;
  readonly byteSize?: bigint;
  readonly product?: string;
  readonly version?: string;
  readonly arch?: string;
  readonly ingestedAt?: string;
}

function symbolRecord(overrides: SymbolRecordOverrides = {}): SymbolRecord {
  return {
    artifactId: overrides.artifactId ?? "sym-1",
    debugFile: overrides.debugFile ?? "electron.pdb",
    debugId: overrides.debugId ?? DEBUG_ID,
    kind: "pdb",
    byteSize: overrides.byteSize ?? 224395264n, // 214 MiB
    sha256: SHA256_HEX,
    ...(overrides.product === undefined ? {} : { product: overrides.product }),
    ...(overrides.version === undefined ? {} : { version: overrides.version }),
    ...(overrides.arch === undefined ? {} : { arch: overrides.arch }),
    ingestedAt: overrides.ingestedAt ?? "2026-09-16T03:00:00.000Z",
  };
}

interface IngestOverrides {
  readonly artifactId?: string;
  readonly debugFile?: string;
  readonly debugId?: string;
  readonly byteSize?: bigint;
  readonly deduplicated?: boolean;
}

function ingestResponse(overrides: IngestOverrides = {}): SymbolIngestResponse {
  return {
    artifactId: overrides.artifactId ?? "sym-1",
    debugFile: overrides.debugFile ?? "electron.pdb",
    debugId: overrides.debugId ?? DEBUG_ID,
    kind: "pdb",
    byteSize: overrides.byteSize ?? 224395264n,
    sha256: SHA256_HEX,
    deduplicated: overrides.deduplicated ?? false,
  };
}

function makePdb(name: string, size = 64): File {
  return new File([new Uint8Array(size)], name, { type: "application/octet-stream" });
}

interface PendingIngest {
  readonly request: OperatorRawUploadRequest<SymbolIngestResponse>;
  readonly onProgress: ((fraction: number) => void) | undefined;
  readonly resolve: (value: SymbolIngestResponse) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Operator fake plus the raw-upload seam. Requests are held open so a test can
 * assert that the queue never overlaps two files.
 */
class SymbolsFakeHttpClient extends OperatorFakeHttpClient {
  readonly ingestRequests: OperatorRawUploadRequest<SymbolIngestResponse>[] = [];
  private readonly pendingIngests: PendingIngest[] = [];

  uploadRaw<T>(
    request: OperatorRawUploadRequest<T>,
    observer: UploadObserver,
  ): { readonly result: Promise<T>; abort(): void } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.ingestRequests.push(request as OperatorRawUploadRequest<SymbolIngestResponse>);
    this.pendingIngests.push({
      request: request as OperatorRawUploadRequest<SymbolIngestResponse>,
      onProgress: observer.onProgress,
      resolve: (value) => resolve(value as T),
      reject,
    });
    return {
      result,
      abort: () => reject(new DOMException("The upload was aborted.", "AbortError")),
    };
  }

  get latestIngest(): PendingIngest {
    const latest = this.pendingIngests[this.pendingIngests.length - 1];
    if (latest === undefined) throw new Error("no ingest has started");
    return latest;
  }

  /** Fires a progress event exactly like the real XHR observer. */
  progress(fraction: number): void {
    const latest = this.latestIngest;
    act(() => {
      latest.onProgress?.(fraction);
    });
  }

  async succeed(response: SymbolIngestResponse): Promise<void> {
    await settle(() => this.latestIngest.resolve(response));
  }

  async failWith(error: unknown): Promise<void> {
    await settle(() => this.latestIngest.reject(error));
  }

  ingestCallCount(): number {
    return this.ingestRequests.length;
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

function renderSymbols(fake: SymbolsFakeHttpClient): void {
  renderFeaturePage(fake, <SymbolsPage />, { entry: "/symbols" });
}

function symbolQueryCount(fake: SymbolsFakeHttpClient): number {
  return fake.queryCalls.filter((call) => call.path === SYMBOLS_PATH).length;
}

describe("Symbols page artifact list", () => {
  it("renders debug file, truncated identity, kind, size, timestamp, and annotations", async () => {
    const fake = new SymbolsFakeHttpClient();
    fake.setQueryResponder(SYMBOLS_PATH, () => ({
      symbols: [
        symbolRecord({ product: "Electron", version: "41.10.6", arch: "x64" }),
        symbolRecord({ artifactId: "sym-2", debugFile: "node.pdb", debugId: "ABCDEF0123456789ABCDEF01234567890" }),
      ],
    }));
    renderSymbols(fake);

    expect(await screen.findByText("electron.pdb")).toBeTruthy();
    expect(screen.getByText("node.pdb")).toBeTruthy();
    // Truncated debug ids; the full identity stays in the row title.
    expect(screen.getByText("3A9C…1")).toBeTruthy();
    expect(screen.getByText("ABCD…0")).toBeTruthy();
    expect(screen.getAllByText("PDB")).toHaveLength(2);
    expect(screen.getAllByText("214 MiB")).toHaveLength(2);
    expect(screen.getAllByText("Ingested 2026-09-16 03:00:00 UTC")).toHaveLength(2);
    expect(screen.getByText("Electron")).toBeTruthy();
    expect(screen.getByText("41.10.6")).toBeTruthy();
    expect(screen.getByText("x64")).toBeTruthy();
    expect(symbolQueryCount(fake)).toBe(1);
  });

  it("renders the empty state when the store has no artifacts", async () => {
    const fake = new SymbolsFakeHttpClient();
    fake.setQueryResponder(SYMBOLS_PATH, () => ({ symbols: [] }));
    renderSymbols(fake);

    expect(await screen.findByText("No symbol artifacts")).toBeTruthy();
    expect(screen.getByText(/Ingest a PDB below to serve it to debuggers/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Purge" })).toBeNull();
  });
});

describe("Symbols page ingest queue", () => {
  it("ingests files strictly sequentially and reports each parsed identity", async () => {
    const fake = new SymbolsFakeHttpClient();
    fake.setQueryResponder(SYMBOLS_PATH, () => ({ symbols: [] }));
    const user = userEvent.setup();
    renderSymbols(fake);

    await screen.findByText("No symbol artifacts");
    await user.upload(screen.getByLabelText("Choose PDB files"), [
      makePdb("outdated.pdb", 64),
      makePdb("current.pdb", 128),
    ]);

    // One request at a time: the second file waits for the first to settle.
    await waitFor(() => expect(fake.ingestCallCount()).toBe(1));
    expect(fake.ingestRequests[0]?.path).toBe(SYMBOLS_PATH);
    expect(fake.ingestRequests[0]?.filename).toBe("outdated.pdb");
    expect(fake.ingestRequests[0]?.filenameHeader).toBe(X_SYMBOL_FILENAME_HEADER);
    expect(fake.ingestRequests[0]?.decoder).toBeTypeOf("function");

    // Per-file progress reaches the queue row while the file streams.
    fake.progress(0.5);
    expect(screen.getByText("50%")).toBeTruthy();

    await fake.succeed(ingestResponse());
    await waitFor(() => expect(fake.ingestCallCount()).toBe(2));
    expect(fake.ingestRequests[1]?.filename).toBe("current.pdb");
    // The first identity result is already on screen while the second streams.
    expect(screen.getByText("electron.pdb 3A9C…1 registered (214 MiB)")).toBeTruthy();

    await fake.succeed(ingestResponse({ deduplicated: true }));
    expect(
      await screen.findByText("electron.pdb 3A9C…1 already registered (214 MiB)"),
    ).toBeTruthy();
    expect(screen.getByText("2 of 2 files processed")).toBeTruthy();

    // The authoritative list is refetched once the batch drains.
    await waitFor(() => expect(symbolQueryCount(fake)).toBeGreaterThan(1));
  });

  it("shows the stable identity-unreadable message and never retries the file", async () => {
    const fake = new SymbolsFakeHttpClient();
    fake.setQueryResponder(SYMBOLS_PATH, () => ({ symbols: [] }));
    const user = userEvent.setup();
    renderSymbols(fake);

    await screen.findByText("No symbol artifacts");
    await user.upload(screen.getByLabelText("Choose PDB files"), makePdb("mystery.pdb", 64));
    await waitFor(() => expect(fake.ingestCallCount()).toBe(1));

    await fake.failWith(
      new HttpRequestError("The file is not a PDB or carries no readable RSDS record.", {
        code: "symbol_identity_unreadable",
        status: 422,
        retryable: false,
        path: SYMBOLS_PATH,
      }),
    );

    expect(await screen.findByText("Not a PDB or no RSDS record.")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    // No automatic retry and nothing else was sent for the rejected file.
    await settle(() => undefined);
    expect(fake.ingestCallCount()).toBe(1);
    expect(screen.queryByRole("button", { name: /try again|retry/i })).toBeNull();
    // A rejected file never triggers a list refetch.
    expect(symbolQueryCount(fake)).toBe(1);
  });

  it("fails the file with the stable message when the client cannot stream raw uploads", async () => {
    // The deployed shared client has no uploadRaw yet (see the marked seam in
    // symbols-api.ts): the page must say so instead of pretending to ingest.
    const fake = new OperatorFakeHttpClient();
    fake.setQueryResponder(SYMBOLS_PATH, () => ({ symbols: [] }));
    const user = userEvent.setup();
    renderFeaturePage(fake, <SymbolsPage />, { entry: "/symbols" });

    await screen.findByText("No symbol artifacts");
    await user.upload(screen.getByLabelText("Choose PDB files"), makePdb("electron.pdb", 64));

    expect(await screen.findByText(SYMBOL_INGEST_UNAVAILABLE_MESSAGE)).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("maps a too-large rejection to the ceiling message", async () => {
    const fake = new SymbolsFakeHttpClient();
    fake.setQueryResponder(SYMBOLS_PATH, () => ({ symbols: [] }));
    const user = userEvent.setup();
    renderSymbols(fake);

    await screen.findByText("No symbol artifacts");
    await user.upload(screen.getByLabelText("Choose PDB files"), makePdb("huge.pdb", 64));
    await waitFor(() => expect(fake.ingestCallCount()).toBe(1));

    await fake.failWith(
      new HttpRequestError("The symbol artifact exceeds its allowed byte size.", {
        code: "symbol_too_large",
        status: 413,
        retryable: false,
        path: SYMBOLS_PATH,
      }),
    );

    expect(await screen.findByText("Larger than the 8 GiB symbol artifact ceiling.")).toBeTruthy();
  });
});

describe("Symbols page purge", () => {
  it("purges only after confirmation and refetches the authoritative list", async () => {
    const fake = new SymbolsFakeHttpClient();
    let listCall = 0;
    fake.setQueryResponder(SYMBOLS_PATH, () => {
      listCall += 1;
      return listCall === 1 ? { symbols: [symbolRecord()] } : { symbols: [] };
    });
    fake.setMutationResponder("DELETE", "/api/v1/symbols/sym-1", () => undefined);
    const user = userEvent.setup();
    renderSymbols(fake);

    await screen.findByText("electron.pdb");
    await user.click(screen.getByRole("button", { name: "Purge" }));

    // The dialog gates the mutation: cancelling sends nothing.
    const dialog = await screen.findByRole("dialog", { name: "Purge symbol artifact" });
    expect(fake.mutationCalls).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.mutationCalls).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Purge" }));
    const confirmDialog = await screen.findByRole("dialog", { name: "Purge symbol artifact" });
    await user.click(within(confirmDialog).getByRole("button", { name: "Purge artifact" }));

    await waitFor(() => expect(fake.mutationCalls).toHaveLength(1));
    expect(fake.mutationCalls[0]?.method).toBe("DELETE");
    expect(fake.mutationCalls[0]?.path).toBe("/api/v1/symbols/sym-1");

    // The list is refetched and the purged row is gone.
    await waitFor(() => expect(symbolQueryCount(fake)).toBe(2));
    expect(await screen.findByText("No symbol artifacts")).toBeTruthy();
    expect(screen.getByText("Purged electron.pdb.")).toBeTruthy();
  });
});

describe("Symbols route registration", () => {
  it("serves /symbols behind the operator guard with a Symbols nav entry", async () => {
    const fake = new SymbolsFakeHttpClient();
    fake.preAuthenticate();
    fake.setQueryResponder(SYMBOLS_PATH, () => ({ symbols: [] }));
    const router = createMemoryRouter([...appRouteObjects], { initialEntries: ["/symbols"] });
    render(
      <HttpClientProvider client={fake}>
        <RouterProvider router={router} />
      </HttpClientProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Symbols" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Symbols" })).toBeTruthy();
    expect(await screen.findByText("No symbol artifacts")).toBeTruthy();
  });
});
