/**
 * UploadPage — public one-time dump intake (design sections 6, 7.6, 8.4, 9).
 *
 * Transport rules:
 *   - The one-time grant arrives only in the URL fragment
 *     (`/upload#grant=<base64url-secret>`). The page reads it into
 *     route-local memory on mount and immediately strips the fragment with
 *     `history.replaceState` (fragments are never sent to the server). The
 *     secret is never persisted, never logged, and never written anywhere
 *     beyond this route's memory.
 *   - The chosen file is streamed straight through the shared http-client's
 *     `upload()` API (`XMLHttpRequest.send(file)`). Bytes are never read into
 *     an ArrayBuffer, base64-encoded, placed in JSON, or copied into React
 *     state. The http-client owns the `X-Dump-Filename-Base64url` header and
 *     progress events; this page passes the filename through the request
 *     contract.
 *   - Automatic retry is disabled entirely. Because the grant is one-time and
 *     may be consumed even if the browser aborts or loses the network, only a
 *     confirmed "never started" server error (503/429, contract `retryable`)
 *     offers a manual retry; every other terminal state directs the customer
 *     to request a new link.
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
import { PublicLayout } from "../../app/layouts";
import { Notice } from "../../shared/components/notice";
import { classNames } from "../../shared/classnames";
import { formatBytes } from "../../shared/format";
import { outcomeFromError, outcomeFromSuccess, type UploadOutcome } from "./upload-outcomes";
import { readGrantSecret, scrubGrantFragment } from "./grant-fragment";
import "./uploads.css";

/** Raw byte endpoint (design section 7.6); the http-client streams the file. */
const UPLOAD_ENDPOINT = "/api/v1/uploads";

function clampFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction));
}

export function UploadPage(): ReactNode {
  const client = useHttpClient();

  // The one-time grant held only for the lifetime of this route instance.
  const [grant, setGrant] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [terminal, setTerminal] = useState<UploadOutcome | null>(null);
  const [retry, setRetry] = useState<{ readonly message: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handleRef = useRef<{ abort(): void } | null>(null);
  const resultRef = useRef<HTMLElement | null>(null);
  const retryRef = useRef<HTMLDivElement | null>(null);

  // Fragment grant transport (design 7.6 / 9): read the secret into memory,
  // then strip the fragment so it cannot linger in the address bar. The read
  // happens before the scrub; re-running this effect is idempotent because a
  // second run finds no fragment left and leaves the captured secret alone.
  useEffect(() => {
    const secret = readGrantSecret(window.location);
    if (scrubGrantFragment(window.location, window.history) && secret !== null) {
      setGrant(secret);
    }
  }, []);

  // Abort an in-flight upload when the customer leaves the route, so the
  // request cannot continue silently after unmount.
  useEffect(() => {
    return () => {
      handleRef.current?.abort();
    };
  }, []);

  // Move focus to the terminal result (design 8.4) and to a retryable error.
  useEffect(() => {
    if (terminal !== null) resultRef.current?.focus();
  }, [terminal]);
  useEffect(() => {
    if (retry !== null) retryRef.current?.focus();
  }, [retry]);

  function openPicker(): void {
    if (uploading) return;
    fileInputRef.current?.click();
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const chosen = event.target.files !== null ? (event.target.files[0] ?? null) : null;
    // Reset the value so choosing the same file again still fires a change.
    event.target.value = "";
    if (chosen !== null) {
      setFile(chosen);
      setRetry(null);
    }
  }

  function handleDragOver(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault();
    if (!uploading) setDragging(true);
  }

  function handleDragLeave(): void {
    setDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault();
    setDragging(false);
    if (uploading) return;
    const dropped = event.dataTransfer.files.length > 0 ? (event.dataTransfer.files[0] ?? null) : null;
    if (dropped !== null) {
      setFile(dropped);
      setRetry(null);
    }
  }

  function cancelUpload(): void {
    handleRef.current?.abort();
  }

  async function startUpload(): Promise<void> {
    if (grant === null || file === null || uploading) return;
    const selected = file;
    setUploading(true);
    setProgress(0);
    setRetry(null);
    try {
      // The shared client owns X-Upload-Grant / X-Dump-Filename-Base64url and
      // streams the File directly (never buffered). No automatic retry.
      const handle = client.upload(
        {
          path: UPLOAD_ENDPOINT,
          file: selected,
          grant,
          filename: selected.name,
        },
        { onProgress: (fraction) => setProgress(clampFraction(fraction)) },
      );
      handleRef.current = handle;
      const success = await handle.result;
      setTerminal(outcomeFromSuccess(success));
    } catch (error) {
      const mapped = outcomeFromError(error);
      if (mapped.kind === "retryable") {
        // The request never started, so the one-time grant is still valid.
        // Retry stays manual — the server's retryable flag only tells us a
        // repeat may succeed, it never triggers one.
        setRetry({ message: mapped.message });
      } else {
        setTerminal(mapped);
      }
    } finally {
      handleRef.current = null;
      setUploading(false);
    }
  }

  const percent = Math.round(progress * 100);
  const statusText = uploading
    ? `Uploading… ${percent}%`
    : file !== null
      ? "Ready to upload"
      : "Select a file to continue";

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
            Your file is sent directly to this private DumpLedger instance and associated with the intended
            support case.
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
          ) : terminal !== null ? (
            <UploadResult outcome={terminal} fileName={file?.name ?? null} resultRef={resultRef} />
          ) : (
            <>
              <Notice tone="warn">
                <strong>One-time intake link</strong>
                <p>
                  This link works for a single upload. Once the transfer starts it may be consumed even if the
                  browser is closed, the connection is lost, or the upload is cancelled. If the result is unclear,
                  ask the support team for a new link instead of reusing this one.
                </p>
              </Notice>

              {retry !== null && (
                <div ref={retryRef} tabIndex={-1} className="auth-error">
                  <Notice tone="error" role="alert">
                    <strong>The upload did not start</strong>
                    <p>{retry.message}</p>
                    <p>Nothing was sent and this intake link is still valid, so you can try again.</p>
                    <p>
                      <button type="button" className="button button-small" onClick={() => void startUpload()}>
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
                  file !== null ? "has-file" : undefined,
                  dragging ? "is-dragging" : undefined,
                )}
                aria-label="Choose a minidump or drop it here"
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
                <span className="drop-title">Choose a minidump or drop it here</span>
                <span className="drop-copy">Partial and full-memory Windows minidumps are accepted</span>
                {file !== null ? (
                  <span className="selected-file">
                    <strong>{file.name}</strong>
                    <span>{formatBytes(BigInt(file.size))}</span>
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
                aria-label="Choose a minidump file"
                tabIndex={-1}
                onChange={handleFileChange}
              />

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
                    onClick={() => void startUpload()}
                    disabled={file === null}
                  >
                    Upload dump
                  </button>
                )}
                <p
                  className="upload-status"
                  {...(uploading ? { "data-tone": "active" } : {})}
                  aria-live="polite"
                >
                  {statusText}
                </p>
              </div>

              <ul className="privacy-list">
                <li>One-time case-bound link</li>
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
      // Neutral wording: unknown/revoked/expired/consumed/closed-case are
      // indistinguishable, and the backend never reveals which one occurred.
      return {
        tone: "error",
        role: "alert",
        heading: "This intake link is not available",
        body: [
          "The link could not be used. It may have expired, already been used, been revoked, or the case may no longer accept uploads — those causes look the same from here. Ask the support team for a new intake link.",
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
