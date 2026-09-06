/**
 * Panel — card surface with an optional header (title, subtitle, actions) and
 * body, matching the `.panel` / `.panel-header` / `.panel-body` language.
 */

import type { ReactNode } from "react";
import { classNames } from "../classnames";

export interface PanelProps {
  readonly title?: string;
  readonly subtitle?: string;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
}

export function Panel({ title, subtitle, actions, children, className, bodyClassName }: PanelProps): ReactNode {
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <section className={classNames("panel", className)}>
      {hasHeader && (
        <header className="panel-header">
          <div>
            {title !== undefined && <h2>{title}</h2>}
            {subtitle !== undefined && <p>{subtitle}</p>}
          </div>
          {actions !== undefined && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className={classNames("panel-body", bodyClassName)}>{children}</div>}
    </section>
  );
}
