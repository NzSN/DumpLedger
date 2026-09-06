/**
 * App — composes the production dependency graph:
 *
 *   ErrorBoundary
 *     HttpClientProvider (deep HTTP client; tests inject a fake adapter)
 *       RouterProvider (routes under SessionProvider / OperatorGuard)
 *
 * Feature modules reach HTTP only through the shared client; the global
 * `fetch`/`XMLHttpRequest` surface stays inside shared/http-client.ts.
 */

import { useMemo, type ReactNode } from "react";
import { RouterProvider } from "react-router";
import { HttpClientProvider } from "../shared/http-client-context";
import { createHttpClient, type SessionAwareHttpClient } from "../shared/http-client";
import { ErrorBoundary } from "./ErrorBoundary";
import { createAppRouter, type AppRouter } from "./router";

export interface AppProps {
  /** Injectable HTTP adapter (tests supply a fake; production uses the real client). */
  readonly client?: SessionAwareHttpClient;
  /** Injectable router (tests supply an in-memory router with initial entries). */
  readonly router?: AppRouter;
}

export function App({ client, router }: AppProps): ReactNode {
  const httpClient = useMemo(() => client ?? createHttpClient(), [client]);
  const appRouter = useMemo(() => router ?? createAppRouter(), [router]);
  return (
    <ErrorBoundary>
      <HttpClientProvider client={httpClient}>
        <RouterProvider router={appRouter} />
      </HttpClientProvider>
    </ErrorBoundary>
  );
}
