/**
 * ConfirmationDialog — accessible native-button confirmation surface
 * (design section 8.4).
 *
 * Rendered as an overlay with `role="dialog"`/`aria-modal` labelled by its
 * heading. Escape cancels unless a request is pending, initial focus lands on
 * the safe cancel button, and focus is restored to the previously focused
 * element when the dialog closes.
 */

import { useEffect, useId, useRef, type ReactNode } from "react";
import { classNames } from "../classnames";

export interface ConfirmationDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly tone?: "default" | "danger";
  readonly pending?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmationDialog(props: ConfirmationDialogProps): ReactNode {
  const cancelLabel = props.cancelLabel ?? "Cancel";
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);
  const titleId = useId();
  const pending = props.pending === true;

  // Move focus onto the dialog when it opens and restore it when it closes.
  useEffect(() => {
    if (props.open) {
      previouslyFocused.current = document.activeElement;
      cancelRef.current?.focus();
      return;
    }
    const restoreTo = previouslyFocused.current;
    if (restoreTo instanceof HTMLElement) {
      restoreTo.focus();
    }
    previouslyFocused.current = null;
  }, [props.open]);

  // Escape cancels unless a request is pending.
  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !pending) {
        event.preventDefault();
        props.onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.open, pending, props.onCancel]);

  if (!props.open) return null;
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{props.title}</h2>
        <p>{props.message}</p>
        <div className="dialog-actions">
          <button
            type="button"
            className="button button-secondary"
            ref={cancelRef}
            onClick={props.onCancel}
            disabled={pending}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={classNames("button", props.tone === "danger" ? "button-danger" : undefined)}
            onClick={props.onConfirm}
            disabled={pending}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
