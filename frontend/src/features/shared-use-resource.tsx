/**
 * Feature-scoped async resource primitives (design section 8.3).
 *
 * Operator feature pages own their own bounded loads through the shared HTTP
 * client. They share a few small behaviors here instead of pulling in a query
 * library:
 *
 *   - `useResource` loads on mount, on `reload()`, and when the caller's
 *     `deps` change; it aborts any in-flight request on unmount or
 *     supersession and never lets an older response overwrite newer state.
 *     A manual `reload()` (for example after a successful mutation) keeps the
 *     current data on screen while the fresh load runs, so the mutation's
 *     focus-moved summary is not unmounted by the refetch.
 *   - `useMutationFlow` owns one mutation's pending/error/result state and
 *     aborts the active request on route change,
 *   - the focus summaries move keyboard/screen-reader focus to a finished
 *     mutation's result or error (design section 8.4).
 *
 * Pages compose these with the shared presentation components; no domain
 * logic lives here.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { errorText } from "../shared/http-client";
import { Notice } from "../shared/components/notice";

export type ResourceAsyncState<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: T }
  | { readonly status: "error"; readonly error: unknown };

export interface ResourceApi<T> {
  readonly state: ResourceAsyncState<T>;
  /**
   * Starts a fresh authoritative load; aborts the in-flight one first. When
   * data is already on screen it stays visible until the fresh load resolves.
   */
  readonly reload: () => void;
}

/**
 * Runs `loader(signal)` on mount, on every `reload()`, and again whenever
 * `deps` change (for example a caseId in the URL). The loader receives an
 * AbortSignal that is aborted on unmount or supersession, and any response
 * that resolves after that signal is discarded, so a slow older response can
 * never overwrite a newer route's state.
 */
export function useResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps?: readonly unknown[],
): ResourceApi<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const [state, setState] = useState<ResourceAsyncState<T>>({ status: "loading" });
  const [generation, setGeneration] = useState(0);
  // A manual reload() marks the next effect run as stale-preserving.
  const keepStaleRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let settled = false;
    const keepStale = keepStaleRef.current;
    keepStaleRef.current = false;
    if (!keepStale) {
      // First load, deps change, or a retry from an error: show the loading
      // state. A reload with data on screen leaves that data visible.
      setState({ status: "loading" });
    }
    loaderRef
      .current(controller.signal)
      .then((data) => {
        if (settled || controller.signal.aborted) return;
        settled = true;
        setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (settled || controller.signal.aborted) return;
        settled = true;
        setState({ status: "error", error });
      });
    return () => {
      // Unmount or a newer load: ignore anything this request still resolves.
      settled = true;
      controller.abort();
    };
  }, [generation, ...(deps ?? [])]);

  const reload = useCallback(() => {
    keepStaleRef.current = true;
    setGeneration((value) => value + 1);
  }, []);

  return { state, reload };
}

/**
 * Returns a ref that receives focus whenever `active` becomes true. Used to
 * move focus to the summary of a finished mutation without trapping the rest
 * of the page.
 */
export function useAutoFocus<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (active && ref.current !== null) {
      ref.current.focus();
    }
  }, [active]);
  return ref;
}

/**
 * Error summary shown after a failed mutation. It carries `role="alert"` and
 * focus moves to the summary so keyboard and screen-reader users hear the
 * result (design section 8.4). Renders nothing while there is no error.
 */
export function MutationErrorSummary({
  error,
  fallback = "The request failed.",
}: {
  readonly error: unknown;
  readonly fallback?: string;
}): ReactNode {
  const ref = useAutoFocus<HTMLDivElement>(error !== null && error !== undefined);
  if (error === null || error === undefined) return null;
  return (
    <div ref={ref} tabIndex={-1}>
      <Notice tone="error" role="alert">
        <p>{errorText(error, fallback)}</p>
      </Notice>
    </div>
  );
}

/**
 * Success summary shown after a mutation succeeds. Focus moves to it; the
 * caller supplies the notice body (for example a created case with a link to
 * its detail page). Renders nothing while `active` is false.
 */
export function MutationSuccessSummary({
  active,
  children,
}: {
  readonly active: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const ref = useAutoFocus<HTMLDivElement>(active);
  if (!active) return null;
  return (
    <div ref={ref} tabIndex={-1}>
      <Notice tone="success" role="status">
        {children}
      </Notice>
    </div>
  );
}

export interface MutationFlow<T> {
  /** True while a mutation request is in flight (submit button disabled). */
  readonly pending: boolean;
  /** Last failure; null after a fresh run. */
  readonly error: unknown;
  /** Last success value; null after a fresh run. */
  readonly result: T | null;
  /**
   * Runs the mutator. Resolves to the mutation's success value on an
   * un-aborted success, or to `null` when the request failed or was aborted.
   * Callers never need to capture a value through a closure variable, so the
   * resolved value stays visible to the type checker.
   */
  readonly run: (mutator: (signal: AbortSignal) => Promise<T>) => Promise<T | null>;
}

/**
 * Owns the pending/error/result state of one mutation at a time. Every run
 * aborts any previous in-flight request and a route unmount aborts the active
 * request, matching the "requests are abortable on route change" rule. Success
 * and failure values are rendered by the caller inside a focus summary.
 */
export function useMutationFlow<T>(): MutationFlow<T> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<T | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  const run = useCallback(async (mutator: (signal: AbortSignal) => Promise<T>): Promise<T | null> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const value = await mutator(controller.signal);
      if (controller.signal.aborted) return null;
      setResult(value);
      return value;
    } catch (cause: unknown) {
      if (controller.signal.aborted) return null;
      setError(cause);
      return null;
    } finally {
      setPending(false);
    }
  }, []);

  return { pending, error, result, run };
}
