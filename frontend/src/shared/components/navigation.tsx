/**
 * Shared navigation and chrome primitives (design section 8.4). These are
 * presentational: the operator layout composes them with session state.
 * The brand mark mirrors the legacy evidence-vault inline SVG exactly.
 */

import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { classNames } from "../classnames";

export interface BrandProps {
  readonly href?: string;
  readonly label?: string;
}

export function Brand({ href = "/", label = "DumpLedger home" }: BrandProps): ReactNode {
  return (
    <a className="brand" href={href} aria-label={label}>
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 36 36">
          <path d="M18 3 31 8v9c0 8.4-5.2 13.4-13 16C10.2 30.4 5 25.4 5 17V8l13-5Z" fill="currentColor" opacity=".18" />
          <path
            d="M18 6.6 27.6 10v7c0 6.2-3.6 10.1-9.6 12.6C12 27.1 8.4 23.2 8.4 17v-7L18 6.6Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
          />
          <path
            d="M13 15.2h10M13 19h10M13 22.8h6.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className="brand-copy">
        <strong>DumpLedger</strong>
        <small>Crash evidence vault</small>
      </span>
    </a>
  );
}

export const OPERATOR_NAV_LINKS = [
  { to: "/", label: "Cases", end: true },
  { to: "/operations", label: "Operations", end: false },
] as const;

export function PrimaryNav(): ReactNode {
  return (
    <nav className="primary-nav" aria-label="Primary navigation">
      {OPERATOR_NAV_LINKS.map((link) => (
        <NavLink key={link.to} to={link.to} end={link.end}>
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}

export interface SignOutButtonProps {
  readonly onSignOut: () => void;
  readonly pending?: boolean;
  readonly className?: string;
}

export function SignOutButton({ onSignOut, pending, className }: SignOutButtonProps): ReactNode {
  return (
    <button type="button" className={classNames("nav-signout", className)} onClick={onSignOut} disabled={pending}>
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}

export function PublicTrustChip(): ReactNode {
  return (
    <span className="trust-chip">
      <span className="trust-dot" aria-hidden="true" />
      Private intake
    </span>
  );
}

export function SiteFooter(): ReactNode {
  return (
    <footer className="site-footer">
      <span>DumpLedger</span>
      <span>Private by design · original bytes stay immutable</span>
    </footer>
  );
}
