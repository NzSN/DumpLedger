/**
 * Operator grant components (design section 7.5), composed on the case
 * detail page.
 *
 *   CreateGrantForm  — POST /api/v1/cases/:caseId/grants with bounded
 *                      `validForHours` and `maxBytes`. Byte values stay as
 *                      strings until they become `bigint`; they are never
 *                      routed through a JavaScript `number`.
 *   ShareLinkCard    — renders the one-time upload URL built ONLY from
 *                      `location.origin + uploadPath`. The upload path (with
 *                      its grant secret) lives in route-local React state and
 *                      disappears when the operator navigates away; the Host
 *                      header is never trusted.
 *   GrantRow         — one bounded grant row with a confirmed revoke mutation
 *                      (`POST /api/v1/grants/:grantId/revoke`).
 */

import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  decodeCreateGrantResponse,
  decodeRevokeGrantResponse,
  encodeCreateGrantRequest,
  MAX_GRANT_VALID_FOR_HOURS,
  type CaseGrantSummary,
  type CreateGrantResponse,
  type GrantRecord,
} from "@dump-ledger/http-contracts";
import { useHttpClient } from "../../shared/http-client-context";
import { FormField } from "../../shared/components/form-field";
import { ConfirmationDialog } from "../../shared/components/confirmation-dialog";
import { StatusPill } from "../../shared/components/status-pill";
import { formatUtcTimestamp, formatBytes } from "../../shared/format";
import { grantStatePresentation } from "../../shared/status";
import {
  MutationErrorSummary,
  MutationSuccessSummary,
  useAutoFocus,
  useMutationFlow,
} from "../shared-use-resource";

const DEFAULT_VALID_FOR_HOURS = 24;
const DEFAULT_MAX_BYTES = 10737418240n; // 10 GiB

function parsePositiveBigInt(value: string): bigint | null {
  if (!/^[0-9]+$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

export interface ShareLinkCardProps {
  readonly uploadPath: string;
}

/** Shareable one-time upload URL: location.origin + the relative upload path. */
function buildShareUrl(uploadPath: string): string {
  return `${window.location.origin}${uploadPath}`;
}

/**
 * Displays the shareable URL in a read-only field with a copy action. The
 * upload path (carrying the one-time secret) is supplied by the caller from
 * its own route-local state, so the secret is never stored globally and is
 * gone when the route unmounts.
 */
export function ShareLinkCard({ uploadPath }: ShareLinkCardProps): ReactNode {
  const ref = useAutoFocus<HTMLDivElement>(true);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [copied, setCopied] = useState(false);
  const url = buildShareUrl(uploadPath);

  async function handleCopy(): Promise<void> {
    const input = inputRef.current;
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard !== undefined &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(url);
      } else {
        // Clipboard API unavailable: select the text and fall back to the
        // legacy copy command so the operator can still copy from the field.
        input?.focus();
        input?.select();
        if (typeof document !== "undefined" && typeof document.execCommand === "function") {
          document.execCommand("copy");
        }
      }
      setCopied(true);
    } catch {
      // Copy failed; leave the URL selected so the user can copy manually.
      input?.focus();
      input?.select();
      setCopied(false);
    }
  }

  return (
    <div ref={ref} tabIndex={-1} className="copy-row" aria-label="Shareable upload link">
      <input
        ref={inputRef}
        type="text"
        readOnly
        value={url}
        aria-label="Shareable upload URL"
        onFocus={(event) => event.currentTarget.select()}
        className="mono"
      />
      <button type="button" className={copied ? "button button-small is-copied" : "button button-small"} onClick={() => void handleCopy()}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export interface CreateGrantFormProps {
  readonly caseId: string;
  /** Called with the created grant so the page refetches authoritative state. */
  readonly onCreated: (grant: GrantRecord) => void;
}

/** Creates a one-time upload grant; on success reveals the share link. */
export function CreateGrantForm({ caseId, onCreated }: CreateGrantFormProps): ReactNode {
  const client = useHttpClient();
  const flow = useMutationFlow<CreateGrantResponse>();
  const hoursId = useId();
  const bytesId = useId();
  const [hoursText, setHoursText] = useState(String(DEFAULT_VALID_FOR_HOURS));
  const [bytesText, setBytesText] = useState(DEFAULT_MAX_BYTES.toString());
  const [hoursError, setHoursError] = useState<string | undefined>(undefined);
  const [bytesError, setBytesError] = useState<string | undefined>(undefined);

  const pending = flow.pending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const hours = Number(hoursText);
    if (!/^[0-9]+$/.test(hoursText) || !Number.isSafeInteger(hours) || hours < 1 || hours > MAX_GRANT_VALID_FOR_HOURS) {
      setHoursError(`Whole hours from 1 to ${MAX_GRANT_VALID_FOR_HOURS}.`);
      return;
    }
    // A field that is now valid stops showing its stale error even when a
    // later field still fails, so one invalid field never masks another.
    setHoursError(undefined);
    const maxBytes = parsePositiveBigInt(bytesText);
    if (maxBytes === null) {
      setBytesError("Enter a whole number of bytes greater than zero.");
      return;
    }
    setBytesError(undefined);
    const created = await flow.run(async (signal) => {
      const response = await client.mutate({
        path: `/api/v1/cases/${encodeURIComponent(caseId)}/grants`,
        method: "POST",
        body: encodeCreateGrantRequest({ validForHours: hours, maxBytes }),
        decoder: decodeCreateGrantResponse,
        signal,
      });
      return response;
    });
    if (created !== null) {
      onCreated(created.grant);
    }
  }

  return (
    <form className="form-stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
      <MutationErrorSummary error={flow.error} fallback="The upload link could not be created." />
      {flow.result !== null && (
        <MutationSuccessSummary active={true}>
          <p>
            New one-time link for this case. Share it privately; it stops working after one upload.
          </p>
        </MutationSuccessSummary>
      )}
      {flow.result !== null && <ShareLinkCard uploadPath={flow.result.uploadPath} />}
      <FormField id={hoursId} label="Valid for" {...(hoursError === undefined ? {} : { error: hoursError })}>
        {({ describedBy }) => (
          <span className="inline-suffix">
            <input
              id={hoursId}
              name="validForHours"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_GRANT_VALID_FOR_HOURS}
              value={hoursText}
              onChange={(event) => setHoursText(event.target.value)}
              disabled={pending}
              aria-invalid={hoursError !== undefined}
              aria-describedby={describedBy}
              required
            />
            <span>hours</span>
          </span>
        )}
      </FormField>
      <FormField
        id={bytesId}
        label="Maximum bytes"
        hint="Default: 10 GiB. Full-memory dumps can be large."
        {...(bytesError === undefined ? {} : { error: bytesError })}
      >
        {({ describedBy }) => (
          <input
            id={bytesId}
            name="maxBytes"
            type="text"
            inputMode="numeric"
            value={bytesText}
            onChange={(event) => setBytesText(event.target.value)}
            disabled={pending}
            aria-invalid={bytesError !== undefined}
            aria-describedby={describedBy}
            required
          />
        )}
      </FormField>
      <button type="submit" className="button" disabled={pending}>
        {pending ? "Generating…" : "Generate secure link"}
      </button>
    </form>
  );
}

