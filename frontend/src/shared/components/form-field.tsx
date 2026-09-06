/**
 * FormField — semantic label + control wrapper (design section 8.4).
 *
 * The caller renders the control itself as a function child and receives the
 * `aria-describedby` value that joins the hint and error ids, so the control
 * can reference both with one attribute. Field errors are exposed with
 * `role="alert"` and the control is marked invalid via the caller's `aria`.
 */

import type { ReactNode } from "react";

export interface FormFieldRenderArgs {
  /** Value for the control's `aria-describedby`; undefined when no hint or error. */
  readonly describedBy: string | undefined;
}

export interface FormFieldProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly children: ReactNode | ((args: FormFieldRenderArgs) => ReactNode);
}

export function FormField({ id, label, hint, error, children }: FormFieldProps): ReactNode {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
      .filter((value): value is string => value !== null)
      .join(" ") || undefined;

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {typeof children === "function" ? children({ describedBy }) : children}
      {hint !== undefined && (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
