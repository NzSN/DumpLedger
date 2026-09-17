/**
 * SymbolsPage — operator symbol store (docs/symbols-design.md, milestone 1).
 *
 * Two panels: the artifact list (bounded `GET /api/v1/symbols`) and the
 * ingest queue (multi-file drop zone, strictly sequential raw uploads). The
 * list is authoritative: a confirmed purge and every drained ingest batch
 * refetch it. Purging is destructive but re-ingestable, so it sits behind the
 * shared confirmation dialog instead of a bare button.
 *
 * The page talks HTTP only through `createSymbolsApi` (see symbols-api.ts);
 * it never touches fetch/XHR, and bytes never enter React state.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { SymbolListResponse, SymbolRecord } from "@dump-ledger/http-contracts";
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
import { formatBytes, formatUtcTimestamp } from "../../shared/format";
import { SymbolIngestQueue } from "./SymbolIngestQueue";
import { createSymbolsApi } from "./symbols-api";
import { symbolKindLabel, truncateDebugId } from "./symbols-copy";
import "./symbols.css";

interface SymbolRowProps {
  readonly record: SymbolRecord;
  readonly purgePending: boolean;
  readonly onPurge: () => void;
}

/** One stored artifact: debug file + truncated identity, kind, size, metadata. */
function SymbolRow({ record, purgePending, onPurge }: SymbolRowProps): ReactNode {
  return (
    <div className="record-row">
      <div className="record-main">
        <span className="record-title mono">{record.debugFile}</span>
        <div className="record-meta">
          <span className="mono" title={record.debugId}>
            {truncateDebugId(record.debugId)}
          </span>
          <span>{formatBytes(record.byteSize)}</span>
          <span>Ingested {formatUtcTimestamp(record.ingestedAt)}</span>
          {record.product !== undefined && <span>{record.product}</span>}
          {record.version !== undefined && <span>{record.version}</span>}
          {record.arch !== undefined && <span>{record.arch}</span>}
        </div>
      </div>
      <div className="record-actions">
        <StatusPill tone="muted" label={symbolKindLabel(record.kind)} />
        <button
          type="button"
          className="button button-danger button-small"
          onClick={onPurge}
          disabled={purgePending}
        >
          Purge
        </button>
      </div>
    </div>
  );
}

export function SymbolsPage(): ReactNode {
  const client = useHttpClient();
  const api = useMemo(() => createSymbolsApi(client), [client]);
  const load = useCallback((signal: AbortSignal) => api.listSymbols(signal), [api]);
  const { state, reload } = useResource<SymbolListResponse>(load);
  const [purgeTarget, setPurgeTarget] = useState<SymbolRecord | null>(null);
  const purge = useMutationFlow<SymbolRecord>();

  async function confirmPurge(): Promise<void> {
    const target = purgeTarget;
    if (target === null) return;
    setPurgeTarget(null);
    const purged = await purge.run(async (signal) => {
      await api.purgeSymbol(target.artifactId, signal);
      return target;
    });
    if (purged !== null) reload();
  }

  const symbols = state.status === "ready" ? state.data.symbols : null;

  return (
    <FeaturePage
      title="Symbols"
      subtitle="PDB artifacts registered by debug identity and served to debuggers through the symbol store."
    >
      <Panel
        title="Symbol artifacts"
        subtitle="Identity is parsed from the bytes; re-ingesting a known build is a no-op."
        actions={
          <>
            {symbols !== null && <span className="panel-count">{symbols.length}</span>}
            <button
              type="button"
              className="button button-secondary button-small"
              onClick={reload}
              disabled={state.status === "loading"}
            >
              Refresh
            </button>
          </>
        }
      >
        <MutationErrorSummary error={purge.error} fallback="The artifact could not be purged." />
        <MutationSuccessSummary active={purge.result !== null}>
          <p>Purged {purge.result?.debugFile}.</p>
        </MutationSuccessSummary>
        {state.status === "loading" && <LoadingState label="Loading symbol artifacts…" />}
        {state.status === "error" && <ResourceError error={state.error} onRetry={reload} />}
        {symbols !== null &&
          (symbols.length === 0 ? (
            <EmptyState title="No symbol artifacts" icon="◇">
              Ingest a PDB below to serve it to debuggers from this store. Artifacts stay until an
              operator purges them.
            </EmptyState>
          ) : (
            <div className="record-list">
              {symbols.map((record) => (
                <SymbolRow
                  key={record.artifactId}
                  record={record}
                  purgePending={purge.pending}
                  onPurge={() => setPurgeTarget(record)}
                />
              ))}
            </div>
          ))}
      </Panel>

      <SymbolIngestQueue api={api} onIngested={reload} />

      <ConfirmationDialog
        open={purgeTarget !== null}
        title="Purge symbol artifact"
        message={
          purgeTarget === null
            ? ""
            : `Purge ${purgeTarget.debugFile} (${truncateDebugId(purgeTarget.debugId)})? Debuggers stop resolving this module until it is ingested again; dumps that reference it keep their recorded module facts.`
        }
        confirmLabel="Purge artifact"
        cancelLabel="Cancel"
        tone="danger"
        pending={purge.pending}
        onConfirm={() => void confirmPurge()}
        onCancel={() => setPurgeTarget(null)}
      />
    </FeaturePage>
  );
}
