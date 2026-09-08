/**
 * ImportPanel — verified ingestion of a server-local export bundle
 * (import/export design, "HTTP and UI surface").
 *
 * The operator supplies the bundle's path on the server filesystem; bundle
 * bytes never transit the browser. Starting an import is gated behind an
 * explicit strict confirmation: import requires an EMPTY ledger, and when
 * the bundle was exported under a different grant key every outstanding
 * upload grant is revoked on the way in.
 *
 * While the import runs, progress (verified / imported / rejected / skipped)
 * polls about once a second and stops on the terminal status.
 */

import { useId, useState, type FormEvent, type ReactNode } from "react";
import {
  MAX_IMPORT_PATH_LENGTH,
  decodeCreateImportResponse,
  encodeCreateImportRequest,
  type CreateImportResponse,
  type ImportProgressResponse,
} from "@dump-ledger/http-contracts";
import { errorText } from "../../shared/http-client";
import { useHttpClient } from "../../shared/http-client-context";
import { importStatusPresentation } from "../../shared/status";
import { Panel } from "../../shared/components/panel";
import { FormField } from "../../shared/components/form-field";
import { Notice } from "../../shared/components/notice";
import { StatusPill } from "../../shared/components/status-pill";
import {
  MutationErrorSummary,
  MutationSuccessSummary,
  useMutationFlow,
} from "../shared-use-resource";
import { IMPORT_PROGRESS_POLL_INTERVAL_MS, useImportProgress } from "./use-import-progress";
import { TransferConflictNotice, isTransferConflict } from "./transfer-common";

const IMPORTS_PATH = "/api/v1/operations/imports";

function ImportProgressView({ progress }: { readonly progress: ImportProgressResponse }): ReactNode {
  const presentation = importStatusPresentation(progress.status);
  return (
    <div className="record-row" aria-live="polite">
      <div className="record-main">
        <span className="record-title mono">{progress.importId}</span>
        <div className="record-meta">
          <span>{progress.verified} verified</span>
          <span>{progress.imported} imported</span>
          <span>{progress.rejected} rejected</span>
          <span>{progress.skipped} skipped</span>
        </div>
      </div>
      <div className="record-actions">
        <StatusPill tone={presentation.tone} label={presentation.label} />
      </div>
    </div>
  );
}

export interface ImportPanelProps {
  /** Progress poll cadence; tests inject a short value. */
  readonly pollIntervalMs?: number;
}

export function ImportPanel({ pollIntervalMs = IMPORT_PROGRESS_POLL_INTERVAL_MS }: ImportPanelProps): ReactNode {
  const client = useHttpClient();
  const startFlow = useMutationFlow<CreateImportResponse>();
  const pathId = useId();
  const confirmId = useId();
  const [pathText, setPathText] = useState("");
  const [pathError, setPathError] = useState<string | undefined>(undefined);
  const [confirmed, setConfirmed] = useState(false);
  const [activeImportId, setActiveImportId] = useState<string | null>(null);
  const { progress, error: progressError } = useImportProgress(activeImportId, pollIntervalMs);

  const importRunning = progress !== null && progress.status === "running";

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const path = pathText.trim();
    if (path.length === 0) {
      setPathError("Enter the path of an export bundle on the server filesystem.");
      return;
    }
    if (path.length > MAX_IMPORT_PATH_LENGTH) {
      setPathError(`The path must be ${MAX_IMPORT_PATH_LENGTH} characters or fewer.`);
      return;
    }
    setPathError(undefined);
    const started = await startFlow.run(async (signal) => {
      return client.mutate({
        path: IMPORTS_PATH,
        method: "POST",
        body: encodeCreateImportRequest({ path }),
        decoder: decodeCreateImportResponse,
        signal,
      });
    });
    if (started !== null) {
      setActiveImportId(started.importId);
    }
  }

  return (
    <Panel title="Import" subtitle="Ingest a server-local export bundle into an empty ledger.">
      <form className="form-stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <Notice tone="warn">
          <p>
            Import requires an <strong>empty ledger</strong>: no customers, cases, dumps, or upload
            grants may exist. If the bundle was exported under a different grant key, every
            outstanding upload grant is revoked when the bundle is imported.
          </p>
        </Notice>
        <TransferConflictNotice active={isTransferConflict(startFlow.error)} />
        {!isTransferConflict(startFlow.error) && (
          <MutationErrorSummary error={startFlow.error} fallback="The import could not be started." />
        )}
        <FormField
          id={pathId}
          label="Bundle path on the server"
          hint="Absolute path of the export bundle tar on this server's filesystem."
          {...(pathError === undefined ? {} : { error: pathError })}
        >
          {({ describedBy }) => (
            <input
              id={pathId}
              name="path"
              type="text"
              className="mono"
              value={pathText}
              onChange={(event) => setPathText(event.target.value)}
              disabled={startFlow.pending || importRunning}
              aria-invalid={pathError !== undefined}
              aria-describedby={describedBy}
              maxLength={MAX_IMPORT_PATH_LENGTH}
              placeholder="/srv/dump-ledger/exports/bundle.tar"
              required
            />
          )}
        </FormField>
        <label className="check-field" htmlFor={confirmId}>
          <input
            id={confirmId}
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={startFlow.pending || importRunning}
          />
          <span>I understand import requires an empty ledger and may revoke outstanding upload grants.</span>
        </label>
        <div>
          <button type="submit" className="button" disabled={!confirmed || startFlow.pending || importRunning}>
            {startFlow.pending ? "Starting…" : importRunning ? "Import running…" : "Start import"}
          </button>
        </div>
      </form>
      {activeImportId !== null && (
        <div className="form-stack import-progress">
          {progressError !== null && progressError !== undefined ? (
            <Notice tone="error" role="alert">
              <p>{errorText(progressError, "Import progress could not be loaded.")}</p>
            </Notice>
          ) : progress === null ? (
            <p role="status" className="screen-subtitle">
              Waiting for import progress…
            </p>
          ) : (
            <>
              <ImportProgressView progress={progress} />
              {progress.status === "finished" && (
                <MutationSuccessSummary active={true}>
                  <p>
                    Import finished: {progress.imported} imported, {progress.rejected} rejected,{" "}
                    {progress.skipped} skipped ({progress.verified} verified).
                  </p>
                </MutationSuccessSummary>
              )}
              {progress.status === "failed" && (
                <Notice tone="error" role="alert">
                  <p>{progress.error ?? "The import failed."}</p>
                </Notice>
              )}
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
