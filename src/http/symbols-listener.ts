import Fastify, { type FastifyInstance } from "fastify";

import { sendError } from "./contracts/json.js";
import { registerSymbolRoutes, type SymbolArtifactStorePort } from "./routes/symbol-routes.js";

/**
 * Dedicated symsrv-protocol listener (docs/symbols-design.md, "Read serving
 * (symsrv route)"; docs/security-model.md, "Dedicated symbols listener").
 *
 * The main HTTP surface already serves `/symbols/:name/:id/:file` next to the
 * operator API and the SPA. This listener exposes that SAME store on a
 * separate, optional port (DUMP_LEDGER_SYMBOLS_PORT) so debugger traffic can
 * be split from the operator surface and served over plain HTTP — symsrv.dll
 * only trusts server certs chaining to a trusted root on the analysis
 * machine, which made the self-signed proxy cert the one friction point of
 * the shared HTTPS route (design "HTTPS caveat").
 *
 * The listener is deliberately minimal and unauthenticated (decision D1):
 * only the three-segment store path exists. There is no session surface, no
 * admin surface, no directory listing; everything else — including the admin
 * ingest path — is an indistinguishable 404 miss.
 */
export function buildSymbolsListener(store: SymbolArtifactStorePort): FastifyInstance {
  const server = Fastify({ logger: false, routerOptions: { maxParamLength: 512 } });
  registerSymbolRoutes(server, store);
  server.setNotFoundHandler((_request, reply) => sendError(reply, "not_found"));
  return server;
}
