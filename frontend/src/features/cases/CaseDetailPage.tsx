/**
 * CaseDetailPage — case status, server-driven transitions, grants, dumps, and
 * activity (design sections 6 and 7.4), migrated from the legacy HTML case
 * oracle.
 *
 *   - The screen heading stays "Case detail" with the case identifier always
 *     visible, so deep links, session tests, and loading/error states keep a
 *     stable landmark; the case title renders inside the ready content.
 *   - The five lifecycle transitions are driven by the server-returned
 *     `allowedActions` list: every action is visible, allowed ones are
 *     enabled and the rest disabled. Allowed actions are guidance only — the
 *     engine re-checks each transition and refuses illegal actions with the
 *     stable `invalid_transition` error.
 *   - Destructive transitions (CloseCase atomically revokes issued grants)
 *     ask for confirmation first. No optimistic lifecycle state is rendered:
 *     the only optimistic feedback is disabling the in-flight controls. Every
 *     successful mutation refetches the authoritative case detail.
 *   - The CloseCase result summary reports the number and identifiers of the
 *     grants the server revoked.
 *   - The manifest is an ordinary same-origin navigation/download to the raw
 *     JSON endpoint; bytes are never buffered through the React app.
 */

import { useCallback, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
  decodeCaseDetailResponse,
  decodeTransitionResponse,
  encodeTransitionRequest,
  type CaseAction,
  type CaseDetailResponse,
  type TransitionResponse,
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
import { EmptyState } from "../../shared/components/empty-state";
import { StatusPill } from "../../shared/components/status-pill";
import { ConfirmationDialog } from "../../shared/components/confirmation-dialog";
import { caseActionLabel, caseStatusPresentation, dumpPhasePresentation } from "../../shared/status";
import { formatUtcDate, formatBytes } from "../../shared/format";
import { ActivityTimeline } from "./activity-timeline";
import { CreateGrantForm, GrantRow } from "../grants/grant-components";

/** Canonical presentation order for the five lifecycle actions. */
export const TRANSITION_ORDER: readonly CaseAction[] = [
  "StartInvestigation",
  "WaitForCustomer",
  "ResumeInvestigation",
  "ResolveCase",
  "CloseCase",
];

export interface ActionFlowPanelProps {
  readonly caseId: string;
  readonly allowedActions: readonly CaseAction[];
  /** Number of currently issued grants, shown when confirming CloseCase. */
  readonly issuedGrantCount: number;
  /** Parent refetches authoritative detail after a successful transition. */
  readonly onChanged: () => void;
}

/**
 * The five transition controls. Allowed actions are enabled; everything else
 * is disabled. CloseCase (which revokes every issued grant) asks for a
 * confirmation before it runs.
 */
export function ActionFlowPanel({
  caseId,
  allowedActions,
  issuedGrantCount,
  onChanged,
}: ActionFlowPanelProps): ReactNode {
  const client = useHttpClient();
  const flow = useMutationFlow<TransitionResponse>();
  const [confirming, setConfirming] = useState<CaseAction | null>(null);
  const [applying, setApplying] = useState<CaseAction | null>(null);
  const allowedSet = new Set<string>(allowedActions);

  async function apply(action: CaseAction): Promise<void> {
    setApplying(action);
    const result = await flow.run(async (signal) => {
      const response = await client.mutate({
        path: `/api/v1/cases/${encodeURIComponent(caseId)}/transitions`,
        method: "POST",
        body: encodeTransitionRequest({ action }),
        decoder: decodeTransitionResponse,
        signal,
      });
      return response;
    });
    setApplying(null);
    setConfirming(null);
    if (result !== null) {
      onChanged();
    }
  }

  function requestTransition(action: CaseAction): void {
    if (action === "CloseCase") {
      setConfirming(action);
      return;
    }
    void apply(action);
  }

  return (
    <Panel title="Case workflow" subtitle="Allowed actions come from the server; the engine re-checks each one.">
      <ul className="action-list">
        {TRANSITION_ORDER.map((action) => {
          const allowed = allowedSet.has(action);
          const pending = flow.pending;
          return (
            <li className="action-row" key={action}>
              <div className="action-main">
                <span className="action-name">{caseActionLabel(action)}</span>
                {!allowed && <span className="action-note">Not available in this case state.</span>}
              </div>
              <button
                type="button"
                className="button button-secondary button-small"
                disabled={!allowed || pending}
                onClick={() => requestTransition(action)}
              >
                {pending && applying === action ? "Applying…" : caseActionLabel(action)}
              </button>
            </li>
          );
        })}
      </ul>
      <MutationErrorSummary error={flow.error} fallback="The transition could not be applied." />
      {flow.result !== null && (
        <MutationSuccessSummary active={true}>
          {flow.result.action === "CloseCase" && flow.result.revokedGrants !== undefined ? (
            <p>
              Closed the case. The server revoked <strong>{flow.result.revokedGrants.count}</strong> upload{" "}
              {flow.result.revokedGrants.count === 1 ? "grant" : "grants"}:
              <span className="mono"> {flow.result.revokedGrants.grantIds.join(", ")}</span>.
            </p>
          ) : (
            <p>
              Applied {caseActionLabel(flow.result.action)} — the case is now{" "}
              <strong>{caseStatusPresentation(flow.result.status).label}</strong>.
            </p>
          )}
        </MutationSuccessSummary>
      )}
      <ConfirmationDialog
        open={confirming === "CloseCase"}
        title="Close case?"
        message={`Closing this case immediately revokes every issued upload grant${
          issuedGrantCount === 0
            ? " (none are currently issued)"
            : ` (${issuedGrantCount} currently issued)`
        }. Existing dumps stay downloadable according to their own state, and the case can be reopened later.`}
        confirmLabel="Close case"
        cancelLabel="Cancel"
        tone="danger"
        pending={flow.pending}
        onConfirm={() => void apply("CloseCase")}
        onCancel={() => setConfirming(null)}
      />
    </Panel>
  );
}

function DumpRows({ dumps }: { readonly dumps: CaseDetailResponse["dumps"] }): ReactNode {
  if (dumps.length === 0) {
    return (
      <EmptyState title="No dumps attached" icon="◇">
        Create a one-time upload link to collect the first minidump.
      </EmptyState>
    );
  }
  return (
    <div className="record-list">
      {dumps.map((dump) => {
        const phase = dumpPhasePresentation(dump.phase);
        return (
          <Link className="record-row" key={dump.dumpId} to={`/dumps/${encodeURIComponent(dump.dumpId)}`}>
            <div className="record-main">
              <span className="record-title mono">{dump.dumpId}</span>
              <div className="record-meta">
                <span>{dump.originalName}</span>
                <span>{formatBytes(dump.byteSize)}</span>
                <time dateTime={dump.receivedAt}>{formatUtcDate(dump.receivedAt)}</time>
              </div>
            </div>
            <StatusPill tone={phase.tone} label={phase.label} />
          </Link>
        );
      })}
    </div>
  );
}

export function CaseDetailPage(): ReactNode {
  const params = useParams<{ caseId: string }>();
  const caseId = params.caseId ?? "(missing)";
  const client = useHttpClient();
  const { state, reload } = useResource<CaseDetailResponse>(
    useCallback(
      (signal) =>
        client.query({
          path: `/api/v1/cases/${encodeURIComponent(caseId)}`,
          decoder: decodeCaseDetailResponse,
          signal,
        }),
      [client, caseId],
    ),
    [caseId],
  );

  const statusLabel =
    state.status === "ready" ? caseStatusPresentation(state.data.status).label : undefined;

  return (
    <FeaturePage
      title="Case detail"
      eyebrow="Investigation"
      subtitle={`Case ${caseId}`}
      actions={
        state.status === "ready" ? (
          <>
            <StatusPill
              tone={caseStatusPresentation(state.data.status).tone}
              label={statusLabel ?? ""}
            />
            <a
              className="button button-secondary"
              href={`/api/v1/cases/${encodeURIComponent(caseId)}/manifest`}
              download={`${caseId}-manifest.json`}
            >
              Export manifest
            </a>
          </>
        ) : null
      }
    >
      {state.status === "loading" && <LoadingState label="Loading case…" />}
      {state.status === "error" && <ResourceError error={state.error} onRetry={reload} />}
      {state.status === "ready" && <CaseDetailReady detail={state.data} onReload={reload} />}
    </FeaturePage>
  );
}

function CaseDetailReady({
  detail,
  onReload,
}: {
  readonly detail: CaseDetailResponse;
  readonly onReload: () => void;
}): ReactNode {
  const issuedGrants = detail.grants.filter((grant) => grant.state === "issued").length;
  const activeDumps = detail.dumps.filter((dump) => dump.phase === "available").length;

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/">Cases</Link>
        <span>/</span>
        <span>{detail.title}</span>
      </nav>
      <section className="metric-grid metric-grid-three" aria-label="Case summary">
        <div className="metric">
          <span className="metric-label">Dumps</span>
          <strong className="metric-value">{detail.dumps.length}</strong>
          <span className="metric-note">{activeDumps} available</span>
        </div>
        <div className="metric">
          <span className="metric-label">Upload grants</span>
          <strong className="metric-value">{detail.grants.length}</strong>
          <span className="metric-note">{issuedGrants} active</span>
        </div>
        <div className="metric">
          <span className="metric-label">Activity</span>
          <strong className="metric-value">{detail.activity.length}</strong>
          <span className="metric-note">Audited lifecycle events</span>
        </div>
      </section>
      <div className="layout-grid">
        <div className="stack">
          <Panel title="Crash dumps" subtitle="Original bytes are immutable after validation.">
            <DumpRows dumps={detail.dumps} />
          </Panel>
          <Panel title="Activity" subtitle="Most recent case events.">
            <ActivityTimeline items={detail.activity} />
          </Panel>
        </div>
        <div className="stack">
          <ActionFlowPanel
            caseId={detail.caseId}
            allowedActions={detail.allowedActions}
            issuedGrantCount={issuedGrants}
            onChanged={onReload}
          />
          <Panel title="Create upload link" subtitle="One customer, one case, one upload." className="panel-accent">
            <CreateGrantForm caseId={detail.caseId} onCreated={onReload} />
          </Panel>
          <Panel title="Upload grants" subtitle="Secrets are shown only at creation.">
            {detail.grants.length === 0 ? (
              <EmptyState title="No active links" icon="◇">
                Upload grants are one-time and case-bound.
              </EmptyState>
            ) : (
              <div className="record-list">
                {detail.grants.map((grant) => (
                  <GrantRow key={grant.grantId} grant={grant} onRevoked={onReload} />
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
