import { createContext, useContext, type ReactNode } from "react";
import { createHttpClient, type SessionAwareHttpClient } from "./http-client";

/**
 * Provides the HTTP client to the whole tree. `App` supplies the production
 * client; tests supply a fake adapter implementing the same interface so
 * feature tests never mock global `fetch`.
 */
const HttpClientContext = createContext<SessionAwareHttpClient | null>(null);

export interface HttpClientProviderProps {
  readonly client: SessionAwareHttpClient;
  readonly children: ReactNode;
}

export function HttpClientProvider({ client, children }: HttpClientProviderProps): ReactNode {
  return <HttpClientContext.Provider value={client}>{children}</HttpClientContext.Provider>;
}

export function useHttpClient(): SessionAwareHttpClient {
  const client = useContext(HttpClientContext);
  if (client === null) {
    throw new Error("useHttpClient must be used inside <HttpClientProvider>");
  }
  return client;
}
