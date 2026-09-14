/**
 * UploadPage — public dump intake with batch support (design sections 6, 7.6,
 * 8.4, 9 and docs/batch-upload-design.md).
 *
 * Transport rules:
 *   - The grant arrives only in the URL fragment (`/upload#grant=<secret>`).
 *     The page reads it into route-local memory on mount and immediately
 *     strips the fragment with `history.replaceState`. The secret is never
 *     persisted, never logged, and never written anywhere beyond this route's
 *     memory.
 *   - On mount the page asks `GET /api/v1/uploads/quota` (secret in the
 *     X-Upload-Grant header) how many upload slots the link has left, so file
 *     selection is capped and exhaustion is explained before a byte streams.
 *   - Files are streamed one request per file, strictly sequentially, through
 *     the shared http-client's `upload()` API. Bytes are never read into an
 *     ArrayBuffer, base64-encoded, placed in JSON, or copied into React
 *     state.
 *   - Automatic retry is disabled entirely. A slot may be consumed even if
 *     the browser aborts or loses the network, so only a confirmed
 *     "never started" server error (503/429, contract `retryable`) offers a
 *     manual retry; every other terminal state directs the customer to
 *     request a new link. Partial success is first-class: each file reports
 *     its own outcome.
 *
 * No third-party requests, no inline scripts, no dangerouslySetInnerHTML.
 */

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import { useHttpClient } from "../../shared/http-client-context";
import { HttpRequestError } from "../../shared/http-client";
import { PublicLayout } from "../../app/layouts";
import { Notice } from "../../shared/components/notice";
import { classNames } from "../../shared/classnames";
import { formatBytes } from "../../shared/format";
import {
  decodeGrantQuotaResponse,
  GRANT_QUOTA_PATH,
  X_UPLOAD_GRANT_HEADER,
  type GrantQuotaResponse,
} from "@dump-ledger/http-contracts";
import { outcomeFromError, outcomeFromSuccess, type UploadOutcome } from "./upload-outcomes";
import { readGrantSecret, scrubGrantFragment } from "./grant-fragment";
import "./uploads.css";

/** Raw byte endpoint (design section 7.6); the http-client streams the file. */
const UPLOAD_ENDPOINT = "/api/v1/uploads";

function clampFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction));
}

/** Grant-slot knowledge for this link, fetched once per page visit. */
type QuotaState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly quota: GrantQuotaResponse }
  | { readonly kind: "unavailable" };

/** One file in the sequential upload queue. */
interface QueueEntry {
  readonly id: number;
  readonly file: File;
  readonly status: "queued" | "uploading" | "done" | "failed";
  readonly progress: number;
  /** Terminal outcome for this file; absent when the file was never attempted. */
  readonly outcome?: UploadOutcome;
}

type PagePhase = "selecting" | "uploading" | "done";

