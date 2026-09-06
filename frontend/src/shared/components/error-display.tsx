/**
 * ErrorDisplay — renders any thrown value as a stable operator-facing notice
 * (design section 8.4). A retry affordance is offered only when the contract
 * error is `retryable` and the caller provides an `onRetry` handler.
 */

import type { ReactNode } from "react";
import { errorText, HttpRequestError } from "../http-client";
import { Notice, type NoticeProps } from "./notice";

export interface ErrorDisplayProps {
  readonly error: unknown;
  readonly onRetry?: () => void;
  readonly className?: string;
}

export function ErrorDisplay({ error, onRetry, className }: ErrorDisplayProps): ReactNode {
  const retryable = error instanceof HttpRequestError && error.retryable;
  return (
    <Notice
      tone="error"
      role="alert"
      {...(className !== undefined ? { className } : {})}
    >
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
  );
}
