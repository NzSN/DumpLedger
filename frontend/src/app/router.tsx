/**
 * Browser routes (design section 6). The public /login and /upload routes sit
 * outside the operator guard, so opening them never triggers the
 * authenticated session bootstrap or loads operator data. Unknown browser
 * routes render the branded not-found view.
 */

import { createBrowserRouter, createMemoryRouter, type RouteObject } from "react-router";
import { SessionProvider } from "./SessionProvider";
import { FatalScreen } from "./ErrorBoundary";
import { OperatorGuard } from "./OperatorGuard";
import { NotFoundPage } from "./NotFoundPage";
import { LoginPage } from "../features/auth/LoginPage";
import { UploadPage } from "../features/uploads/UploadPage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { CustomersPage } from "../features/customers/CustomersPage";
import { CasesPage } from "../features/cases/CasesPage";
import { CaseDetailPage } from "../features/cases/CaseDetailPage";
import { DumpsPage } from "../features/dumps/DumpsPage";
import { DumpDetailPage } from "../features/dumps/DumpDetailPage";
import { OperationsPage } from "../features/operations/OperationsPage";

export const appRouteObjects: readonly RouteObject[] = [
  {
    // SessionProvider is the pathless root element: every route renders inside
    // its Outlet and can consume session context.
    element: <SessionProvider />,
    // React Router catches route-render failures and renders this branded
    // fatal screen (design sections 4 and 8.4); it never echoes error content.
    errorElement: <FatalScreen />,
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: "/upload", element: <UploadPage /> },
      {
        element: <OperatorGuard />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: "customers", element: <CustomersPage /> },
          { path: "cases", element: <CasesPage /> },
          { path: "cases/:caseId", element: <CaseDetailPage /> },
          { path: "dumps", element: <DumpsPage /> },
          { path: "dumps/:dumpId", element: <DumpDetailPage /> },
          { path: "operations", element: <OperationsPage /> },
        ],
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter([...appRouteObjects]);
}

export type AppRouter = ReturnType<typeof createAppRouter>;

/** In-memory router for Vitest integration tests (no global fetch involved). */
export function createTestRouter(initialEntries: readonly string[]): AppRouter {
  return createMemoryRouter([...appRouteObjects], { initialEntries: [...initialEntries] });
}
