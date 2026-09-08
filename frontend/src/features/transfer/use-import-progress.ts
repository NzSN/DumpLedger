/**
 * Import progress polling hook (import/export design, "HTTP and UI surface").
 *
 * While an import id is active, polls `GET /api/v1/operations/imports/:id`
 * through the shared HTTP client:
 *   - the first poll starts immediately, then roughly every interval,
 *   - polling stops for good on a terminal status (`finished` / `failed`)
 *     or a request failure — a terminal import never changes again,
 *   - while `document.hidden` no interval tick starts a request,
 *   - a tick never overlaps an outstanding request,
 *   - unmount or a newer import id aborts the in-flight request and any
 *     late response is discarded.
 */

import { useEffect, useRef, useState } from "react";
import { decodeImportProgressResponse, type ImportProgressResponse } from "@dump-ledger/http-contracts";
import { useHttpClient } from "../../shared/http-client-context";

/** Default poll cadence while an import runs (about one second). */
export const IMPORT_PROGRESS_POLL_INTERVAL_MS = 1_000;

export interface ImportProgressState {
  /** Latest progress snapshot; null until the first poll resolves. */
  readonly progress: ImportProgressResponse | null;
  /** Poll failure; polling stops once set. */
  readonly error: unknown;
}

export function useImportProgress(importId: string | null, intervalMs: number): ImportProgressState {
  const client = useHttpClient();
  const [progress, setProgress] = useState<ImportProgressResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const busyRef = useRef(false);
  const terminalRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (importId === null) return;
    setProgress(null);
    setError(null);
    busyRef.current = false;
    terminalRef.current = false;
    let disposed = false;
    const path = `/api/v1/operations/imports/${encodeURIComponent(importId)}`;

    const poll = async (): Promise<void> => {
      if (disposed || busyRef.current || terminalRef.current || document.hidden) return;
      busyRef.current = true;
      const controller = new AbortController();
      controllerRef.current?.abort();
      controllerRef.current = controller;
      try {
        const data = await client.query({ path, decoder: decodeImportProgressResponse, signal: controller.signal });
        if (disposed || controller.signal.aborted) return;
        setProgress(data);
        if (data.status !== "running") terminalRef.current = true;
      } catch (pollError: unknown) {
        if (disposed || controller.signal.aborted) return;
        setError(pollError);
        // A failed poll stops the loop; the operator can retry the import.
        terminalRef.current = true;
      } finally {
        busyRef.current = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, intervalMs);
    const onVisibilityChange = (): void => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      controllerRef.current?.abort();
    };
  }, [client, importId, intervalMs]);

  return { progress, error };
}
