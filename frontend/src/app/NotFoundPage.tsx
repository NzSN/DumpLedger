/**
 * NotFoundPage — branded view for unknown browser routes (design section 6).
 * It is a public route and never triggers the authenticated session
 * bootstrap.
 */

import type { ReactNode } from "react";
import { Link } from "react-router";
import { PublicLayout } from "./layouts";

export function NotFoundPage(): ReactNode {
  return (
    <PublicLayout>
      <section className="screen-status" aria-labelledby="not-found-title">
        <h1 id="not-found-title" className="screen-title">
          Page not found
        </h1>
        <p>The address you opened does not match a DumpLedger page.</p>
        <p>
          <Link className="button button-secondary" to="/">
            Go to the operator sign in
          </Link>
        </p>
      </section>
    </PublicLayout>
  );
}
