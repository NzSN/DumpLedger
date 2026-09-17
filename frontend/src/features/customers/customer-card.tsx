/**
 * CustomerCard — one individual customer widget: the display name links to the
 * customer's individual panel, and the per-customer case intake form rides
 * below. Used by the customer directory (the only place customer widgets live).
 */

import type { ReactNode } from "react";
import { Link } from "react-router";
import type { CaseSummary, CustomerSummary } from "@dump-ledger/http-contracts";
import { CreateCaseForm } from "./customer-forms";

export interface CustomerCardProps {
  readonly customer: CustomerSummary;
  readonly onCaseCreated: (created: CaseSummary) => void;
}

export function CustomerCard({ customer, onCaseCreated }: CustomerCardProps): ReactNode {
  return (
    <section className="customer-card">
      <div>
        {/* Each customer widget switches to its individual panel. */}
        <Link className="customer-name" to={`/customers/${encodeURIComponent(customer.customerId)}`}>
          {customer.displayName}
        </Link>
        <div className="mono subtle-id">{customer.customerId}</div>
      </div>
      <CreateCaseForm
        customerId={customer.customerId}
        customerName={customer.displayName}
        onCreated={onCaseCreated}
      />
    </section>
  );
}
