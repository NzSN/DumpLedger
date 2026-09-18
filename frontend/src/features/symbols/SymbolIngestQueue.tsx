/**
 * SymbolIngestQueue — multi-file PDB/EXE/DLL ingest with a strictly sequential
 * queue (docs/symbols-design.md, "Ingest (operator surface)").
 *
 * Structure follows the public uploader's batch queue (UploadPage) but owns
 * its markup and copy: selection through a native file input and a drop zone,
 * then one raw `POST /api/v1/symbols` per file — in selection order, one
 * request at a time — through the shared client's operator raw-upload seam.
 * Every file reports its own outcome: the server-parsed identity on success
 * (or `already registered` for a deduplicated identity), or the stable
 * rejection copy. There is no automatic retry; re-selecting the file is the
 * operator's explicit action.
 *
 * Progress and status live in local React state only; bytes are streamed by
 * the client (never buffered, base64-encoded, or copied into state).
 */

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import { MAX_SYMBOL_BYTES, type SymbolIngestResponse } from "@dump-ledger/http-contracts";
import { classNames } from "../../shared/classnames";
import { formatBytes } from "../../shared/format";
import { Panel } from "../../shared/components/panel";
import type { SymbolsApi } from "./symbols-api";
import { ingestFailureText, ingestResultText } from "./symbols-copy";

function clampFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction));
}

/** One file in the sequential ingest queue. */
interface IngestEntry {
  readonly id: number;
  readonly file: File;
  readonly status: "waiting" | "uploading" | "done" | "failed";
  readonly progress: number;
  /** Server-parsed identity; present after a successful (or dedup) ingest. */
  readonly response?: SymbolIngestResponse;
  /** Stable operator copy for a rejected file. */
  readonly failure?: string;
}

export interface SymbolIngestQueueProps {
  readonly api: SymbolsApi;
  /** Called after a drain in which at least one file settled successfully. */
  readonly onIngested: () => void;
}

function queueStateText(entry: IngestEntry): string {
  switch (entry.status) {
    case "waiting":
      return "Waiting";
    case "uploading":
      return `${Math.round(entry.progress * 100)}%`;
    case "done":
      return entry.response?.deduplicated === true ? "Already registered" : "Registered";
    case "failed":
      return "Failed";
  }
}

