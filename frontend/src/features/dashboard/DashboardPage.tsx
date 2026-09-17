/**
 * DashboardPage — bounded operator summary (design section 7.3) migrated from
 * the legacy "Cases" home oracle.
 *
 * `GET /api/v1/dashboard` returns counts plus a bounded customer summary and
 * recent-case list. Customer and per-customer case creation POST through the
 * shared client, and a successful mutation refetches the authoritative
 * dashboard (the forms live under stable keys, so their focus-moved success
 * summaries survive the refetch). No optimistic counts are shown.
 */

import { useCallback, type ReactNode } from "react";
import { Link } from "react-router";
import {
  decodeDashboardResponse,
  type CaseSummary,
  type CustomerSummary,
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

function MetricsGrid({ data }: { readonly data: DashboardResponse }): ReactNode {
  const counts = data.counts;
  return (
    <section className="metric-grid" aria-label="Overview">
      <div className="metric">
        <span className="metric-label">Active cases</span>
        <strong className="metric-value">{counts.activeCases}</strong>
        <span className="metric-note">Investigations in flight</span>
      </div>
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
        <span className="metric-label">Customers</span>
        <strong className="metric-value">{counts.customers}</strong>
        <span className="metric-note">Tracked identities</span>
      </div>
    </section>
  );
}

function RecentCasesPanel({ data }: { readonly data: DashboardResponse }): ReactNode {
  const nameByCustomer = new Map(data.customers.map((customer) => [customer.customerId, customer.displayName]));
  if (data.recentCases.length === 0) {
    return (
      <Panel
        title="Recent cases"
        subtitle="Open an investigation to issue links and review dumps."
        actions={
          <Link className="button button-secondary button-small" to="/cases">
            Search cases
          </Link>
        }
      >
        <EmptyState title="No cases yet" icon="◇">
          Create a customer, then open the first investigation.
        </EmptyState>
      </Panel>
    );
  }
  return (
    <Panel
      title="Recent cases"
      subtitle="Open an investigation to issue links and review dumps."
      actions={<span className="panel-count">{data.recentCases.length}</span>}
    >
      <div className="case-list">
        {data.recentCases.map((item) => {
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

export function DashboardPage(): ReactNode {
  const client = useHttpClient();
  const { state, reload } = useResource<DashboardResponse>(
    useCallback(
      (signal) => client.query({ path: "/api/v1/dashboard", decoder: decodeDashboardResponse, signal }),
      [client],
    ),
  );

  return (
    <FeaturePage
      title="Dashboard"
      eyebrow="Evidence intake"
      subtitle="Overview of customers, recent cases, and bounded ledger state."
    >
      {state.status === "loading" && <LoadingState label="Loading overview…" />}
      {state.status === "error" && <ResourceError error={state.error} onRetry={reload} />}
      {state.status === "ready" && (
        <>
          <MetricsGrid data={state.data} />
          <RecentCasesPanel data={state.data} />
        </>
      )}
    </FeaturePage>
  );
}
