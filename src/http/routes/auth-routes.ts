import type { FastifyInstance } from "fastify";

import {
  decodeLoginRequest,
  encodeSessionResponse,
} from "@dump-ledger/http-contracts";
import { decodeJsonRequest, jsonRequireMutation, jsonSession, sendError } from "../contracts/json.js";
import type { RouteContext } from "./common.js";

/**
 * Operator session routes (design sections 7.2 and 8.2).
 *
 * The JSON session bootstrap is how the React shell learns the in-memory CSRF
 * token; every JSON mutation re-sends that token in the `X-CSRF-Token` header.
 * The legacy HTML login/logout pages were deleted in the Phase-5 cutover; the
 * `/login` browser route now serves the React shell from static-web.
 */
export function registerAuthRoutes(server: FastifyInstance, ctx: RouteContext): void {
  const { options } = ctx;
  const { loginRateLimiter } = ctx;

  server.get("/api/v1/session", async (request, reply) => {
    const session = jsonSession(request, options.sessions);
    if (session === undefined) {
      return reply
        .type("application/json; charset=utf-8")
        .send(encodeSessionResponse({ authenticated: false }));
    }
    return reply
      .type("application/json; charset=utf-8")
      .send(
        encodeSessionResponse({
          authenticated: true,
          csrfToken: session.csrfToken,
          expiresAt: new Date(session.expiresAt).toISOString(),
        }),
      );
  });

  server.post("/api/v1/session", async (request, reply) => {
    if (!loginRateLimiter.take(request.ip)) {
      reply.header("Retry-After", "300");
      return sendError(reply, "rate_limited");
    }
    const decoded = decodeJsonRequest(request, decodeLoginRequest);
    if (!decoded.ok) return sendError(reply, "invalid_request");
    const loggedIn = await options.sessions.login(decoded.value.password);
    if (loggedIn === undefined) return sendError(reply, "unauthenticated");
    const session = options.sessions.authenticate(loggedIn.setCookie.split(";", 1)[0] ?? "");
    if (session === undefined) return sendError(reply, "internal_error");
    return reply
      .header("Set-Cookie", loggedIn.setCookie)
      .type("application/json; charset=utf-8")
      .send(
        encodeSessionResponse({
          authenticated: true,
          csrfToken: session.csrfToken,
          expiresAt: new Date(session.expiresAt).toISOString(),
        }),
      );
  });

  server.delete("/api/v1/session", async (request, reply) => {
    const session = jsonRequireMutation(request, reply, options.sessions, options.allowedOrigins);
    if (session === undefined) return reply;
    return reply.header("Set-Cookie", options.sessions.logout(session)).code(204).send();
  });
}
