/**
 * Feature-scoped page chrome (design section 8.4).
 *
 * Feature pages keep their real screen heading rendered in every async state
 * (loading, error, ready) so the shell, routing, and session tests that rely
 * on the heading keep passing, and so keyboard/screen-reader users always
 * have a stable landmark. Content below the heading swaps with the resource
 * state. Shared presentation components do the heavy lifting; nothing here is
 * a domain-logic layer.
 *
 * Page-load failures render as a polite `role="status"` notice: the assertive
 * `role="alert"` live region is reserved for mutations, whose finished result
 * also moves focus (design section 8.4). Callers that need the assertive
 * semantics on a user-initiated action should use the mutation summaries in
 * `shared-use-resource` instead.
 */

import { useId, type ReactNode } from "react";
import { errorText, HttpRequestError } from "../shared/http-client";
import { Notice } from "../shared/components/notice";

export interface FeaturePageProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly eyebrow?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}

export function FeaturePage({ title, subtitle, eyebrow, actions, children }: FeaturePageProps): ReactNode {
  const titleId = useId();
  return (
    <section className="placeholder-page" aria-labelledby={titleId}>
      <header className="page-heading">
        <div>
          {eyebrow !== undefined && <p className="eyebrow">{eyebrow}</p>}
          <h1 id={titleId} className="screen-title">
            {title}
          </h1>
          {subtitle !== undefined && <p>{subtitle}</p>}
        </div>
        {actions !== undefined && <div className="heading-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** Inline loading message with polite live-region semantics. */
export function LoadingState({ label = "Loading…" }: { readonly label?: string }): ReactNode {
  return (
    <p role="status" className="screen-subtitle">
      {label}
    </p>
  );
}

export interface ResourceErrorProps {
  readonly error: unknown;
  readonly onRetry?: () => void;
}

/**
 * Stable operator-facing page-load error. Uses the polite `status` live
 * region (the page content region changed as a whole); retry is offered only
 * for contract errors the server marked retryable.
 */
export function ResourceError({ error, onRetry }: ResourceErrorProps): ReactNode {
  const retryable = error instanceof HttpRequestError && error.retryable;
  return (
    <section aria-label="Load error">
      <Notice tone="error" role="status">
        <strong>Request failed</strong>
        <p>{errorText(error)}</p>
        {retryable && onRetry !== undefined && (
          <p>
            <button type="button" className="button button-small" onClick={onRetry}>
              Try again
            </button>
          </p>
        )}
      </Notice>
    </section>
  );
}
