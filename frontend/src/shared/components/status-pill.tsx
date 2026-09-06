/**
 * StatusPill — renders a contract status as readable text inside the
 * evidence-vault pill. The label is ordinary text content (never decorative),
 * so the pill reads correctly without the tone dot.
 */

import type { ReactNode } from "react";
import type { StatusTone } from "../status";
import { classNames } from "../classnames";

export interface StatusPillProps {
  readonly tone: StatusTone;
  readonly label: string;
  readonly className?: string;
}

export function StatusPill({ tone, label, className }: StatusPillProps): ReactNode {
  return <span className={classNames("status", `status-${tone}`, className)}>{label}</span>;
}
