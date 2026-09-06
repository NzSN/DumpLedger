/**
 * DumpsPage — bounded evidence overview (design sections 6 and 7.3).
 *
 * The backend exposes no global `/api/v1/dumps` list endpoint: dumps are
 * bounded by case (case detail) and by identity (dump detail). This index
 * therefore loads the bounded dashboard summary and presents the evidence
 * counters plus the recent cases to drill into, so an operator always has a
 * working entry point without the browser ever receiving the whole ledger.
 */

import { useCallback, type ReactNode } from "react";
import { Link } from "react-router";
import {
  decodeDashboardResponse,
  type CaseSummary,
  type DashboardResponse,
} from "@dump-ledger/http-contracts";
import { useHttpClient } from "../../shared/http-client-context";
import { useResource } from "../shared-use-resource";
import { FeaturePage, LoadingState, ResourceError } from "../feature-page";
import { Panel } from "../../shared/components/panel";
import { EmptyState } from "../../shared/components/empty-state";
import { StatusPill } from "../../shared/components/status-pill";
import { caseStatusPresentation } from "../../shared/status";
import { formatUtcDate } from "../../shared/format";

function DumpMetrics({ data }: { readonly data: DashboardResponse }): ReactNode {
  const { counts } = data;
  return (
    <section className="metric-grid metric-grid-three" aria-label="Evidence overview">
      <div className="metric">
        <span className="metric-label">Available dumps</span>
        <strong className="metric-value">{counts.availableDumps}</strong>
        <span className="metric-note">Validated for analysis</span>
      </div>
      <div className="metric">
        <span className="metric-label">Processing</span>
        <strong className="metric-value">{counts.processingDumps}</strong>
        <span className="metric-note">In durable lifecycle</span>
      </div>
      <div className="metric">
        <span className="metric-label">Active cases</span>
        <strong className="metric-value">{counts.activeCases}</strong>
        <span className="metric-note">Investigations in flight</span>
      </div>
    </section>
  );
}

function RecentCasesPanel({ data }: { readonly data: DashboardResponse }): ReactNode {
  const nameByCustomer = new Map(data.customers.map((customer) => [customer.customerId, customer.displayName]));
  if (data.recentCases.length === 0) {
    return (
      <Panel
        title="Browse by case"
        subtitle="Dumps are attached to the case that collected them."
        actions={
          <Link className="button button-secondary button-small" to="/cases">
            Search cases
          </Link>
        }
      >
        <EmptyState title="No recent cases" icon="◇">
          Open a case to review the dumps attached to it.
        </EmptyState>
      </Panel>
    );
  }
  return (
    <Panel
      title="Browse by case"
      subtitle="Open a case to see its dumps, then drill into one artifact."
      actions={<span className="panel-count">{data.recentCases.length}</span>}
    >
      <div className="case-list">
        {data.recentCases.map((item: CaseSummary) => {
          const presentation = caseStatusPresentation(item.status);
          return (
            <Link className="case-row" key={item.caseId} to={`/cases/${encodeURIComponent(item.caseId)}`}>
              <span>
                <span className="case-title">{item.title}</span>
                <span className="case-meta">
                  <span>{nameByCustomer.get(item.customerId) ?? "Unknown customer"}</span>
                  <span className="mono subtle-id">{item.caseId}</span>
                  <time dateTime={item.createdAt}>{formatUtcDate(item.createdAt)}</time>
                </span>
              </span>
              <StatusPill tone={presentation.tone} label={presentation.label} />
            </Link>
          );
        })}
      </div>
    </Panel>
  );
}

export function DumpsPage(): ReactNode {
  const client = useHttpClient();
  const { state, reload } = useResource<DashboardResponse>(
    useCallback(
      (signal) => client.query({ path: "/api/v1/dashboard", decoder: decodeDashboardResponse, signal }),
      [client],
    ),
  );

  return (
    <FeaturePage
      title="Dumps"
      subtitle="Evidence overview — every dump is reached through its case."
      actions={
        <Link className="button button-secondary" to="/operations">
          Operations
        </Link>
      }
    >
      {state.status === "loading" && <LoadingState label="Loading evidence overview…" />}
      {state.status === "error" && <ResourceError error={state.error} onRetry={reload} />}
      {state.status === "ready" && (
        <>
          <DumpMetrics data={state.data} />
          <div className="layout-grid">
            <RecentCasesPanel data={state.data} />
            <Panel title="Dump lifecycle" subtitle="How received bytes reach review.">
              <p className="side-copy">
                Uploads seal as <strong>available</strong> or <strong>rejected</strong> after
                validation. Retention is assigned per dump from the server clock, and downloads
                stream the immutable original directly to disk.
              </p>
            </Panel>
          </div>
        </>
      )}
    </FeaturePage>
  );
}
