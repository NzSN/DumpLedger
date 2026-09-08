/**
 * Shared transfer-panel pieces: the 409 "another transfer is running"
 * conflict surface. Export and import are mutually exclusive on the server
 * (one transfer at a time), so both panels render the same notice.
 */

import type { ReactNode } from "react";
import { HttpRequestError } from "../../shared/http-client";
import { Notice } from "../../shared/components/notice";
import { useAutoFocus } from "../shared-use-resource";

/** True when the server refused a transfer mutation because one is running. */
export function isTransferConflict(error: unknown): boolean {
  return error instanceof HttpRequestError && error.status === 409;
}

/**
 * Inline conflict notice for a 409 while a transfer job runs. Rendered with
 * the assertive alert semantics of a mutation failure; focus moves to it.
 */
export function TransferConflictNotice({ active }: { readonly active: boolean }): ReactNode {
  const ref = useAutoFocus<HTMLDivElement>(active);
  if (!active) return null;
  return (
    <div ref={ref} tabIndex={-1}>
      <Notice tone="warn" role="alert">
        <p>
          Another transfer is already running. Wait for it to finish, then try again.
        </p>
      </Notice>
    </div>
  );
}
