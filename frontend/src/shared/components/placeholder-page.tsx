/**
 * PlaceholderPage — shared shell placeholder for operator screens that land in
 * the next phase (T5/T6). Each placeholder keeps its real route and heading so
 * routing, session protection, and deep links are already exercised.
 */

import { useId, type ReactNode } from "react";
import { Panel } from "./panel";
import { EmptyState } from "./empty-state";

export interface PlaceholderPageProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly message?: string;
}

export function PlaceholderPage({ title, subtitle, message }: PlaceholderPageProps): ReactNode {
  const titleId = useId();
  return (
    <section className="placeholder-page" aria-labelledby={titleId}>
      <h1 id={titleId} className="screen-title">
        {title}
      </h1>
      {subtitle !== undefined && <p className="screen-subtitle">{subtitle}</p>}
      <Panel>
        <EmptyState title="Coming in the operator phase" icon="◈">
          {message ?? "This screen is routed and session-protected; its data flows arrive with the feature phase."}
        </EmptyState>
      </Panel>
    </section>
  );
}
