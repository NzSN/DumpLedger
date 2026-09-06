/**
 * DumpDetailPage — evidence facts, lifecycle, coverage, retention, and
 * activity for one dump (design section 7.7), migrated from the legacy HTML
 * dump oracle.
 *
 *   - The screen heading stays "Dump detail" with the dump identifier always
 *     visible so deep links and async states keep a stable landmark.
 *   - Retention is a bounded whole-days input (1..MAX_RETENTION_DAYS) shown
 *     only for dumps the backend accepts (`available`/`rejected` phases).
 *     The canonical purge deadline comes from the server's own clock; the
 *     browser clock and timezone are never authoritative.
 *   - Download is an ordinary same-origin navigation to the raw content
 *     endpoint; dump bytes are never buffered through the React app.
 */

import { useCallback, useId, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
  decodeDumpDetailResponse,
  decodeRetentionResponse,
  encodeRetentionRequest,
  MAX_RETENTION_DAYS,
  type DumpDetailResponse,
  type RetentionResponse,
} from "@dump-ledger/http-contracts";
import { useHttpClient } from "../../shared/http-client-context";
import {
  MutationErrorSummary,
  MutationSuccessSummary,
  useMutationFlow,
  useResource,
} from "../shared-use-resource";
import { FeaturePage, LoadingState, ResourceError } from "../feature-page";
import { Panel } from "../../shared/components/panel";
import { StatusPill } from "../../shared/components/status-pill";
import { Notice } from "../../shared/components/notice";
import { FormField } from "../../shared/components/form-field";
import {
  coverageKindLabel,
  dumpPhasePresentation,
  validationStatePresentation,
} from "../../shared/status";
import { formatUtcTimestamp, formatBytes } from "../../shared/format";
import { ActivityTimeline } from "../cases/activity-timeline";

export const DEFAULT_RETENTION_DAYS = 30;

export function RetentionForm({
  dumpId,
  onChanged,
}: {
  readonly dumpId: string;
  /** Parent refetches authoritative detail after a successful update. */
  readonly onChanged: () => void;
}): ReactNode {
  const client = useHttpClient();
  const flow = useMutationFlow<RetentionResponse>();
  const daysId = useId();
  const [daysText, setDaysText] = useState(String(DEFAULT_RETENTION_DAYS));
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!/^[0-9]+$/.test(daysText)) {
      setFieldError(`Enter whole days from 1 to ${MAX_RETENTION_DAYS}.`);
      return;
    }
    const days = Number(daysText);
    if (!Number.isSafeInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) {
      setFieldError(`Enter whole days from 1 to ${MAX_RETENTION_DAYS}.`);
      return;
    }
    setFieldError(undefined);
    const result = await flow.run(async (signal) => {
      const response = await client.mutate({
        path: `/api/v1/dumps/${encodeURIComponent(dumpId)}/retention`,
        method: "PUT",
        body: encodeRetentionRequest({ days }),
        decoder: decodeRetentionResponse,
        signal,
      });
      return response;
    });
    if (result !== null) {
      onChanged();
    }
  }

  return (
    <form className="form-stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
      <MutationErrorSummary error={flow.error} fallback="Retention could not be updated." />
      {flow.result !== null && (
        <MutationSuccessSummary active={true}>
          <p>
            Retention updated — the server-scheduled purge deadline is{" "}
            <strong>{formatUtcTimestamp(flow.result.dump.purgeAt)}</strong>.
          </p>
        </MutationSuccessSummary>
      )}
      <FormField
        id={daysId}
        label="Retain for"
        hint={`The purge deadline is calculated from the server clock (1–${MAX_RETENTION_DAYS} days).`}
        {...(fieldError === undefined ? {} : { error: fieldError })}
      >
        {({ describedBy }) => (
          <span className="inline-suffix">
            <input
              id={daysId}
              name="days"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_RETENTION_DAYS}
              value={daysText}
              onChange={(event) => setDaysText(event.target.value)}
              disabled={flow.pending}
              aria-invalid={fieldError !== undefined}
              aria-describedby={describedBy}
              required
            />
            <span>days</span>
          </span>
        )}
      </FormField>
      <button type="submit" className="button button-secondary" disabled={flow.pending}>
        {flow.pending ? "Updating…" : "Update retention"}
      </button>
    </form>
  );
}

