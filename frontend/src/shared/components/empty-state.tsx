/**
 * EmptyState — the evidence-vault empty-state presentation. `title` is the
 * strong lead line; children carry the supporting copy.
 */

import type { ReactNode } from "react";
import { classNames } from "../classnames";

export interface EmptyStateProps {
  readonly title: string;
  readonly children?: ReactNode;
  readonly icon?: string;
  readonly className?: string;
}

export function EmptyState({ title, children, icon, className }: EmptyStateProps): ReactNode {
  return (
    <div className={classNames("empty-state", className)}>
      {icon !== undefined && (
        <span className="empty-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <strong>{title}</strong>
      {children !== undefined && <p>{children}</p>}
    </div>
  );
}
