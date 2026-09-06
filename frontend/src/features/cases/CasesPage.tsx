/**
 * CasesPage — bounded case search with server-side filtering and cursor
 * pagination (design section 7.3).
 *
 * `GET /api/v1/cases?query=&cursor=` returns a bounded page plus an opaque
 * `nextCursor` when more rows exist. The browser never receives the whole
 * ledger. Each submitted query starts a fresh first page; "Load more" appends
 * the next cursor page. Requests are abortable on route change or when a newer
 * search supersedes an in-flight one, and an older response can never replace
 * a newer page's rows.
 */

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import {
  decodeCaseSearchResponse,
  type CaseSearchResponse,
  type CaseSummary,
} from "@dump-ledger/http-contracts";
import { useHttpClient } from "../../shared/http-client-context";
import { FeaturePage, LoadingState, ResourceError } from "../feature-page";
import { Panel } from "../../shared/components/panel";
import { FormField } from "../../shared/components/form-field";
import { EmptyState } from "../../shared/components/empty-state";
import { StatusPill } from "../../shared/components/status-pill";
import { caseStatusPresentation } from "../../shared/status";
import { formatUtcDate } from "../../shared/format";

export type CaseSearchPhase =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly cases: readonly CaseSummary[]; readonly nextCursor: string | undefined }
  | { readonly status: "error"; readonly error: unknown };

export interface CaseSearchControls {
  readonly state: CaseSearchPhase;
  /** True while a "Load more" cursor page is being fetched. */
  readonly loadingMore: boolean;
  readonly query: string;
  readonly setQuery: (value: string) => void;
  readonly search: (query: string) => void;
  readonly loadMore: () => void;
  readonly retry: () => void;
}

/**
 * Owns the bounded search/pagination state machine. `search` starts a fresh
 * first page; `loadMore` appends the server's cursor page; every run aborts
 * the previous in-flight request, and stale responses are discarded.
 */
export function useCaseSearch(): CaseSearchControls {
  const client = useHttpClient();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<CaseSearchPhase>({ status: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  // Guards against duplicate concurrent searches from the same input value.
  const requestKeyRef = useRef(0);
  // Latest committed phase: the click handler reads it so it never closes
  // over a stale cursor, and no state updater has side effects.
  const phaseRef = useRef<CaseSearchPhase>({ status: "loading" });

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const search = useCallback((nextQuery: string) => {
    setQuery(nextQuery);
    setCursor(undefined);
  }, []);

  const loadMore = useCallback(() => {
    const current = phaseRef.current;
    if (current.status !== "ready" || current.nextCursor === undefined) return;
    setCursor(current.nextCursor);
  }, []);

  const retry = useCallback(() => {
    setRetryNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let settled = false;
    const requestKey = ++requestKeyRef.current;
    const replacing = cursor === undefined;

    setLoadingMore(!replacing);
    if (replacing) {
      setPhase({ status: "loading" });
    }

    const params = new URLSearchParams();
    if (query.length > 0) params.set("query", query);
    if (cursor !== undefined) params.set("cursor", cursor);
    const queryString = params.toString();
    const path = queryString.length === 0 ? "/api/v1/cases" : `/api/v1/cases?${queryString}`;

    client
      .query<CaseSearchResponse>({ path, decoder: decodeCaseSearchResponse, signal: controller.signal })
      .then((response) => {
        if (settled || controller.signal.aborted || requestKey !== requestKeyRef.current) return;
        settled = true;
        setPhase((current) => {
          const previous = current.status === "ready" ? current.cases : [];
          return {
            status: "ready",
            cases: replacing ? [...response.cases] : [...previous, ...response.cases],
            nextCursor: response.nextCursor,
          };
        });
        setLoadingMore(false);
      })
      .catch((error: unknown) => {
        if (settled || controller.signal.aborted || requestKey !== requestKeyRef.current) return;
        settled = true;
        setPhase({ status: "error", error });
        setLoadingMore(false);
      });

    return () => {
      settled = true;
      controller.abort();
    };
  }, [client, query, cursor, retryNonce]);

  return {
    state: phase,
    loadingMore,
    query,
    setQuery,
    search,
    loadMore,
    retry,
  };
}

function CaseList({ cases }: { readonly cases: readonly CaseSummary[] }): ReactNode {
  if (cases.length === 0) {
    return (
      <EmptyState title="No matching cases" icon="◇">
        Try a different search, or open a case under a customer on the dashboard.
      </EmptyState>
    );
  }
  return (
    <div className="case-list">
      {cases.map((item) => {
        const presentation = caseStatusPresentation(item.status);
        return (
          <Link className="case-row" key={item.caseId} to={`/cases/${encodeURIComponent(item.caseId)}`}>
            <span>
              <span className="case-title">{item.title}</span>
              <span className="case-meta">
                <span className="mono subtle-id">{item.caseId}</span>
                <time dateTime={item.createdAt}>{formatUtcDate(item.createdAt)}</time>
              </span>
            </span>
            <StatusPill tone={presentation.tone} label={presentation.label} />
          </Link>
        );
      })}
    </div>
  );
}

export function CasesPage(): ReactNode {
  const { state, loadingMore, query, search, loadMore, retry } = useCaseSearch();
  const [inputValue, setInputValue] = useState("");
  const searchQueryId = useId();

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    search(inputValue.trim());
  }

  return (
    <FeaturePage
      title="Cases"
      subtitle="Bounded search across every case, with server-side pagination."
      actions={
        <Link className="button button-secondary button-small" to="/">
          Back to dashboard
        </Link>
      }
    >
      <Panel title="Search cases" subtitle="Filter by title or customer identity.">
        <form className="inline-create" onSubmit={handleSubmit} role="search">
          <FormField id={searchQueryId} label="Search query">
            {({ describedBy }) => (
              <span className="inline-field">
                <input
                  id={searchQueryId}
                  type="search"
                  name="query"
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  placeholder="Search titles and customers"
                  maxLength={200}
                  aria-describedby={describedBy}
                />
                <button type="submit" className="button button-secondary">
                  Search
                </button>
              </span>
            )}
          </FormField>
        </form>
      </Panel>

      {state.status === "loading" && <LoadingState label="Searching cases…" />}
      {state.status === "error" && <ResourceError error={state.error} onRetry={retry} />}
      {state.status === "ready" && (
        <Panel
          title="Results"
          subtitle={query.length > 0 ? `Matches for “${query}”.` : "Latest cases first."}
          actions={<span className="panel-count">{state.cases.length}</span>}
        >
          <CaseList cases={state.cases} />
          {state.nextCursor !== undefined && (
            <div className="panel-body">
              <button
                type="button"
                className="button button-secondary"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading more…" : "Load more"}
              </button>
            </div>
          )}
        </Panel>
      )}
    </FeaturePage>
  );
}