export interface GrantRowProps {
  readonly grant: CaseGrantSummary;
  /** Called after a successful revoke so the page refetches the case. */
  readonly onRevoked: (grantId: string) => void;
}

/** One bounded grant row with a confirmed revoke for still-issued grants. */
export function GrantRow({ grant, onRevoked }: GrantRowProps): ReactNode {
  const client = useHttpClient();
  const flow = useMutationFlow<GrantRecord>();
  const [confirming, setConfirming] = useState(false);
  const presentation = grantStatePresentation(grant.state);

  async function handleConfirmRevoke(): Promise<void> {
    setConfirming(false);
    const revoked = await flow.run(async (signal) => {
      const response = await client.mutate({
        path: `/api/v1/grants/${encodeURIComponent(grant.grantId)}/revoke`,
        method: "POST",
        decoder: decodeRevokeGrantResponse,
        signal,
      });
      return response.grant;
    });
    if (revoked !== null) {
      onRevoked(revoked.grantId);
    }
  }

  return (
    <div className="record-row">
      <div className="record-main">
        <span className="record-title mono">{grant.grantId}</span>
        <div className="record-meta">
          <span>Expires {formatUtcTimestamp(grant.expiresAt)}</span>
          <span>{formatBytes(grant.maxBytes)} max</span>
        </div>
      </div>
      <div className="record-actions">
        <StatusPill tone={presentation.tone} label={presentation.label} />
        {grant.state === "issued" && (
          <button
            type="button"
            className="button button-danger button-small"
            onClick={() => setConfirming(true)}
            disabled={flow.pending}
          >
            {flow.pending ? "Revoking…" : "Revoke"}
          </button>
        )}
      </div>
      <MutationErrorSummary error={flow.error} fallback="The grant could not be revoked." />
      <MutationSuccessSummary active={flow.result !== null}>
        <p>Revoked grant {grant.grantId}.</p>
      </MutationSuccessSummary>
      <ConfirmationDialog
        open={confirming}
        title="Revoke upload grant"
        message="Revoking this grant immediately invalidates its one-time link. Any upload already in flight may still be consumed."
        confirmLabel="Revoke grant"
        cancelLabel="Cancel"
        tone="danger"
        pending={flow.pending}
        onConfirm={() => void handleConfirmRevoke()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
