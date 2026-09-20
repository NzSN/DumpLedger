import Fastify, { type FastifyInstance } from "fastify";

import { sendError } from "./contracts/json.js";
import { registerSymbolRoutes, type SymbolArtifactStorePort } from "./routes/symbol-routes.js";

/**
 * Dedicated symsrv-protocol listener (docs/symbols-design.md, "Read serving
 * (symsrv route)"; docs/security-model.md, "Dedicated symbols listener").
 *
 * The main HTTP surface already serves `/symbols/:name/:id/:file` next to the
 * operator API and the SPA. This listener exposes that SAME store on a
 * separate, optional port (DUMP_LEDGER_SYMBOLS_PORT). The composition root
 * requires TLS for non-loopback binds. Plain HTTP is only for a local
 * debugger, authenticated tunnel, or local TLS proxy; symbol identities do
 * not authenticate bytes against an on-path attacker.
 *
 * The listener is deliberately minimal and unauthenticated (decision D1):
 * only the three-segment store path exists. There is no session surface, no
 * admin surface, no directory listing; everything else — including the admin
 * ingest path — is an indistinguishable 404 miss.
 */
export function buildSymbolsListener(
  store: SymbolArtifactStorePort,
  tls?: { readonly cert: Buffer; readonly key: Buffer },
): FastifyInstance {
  const server = Fastify({
    logger: false,
    ...(tls === undefined ? {} : { https: { ...tls, minVersion: "TLSv1.2" as const } }),
    connectionTimeout: 60_000,
    requestTimeout: 60_000,
    routerOptions: { maxParamLength: 512 },
  });
  registerSymbolRoutes(server, store);
  server.setNotFoundHandler((_request, reply) => sendError(reply, "not_found"));
  return server;
}
