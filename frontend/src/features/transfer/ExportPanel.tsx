/**
 * ExportPanel — operator export bundle surface (import/export design,
 * "HTTP and UI surface").
 *
 *   - "Create export bundle" runs POST /api/v1/operations/exports and is
 *     disabled while any bundle is running (the server allows one transfer
 *     at a time; a race still surfaces as the inline 409 notice),
 *   - the bounded list polls only while a bundle is running,
 *   - a sealed bundle downloads through a plain anchor so multi-GB tar
 *     bytes stream straight to disk without transiting fetch/blob memory,
 *   - delete is a confirmed danger mutation; bundle removal never touches
 *     the ledger or the vault.
 */

import { useState, type ReactNode } from "react";
import {
  decodeCreateExportResponse,
  decodeDeleteExportResponse,
  type CreateExportResponse,
  type DeleteExportResponse,
  type ExportSummary,
} from "@dump-ledger/http-contracts";
import { useHttpClient } from "../../shared/http-client-context";
import { formatBytes, formatUtcTimestamp } from "../../shared/format";
import { exportStatusPresentation } from "../../shared/status";
import { Panel } from "../../shared/components/panel";
import { StatusPill } from "../../shared/components/status-pill";
import { EmptyState } from "../../shared/components/empty-state";
import { ConfirmationDialog } from "../../shared/components/confirmation-dialog";
import { LoadingState, ResourceError } from "../feature-page";
import {
  MutationErrorSummary,
  MutationSuccessSummary,
  useMutationFlow,
} from "../shared-use-resource";
import { EXPORT_LIST_POLL_INTERVAL_MS, EXPORTS_PATH, useExportList } from "./use-export-list";
import { TransferConflictNotice, isTransferConflict } from "./transfer-common";

/**
 * Bundle sizes cross the wire as canonical decimal strings. Display goes
 * through bigint (never a JavaScript number) so multi-GB sizes stay exact;
 * an unexpected value falls back to the verbatim string.
 */
export function formatBundleSize(byteSize: string | null): string {
  if (byteSize === null) return "Unknown";
  try {
    return formatBytes(BigInt(byteSize));
  } catch {
    return byteSize;
  }
}

/** Streamed tar download URL; consumed by a plain anchor, never by fetch. */
export function exportFileHref(exportId: string): string {
  return `${EXPORTS_PATH}/${encodeURIComponent(exportId)}/file`;
}

interface ExportRowProps {
  readonly bundle: ExportSummary;
  /** Called after a successful delete so the list refetches. */
  readonly onDeleted: (exportId: string) => void;
}

function ExportRow({ bundle, onDeleted }: ExportRowProps): ReactNode {
  const client = useHttpClient();
  const flow = useMutationFlow<DeleteExportResponse>();
  const [confirming, setConfirming] = useState(false);
  const presentation = exportStatusPresentation(bundle.status);

  async function handleConfirmDelete(): Promise<void> {
    setConfirming(false);
    const deleted = await flow.run(async (signal) => {
      return client.mutate({
        path: `${EXPORTS_PATH}/${encodeURIComponent(bundle.exportId)}`,
        method: "DELETE",
        decoder: decodeDeleteExportResponse,
        signal,
      });
    });
    if (deleted !== null) {
      onDeleted(bundle.exportId);
    }
  }

  return (
    <div className="record-row">
      <div className="record-main">
        <span className="record-title mono">{bundle.exportId}</span>
        <div className="record-meta">
          <span>Created {formatUtcTimestamp(bundle.createdAt)}</span>
          <span>{formatBundleSize(bundle.byteSize)}</span>
          {bundle.error !== null && <span>{bundle.error}</span>}
        </div>
      </div>
      <div className="record-actions">
        <StatusPill tone={presentation.tone} label={presentation.label} />
        {bundle.status === "sealed" && (
          <a
            className="button button-secondary button-small"
            href={exportFileHref(bundle.exportId)}
            download
          >
            Download bundle
          </a>
        )}
        {bundle.status !== "running" && (
          <button
            type="button"
            className="button button-danger button-small"
            onClick={() => setConfirming(true)}
            disabled={flow.pending}
          >
            {flow.pending ? "Deleting…" : "Delete"}
          </button>
        )}
      </div>
      <MutationErrorSummary error={flow.error} fallback="The export bundle could not be deleted." />
      <MutationSuccessSummary active={flow.result !== null}>
        <p>Deleted export bundle {bundle.exportId}.</p>
      </MutationSuccessSummary>
      <ConfirmationDialog
        open={confirming}
        title="Delete export bundle"
        message="Deleting removes this export bundle from the server. Ledger entries and dump bytes in the vault are not affected."
        confirmLabel="Delete bundle"
        cancelLabel="Cancel"
        tone="danger"
        pending={flow.pending}
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

export interface ExportPanelProps {
  /** List poll cadence while a bundle is running; tests inject a short value. */
  readonly pollIntervalMs?: number;
}

export function ExportPanel({ pollIntervalMs = EXPORT_LIST_POLL_INTERVAL_MS }: ExportPanelProps): ReactNode {
  const client = useHttpClient();
  const { phase, busy, refresh } = useExportList(pollIntervalMs);
  const createFlow = useMutationFlow<CreateExportResponse>();

  const bundles = phase.status === "ready" ? phase.data.exports : [];
  const anyRunning = bundles.some((bundle) => bundle.status === "running");

  async function handleCreate(): Promise<void> {
    const created = await createFlow.run(async (signal) => {
      return client.mutate({
        path: EXPORTS_PATH,
        method: "POST",
        decoder: decodeCreateExportResponse,
        signal,
      });
    });
    if (created !== null) {
      // Show the new running bundle immediately.
      refresh();
    }
  }

  return (
    <Panel
      title="Export bundles"
      subtitle="Portable bundles of the ledger and vault bytes. One transfer runs at a time."
      actions={
        <button
          type="button"
          className="button button-secondary button-small"
          onClick={refresh}
          disabled={busy}
        >
          {busy ? "Refreshing…" : "Refresh list"}
        </button>
      }
    >
      <div className="form-stack">
        <div>
          <button
            type="button"
            className="button"
            onClick={() => void handleCreate()}
            disabled={createFlow.pending || anyRunning}
          >
            {createFlow.pending ? "Creating…" : "Create export bundle"}
          </button>
        </div>
        <TransferConflictNotice active={isTransferConflict(createFlow.error)} />
        {!isTransferConflict(createFlow.error) && (
          <MutationErrorSummary error={createFlow.error} fallback="The export bundle could not be created." />
        )}
        <MutationSuccessSummary active={createFlow.result !== null}>
          <p>Export bundle {createFlow.result?.exportId} is being written; it appears below while it runs.</p>
        </MutationSuccessSummary>
        {phase.status === "loading" && <LoadingState label="Loading export bundles…" />}
        {phase.status === "error" && <ResourceError error={phase.error} onRetry={refresh} />}
        {phase.status === "ready" &&
          (bundles.length === 0 ? (
            <EmptyState title="No export bundles" icon="↓">
              Create a bundle to move this instance or hand off evidence.
            </EmptyState>
          ) : (
            <div className="record-list">
              {bundles.map((bundle) => (
                <ExportRow bundle={bundle} key={bundle.exportId} onDeleted={refresh} />
              ))}
            </div>
          ))}
      </div>
    </Panel>
  );
}
