/**
 * OperationsPage — runtime health and bounded job state (design section 7.7),
 * migrated from the legacy HTML operations oracle.
 *
 * The page polls the authenticated `GET /api/v1/operations` summary through
 * the shared HTTP client. Polling pauses while the document is hidden, never
 * overlaps an outstanding request, and a manual Refresh is always available.
 * Integrity warnings from the server are surfaced verbatim (they are
 * operator-safe, bounded text). The response never exposes customer, grant,
 * or dump contents.
 */

import type { ReactNode } from "react";
import { type OperationsResponse, type RuntimeJobSummary } from "@dump-ledger/http-contracts";
import { FeaturePage, LoadingState, ResourceError } from "../feature-page";
import { Panel } from "../../shared/components/panel";
import { StatusPill } from "../../shared/components/status-pill";
import { Notice } from "../../shared/components/notice";
import { EmptyState } from "../../shared/components/empty-state";
import { integrityStatusPresentation } from "../../shared/status";
import { useOperationsPolling } from "./use-operations-polling";
import { TransferSection } from "../transfer/TransferSection";

export const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface OperationsPageProps {
  /**
   * Poll cadence. Bounded to sane values; pass 0 to disable polling (manual
   * refresh only). Tests inject a short interval.
   */
  readonly pollIntervalMs?: number;
}

function JobRows({ jobs }: { readonly jobs: readonly RuntimeJobSummary[] }): ReactNode {
  if (jobs.length === 0) {
    return (
      <EmptyState title="No periodic jobs" icon="◇">
        Runtime jobs are optional in this deployment.
      </EmptyState>
    );
  }
  return (
    <div className="record-list">
      {jobs.map((job) => (
        <div className="record-row" key={job.name}>
          <div className="record-main">
            <span className="record-title">{job.name}</span>
            <div className="record-meta">
              <span>{job.runs} runs</span>
              <span>{job.failures} failures</span>
            </div>
          </div>
          <StatusPill tone={job.running ? "good" : "muted"} label={job.running ? "Running" : "Stopped"} />
        </div>
      ))}
    </div>
  );
}

function IntegrityPanel({ data }: { readonly data: OperationsResponse }): ReactNode {
  const presentation = integrityStatusPresentation(data.integrity.status);
  if (data.integrity.status === "ok") {
    return (
      <div className="health-ok">
        <span aria-hidden="true">✓</span>
        <div>
          <strong>All checks passed</strong>
          <p>No SQLite integrity errors are currently reported.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="integrity-degraded">
      <Notice tone="warn" role="alert">
        <strong>{data.integrity.errorCount} integrity {data.integrity.errorCount === 1 ? "error" : "errors"} require operator review.</strong>
      </Notice>
      <ul className="integrity-errors">
        {data.integrity.errors.map((message, index) => (
          <li key={`${index}-${message}`} className="integrity-error">
            {message}
          </li>
        ))}
      </ul>
      <StatusPill tone={presentation.tone} label={presentation.label} />
    </div>
  );
}

function ReadyView({ data }: { readonly data: OperationsResponse }): ReactNode {
  const integrity = integrityStatusPresentation(data.integrity.status);
  return (
    <>
      <section className="metric-grid" aria-label="Runtime health">
        <div className="metric">
          <span className="metric-label">Integrity</span>
          <strong className="metric-value metric-word">{integrity.label}</strong>
          <span className="metric-note">{data.integrity.errorCount} reported errors</span>
        </div>
        <div className="metric">
          <span className="metric-label">Uploads</span>
          <strong className="metric-value">
            {data.uploads.active}/{data.uploads.capacity}
          </strong>
          <span className="metric-note">Active / admitted</span>
        </div>
        <div className="metric">
          <span className="metric-label">Processing queue</span>
          <strong className="metric-value">{data.postProcessing.pending}</strong>
          <span className="metric-note">{data.postProcessing.exhausted} exhausted</span>
        </div>
        <div className="metric">
          <span className="metric-label">Retries</span>
          <strong className="metric-value">{data.postProcessing.totalRetries}</strong>
          <span className="metric-note">Post-upload attempts</span>
        </div>
      </section>
      <div className="layout-grid">
        <Panel title="Runtime jobs" subtitle="Bounded tasks never overlap themselves.">
          <JobRows jobs={data.runtimeJobs} />
        </Panel>
        <Panel title="Integrity" subtitle="SQLite consistency status.">
          <IntegrityPanel data={data} />
        </Panel>
      </div>
      <TransferSection />
    </>
  );
}

export function OperationsPage({ pollIntervalMs = DEFAULT_POLL_INTERVAL_MS }: OperationsPageProps): ReactNode {
  const { phase, busy, refresh } = useOperationsPolling(pollIntervalMs);
  return (
    <FeaturePage
      title="Operations"
      subtitle="Runtime health and bounded job state."
      actions={
        <button
          type="button"
          className="button button-secondary button-small"
          onClick={refresh}
          disabled={busy}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      }
    >
      {phase.status === "loading" && <LoadingState label="Loading operations…" />}
      {phase.status === "error" && <ResourceError error={phase.error} onRetry={refresh} />}
      {phase.status === "ready" && <ReadyView data={phase.data} />}
    </FeaturePage>
  );
}
