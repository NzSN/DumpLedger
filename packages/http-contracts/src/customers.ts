/**
 * Customer and dashboard contracts (design section 7.3).
 *
 *   GET  /api/v1/dashboard            -> DashboardResponse
 *   GET  /api/v1/cases?query=&cursor= -> CaseSearchResponse (see cases.ts)
 *   POST /api/v1/customers            <- CreateCustomerRequest
 *   POST /api/v1/customers/:customerId/cases <- CreateCaseRequest (see cases.ts)
 *
 * Dashboard and search responses are bounded: the backend performs filtering
 * and pagination and never sends the whole ledger through a global snapshot.
 */

import {
  arrayOf,
  counterField,
  field,
  identifierField,
  object,
  text,
  type Decoder,
} from "./decode.js";
import {
  decodeCaseSummary,
  encodeCaseSummary,
  type CaseSummary,
} from "./cases.js";

export const MAX_DISPLAY_NAME_LENGTH = 200;
export const MAX_DASHBOARD_CUSTOMERS = 100;
export const MAX_DASHBOARD_RECENT_CASES = 20;

export interface CustomerSummary {
  readonly customerId: string;
  readonly displayName: string;
}

export const decodeCustomerSummary: Decoder<CustomerSummary> = (value, path) => {
  const decoded = object(
    {
      customerId: field(identifierField("customerId")),
      displayName: field(text({ max: MAX_DISPLAY_NAME_LENGTH, label: "displayName" })),
    },
    "customer summary",
  )(value, path);
  return { customerId: decoded.customerId, displayName: decoded.displayName };
};

export function encodeCustomerSummary(customer: CustomerSummary): Record<string, unknown> {
  return { customerId: customer.customerId, displayName: customer.displayName };
}

/** `POST /api/v1/customers` body. */
export interface CreateCustomerRequest {
  readonly displayName: string;
}

export const decodeCreateCustomerRequest: Decoder<CreateCustomerRequest> = (value, path) => {
  const decoded = object(
    { displayName: field(text({ max: MAX_DISPLAY_NAME_LENGTH, label: "displayName" })) },
    "create customer request",
  )(value, path);
  return { displayName: decoded.displayName };
};

export function encodeCreateCustomerRequest(request: CreateCustomerRequest): Record<string, unknown> {
  return { displayName: request.displayName };
}

/** Create-customer success is the resulting customer (server state). */
export interface CreateCustomerResponse {
  readonly customer: CustomerSummary;
}

export const decodeCreateCustomerResponse: Decoder<CreateCustomerResponse> = (value, path) => {
  const decoded = object(
    { customer: field(decodeCustomerSummary) },
    "create customer response",
  )(value, path);
  return { customer: decoded.customer };
};

export function encodeCreateCustomerResponse(response: CreateCustomerResponse): Record<string, unknown> {
  return { customer: encodeCustomerSummary(response.customer) };
}

/** Operator-visible ledger counters on the dashboard. */
export interface DashboardCounts {
  readonly customers: number;
  readonly activeCases: number;
  readonly availableDumps: number;
  readonly processingDumps: number;
}

const dashboardCountsShape = {
  customers: field(counterField("customers count")),
  activeCases: field(counterField("activeCases count")),
  availableDumps: field(counterField("availableDumps count")),
  processingDumps: field(counterField("processingDumps count")),
} as const;

export const decodeDashboardCounts: Decoder<DashboardCounts> = (value, path) => {
  const decoded = object(dashboardCountsShape, "dashboard counts")(value, path);
  return {
    customers: decoded.customers,
    activeCases: decoded.activeCases,
    availableDumps: decoded.availableDumps,
    processingDumps: decoded.processingDumps,
  };
};

export function encodeDashboardCounts(counts: DashboardCounts): Record<string, unknown> {
  return {
    customers: counts.customers,
    activeCases: counts.activeCases,
    availableDumps: counts.availableDumps,
    processingDumps: counts.processingDumps,
  };
}

/** `GET /api/v1/dashboard` success: bounded counts, customers, and cases. */
export interface DashboardResponse {
  readonly counts: DashboardCounts;
  readonly customers: readonly CustomerSummary[];
  readonly recentCases: readonly CaseSummary[];
}

export const decodeDashboardResponse: Decoder<DashboardResponse> = (value, path) => {
  const decoded = object(
    {
      counts: field(decodeDashboardCounts),
      customers: field(arrayOf(decodeCustomerSummary, { label: "customers", maxLength: MAX_DASHBOARD_CUSTOMERS })),
      recentCases: field(
        arrayOf(decodeCaseSummary, { label: "recentCases", maxLength: MAX_DASHBOARD_RECENT_CASES }),
      ),
    },
    "dashboard response",
  )(value, path);
  return {
    counts: decoded.counts,
    customers: decoded.customers,
    recentCases: decoded.recentCases,
  };
};

export function encodeDashboardResponse(response: DashboardResponse): Record<string, unknown> {
  return {
    counts: encodeDashboardCounts(response.counts),
    customers: response.customers.map(encodeCustomerSummary),
    recentCases: response.recentCases.map(encodeCaseSummary),
  };
}