function FactGrid({ detail }: { readonly detail: DumpDetailResponse }): ReactNode {
  const phase = dumpPhasePresentation(detail.phase);
  const validation = validationStatePresentation(detail.validation);
  return (
    <dl className="detail-grid">
      <div className="detail">
        <dt>Lifecycle phase</dt>
        <dd>
          <StatusPill tone={phase.tone} label={phase.label} />
        </dd>
      </div>
      <div className="detail">
        <dt>Validation</dt>
        <dd>
          <StatusPill tone={validation.tone} label={validation.label} />
        </dd>
      </div>
      <div className="detail">
        <dt>Memory coverage</dt>
        <dd>{coverageKindLabel(detail.coverage)}</dd>
      </div>
      <div className="detail">
        <dt>Stored size</dt>
        <dd>{formatBytes(detail.byteSize)}</dd>
      </div>
      <div className="detail">
        <dt>Original name</dt>
        <dd>{detail.originalName}</dd>
      </div>
      <div className="detail">
        <dt>Received at</dt>
        <dd>
          <time dateTime={detail.receivedAt}>{formatUtcTimestamp(detail.receivedAt)}</time>
        </dd>
      </div>
      <div className="detail">
        <dt>Purge at</dt>
        <dd>{detail.purgeAt === null ? "Not scheduled" : formatUtcTimestamp(detail.purgeAt)}</dd>
      </div>
      <div className="detail">
        <dt>SHA-256</dt>
        <dd>{detail.sha256 === null ? "Not recorded" : <code className="mono">{detail.sha256}</code>}</dd>
      </div>
      {detail.inspectionError !== null && (
        <div className="detail">
          <dt>Inspection error</dt>
          <dd>{detail.inspectionError}</dd>
        </div>
      )}
    </dl>
  );
}

export function DumpDetailPage(): ReactNode {
  const params = useParams<{ dumpId: string }>();
  const dumpId = params.dumpId ?? "(missing)";
  const client = useHttpClient();
  const { state, reload } = useResource<DumpDetailResponse>(
    useCallback(
      (signal) =>
        client.query({
          path: `/api/v1/dumps/${encodeURIComponent(dumpId)}`,
          decoder: decodeDumpDetailResponse,
          signal,
        }),
      [client, dumpId],
    ),
    [dumpId],
  );

  return (
    <FeaturePage
      title="Dump detail"
      eyebrow="Crash evidence"
      subtitle={`Dump ${dumpId}`}
      actions={
        state.status === "ready" && state.data.downloadable ? (
          <a
            className="button"
            href={`/api/v1/dumps/${encodeURIComponent(dumpId)}/content`}
            download={`${dumpId}.dmp`}
          >
            Download original dump
          </a>
        ) : null
      }
    >
      {state.status === "loading" && <LoadingState label="Loading dump…" />}
      {state.status === "error" && <ResourceError error={state.error} onRetry={reload} />}
      {state.status === "ready" && <DumpDetailReady detail={state.data} onReload={reload} />}
    </FeaturePage>
  );
}

function DumpDetailReady({
  detail,
  onReload,
}: {
  readonly detail: DumpDetailResponse;
  readonly onReload: () => void;
}): ReactNode {
  const retentionAllowed = detail.phase === "available" || detail.phase === "rejected";
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/">Cases</Link>
        <span>/</span>
        <Link to={`/cases/${encodeURIComponent(detail.case.caseId)}`}>{detail.case.title}</Link>
        <span>/</span>
        <span>Dump</span>
      </nav>
      <div className="layout-grid">
        <div className="stack">
          <Panel title="Artifact details" subtitle="Facts recorded from the immutable original.">
            <FactGrid detail={detail} />
          </Panel>
          <Panel title="Lifecycle activity" subtitle="Audited events for this dump.">
            <ActivityTimeline items={detail.activity} />
          </Panel>
        </div>
        <aside className="stack">
          <Panel title="Retention" subtitle="Control when active bytes are purged." className="panel-accent">
            {retentionAllowed ? (
              <RetentionForm dumpId={detail.dumpId} onChanged={onReload} />
            ) : (
              <Notice tone="info">
                Retention can be assigned after validation reaches available or rejected.
              </Notice>
            )}
          </Panel>
          <Panel>
            <div className="panel-body">
              <p className="eyebrow">Integrity note</p>
              <p className="side-copy">
                A displayed hash identifies the received original; it does not authenticate who created the
                process memory.
              </p>
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
