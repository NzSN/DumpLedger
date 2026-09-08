/**
 * TransferSection — the operations page "Export / Import" region
 * (import/export design, "HTTP and UI surface"). Composes the export bundle
 * list/create/delete panel with the gated import panel; both panels own
 * their own loads, mutations, and bounded polling.
 */

import type { ReactNode } from "react";
import { ExportPanel } from "./ExportPanel";
import { ImportPanel } from "./ImportPanel";

export interface TransferSectionProps {
  /** Export list poll cadence while a bundle is running. */
  readonly exportPollIntervalMs?: number;
  /** Import progress poll cadence. */
  readonly importPollIntervalMs?: number;
}

export function TransferSection(props: TransferSectionProps): ReactNode {
  return (
    <section aria-label="Export / Import">
      <div className="layout-grid">
        <ExportPanel
          {...(props.exportPollIntervalMs === undefined
            ? {}
            : { pollIntervalMs: props.exportPollIntervalMs })}
        />
        <ImportPanel
          {...(props.importPollIntervalMs === undefined
            ? {}
            : { pollIntervalMs: props.importPollIntervalMs })}
        />
      </div>
    </section>
  );
}