export function UploadPage(): ReactNode {
  const client = useHttpClient();

  // The grant held only for the lifetime of this route instance.
  const [grant, setGrant] = useState<string | null>(null);
  const [quotaState, setQuotaState] = useState<QuotaState>({ kind: "loading" });
  const [quotaAttempt, setQuotaAttempt] = useState(0);
  const [entries, setEntries] = useState<readonly QueueEntry[]>([]);
  const [phase, setPhase] = useState<PagePhase>("selecting");
  const [progress, setProgress] = useState(0);
  const [currentName, setCurrentName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [retry, setRetry] = useState<{ readonly message: string } | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);

  const nextId = useRef(1);
  const runningRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handleRef = useRef<{ abort(): void } | null>(null);
  const resultRef = useRef<HTMLElement | null>(null);
  const retryRef = useRef<HTMLDivElement | null>(null);

  const readyQuota = quotaState.kind === "ready" ? quotaState.quota : null;
  const isBatchLink = readyQuota !== null && readyQuota.maxUploads > 1;
  // A valid link with no slots left is terminal before any file is chosen
  // (batch upload design, decision 3): distinct from an opaque unavailable link.
  const exhausted = readyQuota !== null && readyQuota.maxUploads - readyQuota.uploadsUsed <= 0;

  // Fragment grant transport (design 7.6 / 9): read the secret into memory,
  // then strip the fragment so it cannot linger in the address bar.
  useEffect(() => {
    const secret = readGrantSecret(window.location);
    if (scrubGrantFragment(window.location, window.history) && secret !== null) {
      setGrant(secret);
    }
  }, []);

  // Quota query (batch upload design): issued and consumed links answer 200;
  // unknown/revoked/expired stay opaque and the page renders the neutral
  // unavailable outcome. Retryable failures offer a manual re-check only.
  useEffect(() => {
    if (grant === null) return;
    let cancelled = false;
    setQuotaState({ kind: "loading" });
    client
      .query({
        path: GRANT_QUOTA_PATH,
        decoder: decodeGrantQuotaResponse,
        headers: { [X_UPLOAD_GRANT_HEADER]: grant },
      })
      .then((quota) => {
        if (!cancelled) setQuotaState({ kind: "ready", quota });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof HttpRequestError && error.retryable) {
          setQuotaState({ kind: "loading" });
          setRetry({ message: error.message });
        } else {
          setQuotaState({ kind: "unavailable" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, grant, quotaAttempt]);

  // If the link allows fewer files than were picked before the quota arrived,
  // trim the selection honestly rather than failing mid-batch.
  useEffect(() => {
    if (readyQuota === null || phase !== "selecting") return;
    const room = readyQuota.maxUploads - readyQuota.uploadsUsed;
    if (entries.length > room) {
      setEntries((previous) => previous.slice(0, room));
      setSelectionNotice(
        room === 1
          ? "This link accepts one upload; the extra selection was removed."
          : `This link accepts ${room} uploads; the extra selection was removed.`,
      );
    }
  }, [readyQuota, phase, entries.length]);

  // Abort an in-flight upload when the customer leaves the route.
  useEffect(() => {
    return () => {
      handleRef.current?.abort();
    };
  }, []);

  // Move focus to the terminal result (design 8.4) and to a retryable error.
  useEffect(() => {
    if (phase === "done" || quotaState.kind === "unavailable" || exhausted) resultRef.current?.focus();
  }, [phase, quotaState.kind, exhausted]);
  useEffect(() => {
    if (retry !== null) retryRef.current?.focus();
  }, [retry]);

  function updateEntry(id: number, patch: Partial<Omit<QueueEntry, "id" | "file">>): void {
    setEntries((previous) =>
      previous.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    );
  }

  function addFiles(incoming: readonly File[]): void {
    if (incoming.length === 0 || phase === "uploading" || quotaState.kind === "unavailable") return;
    setRetry(null);
    // While the quota is still loading the selection is uncapped; the trim
    // effect above enforces the bound as soon as the answer arrives.
    const room =
      readyQuota === null
        ? incoming.length
        : Math.max(0, readyQuota.maxUploads - readyQuota.uploadsUsed - entries.length);
    const accepted = incoming.slice(0, room);
    const skipped = incoming.length - accepted.length;
    if (skipped > 0) {
      setSelectionNotice(
        room === 1 || (readyQuota !== null && readyQuota.maxUploads - readyQuota.uploadsUsed === 1)
          ? "This link accepts one upload; extra files were not added."
          : `This link accepts ${room} more files; ${skipped} were not added.`,
      );
    } else {
      setSelectionNotice(null);
    }
    if (accepted.length === 0) return;
    const stamped: QueueEntry[] = accepted.map((file) => ({
      id: nextId.current++,
      file,
      status: "queued",
      progress: 0,
    }));
    setEntries((previous) => [...previous, ...stamped]);
  }

  function openPicker(): void {
    if (phase === "uploading") return;
    fileInputRef.current?.click();
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const chosen = event.target.files !== null ? Array.from(event.target.files) : [];
    // Reset the value so choosing the same file again still fires a change.
    event.target.value = "";
    addFiles(chosen);
  }

  function handleDragOver(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault();
    if (phase !== "uploading") setDragging(true);
  }

  function handleDragLeave(): void {
    setDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault();
    setDragging(false);
    if (phase === "uploading") return;
    addFiles(Array.from(event.dataTransfer.files));
  }

  function cancelUpload(): void {
    handleRef.current?.abort();
  }

  /** Marks every still-queued file as never attempted (terminal for the batch). */
  function markRemainingNotAttempted(): void {
    setEntries((previous) =>
      previous.map((entry) =>
        entry.status === "queued" ? { ...entry, status: "failed" as const } : entry,
      ),
    );
  }

  async function runQueue(): Promise<void> {
    if (grant === null || readyQuota === null || runningRef.current) return;
    const queue = entries.filter((entry) => entry.status === "queued");
    if (queue.length === 0) return;
    runningRef.current = true;
    setPhase("uploading");
    setRetry(null);
    setSelectionNotice(null);
    try {
      for (const entry of queue) {
        updateEntry(entry.id, { status: "uploading", progress: 0 });
        setCurrentName(entry.file.name);
        setProgress(0);
        try {
          // The shared client owns X-Upload-Grant / X-Dump-Filename-Base64url
          // and streams the File directly (never buffered). No automatic retry.
          const handle = client.upload(
            { path: UPLOAD_ENDPOINT, file: entry.file, grant, filename: entry.file.name },
            {
              onProgress: (fraction) => {
                const clamped = clampFraction(fraction);
                updateEntry(entry.id, { progress: clamped });
                setProgress(clamped);
              },
            },
          );
          handleRef.current = handle;
          const success = await handle.result;
          updateEntry(entry.id, { status: "done", outcome: outcomeFromSuccess(success) });
        } catch (error) {
          const mapped = outcomeFromError(error);
          if (mapped.kind === "retryable") {
            // The request never started, so no slot was consumed. Retry stays
            // manual — the queue pauses until the customer asks to continue.
            updateEntry(entry.id, { status: "queued", progress: 0 });
            setRetry({ message: mapped.message });
            setPhase("selecting");
            return;
          }
          updateEntry(entry.id, { status: "failed", outcome: mapped });
          if (mapped.kind === "too-large") {
            // The slot is burned (batch design, decision 2); the batch goes on.
            continue;
          }
          // Exhaustion, unavailability, and uncertainty end the batch: the
          // remaining files are honestly marked as never attempted.
          markRemainingNotAttempted();
          break;
        } finally {
          handleRef.current = null;
        }
      }
      setPhase("done");
    } finally {
      runningRef.current = false;
      setCurrentName(null);
    }
  }

  const uploading = phase === "uploading";
  const percent = Math.round(progress * 100);
  const queuedCount = entries.filter((entry) => entry.status === "queued").length;
  const currentIndex = entries.findIndex((entry) => entry.status === "uploading");
  const statusText = uploading
    ? entries.length > 1
      ? `Uploading file ${currentIndex + 1} of ${entries.length}… ${percent}%`
      : `Uploading… ${percent}%`
    : readyQuota === null && grant !== null && quotaState.kind !== "unavailable"
      ? "Checking this link…"
      : entries.length === 0
        ? isBatchLink
          ? "Select files to continue"
          : "Select a file to continue"
        : entries.length === 1
          ? "Ready to upload"
          : `Ready to upload ${entries.length} files`;

  return (
    <PublicLayout>
      <section className="upload-shell" aria-labelledby="upload-title">
        <div className="upload-card">
          <div className="auth-symbol" aria-hidden="true">
            ⇧
          </div>
          <p className="eyebrow">Secure case intake</p>
          <h1 id="upload-title">Crash dump intake</h1>
          <p>
            Your {isBatchLink ? "files are" : "file is"} sent directly to this private DumpLedger instance and
            associated with the intended support case.
          </p>

          {grant === null ? (
            <Notice tone="info">
              <strong>No intake link found</strong>
              <p>
                This page needs the full intake link that the support team sent you — the one-time secret travels
                in the address itself. If the link still shows this message, it may be out of date: ask the support
                team for a new one.
              </p>
            </Notice>
          ) : quotaState.kind === "unavailable" ? (
            <UploadResult outcome={{ kind: "grant-unavailable" }} fileName={null} resultRef={resultRef} />
          ) : exhausted ? (
            <UploadResult outcome={{ kind: "slots-exhausted" }} fileName={null} resultRef={resultRef} />
          ) : phase === "done" ? (
            entries.length === 1 && entries[0]?.outcome !== undefined ? (
              <UploadResult outcome={entries[0].outcome} fileName={entries[0].file.name} resultRef={resultRef} />
            ) : (
              <BatchSummary entries={entries} resultRef={resultRef} />
            )
          ) : (
            <>
              <Notice tone="warn">
                <strong>{isBatchLink ? "Case intake link" : "One-time intake link"}</strong>
                {isBatchLink && readyQuota !== null ? (
                  <p>
                    This link works for up to {readyQuota.maxUploads} uploads
                    {readyQuota.uploadsUsed > 0
                      ? ` and has ${readyQuota.maxUploads - readyQuota.uploadsUsed} left`
                      : ""}
                    . Once a transfer starts its slot may be consumed even if the browser is closed, the
                    connection is lost, or the upload is cancelled. If a result is unclear, ask the support team
                    for a new link instead of reusing this one.
                  </p>
                ) : (
                  <p>
                    This link works for a single upload. Once the transfer starts it may be consumed even if the
                    browser is closed, the connection is lost, or the upload is cancelled. If the result is
                    unclear, ask the support team for a new link instead of reusing this one.
                  </p>
                )}
              </Notice>

              {selectionNotice !== null && (
                <Notice tone="info" role="status">
                  <p>{selectionNotice}</p>
                </Notice>
              )}

              {retry !== null && (
                <div ref={retryRef} tabIndex={-1} className="auth-error">
                  <Notice tone="error" role="alert">
                    <strong>The upload did not start</strong>
                    <p>{retry.message}</p>
                    <p>Nothing was sent and this intake link is still valid, so you can try again.</p>
                    <p>
                      <button
                        type="button"
                        className="button button-small"
                        onClick={() => {
                          setRetry(null);
                          if (readyQuota === null) setQuotaAttempt((attempt) => attempt + 1);
                          else void runQueue();
                        }}
                      >
                        Try again
                      </button>
                    </p>
                  </Notice>
                </div>
              )}

              <button
                type="button"
                className={classNames(
                  "drop-zone",
                  "drop-zone-chooser",
                  entries.length > 0 ? "has-file" : undefined,
                  dragging ? "is-dragging" : undefined,
                )}
                aria-label={isBatchLink ? "Choose minidumps or drop them here" : "Choose a minidump or drop it here"}
                disabled={uploading}
                onClick={openPicker}
                onDragEnter={handleDragOver}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <span className="drop-icon" aria-hidden="true">
                  ⇧
                </span>
                <span className="drop-title">
                  {isBatchLink ? "Choose minidumps or drop them here" : "Choose a minidump or drop it here"}
                </span>
                <span className="drop-copy">Partial and full-memory Windows minidumps are accepted</span>
                {entries.length === 1 ? (
                  <span className="selected-file">
                    <strong>{entries[0]?.file.name}</strong>
                    <span>{formatBytes(BigInt(entries[0]?.file.size ?? 0))}</span>
                  </span>
                ) : entries.length > 1 ? (
                  <span className="selected-file">
                    <strong>{entries.length} files selected</strong>
                  </span>
                ) : (
                  <span className="selected-file">
                    <strong>No file selected</strong>
                  </span>
                )}
              </button>

              {/* The native file input stays in the DOM (programmatic picker +
                  accessible control) but is visually hidden and not a tab stop. */}
              <input
                ref={fileInputRef}
                id="dump-file"
                className="upload-file-input"
                type="file"
                accept=".dmp,application/octet-stream"
                aria-label={isBatchLink ? "Choose minidump files" : "Choose a minidump file"}
                tabIndex={-1}
                multiple
                onChange={handleFileChange}
              />

              {entries.length > 1 && (
                <ul className="upload-queue" aria-label="Selected files">
                  {entries.map((entry) => (
                    <li key={entry.id} className={`upload-queue-row is-${entry.status}`}>
                      <span className="upload-queue-name">{entry.file.name}</span>
                      <span className="upload-queue-size">{formatBytes(BigInt(entry.file.size))}</span>
                      <span className="upload-queue-state">{queueStateText(entry)}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div
                className="progress-track"
                role="progressbar"
                aria-label="Upload progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                {...(uploading ? { "aria-valuetext": `${percent}% uploaded` } : {})}
                hidden={!uploading}
              >
                <div className="progress-bar" style={{ width: `${percent}%` }} />
              </div>

              <div className="upload-actions">
                {uploading ? (
                  <button type="button" className="button button-secondary" onClick={cancelUpload}>
                    Cancel upload
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button"
                    onClick={() => void runQueue()}
                    disabled={queuedCount === 0 || readyQuota === null}
                  >
                    {entries.length > 1 ? `Upload ${entries.length} dumps` : "Upload dump"}
                  </button>
                )}
                <p
                  className="upload-status"
                  {...(uploading ? { "data-tone": "active" } : {})}
                  aria-live="polite"
                >
                  {statusText}
                </p>
                {uploading && currentName !== null && entries.length > 1 && (
                  <p className="upload-current-file">{currentName}</p>
              )}
              </div>

              <ul className="privacy-list">
                <li>{isBatchLink && readyQuota !== null ? `${readyQuota.maxUploads}-upload case-bound link` : "One-time case-bound link"}</li>
                <li>SHA-256 calculated during transfer</li>
                <li>Original bytes remain immutable</li>
              </ul>
            </>
          )}
        </div>
      </section>
    </PublicLayout>
  );
}

/** One-line per-file state in the selection queue. */
function queueStateText(entry: QueueEntry): string {
  switch (entry.status) {
    case "queued":
      return "Waiting";
    case "uploading":
      return `Uploading… ${Math.round(entry.progress * 100)}%`;
    case "done":
      return entry.outcome?.kind === "complete" && entry.outcome.response.phase === "available"
        ? "Received"
        : entry.outcome?.kind === "complete" && entry.outcome.response.phase === "rejected"
          ? "Not accepted"
          : "Received";
    case "failed":
      return entry.outcome === undefined ? "Not attempted" : "Not sent";
  }
}

/* ---------------------------------------------------------------------------
 * Batch summary presentation
 * ------------------------------------------------------------------------- */

interface BatchSummaryProps {
  readonly entries: readonly QueueEntry[];
  readonly resultRef: { readonly current: HTMLElement | null };
}

/** Batch terminal panel: per-file outcomes, partial success first-class. */
function BatchSummary({ entries, resultRef }: BatchSummaryProps): ReactNode {
  const done = entries.filter((entry) => entry.status === "done").length;
  const total = entries.length;
  const allDone = done === total;
  const tone = allDone ? "success" : done > 0 ? "warn" : "error";
  const heading = allDone
    ? "Batch upload complete"
    : done > 0
      ? "Batch partially uploaded"
      : "No files were uploaded";
  return (
    <section
      className="auth-error upload-result"
      aria-labelledby="upload-result-title"
      tabIndex={-1}
      ref={resultRef}
    >
      <Notice tone={tone} role={allDone ? "status" : "alert"}>
        <strong id="upload-result-title">{heading}</strong>
        <p>
          {done} of {total} {total === 1 ? "file" : "files"} uploaded.
          {allDone
            ? " Everything you sent is with the support team."
            : " Files that were not sent need a new intake link — ask the support team."}
        </p>
        <ul className="upload-batch-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <strong>{entry.file.name}</strong>
              <span> — {batchEntryText(entry)}</span>
              {entry.status === "done" && entry.outcome?.kind === "complete" && (
                <span className="upload-batch-receipt"> (Dump ID: {entry.outcome.response.dumpId})</span>
              )}
            </li>
          ))}
        </ul>
      </Notice>
    </section>
  );
}

/** One-line per-file outcome in the batch summary. */
function batchEntryText(entry: QueueEntry): string {
  if (entry.status === "done") {
    if (entry.outcome?.kind === "complete") {
      if (entry.outcome.response.phase === "available") return "received and available to the support team";
      if (entry.outcome.response.phase === "rejected") return "received but not accepted for this intake";
      return "received and sealed for the support team";
    }
    return "received; processing continues on the server";
  }
  switch (entry.outcome?.kind) {
    case undefined:
      return "not attempted";
    case "slots-exhausted":
      return "not sent — the link had no remaining upload slots";
    case "grant-unavailable":
      return "not sent — the link is not available";
    case "too-large":
      return "not sent — too large for this intake link";
    case "uncertain":
      return "outcome unknown — ask the support team before resending";
    default:
      return "not sent";
  }
}

/* ---------------------------------------------------------------------------
 * Terminal result presentation
 * ------------------------------------------------------------------------- */

interface ResultCopy {
  readonly tone: "success" | "warn" | "error";
  readonly role: "status" | "alert";
  readonly heading: string;
  readonly body: readonly string[];
  readonly receipt?: { readonly dumpId: string; readonly byteSize: bigint; readonly sha256: string };
}

function resultCopy(outcome: UploadOutcome, fileName: string | null): ResultCopy {
  switch (outcome.kind) {
    case "complete": {
      const receipt = {
        dumpId: outcome.response.dumpId,
        byteSize: outcome.response.byteSize,
        sha256: outcome.response.sha256,
      };
      if (outcome.response.phase === "rejected") {
        return {
          tone: "warn",
          role: "status",
          heading: "File received but not accepted",
          body: [
            "Your file arrived, but it could not be processed and was not kept — it may not be a valid crash dump for this intake. This one-time link has been used. If you want to try a different file, ask the support team for a new link.",
          ],
          receipt,
        };
      }
      if (outcome.response.phase === "available") {
        return {
          tone: "success",
          role: "status",
          heading: "Upload complete",
          body: ["Your crash dump was received and is now available to the support team."],
          receipt,
        };
      }
      // "sealed": bytes sealed; post-processing is not part of this response.
      return {
        tone: "success",
        role: "status",
        heading: "Upload received",
        body: ["Your crash dump was received and sealed for the support team."],
        receipt,
      };
    }
    case "queued": {
      const receipt = {
        dumpId: outcome.response.dumpId,
        byteSize: outcome.response.byteSize,
        sha256: outcome.response.sha256,
      };
      if (outcome.response.processing === "retry-queued") {
        return {
          tone: "success",
          role: "status",
          heading: "Upload received — processing queued",
          body: [
            "Your crash dump was received. Further processing is queued and continues automatically on the server; nothing else is needed from you.",
          ],
          receipt,
        };
      }
      return {
        tone: "warn",
        role: "status",
        heading: "Upload received — processing needs recovery",
        body: [
          "Your crash dump was received, but the server could not continue processing it automatically and has flagged it for recovery. Nothing else is needed from you.",
        ],
        receipt,
      };
    }
    case "grant-unavailable":
      // Neutral wording: unknown/revoked/expired/closed-case are
      // indistinguishable, and the backend never reveals which one occurred.
      return {
        tone: "error",
        role: "alert",
        heading: "This intake link is not available",
        body: [
          "The link could not be used. It may have expired, already been used, been revoked, or the case may no longer accept uploads — those causes look the same from here. Ask the support team for a new intake link.",
        ],
      };
    case "slots-exhausted":
      return {
        tone: "error",
        role: "alert",
        heading: "This intake link has no uploads left",
        body: [
          "Every upload this link allows has already been used, so nothing was sent. Ask the support team for a new intake link.",
        ],
      };
    case "too-large": {
      const name = fileName !== null ? `“${fileName}”` : "The chosen file";
      return {
        tone: "error",
        role: "alert",
        heading: "The file is too large for this intake link",
        body: [
          `${name} is larger than the byte limit this intake link allows, so nothing was kept. Ask the support team for a new intake link that can accept a file of this size.`,
        ],
      };
    }
    case "retryable":
      return {
        tone: "error",
        role: "alert",
        heading: "The upload did not start",
        body: [outcome.message, "Nothing was sent and this intake link is still valid, so you can try again."],
      };
    case "uncertain": {
      const opening =
        outcome.reason === "aborted"
          ? "You cancelled the upload before the server confirmed whether your file arrived."
          : outcome.reason === "connection"
            ? "The connection was lost before the server confirmed whether your file arrived."
            : "The server reported a problem before confirming whether your file arrived.";
      return {
        tone: outcome.reason === "aborted" ? "warn" : "error",
        role: "alert",
        heading: "Upload outcome unknown",
        body: [
          opening,
          "This one-time link may already have been consumed even though the transfer was interrupted, so it may not work again. If you are not sure whether your file arrived, ask the support team for a new intake link.",
        ],
      };
    }
  }
}

interface UploadResultProps {
  readonly outcome: UploadOutcome;
  readonly fileName: string | null;
  readonly resultRef: { readonly current: HTMLElement | null };
}

/** Terminal result panel: focused on mount so keyboard/SR users hear it. */
function UploadResult({ outcome, fileName, resultRef }: UploadResultProps): ReactNode {
  const copy = resultCopy(outcome, fileName);
  return (
    <section
      className="auth-error upload-result"
      aria-labelledby="upload-result-title"
      tabIndex={-1}
      ref={resultRef}
    >
      <Notice tone={copy.tone} role={copy.role}>
        <strong id="upload-result-title">{copy.heading}</strong>
        {copy.body.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        {copy.receipt !== undefined && (
          <>
            <p>Dump ID: {copy.receipt.dumpId}</p>
            <p>Size: {formatBytes(copy.receipt.byteSize)}</p>
            <p>SHA-256: {copy.receipt.sha256}</p>
          </>
        )}
      </Notice>
    </section>
  );
}
