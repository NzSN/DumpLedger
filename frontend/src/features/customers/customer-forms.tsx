/**
 * Customer and per-customer case creation forms (design section 7.3).
 *
 * Both mutations POST through the shared HTTP client with runtime-decoded
 * responses; a created entity is surfaced in a focus-moved success summary and
 * reported to the parent (`onCreated`) so the page can refetch authoritative
 * state. Failures show the stable server message and move focus to it.
 */

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import {
  decodeCreateCaseResponse,
  decodeCreateCustomerResponse,
  encodeCreateCaseRequest,
  encodeCreateCustomerRequest,
  type CaseSummary,
  type CustomerSummary,
} from "@dump-ledger/http-contracts";
import { useHttpClient } from "../../shared/http-client-context";
import { FormField } from "../../shared/components/form-field";
import {
  MutationErrorSummary,
  MutationSuccessSummary,
  useMutationFlow,
} from "../shared-use-resource";

export interface CreateCustomerFormProps {
  /** Called after the server confirms the customer so the page can refetch. */
  readonly onCreated: (customer: CustomerSummary) => void;
}

export function CreateCustomerForm({ onCreated }: CreateCustomerFormProps): ReactNode {
  const client = useHttpClient();
  const flow = useMutationFlow<CustomerSummary>();
  const nameId = useId();
  const [displayName, setDisplayName] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const name = displayName.trim();
    if (name.length === 0) {
      setFieldError("Enter a display name.");
      return;
    }
    setFieldError(undefined);
    const created = await flow.run(async (signal) => {
      const response = await client.mutate({
        path: "/api/v1/customers",
        method: "POST",
        body: encodeCreateCustomerRequest({ displayName: name }),
        decoder: decodeCreateCustomerResponse,
        signal,
      });
      return response.customer;
    });
    if (created !== null) {
      setDisplayName("");
      onCreated(created);
    }
  }

  /* Generates a customer with a random `customer_<uuid>` display name in one
     click; the server still assigns the real (UUID-shaped) identifier. */
  async function handleGenerate(): Promise<void> {
    setFieldError(undefined);
    const created = await flow.run(async (signal) => {
      const response = await client.mutate({
        path: "/api/v1/customers",
        method: "POST",
        body: encodeCreateCustomerRequest({ displayName: `customer_${crypto.randomUUID()}` }),
        decoder: decodeCreateCustomerResponse,
        signal,
      });
      return response.customer;
    });
    if (created !== null) {
      onCreated(created);
    }
  }

  return (
    <form className="form-stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
      <MutationErrorSummary error={flow.error} fallback="The customer could not be added." />
      <MutationSuccessSummary active={flow.result !== null}>
        <p>
          Added customer <strong>{flow.result?.displayName ?? ""}</strong>.
        </p>
      </MutationSuccessSummary>
      <FormField
        id={nameId}
        label="Display name"
        {...(fieldError === undefined ? {} : { error: fieldError })}
      >
        {({ describedBy }) => (
          <input
            id={nameId}
            name="displayName"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Acme Support"
            maxLength={200}
            disabled={flow.pending}
            aria-invalid={fieldError !== undefined}
            aria-describedby={describedBy}
            required
          />
        )}
      </FormField>
      <button type="submit" className="button" disabled={flow.pending}>
        {flow.pending ? "Adding…" : "Add customer"}
      </button>
      <button
        type="button"
        className="button button-secondary"
        onClick={() => void handleGenerate()}
        disabled={flow.pending}
      >
        {flow.pending ? "Generating…" : "Generate customer"}
      </button>
    </form>
  );
}

export interface CreateCaseFormProps {
  readonly customerId: string;
  readonly customerName: string;
  /** Called after the server confirms the case so the page can refetch. */
  readonly onCreated: (created: CaseSummary) => void;
}

/** Inline "New case" form shown under one customer (legacy `.inline-create`). */
export function CreateCaseForm({ customerId, customerName, onCreated }: CreateCaseFormProps): ReactNode {
  const client = useHttpClient();
  const flow = useMutationFlow<CaseSummary>();
  const titleId = useId();
  const [title, setTitle] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    const created = await flow.run(async (signal) => {
      const response = await client.mutate({
        path: `/api/v1/customers/${encodeURIComponent(customerId)}/cases`,
        method: "POST",
        body: encodeCreateCaseRequest({ title: trimmed }),
        decoder: decodeCreateCaseResponse,
        signal,
      });
      return response;
    });
    if (created !== null) {
      setTitle("");
      onCreated(created);
    }
  }

  return (
    <form className="inline-create" onSubmit={(event) => void handleSubmit(event)} noValidate>
      <MutationErrorSummary error={flow.error} fallback="The case could not be created." />
      <MutationSuccessSummary active={flow.result !== null}>
        <p>
          Created case <strong>{flow.result?.title ?? ""}</strong> under {customerName}.{" "}
          {flow.result !== null && (
            <Link to={`/cases/${encodeURIComponent(flow.result.caseId)}`}>Open case</Link>
          )}
        </p>
      </MutationSuccessSummary>
      <FormField id={titleId} label="New case">
        {({ describedBy }) => (
          <span className="inline-field">
            <input
              id={titleId}
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Renderer crash on startup"
              maxLength={300}
              disabled={flow.pending}
              aria-describedby={describedBy}
              required
            />
            <button type="submit" className="button button-secondary button-small" disabled={flow.pending}>
              {flow.pending ? "Creating…" : "Create"}
            </button>
          </span>
        )}
      </FormField>
    </form>
  );
}
