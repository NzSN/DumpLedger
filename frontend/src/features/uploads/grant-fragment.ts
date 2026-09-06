/**
 * features/uploads/grant-fragment.ts — fragment grant transport
 * (design sections 6, 7.6 and 9).
 *
 * The one-time secret travels only in the URL fragment
 * (`/upload#grant=<base64url-secret>`). Fragments are never sent to the
 * server, so they never reach request-target or reverse-proxy access logs.
 * The uploader reads the secret into route-local memory and immediately
 * strips the fragment with `history.replaceState` so the secret cannot linger
 * in the address bar, be copied into a later navigation, or leak into logs.
 *
 * The secret is never persisted (no localStorage/sessionStorage/IndexedDB),
 * never written to React state beyond this route, and never logged. This
 * module only touches the browser location/history seam; it contains no
 * secret values of its own.
 */

import { parseUploadFragment } from "@dump-ledger/http-contracts";

/** The narrow slice of `window.location` this module reads. */
export interface GrantLocation {
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
}

/** The narrow slice of `window.history` this module writes to. */
export interface GrantHistory {
  replaceState(data: unknown, unusedTitle: string, url?: string | null): void;
}

/** True when the fragment is a `#grant=` bearer fragment (valid or not). */
export function isGrantFragment(hash: string): boolean {
  return hash.startsWith("#grant=");
}

/**
 * Parses the one-time secret from the location hash. Returns null when the
 * fragment is absent or does not match the strict base64url grant shape, so
 * callers cannot distinguish unknown/revoked/expired/consumed states — the
 * backend owns that and never reveals which one occurred.
 */
export function readGrantSecret(location: GrantLocation): string | null {
  return parseUploadFragment(location.hash);
}

/**
 * Removes a grant-shaped fragment from the current URL with
 * `history.replaceState`. Returns true when a `#grant=` fragment was present
 * (and therefore scrubbed), whether or not its value parsed as a valid
 * secret. Non-grant fragments are left untouched.
 */
export function scrubGrantFragment(location: GrantLocation, history: GrantHistory): boolean {
  if (!isGrantFragment(location.hash)) return false;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return true;
}
