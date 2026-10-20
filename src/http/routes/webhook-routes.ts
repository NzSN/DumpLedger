import type { FastifyInstance, FastifyReply } from "fastify";

import {
  decodeCreateWebhookParams,
  encodeCreateWebhookResponse,
  encodeWebhookDeliveriesResponse,
  encodeWebhookListResponse,
} from "@dump-ledger/http-contracts";
import { DumpLedgerError } from "../../domain/errors.js";
import type { WebhookApplicationPort } from "../application.js";
import {
  contractErrorFor,
  decodeJsonRequest,
  jsonRequireMutation,
  jsonRequireSession,
  sendError,
} from "../contracts/json.js";
import type { RouteContext } from "./common.js";

/**
 * Webhook management routes (docs/webhook-notifications-design.md,
 * "Management API"; milestone WH1).
 *
 * Every route is operator-session-only: registering a subscription makes the
 * server push event data to an arbitrary URL, so the analyzer bearer token is
 * deliberately not consulted here. Mutations additionally pass the CSRF/
 * Origin mutation guard. Subscription CRUD is operational configuration and
 * appends no audit event.
 */

/** Maps a thrown application failure onto the stable error envelope, exactly
 * like `eventsError`: URL/case validation throws `invalid_input` (mapped to
 * `invalid_request`), storage unavailability stays retryable, and anything
 * unexpected degrades to `internal_error` rather than leaking internals. */
function webhooksError(reply: FastifyReply, error: unknown): FastifyReply {
  return sendError(reply, contractErrorFor(error instanceof DumpLedgerError ? error.code : "internal_error"));
}

export function registerWebhookRoutes(server: FastifyInstance, ctx: RouteContext): void {
  const { options } = ctx;
  // The HTTP application port is intentionally limited to browser use cases;
  // the webhook methods are an additive surface implemented by the concrete
  // application the composition root supplies.
  const application = options.application as typeof options.application & WebhookApplicationPort;

  server.post("/api/v1/webhooks", async (request, reply) => {
    if (jsonRequireMutation(request, reply, options.sessions, options.allowedOrigins) === undefined) return reply;
    const decoded = decodeJsonRequest(request, decodeCreateWebhookParams);
    if (!decoded.ok) return sendError(reply, "invalid_request");
    try {
      const outcome = application.createWebhook(decoded.value);
      if (!outcome.ok) return sendError(reply, contractErrorFor(outcome.code));
      return reply
        .code(201)
        .type("application/json; charset=utf-8")
        .send(encodeCreateWebhookResponse(outcome.response));
    } catch (error) {
      return webhooksError(reply, error);
    }
  });

  server.get("/api/v1/webhooks", async (request, reply) => {
    if (jsonRequireSession(request, reply, options.sessions) === undefined) return reply;
    try {
      return reply.type("application/json; charset=utf-8").send(encodeWebhookListResponse(application.listWebhooks()));
    } catch (error) {
      return webhooksError(reply, error);
    }
  });

  server.delete<{ Params: { webhookId: string } }>("/api/v1/webhooks/:webhookId", async (request, reply) => {
    if (jsonRequireMutation(request, reply, options.sessions, options.allowedOrigins) === undefined) return reply;
    try {
      if (!application.deleteWebhook(request.params.webhookId)) return sendError(reply, "not_found");
      return reply.code(204).send();
    } catch (error) {
      return webhooksError(reply, error);
    }
  });

  server.get<{ Params: { webhookId: string } }>("/api/v1/webhooks/:webhookId/deliveries", async (request, reply) => {
    if (jsonRequireSession(request, reply, options.sessions) === undefined) return reply;
    try {
      const response = application.webhookDeliveries(request.params.webhookId);
      if (response === undefined) return sendError(reply, "not_found");
      return reply.type("application/json; charset=utf-8").send(encodeWebhookDeliveriesResponse(response));
    } catch (error) {
      return webhooksError(reply, error);
    }
  });
}
