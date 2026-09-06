/**
 * Operator feature test doubles (T5 additions).
 *
 * `OperatorFakeHttpClient` extends the shell's `FakeHttpClient` with per-route
 * responders so feature pages can serve dashboard, customer, case, grant,
 * dump, and operations data without editing the shared fake. Like the shell
 * fake, it returns already-decoded values (the shared client owns runtime
 * decoding; tests supply the typed results feature pages consume).
 *
 * Requests record their AbortSignal so tests can assert that route changes
 * abort in-flight loads, and a responder may return a manually-resolved
 * promise to hold a request open while the test drives navigation.
 *
 * `renderFeaturePage` mounts one feature page inside the real providers
 * (HttpClientProvider + Router) without the operator session bootstrap, so a
 * feature test can drive the page directly and pass page-level props (for
 * example a short polling interval on the operations screen).
 */

import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ReactNode } from "react";
import type { MutationRequest, QueryRequest, SessionAwareHttpClient } from "../shared/http-client";
import { HttpClientProvider } from "../shared/http-client-context";
import { FakeHttpClient } from "./fake-http-client";

export interface OperatorRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export type OperatorResponder = (request: OperatorRequest) => unknown | Promise<unknown>;

export class OperatorFakeHttpClient extends FakeHttpClient {
  readonly queryCalls: OperatorRequest[] = [];
  readonly mutationCalls: OperatorRequest[] = [];
  readonly abortedSignals: AbortSignal[] = [];

  private readonly responders = new Map<string, OperatorResponder>();

  /** Registers a responder for `GET path`. */
  setQueryResponder(path: string, responder: OperatorResponder): void {
    this.responders.set(`GET ${path}`, responder);
  }

  /** Registers a responder for `METHOD path`. */
  setMutationResponder(method: string, path: string, responder: OperatorResponder): void {
    this.responders.set(`${method} ${path}`, responder);
  }

  /** Latest recorded AbortSignal for a given path, or undefined. */
  signalFor(path: string): AbortSignal | undefined {
    const calls = [...this.queryCalls, ...this.mutationCalls];
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      const call = calls[index];
      if (call?.path === path) return call.signal;
    }
    return undefined;
  }

  private observeAbort(signal: AbortSignal | undefined): void {
    if (signal === undefined) return;
    signal.addEventListener(
      "abort",
      () => {
        this.abortedSignals.push(signal);
      },
      { once: true },
    );
  }

  override async query<T>(request: QueryRequest<T>): Promise<T> {
    if (request.path === "/api/v1/session") return super.query(request);
    const call: OperatorRequest = {
      method: "GET",
      path: request.path,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    this.queryCalls.push(call);
    this.observeAbort(request.signal);
    const responder = this.responders.get(`GET ${request.path}`);
    if (responder === undefined) {
      throw new Error(`OperatorFakeHttpClient: no query responder for ${request.path}`);
    }
    return (await responder(call)) as T;
  }

  override async mutate<T>(request: MutationRequest<T>): Promise<T> {
    if (request.path === "/api/v1/session") return super.mutate(request);
    const call: OperatorRequest = {
      method: request.method,
      path: request.path,
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    this.mutationCalls.push(call);
    this.observeAbort(request.signal);
    const responder = this.responders.get(`${request.method} ${request.path}`);
    if (responder === undefined) {
      throw new Error(`OperatorFakeHttpClient: no mutation responder for ${request.method} ${request.path}`);
    }
    return (await responder(call)) as T;
  }
}

export interface RenderFeatureOptions {
  readonly entry?: string;
  /** Route pattern that must expose the params the page reads (default "*"). */
  readonly path?: string;
}

/**
 * Renders a single feature page inside the real providers. `path` lets a test
 * expose the URL params the page reads (for example `/cases/:caseId`).
 */
export function renderFeaturePage(
  client: SessionAwareHttpClient,
  element: ReactNode,
  options: RenderFeatureOptions = {},
): void {
  const { entry = "/", path = "*" } = options;
  const routes = [
    { path, element },
    // Fallback so in-page navigation links never render an empty tree.
    { path: "*", element: <p data-testid="nav-stub">Navigation target</p> },
  ];
  const router = createMemoryRouter(routes, { initialEntries: [entry] });
  render(
    <HttpClientProvider client={client}>
      <RouterProvider router={router} />
    </HttpClientProvider>,
  );
}
