/**
 * CustomerDetailPage — the individual customer panel: the customer record,
 * their bounded case list, and case intake for this customer.
 * `GET /api/v1/customers/:customerId` (session, bounded; 404 -> not-found panel).
 */

import { useCallback, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
  decodeCustomerDetailResponse,
  type CaseSummary,
  type CustomerDetailResponse,
} from "@dump-ledger/http-contracts";
import { useHttpClient } from "../../shared/http-client-context";
import { useResource } from "../shared-use-resource";
import { FeaturePage, LoadingState, ResourceError } from "../feature-page";
import { Panel } from "../../shared/components/panel";
import { EmptyState } from "../../shared/components/empty-state";
import { StatusPill } from "../../shared/components/status-pill";
import { caseStatusPresentation } from "../../shared/status";
import { formatUtcDate, formatUtcTimestamp } from "../../shared/format";
import { HttpRequestError } from "../../shared/http-client";
import { CreateCaseForm } from "./customer-forms";

function detailPath(customerId: string): string {
  return `/api/v1/customers/${encodeURIComponent(customerId)}`;
}

export function CustomerDetailPage(): ReactNode {
  const client = useHttpClient();
  const params = useParams();
  const customerId = params.customerId ?? "";

  const { state, reload } = useResource<CustomerDetailResponse>(
    useCallback(
      (signal) => client.query({ path: detailPath(customerId), decoder: decodeCustomerDetailResponse, signal }),
      [client, customerId],
    ),
  );

  const handleCaseCreated = useCallback((_created: CaseSummary) => reload(), [reload]);

  if (customerId === "") {
    return (
      <FeaturePage title="Customer" subtitle="Individual customer panel">
        <EmptyState title="No customer selected" icon="◇">
          Open a customer from the directory to see their cases.
        </EmptyState>
      </FeaturePage>
    );
  }

  return (
    <FeaturePage
      title={state.status === "ready" ? state.data.customer.displayName : "Customer"}
      subtitle={
        state.status === "ready"
          ? `Created ${formatUtcTimestamp(state.data.customer.createdAt)}`
          : "Individual customer panel"
      }
    >
      {state.status === "loading" && <LoadingState label="Loading customer…" />}
      {state.status === "error" && state.error instanceof HttpRequestError && state.error.status === 404 ? (
        <EmptyState title="Customer not found" icon="◇">
          This customer does not exist. <Link to="/customers">Back to the customer directory</Link>.
        </EmptyState>
      ) : state.status === "error" ? (
        <ResourceError error={state.error} onRetry={reload} />
      ) : null}
      {state.status === "ready" && (
        <div className="stack">
          <Panel title="Customer" subtitle="Identity and creation metadata" className="panel-accent">
            <div className="record-main">
              <span className="record-title">{state.data.customer.displayName}</span>
              <div className="record-meta">
                <span className="mono subtle-id">{state.data.customer.customerId}</span>
                <span>
                  Created <time dateTime={state.data.customer.createdAt}>{formatUtcDate(state.data.customer.createdAt)}</time>
                </span>
              </div>
            </div>
          </Panel>

          <Panel title="New case" subtitle="Create a case directly under this customer.">
            <CreateCaseForm
              customerId={state.data.customer.customerId}
              customerName={state.data.customer.displayName}
              onCreated={handleCaseCreated}
            />
          </Panel>

          <Panel
            title={`Cases (${state.data.cases.length})`}
            subtitle="Every intake case owned by this customer; open one for detail."
          >
            {state.data.cases.length === 0 ? (
              <EmptyState title="No cases yet" icon="◇">
                Create the first case for this customer above.
              </EmptyState>
            ) : (
              <div className="case-list">
                {state.data.cases.map((item) => {
                  const presentation = caseStatusPresentation(item.status);
                  return (
                    <Link className="case-row" key={item.caseId} to={`/cases/${encodeURIComponent(item.caseId)}`}>
                      <span>
                        <span className="case-title">{item.title}</span>
                        <span className="case-meta">
                          <span className="mono subtle-id">{item.caseId}</span>
                          <time dateTime={item.createdAt}>{formatUtcDate(item.createdAt)}</time>
                        </span>
                      </span>
                      <StatusPill tone={presentation.tone} label={presentation.label} />
                    </Link>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>
      )}
    </FeaturePage>
  );
}
