/**
 * ErrorBoundary (design sections 4 and 8.4).
 *
 * Rendering failures can surface in two places:
 *   - inside the router (feature screens): React Router 7 owns the render
 *     path for route elements, so each layout route declares an
 *     `errorElement` that renders {@link FatalScreen} (see router.tsx);
 *   - above/below the router (root render, provider tree): the class
 *     {@link ErrorBoundary} catches those and renders the same screen.
 *
 * No error data, stack, location, or request content is rendered; operator
 * debugging happens in the console.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Branded fatal screen shared by the class boundary and the router-level
 * errorElement. Presents a reload affordance and never echoes error content.
 */
export function FatalScreen(): ReactNode {
  return (
    <div className="page-frame">
      <section className="screen-status" role="alert" aria-labelledby="fatal-title">
        <h1 id="fatal-title" className="screen-title">
          Something went wrong
        </h1>
        <p>
          DumpLedger hit an unexpected error while rendering this screen. Your evidence is safe; reload the page
          to continue.
        </p>
        <p>
          <button type="button" className="button" onClick={reloadPage}>
            Reload page
          </button>
        </p>
      </section>
    </div>
  );
}

function reloadPage(): void {
  try {
    window.location.reload();
  } catch {
    // Restricted environments (for example jsdom) may not implement reload.
  }
}

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

export interface ErrorBoundaryState {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error("Unexpected rendering error") };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Deliberately no third-party reporting in this shell.
    console.error("DumpLedger web render error", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }
    return <FatalScreen />;
  }
}
