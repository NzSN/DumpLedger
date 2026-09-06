/**
 * Operations polling hook (design sections 7.7 and 8.3).
 *
 * Bounded polling rules:
 *   - a fresh load starts on mount and after every manual refresh,
 *   - while `document.hidden` no interval tick starts a request,
 *   - an interval tick never overlaps an outstanding request (the tick is
 *     skipped while one is in flight),
 *   - becoming visible again triggers an immediate refresh,
 *   - every request is abortable: unmount or a newer request aborts the
 *     active one, and a response that resolves after the abort is discarded.
 *
 * All loads go through the shared HTTP client; no direct fetch.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeOperationsResponse, type OperationsResponse } from "@dump-ledger/http-contracts";
import { useHttpClient } from "../../shared/http-client-context";

export type OperationsPhase =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: OperationsResponse }
  | { readonly status: "error"; readonly error: unknown };

export interface OperationsControls {
  readonly phase: OperationsPhase;
  /** True while any operations request is in flight (refresh button disabled). */
  readonly busy: boolean;
  readonly refresh: () => void;
}

export function useOperationsPolling(intervalMs: number): OperationsControls {
  const client = useHttpClient();
  const [phase, setPhase] = useState<OperationsPhase>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  // Guard state stays in refs so interval closures never go stale.
  const busyRef = useRef(false);
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
          path: "/api/v1/operations",
          decoder: decodeOperationsResponse,
          signal: controller.signal,
        });
        if (controller.signal.aborted || generation !== generationRef.current) return;
        setPhase({ status: "ready", data });
      } catch (error: unknown) {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        setPhase({ status: "error", error });
      } finally {
        // Only the newest request may release the in-flight guard; an aborted
        // superseded request must not clear the guard while its replacement
        // is still running.
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
      if (!document.hidden) {
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
      if (document.hidden || busyRef.current) return;
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
