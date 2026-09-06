/**
 * ActivityTimeline — bounded, safely-echoed lifecycle events shown on case
 * and dump detail pages (legacy `.timeline` oracle). Each item carries the
 * audit action (readable spaced label) and the canonical UTC timestamp.
 */

import type { ReactNode } from "react";
import type { ActivityItem } from "@dump-ledger/http-contracts";
import { EmptyState } from "../../shared/components/empty-state";
import { formatUtcTimestamp } from "../../shared/format";

/** "UploadStarted" -> "Upload Started" (legacy audit label language). */
export function humanizeAction(action: string): string {
  return action.replaceAll(/([a-z])([A-Z])/g, "$1 $2");
}

export interface ActivityTimelineProps {
  readonly items: readonly ActivityItem[];
}

export function ActivityTimeline({ items }: ActivityTimelineProps): ReactNode {
  if (items.length === 0) {
    return <EmptyState title="No activity yet">Lifecycle events will appear here.</EmptyState>;
  }
  return (
    <ol className="timeline">
      {items.map((item, index) => (
        <li className="timeline-item" key={`${item.occurredAt}-${index}`}>
          <span className="timeline-title">
            {humanizeAction(item.action)}
            {item.outcome !== undefined ? ` · ${item.outcome}` : null}
          </span>
          <time className="timeline-time" dateTime={item.occurredAt}>
            {formatUtcTimestamp(item.occurredAt)}
          </time>
        </li>
      ))}
    </ol>
  );
}
