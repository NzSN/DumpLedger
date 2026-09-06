/**
 * ErrorBoundary tests (design sections 4 and 8.4).
 *
 * Route-render failures are caught by the router-level `errorElement`
 * (FatalScreen) in the real App/router graph; rendering failures above the
 * router are caught by the class ErrorBoundary. Both present the same branded
 * fatal screen and never echo error data to the DOM.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, type RouteObject } from "react-router";
import type { ReactNode } from "react";
import { App } from "../app/App";
import { appRouteObjects } from "../app/router";
import { ErrorBoundary } from "../app/ErrorBoundary";
import { FakeHttpClient } from "./fake-http-client";

function ThrowingRoute(): ReactNode {
  throw new Error("synthetic render failure");
}

function ThrowingChild(): ReactNode {
  throw new Error("synthetic render failure");
}

/** Production routes plus a route whose element throws on render. */
function routesWithFailure(): RouteObject[] {
  const root = appRouteObjects[0];
  if (root === undefined) throw new Error("appRouteObjects[0] is missing");
  return [
    {
      element: root.element,
      errorElement: root.errorElement,
      children: [
        { path: "/boom", element: <ThrowingRoute /> },
        ...(root.children ?? []),
      ],
    },
  ];
}

describe("router-level error element (route render failures)", () => {
  it("shows the branded fatal screen and never echoes the error to the DOM", async () => {
    const fake = new FakeHttpClient();
    const router = createMemoryRouter(routesWithFailure(), { initialEntries: ["/boom"] });

    render(<App client={fake} router={router} />);

    expect(await screen.findByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("synthetic render failure");
    expect(document.body.textContent).not.toContain("boom");
  });

  it("renders healthy routes again after a fresh navigation", async () => {
    const fake = new FakeHttpClient();
    const router = createMemoryRouter(routesWithFailure(), { initialEntries: ["/boom"] });

    render(<App client={fake} router={router} />);
    await screen.findByRole("heading", { name: "Something went wrong" });

    const healthyRouter = createMemoryRouter([...appRouteObjects], { initialEntries: ["/login"] });
    const { rerender } = render(<App client={fake} router={healthyRouter} />);
    expect(await screen.findByRole("heading", { name: "Operator sign in" })).toBeTruthy();
  });
});

describe("class ErrorBoundary (failures outside the router)", () => {
  it("catches a throwing child and renders the branded fatal screen", async () => {
    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(await screen.findByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("synthetic render failure");
  });

  it("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>healthy content</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("healthy content")).toBeTruthy();
  });
});
