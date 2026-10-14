import type { FastifyInstance, FastifyReply } from "fastify";

import {
  decodeEventFeedParams,
  encodeEventFeedResponse,
} from "@dump-ledger/http-contracts";
import { DumpLedgerError } from "../../domain/errors.js";
import { authorizeSessionOrAnalyzer, contractErrorFor, sendError } from "../contracts/json.js";
import type { RouteContext } from "./common.js";

/**
 * Audit event feed route (docs/analyzer-integration-design.md, "Event feed";
 * milestone AI2).
 *
 * `GET /api/v1/events` is a read-only rowid-cursor page over the audit trail,
 * served by the application layer's `eventFeed` query (no engine command, no
 * audit event) under `authorizeSessionOrAnalyzer`: the operator session
 * cookie or the configured analyzer bearer token, with the pinned precedence
 * that any `Authorization` header selects the bearer path only.
 */

/**
 * Maps a thrown application failure onto the stable error envelope, exactly
 * like `catalogError`: a malformed cursor or filter throws `invalid_input`
 * (mapped to `invalid_request`), and anything unexpected degrades to
 * `internal_error` rather than leaking an internal detail or bypassing the
 * envelope.
 */
function eventsError(reply: FastifyReply, error: unknown): FastifyReply {
  return sendError(reply, contractErrorFor(error instanceof DumpLedgerError ? error.code : "internal_error"));
}

export function registerEventRoutes(server: FastifyInstance, ctx: RouteContext): void {
  const { options } = ctx;

  server.get("/api/v1/events", async (request, reply) => {
    if (authorizeSessionOrAnalyzer(request, reply, options) === undefined) return reply;
    let params;
    try {
      params = decodeEventFeedParams((request.query ?? {}) as Record<string, string | readonly string[] | undefined>);
    } catch {
      return sendError(reply, "invalid_request");
    }
    let response;
    try {
      response = options.application.eventFeed(params);
    } catch (error) {
      return eventsError(reply, error);
    }
    return reply.type("application/json; charset=utf-8").send(encodeEventFeedResponse(response));
  });
}
