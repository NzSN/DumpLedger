/**
 * Dump ↔ symbol linkage lists (docs/symbols-design.md, milestone 2).
 *
 * `SymbolCoverageList` is the dump page's per-module coverage;
 * `MissingSymbolsList` is the case page's aggregation of missing identities.
 * Both are pure presentation over the contract shapes in
 * `@dump-ledger/http-contracts` and reuse the record-row language of the
 * artifact and dump lists. There is no per-artifact route, so stored artifacts
 * are referenced by debug file plus the same shortened identity the Symbols
 * page shows, with the full value in the row's `title`; missing identities
 * render their full debug file and debug id so an operator can go ingest
 * exactly that build.
 */

import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { MissingSymbolIdentity, ModuleSymbolCoverage } from "@dump-ledger/http-contracts";
import { EmptyState } from "../../shared/components/empty-state";
import { classNames } from "../../shared/classnames";
import {
  moduleNameLabel,
  moduleSymbolStatusGlyph,
  moduleSymbolStatusLabel,
  referencingDumpCountLabel,
  systemModulesToggleLabel,
  truncateDebugId,
} from "./symbols-copy";
import "./symbols.css";

function SymbolCoverageRow({ entry }: { readonly entry: ModuleSymbolCoverage }): ReactNode {
  return (
    <div className="record-row">
      <div className="record-main">
        <span className="record-title mono">{moduleNameLabel(entry.name)}</span>
        {entry.status === "present" && (
          <div className="record-meta">
            <span className="mono" title={entry.debugFile ?? undefined}>
              {entry.debugFile ?? "debug file not recorded"}
            </span>
            {entry.debugId !== null && (
              <span className="mono" title={entry.debugId}>
                {truncateDebugId(entry.debugId)}
              </span>
            )}
            {entry.artifactId !== null && (
              <span className="mono" title={`Artifact ${entry.artifactId}`}>
                {truncateDebugId(entry.artifactId)}
              </span>
            )}
          </div>
        )}
        {entry.status === "missing" && (
          <div className="record-meta">
            <span className="mono">{entry.debugFile ?? "debug file not recorded"}</span>
            <span className="mono">{entry.debugId ?? "debug id not recorded"}</span>
          </div>
        )}
      </div>
      <span className={classNames("symbol-coverage-status", `is-${entry.status}`)}>
        <span aria-hidden="true">{moduleSymbolStatusGlyph(entry.status)}</span>
        <span>{moduleSymbolStatusLabel(entry.status)}</span>
      </span>
    </div>
  );
}

export function SymbolCoverageList({
  entries,
}: {
  readonly entries: readonly ModuleSymbolCoverage[];
}): ReactNode {
  const [showSystem, setShowSystem] = useState(false);
  if (entries.length === 0) {
    return (
      <EmptyState title="No module identities recorded" icon="◇">
        Coverage appears after intake inspection records the dump's module list.
      </EmptyState>
    );
  }
  // OS-owned modules (System32 and siblings) never need symbols from this
  // store — the Microsoft public server resolves them — so they collapse out
  // of the operator's way by default.
  const applicationEntries = entries.filter((entry) => !entry.system);
  const systemEntries = entries.filter((entry) => entry.system);
  const visible = showSystem ? systemEntries : [];
  return (
    <div className="record-list">
      {applicationEntries.map((entry, index) => (
        <SymbolCoverageRow
          key={`${entry.status}-${entry.debugFile ?? "unnamed"}-${index}`}
          entry={entry}
        />
      ))}
      {systemEntries.length > 0 && (
        <div>
          <button
            type="button"
            className="button button-secondary button-small"
            onClick={() => setShowSystem((current) => !current)}
          >
            {systemModulesToggleLabel(systemEntries.length, showSystem)}
          </button>
        </div>
      )}
      {visible.map((entry, index) => (
        <SymbolCoverageRow
          key={`system-${entry.status}-${entry.debugFile ?? "unnamed"}-${index}`}
          entry={entry}
        />
      ))}
    </div>
  );
}

export function MissingSymbolsList({
  entries,
}: {
  readonly entries: readonly MissingSymbolIdentity[];
}): ReactNode {
  if (entries.length === 0) {
    return (
      <EmptyState title="No missing symbols" icon="◇">
        Every debug identity referenced by this case's dumps resolves to an artifact in the symbol
        store.
      </EmptyState>
    );
  }
  return (
    <div className="record-list">
      {entries.map((entry, index) => (
        <div className="record-row" key={`${entry.debugFile}-${entry.debugId}-${index}`}>
          <div className="record-main">
            <span className="record-title mono">{entry.debugFile}</span>
            <div className="record-meta">
              <span className="mono">{entry.debugId}</span>
              <span>{referencingDumpCountLabel(entry.dumpIds.length)}</span>
            </div>
            {entry.dumpIds.length > 0 && (
              <div className="record-meta">
                {entry.dumpIds.map((dumpId) => (
                  <Link className="mono" key={dumpId} to={`/dumps/${encodeURIComponent(dumpId)}`}>
                    {dumpId}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