export function SymbolIngestQueue({ api, onIngested }: SymbolIngestQueueProps): ReactNode {
  const [entries, setEntries] = useState<readonly IngestEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const entriesRef = useRef<readonly IngestEntry[]>([]);
  const nextIdRef = useRef(1);
  const drainingRef = useRef(false);
  const disposedRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // A route change aborts the in-flight file and silences later state writes.
  useEffect(() => {
    return () => {
      disposedRef.current = true;
      controllerRef.current?.abort();
    };
  }, []);

  function commit(next: readonly IngestEntry[]): void {
    if (disposedRef.current) return;
    entriesRef.current = next;
    setEntries(next);
  }

  function patchEntry(id: number, apply: (entry: IngestEntry) => IngestEntry): void {
    commit(entriesRef.current.map((entry) => (entry.id === id ? apply(entry) : entry)));
  }

  function addFiles(files: readonly File[]): void {
    if (files.length === 0) return;
    const stamped = files.map(
      (file): IngestEntry => ({ id: nextIdRef.current++, file, status: "waiting", progress: 0 }),
    );
    commit([...entriesRef.current, ...stamped]);
    void drainQueue();
  }

  /** Drains every waiting file, in order, one request at a time. */
  async function drainQueue(): Promise<void> {
    if (drainingRef.current) return;
    drainingRef.current = true;
    if (!disposedRef.current) setBusy(true);
    let anyRegistered = false;
    try {
      for (;;) {
        if (disposedRef.current) return;
        const next = entriesRef.current.find((entry) => entry.status === "waiting");
        if (next === undefined) break;
        patchEntry(next.id, (entry) => ({ ...entry, status: "uploading", progress: 0 }));
        const controller = new AbortController();
        controllerRef.current = controller;
        try {
          const response = await api.ingestSymbol(next.file, {
            signal: controller.signal,
            onProgress: (fraction) => {
              patchEntry(next.id, (entry) => ({ ...entry, progress: clampFraction(fraction) }));
            },
          });
          patchEntry(next.id, (entry) => ({ ...entry, status: "done", progress: 1, response }));
          anyRegistered = true;
        } catch (error) {
          if (disposedRef.current) return;
          patchEntry(next.id, (entry) => ({
            ...entry,
            status: "failed",
            progress: 0,
            failure: ingestFailureText(error),
          }));
        } finally {
          controllerRef.current = null;
        }
      }
    } finally {
      drainingRef.current = false;
      if (!disposedRef.current) setBusy(false);
    }
    if (anyRegistered && !disposedRef.current) onIngested();
  }

  function openPicker(): void {
    if (busy) return;
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
    if (!busy) setDragging(true);
  }

  function handleDragLeave(): void {
    setDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    addFiles(Array.from(event.dataTransfer.files));
  }

  const currentIndex = entries.findIndex((entry) => entry.status === "uploading");
  const current = currentIndex >= 0 ? entries[currentIndex] : undefined;
  const uploading = current !== undefined;
  const percent = current === undefined ? 0 : Math.round(current.progress * 100);
  const doneCount = entries.filter((entry) => entry.status === "done").length;
  const failedCount = entries.filter((entry) => entry.status === "failed").length;
  const settledCount = doneCount + failedCount;
  const statusText = uploading
    ? entries.length > 1
      ? `Ingesting file ${currentIndex + 1} of ${entries.length}… ${percent}%`
      : `Ingesting… ${percent}%`
    : entries.length === 0
      ? "Select symbol files to ingest"
      : `${settledCount} of ${entries.length} files processed`;

  return (
    <Panel
      title="Ingest symbol files"
      subtitle={`Identity is parsed from the bytes; one file streams at a time, up to ${formatBytes(MAX_SYMBOL_BYTES)} each.`}
    >
      <button
        type="button"
        className={classNames(
          "drop-zone",
          "symbol-drop-zone",
          entries.length > 0 ? "has-file" : undefined,
          dragging ? "is-dragging" : undefined,
        )}
        aria-label="Choose symbol files or drop them here"
        disabled={busy}
        onClick={openPicker}
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span className="drop-icon" aria-hidden="true">
          ⇧
        </span>
        <span className="drop-title">Choose symbol files or drop them here</span>
        <span className="drop-copy">
          PDB, EXE, and DLL; the filename is display-only and the server derives the identity from the file
        </span>
      </button>

      {/* The native input stays in the DOM (programmatic picker + accessible
          control) but is visually hidden and not a tab stop. */}
      <input
        ref={fileInputRef}
        id="symbol-files"
        className="symbol-file-input"
        type="file"
        accept=".pdb,.exe,.dll,application/octet-stream"
        aria-label="Choose symbol files"
        tabIndex={-1}
        multiple
        onChange={handleFileChange}
      />

      {entries.length > 0 && (
        <ul className="symbol-queue" aria-label="Symbol ingest queue">
          {entries.map((entry) => (
            <li key={entry.id} className={classNames("symbol-queue-row", `is-${entry.status}`)}>
              <span className="symbol-queue-name mono" title={entry.file.name}>
                {entry.file.name}
              </span>
              <span className="symbol-queue-size">{formatBytes(BigInt(entry.file.size))}</span>
              <span className="symbol-queue-state">{queueStateText(entry)}</span>
              {entry.status === "done" && entry.response !== undefined && (
                <span className="symbol-queue-result">{ingestResultText(entry.response)}</span>
              )}
              {entry.status === "failed" && entry.failure !== undefined && (
                <span className="symbol-queue-result">{entry.failure}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {uploading && (
        <div
          className="progress-track"
          role="progressbar"
          aria-label="Ingest progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${percent}% ingested`}
        >
          <div className="progress-bar" style={{ width: `${percent}%` }} />
        </div>
      )}

      <p className="symbol-queue-status" aria-live="polite">
        {statusText}
        {entries.length > 0 && failedCount > 0 ? ` — ${failedCount} failed` : ""}
      </p>
    </Panel>
  );
}
