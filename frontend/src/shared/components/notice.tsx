/**
 * Notice — shared status message (design section 8.4). Rendered with native
 * live-region semantics: callers choose `alert` for errors and `status`
 * (polite) for success/info so screen readers announce changes.
 */

import type { ReactNode } from "react";
import { classNames } from "../classnames";

export type NoticeTone = "info" | "success" | "warn" | "error";

export interface NoticeProps {
  readonly tone?: NoticeTone;
  readonly role?: "status" | "alert";
  readonly children: ReactNode;
  readonly className?: string;
}

const TONE_ICONS: Record<NoticeTone, string> = {
  info: "i",
  success: "✓",
  warn: "!",
  error: "!",
};

export function Notice({ tone = "warn", role, children, className }: NoticeProps): ReactNode {
  // The base `.notice` style is the warn tone; only other tones need data-tone.
  const dataTone = tone === "warn" ? undefined : tone;
  return (
    <div className={classNames("notice", className)} data-tone={dataTone} role={role ?? "status"}>
      <span className="notice-icon" aria-hidden="true">
        {TONE_ICONS[tone]}
      </span>
      <div className="notice-body">{children}</div>
    </div>
  );
}
