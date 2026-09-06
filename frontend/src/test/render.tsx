/**
 * Shared render helpers for shell tests.
 *
 * Tests drive the real `App` (ErrorBoundary + HttpClientProvider + Router)
 * with an injected fake HTTP adapter and an in-memory router, so routing,
 * session, error, and keyboard behavior are exercised end to end through the
 * same component graph production uses.
 */

import { render } from "@testing-library/react";
import { createMemoryRouter, type RouteObject } from "react-router";
import { App } from "../app/App";
import { appRouteObjects } from "../app/router";
import type { SessionAwareHttpClient } from "../shared/http-client";

export interface RenderWebOptions {
  readonly initialEntries?: readonly string[];
}

export function createWebRouter(
  initialEntries: readonly string[] = ["/"],
  routes: readonly RouteObject[] = appRouteObjects,
) {
  return createMemoryRouter([...routes], { initialEntries: [...initialEntries] });
}

export function renderWeb(
  client: SessionAwareHttpClient,
  options: RenderWebOptions = {},
): { readonly router: ReturnType<typeof createWebRouter> } {
  const router = createWebRouter(options.initialEntries);
  render(<App client={client} router={router} />);
  return { router };
}
