/**
 * CustomersPage — customer directory and case creation (design section 7.3).
 *
 * The backend exposes no separate customer-list endpoint; the bounded customer
 * summary travels with `GET /api/v1/dashboard`, so this page loads that
 * representation and renders only the directory half. Creation flows are
 * shared with the dashboard so the domain behavior stays in one place.
 */

import { useCallback, type ReactNode } from "react";
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
import { CreateCustomerForm } from "./customer-forms";
import { CustomerCard } from "../dashboard/DashboardPage";

function Directory({
  data,
  onCaseCreated,
  onCustomerCreated,
}: {
  readonly data: DashboardResponse;
  readonly onCaseCreated: (c: CaseSummary) => void;
  readonly onCustomerCreated: (c: CustomerSummary) => void;
}): ReactNode {
  return (
    <>
      <Panel title="Add customer" subtitle="Names stay in metadata, never vault paths." className="panel-accent">
        <CreateCustomerForm onCreated={onCustomerCreated} />
      </Panel>
      <Panel
        title={`Customers (${data.counts.customers})`}
        subtitle="Create a case directly under its owner."
      >
        {data.customers.length === 0 ? (
          <EmptyState title="No customers yet" icon="◇">
            Add the organization or person supplying crash evidence.
          </EmptyState>
        ) : (
          <div className="customer-list">
            {data.customers.map((customer) => (
              <CustomerCard key={customer.customerId} customer={customer} onCaseCreated={onCaseCreated} />
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}

export function CustomersPage(): ReactNode {
  const client = useHttpClient();
  const { state, reload } = useResource<DashboardResponse>(
    useCallback(
      (signal) => client.query({ path: "/api/v1/dashboard", decoder: decodeDashboardResponse, signal }),
      [client],
    ),
  );

  const handleCustomerCreated = useCallback(
    (_created: CustomerSummary) => {
      reload();
    },
    [reload],
  );

  const handleCaseCreated = useCallback(
    (_created: CaseSummary) => {
      reload();
    },
    [reload],
  );

  return (
    <FeaturePage
      title="Customers"
      subtitle="Customer directory, creation, and per-customer case intake."
    >
      {state.status === "loading" && <LoadingState label="Loading customers…" />}
      {state.status === "error" && <ResourceError error={state.error} onRetry={reload} />}
      {state.status === "ready" && (
        <div className="stack">
          <Directory data={state.data} onCaseCreated={handleCaseCreated} onCustomerCreated={handleCustomerCreated} />
        </div>
      )}
    </FeaturePage>
  );
}
