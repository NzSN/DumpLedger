/**
 * Export bundle list hook (import/export design, "HTTP and UI surface").
 *
 * Loads `GET /api/v1/operations/exports` through the shared HTTP client and
 * follows the same bounded polling rules as the operations summary:
 *   - a fresh load starts on mount and after every manual refresh,
 *   - interval polling runs ONLY while at least one export is `running` (a
 *     sealed or failed bundle never changes on its own),
 *   - while `document.hidden` no interval tick starts a request,
 *   - a tick never overlaps an outstanding request,
 *   - every request is abortable: unmount or a newer request aborts the
 *     active one, and a late response is discarded.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeListExportsResponse, type ListExportsResponse } from "@dump-ledger/http-contracts";
import { useHttpClient } from "../../shared/http-client-context";

export const EXPORTS_PATH = "/api/v1/operations/exports";

/** Poll cadence while an export bundle is running. */
export const EXPORT_LIST_POLL_INTERVAL_MS = 2_000;

export type ExportListPhase =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: ListExportsResponse }
  | { readonly status: "error"; readonly error: unknown };

export interface ExportListControls {
  readonly phase: ExportListPhase;
  /** True while any export list request is in flight. */
  readonly busy: boolean;
  readonly refresh: () => void;
}

export function useExportList(intervalMs: number): ExportListControls {
  const client = useHttpClient();
  const [phase, setPhase] = useState<ExportListPhase>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  // Guard state stays in refs so interval closures never go stale.
  const busyRef = useRef(false);
  const runningRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const fetchOnce = useCallback(
    async (showLoading: boolean): Promise<void> => {
      if (busyRef.current) return; // never overlap an outstanding request
      busyRef.current = true;
      setBusy(true);
      const controller = new AbortController();
      controllerRef.current?.abort();
      controllerRef.current = controller;
      const generation = ++generationRef.current;
      if (showLoading) setPhase({ status: "loading" });
      try {
        const data = await client.query({
          path: EXPORTS_PATH,
          decoder: decodeListExportsResponse,
          signal: controller.signal,
        });
        if (controller.signal.aborted || generation !== generationRef.current) return;
        runningRef.current = data.exports.some((entry) => entry.status === "running");
        setPhase({ status: "ready", data });
      } catch (error: unknown) {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        setPhase({ status: "error", error });
      } finally {
        // Only the newest request may release the in-flight guard.
        if (generation === generationRef.current) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [client],
  );

  const refresh = useCallback(() => {
    void fetchOnce(false);
  }, [fetchOnce]);

  useEffect(() => {
    void fetchOnce(true);

    const onVisibilityChange = (): void => {
      if (!document.hidden && runningRef.current) {
        // A tick may have been skipped while hidden; refresh immediately.
        void fetchOnce(false);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    if (intervalMs <= 0) {
      return () => {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        controllerRef.current?.abort();
      };
    }
    const timer = window.setInterval(() => {
      if (document.hidden || busyRef.current || !runningRef.current) return;
      void fetchOnce(false);
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      controllerRef.current?.abort();
    };
  }, [fetchOnce, intervalMs]);

  return { phase, busy, refresh };
}
